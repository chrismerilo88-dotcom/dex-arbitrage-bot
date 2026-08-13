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
              { protocol: adapter1.protocol, tokenIn: borrowedAsset, tokenOut: viaToken, fee: feeOut },
              { protocol: adapter2.protocol, tokenIn: viaToken, tokenOut: borrowedAsset, fee: feeBack },
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
                { protocol: adapter1.protocol, tokenIn: borrowedAsset, tokenOut: viaA, fee: feeOut },
                { protocol: adapter2.protocol, tokenIn: viaA, tokenOut: viaB, fee: feeBackPair[0] },
                { protocol: adapter2.protocol, tokenIn: viaB, tokenOut: borrowedAsset, fee: feeBackPair[1] },
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
                { protocol: adapter1.protocol, tokenIn: borrowedAsset, tokenOut: viaA, fee: feeOutPair[0] },
                { protocol: adapter1.protocol, tokenIn: viaA, tokenOut: viaB, fee: feeOutPair[1] },
                { protocol: adapter2.protocol, tokenIn: viaB, tokenOut: borrowedAsset, fee: feeBack },
              ],
            });
          }
        }
      }
    }
  }
  return candidates;
}

function hopKey(hop) {
  return `${hop.protocol}:${hop.tokenIn.toLowerCase()}:${hop.tokenOut.toLowerCase()}:${hop.fee || 0}`;
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

module.exports = {
  KNOWN_PROTOCOLS,
  GENERIC_PROTOCOLS,
  encodeV2RouteData,
  encodeV3RouteData,
  encodeCurveRouteData,
  encodeBalancerRouteData,
  parseAdapterList,
  parseAddressList,
  parseFeeTiers,
  feeCombos,
  adapterPairs,
  encodeForProtocol,
  buildTwoLegCandidates,
  buildTriangularCandidates,
  hopKey,
  Q96,
  v3SwapAmountOut,
  applyHopPrice,
};
