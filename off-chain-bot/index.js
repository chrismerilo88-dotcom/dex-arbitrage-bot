/**
 * The off-chain half of this system.
 *
 * Two parts: (1) opportunity discovery -- scans BORROWED_ASSET -> via ->
 * BORROWED_ASSET round trips across configured V3 fee-tier combinations
 * through the one adapter this project currently has approved per
 * network (see the "Opportunity discovery" section below), and (2)
 * tryRoute() -- verifies profitability against live chain state via
 * quoteRoute() before spending any gas, then submits the request.
 *
 * This is a real, working scanner, but not a production one -- it scans
 * a fixed candidate list on a timer, not in reaction to new blocks or
 * mempool activity, and it has no local reserve math (every candidate
 * costs a network round trip). See the "Opportunity discovery" section
 * comment for what a production version needs on top of this.
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
// This project currently has one DEX adapter approved per network (see
// notes/03 - Address Registry.md), not multiple DEXs to compare against
// each other -- so the realistic candidate set right now is every
// BORROWED_ASSET -> viaToken -> BORROWED_ASSET round trip through that
// one adapter, across every V3 fee-tier combination for the two legs.
// Adding a second adapter later (a different DEX, or a different V3
// pool deployment) is a straightforward extension of buildCandidates()
// below, not a redesign.
//
// This is still not a production scanner: quoteRoute() calls are free
// eth_call reads (no gas spent scanning), but each one is a network
// round trip against a fixed token/fee-tier list on a timer, not a
// reaction to new blocks or mempool activity. Speed is most of the
// competitive edge in real MEV competition, and getting there means
// replacing this section with block/mempool-triggered scanning and
// (for real speed) local reserve math instead of a live call per
// candidate -- that's the "substantial project of its own" this file's
// header comment refers to.
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

/**
 * Builds every BORROWED_ASSET -> viaToken -> BORROWED_ASSET round trip
 * across every fee-tier combination for the two legs, using the same
 * adapter for both -- see the section comment above for why.
 */
function buildCandidates({ adapter, borrowedAsset, viaTokens, feeTiers, amount, minProfit, slippageBps }) {
  const candidates = [];
  for (const viaToken of viaTokens) {
    for (const feeOut of feeTiers) {
      for (const feeBack of feeTiers) {
        candidates.push({
          amount,
          adapter1: adapter,
          routeData1: encodeV3RouteData([borrowedAsset, viaToken], [feeOut]),
          adapter2: adapter,
          routeData2: encodeV3RouteData([viaToken, borrowedAsset], [feeBack]),
          minProfit,
          slippageBps,
        });
      }
    }
  }
  return candidates;
}

/**
 * Quotes every candidate via quoteRoute() -- a free eth_call, not a real
 * transaction -- and returns the ones that didn't revert, best-profit
 * first. A candidate reverting just means no pool exists at that
 * specific fee-tier combination, or the route isn't currently viable;
 * that's an expected, common outcome when scanning fee-tier
 * combinations, not a fatal error for the scan as a whole.
 */
async function rankCandidates(candidates) {
  const quoted = await Promise.all(
    candidates.map(async (c) => {
      try {
        const netProfit = await bot.quoteRoute.staticCall(c.amount, c.adapter1, c.routeData1, c.adapter2, c.routeData2);
        return { ...c, netProfit };
      } catch {
        return null;
      }
    })
  );
  return quoted.filter((c) => c !== null).sort((a, b) => (b.netProfit > a.netProfit ? 1 : b.netProfit < a.netProfit ? -1 : 0));
}

async function main() {
  await assertSubmissionSetupIsSafe();

  const adapter = process.env.ADAPTER_ADDRESS;
  const borrowedAsset = process.env.BORROWED_ASSET;
  const viaTokens = parseAddressList('VIA_TOKENS');

  if (!adapter || !borrowedAsset || viaTokens.length === 0) {
    console.log('Set ADAPTER_ADDRESS, BORROWED_ASSET, and VIA_TOKENS in .env to scan for routes -- see .env.example.');
    return;
  }

  const candidates = buildCandidates({
    adapter,
    borrowedAsset,
    viaTokens,
    feeTiers: parseFeeTiers(),
    amount: ethers.parseEther(process.env.SCAN_AMOUNT || '1'),
    minProfit: ethers.parseEther(process.env.MIN_PROFIT || '0.01'),
    slippageBps: Number(process.env.SLIPPAGE_BPS || 300),
  });
  console.log(`scanning ${candidates.length} candidate route(s)...`);

  const ranked = await rankCandidates(candidates);
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
