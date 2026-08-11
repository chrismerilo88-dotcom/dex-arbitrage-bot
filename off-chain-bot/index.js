/**
 * The off-chain half of this system.
 *
 * Two parts: (1) opportunity discovery -- scans 2-hop and triangular
 * (3-hop) BORROWED_ASSET round trips across every configured adapter
 * pair and V3 fee-tier combination (see the "Opportunity discovery"
 * section below for the three axes of coverage: adapters, triangular
 * routes, and WATCH_MODE for block-reactive scanning), and (2)
 * tryRoute() -- verifies profitability against live chain state via
 * quoteRoute() before spending any gas, then submits the request.
 *
 * This is a real, working scanner, but not a production one -- it has
 * no local reserve math, so every candidate costs a real network round
 * trip (batched, see SCAN_CONCURRENCY), and even in WATCH_MODE it reacts
 * to confirmed blocks, not pending mempool transactions. See the
 * "Opportunity discovery" section comment for exactly what's covered.
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
];

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider);
const bot = new ethers.Contract(process.env.EXECUTOR_ADDRESS, EXECUTOR_ABI, wallet);

// Separate provider/wallet/contract for the actual submission, so it can
// point at a private relay instead of the public mempool -- see
// SUBMIT_RPC_URL in .env.example. Falls back to RPC_URL when unset, so
// testnets work unchanged with no extra config.
const submitProvider = new ethers.JsonRpcProvider(process.env.SUBMIT_RPC_URL || process.env.RPC_URL);
const submitWallet = new ethers.Wallet(process.env.PRIVATE_KEY, submitProvider);
const botSubmit = new ethers.Contract(process.env.EXECUTOR_ADDRESS, EXECUTOR_ABI, submitWallet);

// Chain IDs where "submit through the public mempool" is not an acceptable
// default -- see SUBMIT_RPC_URL's comment in .env.example for why Ethereum
// and Base need different private-submission setups.
const MAINNET_CHAIN_IDS = new Set([1n, 8453n]); // Ethereum, Base

/// Fails loudly instead of silently degrading MEV protection: catches a
/// misconfigured/unset SUBMIT_RPC_URL on mainnet (which would otherwise
/// fall back to the public mempool with no warning), and catches
/// RPC_URL/SUBMIT_RPC_URL pointing at two different chains (which would
/// sign a transaction against the wrong network's EXECUTOR_ADDRESS).
async function assertSubmissionSetupIsSafe() {
  const [readNet, submitNet] = await Promise.all([provider.getNetwork(), submitProvider.getNetwork()]);

  if (readNet.chainId !== submitNet.chainId) {
    throw new Error(
      `chain mismatch: RPC_URL is chain ${readNet.chainId}, SUBMIT_RPC_URL is chain ${submitNet.chainId}`
    );
  }
  if (MAINNET_CHAIN_IDS.has(readNet.chainId) && !process.env.SUBMIT_RPC_URL) {
    throw new Error(
      `SUBMIT_RPC_URL is required on chain ${readNet.chainId} -- refusing to submit through the public mempool`
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

/**
 * Checks one candidate route and submits it if it clears minProfit.
 * This is the part every scanner calls once it *thinks* it found
 * something -- it does not itself decide what to check.
 */
