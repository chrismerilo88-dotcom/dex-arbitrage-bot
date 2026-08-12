# Changelog

Version shown here matches `VERSION` on the deployed `DexArbitrageBotFlashLoan`
contract. v1–v9 were single-file iterations before this became a multi-file
project; v10 introduced the adapter architecture in `contracts/adapters/`.

## v14 — operator role, quoteRoute hardening, adapter fixes
Deferred findings from the v13 security review, finally addressed, plus
one addition found while doing it. All of this was already live on Base
Sepolia under the `v13` label before this bump — `VERSION` and this
changelog just hadn't caught up to what was actually deployed.

- **New `operator` role.** `requestFlashLoanArbitrage()` required
  `onlyOwner`, which stopped working the moment owner became a Safe
  multisig — a multisig can't realistically co-sign every automated
  submission. Added a separate, lower-privilege `operator` address
  (`onlyOperator`: owner or operator), settable only by owner via
  `setOperator()`, that can submit requests without any admin
  capability — lets the always-on off-chain bot hold a hot key that can
  only ever trigger trades.
- **`quoteRoute()` had no access control.** Anyone could call it with
  arbitrary `adapter1`/`adapter2` addresses, forcing the executor to make
  external calls of the caller's choosing as its own `msg.sender`. Not
  fund-losing on its own, but free ammunition against any future
  integration that trusts a call coming from this contract's address.
  Fixed by requiring both adapters already approved, plus the
  `nonReentrant`/`whenNotPaused` guards it was also missing.
- **Degenerate route shape reached an opaque panic.** A route shaped
  `[WETH, X, WETH]` (leg 1 starts and ends at the same token) made
  `_executeRoute`'s balance-delta subtraction underflow into a bare
  panic instead of a named revert. Rejected explicitly now, with
  `InvalidRoute()`.
- **`UniswapV3Adapter` called the wrong router interface.** `swap()` used
  the original v3-periphery `ISwapRouter` (`deadline` inside its
  structs) against a deployed SwapRouter02, which dropped `deadline`
  entirely — different function selectors, so every real swap would
  revert. `quote()` uses `QuoterV2`, a different interface entirely
  unaffected by this, which is why it went unnoticed: quotes always
  looked plausible while `maxLoanAmount = 0` kept `swap()` from ever
  actually being reached. Caught by an independent security review
  checking selectors against live router bytecode directly. Fixed by
  switching to `IV3SwapRouter` (SwapRouter02's real interface).
- **`CurveAdapter`'s `exchange()` return type didn't match the real
  pool.** Classic Vyper StableSwap pools return nothing from
  `exchange()`; declaring a non-`void` return type made Solidity revert
  while decoding a value the call never provided. Fixed by dropping the
  declared return and measuring output via balance delta instead,
  matching every other adapter's pattern.

## v13 — forge-lint fixes
Surfaced by forge's built-in linter and a real "stack too deep" compiler
limit, both only visible once the project was actually built with real
Foundry against real, adapter-heavy functions.

- **Stack too deep in `executeOperation()`.** Enough local variables (gas
  tracking, decoded route data, profit accounting) that Solidity's default
  code generator ran out of stack slots. Fixed via `foundry.toml`, not a
  code change: `via_ir = true` enables Solidity's newer IR-based pipeline,
  at the cost of slower compiles.
- **Unchecked `transferFrom()` return values in every adapter.** Each
  adapter pulled funds via a raw `transferFrom()` without checking its
  boolean return value. Added `safeTransferFrom()` to `SafeERC20.sol`,
  matching the existing pattern, and switched all four adapters to it —
  which also let the now-unnecessary `IERC20Min` import be dropped from
  each of them.
- **Not changed:** the three `block-timestamp` warnings (two 24-hour
  approval-cooldown checks and the `executeBefore` staleness guard). A
  validator's timestamp influence is on the order of seconds — irrelevant
  against an hours-long window, and not security-critical for a staleness
  check. The warning is a generic heuristic that doesn't apply at these
  timescales.

## v12 — real toolchain verification fixes
Found only once a real user actually ran `forge build` against this project
for the first time. Both issues below existed from v10 onward but were
invisible to every check run before this — a real gap in prior
verification (which only compiled `contracts/` in isolation, with a
solc.js stand-in rather than actual Foundry), not a new regression.

- **Duplicate file-level declarations across adapters.** `UniswapV2Adapter`,
  `UniswapV3Adapter`, `CurveAdapter`, and `BalancerAdapter` each
  independently declared their own local `error ZeroAddress()` and
  `interface IERC20Min`, and Curve/Balancer both also declared their own
  local `error UnsupportedRoute()`. Harmless on their own — but the moment
  any single file imports more than one of them together (exactly what
  `script/Deploy.s.sol` and `test/DeploySmokeTest.t.sol` both do), Solidity
  finds multiple conflicting definitions of the same name and refuses to
  compile. Fixed by consolidating the shared declarations into
  `contracts/interfaces/IERC20Min.sol` and
  `contracts/libraries/CommonErrors.sol`, imported everywhere instead of
  redeclared per-file.
- **Two wrong addresses in `Deploy.s.sol`.** The Balancer Vault constant
  was missing its trailing hex digit (39 characters instead of 40), and
  the Uniswap V3 QuoterV2 constant was an entirely different, wrong
  address, not just a checksum-case typo. Both were only surfaced by
  actually compiling the deploy script, and fixed after independently
  re-verifying the corrected values against Etherscan, the official
  Uniswap and Balancer GitHub source repositories, and multiple other
  chain explorers.

## v11 — post-review fixes
Found during a follow-up manual review after v10, without Foundry or Slither
available to automate it — a targeted re-read against known vulnerability
classes, not a tool-driven audit.

- **Gas backstop measured less than it claimed to.** The WETH gas-cost check
  ran *before* the repayment approval and profit sweep, so its own
  measurement silently excluded their gas cost. Moved the check to after
  both — a revert unwinds everything above it regardless of where in the
  function it happens, so there was no reason not to.
- **Silent wrong-sign failure in `BalancerAdapter`.** `quote()` cast a signed
  delta to `uint256` via `uint256(-deltas[1])`, assuming that delta is always
  negative. Explicit `int→uint` casts in Solidity reinterpret bits rather
  than check sign — if that assumption were ever wrong, the cast wouldn't
  revert, it would silently produce a huge wrong number. Traced where that
  number flows: it only ever feeds a slippage-bound calculation, which
  overflows (and cleanly reverts) when fed a number that large — so the
  practical failure mode was already "revert," not fund loss. Added an
  explicit revert on a positive delta anyway, rather than relying on that
  incidental downstream overflow to catch it.

## v10 — adapter architecture + WETH gas backstop
- Replaced the stored `routerA`/`routerB` + hardcoded Uniswap V2 interface
  with a per-request `adapter1`/`routeData1`/`adapter2`/`routeData2` design.
  Each adapter is a separately-deployed contract implementing the shared
  `IDexAdapter` interface (`quote`/`swap`); the executor no longer knows or
  cares which protocol a given adapter wraps. Shipped with
  `UniswapV2Adapter`, `UniswapV3Adapter`, `CurveAdapter`, and
  `BalancerAdapter`. `approveRouter`/`isRouterApproved` renamed to
  `approveAdapter`/`isAdapterApproved` accordingly. `quoteRoute()` is no
  longer `view`, since `IDexAdapter.quote()` isn't either (Uniswap V3's
  on-chain quoter needs write access internally) — call it via `eth_call`
  off-chain for a free read.
