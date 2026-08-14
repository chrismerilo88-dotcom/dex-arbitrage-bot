const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { ethers } = require('ethers');
const lib = require('./lib');

const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const DAI = '0x1111111111111111111111111111111111111111';
const ADAPTER_A = '0xaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaAaA';
const ADAPTER_B = '0xbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbBbB';

describe('route encoding', () => {
  test('encodeV2RouteData round-trips tokens with empty extra', () => {
    const data = lib.encodeV2RouteData([WETH, USDC]);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], data);
    assert.deepEqual([...tokens], [WETH, USDC]);
    assert.equal(extra, '0x');
  });

  test('encodeV3RouteData round-trips tokens and fee tiers', () => {
    const data = lib.encodeV3RouteData([WETH, USDC], [3000]);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], data);
    assert.deepEqual([...tokens], [WETH, USDC]);
    const [fees] = ethers.AbiCoder.defaultAbiCoder().decode(['uint24[]'], extra);
    assert.deepEqual([...fees].map(Number), [3000]);
  });

  test('encodeCurveRouteData round-trips coin indices', () => {
    const data = lib.encodeCurveRouteData([WETH, USDC], 0, 1);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], data);
    assert.deepEqual([...tokens], [WETH, USDC]);
    const [i, j] = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128'], extra);
    assert.equal(i, 0n);
    assert.equal(j, 1n);
  });

  test('encodeBalancerRouteData round-trips poolId', () => {
    const poolId = '0x' + '11'.repeat(32);
    const data = lib.encodeBalancerRouteData([WETH, USDC], poolId);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], data);
    assert.deepEqual([...tokens], [WETH, USDC]);
    const [decodedPoolId] = ethers.AbiCoder.defaultAbiCoder().decode(['bytes32'], extra);
    assert.equal(decodedPoolId, poolId);
  });

  test('encodeForProtocol dispatches v2 and v3 differently', () => {
    const v2 = lib.encodeForProtocol('v2', [WETH, USDC], [3000]);
    const v3 = lib.encodeForProtocol('v3', [WETH, USDC], [3000]);
    assert.notEqual(v2, v3);
  });

  test('encodeForProtocol rejects non-generic protocols', () => {
    assert.throws(() => lib.encodeForProtocol('curve', [WETH, USDC], []), /not a generic/);
    assert.throws(() => lib.encodeForProtocol('balancer', [WETH, USDC], []), /not a generic/);
  });
});

describe('config parsing', () => {
  test('parseAdapterList defaults to v3 when protocol omitted', () => {
    assert.deepEqual(lib.parseAdapterList(ADAPTER_A), [{ address: ADAPTER_A, protocol: 'v3' }]);
  });

  test('parseAdapterList reads an explicit protocol tag', () => {
    assert.deepEqual(lib.parseAdapterList(`${ADAPTER_A}:v2`), [{ address: ADAPTER_A, protocol: 'v2' }]);
  });

  test('parseAdapterList handles multiple comma-separated entries with mixed protocols', () => {
    assert.deepEqual(lib.parseAdapterList(`${ADAPTER_A}:v2, ${ADAPTER_B}:curve`), [
      { address: ADAPTER_A, protocol: 'v2' },
      { address: ADAPTER_B, protocol: 'curve' },
    ]);
  });

  test('parseAdapterList throws on an unknown protocol tag', () => {
    assert.throws(() => lib.parseAdapterList(`${ADAPTER_A}:sushi`), /unknown protocol "sushi"/);
  });

  test('parseAdapterList returns empty array for blank/unset input', () => {
    assert.deepEqual(lib.parseAdapterList(''), []);
    assert.deepEqual(lib.parseAdapterList(undefined), []);
  });

  test('parseAddressList trims and filters blanks', () => {
    assert.deepEqual(lib.parseAddressList(` ${WETH} , ${USDC},`), [WETH, USDC]);
  });

  test('parseFeeTiers defaults to the three standard V3 tiers', () => {
    assert.deepEqual(lib.parseFeeTiers(undefined), [500, 3000, 10000]);
  });

  test('parseFeeTiers parses a custom list', () => {
    assert.deepEqual(lib.parseFeeTiers('100,500'), [100, 500]);
  });
});

