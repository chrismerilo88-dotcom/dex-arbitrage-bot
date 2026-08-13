/**
 * Shared structured logging -- level filtering (LOG_LEVEL env var) plus
 * file output with date-based rotation, so a failure at 9pm during an
 * unattended scheduled run is still diagnosable later, not just whatever
 * scrolled past in a terminal nobody was watching.
 *
 * Writes to shared/logs/ (next to shared/data/'s DB -- same reasoning:
 * one shared location both off-chain-bot/ and monitoring/ write to, so
 * their timelines can be correlated later) alongside the existing
 * console output, never instead of it -- systemd/journald already
 * captures monitor.js's console output (see `journalctl --user -u
 * dex-arbitrage-monitor.service`), and this doesn't change that.
 *
 * Deliberately no rotation *library* -- a new file per UTC day is a
 * simple, dependency-free way to bound any single file's size and make
 * "what happened on date X" a one-`cat`-away question, without pulling
 * in a package for something this small.
 */

const fs = require('node:fs');
const path = require('node:path');

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const configuredLevel = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;

const LOG_DIR = process.env.LOG_DIR || path.join(__dirname, 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });

let currentDate = null;
let stream = null;

function currentStream() {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
  if (today !== currentDate) {
    if (stream) stream.end();
    currentDate = today;
    stream = fs.createWriteStream(path.join(LOG_DIR, `${today}.log`), { flags: 'a' });
  }
  return stream;
}

function log(level, label, message, meta) {
  if (LEVELS[level] < configuredLevel) return;
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${label}] ${message}${meta !== undefined ? ' ' + JSON.stringify(meta) : ''}`;
  (level === 'error' || level === 'warn' ? console.error : console.log)(line);
  currentStream().write(line + '\n');
}

/** One logger instance per module/process label (e.g. "off-chain-bot", "monitor") -- shows up as the [label] tag on every line from that source, since both processes' output ends up in the same daily file. */
function createLogger(label) {
  return {
    debug: (message, meta) => log('debug', label, message, meta),
    info: (message, meta) => log('info', label, message, meta),
    warn: (message, meta) => log('warn', label, message, meta),
    error: (message, meta) => log('error', label, message, meta),
  };
}

module.exports = { createLogger };
