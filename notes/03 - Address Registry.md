---
tags: [addresses, reference]
---

# Address Registry

See also: [[02 - Security Review Log]] · [[05 - Lessons Learned]]

**Rule for adding anything to this file**: an address only belongs in the ✅ table after a live `cast code` (or successful on-chain use) confirms it — not after research alone, no matter how many sources agree. See [[05 - Lessons Learned]] for exactly why.

## ✅ Ethereum Sepolia — confirmed live

| Contract | Address | Verified via |
|---|---|---|
| Aave PoolAddressesProvider | `0x012bAC54348C0E635dCAc9D5FB99f06F24136C9A` | aave-address-book + successful live deployment |
| WETH | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | Multiple independent sources + confirmed via `SwapRouter02.WETH9()` + successful live use |
| Uniswap V3 SwapRouter02 | `0x3bFA4769FB09eefC5a80d6E87c3B9C650f7Ae48E` | Direct sepolia.etherscan.io source fetch + `cast code` |
| Uniswap V3 QuoterV2 | `0xEd1f6473345F45b75F8179591dd5bA1888cf2FB3` | Direct sepolia.etherscan.io source fetch + `cast code` |
| Uniswap V3 Factory | `0x0227628f3F023bB0B980b67D528571c95c6DaC1c` | Queried directly from the confirmed-good SwapRouter02's own `factory()` — self-consistent ground truth |
| USDC (candidate token) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | `cast code` + real pool liquidity confirmed against it at 3 fee tiers |
| WSOL (candidate token) | `0x357eca9754fdc02a9860973e261fb08de0f3b094` | `cast code` + `name()`/`symbol()` self-identification ("Wrapped Solana Coin" / "WSOL") + real WETH pool liquidity confirmed at the 0.3% fee tier (see below) |

**WETH/WSOL pool liquidity check** (same method as WETH/USDC): queried `Factory.getPool()` at fee tiers 500, 3000, 10000.

| Fee tier | Pool address | Liquidity |
|---|---|---|
| 500 (0.05%) | none (zero address) | — |
| 3000 (0.3%) | `0x855C7022f13e82Cd347d1F1CCf6b30d02e192D2e` | `220610898382903028801` — nonzero, real depth |
| 10000 (1%) | none (zero address) | — |

Note: WSOL here carries 18 decimals and exposes `mint`/`burn` -- consistent with a standalone testnet token rather than a real bridge-wrapped asset (bridged SOL normally carries 9 decimals to match Solana). Fine for testnet use, just don't assume this address has any relationship to a real cross-chain SOL bridge deployment on another network.

### Deployed contract instances (Ethereum Sepolia)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor) | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | v13, live |
| `UniswapV3Adapter` (broken) | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | **Do not use** — deployed with a wrong QuoterV2, `QUOTER` is immutable, can't be patched |
| `UniswapV3Adapter` (working) | `0x90dCEa7EcC443B96938d57758f92E24735b64800` | Use this one |

## ✅ Ethereum Mainnet — verified, not yet deployed against

| Contract | Address |
|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` |
| Aave PoolAddressesProvider | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` |
| Uniswap V2 Router02 | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` |
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` |
| Uniswap V3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` |
| Balancer Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` |

## ✅ Base Sepolia — confirmed live

| Contract | Address | Verified via |
|---|---|---|
| WETH | `0x4200000000000000000000000000000000000006` | OP-stack genesis predeploy — protocol-guaranteed on every OP-stack chain, the one documented exception to the live-check rule (see [[05 - Lessons Learned]]) |
| Aave PoolAddressesProvider | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | `cast code` (~6.6KB bytecode returned) |
| Uniswap V3 SwapRouter02 | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | `cast code` (~24.5KB bytecode returned) |
| Uniswap V3 QuoterV2 | `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` | `cast code` (~8.2KB bytecode returned). Sourced from the official Uniswap docs GitHub repo (`Base-Deployments.md`), cross-validated by its paired SwapRouter02 matching the address above — but still went through a live check per the rule, not trusted on source quality alone |

All four Base Sepolia addresses now confirmed.

### Deployed contract instances (Base Sepolia)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor) | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | v13, live. Deployed via raw `cast send --create`, not `forge script` -- see the Foundry/revm caveat below |
| `UniswapV3Adapter` | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | Wired to the confirmed SwapRouter02 + QuoterV2 above |

Both `approveAdapter(UniswapV3Adapter, true)` and `approveToken(WETH, true)` were called immediately after deployment -- neither is usable until the 24h `approvalDelay` cooldown elapses. `maxLoanAmount` was deliberately left at 0 (not called), per [[04 - Deployment Runbook]] and [[06 - Pre-Mainnet Checklist]].

**Foundry/revm caveat, logged so it's not re-discovered from scratch**: `forge script`/`forge test --fork-url` against Base Sepolia fail with `EvmError: NotActivated` on any call into the Aave PoolAddressesProvider (`0xE4C2...4Ad00`) -- specifically its `getPool()` call reverts locally in revm at ~65 gas, while the identical call succeeds via a direct `cast call` against the real RPC (confirmed repeatedly). This affects `forge test`, `forge script` (simulated), and even `forge script --skip-simulation` (which still executes the script once locally to build the transaction list, so it hits the same wall). Tried `--evm-version` across shanghai/cancun/prague/london/paris -- no difference. Root cause is presumed to be forge 1.7.1's revm lagging some very recent Base/OP-stack chain upgrade; not yet fixed via `foundryup` (deliberately deferred, not required to unblock deployment). **Workaround used for this deployment**: bypass `forge script` entirely -- get creation bytecode via `forge inspect <Contract> bytecode`, append `cast abi-encode "constructor(...)" ...` for constructor args, and broadcast with `cast send --create`, which does no local simulation at all. See [[04 - Deployment Runbook]] for the exact commands if this needs to be repeated.

## ❌ Wrong addresses caught — logged so they're never reused

| Contract | Wrong address | What it actually was | Caught by |
|---|---|---|---|
| Aave PoolAddressesProvider (thought: Sepolia) | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | The real **mainnet** address — Sepolia has its own, different one | Live deploy: `call to non-contract address` |
| Uniswap V3 QuoterV2 (thought: Sepolia) | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | The real **mainnet** address | Live `cast code`: empty bytecode |
| Uniswap V3 Factory (thought: Sepolia) | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | The real address on mainnet and most other chains, not Sepolia | Live `cast call`: `does not have any code` |
| Uniswap V3 QuoterV2 (thought: mainnet) | `0x0209c4Dc18B2A1439fD2427E34E7cf3c6B91cFB9` | A different, unrelated contract entirely | solc checksum validation + independent search |
| Balancer Vault (thought: mainnet) | `0xBA12222222228d8Ba445958a75a0704d566BF2C` | Missing its final digit (39 hex chars, not 40) | solc rejected the malformed literal at compile time |
| Uniswap V3 SwapRouter02 (thought: Sepolia) | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | The real mainnet address; on Sepolia it's just a normal wallet address that scam bots had sprayed with fake airdrop tokens | Sepolia Etherscan page showed spam-token contamination instead of "Contract: Verified" |
| Uniswap V3 QuoterV2 (thought: Base Sepolia) | `0xc694a4cf10e2e4f77b49c35c5e6ea1b0fde6f6e8` | Nothing — no contract deployed at this address | Live `cast code`: empty bytecode (`0x`), despite two independent sources agreeing on it |