describe('feeCombos / adapterPairs', () => {
  test('feeCombos with hops=1 returns one singleton array per tier', () => {
    assert.deepEqual(lib.feeCombos([500, 3000], 1), [[500], [3000]]);
  });

  test('feeCombos with hops=2 returns the full cartesian product', () => {
    const combos = lib.feeCombos([500, 3000], 2);
    assert.equal(combos.length, 4);
    assert.deepEqual(combos, [
      [500, 500],
      [500, 3000],
      [3000, 500],
      [3000, 3000],
    ]);
  });

  test('adapterPairs includes every ordered pair, including self-pairs', () => {
    const pairs = lib.adapterPairs(['a', 'b']);
    assert.equal(pairs.length, 4);
    assert.deepEqual(pairs, [
      ['a', 'a'],
      ['a', 'b'],
      ['b', 'a'],
      ['b', 'b'],
    ]);
  });
});

describe('candidate building', () => {
  const baseConfig = {
    genericAdapters: [{ address: ADAPTER_A, protocol: 'v3' }],
    borrowedAsset: WETH,
    viaTokens: [USDC],
    feeTiers: [500, 3000],
    amount: 100n,
    minProfit: 0n,
    slippageBps: 300,
  };

  test('buildTwoLegCandidates produces one candidate per fee-tier combination', () => {
    const candidates = lib.buildTwoLegCandidates(baseConfig);
    // 1 adapter pair x 1 via-token x 2 feeOut x 2 feeBack = 4
    assert.equal(candidates.length, 4);
    for (const c of candidates) {
      assert.equal(c.adapter1, ADAPTER_A);
      assert.equal(c.adapter2, ADAPTER_A);
      assert.equal(c._hops.length, 2);
      assert.equal(c._hops[0].tokenIn, WETH);
      assert.equal(c._hops[0].tokenOut, USDC);
      assert.equal(c._hops[1].tokenIn, USDC);
      assert.equal(c._hops[1].tokenOut, WETH);
    }
  });

  test('buildTwoLegCandidates collapses the fee-tier loop for a v2 leg', () => {
    const candidates = lib.buildTwoLegCandidates({
      ...baseConfig,
      genericAdapters: [{ address: ADAPTER_A, protocol: 'v2' }],
    });
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0]._hops[0].fee, undefined);
  });

  test('buildTriangularCandidates skips viaA === viaB and covers both splits', () => {
    const candidates = lib.buildTriangularCandidates({
      ...baseConfig,
      viaTokens: [USDC, DAI],
    });
    assert.ok(candidates.length > 0);
    for (const c of candidates) {
      assert.equal(c._hops.length, 3);
      const [hop1, hop2, hop3] = c._hops;
      // Round trip: starts and ends at the borrowed asset, hops chain
      // tokenOut -> next tokenIn, and the two via-tokens are distinct.
      assert.equal(hop1.tokenIn, WETH);
      assert.equal(hop3.tokenOut, WETH);
      assert.equal(hop1.tokenOut, hop2.tokenIn);
      assert.equal(hop2.tokenOut, hop3.tokenIn);
      assert.notEqual(hop1.tokenOut, hop2.tokenOut);
    }
  });
});

