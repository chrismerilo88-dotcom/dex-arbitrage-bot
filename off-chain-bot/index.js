/**
 * The off-chain half of this system.
 *
 * Two parts: (1) opportunity discovery -- scans 2-hop and triangular
 * (3-hop) BORROWED_ASSET round trips across every configured, protocol-
 * tagged adapter pair (see the "Opportunity discovery" section below for
 * the four axes of coverage: multi-protocol adapters, triangular routes,
 * WATCH_MODE for block-reactive scanning, and decimal-aware amounts),
 * and (2) tryRoute() -- verifies profitability against live chain state
 * via quoteRoute() before spending any gas, then submits the request.
 *
 * This is a real, working scanner, but not a production one -- local
 * reserve math (see prefilterCandidates() below) cuts the number of
 * candidates that reach a full quoteRoute() simulation, but it's a
 * spot-price approximation, not concentrated-liquidity-aware, and even
 * in WATCH_MODE it reacts to confirmed blocks, not pending mempool
 * transactions. See the "Opportunity discovery" section comment for
 * exactly what's covered.
 *
 * Usage:
 *   npm install
 *   node index.js
 */

require('dotenv').config();
const { ethers } = require('ethers');

const EXECUTOR_ABI = [
  'function quoteRoute(uint256 amount, address adapter1, bytes routeData1, address adapter2, bytes routeData2) returns (uint256 netProfit)',
  'function requestFlashLoanArbitrage(uint256 amount, address adapter1, bytes routeData1, address adapter2, bytes routeData2, uint256 minProfit, uint256 slippageBps, uint256 deadlineSeconds, uint256 executeBefore) external',
  'function isAdapterApproved(address adapter) view returns (bool)',
  'function isTokenApproved(address token) view returns (bool)',
  'function maxLoanAmount() view returns (uint256)',
  'function WETH() view returns (address)',
];

const ERC20_ABI = ['function decimals() view returns (uint8)'];

// Minimal read-only ABI for a Curve classic-style pool -- just enough to
// discover which two tokens (and coin indices) a given CurveAdapter's
// immutable pool actually trades. See CurveAdapter.sol's own caveat: this
// matches classic stable-pool style (e.g. 3pool) only.
const CURVE_POOL_ABI = ['function coins(uint256 index) view returns (address)'];

// Minimal read-only ABIs for the local reserve-math pre-filter (see
// prefilterCandidates() below) -- just enough to read a pool's current
// spot price without simulating a swap.
const V3_FACTORY_ABI = ['function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)'];
const V3_POOL_ABI = [
  'function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
  'function token0() view returns (address)',
];
const V2_FACTORY_ABI = ['function getPair(address tokenA, address tokenB) view returns (address)'];
const V2_PAIR_ABI = [
  'function getReserves() view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
  'function token0() view returns (address)',
];

// JsonRpcProvider only speaks HTTP(S) -- a wss:// URL needs
// WebSocketProvider instead. Matters most for WATCH_MODE: block events
// arrive as a push over the open socket rather than via ethers' internal
// HTTPS polling loop, which is the actual "faster reaction" lever here
// (confirmed live: Alchemy's testnet endpoints support wss:// on the
// same API key, no separate signup). Falls back to plain HTTP(S) when
// the URL doesn't opt into it, so this is a strict opt-in, not a
// behavior change for existing https:// configs.
function makeProvider(url) {
  return url.startsWith('ws://') || url.startsWith('wss://') ? new ethers.WebSocketProvider(url) : new ethers.JsonRpcProvider(url);
}