- Added a WETH-specific gas-cost backstop: when the borrowed asset is WETH,
  `executeOperation()` measures actual gas consumed and requires profit to
  clear it, on top of the off-chain-supplied `minProfit`. Approximate, not
  exact — see the in-file comment for exactly what it does and doesn't cover.

## v9 — router-revocation cleanup
- Revoking a router now also clears its `useUnlimitedApproval` flag, so a
  later re-approval always requires a fresh, explicit opt-in.
- Added `revokeApprovalBatch()` to clear several tokens' allowances against
  one router in a single transaction.

## v8 — approval cooldown + contract-existence check
- `approveRouter()`/`approveToken()` now start a cooldown (`approvalDelay`,
  default 24h) before the approval is usable — a process safeguard against a
  rushed or socially-engineered approval, with revocation still immediate.
- Added a check that the address being approved actually has contract code,
  catching the mundane mistake of pasting a wallet address into a
  token/router slot.

## v7 — borrow-size circuit breaker
- Added `maxLoanAmount`, starting at 0 so no request succeeds at all until
  the owner explicitly sets a cap. A fresh deployment is locked down by
  default, not silently uncapped.

## v6 — per-request routes replacing stored routers
- Replaced the fixed `routerA`/`routerB` + on-chain `_bestDirection()`
  search with caller-supplied `router1`/`path1`/`router2`/`path2` per
  request, supporting multi-hop paths. Route discovery moved off-chain,
  where a scanner can see more pools and react faster than any on-chain
  search.

## v5 — toggleable unlimited approval
- Added a per-router opt-in for unlimited approval instead of the default
  exact-amount-per-trade pattern, off by default. Added `revokeApproval()`
  as a manual kill switch, since disabling the toggle doesn't retroactively
  revoke an allowance already granted while it was on.

## v4 — gas pass and stricter failure modes
- Switched ~20 `require(x, "string")` sites to custom errors.
- Packed `_locked` and `_flashLoanActive` into the same storage slot.
- Added a fail-fast check when neither swap direction produces a usable
  quote, instead of sending doomed swap calls to the router.

## v3 — redundant on-chain quotes, balance-delta accounting, same-token guard
- Eliminated duplicate `getAmountsOut()` calls between direction-selection
  and execution by reusing the upfront simulation's results.
- Switched to measuring actual received amounts via balance deltas instead
  of trusting swap return data — correct even for fee-on-transfer tokens.
- Added a `tokenIn == tokenOut` guard at the request entrypoint (already
  present in the read-only profitability check, but missing where it
  actually mattered).
- Two-step ownership transfer (`transferOwnership`/`acceptOwnership`)
  instead of one-step, to prevent a typo'd or unreachable address from
  permanently locking the contract.

## v2 — hardening pass
- Fixed a reentrancy-lock deadlock: v1 put `nonReentrant` on both the
  request function and the Aave callback, but Aave calls the callback
  *from inside* the request call — the second lock check always failed.
  Fixed with a single outer lock plus a separate `_flashLoanActive` flag.
- Profit no longer sits in the contract until manually withdrawn — swept to
  the owner at the end of execution (toggleable).
- Added router and token allowlists; previously any address could be set as
  a router or used in a flash loan with no restriction.
- Added a request-level deadline (`executeBefore`), not just per-swap
  deadlines applied after execution had already started.

## v1 — initial version
Flash loan arbitrage bot: borrow via Aave, swap on one Uniswap V2-style
router, swap back on another, repay, keep the difference.
