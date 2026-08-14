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
| `DexArbitrageBotFlashLoan` (executor, **current**) | `0xa72F128406293837DD921c827868c4B78f9AC90D` | v14, live. Single-key owned (deployer) -- no Safe migration on this network. Was already on the operator-role/quoteRoute-guard/degenerate-route-check bytecode's *predecessor* (the pre-v14 executor below predates all three) -- this redeploy exists purely to pick those up and get `VERSION()` checkable on-chain, see the v14 writeup below. Adapter approved, `WETH`/`USDC`/`WSOL` all approved, `approvalDelay` 0, `maxLoanAmount` 0.1 ETH -- all confirmed live, matching the predecessor's config exactly |
| `DexArbitrageBotFlashLoan` (executor, **deprecated**) | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | **Do not use** -- predates the operator role entirely (`operator()` reverts, function doesn't exist on this bytecode). Superseded by the address above |
| `UniswapV3Adapter` (**current**) | `0x15F894EF3e8ce6156878fEc9B82564142439735C` | Fixed router interface (security review finding #1, same bug as Base Sepolia -- see that network's section for the full writeup). Unchanged by the v14 executor redeploy -- adapters aren't versioned, re-approved on the new executor as-is. Approved and confirmed live via `isAdapterApproved()`. Selector-verified against the router's real bytecode the same way. |
| `UniswapV3Adapter` (deprecated, wrong QuoterV2) | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | **Do not use** — deployed with a wrong QuoterV2, `QUOTER` is immutable, can't be patched |
| `UniswapV3Adapter` (deprecated, broken router interface) | `0x90dCEa7EcC443B96938d57758f92E24735b64800` | **Do not use** — previously labeled "working" since `quote()` functioned fine, but `swap()` targeted selectors that don't exist on the deployed SwapRouter02 (finding #1) -- would have reverted on every real trade. Superseded by the address above. |

### ⚠️ Ethereum Sepolia's WETH/USDC are NOT Aave-flash-loanable

Discovered on the first-ever real `requestFlashLoanArbitrage` attempt in this project (previously blocked by `maxLoanAmount = 0`): the request reverted at Aave's own `estimateGas` step with error `"27"`. Verified directly against Aave V3's `Errors.sol` source: `27 = RESERVE_INACTIVE` ("Action requires an active reserve").

Root cause, independently confirmed via `getReserveData()` on Aave's Sepolia Pool (`0x6Ae43d3271ff6888e7Fc43Fd7321a503ff738951`):

| Token | Our registry's address | `getReserveData()` result |
|---|---|---|
| WETH (Uniswap-verified) | `0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14` | All zeros -- never listed as an Aave reserve at all |
| USDC (Uniswap-verified) | `0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238` | All zeros -- same |

**Aave's Ethereum Sepolia market runs its own, entirely separate set of tokens** -- confirmed against the official `aave-address-book` repo (`AaveV3Sepolia.sol`): their own WETH (`0xC558DBdd856501FCd9aaF1E62eae57A9F0629a3c`), USDC (`0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8`), USDT, DAI, WBTC, etc. -- confirmed live as a real contract, self-identifying as `"WETH"`/`"WETH"`, and confirmed as an *active* Aave reserve (`getReserveData()` returns real, non-zero data including a real `aToken` address). None of Aave's own tokens match anything in this registry's Uniswap-verified token set, and no Uniswap V3 liquidity has been verified for Aave's own tokens.

**Practical consequence**: a real flash loan cannot currently execute on Ethereum Sepolia using this project's verified WETH/USDC/WSOL, regardless of contract correctness -- the borrowed asset must be one Aave actually lists, and that asset would then need real Uniswap liquidity of its own (unverified, likely absent). This isn't a code bug; it's a platform-level mismatch between two different testnet ecosystems.

**Base Sepolia does not have this problem** -- confirmed live: `getReserveData()` for the OP-stack WETH predeploy (`0x4200000000000000000000000000000000000006`) on Base Sepolia's Aave Pool (`0x8bAB6d1b75f19e9eD9fCe8b9BD338844fF79aE27`) returns real, active reserve data. Because the predeploy is a protocol-standard address baked into every OP-stack chain's genesis (see [[05 - Lessons Learned]]), Aave -- like every other protocol -- naturally uses it rather than deploying a separate WETH, so there's no split between "the WETH Aave lists" and "the WETH Uniswap trades" the way there is on Ethereum Sepolia. Base Sepolia's own second-token gap has since been closed (see the Base Sepolia section above) -- but a separate network was also fully verified and deployed to, below.

## ✅ Arbitrum Sepolia — confirmed live, deployed

Chosen after Ethereum Sepolia's Aave/Uniswap token mismatch (above) ruled that network out for a real end-to-end test. Arbitrum Sepolia was checked specifically for the same failure mode *before* committing to a deployment -- confirmed Aave's own listed reserves have real matching Uniswap liquidity here, unlike Ethereum Sepolia.

| Contract | Address | Verified via |
|---|---|---|
| Aave PoolAddressesProvider | `0xB25a5D144626a0D488e52AE717A051a2E9997076` | Official `aave-address-book` (`AaveV3ArbitrumSepolia.sol`) + `cast code` + `getMarketId()` returns `"Aave V3 Arbitrum Sepolia Testnet Market"` |
| Aave Pool (resolved) | `0xBfC91D59fdAA134A4ED45f7B584cAf96D7792Eff` | `PoolAddressesProvider.getPool()` |
| Aave's WETH (**flash-loanable**) | `0x1dF462e2712496373A347f8ad10802a5E95f053D` | Official `aave-address-book` + `cast code` + confirmed *active* reserve via `getReserveData()` (real aToken `0xf5f17EbE81E516Dc7cB38D61908EC252F150CE60`, matching the address book exactly) |
| Aave's USDC (**flash-loanable**) | `0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d` | Same treatment -- confirmed active reserve, real aToken `0x460b97BD498E1157530AEb3086301d5225b91216` |
| Uniswap V3 SwapRouter02 | `0x101F443B4d1b059569D643917553c771E1b9663E` | Official Uniswap docs (`developers.uniswap.org`, not a search-engine summary -- a prior search result mislabeled a **mainnet** router address as this network's testnet address; caught before use, see below) + `cast code` + selector-verified (`0x04e45aaf`/`0xb858183f` present, matching this project's already-fixed adapter) |
| Uniswap V3 Factory | `0x248AB79Bbb9bC29bB72f7Cd42F17e054Fc40188e` | Official Uniswap docs + `cast code` + self-consistency (router's own `factory()` returns this exact address) |
| Uniswap V3 QuoterV2 | `0x2779a0CC1c3e0E44D2542EC3e79e3864Ae93Ef0B` | Official Uniswap docs + `cast code` |

**WETH/USDC pool liquidity check, using Aave's exact token addresses** (the whole point -- confirming Aave's reserves and Uniswap's liquidity are for the *same* tokens, unlike Ethereum Sepolia):

| Fee tier | Pool address | Liquidity |
|---|---|---|
| 500 (0.05%) | `0x6399919A60d6a47e9927dDc7A45fb4995A5425bc` | `8708125569160` — nonzero |
| 3000 (0.3%) | `0x99A927D8127b7215FC11Ce1F1009e77ff8B1d1b0` | `0` — pool exists, empty |
| 10000 (1%) | `0xecb31BcF0C3BEc43b0f074f48D55C3cC8Ff5a39B` | `765346788228264` — nonzero, deepest pool found on any of the three networks in this file |

### Deployed contract instances (Arbitrum Sepolia)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor, **current**) | `0x9515a6e0E5e78A9C1A5cCC196800CA176FCBD486` | v14, live. Single-key owned (deployer) -- no Safe on this network. **Same address string as Base Sepolia's old, deprecated executor below -- different networks, coincidental nonce-driven collision, not the same contract.** `operator` is unset (`address(0)`) -- this network doesn't run a separate off-chain bot key, owner calls `requestFlashLoanArbitrage` directly |
| `DexArbitrageBotFlashLoan` (executor, **deprecated**) | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | **Do not use** -- was already on the operator-role/quoteRoute-guard/degenerate-route-check bytecode (deployed after security review finding #1, same as its `UniswapV3Adapter`), just still labeled `VERSION() == "v13"`. Superseded purely to get the version string checkable on-chain, see the v14 writeup below -- no functional difference from the address above |
| `UniswapV3Adapter` | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | Already-fixed router interface from day one (deployed after security review finding #1 was fixed) -- selector-verified against the real router the same way as every other network. Unchanged by the v14 executor redeploy, re-approved on the new executor as-is |

Adapter and both tokens (Aave's WETH + USDC) approved; `approvalDelay` set to 0 for testnet convenience (same pattern as the other networks), confirmed live via `isAdapterApproved()`/`isTokenApproved()` all returning `true`. `maxLoanAmount` set to 0.1 ETH.

**Caught during setup, logged so it's not repeated**: a web search initially returned `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` labeled as this network's SwapRouter02 -- the *exact same address* already logged in the ❌ table below as a previously-caught wrong address (the real **Ethereum mainnet** SwapRouter02, mistakenly attributed to Ethereum Sepolia earlier in this project). Same research-only error, different network, caught the same way: didn't trust the summary, went to Uniswap's own docs directly, then verified live.

**Funding note**: getting real ETH onto this network took two failed attempts before succeeding -- a faucet requiring a mainnet balance first (anti-abuse measure, blocked this testnet-only wallet), and a bridge transaction that was filled out but never actually confirmed/signed (wallet Activity tab stayed empty, balance unchanged). Third attempt -- properly confirming the Sepolia-to-Arbitrum-Sepolia bridge transaction -- worked, landing 0.02 ETH.

## ✅ Ethereum Mainnet — verified live, deployed (DRY_RUN only)

| Contract | Address | Verified via |
|---|---|---|
| WETH | `0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2` | `cast code` + `name()`/`symbol()` self-identification ("Wrapped Ether"/"WETH") |
| Aave PoolAddressesProvider | `0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e` | `cast code` + `getPool()` resolves to a real, live Pool contract |
| Uniswap V2 Router02 | `0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D` | `cast code` (not currently used by any deployed adapter -- v3-only so far on this network) |
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | `cast code` + self-consistent `factory()` |
| Uniswap V3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | `cast code` |
| Uniswap V3 Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | Queried directly from the confirmed-good SwapRouter02's own `factory()` -- self-consistent ground truth, same method as every other network |
| USDC | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | `cast code` + `name()`/`symbol()`/`decimals()` self-identification ("USD Coin"/"USDC"/6) |
| Balancer Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | `cast code` (not currently used -- no adapter deployed for it on this network) |

**WETH/USDC pool liquidity check**, all three fee tiers, same method as every other network:

| Fee tier | Pool address | Liquidity |
|---|---|---|
| 500 (0.05%) | `0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640` | `8796513570041565008` -- deepest of the three, real market depth |
| 3000 (0.3%) | `0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8` | `621917942391651938` |
| 10000 (1%) | `0x7BeA39867e4169DBe237d55C8242a8f2fcDcc387` | `13387167328646483` |

All orders of magnitude deeper than anything seen on any testnet in this file -- expected, this is where real market depth actually lives.

### Deployed contract instances (Ethereum Mainnet)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor) | `0x03e22682AA1e319E55598B89A3366083b2d28051` | v14, live. Single-key owned (deployer = a fresh key generated specifically for this, `0xD692484B3263dFb3c18fBaA545a4fcff38DFaB32`, funded with 0.005 ETH real money -- the only real-money spend so far, all gas). **`maxLoanAmount` is deliberately, permanently 0** -- see [[06 - Pre-Mainnet Checklist]]'s pre-funding bar. Deployed at a real gas price of ~0.075 Gwei (~$0.0002-0.0003 ETH total for deployment + adapter + approvals -- confirmed unusually cheap at deploy time, verified against the block's own `baseFeePerGas` directly, not just `cast gas-price`, since it looked implausibly low at first) |
| `UniswapV3Adapter` | `0x7400889e29Dd8E3a9667050571F2c87feDfa7450` | Wired to the confirmed SwapRouter02 + QuoterV2 above. `ROUTER()`/`QUOTER()` confirmed live post-deploy |

Adapter and WETH/USDC approved, `approvalDelay` 0. **`maxLoanAmount` intentionally never called** -- this deployment exists solely to let `off-chain-bot/` run `DRY_RUN=true` against real mainnet liquidity, observing whether genuine arbitrage opportunities exist, without any ability to execute a real trade regardless of what the off-chain code does. See [[06 - Pre-Mainnet Checklist]] for the exact milestone this is measuring toward.

**Two real bugs found only by actually running this against mainnet, not by writing/reviewing the code**:
1. `assertSubmissionSetupIsSafe()`'s mainnet `SUBMIT_RPC_URL` requirement blocked `DRY_RUN` mode entirely -- it exists to stop a *real* submission leaking to the public mempool, but `DRY_RUN` never submits anything at all, so the check was protecting against something structurally impossible in that mode. Fixed: skipped when `DRY_RUN=true`.
2. `maxLoanAmount = 0` (deliberately, permanently, for exactly the reason above) meant `tryRoute()` bailed out on its very first check, before ever reaching the real `quoteRoute()`/gas-estimate logic that `DRY_RUN` exists to run -- every attempt was recording `skipped_cap` with zero profitability data, silently defeating the entire deployment's purpose. Fixed: the `amount > maxLoanAmount` check is now skipped specifically when `DRY_RUN=true` (real submissions still enforce it unconditionally).

Off-chain scanner runs persistently via systemd (`off-chain-bot/dex-arbitrage-scanner-mainnet.service`, same pattern as `monitoring/`'s service), `WATCH_MODE=true`, reacting to every new mainnet block. Progress toward the 100-opportunity milestone: `node shared/report.js` (reads `shared/data/bot.db`, the same DB `off-chain-bot/` and `monitoring/` share).

**Update**: after real trade sizing (see below) confirmed no profitable size exists anywhere from 0.01-1000 WETH across all 9 fee-tier combinations on this pair, checked directly rather than just inferred from zero dry-run hits -- Ethereum mainnet's WETH/USDC is one of the single most heavily arbitraged pairs in all of crypto, and scanning one protocol against its own fee tiers doesn't create genuine price divergence when the same searchers correct all of those tiers together. See the Arbitrum Mainnet section below for the pivot this led to.

## ✅ Arbitrum Mainnet — verified live, deployed (DRY_RUN only, cross-DEX)

Deployed as a second DRY_RUN observer specifically to test genuine cross-DEX price divergence (Uniswap V3 vs. SushiSwap V2 on the same pair) rather than repeating Ethereum mainnet's same-protocol-different-fee-tier scanning, which turned out to already be fully arbitraged.

| Contract | Address | Verified via |
|---|---|---|
| WETH | `0x82aF49447D8a07e3bd95BD0d56f35241523fBab1` | Official `aave-address-book` (`AaveV3Arbitrum.sol`) + `cast code`. Independently cross-checked: SushiSwap's router `WETH()` call returns this exact same address |
| Aave PoolAddressesProvider | `0xa97684ead0e402dC232d5A977953DF7ECBaB3CDb` | Official `aave-address-book` + `cast code` + `getPool()` resolves to a real, live Pool contract |
| USDC (native, not USDC.e) | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` | Official `aave-address-book`'s `USDC_UNDERLYING` + `cast code` + `name()`/`symbol()`/`decimals()` self-identification ("USD Coin (Arb1)"/"USDC"/6) |
| Uniswap V3 SwapRouter02 | `0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45` | **Same address as Ethereum mainnet** -- Uniswap's real deterministic cross-chain deployment (confirmed, not a research-summary mixup like the ones logged in the wrong-addresses table below -- verified live on the actual Arbitrum RPC, self-consistent `factory()`, not just accepted because it matched a known address) |
| Uniswap V3 QuoterV2 | `0x61fFE014bA17989E743c5F6cB21bF9697530B21e` | Same address as Ethereum mainnet, same live-verification treatment |
| Uniswap V3 Factory | `0x1F98431c8aD98523631AE4a59f267346ea31F984` | Same address as Ethereum mainnet, self-consistent via the router's own `factory()` |
| SushiSwap Factory (V2-style) | `0xc35DADB65012eC5796536bD9864eD8773aBc74C4` | `cast code` + self-consistent via the router's own `factory()` call |
| SushiSwap Router02 (V2-style) | `0x1b02dA8Cb0d097eB8D57A175b88c7D8b47997506` | `cast code` + its own `WETH()` call matches Aave's WETH exactly (see above) |

**Real liquidity confirmed on both DEXs before deploying anything**:

| Venue | Pool/pair | Liquidity |
|---|---|---|
| Uniswap V3, 500 (0.05%) | `0xC31E54c7a869B9FcBEcc14363CF510d1c41fa443` | `33651878359847033` |
| Uniswap V3, 3000 (0.3%) | `0x17c14D2c404D167802b16C450d3c99F88F2c4F4d` | `13020943601521651` |
| Uniswap V3, 10000 (1%) | `0x7e5E4a3F855f19cC1a45b9eFF1c8B2419036CE85` | `83388783585344` |
| SushiSwap V2 pair | `0x905dfCD5649217c42684f23958568e533C711Aa3` | `40.01 WETH / 75,168 USDC` reserves -- token0 confirmed as WETH |

### Deployed contract instances (Arbitrum Mainnet)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor) | `0x03e22682AA1e319E55598B89A3366083b2d28051` | v14, live. **Same address string as the Ethereum Mainnet executor above -- different networks, coincidental nonce collision (same deployer, same fresh-chain nonce sequence), not the same contract.** Single-key owned by the same deployer key used for Ethereum mainnet (`0xD692484B3263dFb3c18fBaA545a4fcff38DFaB32`) -- separately funded with 0.005 ETH real money on Arbitrum specifically, since L2 balances are entirely independent of L1 balances even for the same address. **`maxLoanAmount` is deliberately, permanently 0**, same reasoning as Ethereum mainnet |
| `UniswapV3Adapter` | `0x7400889e29Dd8E3a9667050571F2c87feDfa7450` | Wired to the confirmed SwapRouter02 + QuoterV2 above. `ROUTER()`/`QUOTER()` confirmed live post-deploy |
| `UniswapV2Adapter` | `0x3C0be090cad892f2027576CcACCdA7C851324C5E` | New -- first live use of this adapter in the project. Wired to SushiSwap's confirmed Router02. `ROUTER()` confirmed live post-deploy |

Both adapters and WETH/USDC approved, `approvalDelay` 0, `maxLoanAmount` confirmed 0 post-setup. Off-chain scanner runs persistently via systemd (`off-chain-bot/dex-arbitrage-scanner-arbitrum-mainnet.service`), `WATCH_MODE=true`, `DRY_RUN=true`. With two protocols configured, candidate count is 16 (up from Ethereum mainnet's 9) -- includes genuine cross-DEX candidates (a Uniswap V3 leg paired with a SushiSwap V2 leg), not just same-protocol fee-tier variants. Same `node shared/report.js` (filter by "Arbitrum Mainnet") tracks progress here too.

**Funding note**: getting ETH onto this deployer address (on Arbitrum specifically, separate from its existing Ethereum mainnet balance) needed care -- an early attempt via a MetaMask-embedded buy widget defaulted to buying ARB (Arbitrum's governance token, an ERC-20) instead of ETH, and separately defaulted the destination network back to Ethereum Mainnet after switching the asset. Both caught before completing the purchase. Landed correctly after explicitly re-selecting ETH as the asset and Arbitrum Mainnet as the network, then a manual send from the user's own wallet to the deployer address.

## ✅ Base Sepolia — confirmed live

| Contract | Address | Verified via |
|---|---|---|
| WETH | `0x4200000000000000000000000000000000000006` | OP-stack genesis predeploy — protocol-guaranteed on every OP-stack chain, the one documented exception to the live-check rule (see [[05 - Lessons Learned]]) |
| Aave PoolAddressesProvider | `0xE4C23309117Aa30342BFaae6c95c6478e0A4Ad00` | `cast code` (~6.6KB bytecode returned) |
| Uniswap V3 SwapRouter02 | `0x94cC0AaC535CCDB3C01d6787D6413C739ae12bc4` | `cast code` (~24.5KB bytecode returned) |
| Uniswap V3 QuoterV2 | `0xC5290058841028F1614F3A6F0F5816cAd0df5E27` | `cast code` (~8.2KB bytecode returned). Sourced from the official Uniswap docs GitHub repo (`Base-Deployments.md`), cross-validated by its paired SwapRouter02 matching the address above — but still went through a live check per the rule, not trusted on source quality alone |
| USDC (candidate token) | `0x036CbD53842c5426634e7929541eC2318f3dCF7e` | Circle's official testnet address (`developers.circle.com/stablecoins/usdc-contract-addresses`) + `cast code` + `name()`/`symbol()`/`decimals()` self-identification ("USDC"/"USDC"/6 -- 6 decimals matches genuine USDC, unlike WSOL's 18-decimal mock on Ethereum Sepolia) + real pool liquidity confirmed against WETH at all 3 fee tiers |

All four original Base Sepolia addresses confirmed, plus this fifth (USDC) -- the first second-token verification on this network, closing the "more token pairs" gap flagged earlier.

**WETH/USDC pool liquidity check** (same method as every other pool in this file): Factory derived self-consistently from the confirmed SwapRouter02's own `factory()` (`0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24`), then `Factory.getPool()` queried at fee tiers 500, 3000, 10000.

| Fee tier | Pool address | Liquidity |
|---|---|---|
| 500 (0.05%) | `0x94bfc0574FF48E92cE43d495376C477B1d0EEeC0` | `448098251397` — nonzero |
| 3000 (0.3%) | `0x46880b404CD35c165EDdefF7421019F8dD25F4Ad` | `345051610381846` — nonzero, deepest of the three |
| 10000 (1%) | `0x4664755562152EDDa3a3073850FB62835451926a` | `57734017049` — nonzero |

All three tiers have real liquidity (better coverage than Ethereum Sepolia's WETH/USDC or WETH/WSOL, which each only had liquidity at some tiers). `token0`/`token1` on the 3000-tier pool confirmed as exactly USDC/WETH, sorted by address.

### Deployed contract instances (Base Sepolia)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor, **current**) | `0x57fdced36481271588d0A5EdAD6F23Df1A4C8716` | v14, live. Owner is the Safe (ownership transfer fully complete, see the "v14 redeploy" subsection immediately below). `operator` is `0x0E7de81E4823c69f8c0930b66f718513523abb6b` (unchanged from before), confirmed live via a real `estimateGas` call from that key (reverted with `AmountExceedsCap()`, not `NotOperator()`) |
| `DexArbitrageBotFlashLoan` (executor, **deprecated**) | `0x9515a6e0E5e78A9C1A5cCC196800CA176FCBD486` | **Do not use** -- v13-labeled predecessor, superseded to get `VERSION()` checkable on-chain (see the v14 writeup below). **Same address string as Arbitrum Sepolia's current executor above -- different networks, coincidental nonce-driven collision, not the same contract.** |
| `DexArbitrageBotFlashLoan` (executor, **deprecated**) | `0x0B94075406C2c004A0f80cD016E13B7211FfCE28` | **Do not use** -- source predates the `operator` role entirely. |
| `UniswapV3Adapter` (**current**) | `0xd4c69BB515E95EE18894BDe5480ECC4627D92875` | Fixed router interface (security review finding #1, see below). Wired to the same confirmed SwapRouter02 + QuoterV2 above. Unchanged by the v14 executor redeploy -- approved on the new executor as-is, confirmed live via `isAdapterApproved()` |
| `UniswapV3Adapter` (**deprecated, broken**) | `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E` | **Do not use** -- `swap()` targets function selectors that don't exist on the deployed SwapRouter02, so every real swap would revert. See finding #1 below for the full writeup. `quote()` still worked, which is why this went unnoticed. |

`approveAdapter`/`approveToken`/`setApprovalDelay(0)`/`setOperator` all re-applied on the new executor, confirmed live. **Correction to a stale note that used to be here**: this section previously said `maxLoanAmount` "remains deliberately 0" on the prior (v13-labeled) executor -- that was stale by the time of the v14 redeploy; a live check just before redeploying found it had actually been set to 0.1 ETH at some point without this doc being updated. Exactly the kind of drift the "verify live, don't trust notes" rule exists for -- the new executor's `maxLoanAmount` was set to match the live value (0.1 ETH), not the stale doc.

#### v14 redeploy -- Safe ownership transfer completed

Deploying a new executor makes the deployer key its initial owner again -- moving it to the Safe needed the same two-step `transferOwnership()`/`acceptOwnership()` flow as the original migration (see the Safe infrastructure section below), and `acceptOwnership()` had to be called *by* the Safe, i.e. a signed 2-of-3 `execTransaction()`. The deployer-only half (`setOperator`, then `transferOwnership(safe)`) was done first with the one Safe-owner key available directly in this environment; the second signature came from owner #2's key (`0xb94976F7...4736F`), recovered from an earlier session's own transcript (these are `cast wallet new`-generated throwaway testnet keys, printed to that session's terminal output when the Safe was first set up, not stored in any project file or the user's wallet). `execTransaction()` submitted with both signatures in ascending owner-address order, confirmed live:

- `owner()` → `0x63D055A8D26937a98EdA61bb0A4d8C8244de3197` (the Safe)
- `pendingOwner()` → `0x0000000000000000000000000000000000000000` (cleared)

**Worth flagging for [[06 - Pre-Mainnet Checklist]]**: this session was able to complete a 2-of-3 multisig action alone because two of the three "signer" keys turned out to be recoverable from old conversation transcripts, not because they were properly custodied by separate parties -- exactly the throwaway-key risk that checklist item already calls out. A real multisig depends on the signers being unable to do this to each other, which testnet convenience never actually tested.

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

## ✅ BNB Chain Mainnet — verified live, deployed (DRY_RUN only)

Checked after Ethereum mainnet's WETH/USDC confirmed fully arbitraged and Arbitrum was already in progress -- asked "what else." Both prerequisites confirmed live:

| Contract | Address | Verified via |
|---|---|---|
| Aave PoolAddressesProvider | `0xff75B6da14FfbbfD355Daf7a2731456b3562Ba6D` | Official `aave-address-book` (`AaveV3BNB.sol`) + `cast code` + `getPool()` resolves to a real, live Pool contract |
| WBNB | `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` | Official `aave-address-book`'s `WBNB_UNDERLYING` + `cast code` + `symbol()` self-identification |
| USDT | `0x55d398326f99059fF775485246999027B3197955` | Official `aave-address-book`'s `USDT_UNDERLYING` + `cast code` + `symbol()`/`decimals()` self-identification ("USDT"/18 -- note 18 decimals, not USDT's usual 6, since this is BNB Chain's own bridged/native deployment) |
| PancakeSwap V3 Factory | `0x0BFbCF9fa4f9C56B0F40a671Ad40E0805A091865` | Official `pancake-v3-contracts` GitHub repo's own `deployments/bscMainnet.json` + `cast code`, cross-confirmed independently via a second source (the `@pancakeswap/v3-sdk` npm package's bundled constants) before trusting it |
| PancakeSwap V3 QuoterV2 | `0xB048Bbc1Ee6b733FFfCFb9e9CeF7375518e25997` | Same source + `cast code` + `cast selectors` against live bytecode confirms `quoteExactInputSingle`/`quoteExactInput` selectors match Uniswap's QuoterV2 shape exactly |
| PancakeSwap V3 SwapRouter | `0x1b81D678ffb9C0263b24A97847620C99d213eB14` | Same source + `cast code`. **Does NOT match Uniswap SwapRouter02's interface** -- see below |

**Real liquidity confirmed**, WBNB/USDT across all four of PancakeSwap's fee tiers (100/500/2500/10000 -- different from Uniswap's 500/3000/10000):

| Fee tier | Pool address | Liquidity |
|---|---|---|
| 100 (0.01%) | `0x172fcD41E0913e95784454622d1c3724f546f849` | `6312567662236941418074908` -- deepest by far |
| 500 (0.05%) | `0x36696169C63e42cd08ce11f5deeBbCeBae652050` | `1883574879993795241208613` |
| 2500 (0.25%) | `0x1401ff943D08a7E098328C1d3a9d388923B115D2` | `16691348847140023560818` |
| 10000 (1%) | `0x6805E0E5333c5c3acCF2930Be4734E2b98f4Ce06` | `1344953231590004411922` |

**Router interface mismatch found, same category of bug this project already caught once for Uniswap SwapRouter02**: PancakeSwap's real SwapRouter uses selectors `0x414bf389`/`0xc04b8d59`, confirmed via `cast selectors` against its live bytecode -- the *original* v3-periphery `ISwapRouter` interface (deadline in the structs), not SwapRouter02's `IV3SwapRouter` that `UniswapV3Adapter.sol` targets and every other network in this file actually deploys. PancakeSwap never adopted SwapRouter02's interface. Deploying the existing adapter against it would have reverted on every real swap -- caught before deploying anything, not after.

Fixed with a new `contracts/adapters/PancakeV3Adapter.sol`, otherwise identical to `UniswapV3Adapter.sol` but targeting the original `ISwapRouter` shape. Verified before writing it: independently recomputed both selectors via `cast sig` from the interface's own struct shape and confirmed an exact match against the real router's live bytecode, not assumed from "PancakeSwap is a Uniswap V3 fork." QuoterV2's selectors, by contrast, were separately checked and do match Uniswap's shape -- only the router needed a new interface. Compiles clean, 32/32 fork-free unit tests still pass.

### Deployed contract instances (BNB Chain Mainnet)

| Contract | Address | Notes |
|---|---|---|
| `DexArbitrageBotFlashLoan` (executor) | `0xEea58C6F3C0708c658c6d4Db98d789B1Bedc6F8C` | v14, live. Single-key owned by a fresh deployer key generated specifically for this network (`0x4041AE6c57e9F0453c6531bdA87178e3543254B9`), funded with ~0.015 BNB real money (all gas). **`maxLoanAmount` is deliberately, permanently 0**, same reasoning as every other DRY_RUN-only mainnet deployment |
| `PancakeV3Adapter` | `0xb36F2fF64f2Fc6Cf3008a7846181492b4C61Bf3A` | First live use of this new adapter. `ROUTER()`/`QUOTER()` confirmed live post-deploy, matching the addresses above |

Adapter and WBNB/USDT approved, `approvalDelay` 0, `maxLoanAmount` confirmed 0 post-setup. PancakeSwap V3 only for now (single protocol, 16 candidates) -- same phased approach as Ethereum Mainnet before Arbitrum's cross-DEX expansion; if this comes back fully arbitraged too, the next step is a second BNB Chain DEX (BiSwap, ApeSwap, or PancakeSwap's own V2), not more of the same protocol.

**Real, live bug caught during setup, not deployment**: at the default `SCAN_CONCURRENCY=10`, 0/16 candidates returned a quote at all against the free public RPC (`bsc-dataseed1.binance.org`) -- confirmed via a manual `cast call quoteRoute()` that the contract/adapter were fine, so the failure was purely RPC-side. At `SCAN_CONCURRENCY=1`, all 16/16 quoted successfully. The free public endpoint silently fails/rate-limits under concurrent `eth_call` load in a way `rankCandidates()`'s bare `catch` can't distinguish from "no pool here" -- `.env.bnb-mainnet` runs at concurrency 1 accordingly. A paid/dedicated BSC RPC would likely tolerate more, but hasn't been set up for this network.

Off-chain scanner runs persistently via systemd (`off-chain-bot/dex-arbitrage-scanner-bnb-mainnet.service`, same pattern as the other two mainnet scanners), `WATCH_MODE=true`, `DRY_RUN=true`. `node shared/report.js` (filter by "BNB Chain Mainnet") tracks progress here too.

### Second DEX added (2026-08-14): BiSwap

After ~4,634 attempts on PancakeSwap V3 alone with zero profitable opportunities, added a second DEX -- same reasoning as Arbitrum's SushiSwap addition. **BiSwap chosen deliberately over PancakeSwap V2 or ApeSwap**: PancakeSwap V2 is the same team as the already-deployed V3 pool, so their own market-makers likely keep V2/V3 prices aligned (same dead-end pattern as Ethereum's fee-tier scanning finding nothing). BiSwap is an independent team, more likely to show genuine divergence.

**Address conflict caught, verified live before trusting either**: a web search returned two different "official" BiSwap router addresses -- one from a search snippet (`0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8`), one from BiSwap's own official docs page, labeled "Smart Router" (`0x0eB6949e725A295Ecb3BEacFc3766610BC970BEF`). Verified via direct `cast call` against both:
- `0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8`: `factory()` returns `0x858E3312ed3A876947EA49d572A7C42DE08af7EE`, `WETH()` returns `0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c` -- the exact same WBNB address already verified elsewhere in this file (self-consistent ground truth). This is the real classic-`IUniswapV2Router02`-interface router.
- `0x0eB6949e725A295Ecb3BEacFc3766610BC970BEF` ("Smart Router" per BiSwap's own docs): both `factory()` and `WETH()` **revert** -- not a standard V2 router interface at all, incompatible with `UniswapV2Adapter.sol`. Official docs pointed at the wrong contract for this purpose.

| Contract | Address | Verified via |
|---|---|---|
| BiSwap Router | `0x3a6d8cA21D1CF76F653A67577FA0D27453350dD8` | `cast code` + `factory()`/`WETH()` self-consistency check above |
| BiSwap Factory | `0x858E3312ed3A876947EA49d572A7C42DE08af7EE` | Discovered live via the router's own `factory()` -- not from any external source |
| WBNB/USDT pair | `0x8840C6252e2e86e545deFb6da98B2a0E26d8C1BA` | `Factory.getPair()` + `getReserves()`: ~207,751 USDT / ~339 WBNB (~$612/BNB, ~$415k+ TVL) -- real, substantial liquidity |
| `BiSwapAdapter` (a `UniswapV2Adapter` instance) | `0x5C6CC639AC1d094c3A2d6ef9ae8926856e2fA2e0` | Deployed via the established `cast send --create` workaround. `ROUTER()` confirmed live matching the router above. End-to-end `quote()` tested: 1 WBNB -> 608.99 USDT, consistent with the pool's real reserves |

Approved (`isAdapterApproved()` confirmed `true` immediately, `approvalDelay` still 0 on this network). `off-chain-bot/.env.bnb-mainnet`'s `ADAPTERS` now lists both adapters (`v3,v2`) and `V2_FACTORY_ADDRESS` was added so the reserve-math pre-filter covers the new adapter too. Scanner restarted and confirmed live: candidate count went from 16 (V3-only) to 25 (V2×V3 cross-DEX combinations), all 25 returning real quotes. `maxLoanAmount` reconfirmed `0` before and after every step of this addition -- still DRY_RUN only, no ability to execute a real trade.

## 🔄 Curve / Balancer — investigated, blocked, not verified

The off-chain bot already has working infrastructure for both protocols (protocol-tagged `ADAPTERS` config, correct route encoding for each, and for Curve specifically, on-chain auto-discovery of a pool's traded pair via `coins()` -- see `off-chain-bot/index.js`). Neither has an actual verified pool to point that infrastructure at yet.

**Curve**: no current, actively-maintained testnet deployment found on Ethereum Sepolia, Base Sepolia, or Arbitrum Sepolia. Curve's own official reference docs (`curve.readthedocs.io/ref-addresses.html` -- an authoritative source, not a search summary) list zero testnet addresses, only mainnet and production L2s; `docs.curve.finance/references/deployed-contracts/` 404s. The one lead found (crvUSD on Sepolia) traces to a 2023 pre-mainnet-launch announcement -- roughly 3 years stale, no confirmed-current address. Not pursued further rather than guess at a stale/unconfirmed address.

**Balancer**: found a real, live pool token on Ethereum Sepolia (`0x054dc1c0b7bffd4107b01e9a4799fdc31cf726fb`, "JLY/50-ETH/50") -- confirmed via `cast code`, `name()`/`symbol()`, and a self-consistent `getPoolId()` (first 20 bytes match the pool's own address). But calling the Vault's `getPoolTokens(poolId)` with that ID reverts with `BAL#500` -- verified against Balancer's own `BalancerErrors.sol` source: `500 = INVALID_POOL_ID`. The Vault itself (`0xBA12222222228d8Ba445958a75a0704d566BF2C8`, confirmed live and genuinely Sepolia-specific via its own `WETH()` returning a Sepolia-only address, not mainnet's) doesn't recognize this poolId as registered. Most likely explanation: this pool was created under Balancer V3 (also live on Ethereum Sepolia per search results), which uses a different registration system than V2 -- `BalancerAdapter.sol` in this project targets V2's Vault interface specifically, so a V3 pool would be incompatible regardless of the poolId issue.

**To close this out later**: either find a genuine Balancer V2 (not V3) pool with a poolId the V2 Vault actually recognizes, or find a current Curve deployment -- both need the same live-verification treatment as everything else in this file, not just a source that claims one exists.

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
