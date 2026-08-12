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

describe('applyHopPrice', () => {
  test('v3: token0 == tokenIn, 1:1 spot price, zero fee', () => {
    // sqrtPriceX96 for a 1:1 price is exactly 2^96.
    const price = { protocol: 'v3', fee: 0, token0: WETH.toLowerCase(), sqrtPriceX96: 2n ** 96n };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), 1_000_000n);
  });

  test('v3: token0 == tokenOut (inverse direction) still resolves to the same 1:1 price', () => {
    const price = { protocol: 'v3', fee: 0, token0: USDC.toLowerCase(), sqrtPriceX96: 2n ** 96n };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), 1_000_000n);
  });

  test('v3: applies the pool fee tier as a proportional cut', () => {
    // 3000 = 0.3% fee tier (parts per million).
    const price = { protocol: 'v3', fee: 3000, token0: WETH.toLowerCase(), sqrtPriceX96: 2n ** 96n };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 3000 };
    const out = lib.applyHopPrice(hop, price, 1_000_000n);
    assert.equal(out, 997_000n); // 1_000_000 * (1 - 0.003)
  });

  test('v3: a 2x price ratio scales output accordingly', () => {
    // sqrtPriceX96 = 2 * 2^96 => price (token1/token0) = 4.
    const price = { protocol: 'v3', fee: 0, token0: WETH.toLowerCase(), sqrtPriceX96: 2n * 2n ** 96n };
    const hop = { protocol: 'v3', tokenIn: WETH, tokenOut: USDC, fee: 0 };
    assert.equal(lib.applyHopPrice(hop, price, 1_000_000n), 4_000_000n);
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
