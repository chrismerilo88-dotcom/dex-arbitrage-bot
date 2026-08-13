/**
 * Watches DexArbitrageBotFlashLoan's admin-state events across every
 * configured network, in real time, and alerts on each one. Exists
 * specifically for notes/06 - Pre-Mainnet Checklist.md item 4: the
 * approval cooldown creates a review window before a newly-approved
 * adapter/token goes live, but a cooldown only works if someone is
 * actually watching for it -- this is that someone.
 *
 * Every admin-state event is covered, not just AdapterApprovalSet/
 * TokenApprovalSet -- an unexpected OwnershipTransferStarted,
 * OperatorSet, or MaxLoanAmountSet is exactly the same category of
 * "something changed, a human should know now" as a bad approval.
 *
 * Also runs a Telegram bot (optional -- TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID) alongside the chain watching: every alert above gets
 * sent there too, plus /status, /pause, /resume against
 * shared/data/bot.db's circuit-breaker state -- the same state
 * off-chain-bot/'s tryRoute() checks before every real submission, so
 * /pause here genuinely stops trading, not just this process's own
 * alerts. Works with zero chain targets configured too, if you only want
 * Telegram control over off-chain-bot without watching any executor's
 * events.
 *
 * Usage:
 *   npm install
 *   cp .env.example .env   # fill in MONITOR_* targets and/or TELEGRAM_*
 *   node monitor.js
 */

require('dotenv').config();
const { ethers } = require('ethers');
const db = require('../shared/db');

// Every event this contract emits that changes admin-relevant state.
// Deliberately not FlashArbitrageExecuted/Withdrawn -- those are normal
// operational activity, not the "did an admin action just happen"
// signal this monitor exists for.
const MONITORED_EVENTS = [
  'AdapterApprovalSet',
  'TokenApprovalSet',
  'UnlimitedApprovalSet',
  'ApprovalRevoked',
  'ApprovalDelaySet',
  'MaxLoanAmountSet',
  'OperatorSet',
  'OwnershipTransferStarted',
  'OwnershipTransferred',
  'Paused',
  'AutoSweepProfitSet',
  'PoolSet',
];

const EXECUTOR_ABI = [
  'event AdapterApprovalSet(address indexed adapter, bool approved, uint256 activatesAt)',
  'event TokenApprovalSet(address indexed token, bool approved, uint256 activatesAt)',
  'event UnlimitedApprovalSet(address indexed adapter, bool enabled)',
  'event ApprovalRevoked(address indexed token, address indexed adapter)',
  'event ApprovalDelaySet(uint256 newDelay)',
  'event MaxLoanAmountSet(uint256 newCap)',
  'event OperatorSet(address indexed operator)',
  'event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner)',
  'event OwnershipTransferred(address indexed previousOwner, address indexed newOwner)',
  'event Paused(bool isPaused)',
  'event AutoSweepProfitSet(bool enabled)',
  'event PoolSet(address pool)',
];

// Same wss://-vs-https:// dispatch as off-chain-bot/index.js's
// makeProvider() -- real-time push over a socket where the RPC provider
// supports one, HTTPS polling fallback otherwise. Duplicated rather than
// shared: this is a separate deployable process from off-chain-bot/,
// meant to run independently of (and survive outages in) the scanner.
function makeProvider(url) {
  return url.startsWith('ws://') || url.startsWith('wss://') ? new ethers.WebSocketProvider(url) : new ethers.JsonRpcProvider(url);
}

/**
 * `MONITOR_TARGETS=Label1|rpcUrlOrEnvVar|executorAddress;Label2|...` --
 * `|` and `;` delimiters specifically because `,` and `:` both appear
 * inside a literal RPC URL (`https://host/v2/key`), which broke the
 * first version of this parser the moment it was tested against a real
 * URL instead of an env-var name. The RPC segment is looked up as an env
 * var first (so you can reuse SEPOLIA_RPC_URL/BASE_SEPOLIA_RPC_URL/etc.
 * from the project root .env without duplicating the URL), falling back
 * to treating it as a literal URL if no env var by that name exists.
 */
function parseTargets() {
  return (process.env.MONITOR_TARGETS || '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const [label, rpcRef, executor] = entry.split('|').map((s) => s.trim());
      if (!label || !rpcRef || !executor) {
        throw new Error(`MONITOR_TARGETS entry "${entry}" must be "Label|rpcUrlOrEnvVar|executorAddress"`);
      }
      const rpcUrl = process.env[rpcRef] || rpcRef;
      return { label, rpcUrl, executor };
    });
}