const provider = makeProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const bot = new ethers.Contract(process.env.EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

// Separate provider/wallet/contract for the actual submission, so it can
// point at a private relay instead of the public mempool -- see
// SUBMIT_RPC_URL in .env.example. Falls back to RPC_URL when unset, so
// testnets work unchanged with no extra config.
const submitProvider = makeProvider(process.env.SUBMIT_RPC_URL || process.env.RPC_URL);
const submitWallet = new ethers.Wallet(process.env.PRIVATE_KEY, submitProvider);
const botSubmit = new ethers.Contract(process.env.EXECUTOR_ADDRESS, EXECUTOR_ABI, submitWallet);

// Chain IDs where "submit through the public mempool" is not an acceptable
// default -- see SUBMIT_RPC_URL's comment in .env.example for why Ethereum
// and Base need different private-submission setups.
const MAINNET_CHAIN_IDS = new Set([1n, 8453n]); // Ethereum, Base

// How long to wait for a submitted tx to confirm before treating it as
// stuck and freeing its nonce -- see tryRoute()'s catch block below.
const CONFIRMATION_TIMEOUT_MS = Number(process.env.CONFIRMATION_TIMEOUT_MS || 120_000);

/// Fails loudly instead of silently degrading MEV protection: catches a
/// misconfigured/unset SUBMIT_RPC_URL on mainnet (which would otherwise
/// fall back to the public mempool with no warning), and catches
/// RPC_URL/SUBMIT_RPC_URL pointing at two different chains (which would
/// sign a transaction against the wrong network's EXECUTOR_ADDRESS).
// Hosts known to actually be private submission paths -- see
// SUBMIT_RPC_URL's comment in .env.example. Extend this list rather than
// relying on ALLOW_UNKNOWN_SUBMIT_RELAY for anything you use regularly.
const PRIVATE_RELAY_HOSTS = new Set(['rpc.flashbots.net', 'rpc.mevblocker.io', 'mainnet.base.org']);

async function assertSubmissionSetupIsSafe() {
  const [readNet, submitNet] = await Promise.all([provider.getNetwork(), submitProvider.getNetwork()]);

  if (readNet.chainId !== submitNet.chainId) {
    throw new Error(
      `chain mismatch: RPC_URL is chain ${readNet.chainId}, SUBMIT_RPC_URL is chain ${submitNet.chainId}`
    );
  }
  if (!MAINNET_CHAIN_IDS.has(readNet.chainId)) return;

  // On mainnet, "SUBMIT_RPC_URL is set" isn't enough -- someone hitting a
  // confusing error at 2am could satisfy this by pointing it at the same
  // public RPC as RPC_URL, which reads as fixed but provides zero MEV
  // protection. Require it to be set, distinct from RPC_URL, and either a
  // known private relay or an explicit opt-out.
  const raw = process.env.SUBMIT_RPC_URL;
  if (!raw) {
    throw new Error(`SUBMIT_RPC_URL is required on chain ${readNet.chainId} -- refusing to submit through the public mempool`);
  }
  if (raw === process.env.RPC_URL) {
    throw new Error('SUBMIT_RPC_URL is identical to RPC_URL -- that is the public path, not a private relay');
  }
  const host = new URL(raw).hostname;
  if (!PRIVATE_RELAY_HOSTS.has(host) && process.env.ALLOW_UNKNOWN_SUBMIT_RELAY !== 'true') {
    throw new Error(
      `SUBMIT_RPC_URL host "${host}" is not a known private relay -- set ALLOW_UNKNOWN_SUBMIT_RELAY=true to override if you're sure`
    );
  }
}

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

/**
 * Checks one candidate route and submits it if it clears minProfit.
 * This is the part every scanner calls once it *thinks* it found
 * something -- it does not itself decide what to check.
 */
async function tryRoute({ amount, adapter1, routeData1, adapter2, routeData2, minProfit, slippageBps }, decimals, isBorrowedAssetWeth) {
  // Read-only checks first -- cheap, and avoid a doomed request.
  const [adapter1Ok, adapter2Ok, cap] = await Promise.all([
    bot.isAdapterApproved(adapter1),
    bot.isAdapterApproved(adapter2),
    bot.maxLoanAmount(),
  ]);
  if (!adapter1Ok || !adapter2Ok) {
    console.log('adapter not approved (or still in cooldown), skipping');
    return;
  }
  if (amount > cap) {
    console.log(`amount ${amount} exceeds maxLoanAmount ${cap}, skipping`);
    return;
  }

  // quoteRoute() is NOT view (see IDexAdapter.quote()'s doc comment for
  // why -- V3's on-chain quoter needs write access internally). Calling
  // it here via a provider .call (not sending a real tx) still works and
  // costs nothing, same as eth_call always does regardless of a
  // function's declared mutability.
  //
  // Deliberately through botSubmit (SUBMIT_RPC_URL), not bot (RPC_URL):
  // this is the final, exact-parameters confirmation quote made moments
  // before submission -- routing it through the public read RPC would
  // leak the winning route, amount, and adapters to that provider with
  // near-perfect timing correlation, defeating the point of splitting
  // submission onto a private relay in the first place.
  const netProfit = await botSubmit.quoteRoute.staticCall(amount, adapter1, routeData1, adapter2, routeData2);

  console.log(`quoted net profit: ${ethers.formatUnits(netProfit, decimals)} (borrowed-asset units)`);

  // Derived from chain time, not the host's local clock (Date.now()) --
  // block.timestamp is what executeBefore is actually compared against
  // on-chain, and a skewed/drifting host clock (common on VMs without
  // NTP) would otherwise cause either instant RequestExpired reverts or
  // a much wider staleness window than intended.
  const { timestamp: chainTimestamp } = await submitProvider.getBlock('latest');
  const executeBefore = chainTimestamp + 120; // 2 min to land
  const deadlineSeconds = 300;

  // Gas-adjusted threshold: minProfit alone doesn't account for what this
  // specific request will actually cost to land. gasCostWei is
  // denominated in ETH/wei, which is only directly comparable to
  // netProfit (in borrowed-asset units) when the borrowed asset IS WETH
  // -- matching the on-chain gas backstop's own restriction, see item 21
  // in the contract's header. For any other borrowed asset there's no
  // price conversion here (that would need an oracle), so the gas
  // adjustment is skipped entirely rather than silently mixing units --
  // minProfit alone is what gates those trades, same as the on-chain
  // backstop's own documented limitation.
  let effectiveMinProfit = minProfit;
  if (isBorrowedAssetWeth) {
    const gasEstimate = await botSubmit.requestFlashLoanArbitrage.estimateGas(
      amount,
      adapter1,
      routeData1,
      adapter2,
      routeData2,
      minProfit,
      slippageBps,
      deadlineSeconds,
      executeBefore
    );
    const feeData = await submitProvider.getFeeData();
    // 25% headroom: the on-chain gas backstop only measures executeOperation's
    // own gas, not the outer tx's base cost, calldata cost, or Aave's
    // pre/post bookkeeping -- this estimate has the same blind spots.
    const gasCostWei = (gasEstimate * feeData.maxFeePerGas * 125n) / 100n;
    effectiveMinProfit = minProfit + gasCostWei;
  }

  if (netProfit < effectiveMinProfit) {
    console.log(
      `below gas-adjusted threshold (minProfit ${ethers.formatUnits(minProfit, decimals)} + est. gas headroom ${ethers.formatUnits(effectiveMinProfit - minProfit, decimals)}), skipping`
    );
    return;
  }

  // --- Submission -----------------------------------------------------
  // Goes through botSubmit (SUBMIT_RPC_URL), not bot (RPC_URL), so this
  // can be pointed at a private relay instead of the public mempool --
  // see SUBMIT_RPC_URL in .env.example for the network-specific setup.
  //
  // Submits effectiveMinProfit, not the raw minProfit -- otherwise the
  // gas-adjusted check above is purely advisory: price could drift into
  // the band between minProfit and effectiveMinProfit before this tx
  // lands (up to executeBefore, ~2min), and the contract would execute a
  // trade that's profitable on-chain but net-negative after gas. For a
  // WETH borrow, effectiveMinProfit is the gas-adjusted floor computed
  // above; for anything else it's just minProfit unchanged (see the
  // comment above for why no adjustment is safe to make there).
  const tx = await botSubmit.requestFlashLoanArbitrage(
    amount,
    adapter1,
    routeData1,
    adapter2,
    routeData2,
    effectiveMinProfit,
    slippageBps,
    deadlineSeconds,
    executeBefore
  );
  console.log('submitted:', tx.hash);
  try {
    const receipt = await tx.wait(1, CONFIRMATION_TIMEOUT_MS);
    console.log('confirmed in block', receipt.blockNumber);
  } catch (err) {
    // Without a timeout, a bundle that never lands on a private relay
    // leaves this process blocked indefinitely with a consumed nonce,
    // stalling every subsequent submission behind it. On timeout, free
    // the nonce with a 0-value self-transfer at a bumped fee, so the
    // next scan pass isn't stuck behind a tx that may never confirm.
    if (err.code === 'TIMEOUT') {
      console.error(`tx ${tx.hash} did not confirm within ${CONFIRMATION_TIMEOUT_MS}ms, cancelling nonce ${tx.nonce}`);
      await cancelStuckTransaction(tx.nonce);
    } else {
      throw err;
    }
  }
}

/** Frees a stuck nonce with a 0-value self-transfer at a bumped fee. */
async function cancelStuckTransaction(nonce) {
  const feeData = await submitProvider.getFeeData();
  // Some endpoints return null fee data for non-EIP-1559 chains -- fail
  // loudly here rather than crash on BigInt * null below, which would
  // exit one-shot mode with the nonce still stuck and no explanation.
  if (feeData.maxFeePerGas == null || feeData.maxPriorityFeePerGas == null) {
    console.error(`cannot build cancellation for nonce ${nonce}: endpoint returned no EIP-1559 fee data -- manual intervention required`);
    return;
  }
  const cancelTx = await submitWallet.sendTransaction({
    to: submitWallet.address,
    value: 0,
    nonce,
    // A replacement tx needs a real fee bump to be accepted, not just a
    // higher number than the original -- 50% covers typical minimum-bump
    // requirements across clients/relays.
    maxFeePerGas: (feeData.maxFeePerGas * 150n) / 100n,
    maxPriorityFeePerGas: (feeData.maxPriorityFeePerGas * 150n) / 100n,
  });
  console.log('cancellation tx sent:', cancelTx.hash);
  // Bounded, same as the original tx's wait in tryRoute() -- without a
  // timeout here, a cancellation that itself never confirms (e.g. a
  // private relay that won't broadcast a bare self-transfer) blocks this
  // process forever with the nonce still consumed. In WATCH_MODE that
  // means the `scanning` flag never resets and every future block gets
  // silently skipped -- the exact failure mode this function exists to
  // prevent, just moved one level up.
  try {
    await cancelTx.wait(1, CONFIRMATION_TIMEOUT_MS);
    console.log(`nonce ${nonce} freed`);
  } catch {
    console.error(`cancellation for nonce ${nonce} also did not confirm within ${CONFIRMATION_TIMEOUT_MS}ms -- manual intervention required`);
  }
}

// ---------------------------------------------------------------------
// Opportunity discovery.
//
// Four axes of coverage, all driven by config (see .env.example) so
// adding a newly-deployed adapter or a newly-approved token needs no
// code change:
//
// 1. ADAPTERS (plural, protocol-tagged: `address:protocol`) -- every
//    adapter1 x adapter2 combination gets scanned, not just "the one
//    adapter" against itself. Each adapter is tagged with its protocol
//    (v2/v3/curve/balancer, default v3 if omitted) so routeData gets
//    encoded correctly per protocol -- see encodeForProtocol() below.
//    This matters because the four protocols are NOT interchangeable
//    here:
//      - v2/v3 are token-agnostic -- one adapter instance can route
//        between any pair of tokens its underlying router/factory has a
//        pool for, so these participate in the full combinatorial
//        via-token search below (buildTwoLegCandidates /
//        buildTriangularCandidates, both restricted to genericAdapters).
//      - curve/balancer adapters are each bound to ONE specific,
//        already-deployed pool (immutable in Curve's case, chosen by
//        poolId in Balancer's) with a fixed token pair -- "try this
//        adapter against every via-token" doesn't make sense for them.
//        Curve's exact pair+coin-indices are discovered on-chain at
//        startup via resolveCurveCandidates() below, since coins(i) is
//        public on every pool. Balancer's poolId is NOT derivable from
//        just the vault/token addresses (one Vault manages many pools),
//        so Balancer routes aren't auto-generated yet -- encoding is
//        ready (encodeBalancerRouteData) but candidate generation isn't
//        wired up, since there's no real Balancer pool verified live on
//        either testnet to design or test it against (see notes/03 -
//        Address Registry.md). Once one is verified, this needs the same
//        treatment resolveCurveCandidates() got, plus a way to supply
//        poolId (not derivable the way Curve's indices are).
//
// 2. Triangular routes -- when 2+ VIA_TOKENS are configured, every
//    ordered pair of *distinct* via-tokens also gets scanned as a
//    3-hop BORROWED_ASSET -> viaA -> viaB -> BORROWED_ASSET route (both
//    ways to split a 3-hop path across the executor's two legs), in
//    addition to the plain 2-hop BORROWED_ASSET -> via -> BORROWED_ASSET
//    round trips. Only the token-agnostic (v2/v3) adapters participate,
//    since Curve/Balancer adapters here are hardcoded to tokens.length
//    == 2 (see CurveAdapter.sol / BalancerAdapter.sol's own scope-limit
//    comments) -- a 3-token leg would revert against them immediately.
//
// 3. Speed -- WATCH_MODE=true re-runs the scan on every new block
//    instead of once and exiting, via the provider's own block
//    subscription (works over plain HTTPS RPC through ethers' internal
//    polling, or faster still over a wss:// endpoint if your RPC
//    provider supports one -- same code path either way). True
//    mempool-level reaction (seeing a pending tx before it lands, not
//    just reacting to the block after) needs a provider that exposes
//    pending-transaction subscriptions, which isn't universal across
//    RPC providers -- that's a further step on top of this, not
//    something this generic script can assume it has access to.
//
// 4. Decimals -- amounts are parsed/formatted using BORROWED_ASSET's
//    actual on-chain decimals() (see resolveDecimals() below), not a
//    hardcoded 18. Needed the moment a 6-decimal token like USDC (see
//    notes/03 - Address Registry.md) is used as BORROWED_ASSET --
//    ethers.parseEther would otherwise be off by 10^12.
//
// Still not a production scanner even with all four: candidate count still
// grows combinatorially with how many adapters/via-tokens/fee-tiers you
// configure. Two things now cap what that growth actually costs:
//   - prefilterCandidates() (optional -- set V3_FACTORY_ADDRESS and/or
//     V2_FACTORY_ADDRESS to enable) reads one cheap spot-price per unique
//     hop (slot0()/getReserves(), not a swap simulation) and keeps only
//     the top PREFILTER_TOP_N candidates by rough estimated profit.
//   - rankCandidates() below still quotes whatever survives that (or
//     everything, if the pre-filter is off) via the real, authoritative
//     quoteRoute(), batched via SCAN_CONCURRENCY to avoid hammering the
//     RPC provider.
// The pre-filter is a ranking approximation, not a substitute for
// quoteRoute() -- see prefilterCandidates()'s own doc comment for exactly
// what it ignores (concentrated-liquidity depth, tick-crossing). Keep the
// adapter/via-token list deliberately scoped to what's actually approved
// and worth checking either way, not "everything you can think of."
// ---------------------------------------------------------------------

const KNOWN_PROTOCOLS = new Set(['v2', 'v3', 'curve', 'balancer']);
// Protocols whose adapters are token-agnostic (any approved pair works),
// as opposed to bound to one specific pre-deployed pool.
const GENERIC_PROTOCOLS = new Set(['v2', 'v3']);

/** `ADAPTERS=0xabc:v3,0xdef:v2,0x123:curve` -- protocol defaults to v3 if omitted, matching this project's pre-existing single-adapter config with no breaking change. */
function parseAdapterList() {
  return (process.env.ADAPTERS || '')
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

function parseAddressList(envVar) {
  return (process.env[envVar] || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseFeeTiers() {
  return (process.env.FEE_TIERS || '500,3000,10000').split(',').map((s) => Number(s.trim()));
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
            // Per-hop metadata for prefilterCandidates() below -- not used
            // by tryRoute()/rankCandidates(), which only ever look at the
            // already-encoded routeData.
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

/**
 * For each curve-tagged adapter, discovers on-chain which two tokens its
 * pool actually trades (coins(0)/coins(1)) -- there's no "try every via
 * token" search for Curve the way there is for v2/v3, since one adapter
 * instance is bound to one already-deployed pool with a fixed pair. If
 * that pair is {BORROWED_ASSET, someOtherToken}, generates the one
 * round-trip candidate this adapter can actually serve, in both coin-
 * index directions. If it doesn't include BORROWED_ASSET at all, this
 * adapter contributes nothing to this scan (not an error -- just not a
 * relevant pool for the asset currently being borrowed).
 */
async function resolveCurveCandidates(curveAdapters, borrowedAsset, provider, { amount, minProfit, slippageBps }) {
  const candidates = [];
  for (const { address } of curveAdapters) {
    const curveAdapterContract = new ethers.Contract(address, ['function POOL() view returns (address)'], provider);
    const poolAddress = await curveAdapterContract.POOL();
    const pool = new ethers.Contract(poolAddress, CURVE_POOL_ABI, provider);
    const [coin0, coin1] = await Promise.all([pool.coins(0), pool.coins(1)]);

    const borrowedLower = borrowedAsset.toLowerCase();
    let otherToken, iOut, jOut;
    if (coin0.toLowerCase() === borrowedLower) {
      [otherToken, iOut, jOut] = [coin1, 0, 1];
    } else if (coin1.toLowerCase() === borrowedLower) {
      [otherToken, iOut, jOut] = [coin0, 1, 0];
    } else {
      console.log(`curve adapter ${address}: pool trades ${coin0}/${coin1}, doesn't include BORROWED_ASSET -- skipping`);
      continue;
    }

    candidates.push({
      amount,
      adapter1: address,
      routeData1: encodeCurveRouteData([borrowedAsset, otherToken], iOut, jOut),
      adapter2: address,
      routeData2: encodeCurveRouteData([otherToken, borrowedAsset], jOut, iOut),
      minProfit,
      slippageBps,
    });
  }
  return candidates;
}

// Resolved once per process and cached forever -- a pool's ADDRESS at a
// given (protocol, tokenA, tokenB, fee) doesn't change block to block, so
// re-deriving it via factory.getPool()/getPair() on every WATCH_MODE pass
// would just be wasted RPC calls. The pool's PRICE is a different story
// (see resolveHopPrice()/prefilterCandidates() below) -- that's never
// cached across passes, since staleness there would defeat the point.
const poolAddressCache = new Map();

async function resolvePoolAddress(protocol, tokenA, tokenB, fee, factoryAddress) {
  const key = `${protocol}:${tokenA.toLowerCase()}:${tokenB.toLowerCase()}:${fee || 0}`;
  if (poolAddressCache.has(key)) return poolAddressCache.get(key);

  const poolAddress =
    protocol === 'v3'
      ? await new ethers.Contract(factoryAddress, V3_FACTORY_ABI, provider).getPool(tokenA, tokenB, fee)
      : await new ethers.Contract(factoryAddress, V2_FACTORY_ABI, provider).getPair(tokenA, tokenB);

  const resolved = poolAddress === ethers.ZeroAddress ? null : poolAddress;
  poolAddressCache.set(key, resolved);
  return resolved;
}

/**
 * Fetches one hop's current price, cheaply -- slot0() for v3 (a single
 * storage read) or getReserves() for v2 -- instead of the full swap
 * simulation quoteRoute()/QuoterV2 does. Returns null when there's no
 * pool at all for this (protocol, tokenIn, tokenOut, fee) combination.
 */
async function resolveHopPrice(protocol, tokenIn, tokenOut, fee, factoryAddress) {
  const poolAddress = await resolvePoolAddress(protocol, tokenIn, tokenOut, fee, factoryAddress);
  if (!poolAddress) return null;

  if (protocol === 'v3') {
    const pool = new ethers.Contract(poolAddress, V3_POOL_ABI, provider);
    const [slot0, token0] = await Promise.all([pool.slot0(), pool.token0()]);
    return { protocol, fee, token0: token0.toLowerCase(), sqrtPriceX96: slot0.sqrtPriceX96 };
  }

  const pair = new ethers.Contract(poolAddress, V2_PAIR_ABI, provider);
  const [reserves, token0] = await Promise.all([pair.getReserves(), pair.token0()]);
  return { protocol, token0: token0.toLowerCase(), reserve0: reserves.reserve0, reserve1: reserves.reserve1 };
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

function hopKey(hop) {
  return `${hop.protocol}:${hop.tokenIn.toLowerCase()}:${hop.tokenOut.toLowerCase()}:${hop.fee || 0}`;
}

/**
 * Cheap local ranking pass before the expensive, authoritative
 * quoteRoute() check: fetches ONE price per unique hop across the whole
 * candidate set (not one per candidate -- the same via-token/fee hop
 * shows up in many candidates, e.g. every adapter-pair variant routing
 * through the same via-token at the same fee tier), chains those prices
 * to estimate each candidate's round-trip output, and keeps only the top
 * prefilterTopN. This is a RANKING signal only -- see applyHopPrice()'s
 * doc comment for why it can rank a real winner below a candidate that
 * later reverts or quotes worse. rankCandidates() still runs the real
 * quoteRoute() on whatever this returns, and still decides everything
 * about submission.
 *
 * A no-op (returns candidates unchanged) when neither factory address is
 * configured, or when there aren't more candidates than prefilterTopN
 * already -- so leaving V3_FACTORY_ADDRESS/V2_FACTORY_ADDRESS unset keeps
 * today's exact behavior, no breaking change.
 */
async function prefilterCandidates(candidates, config) {
  const { v3FactoryAddress, v2FactoryAddress, prefilterTopN, concurrency } = config;
  if ((!v3FactoryAddress && !v2FactoryAddress) || candidates.length <= prefilterTopN) {
    return candidates;
  }
  console.log(`pre-filtering ${candidates.length} candidate(s) down to the top ${prefilterTopN} by local reserve math before quoting...`);

  const uniqueHops = new Map();
  for (const c of candidates) {
    for (const hop of c._hops) {
      const factoryAddress = hop.protocol === 'v3' ? v3FactoryAddress : hop.protocol === 'v2' ? v2FactoryAddress : null;
      if (!factoryAddress) continue;
      uniqueHops.set(hopKey(hop), { hop, factoryAddress });
    }
  }

  const priceCache = new Map(); // hopKey -> price descriptor, or null if unresolvable
  const hopEntries = [...uniqueHops.entries()];
  for (let i = 0; i < hopEntries.length; i += concurrency) {
    const batch = hopEntries.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async ([key, { hop, factoryAddress }]) => {
        priceCache.set(key, await resolveHopPrice(hop.protocol, hop.tokenIn, hop.tokenOut, hop.fee, factoryAddress));
      })
    );
  }

  const scored = candidates.map((c) => {
    let amount = c.amount;
    for (const hop of c._hops) {
      const price = priceCache.get(hopKey(hop));
      if (!price) {
        amount = null;
        break;
      }
      amount = applyHopPrice(hop, price, amount);
      if (amount === null) break;
    }
    return { ...c, _roughProfit: amount === null ? null : amount - c.amount };
  });

  // Candidates whose hops couldn't be priced at all (no pool at that fee
  // tier, or a protocol this pre-filter doesn't cover) can't be ranked --
  // cluster them at the bottom instead of dropping them outright, so a
  // real-but-unpriced route still gets a shot at the top N when there's
  // room, same as it always could before this pre-filter existed.
  scored.sort((a, b) => {
    if (a._roughProfit === null && b._roughProfit === null) return 0;
    if (a._roughProfit === null) return 1;
    if (b._roughProfit === null) return -1;
    return b._roughProfit > a._roughProfit ? 1 : b._roughProfit < a._roughProfit ? -1 : 0;
  });

  return scored.slice(0, prefilterTopN);
}

async function buildCandidates(config) {
  const genericCandidates = buildTwoLegCandidates(config);
  if (config.viaTokens.length >= 2) {
    genericCandidates.push(...buildTriangularCandidates(config));
  }

  const candidates = await prefilterCandidates(genericCandidates, config);

  // Curve candidates bypass the pre-filter entirely: there's at most one
  // per curve-tagged adapter (resolveCurveCandidates() doesn't search a
  // via-token space the way the generic builders do), so they were never
  // the source of combinatorial RPC load this pre-filter exists to cut.
  if (config.curveAdapters.length > 0) {
    candidates.push(...(await resolveCurveCandidates(config.curveAdapters, config.borrowedAsset, provider, config)));
  }
  return candidates;
}

/**
 * Quotes every candidate via quoteRoute() -- a free eth_call, not a real
 * transaction -- in batches of `concurrency` at a time (rather than all
 * at once) so a broad scan doesn't fire hundreds of simultaneous
 * requests at the RPC provider. Returns the candidates that didn't
 * revert, best-profit first. A candidate reverting just means no pool
 * exists at that specific fee-tier combination, or the route isn't
 * currently viable; that's an expected, common outcome when scanning
 * many fee-tier/token combinations, not a fatal error for the scan as
 * a whole.
 */
async function rankCandidates(candidates, concurrency) {
  const results = [];
  for (let i = 0; i < candidates.length; i += concurrency) {
    const batch = candidates.slice(i, i + concurrency);
    const batchResults = await Promise.all(
      batch.map(async (c) => {
        try {
          const netProfit = await bot.quoteRoute.staticCall(c.amount, c.adapter1, c.routeData1, c.adapter2, c.routeData2);
          return { ...c, netProfit };
        } catch {
          return null;
        }
      })
    );
    results.push(...batchResults);
  }
  return results.filter((c) => c !== null).sort((a, b) => (b.netProfit > a.netProfit ? 1 : b.netProfit < a.netProfit ? -1 : 0));
}

/** Reads BORROWED_ASSET's real on-chain decimals -- see the "Decimals" axis in the comment block above for why this can't be hardcoded to 18. */
async function resolveDecimals(tokenAddress) {
  const token = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
  return token.decimals();
}

async function loadScanConfig() {
  const parsedAdapters = parseAdapterList();
  const borrowedAsset = process.env.BORROWED_ASSET;
  const viaTokens = parseAddressList('VIA_TOKENS');

  if (parsedAdapters.length === 0 || !borrowedAsset || viaTokens.length === 0) {
    return null;
  }

  const genericAdapters = parsedAdapters.filter((a) => GENERIC_PROTOCOLS.has(a.protocol));
  const curveAdapters = parsedAdapters.filter((a) => a.protocol === 'curve');
  const balancerAdapters = parsedAdapters.filter((a) => a.protocol === 'balancer');
  if (balancerAdapters.length > 0) {
    console.log(
      `${balancerAdapters.length} balancer adapter(s) configured but not yet scanned -- poolId isn't derivable on-chain the way Curve's coin indices are; see the comment above buildCandidates() for how to wire one in once a real pool is verified live.`
    );
  }

  const [decimals, wethAddress] = await Promise.all([resolveDecimals(borrowedAsset), bot.WETH()]);

  return {
    genericAdapters,
    curveAdapters,
    borrowedAsset,
    isBorrowedAssetWeth: borrowedAsset.toLowerCase() === wethAddress.toLowerCase(),
    decimals,
    viaTokens,
    feeTiers: parseFeeTiers(),
    amount: ethers.parseUnits(process.env.SCAN_AMOUNT || '1', decimals),
    minProfit: ethers.parseUnits(process.env.MIN_PROFIT || '0.01', decimals),
    slippageBps: Number(process.env.SLIPPAGE_BPS || 300),
    concurrency: Number(process.env.SCAN_CONCURRENCY || 20),
    // Local reserve-math pre-filter (see prefilterCandidates() above) --
    // both optional. Leaving them unset disables the pre-filter entirely,
    // so every candidate still reaches the real quoteRoute() check exactly
    // as before this feature existed.
    v3FactoryAddress: process.env.V3_FACTORY_ADDRESS || null,
    v2FactoryAddress: process.env.V2_FACTORY_ADDRESS || null,
    prefilterTopN: Number(process.env.PREFILTER_TOP_N || 25),
  };
}

/** One full scan-and-try pass. Called once directly, or repeatedly in WATCH_MODE. */
async function scanOnce(config) {
  const candidates = await buildCandidates(config);
  console.log(`scanning ${candidates.length} candidate route(s)...`);

  const ranked = await rankCandidates(candidates, config.concurrency);
  console.log(`${ranked.length} candidate(s) returned a quote (the rest had no pool at that fee tier, or reverted)`);
  if (ranked.length === 0) {
    console.log('no viable routes found this pass');
    return;
  }

  const best = ranked[0];
  console.log(`best candidate net profit: ${ethers.formatUnits(best.netProfit, config.decimals)}`);

  // tryRoute() re-quotes internally before submitting -- intentional, not
  // duplicate work: it's a fresh state check immediately before spending
  // gas, in case anything moved between this scan and now.
  await tryRoute(best, config.decimals, config.isBorrowedAssetWeth);
}

async function main() {
  await assertSubmissionSetupIsSafe();

  const config = await loadScanConfig();
  if (!config) {
    console.log('Set ADAPTERS, BORROWED_ASSET, and VIA_TOKENS in .env to scan for routes -- see .env.example.');
    return;
  }

  if (process.env.WATCH_MODE === 'true') {
    console.log('watch mode: scanning on every new block (Ctrl+C to stop)...');
    let scanning = false;
    provider.on('block', async (blockNumber) => {
      if (scanning) {
        console.log(`block ${blockNumber}: previous scan still running, skipping this block`);
        return;
      }
      scanning = true;
      try {
        console.log(`--- block ${blockNumber} ---`);
        await scanOnce(config);
      } catch (err) {
        console.error('scan error (continuing to watch):', err);
      } finally {
        scanning = false;
      }
    });
    // Intentionally never resolves -- the block listener above is what
    // keeps the process alive. Ctrl+C (or a process manager) stops it.
    return new Promise(() => {});
  }

  await scanOnce(config);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