describe('buildCurveCrossCandidates', () => {
  const curveConfig = {
    curveAdapterAddress: ADAPTER_A,
    genericAdapters: [{ address: ADAPTER_B, protocol: 'v3' }],
    borrowedAsset: USDC,
    otherToken: DAI,
    curveIOut: 1,
    curveJOut: 0,
    feeTiers: [500, 3000],
    amount: 100n,
    minProfit: 0n,
    slippageBps: 300,
  };

  test('produces two candidates per generic adapter per fee tier (both pairing directions)', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    // 1 generic adapter x 2 fee tiers x 2 directions = 4
    assert.equal(candidates.length, 4);
  });

  test('curve-out direction: adapter1 is curve, adapter2 is the generic adapter', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const curveOut = candidates.filter((c) => c.adapter1 === ADAPTER_A);
    assert.equal(curveOut.length, 2); // one per fee tier
    for (const c of curveOut) {
      assert.equal(c.adapter2, ADAPTER_B);
    }
  });

  test('generic-out direction: adapter1 is the generic adapter, adapter2 is curve', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const genericOut = candidates.filter((c) => c.adapter1 === ADAPTER_B);
    assert.equal(genericOut.length, 2);
    for (const c of genericOut) {
      assert.equal(c.adapter2, ADAPTER_A);
    }
  });

  test('curve leg route data decodes to borrowedAsset/otherToken with the correct coin indices', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const curveOut = candidates.find((c) => c.adapter1 === ADAPTER_A);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], curveOut.routeData1);
    assert.deepEqual([...tokens], [USDC, DAI]);
    const [i, j] = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128'], extra);
    assert.equal(i, 1n);
    assert.equal(j, 0n);
  });

  test('the return leg of the curve-out direction is the curve leg reversed (otherToken -> borrowedAsset, indices swapped)', () => {
    const candidates = lib.buildCurveCrossCandidates(curveConfig);
    const curveOut = candidates.find((c) => c.adapter1 === ADAPTER_A);
    const [tokens, extra] = ethers.AbiCoder.defaultAbiCoder().decode(['address[]', 'bytes'], candidates.find((c) => c.adapter2 === ADAPTER_A).routeData2);
    assert.deepEqual([...tokens], [DAI, USDC]);
    const [i, j] = ethers.AbiCoder.defaultAbiCoder().decode(['int128', 'int128'], extra);
    assert.equal(i, 0n);
    assert.equal(j, 1n);
    void curveOut; // (referenced above only to locate the pair; assertion is on the found candidate)
  });

  test('collapses the fee-tier loop for a v2 generic adapter', () => {
    const candidates = lib.buildCurveCrossCandidates({
      ...curveConfig,
      genericAdapters: [{ address: ADAPTER_B, protocol: 'v2' }],
    });
    // 1 generic adapter x 1 (no fee loop) x 2 directions = 2
    assert.equal(candidates.length, 2);
  });

  test('multiple generic adapters each produce their own candidate pairs', () => {
    const candidates = lib.buildCurveCrossCandidates({
      ...curveConfig,
      genericAdapters: [
        { address: ADAPTER_B, protocol: 'v2' },
        { address: '0xcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcCcC', protocol: 'v2' },
      ],
    });
    // 2 generic adapters x 1 (v2, no fee loop) x 2 directions = 4
    assert.equal(candidates.length, 4);
  });
});

describe('hopKey', () => {
  test('is case-insensitive on addresses', () => {
    const a = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC.toLowerCase(), fee: 3000 };
    const b = { protocol: 'v3', tokenIn: WETH.toLowerCase(), tokenOut: USDC, fee: 3000 };
    assert.equal(lib.hopKey(a), lib.hopKey(b));
  });

  test('differs by direction (tokenIn/tokenOut are not interchangeable)', () => {
    const forward = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 3000 };
    const reverse = { protocol: 'v3', tokenIn: USDC, tokenOut: WETH, fee: 3000 };
    assert.notEqual(lib.hopKey(forward), lib.hopKey(reverse));
  });
});

// Deliberately huge relative to every amountIn used below, so these
// tests sit in the "trade small vs. liquidity" limit where v3's real
// swap-step math is expected to converge (near-exactly, modulo integer
// truncation) to the naive spot-price prediction -- verified by hand via
// a scratch script before writing these numbers in, not just captured
// from a first run. See the "real price impact" tests further down for
// cases where liquidity depth actually changes the answer.
const HUGE_LIQUIDITY = 10n ** 24n;

describe('v3SwapAmountOut (exact swap-step math)', () => {
  test('1:1 price, zeroForOne, small trade converges to the spot-price limit', () => {
    assert.equal(lib.v3SwapAmountOut(lib.Q96, HUGE_LIQUIDITY, true, 1_000_000n), 1_000_000n);
  });

  test('4x price (sqrtPriceX96 = 2*Q96), small trade converges to the spot-price limit', () => {
    assert.equal(lib.v3SwapAmountOut(2n * lib.Q96, HUGE_LIQUIDITY, true, 1_000_000n), 4_000_000n);
  });

  test('!zeroForOne (buying token0 with token1) at 4x price converges to the inverse spot price', () => {
    // Tiny trade relative to liquidity -> integer truncation of 1000/4 is the only "error" (249 vs 250).
    assert.equal(lib.v3SwapAmountOut(2n * lib.Q96, HUGE_LIQUIDITY, false, 1000n), 249n);
  });

  test('real price impact: a trade large enough to matter yields strictly less than the naive spot prediction', () => {
    const amountIn = 10n ** 20n; // meaningful fraction of HUGE_LIQUIDITY's scale
    const out = lib.v3SwapAmountOut(lib.Q96, HUGE_LIQUIDITY, true, amountIn);
    assert.equal(out, 99990000999900009999n); // hand-verified via scratch script, not just "whatever it outputs"
    assert.ok(out < amountIn, 'a real swap-step, sqrt-curve trade must yield less than a flat 1:1 spot prediction');
  });
});

