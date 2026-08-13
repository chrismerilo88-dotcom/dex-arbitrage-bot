/**
 * Reports progress toward notes/06 - Pre-Mainnet Checklist.md's
 * pre-funding bar: 100+ simulated (DRY_RUN) arbitrage opportunities with
 * realistic gas/slippage/execution modeling and positive expected net
 * P&L, before any real trading capital gets funded.
 *
 * "Positive expected net P&L" here means quotedNetProfit already cleared
 * the real, on-chain gas-adjusted threshold that gates a real submission
 * (see tryRoute()'s effectiveMinProfit check in off-chain-bot/index.js)
 * -- i.e. an outcome of 'dry_run', not just any attempt. Everything that
 * got as far as a real quoteRoute() call but didn't clear that bar
 * (skipped_below_threshold, skipped_would_revert) is genuine market data
 * too, just not a "positive P&L opportunity" by this bar's own
 * definition -- reported separately below for context, not counted
 * toward the 100.
 *
 * Usage: node report.js [network label, default "Ethereum Mainnet"]
 */

const db = require('./db');

function main() {
  const network = process.argv[2] || 'Ethereum Mainnet';

  const rows = db.recentAttempts(1_000_000).filter((r) => r.network === network);
  const dryRunOpportunities = rows.filter((r) => r.outcome === 'dry_run');
  const belowThreshold = rows.filter((r) => r.outcome === 'skipped_below_threshold' || r.outcome === 'skipped_would_revert');

  console.log(`=== ${network}: pre-funding milestone progress ===\n`);
  console.log(`Positive-net-P&L opportunities observed: ${dryRunOpportunities.length} / 100`);
  console.log(`Other real quoted attempts (no opportunity at that instant): ${belowThreshold.length}`);
  console.log(`Total attempts recorded: ${rows.length}\n`);

  if (dryRunOpportunities.length === 0) {
    console.log('No positive-net-P&L opportunities recorded yet -- expected in the short term. Real arbitrage windows are brief and rare; this needs sustained runtime, not a quick check.');
    return;
  }

  const profits = dryRunOpportunities.map((r) => BigInt(r.quotedNetProfit));
  const total = profits.reduce((sum, p) => sum + p, 0n);
  const best = profits.reduce((max, p) => (p > max ? p : max));

  console.log(`Aggregate quoted net profit across all opportunities (raw units, BORROWED_ASSET decimals): ${total}`);
  console.log(`Best single opportunity (raw units): ${best}`);
  console.log('\nMost recent opportunities:');
  for (const r of dryRunOpportunities.slice(0, 10)) {
    console.log(`  [${r.timestamp}] profit ${r.quotedNetProfit} -- adapters ${r.adapter1}/${r.adapter2}`);
  }
}

main();
