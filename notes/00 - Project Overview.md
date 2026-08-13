---
tags: [overview]
---

# DexArbitrageBotFlashLoan — Project Overview

A flash loan arbitrage bot: borrow via Aave, swap through two DEX legs, repay, keep the difference — with the profit check enforced against *realized* balances, never assumed ones. Currently at contract version **v14**.

## Status right now

- ✅ Compiles clean (solc + real forge-std, verified repeatedly)
- ✅ **Deployed and live on three testnets**: Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia — see [[03 - Address Registry]] for every address and how each was verified. All three redeployed to v14 (VERSION() was stuck at "v13" through several real behavioral changes — see CHANGELOG.md's v14 entry) and re-confirmed with the exact same live config as before: `maxLoanAmount` 0.1 ETH, `approvalDelay` 0, adapter/tokens approved. Arbitrum Sepolia remains the only network confirmed capable of an actual end-to-end flash loan (Ethereum Sepolia's Aave reserves don't match its Uniswap-liquid tokens; Base Sepolia has no arbitrage opportunity found yet on its one verified pair).
- ✅ Base Sepolia's new v14 executor is fully owned by the Safe again — `owner()`/`pendingOwner()` both confirmed live after a signed 2-of-3 `execTransaction()`. See the "v14 redeploy" note in [[03 - Address Registry]] for how the second signature was obtained (a real, worth-reading caveat about testnet key custody, feeding [[06 - Pre-Mainnet Checklist]]). Ethereum Sepolia and Arbitrum Sepolia remain single-key owned.
- ✅ **Independent security review completed and both findings fixed**: the V3 adapter's router interface was silently broken since early in the project (fixed + redeployed everywhere); the operator key had overlapped with a Safe signer (fixed via key rotation). Several other findings (gas-adjusted profit floor not enforced, MEV-split leak, weak relay validation, a self-deadlocking cancellation path) fixed in the off-chain bot too.
- ✅ Off-chain bot (`off-chain-bot/index.js`) does real opportunity discovery now — protocol-aware routing (v2/v3/curve, decimals-aware, triangular routes), not just a placeholder. Optional local reserve-math pre-filter (`V3_FACTORY_ADDRESS`/`V2_FACTORY_ADDRESS`) ranks candidates from cheap `slot0()`/`liquidity()`/`getReserves()` reads before spending a full `quoteRoute()` call on each one. V3's estimate now uses the pool's real liquidity depth (Uniswap's own swap-step math, reimplemented directly with native `BigInt` rather than pulling in `@uniswap/v3-sdk`'s heavy legacy dependency tree) instead of spot price alone — verified live on Base Sepolia: an exact 0.000000% match against real QuoterV2 for a trade that stayed within one tick (was 0.19% off with the old spot-price-only version), with the known remaining gap being trades large enough to cross a tick boundary.
- ✅ `monitoring/monitor.js` watches every admin-state event (approvals, ownership, operator, cap changes) across all three testnets in real time, plus Telegram alerts and `/status`/`/pause`/`/resume` control (shared with `off-chain-bot/`'s circuit breaker via `shared/data/bot.db`). Runs persistently via systemd (`Restart=always`, survives logout).
- ✅ **Mainnet: real executors deployed on three networks, `maxLoanAmount` permanently 0 on all three — DRY_RUN observation only, no ability to execute a real trade.** Ethereum Mainnet (WETH/USDC, Uniswap V3 only) found zero profitable opportunities anywhere from 0.01-1000 WETH across all 9 fee-tier combinations — that pair is too heavily arbitrage-competed for same-protocol scanning to find anything. Arbitrum Mainnet was deployed next specifically to test genuine cross-DEX divergence instead (Uniswap V3 + SushiSwap V2 on the same pair). BNB Chain Mainnet followed (PancakeSwap V3, single protocol for now) — deploying there surfaced a real router-interface mismatch (PancakeSwap kept the original `ISwapRouter` shape, not SwapRouter02's), fixed with a new `PancakeV3Adapter.sol` before ever deploying it, and separately surfaced that the free public BSC RPC silently fails under concurrent load (fixed by dropping `SCAN_CONCURRENCY` to 1 for that network only). All three run continuously via systemd, logging every real quote/gas-estimate outcome to `shared/data/bot.db`. Working toward [[06 - Pre-Mainnet Checklist]]'s explicit bar — 100+ observed opportunities with positive net P&L — before any real trading capital is ever funded. Progress: `node shared/report.js`. See [[03 - Address Registry]] for addresses and the real bugs each deployment surfaced that pure code review hadn't caught.
- ✅ Off-chain bot now sizes every candidate instead of testing one fixed `SCAN_AMOUNT` — `findOptimalTradeSize()` in `lib.js` finds the locally-best amount via ternary search over the same price data the pre-filter already fetches (zero extra RPC cost), verified against an independent brute-force scan before trusting it. This immediately mattered live: found and executed the first fully successful flash-loan arbitrage this project has completed, on Base Sepolia — the fixed `SCAN_AMOUNT` had never found real profit there all session.

## The one sentence that matters most

No code — not this one, not a rewrite, not a different tool — can guarantee profitability. What *is* fully engineered is that the contract cannot knowingly execute a trade that loses money: `finalAmount <= amountOwed` or `profit < minProfit` both revert before funds move, checked against real balances. See [[06 - Pre-Mainnet Checklist]] for what that does and doesn't protect against.

## Map of this vault

- [[01 - Architecture]] — how the adapter system and RouteData encoding work
- [[02 - Security Review Log]] — every real issue found, v1 through v13, and why each fix exists
- [[03 - Address Registry]] — every verified contract address, per network, with confidence level
- [[04 - Deployment Runbook]] — the actual step-by-step, from zero to deployed
- [[05 - Lessons Learned]] — specific gotchas hit and how they were solved
- [[06 - Pre-Mainnet Checklist]] — what has to be true before real money is ever involved
- [[07 - Glossary]] — plain-language definitions for the DeFi/Solidity terms used everywhere else
- [[08 - Signer Key Generation Runbook]] — how each mainnet Safe signer generates and custodies their own key, and the real testnet incident that makes this non-optional

## Where the actual code lives

Same project, one level up from this `notes/` folder: `contracts/`, `script/`, `test/`, `off-chain-bot/`. This vault is documentation *about* that code, not a copy of it — when in doubt, the code is the source of truth, these notes explain *why* it looks the way it does.
