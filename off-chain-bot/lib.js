/**
 * Pure, side-effect-free logic split out of index.js: route encoding,
 * candidate building, and the local reserve-math pre-filter's math. None
 * of this touches a provider, wallet, or the network -- that's what makes
 * it possible to unit test (see lib.test.js) without faking env vars or
 * risking an accidental real RPC/network call from a test run. Anything
 * that needs chain state (resolveHopPrice, resolveCurveCandidates,
 * rankCandidates, tryRoute, etc.) stays in index.js.
 */

const { ethers } = require('ethers');

const KNOWN_PROTOCOLS = new Set(['v2', 'v3', 'curve', 'balancer']);
// Protocols whose adapters are token-agnostic (any approved pair works),
// as opposed to bound to one specific pre-deployed pool.
const GENERIC_PROTOCOLS = new Set(['v2', 'v3']);

// abi.encode(address[] tokens, bytes extra) -- mirrors RouteData.sol.
// extra is empty for a plain V2 leg; see the main README for Curve/
// Balancer's extra encodings.
function encodeV2RouteData(tokens) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(['address[]', 'bytes'], [tokens, '0x']);
}

// Same RouteData envelope, but `extra` is abi.encode(uint24[] fees) --
// one Uniswap V3 fee tier per hop, matching UniswapV3Adapter.sol exactly.
function encodeV3RouteData(tokens, fees) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const extra = abiCoder.encode(['uint24[]'], [fees]);
  return abiCoder.encode(['address[]', 'bytes'], [tokens, extra]);
}

// Curve: extra = abi.encode(int128 i, int128 j) -- the pool's own coin
// indices, matching CurveAdapter.sol exactly. Always exactly 2 tokens
// (Curve adapters wrap one specific pool, not an arbitrary path).
function encodeCurveRouteData(tokens, i, j) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const extra = abiCoder.encode(['int128', 'int128'], [i, j]);
  return abiCoder.encode(['address[]', 'bytes'], [tokens, extra]);
}

// Balancer: extra = abi.encode(bytes32 poolId), matching
// BalancerAdapter.sol exactly. Always exactly 2 tokens.
function encodeBalancerRouteData(tokens, poolId) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  const extra = abiCoder.encode(['bytes32'], [poolId]);
  return abiCoder.encode(['address[]', 'bytes'], [tokens, extra]);
}

/** `ADAPTERS=0xabc:v3,0xdef:v2,0x123:curve` -- protocol defaults to v3 if omitted, matching this project's pre-existing single-adapter config with no breaking change. */
function parseAdapterList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [address, protocolRaw] = entry.split(':').map((s) => s.trim());
      const protocol = (protocolRaw || 'v3').toLowerCase();
      if (!KNOWN_PROTOCOLS.has(protocol)) {
        throw new Error(`ADAPTERS entry "${entry}" has unknown protocol "${protocol}" -- expected one of ${[...KNOWN_PROTOCOLS].join(', ')}`);
      }
      return { address, protocol };
    });
}

/**
 * Parses ADAPTER_FACTORY_OVERRIDES ("adapterAddress:factoryAddress,...")
 * into a Map keyed by lowercased adapter address. Only needed when two
 * adapters share the same protocol tag but trade through different
 * factories (e.g. two separate 'v2' DEXes on the same network) -- the
 * global V2_FACTORY_ADDRESS/V3_FACTORY_ADDRESS covers every other
 * adapter of that protocol by default, this is strictly an override for
 * the ones that need a different one. See prefilterCandidates()'s use of
 * this in index.js.
 */
