---
tags: [security]
---

# Security Review Log

See also: [[00 - Project Overview]] · [[01 - Architecture]] · [[06 - Pre-Mainnet Checklist]]

Full detail lives in `CHANGELOG.md` in the project root — this note is the condensed, "why it matters" version, organized by theme rather than strictly by version number.

## Fund-safety fixes (would have risked principal)

- **v2 — reentrancy deadlock**: v1 put `nonReentrant` on both the request function and the Aave callback; since Aave calls the callback *from inside* the request call, every call would have reverted. Fixed with one outer lock + a separate `_flashLoanActive` flag.
- **v3 — balance-delta accounting**: switched from trusting swap return values to measuring actual balances before/after. Correct even for fee-on-transfer tokens; doesn't depend on any router's return data being honest.
- **v8 — approval cooldown**: newly-approved routers/tokens now wait `approvalDelay` (24h default) before they're usable. A process safeguard against a rushed or socially-engineered approval — revocation stays immediate.
- **v9 — router revocation cleanup**: revoking a router now also clears its unlimited-approval flag, so re-approval always requires a fresh, explicit opt-in.

## Correctness fixes (would have caused broken/unexpected behavior, not fund loss)

- **v5 — unlimited approval reset bug**: fixed to only skip the zero-first reset when the current allowance is confirmed exactly 0.
- **v6 — replaced on-chain router search with per-request routes**: route discovery moved off-chain (a scanner sees more, reacts faster than any on-chain search could).
- **v12 — duplicate file-level declarations**: `error ZeroAddress()` and `interface IERC20Min` were redeclared identically in every adapter file. Harmless alone; broke the moment `Deploy.s.sol` imported more than one adapter together. Fixed by centralizing into shared files.
- **v13 — stack too deep**: `executeOperation()` had enough local variables to exceed Solidity's default stack limit. Fixed via `via_ir = true` in `foundry.toml`, not a code change.

## Caught only by live testing, not by research (the important pattern)

This is the single most repeated lesson of this whole project, worth its own callout:

- **v12 — two wrong mainnet addresses**: caught by solc's own checksum validation and independent re-verification, before ever touching a live network.
- **Sepolia Aave PoolAddressesProvider**: looked "verified across chains" per Etherscan's cross-link UI. Was actually a *different* address on Sepolia entirely. Only caught because `forge script --broadcast` returned `call to non-contract address` — a live call, not more reading.
- **Sepolia Uniswap V3 QuoterV2**: same failure pattern, caught the same way — `cast code` returning empty bytecode where research said there'd be a real contract.

**The rule that came out of this**: Etherscan showing "Contract: Verified... Sepolia Testnet · Hoodi Testnet" as a cross-link on a *different* network's page is not proof of deployment on that network. The only things that count as verification now: a *direct* fetch of that specific network's explorer page, or (better) a live `cast code` / `cast call` against the actual RPC. See [[03 - Address Registry]] for the verification method logged against every address, and [[05 - Lessons Learned]] for the full story.

## Explicitly declined, with reasoning

- `tx.origin == owner` checks for MEV — actively harmful, breaks multisig ownership.
- Block-number-based expiry instead of `block.timestamp` — the timestamp-manipulation concern doesn't apply meaningfully at the timescales these checks actually use (24h cooldowns, minutes-long deadlines).
- A circuit-breaker counting consecutive losses — structurally impossible on-chain, since a reverted transaction can't leave a trace for a future call to read. Belongs off-chain instead.