function formatArg(value) {
  if (typeof value === 'bigint') return value.toString();
  return String(value);
}

async function alert(label, eventName, args, log) {
  const lines = [
    `[${new Date().toISOString()}] ${label}: ${eventName}`,
    `  tx: ${log.transactionHash}  block: ${log.blockNumber}`,
  ];
  for (const [key, value] of Object.entries(args)) {
    if (!Number.isNaN(Number(key))) continue; // skip ethers' positional duplicates, keep named keys only
    lines.push(`  ${key}: ${formatArg(value)}`);
  }
  // activatesAt is a unix timestamp -- the whole point of watching
  // AdapterApprovalSet/TokenApprovalSet is knowing exactly when the
  // review window closes and the approval goes live.
  if (args.activatesAt !== undefined) {
    lines.push(`  activatesAt (human): ${new Date(Number(args.activatesAt) * 1000).toISOString()}`);
  }
  const message = lines.join('\n');
  console.log(message);
  await sendWebhook(message);
  await sendTelegram(message);
}

/** Generic incoming-webhook POST -- {text, content} covers Slack and Discord's respective payload shapes in one request; unrecognized extra fields are ignored by both. No-op if unset, so this works with zero notification setup beyond console output. */
async function sendWebhook(message) {
  const url = process.env.MONITOR_WEBHOOK_URL;
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: message, content: message }),
    });
    if (!res.ok) console.error(`webhook POST failed: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error('webhook POST threw:', err);
  }
}

/** Telegram Bot API's sendMessage -- https://core.telegram.org/bots/api#sendmessage. Same failure-isolation principle as sendWebhook: never throws up to the caller, a notification failure can't break event watching. No-op if either var is unset. */
async function sendTelegram(message) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message }),
    });
    if (!res.ok) console.error(`Telegram sendMessage failed: ${res.status} ${res.statusText}`);
  } catch (err) {
    console.error('Telegram sendMessage threw:', err);
  }
}

/**
 * Answers a command from the one authorized chat -- /status reports the
 * circuit breaker's state and the last few scan attempts from
 * shared/data/bot.db (populated by off-chain-bot/, a separate OS
 * process -- this works because they share the same DB file, not
 * because they talk to each other directly). /pause and /resume write
 * that same circuit-breaker row, which off-chain-bot's tryRoute() checks
 * before every submission -- so pausing here genuinely stops real
 * transactions, not just this process's own alerting.
 */
async function handleTelegramCommand(text) {
  if (text === '/status') {
    const state = db.getCircuitBreakerState();
    const recent = db.recentAttempts(5);
    const lines = [
      `Circuit breaker: ${state.halted ? `🛑 HALTED (${state.haltedReason})` : '✅ active'}`,
      '',
      recent.length > 0 ? 'Last 5 attempts:' : 'No attempts recorded yet.',
      ...recent.map(
        (a) => `  [${a.timestamp}] ${a.network}: ${a.outcome}${a.quotedNetProfit ? ` (quoted profit ${a.quotedNetProfit})` : ''}`
      ),
    ];
    await sendTelegram(lines.join('\n'));
  } else if (text === '/pause') {
    db.haltCircuitBreaker('paused via Telegram');
    await sendTelegram('⏸️ Circuit breaker paused. off-chain-bot will not submit any requests until /resume.');
  } else if (text === '/resume') {
    db.resumeCircuitBreaker();
    await sendTelegram('▶️ Circuit breaker resumed. off-chain-bot will resume submitting requests.');
  } else {
    await sendTelegram('Unknown command. Available: /status, /pause, /resume');
  }
}

/**
 * Long-polls Telegram's getUpdates (https://core.telegram.org/bots/api#getupdates)
 * for commands -- polling rather than a webhook specifically because it
 * needs no public endpoint/TLS cert/port-forwarding, a good fit for a
 * personal bot running on a home machine behind NAT. Runs forever
 * (fire-and-forget from main()), retrying with a fixed delay on error
 * rather than crashing the whole monitor process over a transient
 * Telegram API hiccup.
 *
 * Authorization against TELEGRAM_CHAT_ID is load-bearing, not optional:
 * a Telegram bot is publicly discoverable by username, so anyone who
 * finds this one could otherwise pause/resume real trading. Messages
 * from any other chat are logged and ignored, never acted on.
 */
async function pollTelegramCommands() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const allowedChatId = process.env.TELEGRAM_CHAT_ID;
  console.log('Telegram command polling enabled...');

  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=${offset}&timeout=30`);
      const data = await res.json();
      if (!data.ok) {
        console.error('Telegram getUpdates returned an error:', data.description);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        continue;
      }
      for (const update of data.result) {
        offset = update.update_id + 1;
        const message = update.message;
        if (!message || !message.text) continue;
        if (String(message.chat.id) !== String(allowedChatId)) {
          console.warn(`ignoring Telegram message from unauthorized chat ${message.chat.id}`);
          continue;
        }
        await handleTelegramCommand(message.text.trim());
      }
    } catch (err) {
      console.error('Telegram polling loop error (retrying in 5s):', err);
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

/**
 * On startup, scans back MONITOR_LOOKBACK_BLOCKS (default 0 = skip
 * this) so a monitor that was offline doesn't silently miss whatever
 * happened while it was down -- the actual failure mode this exists to
 * prevent isn't "the monitor missed a live event," it's "nobody was
 * running the monitor at all for a while."
 */
async function catchUp(label, contract, provider) {
  const lookback = Number(process.env.MONITOR_LOOKBACK_BLOCKS || 0);
  if (lookback <= 0) return;

  const latest = await provider.getBlockNumber();
  const fromBlock = Math.max(0, latest - lookback);
  console.log(`${label}: catching up on blocks ${fromBlock}-${latest}...`);

  // Chunked, not one eth_getLogs call across the whole range -- several
  // RPC providers (confirmed live: Alchemy's free tier) cap the block
  // range per call much smaller than any useful lookback window (as low
  // as 10 blocks), and reject the request outright rather than
  // truncating it. MONITOR_LOOKBACK_CHUNK_SIZE defaults to that same
  // conservative 10 so this works out of the box on a free-tier
  // endpoint; raise it if your provider allows a wider range, for fewer
  // round trips on a long lookback.
  const address = await contract.getAddress();
  const chunkSize = Number(process.env.MONITOR_LOOKBACK_CHUNK_SIZE || 10);
  const rawLogs = [];
  for (let chunkStart = fromBlock; chunkStart <= latest; chunkStart += chunkSize) {
    const chunkEnd = Math.min(chunkStart + chunkSize - 1, latest);
    rawLogs.push(...(await provider.getLogs({ address, fromBlock: chunkStart, toBlock: chunkEnd })));
  }
  for (const log of rawLogs) {
    let parsed;
    try {
      parsed = contract.interface.parseLog(log);
    } catch {
      continue; // not one of this contract's known events -- skip rather than guess
    }
    if (!MONITORED_EVENTS.includes(parsed.name)) continue;
    await alert(label, parsed.name, parsed.args, log);
  }
}

async function watchNetwork({ label, rpcUrl, executor }) {
  const provider = makeProvider(rpcUrl);
  const contract = new ethers.Contract(executor, EXECUTOR_ABI, provider);

  await catchUp(label, contract, provider);

  for (const eventName of MONITORED_EVENTS) {
    contract.on(eventName, async (...eventArgs) => {
      const log = eventArgs[eventArgs.length - 1]; // ethers v6: last arg is the ContractEventPayload/log
      const args = eventArgs.slice(0, -1);
      const named = {};
      contract.interface.getEvent(eventName).inputs.forEach((input, i) => {
        named[input.name] = args[i];
      });
      await alert(label, eventName, named, log.log ?? log);
    });
  }

  console.log(`${label}: watching ${executor} for ${MONITORED_EVENTS.length} event type(s)...`);
}

async function main() {
  const targets = parseTargets();
  const telegramEnabled = Boolean(process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID);

  if (targets.length === 0 && !telegramEnabled) {
    console.log('Set MONITOR_TARGETS and/or TELEGRAM_BOT_TOKEN+TELEGRAM_CHAT_ID in .env -- see .env.example.');
    return;
  }

  if (targets.length > 0) {
    await Promise.all(targets.map(watchNetwork));
    console.log('All networks connected. Watching (Ctrl+C to stop)...');
  }
  if (telegramEnabled) {
    // Fire-and-forget: this loop runs forever on its own and never
    // resolves, same as the per-network event listeners above -- not
    // awaited here, so it runs alongside them rather than blocking main()
    // from reaching the keep-alive Promise below.
    pollTelegramCommands();
  }
  // Intentionally never resolves -- the event listeners and/or the
  // Telegram poll loop above are what keep the process alive, same
  // pattern as off-chain-bot's WATCH_MODE.
  return new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