function parseAdapterFactoryOverrides(raw) {
  const map = new Map();
  for (const entry of (raw || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [adapter, factory] = entry.split(':').map((s) => s.trim());
    map.set(adapter.toLowerCase(), factory);
  }
  return map;
}

function parseAddressList(raw) {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFeeTiers(raw) {
  return (raw || '500,3000,10000').split(',').map((s) => Number(s.trim()));
}

/** Cartesian product of feeTiers, `hops` deep -- one fee tier per hop in a leg. */
function feeCombos(feeTiers, hops) {
  if (hops <= 1) return feeTiers.map((f) => [f]);
  const shorter = feeCombos(feeTiers, hops - 1);
  const combos = [];
  for (const f of feeTiers) {
    for (const rest of shorter) combos.push([f, ...rest]);
  }
  return combos;
}

function adapterPairs(adapters) {
  const pairs = [];
  for (const a1 of adapters) {
    for (const a2 of adapters) pairs.push([a1, a2]);
  }
  return pairs;
}

/** v2 ignores fee tiers entirely -- one route per hop, no fee-tier loop. */
function encodeForProtocol(protocol, tokens, fees) {
  if (protocol === 'v2') return encodeV2RouteData(tokens);
  if (protocol === 'v3') return encodeV3RouteData(tokens, fees);
  throw new Error(`encodeForProtocol: "${protocol}" is not a generic (token-agnostic) protocol`);
}

/**
 * Every BORROWED_ASSET -> viaToken -> BORROWED_ASSET round trip (one hop
 * per leg), across every generic (v2/v3) adapter pair -- and, for v3,
 * every fee-tier combination. v2 has no fee tiers, so that inner loop
 * collapses to a single iteration for a v2 leg.
 */
function buildTwoLegCandidates({ genericAdapters, borrowedAsset, viaTokens, feeTiers, amount, minProfit, slippageBps }) {
  const candidates = [];
  for (const [adapter1, adapter2] of adapterPairs(genericAdapters)) {
    const feesOut = adapter1.protocol === 'v3' ? feeCombos(feeTiers, 1) : [[]];
    const feesBack = adapter2.protocol === 'v3' ? feeCombos(feeTiers, 1) : [[]];
    for (const viaToken of viaTokens) {
      for (const [feeOut] of feesOut) {
        for (const [feeBack] of feesBack) {
          candidates.push({
            amount,
            adapter1: adapter1.address,
            routeData1: encodeForProtocol(adapter1.protocol, [borrowedAsset, viaToken], [feeOut]),
            adapter2: adapter2.address,
            routeData2: encodeForProtocol(adapter2.protocol, [viaToken, borrowedAsset], [feeBack]),
            minProfit,
            slippageBps,
            // Per-hop metadata for prefilterCandidates() in index.js --
            // not used by tryRoute()/rankCandidates(), which only ever
            // look at the already-encoded routeData.
            _hops: [
              { protocol: adapter1.protocol, adapter: adapter1.address, tokenIn: borrowedAsset, tokenOut: viaToken, fee: feeOut },
              { protocol: adapter2.protocol, adapter: adapter2.address, tokenIn: viaToken, tokenOut: borrowedAsset, fee: feeBack },
            ],
          });
        }
      }
    }
  }
  return candidates;
}

/**
 * Every BORROWED_ASSET -> viaA -> viaB -> BORROWED_ASSET triangular
 * route, for every ordered pair of *distinct* via-tokens, across every
 * generic (v2/v3) adapter pair and fee-tier combination (v3 legs only --
 * v2 has none). Built both ways to split the 3-hop path across the
 * executor's two legs (1-hop-then-2-hop, and 2-hop-then-1-hop) since
 * both are valid and may quote differently. Multi-hop-in-one-leg is a
 * v2/v3-only capability -- Curve/Balancer adapters here require exactly
 * 2 tokens per leg, so they're excluded from genericAdapters entirely.
 */
function buildTriangularCandidates({ genericAdapters, borrowedAsset, viaTokens, feeTiers, amount, minProfit, slippageBps }) {
  const candidates = [];
  for (const [adapter1, adapter2] of adapterPairs(genericAdapters)) {
    const feesOut1 = adapter1.protocol === 'v3' ? feeCombos(feeTiers, 1) : [[]];
    const feesOut2 = adapter1.protocol === 'v3' ? feeCombos(feeTiers, 2) : [[]];
    const feesBack1 = adapter2.protocol === 'v3' ? feeCombos(feeTiers, 1) : [[]];
    const feesBack2 = adapter2.protocol === 'v3' ? feeCombos(feeTiers, 2) : [[]];

    for (const viaA of viaTokens) {
      for (const viaB of viaTokens) {
        if (viaA === viaB) continue;

        // Split A: leg1 = borrowed -> viaA (1 hop), leg2 = viaA -> viaB -> borrowed (2 hops)
        for (const [feeOut] of feesOut1) {
          for (const feeBackPair of feesBack2) {
            candidates.push({
              amount,
              adapter1: adapter1.address,
              routeData1: encodeForProtocol(adapter1.protocol, [borrowedAsset, viaA], [feeOut]),
              adapter2: adapter2.address,
              routeData2: encodeForProtocol(adapter2.protocol, [viaA, viaB, borrowedAsset], feeBackPair),
              minProfit,
              slippageBps,
              _hops: [
                { protocol: adapter1.protocol, adapter: adapter1.address, tokenIn: borrowedAsset, tokenOut: viaA, fee: feeOut },
                { protocol: adapter2.protocol, adapter: adapter2.address, tokenIn: viaA, tokenOut: viaB, fee: feeBackPair[0] },
                { protocol: adapter2.protocol, adapter: adapter2.address, tokenIn: viaB, tokenOut: borrowedAsset, fee: feeBackPair[1] },
              ],
            });
          }
        }

        // Split B: leg1 = borrowed -> viaA -> viaB (2 hops), leg2 = viaB -> borrowed (1 hop)
        for (const feeOutPair of feesOut2) {
          for (const [feeBack] of feesBack1) {
            candidates.push({
              amount,
              adapter1: adapter1.address,
              routeData1: encodeForProtocol(adapter1.protocol, [borrowedAsset, viaA, viaB], feeOutPair),
              adapter2: adapter2.address,
              routeData2: encodeForProtocol(adapter2.protocol, [viaB, borrowedAsset], [feeBack]),
              minProfit,
              slippageBps,
              _hops: [
                { protocol: adapter1.protocol, adapter: adapter1.address, tokenIn: borrowedAsset, tokenOut: viaA, fee: feeOutPair[0] },
                { protocol: adapter1.protocol, adapter: adapter1.address, tokenIn: viaA, tokenOut: viaB, fee: feeOutPair[1] },
                { protocol: adapter2.protocol, adapter: adapter2.address, tokenIn: viaB, tokenOut: borrowedAsset, fee: feeBack },
              ],
            });
          }
        }
      }
    }
  }
  return candidates;
}

/**
 * Pairs a single Curve leg against every generic (v2/v3) adapter, in
 * both directions -- the combination `resolveCurveCandidates` never
 * produced (it only ever round-tripped through the same Curve pool,
 * which can never be profitable). Given an already-resolved pairing
 * (which token the pool trades against `borrowedAsset`, and that pool's
 * own coin indices for each), builds:
 *   - borrowed -> otherToken (Curve) -> borrowed (generic adapter)
 *   - borrowed -> otherToken (generic adapter) -> borrowed (Curve)
 * CurveAdapter.sol requires exactly 2 tokens per leg, so unlike
 * buildTriangularCandidates, there's no multi-hop-in-one-leg variant
 * here -- 2-leg only.
 */
function buildCurveCrossCandidates({
  curveAdapterAddress,
  genericAdapters,
  borrowedAsset,
  otherToken,
  curveIOut,
  curveJOut,
  feeTiers,
  amount,
  minProfit,
  slippageBps,
}) {
  const candidates = [];
  const curveOutRouteData = encodeCurveRouteData([borrowedAsset, otherToken], curveIOut, curveJOut);
  const curveBackRouteData = encodeCurveRouteData([otherToken, borrowedAsset], curveJOut, curveIOut);

  for (const generic of genericAdapters) {
    const fees = generic.protocol === 'v3' ? feeCombos(feeTiers, 1) : [[]];
    for (const [fee] of fees) {
      // Curve out, generic adapter back.
      candidates.push({
        amount,
        adapter1: curveAdapterAddress,
        routeData1: curveOutRouteData,
        adapter2: generic.address,
        routeData2: encodeForProtocol(generic.protocol, [otherToken, borrowedAsset], [fee]),
        minProfit,
        slippageBps,
        _hops: [
          { protocol: 'curve', adapter: curveAdapterAddress, tokenIn: borrowedAsset, tokenOut: otherToken, fee: undefined },
          { protocol: generic.protocol, adapter: generic.address, tokenIn: otherToken, tokenOut: borrowedAsset, fee },
        ],
      });

      // Generic adapter out, Curve back.
      candidates.push({
        amount,
        adapter1: generic.address,
        routeData1: encodeForProtocol(generic.protocol, [borrowedAsset, otherToken], [fee]),
        adapter2: curveAdapterAddress,
        routeData2: curveBackRouteData,
        minProfit,
        slippageBps,
        _hops: [
          { protocol: generic.protocol, adapter: generic.address, tokenIn: borrowedAsset, tokenOut: otherToken, fee },
          { protocol: 'curve', adapter: curveAdapterAddress, tokenIn: otherToken, tokenOut: borrowedAsset, fee: undefined },
        ],
      });
    }
  }

  return candidates;
}

/**
 * Includes hop.adapter (the specific adapter address that executes this
 * hop), not just its protocol tag -- two different DEXes can share the
 * same protocol tag (e.g. two separate Uniswap-V2-style forks both
 * tagged 'v2') while trading through entirely different pools for the
 * identical token pair. Keying on protocol+tokens alone would silently
 * collapse both into one cache entry, applying one DEX's real price to
 * the other's candidates -- caught before it ever shipped, adding
 * Camelot alongside SushiSwap as a second 'v2' adapter on Arbitrum's
 * WETH/USDC pair. hop.adapter is optional (defaults to '') so any
 * hop-shaped object that predates this field still produces a valid,
 * internally-consistent key -- nothing needs it added retroactively as
 * long as hopKey() itself is always used to both write and read a given
 * cache entry, which every caller in this file already does.
 */
function hopKey(hop) {
  return `${hop.protocol}:${(hop.adapter || '').toLowerCase()}:${hop.tokenIn.toLowerCase()}:${hop.tokenOut.toLowerCase()}:${hop.fee || 0}`;
}

const Q96 = 2n ** 96n;

/**
 * Exact single-price-range Uniswap V3 swap math -- SqrtPriceMath's
 * getNextSqrtPriceFromAmount0/1RoundingUp/Down plus getAmount0/1Delta,
 * straight from Uniswap V3 core (a public, deterministic formula, not
 * anything proprietary). Computes real output using the pool's actual
 * *liquidity depth* at its current price, not just the spot price --
 * matching what the real pool/quoter would return AS LONG AS the trade
 * doesn't need more liquidity than is active at the current tick (i.e.
 * doesn't cross to the next initialized tick). Verified live against a
 * real Base Sepolia pool and QuoterV2: a trade that stayed within one
 * tick matched the real quote to 0.000000%, versus 0.19% off with the
 * old spot-price-only version. For a trade too large for that, this
 * stops being exact -- checked live with a bigger trade that crossed 5
 * ticks, and the direction of the error isn't reliably one-sided (this
 * one undershot the real output by 0.75%, not the overshoot you'd guess
 * assuming liquidity thins out beyond the current tick -- it depends
 * entirely on how the real LP positions are distributed beyond it, which
 * this deliberately doesn't know). Computing the true tick-crossing-aware
 * value needs the pool's tickBitmap/ticks() data, which resolveHopPrice()
 * deliberately doesn't fetch (see prefilterCandidates()'s doc comment:
 * this is a ranking pre-filter, not the final quote -- quoteRoute() is
 * what actually decides submission, so an optimistic estimate on a large
 * trade can only cost ranking accuracy, never fund safety).
 *
 * Considered pulling in @uniswap/v3-sdk to do this instead of
 * reimplementing it -- its dependency tree (JSBI instead of native
 * BigInt, a stack of @ethersproject/* v5 packages, v3-staker/
 * v3-periphery/swap-router-contracts as transitive deps) is a lot of
 * weight and a foreign numeric type for one well-documented public
 * formula this project can just implement directly.
 */
function v3SwapAmountOut(sqrtPriceX96, liquidity, zeroForOne, effectiveAmountIn) {
  if (zeroForOne) {
    const numerator1 = liquidity * Q96;
    const denominator = numerator1 + effectiveAmountIn * sqrtPriceX96;
    const sqrtPriceNextX96 = (numerator1 * sqrtPriceX96) / denominator;
    return (liquidity * (sqrtPriceX96 - sqrtPriceNextX96)) / Q96;
  }
  const sqrtPriceNextX96 = sqrtPriceX96 + (effectiveAmountIn * Q96) / liquidity;
  return (liquidity * Q96 * (sqrtPriceNextX96 - sqrtPriceX96)) / (sqrtPriceX96 * sqrtPriceNextX96);
}

/**
 * Applies a cached hop price to a specific amountIn -- pure computation,
 * no RPC. v3 uses v3SwapAmountOut() above: real liquidity-depth-aware
 * price impact, not a spot-price approximation, but still not a
 * substitute for the real quote (see that function's doc comment for
 * the tick-crossing caveat). v2's constant-product formula, by contrast,
 * IS exact for this reserve snapshot (no approximation, never was).
 * Returns null when the pool has zero liquidity/reserves.
 */
function applyHopPrice(hop, price, amountIn) {
  if (price.protocol === 'v3') {
    if (price.liquidity === 0n) return null;
    const zeroForOne = price.token0 === hop.tokenIn.toLowerCase();
    // Fee deducted from the input before the swap-step math runs,
    // matching Uniswap V3's own SwapMath.computeSwapStep order of
    // operations -- not a flat multiply on the output afterward, which
    // stops being equivalent the moment price impact is nonlinear.
    const effectiveAmountIn = (amountIn * BigInt(1_000_000 - hop.fee)) / 1_000_000n;
    return v3SwapAmountOut(price.sqrtPriceX96, price.liquidity, zeroForOne, effectiveAmountIn);
  }

  const [reserveIn, reserveOut] =
    price.token0 === hop.tokenIn.toLowerCase() ? [price.reserve0, price.reserve1] : [price.reserve1, price.reserve0];
  if (reserveIn === 0n || reserveOut === 0n) return null;
  const amountInWithFee = amountIn * 997n;
  return (amountInWithFee * reserveOut) / (reserveIn * 1000n + amountInWithFee);
}

/**
 * Chains applyHopPrice() across every hop in a candidate's route (the
 * same per-hop loop prefilterCandidates() runs in index.js, factored out
 * so the trade sizer below can reuse it) -- pure computation, no RPC.
 * Returns null the moment any hop can't be priced (e.g. zero liquidity),
 * same as applyHopPrice() itself.
 */
function applyHopChain(hops, priceCache, amountIn) {
  let amount = amountIn;
  for (const hop of hops) {
    const price = priceCache.get(hopKey(hop));
    if (!price) return null;
    amount = applyHopPrice(hop, price, amount);
    if (amount === null) return null;
  }
  return amount;
}

/**
 * Finds the amountIn (within [minAmount, maxAmount]) that maximizes
 * round-trip net profit (applyHopChain(amount) - amount) for a given
 * route, via ternary search rather than a closed-form per-protocol
 * formula -- works identically for a pure-V2, pure-V3, or mixed chain,
 * reusing applyHopChain()/applyHopPrice() exactly as-is.
 *
 * Ternary search finds the maximum of a *unimodal* (single-peaked)
 * function without needing its derivative. That's the one assumption
 * this makes: round-trip profit across a chain of AMM swaps is concave
 * in the input amount -- each individual swap's output is a concave
 * function of its input (diminishing returns from price impact, true
 * for both the exact V2 formula and the V3 swap-step math above), and
 * composing concave functions this way preserves that shape closely
 * enough in practice for ternary search to reliably find the peak (see
 * lib.test.js: cross-checked against a fine-grained brute-force scan,
 * not just trusted from the math alone).
 *
 * Only cares about amount-dependent profitability -- gas cost, Aave's
 * flash-loan premium, and the contract's own maxLoanAmount cap are
 * deliberately NOT applied here; those are the caller's job afterward
 * (tryRoute() already enforces maxLoanAmount, and a gas-aware comparison
 * needs a live fee-data call this pure function can't make). This finds
 * the size that maximizes *gross* round-trip output over input, nothing
 * more.
 *
 * Returns null if the chain can't be priced at all (checked once
 * upfront at minAmount -- a hop's liquidity being zero doesn't depend on
 * the amount being tried, so there's no need to re-check on every search
 * step), or if the best size found still isn't profitable.
 */
function findOptimalTradeSize(hops, priceCache, minAmount, maxAmount, iterations = 64) {
  if (applyHopChain(hops, priceCache, minAmount) === null) return null;

  const profitAt = (amount) => applyHopChain(hops, priceCache, amount) - amount;

  let lo = minAmount;
  let hi = maxAmount;
  for (let i = 0; i < iterations && hi - lo > 1n; i++) {
    const third = (hi - lo) / 3n;
    const m1 = lo + third;
    const m2 = hi - third;
    if (profitAt(m1) < profitAt(m2)) lo = m1;
    else hi = m2;
  }

  const bestAmount = lo + (hi - lo) / 2n;
  const bestProfit = profitAt(bestAmount);
  return bestProfit > 0n ? { amount: bestAmount, profit: bestProfit } : null;
}

module.exports = {
  KNOWN_PROTOCOLS,
  GENERIC_PROTOCOLS,
  encodeV2RouteData,
  encodeV3RouteData,
  encodeCurveRouteData,
  encodeBalancerRouteData,
  parseAdapterList,
  parseAdapterFactoryOverrides,
  parseAddressList,
  parseFeeTiers,
  feeCombos,
  adapterPairs,
  encodeForProtocol,
  buildTwoLegCandidates,
  buildTriangularCandidates,
  buildCurveCrossCandidates,
  hopKey,
  Q96,
  v3SwapAmountOut,
  applyHopPrice,
  applyHopChain,
  findOptimalTradeSize,
};
