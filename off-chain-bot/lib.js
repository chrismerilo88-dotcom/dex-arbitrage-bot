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

const Q192 = 2n ** 96n * 2n ** 96n;

/**
 * Applies a cached hop price to a specific amountIn -- pure computation,
 * no RPC. v3 uses the pool's current spot price only: it ignores
 * concentrated-liquidity depth and tick-crossing entirely (unlike the
 * real QuoterV2 path), trading accuracy for a read that costs one
 * slot0() instead of a full swap simulation -- correct in the
 * infinite-depth limit, and directionally useful for ranking, but not a
 * substitute for the real quote. v2's constant-product formula, by
 * contrast, IS exact for this reserve snapshot (no approximation).
 * Returns null when the pool has zero reserves on one side.
 */
function applyHopPrice(hop, price, amountIn) {
  if (price.protocol === 'v3') {
    const priceX192 = price.sqrtPriceX96 * price.sqrtPriceX96;
    const rawOut =
      price.token0 === hop.tokenIn.toLowerCase() ? (amountIn * priceX192) / Q192 : (amountIn * Q192) / priceX192;
    return (rawOut * BigInt(1_000_000 - hop.fee)) / 1_000_000n;
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
  Q192,
  applyHopPrice,
};
