---
tags: [troubleshooting, lessons]
---

# Lessons Learned

See also: [[02 - Security Review Log]] · [[03 - Address Registry]] · [[04 - Deployment Runbook]]

## The big one: research is not verification

**Etherscan showing "Contract: Verified... Sepolia Testnet · Hoodi Testnet" as a cross-link on a mainnet page is not proof the contract exists on Sepolia.** It happened three separate times in this project — Aave's PoolAddressesProvider, Uniswap's Factory, Uniswap's QuoterV2 — each time with source-code-verified confidence, each time wrong for the specific testnet.

**What actually works**: `cast code <address> --rpc-url <RPC>` against the *real* network. Empty (`0x`) means nothing's there, regardless of how many sources agreed it should be. When something needs to reference its own dependency (like a router referencing its factory), querying it directly (`cast call <router> "factory()(address)"`) is more reliable than any external source, because it's self-consistent ground truth.

**One real exception**: OP-stack predeploys (like WETH at `0x4200...0006` on every OP-stack chain) *are* trustworthy without a live check, because they're baked into chain genesis by protocol design — not a coincidental deployer-nonce match like the cases above.

## Environment setup gotchas (WSL specifically)

- **Invisible password prompts are normal.** Linux terminals show zero feedback when typing a password — no dots, nothing. Looks broken, isn't.
- **WSL and Windows are separate filesystems.** A file downloaded on Windows needs an explicit `cp /mnt/c/Users/.../file /home/user/` — it's not automatically visible from the Linux side.
- **`forge install` needs a real git repo.** Just unzipping a project doesn't create one. `git init && git add . && git commit -m "..."` first.
- **Foundry CLI flags change between versions.** `--no-commit` on `forge install` stopped being valid at some point; the error message itself said so (`tip: a similar argument exists`).
- **Environment variables don't persist between terminal sessions.** Re-export `PRIVATE_KEY`/RPC URLs (`export X=$(grep X .env | cut -d '=' -f2-)`) every time a new terminal window opens.

## Solidity/Foundry gotchas

- **Duplicate file-level declarations only break when imported together.** Two files can each declare `error Foo()` with zero conflict — until one file imports both, and Solidity finds two definitions of the same name. Fix: centralize shared declarations into one file, import everywhere.
- **`immutable` variables can't be patched after deployment.** A wrong constructor argument (like a bad QuoterV2 address) means redeploying that specific contract, not fixing it in place.
- **Stack-too-deep is a real, common limit**, not exotic — any function with enough local variables can hit it. `via_ir = true` in `foundry.toml` is the standard fix, at the cost of slower compiles.
- **Explicit `int` → `uint` casts don't check sign** — they reinterpret bits. A wrong sign assumption produces a huge wrong number silently, not a revert, unless you add the check yourself.
