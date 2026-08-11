---
tags: [checklist, risk, mainnet]
---

# Pre-Mainnet Checklist

See also: [[00 - Project Overview]] · [[01 - Architecture]]

This is not a formality — real money is genuinely at risk once any of this points at mainnet with a funded wallet. What follows is where that risk actually lives, and what does/doesn't already protect against it.

## What's already protected, structurally

- ✅ The contract cannot knowingly execute a trade at a loss — `finalAmount`/`minProfit` checks are against realized balances, not assumptions.
- ✅ A fresh deployment starts fully locked (`maxLoanAmount = 0`) — nothing executes until deliberately unlocked.
- ✅ New router/token approvals go through a cooldown before they're usable.

## What's not protected — the real risk surface

- [ ] **Gas on failed attempts.** Near-certain over time, not hypothetical. Every reverted attempt still costs real gas. Sizing: how many attempts is the off-chain bot expected to make per day, and what's the gas budget for that?
- [ ] **An unfound bug.** The security review done in this project is real but is *not* a professional audit. Confidence is highest in the core flow (reentrancy, balance-delta accounting, profit floor — tested repeatedly). Confidence is explicitly lower in the Curve and Balancer adapters (flagged as unverified against live contracts from the start). Consider: does this get a real audit before mainnet, or does mainnet exposure stay capped low enough that an unfound bug is tolerable?
- [ ] **Owner key security** — **not yet closed.** What *is* done: the migration mechanism (Safe multisig via the contract's two-step `transferOwnership()`/`acceptOwnership()`) was proven end-to-end on a Base Sepolia dry run — a 2-of-3 Safe was deployed and ownership migrated to it, with `acceptOwnership()` executed as a properly signed `execTransaction()`, not a single key. See [[03 - Address Registry]] for the addresses and verification steps. What's *not* done: the 3 signers in that dry run include two throwaway keys generated purely to prove the flow. This box only closes once mainnet has real, separately-held signer keys — ideally hardware wallets per signer.
- [ ] **A bad approval slipping through the cooldown review window.** The cooldown creates a window to catch a mistake — it doesn't catch it automatically. Who's actually watching `RouterApprovalSet`/`TokenApprovalSet` events during that window?
- [ ] **Underlying protocol risk.** Aave, Uniswap, Curve, Balancer are all their own codebases. Flash loans limit this exposure (no standing deposit) but the swap step still means trusting them for that instant.

## Before flipping the switch

- [ ] `maxLoanAmount` set to something genuinely small relative to what you could tolerate losing entirely to gas/bugs — not the number you eventually want to run at.
- [ ] A specific answer to "what's the maximum I'm prepared to lose to figure out something is wrong," decided in advance, not in the moment.
- [ ] Owner key on something better than a hot wallet with the private key sitting in a plaintext `.env` file (fine for testnet, not for this) -- the *mechanism* (Safe multisig via two-step ownership transfer) is proven on Base Sepolia per the item above, but mainnet needs real signers on real hardware, not the throwaway keys used for that dry run.