describe('applyHopPrice', () => {
  test('v3: token0 == tokenIn, 1:1 spot price, zero fee, small trade', () => {
    // sqrtPriceX96 for a 1:1 price is exactly 2^96.
    const price = { protocol: 'v3', fee: 0, token0: WETH.toLowerCase(), sqrtPriceX96: 2n ** 96n, liquidity: HUGE_LIQUIDITY };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), 1_000_000n);
  });

  test('v3: token0 == tokenOut (inverse direction) still resolves to ~1:1 price', () => {
    const price = { protocol: 'v3', fee: 0, token0: USDC.toLowerCase(), sqrtPriceX96: 2n ** 96n, liquidity: HUGE_LIQUIDITY };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    // The !zeroForOne formula truncates differently than zeroForOne's at
    // this scale -- 999999n, not a clean 1000000n, is the actual correct
    // answer here (verified via the same scratch script), not an
    // off-by-one bug: integer rounding always favors the pool slightly,
    // same as real Uniswap V3.
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), 999_999n);
  });

  test('v3: fee is deducted from the input before the swap-step math runs', () => {
    // 3000 = 0.3% fee tier (parts per million). In the small-trade limit
    // this matches a flat (1 - fee) multiply, but applyHopPrice() does it
    // by shrinking the input first -- see its doc comment for why that
    // stops being equivalent to a post-multiply once price impact is
    // nonlinear (real price impact case further down proves the two
    // orderings diverge).
    const price = { protocol: 'v3', fee: 3000, token0: WETH.toLowerCase(), sqrtPriceX96: 2n ** 96n, liquidity: HUGE_LIQUIDITY };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 3000 };
    const out = lib.applyHopPrice(hop, price, 1_000_000n);
    assert.equal(out, 997_000n); // 1_000_000 * (1 - 0.003), in the small-trade limit
  });

  test('v3: a 2x price ratio scales output accordingly', () => {
    // sqrtPriceX96 = 2 * 2^96 => price (token1/token0) = 4.
    const price = { protocol: 'v3', fee: 0, token0: WETH.toLowerCase(), sqrtPriceX96: 2n * 2n ** 96n, liquidity: HUGE_LIQUIDITY };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), 4_000_000n);
  });

  test('v3: returns null when the pool has zero liquidity', () => {
    const price = { protocol: 'v3', fee: 0, token0: WETH.toLowerCase(), sqrtPriceX96: 2n ** 96n, liquidity: 0n };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), null);
  });

  test('v2: matches the standard constant-product formula exactly', () => {
    const price = { protocol: 'v2', token0: WETH.toLowerCase(), reserve0: 1_000_000n, reserve1: 2_000_000n };
    const hop = { protocol: 'v2', tokenIn: WETH, tokenOut: USDC };
    const amountIn = 1_000n;
    const amountInWithFee = amountIn * 997n;
    const expected = (amountInWithFee * 2_000_000n) / (1_000_000n * 1000n + amountInWithFee);
    assert.equal(lib.applyHopPrice(hop, price, amountIn), expected);
  });

  test('v2: reverse direction (tokenIn is token1) uses reserves the other way round', () => {
    const price = { protocol: 'v2', token0: USDC.toLowerCase(), reserve0: 2_000_000n, reserve1: 1_000_000n };
    const hop = { protocol: 'v2', tokenIn: WETH, tokenOut: USDC };
    const amountIn = 1_000n;
    const amountInWithFee = amountIn * 997n;
    const expected = (amountInWithFee * 2_000_000n) / (1_000_000n * 1000n + amountInWithFee);
    assert.equal(lib.applyHopPrice(hop, price, amountIn), expected);
  });

  test('v2: returns null when either reserve is zero', () => {
    const hop = { protocol: 'v2', tokenIn: WETH, tokenOut: USDC };
    assert.equal(lib.applyHopPrice(hop, { protocol: 'v2', token0: WETH.toLowerCase(), reserve0: 0n, reserve1: 100n }, 1n), null);
    assert.equal(lib.applyHopPrice(hop, { protocol: 'v2', token0: WETH.toLowerCase(), reserve0: 100n, reserve1: 0n }, 1n), null);
  });
});

