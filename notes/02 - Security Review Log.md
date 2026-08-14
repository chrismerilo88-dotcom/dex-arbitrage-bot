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

## Independent static analysis (Slither, 2026-08-14)

Run against every contract (`~/.local/slither-venv/bin/slither . --foundry-out-directory out` -- installed in a dedicated venv since this machine's system Python is externally-managed (PEP 668) and has no global pip; not committed to this repo, Slither 0.11.6): 45 findings (2 High, 13 Medium, 9 Low, 21 Informational, per `--json` output), 21 contracts, 102 detectors. None were a new, previously-unknown fund-safety bug -- every finding is either an already-deliberate design choice this project's own comments already explain, or a known Slither false-positive category. Worth recording precisely *because* the result is "nothing new," not despite it -- this is exactly the kind of evidence [[06 - Pre-Mainnet Checklist]]'s "an unfound bug" risk item asks for, and confidence should update on a real negative result, not just on real findings.

- **`reentrancy-balance` in `executeOperation` -- the only 2 of the 45 findings Slither itself rates High, reviewed on their own rather than folded into the generic reentrancy bucket below**: flags `_ensureApproval(asset, address(POOL), amountOwed)`'s external `token.call(...)` (an `approve()` on the borrowed asset) as reentrancy-enabling, with `profit` (computed earlier from `finalAmount - amountOwed`) called a "stale variable" when later checked against `gasCostWei`. Two independent reasons this isn't exploitable, not one: (1) `profit` is a local variable, not a storage read -- a reentrant call executes in its own separate call frame and cannot mutate the outer frame's already-computed `profit`, so "stale" doesn't apply the way it would to a storage-backed balance; (2) even granting a worst-case reentrant call during that `approve()` (only possible at all if the owner had already approved a non-standard, hook-having token through the existing cooldown-gated allowlist -- standard ERC20 `approve()`/`transfer()` never call back to anyone), it can't reach anything new: `requestFlashLoanArbitrage` is behind the already-held `nonReentrant` lock, `executeOperation` itself is behind `msg.sender != address(POOL)`, and any admin function reentered into is one the owner could already call directly with no privilege gained. Separately worth noting since it looks related but isn't a reentrancy question at all: the WETH gas backstop's `revert ProfitBelowGasCost()` fires *after* the profit sweep already transferred funds to `owner` (line 575, checked at line 581) -- safe regardless, because a revert unwinds the entire atomic transaction including that transfer, exactly as the contract's own existing comment on that check already states ("if this reverts, everything above still unwinds together with it").
- **`reentrancy-events`/`reentrancy-benign` (executeOperation, requestFlashLoanArbitrage, revokeApproval\*)**: the remaining, lower-severity reentrancy findings -- same "external call before a later action" heuristic, same guard chain (`nonReentrant` + `_flashLoanActive` + `msg.sender == POOL`) already covers them. Matches this project's own v2 reentrancy-deadlock reasoning above -- the outer lock plus `_flashLoanActive` is the actual guard, and this is exactly what it's protecting.
- **Uninitialized local `activatesAt`** (`approveAdapter`/`approveToken`): false positive -- Solidity zero-initializes it, and the revoke branch deliberately leaves it at `0` (there's no future activation time to report when revoking; revocation is immediate, per this file's v8 entry above). The emitted event correctly reports `0` in that case.
- **Missing zero-check on `setOperator`**: false positive -- the function's own doc comment says `address(0)` is the *documented* way to clear the operator role, not an oversight.
- **Timestamp comparisons, low-level `.call` usage, ignored adapter return values**: all already-deliberate, already-documented elsewhere (timestamp: this file's "Explicitly declined" section below; ignored return values: v3's balance-delta accounting entry above -- trusting a balance delta instead of a swap's return value is the intentional fix, not an oversight it's re-flagging).
- **Naming convention, unindexed event params, solc-version informational notice**: cosmetic/informational only, no fund-safety or correctness implication.

Not yet run: Mythril or a professional third-party audit -- Slither closes the "did an automated tool see something obvious that manual review missed" gap, not the "an audit firm's manual review" gap. [[06 - Pre-Mainnet Checklist]]'s "not yet closed" status on that item stands.

## Explicitly declined, with reasoning

- `tx.origin == owner` checks for MEV — actively harmful, breaks multisig ownership.
- Block-number-based expiry instead of `block.timestamp` — the timestamp-manipulation concern doesn't apply meaningfully at the timescales these checks actually use (24h cooldowns, minutes-long deadlines).
- A circuit-breaker counting consecutive losses — structurally impossible on-chain, since a reverted transaction can't leave a trace for a future call to read. Belongs off-chain instead.
