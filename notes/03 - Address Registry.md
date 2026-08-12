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
| `DexArbitrageBotFlashLoan` (executor) | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | v13, live. Single-key owned (deployer) -- no Safe migration on this network |
| `UniswapV3Adapter` (**current**) | `0x15F894EF3e8ce6156878fEc9B82564142439735C` | Fixed router interface (security review finding #1, same bug as Base Sepolia -- see that network's section for the full writeup). Approved and confirmed live via `isAdapterApproved()`. Selector-verified against the router's real bytecode the same way. |
| `UniswapV3Adapter` (deprecated, wrong QuoterV2) | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | **Do not use** — deployed with a wrong QuoterV2, `QUOTER` is immutable, can't be patched |
| `UniswapV3Adapter` (deprecated, broken router interface) | `0x90dCEa7EcC443B96938d57758f92E24735b64800` | **Do not use** — previously labeled "working" since `quote()` functioned fine, but `swap()` targeted selectors that don't exist on the deployed SwapRouter02 (finding #1) -- would have reverted on every real trade. Superseded by the address above. |

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
| `DexArbitrageBotFlashLoan` (executor, **current**) | `0x9515a6e0E5e78A9C1A5cCC196800CA176FCBD486` | v13 source (post-operator-role), live. Owner is the Safe multisig below; `operator` is `0x0E7de81E4823c69f8c0930b66f718513523abb6b`, a fresh dedicated key -- see the key-separation note below for why this changed from the deployer key |
| `DexArbitrageBotFlashLoan` (executor, **deprecated**) | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | **Do not use** -- source predates the `operator` role; once ownership moved to the Safe, the bot's hot key could no longer call `requestFlashLoanArbitrage` at all (`onlyOwner`, not `onlyOperator`). Superseded by the address above. |
| `UniswapV3Adapter` (**current**) | `0xd4c69BB515E95EE18894BDe5480ECC4627D92875` | Fixed router interface (security review finding #1, see below). Wired to the same confirmed SwapRouter02 + QuoterV2 above. Approved on the current executor, confirmed live via `isAdapterApproved()` |
| `UniswapV3Adapter` (**deprecated, broken**) | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | **Do not use** -- `swap()` targets function selectors that don't exist on the deployed SwapRouter02, so every real swap would revert. See finding #1 below for the full writeup. `quote()` still worked, which is why this went unnoticed. |

Both `approveAdapter`/`approveToken` are active on the current executor (`approvalDelay` was temporarily set to 0 for this redeploy -- a testnet-only convenience per [[04 - Deployment Runbook]] -- then left at 0 rather than restored to 24h, since restoring it retroactively re-locks already-approved items against their original approval timestamp; caught live when `isAdapterApproved`/`isTokenApproved` unexpectedly flipped back to `false` right after the restore). `maxLoanAmount` remains deliberately 0 (not called), per [[04 - Deployment Runbook]] and [[06 - Pre-Mainnet Checklist]].

### UniswapV3Adapter router interface fixed (security review finding #1)

The adapter's `swap()` called the *original* v3-periphery `ISwapRouter` interface (which carries `deadline` inside `ExactInputSingleParams`/`ExactInputParams`), but every router address in this registry is **SwapRouter02**, which dropped `deadline` from those structs entirely -- changing the function selectors. This meant `swap()` would revert on every real trade, on both networks, since the deployment scripts existed. It went undetected because `quote()` uses `QuoterV2`, whose selectors are unaffected, so quoting always returned plausible numbers while `maxLoanAmount = 0` meant `swap()` was never actually reached in testing.

Caught by an independent security review, which confirmed the mismatch directly against live bytecode: the adapter's selectors (`0x414bf389`, `0xc04b8d59`) are absent from both deployed routers; only the SwapRouter02 selectors (`0x04e45aaf`, `0xb858183f`) are present.

Fixed by replacing `ISwapRouter` with `IV3SwapRouter` (SwapRouter02's real interface, no `deadline` field -- staleness is already bounded by the executor's own `executeBefore` check before any adapter is reached) and redeploying, since `ROUTER` is `immutable`. **Independently re-verified** (not just trusting the fix): pulled the router's real bytecode via `cast code` and ran `cast selectors` on it directly -- confirms `0x04e45aaf`/`0xb858183f` are present and `0x414bf389`/`0xc04b8d59` are absent, exactly matching what the new adapter now calls.

This bug would carry over unchanged to Ethereum Sepolia's `UniswapV3Adapter` (`working`, `0x90dCEa7...`) and to mainnet, since both use the same original `ISwapRouter` interface and both target real SwapRouter02 deployments -- worth fixing/redeploying there too before relying on either.

**Note for next deployment**: `VERSION()` still returns `"v13"` despite the operator-role/quoteRoute/degenerate-route changes -- the header changelog and `VERSION` constant weren't bumped before this redeploy. Worth doing before the *next* one, per the contract's own stated convention ("bump this alongside any future header changelog entry so it's checkable on-chain").

### Operator key separated from Safe signers (security review finding #2)

An independent security review (2026-08-11) caught that the `operator` role, when first introduced, was set to `0xe9376a141009cF5e6C7CE357Cf595Cf3B6a7a7Aa` -- which is simultaneously Safe owner #1 of 3 and the deployer key. That defeated the whole point of adding `operator`: a compromise of the always-on bot host would yield both trading-submission rights *and* one of the two signatures needed for full admin control (`approveAdapter`, `withdrawToken`, `transferOwnership`).

Fixed by generating a fresh, dedicated key (`0x0E7de81E4823c69f8c0930b66f718513523abb6b`, funded with 0.002 ETH for gas only, no other role) and calling `setOperator()` on it via a signed 2-of-3 Safe `execTransaction` -- confirmed live via `operator()`. `off-chain-bot/` now has its own `.env` (gitignored, matches `off-chain-bot/.env.example`'s schema) containing only this key, so the bot process never has access to anything Safe-signer-capable. Previously `off-chain-bot/` had no `.env` of its own, so running it from the repo root silently picked up the deployer/Safe-signer key from the root `.env`.

**Deferred to pre-mainnet, not done now**: `0xe9376a14...` remains a Safe owner on this testnet Safe. The reviewer's full recommendation includes removing it from the Safe's owner set (`swapOwner`) too, but that's a mainnet-readiness action, not something needed to prove the testnet mechanism -- see [[06 - Pre-Mainnet Checklist]].

## ✅ Base Sepolia — Safe multisig infrastructure

| Contract | Address | Verified via |
|---|---|---|
| SafeProxyFactory (v1.4.1) | `0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67` | Official `safe-deployments` repo + `cast code` (~3KB bytecode) |
| Safe singleton (v1.4.1) | `0x41675C099F32341bf84BFc5382aF534df5C7461a` | Official `safe-deployments` repo + `cast code` (~23.5KB) + `VERSION()` returns `"1.4.1"` |
| CompatibilityFallbackHandler (v1.4.1) | `0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99` | Official `safe-deployments` repo + `cast code` (~5.6KB bytecode) |

### Deployed Safe instance (Base Sepolia)

| Item | Value |
|---|---|
| Safe address | `0x63d055a8D26937A98edA61bB0A4d8C8244DE3197` |
| Owners | `0xe9376a141009cF5e6C7CE357Cf595Cf3B6a7a7Aa` (original deployer key), `0xb94976F7b0829874Fb29FC857623c8053c74736F`, `0x188A68CB73237f5650F081B7b1A021e6f9150E3a` |
| Threshold | 2-of-3 |
| Deployed via | `SafeProxyFactory.createProxyWithNonce()`; verified post-deploy via `getOwners()`, `getThreshold()`, and `VERSION()` all matching expectations |

`DexArbitrageBotFlashLoan` (`0x0B94...FfCE28`) ownership was transferred to this Safe via the contract's existing two-step `transferOwnership()`/`acceptOwnership()` flow -- the latter executed as a properly signed 2-of-3 `execTransaction()` (built and signed entirely via `cast`, not the Safe web UI), not a single-key call. `owner()` and `pendingOwner()` were re-checked on-chain after each step to confirm state, not assumed from transaction success alone. See [[06 - Pre-Mainnet Checklist]] for why single-key ownership was the risk this addresses.

**Every admin call on the bot now requires the same 2-of-3 signed pattern** -- `approveAdapter`, `approveToken`, `setMaxLoanAmount`, etc. can no longer be called with a single `cast send --private-key`.

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
