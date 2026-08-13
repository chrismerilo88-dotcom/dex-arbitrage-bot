/**
 * Shared SQLite persistence -- every scan attempt (skipped, dry-run,
 * submitted, confirmed, reverted) plus circuit-breaker state, in one
 * file both off-chain-bot/ (the writer, mostly) and monitoring/ (reads
 * for Telegram /status, writes pause/resume) can see.
 *
 * Uses node:sqlite -- built into Node 22+, no native-compile dependency
 * (unlike better-sqlite3), and this project is already committed to
 * Node 24. WAL mode specifically because two separate processes touch
 * this file concurrently (the scanner writing attempts, the monitor
 * reading/writing circuit-breaker state) -- WAL lets readers and a
 * writer proceed without blocking each other the way SQLite's default
 * rollback journal mode would.
 *
 * Zero new npm dependencies: node:sqlite, node:path, node:fs are all
 * built-in.
 */

const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'bot.db');

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    network TEXT NOT NULL,
    adapter1 TEXT,
    adapter2 TEXT,
    amount TEXT,
    quotedNetProfit TEXT,
    outcome TEXT NOT NULL,
    gasUsedWei TEXT,
    gasCostWei TEXT,
    txHash TEXT,
    errorMessage TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_attempts_network_timestamp ON attempts (network, timestamp);

  -- Singleton row (id always 1) -- one circuit-breaker state per DB, not
  -- per network, since a compromised or misbehaving key is a whole-bot
  -- concern, not something to isolate per chain.
  CREATE TABLE IF NOT EXISTS circuit_breaker (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    halted INTEGER NOT NULL DEFAULT 0,
    haltedAt TEXT,
    haltedReason TEXT,
    resumedAt TEXT
  );
  INSERT OR IGNORE INTO circuit_breaker (id, halted) VALUES (1, 0);
`);

/** Every field optional except network/outcome -- callers fill in whatever's known at the point they're recording. */
function recordAttempt({
  network,
  adapter1 = null,
  adapter2 = null,
  amount = null,
  quotedNetProfit = null,
  outcome,
  gasUsedWei = null,
  gasCostWei = null,
  txHash = null,
  errorMessage = null,
}) {
  db.prepare(
    `INSERT INTO attempts (timestamp, network, adapter1, adapter2, amount, quotedNetProfit, outcome, gasUsedWei, gasCostWei, txHash, errorMessage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    new Date().toISOString(),
    network,
    adapter1,
    adapter2,
    amount,
    quotedNetProfit,
    outcome,
    gasUsedWei,
    gasCostWei,
    txHash,
    errorMessage
  );
}

function recentAttempts(limit = 20) {
  return db.prepare('SELECT * FROM attempts ORDER BY id DESC LIMIT ?').all(limit);
}

/** Sums gasCostWei for everything that actually landed on-chain (submitted or confirmed) today, in a given network -- what the circuit breaker's daily cap checks against. */
function dailyGasSpendWei(network) {
  const todayPrefix = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(CAST(gasCostWei AS INTEGER)), 0) AS total
       FROM attempts
       WHERE network = ? AND timestamp LIKE ? AND gasCostWei IS NOT NULL
         AND outcome IN ('submitted', 'confirmed', 'failed_revert_onchain')`
    )
    .get(network, `${todayPrefix}%`);
  return BigInt(row.total);
}

/**
 * Counts trailing failures (reverted/failed on-chain, not just skipped
 * for being below threshold) since the most recent success, for a given
 * network -- the circuit breaker's consecutive-failure trigger. A
 * 'skipped_*' outcome (never submitted at all) doesn't count as a
 * failure and doesn't reset the streak either -- it's simply not a
 * signal either way.
 */
function consecutiveFailures(network) {
  const rows = db
    .prepare('SELECT outcome FROM attempts WHERE network = ? ORDER BY id DESC')
    .all(network);
  let count = 0;
  for (const row of rows) {
    if (row.outcome === 'confirmed') break;
    if (row.outcome === 'failed_revert_onchain' || row.outcome === 'failed_timeout') count++;
  }
  return count;
}

function getCircuitBreakerState() {
  return db.prepare('SELECT * FROM circuit_breaker WHERE id = 1').get();
}

function haltCircuitBreaker(reason) {
  db.prepare('UPDATE circuit_breaker SET halted = 1, haltedAt = ?, haltedReason = ?, resumedAt = NULL WHERE id = 1').run(
    new Date().toISOString(),
    reason
  );
}

/** Deliberately requires an explicit call -- no auto-reset after a cooldown. A tripped breaker means something needs a human's judgment before the bot submits again, not a timer's. */
function resumeCircuitBreaker() {
  db.prepare('UPDATE circuit_breaker SET halted = 0, resumedAt = ? WHERE id = 1').run(new Date().toISOString());
}

module.exports = {
  recordAttempt,
  recentAttempts,
  dailyGasSpendWei,
  consecutiveFailures,
  getCircuitBreakerState,
  haltCircuitBreaker,
  resumeCircuitBreaker,
};
