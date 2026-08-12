---
tags: [overview]
---

# DexArbitrageBotFlashLoan — Project Overview

A flash loan arbitrage bot: borrow via Aave, swap through two DEX legs, repay, keep the difference — with the profit check enforced against *realized* balances, never assumed ones. Currently at contract version **v13**.

## Status right now

- ✅ Compiles clean (solc + real forge-std, verified repeatedly)
- ✅ **Deployed and live on three testnets**: Ethereum Sepolia, Base Sepolia, and Arbitrum Sepolia — see [[03 - Address Registry]] for every address and how each was verified. All three have `maxLoanAmount` unlocked to a small testnet cap (0.1 ETH on the first two); Arbitrum Sepolia is the only network confirmed capable of an actual end-to-end flash loan (Ethereum Sepolia's Aave reserves don't match its Uniswap-liquid tokens; Base Sepolia has no arbitrage opportunity found yet on its one verified pair).
- ✅ Base Sepolia has a 2-of-3 **Safe multisig** as owner (Ethereum Sepolia and Arbitrum Sepolia are still single-key owned). A separate `operator` role exists so the off-chain bot's hot key never needs owner-level access — see the key-separation writeup in [[03 - Address Registry]].
- ✅ **Independent security review completed and both findings fixed**: the V3 adapter's router interface was silently broken since early in the project (fixed + redeployed everywhere); the operator key had overlapped with a Safe signer (fixed via key rotation). Several other findings (gas-adjusted profit floor not enforced, MEV-split leak, weak relay validation, a self-deadlocking cancellation path) fixed in the off-chain bot too.
- ✅ Off-chain bot (`off-chain-bot/index.js`) does real opportunity discovery now — protocol-aware routing (v2/v3/curve, decimals-aware, triangular routes), not just a placeholder. Optional local reserve-math pre-filter (`V3_FACTORY_ADDRESS`/`V2_FACTORY_ADDRESS`) ranks candidates from cheap `slot0()`/`getReserves()` reads before spending a full `quoteRoute()` call on each one — verified live on Base Sepolia within 0.19% of the real QuoterV2 simulation.
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