async function tryRoute({ amount, adapter1, routeData1, adapter2, routeData2, minProfit, slippageBps }) {
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
  const netProfit = await bot.quoteRoute.staticCall(amount, adapter1, routeData1, adapter2, routeData2);

  console.log(`quoted net profit: ${ethers.formatEther(netProfit)} (borrowed-asset units)`);

  const executeBefore = Math.floor(Date.now() / 1000) + 120; // 2 min to land
  const deadlineSeconds = 300;

  // Gas-adjusted threshold: minProfit alone doesn't account for what this
  // specific request will actually cost to land. Only directly comparable
  // to netProfit when the borrowed asset is WETH (matching the on-chain
  // gas backstop's own restriction, see item 21 in the contract's header)
  // -- for any other borrowed asset, price gasCostWei into borrowed-asset
  // units yourself before relying on this comparison.
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
  const effectiveMinProfit = minProfit + gasCostWei;

  if (netProfit < effectiveMinProfit) {
    console.log(
      `below gas-adjusted threshold (minProfit ${ethers.formatEther(minProfit)} + est. gas ${ethers.formatEther(gasCostWei)}), skipping`
    );
    return;
  }

  // --- Submission -----------------------------------------------------
  // Goes through botSubmit (SUBMIT_RPC_URL), not bot (RPC_URL), so this
  // can be pointed at a private relay instead of the public mempool --
  // see SUBMIT_RPC_URL in .env.example for the network-specific setup.
  const tx = await botSubmit.requestFlashLoanArbitrage(
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
  console.log('submitted:', tx.hash);
  const receipt = await tx.wait();
  console.log('confirmed in block', receipt.blockNumber);
}

// ---------------------------------------------------------------------
// Opportunity discovery.
//
// Three axes of coverage, all driven by config (see .env.example) so
// adding a newly-deployed adapter or a newly-approved token needs no
// code change:
//
// 1. ADAPTERS (plural) -- every adapter1 x adapter2 combination gets
//    scanned, not just "the one adapter" against itself. Today this
//    project has one adapter approved per network (see notes/03 -
//    Address Registry.md), so that's a 1x1 product -- identical
//    behavior to before. The moment a second adapter (a different DEX,
//    or a second V3 deployment) is approved, it's compared automatically.
//
// 2. Triangular routes -- when 2+ VIA_TOKENS are configured, every
//    ordered pair of *distinct* via-tokens also gets scanned as a
//    3-hop BORROWED_ASSET -> viaA -> viaB -> BORROWED_ASSET route (both
//    ways to split a 3-hop path across the executor's two legs), in
//    addition to the plain 2-hop BORROWED_ASSET -> via -> BORROWED_ASSET
//    round trips. See buildTriangularCandidates() below -- this is a
//    direct application of what the architecture already supports
//    (RouteData's `tokens` array can be more than 2 tokens; a single
//    adapter leg can be multiple hops), not a new on-chain capability.
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
// Still not a production scanner even with all three: it has no local
// reserve math, so every candidate costs a real network round trip
// (batched via SCAN_CONCURRENCY to avoid hammering the RPC provider --
// see rankCandidates() below), and candidate count grows combinatorially
// with how many adapters/via-tokens/fee-tiers you configure. Keep that
// list deliberately scoped to what's actually approved and worth
// checking, not "everything you can think of."
// ---------------------------------------------------------------------

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

/**
 * Every BORROWED_ASSET -> viaToken -> BORROWED_ASSET round trip (one hop
 * per leg), across every adapter pair and fee-tier combination.
 */
function buildTwoLegCandidates({ adapters, borrowedAsset, viaTokens, feeTiers, amount, minProfit, slippageBps }) {
  const candidates = [];
  for (const [adapter1, adapter2] of adapterPairs(adapters)) {
    for (const viaToken of viaTokens) {
      for (const [feeOut] of feeCombos(feeTiers, 1)) {
        for (const [feeBack] of feeCombos(feeTiers, 1)) {
          candidates.push({
            amount,
            adapter1,
            routeData1: encodeV3RouteData([borrowedAsset, viaToken], [feeOut]),
            adapter2,
            routeData2: encodeV3RouteData([viaToken, borrowedAsset], [feeBack]),
            minProfit,
            slippageBps,
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
 * adapter pair and fee-tier combination. Built both ways to split the
 * 3-hop path across the executor's two legs (1-hop-then-2-hop, and
 * 2-hop-then-1-hop) since both are valid and may quote differently.
 */
function buildTriangularCandidates({ adapters, borrowedAsset, viaTokens, feeTiers, amount, minProfit, slippageBps }) {
  const candidates = [];
  for (const [adapter1, adapter2] of adapterPairs(adapters)) {
    for (const viaA of viaTokens) {
      for (const viaB of viaTokens) {
        if (viaA === viaB) continue;

        // Split A: leg1 = borrowed -> viaA (1 hop), leg2 = viaA -> viaB -> borrowed (2 hops)
        for (const [feeOut] of feeCombos(feeTiers, 1)) {
          for (const feeBackPair of feeCombos(feeTiers, 2)) {
            candidates.push({
              amount,
              adapter1,
              routeData1: encodeV3RouteData([borrowedAsset, viaA], [feeOut]),
              adapter2,
              routeData2: encodeV3RouteData([viaA, viaB, borrowedAsset], feeBackPair),
              minProfit,
              slippageBps,
            });
          }
        }

        // Split B: leg1 = borrowed -> viaA -> viaB (2 hops), leg2 = viaB -> borrowed (1 hop)
        for (const feeOutPair of feeCombos(feeTiers, 2)) {
          for (const [feeBack] of feeCombos(feeTiers, 1)) {
            candidates.push({
              amount,
              adapter1,
              routeData1: encodeV3RouteData([borrowedAsset, viaA, viaB], feeOutPair),
              adapter2,
              routeData2: encodeV3RouteData([viaB, borrowedAsset], [feeBack]),
              minProfit,
              slippageBps,
            });
          }
        }
      }
    }
  }
  return candidates;
}

function buildCandidates(config) {
  const candidates = buildTwoLegCandidates(config);
  if (config.viaTokens.length >= 2) {
    candidates.push(...buildTriangularCandidates(config));
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

function loadScanConfig() {
  const adapters = parseAddressList('ADAPTERS');
  const borrowedAsset = process.env.BORROWED_ASSET;
  const viaTokens = parseAddressList('VIA_TOKENS');

  if (adapters.length === 0 || !borrowedAsset || viaTokens.length === 0) {
    return null;
  }

  return {
    adapters,
    borrowedAsset,
    viaTokens,
    feeTiers: parseFeeTiers(),
    amount: ethers.parseEther(process.env.SCAN_AMOUNT || '1'),
    minProfit: ethers.parseEther(process.env.MIN_PROFIT || '0.01'),
    slippageBps: Number(process.env.SLIPPAGE_BPS || 300),
    concurrency: Number(process.env.SCAN_CONCURRENCY || 20),
  };
}

/** One full scan-and-try pass. Called once directly, or repeatedly in WATCH_MODE. */
async function scanOnce(config) {
  const candidates = buildCandidates(config);
  console.log(`scanning ${candidates.length} candidate route(s)...`);

  const ranked = await rankCandidates(candidates, config.concurrency);
  console.log(`${ranked.length} candidate(s) returned a quote (the rest had no pool at that fee tier, or reverted)`);
  if (ranked.length === 0) {
    console.log('no viable routes found this pass');
    return;
  }

  const best = ranked[0];
  console.log(`best candidate net profit: ${ethers.formatEther(best.netProfit)}`);

  // tryRoute() re-quotes internally before submitting -- intentional, not
  // duplicate work: it's a fresh state check immediately before spending
  // gas, in case anything moved between this scan and now.
  await tryRoute(best);
}

async function main() {
  await assertSubmissionSetupIsSafe();

  const config = loadScanConfig();
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
