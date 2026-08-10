---
tags: [glossary, reference]
---

# Glossary

See also: [[01 - Architecture]]

**Flash loan** — A loan borrowed and repaid within a single transaction, with no upfront collateral. If it can't be repaid by the end of the transaction, the entire transaction reverts as if it never happened — this is what makes it safe for the lender.

**Slippage** — The difference between a trade's expected price and its actual execution price, usually because the trade itself moves the pool's price. `slippageBps` bounds how much of this is tolerated before a swap reverts.

**MEV (Maximal Extractable Value)** — Value a transaction orderer (validator, or a searcher paying them) can capture by choosing how to order or insert transactions — e.g. seeing your profitable trade in the mempool and copying it with higher priority. Solidity can't prevent this directly; the real defense is submitting transactions privately (Flashbots Protect, MEV Blocker) rather than through the public mempool.

**Adapter** (in this project) — A small contract wrapping one specific DEX router/pool/vault behind a shared interface, so the executor doesn't need protocol-specific logic. See [[01 - Architecture]].

**RouteData** — This project's shared encoding (`tokens` + protocol-specific `extra` bytes) that lets any adapter type plug into the same executor. See [[01 - Architecture]].

**Approval cooldown** — A required waiting period (`approvalDelay`) between approving a new router/token and it becoming usable — a review window against a rushed or socially-engineered approval, not a technical guarantee.

**Immutable** (Solidity) — A variable set once in the constructor and never changeable afterward. Cheaper than regular storage, but means a wrong constructor argument requires redeploying, not patching.

**Stack too deep** — A Solidity compiler limit on how many local variables a function can track at once with the default code generator. Fixed via `via_ir = true`, which switches to a different (slower-compiling) code generation pipeline.

**`cast`** — Foundry's command-line tool for reading (`cast call`, `cast code`) and writing (`cast send`) to any contract on any network directly from the terminal — the tool that caught every wrong address in this project.

**Testnet vs. mainnet** — A testnet (Sepolia, Base Sepolia, ...) is a separate blockchain using worthless fake currency, used for practice with zero real financial risk. Mainnet is the real network with real money. Contracts, addresses, and liquidity on one have no relationship to the other — a Sepolia address being correct says nothing about whether the "same" address is correct on mainnet, and vice versa.
