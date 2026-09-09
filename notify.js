// Telegram alert notifier for the factory bot.
//
// Reads credentials from config.json -> { "telegram": { "botToken": "...",
// "chatId": "..." } }. If either is missing, notifications are silently
// disabled so the bot keeps running unchanged.
//
// Anti-spam: many "errors" in this bot are normal (is not idle / not enough
// balance / nothing to claim). To avoid flooding Telegram we (1) batch all
// alerts inside a short window into ONE message, and (2) drop a duplicate
// message body if it was already sent within DEDUPE_MS.

const https = require('https');
const fs = require('fs');

let BOT_TOKEN = '';
let CHAT_ID = '';
try {
  const cfg = JSON.parse(fs.readFileSync(__dirname + '/config.json', 'utf8'));
  BOT_TOKEN = cfg.telegram?.botToken || '';
  CHAT_ID = cfg.telegram?.chatId || '';
} catch (_) { /* config unreadable -> notifier stays disabled */ }

const ENABLED = Boolean(BOT_TOKEN && CHAT_ID);

const BATCH_MS = 5000;        // collect alerts for 5s, then send one message
const DEDUPE_MS = 10 * 60000; // don't resend the same line within 10 min

let _pending = [];            // lines waiting to be flushed
let _flushTimer = null;
const _lastSent = new Map();  // line -> timestamp it was last sent

// Low-level: POST to the Telegram sendMessage API. Best-effort; never throws.
function sendRaw(text) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      chat_id: CHAT_ID,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });
    const req = https.request(
      {
        hostname: 'api.telegram.org',
        path: `/bot${BOT_TOKEN}/sendMessage`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
        timeout: 10000,
      },
      (res) => { res.on('data', () => {}); res.on('end', resolve); }
    );
    req.on('error', () => resolve());   // swallow network errors
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

function flush() {
  _flushTimer = null;
  if (!_pending.length) return;
  const lines = _pending;
  _pending = [];
  const host = require('os').hostname();
  const text = `<b>🤖 Craft bot — ${host}</b>\n` + lines.join('\n');
  sendRaw(text);
}

// Queue one alert line. `level` is 'crit' | 'error' for the emoji prefix.
// Returns immediately; actual send is batched.
function notify(level, tag, message) {
  if (!ENABLED) return;
  const line = `${level === 'crit' ? '🔴' : '⚠️'} <b>[${tag}]</b> ${escapeHtml(message)}`;

  const now = Date.now();
  const last = _lastSent.get(line);
  if (last && now - last < DEDUPE_MS) return; // recently sent, skip
  _lastSent.set(line, now);

  // prune old dedupe entries so the map doesn't grow forever
  if (_lastSent.size > 200) {
    for (const [k, t] of _lastSent) if (now - t > DEDUPE_MS) _lastSent.delete(k);
  }

  _pending.push(line);
  if (!_flushTimer) _flushTimer = setTimeout(flush, BATCH_MS);
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Send a message immediately, bypassing batching/dedupe (for startup/shutdown).
function notifyNow(text) {
  if (!ENABLED) return Promise.resolve();
  return sendRaw(`<b>🤖 Craft bot — ${require('os').hostname()}</b>\n${escapeHtml(text)}`);
}

module.exports = { notify, notifyNow, ENABLED };
