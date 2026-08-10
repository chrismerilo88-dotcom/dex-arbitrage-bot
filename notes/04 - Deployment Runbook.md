---
tags: [runbook, deployment]
---

# Deployment Runbook

See also: [[03 - Address Registry]] · [[06 - Pre-Mainnet Checklist]]

## 0. One-time machine setup

- [ ] Foundry installed (`forge --version` works)
- [ ] Node.js installed (`node --version` works)
- [ ] Project unzipped, `forge install foundry-rs/forge-std` run
- [ ] `git init` + one commit (forge's dependency installer needs a real git repo — see [[05 - Lessons Learned]])

## 1. Compile

```
forge build
```
Expect: `Compiler run successful!`. `via_ir = true` is already set in `foundry.toml` — without it, `executeOperation()` hits a stack-too-deep limit (see [[02 - Security Review Log]]).

## 2. Fork test

```
forge test --fork-url $MAINNET_RPC_URL -vvv
```
This is the step that actually catches real bugs — see [[05 - Lessons Learned]] for why research alone isn't enough.

## 3. Per-network setup (repeat for each new network)

- [ ] Get an RPC URL (Alchemy, one app per network or "enable networks" on an existing app)
- [ ] Get testnet funds from a faucet for that specific network
- [ ] Add `<NETWORK>_RPC_URL` to `.env`
- [ ] **Verify every address for this network** — see [[03 - Address Registry]]. Live `cast code` check, not research alone.
- [ ] Write/update a `Deploy<Network>.s.sol` script with only confirmed-good addresses

## 4. Deploy

```
export PRIVATE_KEY=$(grep PRIVATE_KEY .env | cut -d '=' -f2-)
export <NETWORK>_RPC_URL=$(grep <NETWORK>_RPC_URL .env | cut -d '=' -f2-)
forge script script/Deploy<Network>.s.sol --rpc-url $<NETWORK>_RPC_URL --broadcast
```

This starts the approval cooldown for every adapter/token it approves — nothing is usable yet.

## 5. Post-deploy configuration checklist

- [ ] `isAdapterApproved()` / `isTokenApproved()` confirmed `true` (after cooldown, or after `setApprovalDelay(0)` on testnet only)
- [ ] `setMaxLoanAmount()` called — nothing executes at all until this is set above 0
- [ ] Real pool liquidity confirmed via `Factory.getPool()` + `Pool.liquidity()`, not just address correctness
- [ ] `quoteRoute()` tried against a real route, confirms full call chain works end to end

## 6. Record the result

Add the new deployed contract addresses to [[03 - Address Registry]] immediately — don't rely on remembering them or digging through terminal history later.

## Fallback: deploying without `forge script` (when the local fork EVM can't run it)

Some chains run opcodes/precompiles ahead of what a given Foundry build's local revm supports — `forge script` and `forge test --fork-url` both execute the script/test locally first, so both fail with `EvmError: NotActivated` (or similar) even though the identical call succeeds via a direct `cast call` against the real RPC. This hit Base Sepolia specifically for the Aave PoolAddressesProvider's `getPool()` call — see [[03 - Address Registry]] for the full writeup. `--skip-simulation` does **not** help; forge still has to run the script once locally to build the transaction list.

When this happens, deploy with raw `cast send` instead — no local EVM execution at all, so the local/live gap is irrelevant:

```
# 1. Get creation bytecode for each contract
ADAPTER_BYTECODE=$(forge inspect UniswapV3Adapter bytecode)
BOT_BYTECODE=$(forge inspect DexArbitrageBotFlashLoan bytecode)

# 2. ABI-encode constructor args and append (strip the leading 0x)
ADAPTER_ARGS=$(cast abi-encode "constructor(address,address)" $ROUTER $QUOTER)
ADAPTER_FULL="${ADAPTER_BYTECODE}${ADAPTER_ARGS#0x}"

# 3. Broadcast the raw creation transaction directly — no simulation
cast send --private-key $PRIVATE_KEY --rpc-url $<NETWORK>_RPC_URL --create "$ADAPTER_FULL"
# contractAddress in the receipt is the deployed address

# 4. Same pattern for DexArbitrageBotFlashLoan(addressesProvider, weth),
#    then the post-deploy approveAdapter()/approveToken() calls as normal
#    `cast send <bot> "approveAdapter(address,bool)" <adapter> true` calls.
```

Check the deployer's balance first (`cast balance <address> --rpc-url ... --ether`) and sanity-check current gas price (`cast gas-price --rpc-url ...`) — there's no forge-provided gas estimate or preflight in this path, so a badly wrong balance assumption is the only way this silently fails partway through.
