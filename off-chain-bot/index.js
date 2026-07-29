/**
 * Minimal skeleton for the off-chain half of this system.
 *
 * This is NOT a scanner -- it doesn't discover opportunities on its own.
 * It shows the two things every scanner eventually needs regardless of
 * how it finds a candidate route: (1) verify profitability against live
 * chain state via quoteRoute() before spending any gas, and (2) submit
 * the request. Where you plug in real opportunity discovery (comparing
 * quotes across many pools, reacting to new blocks or mempool activity)
 * is marked below -- that's the actual "bot" and it's a substantial
 * project of its own, not something with one correct implementation.
 *
 * Usage:
 *   npm install ethers dotenv
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

// abi.encode(address[] tokens, bytes extra) -- mirrors RouteData.sol.
// extra is empty for a plain V2 leg; see the main README for V3/Curve/
// Balancer's extra encodings.
function encodeV2RouteData(tokens) {
  const abiCoder = ethers.AbiCoder.defaultAbiCoder();
  return abiCoder.encode(['address[]', 'bytes'], [tokens, '0x']);
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
  if (netProfit < minProfit) {
    console.log('below minProfit threshold, skipping');
    return;
  }

  const executeBefore = Math.floor(Date.now() / 1000) + 120; // 2 min to land
  const deadlineSeconds = 300;

  // --- Submission -----------------------------------------------------
  // Sending this via provider.sendTransaction (i.e. the public mempool)
  // is what makes this vulnerable to front-running -- see the MEV
  // discussion earlier in this project's history. For real use, submit
  // through a private relay instead (e.g. Flashbots Protect's RPC
  // endpoint, or MEV Blocker) so the transaction never sits in the
  // public mempool for a searcher to see and copy. Swapping that in is
  // a change to how `wallet`/`provider` is constructed above, not to
  // the call below.
  const tx = await bot.requestFlashLoanArbitrage(
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
// >>> Real opportunity discovery goes here. <<<
// This is where an actual bot spends most of its engineering effort:
// pulling reserves/quotes across every pool you care about (directly via
// each protocol's contracts, or a subgraph/indexer for speed), computing
// candidate routes and their approximate profitability *before* paying
// for an on-chain quoteRoute() call, and deciding which candidates are
// worth the round-trip above. A production version of this typically
// runs on every new block (or every pending tx that touches a pool you
// watch), not on a timer -- speed is most of the competitive edge here.
// ---------------------------------------------------------------------
async function main() {
  const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

  // Placeholder candidate -- replace with a route your own scanning logic
  // actually found to be promising.
  await tryRoute({
    amount: ethers.parseEther('1'),
    adapter1: process.env.UNISWAP_V2_ADAPTER,
    routeData1: encodeV2RouteData([WETH, USDC]),
    adapter2: process.env.SUSHISWAP_V2_ADAPTER,
    routeData2: encodeV2RouteData([USDC, WETH]),
    minProfit: ethers.parseEther('0.01'),
    slippageBps: 300,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