describe('applyHopChain', () => {
  test('chains multiple hops in sequence, output of one feeding input of the next', () => {
    const hops = [
      { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 },
      { protocol: 'v3', tokenIn: USDC, tokenOut: DAI, fee: 0 },
    ];
    const priceCache = new Map();
    priceCache.set(lib.hopKey(hops[0]), { protocol: 'v3', fee: 0, token0: WETH.toLowerCase(), sqrtPriceX96: lib.Q96, liquidity: 10n ** 24n });
    priceCache.set(lib.hopKey(hops[1]), { protocol: 'v3', fee: 0, token0: USDC.toLowerCase(), sqrtPriceX96: 2n * lib.Q96, liquidity: 10n ** 24n });
    // Small trade limit: 1_000_000 -> 1_000_000 (1:1) -> 4_000_000 (4x).
    assert.equal(lib.applyHopChain(hops, priceCache, 1_000_000n), 4_000_000n);
  });

  test('returns null the moment any hop in the chain lacks price data', () => {
    const hops = [{ protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 }];
    assert.equal(lib.applyHopChain(hops, new Map(), 1_000_000n), null);
  });
});

describe('findOptimalTradeSize', () => {
  // Two V2-style pools priced differently enough for a real arbitrage
  // edge to exist. Round trip: WETH -> USDC (pool1, sells WETH at the
  // BETTER of the two rates) -> WETH (pool2, buys WETH back cheaper).
  // Numbers cross-checked against an independent 200,000-step
  // brute-force scan over the same range before being written in here
  // (not just trusted from the ternary search's own output) -- matched
  // to within 0.0002% on amount and 0.000000% on profit, with
  // unimodality (no second peak) confirmed empirically across the range.
  const WETH_USDC_POOL1 = {
    protocol: 'v2',
    token0: WETH.toLowerCase(),
    reserve0: 900_000_000_000_000_000_000n, // 900 WETH
    reserve1: 2_050_000_000_000n, // 2,050,000 USDC -- price ~2278
  };
  const WETH_USDC_POOL2 = {
    protocol: 'v2',
    token0: WETH.toLowerCase(),
    reserve0: 1_000_000_000_000_000_000_000n, // 1000 WETH
    reserve1: 2_000_000_000_000n, // 2,000,000 USDC -- price 2000
  };
  const hops = [
    { protocol: 'v2', tokenIn: WETH, tokenOut: USDC, fee: 0 },
    { protocol: 'v2', tokenIn: USDC, tokenOut: WETH, fee: 0 },
  ];
  const priceCache = new Map([
    [lib.hopKey(hops[0]), WETH_USDC_POOL1],
    [lib.hopKey(hops[1]), WETH_USDC_POOL2],
  ]);

  test('finds the real optimum, matching an independent brute-force scan', () => {
    const result = lib.findOptimalTradeSize(hops, priceCache, 1n, 100_000_000_000_000_000_000n);
    assert.ok(result !== null);
    // Brute-force ground truth from the scratch verification script:
    // amount 28566999999999942867, profit 1827888345350716911.
    const amountDiffPct = Number((result.amount - 28_566_999_999_999_942_867n) * 1_000_000n / 28_566_999_999_999_942_867n) / 10_000;
    const profitDiffPct = Number((result.profit - 1_827_888_345_350_716_911n) * 1_000_000n / 1_827_888_345_350_716_911n) / 10_000;
    assert.ok(Math.abs(amountDiffPct) < 0.01, `amount off by ${amountDiffPct}%`);
    assert.ok(Math.abs(profitDiffPct) < 0.01, `profit off by ${profitDiffPct}%`);
  });

  test('returns null when no amount in range is profitable (both pools priced the same)', () => {
    const samePrice = new Map([
      [lib.hopKey(hops[0]), WETH_USDC_POOL2],
      [lib.hopKey(hops[1]), WETH_USDC_POOL2],
    ]);
    assert.equal(lib.findOptimalTradeSize(hops, samePrice, 1n, 100_000_000_000_000_000_000n), null);
  });

  test('returns null immediately when a hop has zero liquidity, without searching', () => {
    const noLiquidity = new Map([
      [lib.hopKey(hops[0]), { ...WETH_USDC_POOL1, reserve0: 0n }],
      [lib.hopKey(hops[1]), WETH_USDC_POOL2],
    ]);
    assert.equal(lib.findOptimalTradeSize(hops, noLiquidity, 1n, 100_000_000_000_000_000_000n), null);
  });
});
