# DexArbitrageBotFlashLoan v11

v11 is two post-review fixes on top of v10, both in `contracts/DexArbitrageBotFlashLoan.sol` and
`contracts/adapters/BalancerAdapter.sol` — see items 22–23 in the header comment of the main
contract for exactly what changed and why.

Compiles clean with solc 0.8.19, optimizer on, 200 runs — verified against
all 8 contract files in this project by actually running the compiler,
not just by inspection.

## How to actually run this

### 1. Install Foundry (if you don't have it)
```
curl -L https://foundry.paradigm.xyz | bash
foundryup
```

### 2. Get forge-std and compile
```
cd dex-arbitrage-bot
forge install foundry-rs/forge-std --no-commit
forge build
```

### 3. Fork-test against real mainnet state
This is the step that actually matters most before risking real funds —
it runs every contract against live Aave and Uniswap state, not mocks.
```
export MAINNET_RPC_URL=https://your-rpc-provider-url
forge test --fork-url $MAINNET_RPC_URL -vvv
```
`test/DeploySmokeTest.t.sol` checks deployment wiring, that the approval
cooldown actually blocks usage until it elapses, and that the V2 adapter's
quote matches the real Uniswap router's quote exactly. It's a smoke test,
not full coverage — extend it with a real `executeOperation()` test once
you've found (or fork-simulated) an actually profitable route, and add
equivalent tests for the V3, Curve, and Balancer adapters before trusting
those in production; I have meaningfully less confidence in those three
than in the V2 path (see the CAUTION comments in each adapter file).

### 4. Deploy
```
export PRIVATE_KEY=0x...
export MAINNET_RPC_URL=https://your-rpc-provider-url
forge script script/Deploy.s.sol --rpc-url $MAINNET_RPC_URL --broadcast --verify
```
`script/Deploy.s.sol` deploys the adapters, deploys the executor, and
starts the approval cooldown for each adapter and token — but does
**not** set `maxLoanAmount` above 0 (so nothing can execute yet) or wait
out the cooldown for you. Do both deliberately, not as part of a script.

**Every address in `Deploy.s.sol` needs verifying against the live source
before you broadcast** — they were pulled from official docs/Etherscan
while writing this, but addresses are exactly the kind of detail that
goes stale or gets typo'd with real consequences. Links are in the
script's header comment.

### 5. Off-chain bot
`off-chain-bot/` is a skeleton, not a finished bot — `npm install` inside
it, copy `.env.example` to `.env`, fill it in. It shows the two
mechanical pieces (quote via `quoteRoute()`, then submit) that any
scanner needs regardless of how it finds a candidate route. **Actual
opportunity discovery — watching pools, computing candidate routes,
reacting fast enough to matter — isn't in there**; that's a genuinely
separate, ongoing project, marked clearly in `index.js` where it plugs
in. Same for MEV-safe submission: the skeleton submits directly, which
is exactly the mempool-visible path discussed earlier in this project's
history — swap in a private relay (Flashbots Protect, MEV Blocker) before
running this against real opportunities.

## Structure

```
contracts/
  DexArbitrageBotFlashLoan.sol   the executor -- borrows, runs a route, repays, sweeps profit
  interfaces/IDexAdapter.sol     shared quote()/swap() interface every adapter implements
  libraries/RouteData.sol        shared routeData encoding: (address[] tokens, bytes extra)
  libraries/SafeERC20.sol        approve/transfer helpers used by the executor and adapters
  adapters/
    UniswapV2Adapter.sol         Uniswap V2, SushiSwap, PancakeSwap V2, other V2 forks
    UniswapV3Adapter.sol         Uniswap V3 (single-hop and multi-hop)
    CurveAdapter.sol             classic stable-pool Curve (int128 indices) -- one pool, 2 tokens
    BalancerAdapter.sol          Balancer V2 Vault -- one pool, 2 tokens
```

## Deployment order

1. Deploy one adapter instance **per underlying router/pool/vault** you want to use:
   - `new UniswapV2Adapter(routerAddress)`
   - `new UniswapV3Adapter(swapRouterAddress, quoterV2Address)`
   - `new CurveAdapter(poolAddress)` — verify the pool actually uses the classic
     `exchange(int128,int128,uint256,uint256)` / `get_dy(int128,int128,uint256)` signature first;
     see the caution comment at the top of the file.
   - `new BalancerAdapter(vaultAddress)`
