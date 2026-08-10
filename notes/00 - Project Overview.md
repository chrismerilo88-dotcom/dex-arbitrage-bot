---
tags: [overview]
---

# DexArbitrageBotFlashLoan — Project Overview

A flash loan arbitrage bot: borrow via Aave, swap through two DEX legs, repay, keep the difference — with the profit check enforced against *realized* balances, never assumed ones. Currently at contract version **v13**.

## Status right now

- ✅ Compiles clean (solc + real forge-std, verified repeatedly)
- ✅ Deployed and working on **Ethereum Sepolia** — see [[03 - Address Registry]]
- ✅ **Deployed and live on Base Sepolia** too — `DexArbitrageBotFlashLoan` at `0x0B94075406C2c004A0f80cD016E13B7211FfCE28`, `UniswapV3Adapter` at `0xaEb83a3F9ea57a88be1E0aBF473ec01c1FD1A12E`. Adapter + WETH approvals submitted, still in their 24h cooldown; `maxLoanAmount` deliberately left at 0. Deployed via raw `cast send`, not `forge script` — see [[03 - Address Registry]] for why. See [[04 - Deployment Runbook]] for post-deploy steps still ahead.
- ❌ **Mainnet: not deployed, not decided.** See [[06 - Pre-Mainnet Checklist]] before that ever happens.

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

## Where the actual code lives

Same project, one level up from this `notes/` folder: `contracts/`, `script/`, `test/`, `off-chain-bot/`. This vault is documentation *about* that code, not a copy of it — when in doubt, the code is the source of truth, these notes explain *why* it looks the way it does.
