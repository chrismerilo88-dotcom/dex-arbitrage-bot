---
tags: [architecture]
---

# Architecture

See also: [[00 - Project Overview]] · [[07 - Glossary]]

## The core loop

```
Owner calls requestFlashLoanArbitrage()
  → Aave lends the asset
    → executeOperation() callback fires
      → _executeRoute(): quote both legs, swap leg 1, swap leg 2
        → measure actual amount returned via balance delta
      → require(finalAmount > amountOwed)      -- structural loss prevention
      → require(profit >= minProfit)
      → repay Aave
      → sweep profit to owner
```

Every step that could fail, fails by **reverting the whole transaction** — nothing partially executes. Worst case on a bad attempt is wasted gas, not lost principal. See [[06 - Pre-Mainnet Checklist]] for why gas cost is still a real risk even though principal is protected.

## The adapter pattern

The executor doesn't know or care which DEX protocol it's trading against. Each protocol (Uniswap V2, Uniswap V3, Curve, Balancer) gets its own small adapter contract implementing one shared interface:

```solidity
interface IDexAdapter {
    function quote(bytes calldata routeData, uint256 amountIn) external returns (uint256 amountOut);
    function swap(bytes calldata routeData, uint256 amountIn, uint256 minAmountOut, address recipient, uint256 deadline) external returns (uint256 amountOut);
}
```

One adapter *instance* wraps one specific router/pool/vault. Deploy a new `UniswapV2Adapter` for every V2-style router you want (Uniswap, Sushi, ...), a new `UniswapV3Adapter` per V3 SwapRouter+Quoter pair, etc.

## RouteData encoding

Every adapter agrees on one shared envelope: `abi.encode(address[] tokens, bytes extra)`.

- `tokens` — the executor reads *only* this part, for allowlist checks and to verify the round trip actually returns to the borrowed asset. Protocol-agnostic.
- `extra` — opaque to the executor, meaningful only to that specific adapter. V2: unused. V3: `abi.encode(uint24[] fees)`, one per hop. Curve: `abi.encode(int128 i, int128 j)`. Balancer: `abi.encode(bytes32 poolId)`.

This is what makes triangular arbitrage (three tokens, one exchange) *not* a new feature — `adapter1` and `adapter2` can be the same adapter instance, with a `tokens` array like `[WETH, USDC, ARB]` on the way out.

## The safety layers, and why each exists

| Layer | What it stops |
|---|---|
| Two-step ownership (`transferOwnership`/`acceptOwnership`) | A typo'd address permanently locking the contract |
| Router/token allowlist + cooldown (`approvalDelay`) | Immediate exploitation of a rushed or socially-engineered approval — see [[02 - Security Review Log]] item 18 |
| `maxLoanAmount` starting at 0 | A fat-fingered borrow amount before the owner deliberately sets a cap |
| Balance-delta accounting (not trusting router return values) | Fee-on-transfer/non-standard tokens silently breaking profit math |
| `finalAmount`/`minProfit` checks against realized amounts | The contract ever knowingly executing a losing trade |
| `nonReentrant` + `_flashLoanActive` flag | Reentrancy into admin functions during the flash loan flow |

## Known scope limits (deliberate, not oversights)

- Curve and Balancer adapters: one pool, two tokens per leg. Their interfaces vary too much across pool variants to generalize safely.
- No on-chain MEV protection. That's an off-chain submission concern (private relay), not something Solidity can fix — see [[07 - Glossary]] → MEV.
- WETH gas backstop only applies when the borrowed asset is WETH, and only covers gas spent inside `executeOperation()` itself.