2. Deploy the executor: `new DexArbitrageBotFlashLoan(aaveAddressesProvider, wethAddress)`.
3. On the executor, for each adapter from step 1: `approveAdapter(adapterAddress, true)`, then wait
   out `approvalDelay` (24h by default) before it's usable — check `isAdapterApproved()`.
4. `approveToken(tokenAddress, true)` for every token you'll route through (same cooldown applies).
5. `setMaxLoanAmount(cap)` — required before any request will succeed; starts at 0 (locked).

Nothing executes until steps 3–5 are all done.

## routeData encoding

Every adapter shares the same outer envelope: `abi.encode(address[] tokens, bytes extra)`.
`tokens` is what the executor validates against your token allowlist and uses to check the
round-trip invariant. `extra` is adapter-specific:

**UniswapV2Adapter** — `extra` unused (pass `"0x"` / empty bytes):
```solidity
bytes memory routeData = abi.encode(
    [WETH, USDC],   // tokens: direct pair, or a longer array for a multi-hop V2 path
    bytes("")
);
```

**UniswapV3Adapter** — `extra = abi.encode(uint24[] fees)`, one fee tier per hop:
```solidity
bytes memory routeData = abi.encode(
    [WETH, USDC],           // tokens
    abi.encode([uint24(3000)])   // extra: single 0.3% pool
);
// two-hop example: WETH -[0.3%]-> DAI -[0.05%]-> USDC
bytes memory routeData2 = abi.encode(
    [WETH, DAI, USDC],
    abi.encode([uint24(3000), uint24(500)])
);
```

**CurveAdapter** — `extra = abi.encode(int128 i, int128 j)`, the pool's own coin indices:
```solidity
bytes memory routeData = abi.encode(
    [DAI, USDC],
    abi.encode(int128(0), int128(1))   // verify against the pool's coins() ordering
);
```

**BalancerAdapter** — `extra = abi.encode(bytes32 poolId)`:
```solidity
bytes memory routeData = abi.encode(
    [WETH, USDC],
    abi.encode(bytes32(0x...poolId))
);
```

## Known scope limits (by design, not oversights)

- Curve and Balancer adapters support one pool, two tokens per leg — see the caution comments in
  each file for why (interface heterogeneity across pool variants, and Balancer batch-swap
  complexity).
- `quoteRoute()` on the executor is not `view` (Uniswap V3's on-chain quoter isn't either). Call it
  via `eth_call` off-chain for a free read, same as any V3 quoter.
- The WETH gas backstop in `executeOperation()` only applies when the borrowed asset is WETH, and
  only measures gas spent inside `executeOperation()` itself — not the full transaction's base cost,
  calldata cost, or Aave's own bookkeeping around the callback. It's an approximate backstop against
  a stale off-chain `minProfit`, not an exact accounting.

## Rollout checklist

Roughly the order this actually goes in practice:

1. `forge build` — clean compile.
2. `forge test --fork-url $MAINNET_RPC_URL` — smoke test passes against real chain state.
3. Verify every address in `Deploy.s.sol` against the official source, not this file.
4. Deploy to a testnet first if one with real Aave V3 + Uniswap liquidity is available to you;
   otherwise deploy to mainnet with `maxLoanAmount` left at 0.
5. `approveAdapter()` + `approveToken()` for everything you need, then **wait out the cooldown** —
   don't shorten `approvalDelay` to skip this on a live deployment.
6. `setMaxLoanAmount()` to something small — orders of magnitude below what you'd eventually run.
7. Run the off-chain bot against a single, manually-verified profitable-looking route first, watching
   `FlashArbitrageExecuted` and the revert reason of anything that fails.
8. Only after that works repeatedly: raise `maxLoanAmount`, connect real opportunity discovery, and
   switch submission to a private relay.
9. Move `owner` to a multisig or timelock via `transferOwnership()`/`acceptOwnership()` before running
   with meaningful capital — this was built specifically to make that migration safe.

