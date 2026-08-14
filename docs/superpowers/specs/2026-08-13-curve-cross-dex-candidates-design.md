# Curve cross-DEX candidate pairing — design

## Purpose

`off-chain-bot/index.js`'s `resolveCurveCandidates()` builds a Curve
candidate as a round trip through the *same* Curve pool in both
directions (`adapter1 === adapter2`, both the Curve adapter). This can
never be profitable — it's paying the pool's own swap fee twice with
nothing to arbitrage against. As a result, Curve has never actually
produced a usable candidate anywhere in this project.

This design lets a Curve leg pair against a *different* generic (v2/v3)
adapter instead — the combination needed to actually compare Curve's
pricing against another DEX's, which is the entire point of adding Curve.

## Motivating case

Curve's real 3pool (DAI/USDC/USDT, ~$159.6M TVL on Ethereum Mainnet) was
verified live: real bytecode, `coins(0/1/2)` match DAI/USDC/USDT exactly,
`get_dy(1, 2, 1000000)` returns a sane quote via the classic `int128`
interface `CurveAdapter.sol` expects, real deep liquidity in all three
balances. This is deployable and compatible today — the blocker is
routing logic, not the pool or the contract.

## Scope decisions

Resolved through brainstorming before this design was written:

- **`BORROWED_ASSET` on Ethereum Mainnet changes from WETH to USDC.**
  `resolveCurveCandidates`'s existing coin-matching logic requires
  `BORROWED_ASSET` to be one of the pool's own coins (DAI/USDC/USDT for
  3pool) — WETH never matches, so Curve is a structural no-op there
  regardless of routing-logic changes unless this also changes. USDC is
  already an approved, verified token on this deployment (currently a
  `VIA_TOKEN`), so this reuses existing approval, not a new one. This
  also reframes the deployment's strategy: from WETH/USDC arb (already
  confirmed at 0 opportunities, too competed) to stablecoin arb, a
  structurally different edge (small persistent peg deviations, not a
  volatile-pair price race).
- **2-leg only, no triangular-with-Curve.** `CurveAdapter.sol` requires
  exactly 2 tokens per leg (its own `SCOPE LIMIT`), so a Curve leg can
  never be part of a multi-hop-in-one-leg triangular path the way v2/v3
  legs can. Pairing it in a simple round trip against a generic adapter's
  single-hop leg is the smallest version that tests the real idea.
  Triangular-with-Curve is a real non-goal for this design, not an
  oversight — revisit only if 2-leg data justifies it.
- **The same-pool round-trip candidate is dropped, not kept alongside.**
  It can never be selected as the best candidate (guaranteed loss to
  fees), so keeping it would only waste one `quoteRoute()` call per scan
  for no benefit.

## Architecture

Two changes:

1. **New pure function, `off-chain-bot/lib.js`**:
   `buildCurveCrossCandidates({ curveAdapterAddress, genericAdapters,
   borrowedAsset, otherToken, curveIOut, curveJOut, feeTiers, amount,
   minProfit, slippageBps })`. Given an already-resolved Curve pairing
   (which token, which coin indices — resolved by the caller in
   `index.js`, since that requires an RPC call), builds two candidates per
   generic (v2/v3) adapter: one with Curve as the outbound leg and the
   generic adapter as the return leg, and one with the legs reversed. No
   RPC calls of its own, so it's unit-testable with fabricated inputs —
   mirrors `buildTwoLegCandidates`'s existing style and the codebase's
   established pure/impure split (`lib.js`'s own header comment: "Anything
   that needs chain state... stays in index.js").
2. **Replace `resolveCurveCandidates` with `resolveCurveCrossCandidates`
   in `index.js`**: keeps the existing pool/coin discovery unchanged
   (`POOL()`, `coins(0)`/`coins(1)`, the borrowed-asset match check, and
   its skip-with-log-message behavior when no match). Instead of building
   a same-pool round trip on a match, calls the new
   `buildCurveCrossCandidates()` once per curve adapter, passing
   `config.genericAdapters` — the same v2/v3 adapter list the generic
   candidate builder already uses.

## Data flow

1. `buildCandidates()` (orchestration unchanged) calls
   `resolveCurveCrossCandidates(config.curveAdapters,
   config.genericAdapters, config.borrowedAsset, provider, config)` after
   building the generic v2/v3 candidates, same call site as today.
2. Per curve adapter: discover pool, read `coins(0)`/`coins(1)`
   (unchanged). No match with `borrowedAsset` → skip, log, unchanged
   behavior.
3. Match found → call `buildCurveCrossCandidates()` once, producing
   `2 × genericAdapters.length × feeCombos(feeTiers, 1)` candidates (the
   fee-tier loop only applies to v3 generic adapters; v2 collapses to one
   iteration, same convention as `buildTwoLegCandidates`).
4. Those candidates flow into the unmodified
   `prefilterCandidates()` → `rankCandidates()` → `tryRoute()` pipeline.
   Already verified: `prefilterCandidates()` skips pricing any hop whose
   protocol isn't `v3`/`v2` (`factoryAddress` resolves to `null`, hop is
   excluded from the price cache) and clusters unpriced candidates at the
   bottom of the ranking rather than dropping them — so Curve-tagged hops
   are already handled safely with zero changes needed there.
5. **Config change** (`off-chain-bot/.env.mainnet`): `BORROWED_ASSET`
   changes from WETH (`0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2`) to
   USDC (`0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`). WETH moves from
   `BORROWED_ASSET` into `VIA_TOKENS` (alongside the existing USDC entry,
   which is removed since it's now the borrowed asset) so the existing
   WETH↔USDC Uniswap V3 scanning surface isn't lost, just re-rooted at
   USDC instead of WETH. `ADAPTERS` gets the new Curve adapter instance
   appended with a `:curve` tag.

## Error handling

No new failure modes. `resolveCurveCrossCandidates` reuses the exact same
pool-discovery calls `resolveCurveCandidates` already makes today, which
already tolerate a non-matching pool by skipping with a log line. Every
downstream stage (`prefilterCandidates`, `rankCandidates`, `tryRoute`)
already tolerates a bad or reverting candidate on a per-candidate basis
without aborting the scan — unchanged by this design.

## Testing

`buildCurveCrossCandidates()` is pure, tested in the existing
`lib.test.js` (matches its `describe`/`test` convention). Cases:
Curve-out/generic-back and generic-out/Curve-back both produce
correctly-encoded candidates (route data decodes to the expected
tokens/extra); a v3 generic adapter produces one candidate pair per fee
tier; a v2 generic adapter produces exactly one pair (no fee-tier loop);
multiple generic adapters each produce their own candidate pairs.

No new tests needed for `prefilterCandidates`/`rankCandidates`/`tryRoute`
— already verified by reading the code that they handle an
unpriced/unknown-protocol hop safely, and this design doesn't change
their behavior.

**Live verification, done before this design was written**: Curve's
3pool address, bytecode, `coins()`, `get_dy()`, and real liquidity
balances were all confirmed live via `cast call` against Ethereum
Mainnet — not assumed from any single source. See the "Second DEX added"
precedent in `notes/03 - Address Registry.md`'s BNB Chain section for
the same discipline applied to a different network.

## Non-goals

- No triangular routes involving a Curve leg (2-leg only, see Scope
  decisions).
- No submission/execution changes — this only produces candidates for
  the existing DRY_RUN `tryRoute()` pipeline, same as every other
  candidate type. `maxLoanAmount` stays 0.
- No changes to `CurveAdapter.sol` — already correct and verified live
  against the real pool.
- No changes to Arbitrum or BNB Chain's scanners — they have no
  curve-tagged adapters configured, so `resolveCurveCrossCandidates`
  returns nothing for them, identical to today's behavior.
