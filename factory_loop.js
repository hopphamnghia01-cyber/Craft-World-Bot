const axios = require('axios');
const { v7: uuidv7 } = require('uuid');
const fs = require('fs').promises;
const { getValidToken } = require('./auth');
const { notify, notifyNow } = require('./notify');

const colors = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", gray: "\x1b[90m", bold: "\x1b[1m",
};
const ts = () => new Date().toLocaleTimeString();
const log = {
  info: (t, m) => console.log(`${colors.gray}${ts()}${colors.reset} ${colors.green}[✓][${t}] ${m}${colors.reset}`),
  warn: (t, m) => console.log(`${colors.gray}${ts()}${colors.reset} ${colors.yellow}[⚠][${t}] ${m}${colors.reset}`),
  error: (t, m) => console.log(`${colors.gray}${ts()}${colors.reset} ${colors.red}[✗][${t}] ${m}${colors.reset}`),
  step: (t, m) => console.log(`${colors.gray}${ts()}${colors.reset} ${colors.cyan}[➤][${t}] ${m}${colors.reset}`),
};

const BASE_URL = 'https://craft-world.gg/api/1/user-actions/ingest';
// Boosts live on two endpoints separate from the action-ingest one:
//   GRAPHQL_URL  — SkipAdWatch arms boostedNextRun on ONE mine (per-run, x2).
//   BOOSTER_URL  — refreshes the account-wide land-plot boost (boostValue 0.5,
//                  i.e. production times halved). endTime = startTime + 24h,
//                  capped by the server at 12h ahead of now.
const GRAPHQL_URL = 'https://craft-world.gg/graphql';
const BOOSTER_URL = 'https://craft-world.gg/api/2/land-plots/boosters';
// Boost settings come from config.json -> boost (loaded in main()). `vip` reflects
// whether the account owns the skip-ads pack: with it, the x2 buttons cost nothing
// but a click, so the bot presses them for you. Without it, every boost call would
// demand a real ad view, so the bot skips both systems entirely — and the durations
// in config must then be the un-boosted ones (see durationsNoVip).
let BOOST_VIP = false;
let MINE_AD_PLACEMENT = 'EARTH';
let BOOSTER_EVERY_SEC = 4 * 3600;
const CONFIG_PATH = 'config.json';

// Supply-chain order. Earth feeds mud feeds clay feeds sand feeds copper.
const CHAIN = ['earthMine', 'mud', 'clay', 'sand', 'copper', 'steel'];

// x-app-version the game enforces. The server bumps its minimum whenever the
// game updates, rejecting old clients with HTTP 400 OUTDATED_VERSION. We keep
// the current version in mutable state so a single auto-bump (see maybeBumpVersion)
// instantly applies to every subsequent request — no restart, no manual edit.
let APP_VERSION = '1.15.1'; // overwritten from config.json at startup

// Reads the saved version from config.json (falls back to the constant above).
async function loadAppVersion() {
  try {
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    if (cfg.appVersion) APP_VERSION = cfg.appVersion;
  } catch { /* keep default */ }
}

// Persists the new version back into config.json so a restart keeps it (the VM's
// systemd unit just re-runs this file). Best-effort: a write failure is logged
// but never blocks the bot — the in-memory APP_VERSION is what requests use.
async function saveAppVersion(v) {
  try {
    const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
    cfg.appVersion = v;
    await fs.writeFile(CONFIG_PATH, JSON.stringify(cfg, null, 2) + '\n');
  } catch (err) {
    log.warn('version', `could not persist appVersion to config.json: ${err.message}`);
  }
}

// Pulls the required minimum version out of an OUTDATED_VERSION error body, or
// null if this error isn't a version problem.
function parseMinVersion(err) {
  const data = err.response?.data;
  if (!data) return null;
  if (typeof data === 'object' && data.minAppVersion) return String(data.minAppVersion);
  const body = typeof data === 'string' ? data : JSON.stringify(data);
  const m = body.match(/"minAppVersion"\s*:\s*"([^"]+)"/);
  return m ? m[1] : null;
}

// If `err` is an OUTDATED_VERSION rejection, bump APP_VERSION to the server's
// required minimum (idempotent — re-bumping to the same value is a no-op), save
// it, alert Telegram once, and return true so the caller retries the request
// with the new version. Returns false for any non-version error.
async function maybeBumpVersion(err) {
  const min = parseMinVersion(err);
  if (!min || min === APP_VERSION) return false;
  const old = APP_VERSION;
  APP_VERSION = min; // applies to every subsequent buildHeaders() immediately
  log.info('version', `auto-updated x-app-version ${old} → ${min}`);
  await saveAppVersion(min);
  await notifyNow(`🔄 Auto-updated app version ${old} → ${min} (game updated).`);
  return true;
}

async function authHeader(force = false) {
  const token = await getValidToken(force);
  return token.startsWith('Bearer jwt_') ? token : `Bearer jwt_${token}`;
}

function buildHeaders(authToken) {
  return {
    "accept": "*/*",
    "content-type": "application/json",
    "origin": "https://craft-world.gg",
    "referer": "https://craft-world.gg/",
    "user-agent": "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36",
    "x-app-version": APP_VERSION,
    "authorization": authToken,
  };
}

// The server logs actions per-account and rejects any whose timestamp is not
// strictly after the previous one. Because 5 type-timers run concurrently, we
// funnel every request through a single promise chain (global mutex) and stamp
// each with a monotonically increasing time, so no two ever collide.
let _queue = Promise.resolve();
let _lastTime = 0;

function enqueue(fn) {
  const run = _queue.then(fn, fn);
  // Keep the chain alive regardless of individual failures.
  _queue = run.then(() => {}, () => {});
  return run;
}

// Sends one action; on 401 force-refreshes the token and retries once.
function sendAction(actionType, payload) {
  return enqueue(async () => {
    const run = async (force) => {
      const headers = buildHeaders(await authHeader(force));
      const actionId = uuidv7();
      const time = Math.max(Date.now(), _lastTime + 1); // strictly increasing
      _lastTime = time;
      const body = { data: [{ id: actionId, actionType, payload, time }] };
      const res = await axios.post(BASE_URL, body, { headers });
      return {
        ok: (res.data?.data?.processed || []).includes(actionId),
        account: res.data?.data?.account,
      };
    };
    try {
      return await run(false);
    } catch (err) {
      // Game version bumped: auto-update APP_VERSION, then retry once with it.
      if (err.response?.status === 400 && await maybeBumpVersion(err)) {
        return run(false);
      }
      if (err.response?.status === 401) {
        return run(true);
      }
      throw err;
    }
  });
}

function errMsg(err) {
  return err.response
    ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data).slice(0, 160)}`
    : err.message;
}

// Distinguish *real* problems from the benign game states that happen during
// normal operation. Critical = token dead, game version bumped, or a network
// failure (no HTTP response). Everything with a 500 + a known benign phrase
// (is not idle / still running / not enough balance / nothing to claim) is
// expected and only worth a soft alert.
const BENIGN_RE = /is not idle|still running|not enough balance|nothing to claim/i;
function isCritical(err) {
  if (!err.response) return true;                 // network/timeout, no response
  const status = err.response.status;
  if (status === 401) return true;                // token rejected/expired
  const body = JSON.stringify(err.response.data || '');
  if (/OUTDATED_VERSION|minAppVersion/i.test(body)) return true; // game updated
  if (BENIGN_RE.test(body)) return false;         // known harmless state
  return status >= 500;                            // other server errors
}

function summarize(account) {
  if (!account) return '';
  const earth = account.resources?.find(r => r.symbol === 'EARTH')?.amount ?? 0;
  return `power=${account.power} | EARTH=${earth.toFixed(0)}`;
}

// Returns duration in ms with a fixed +20..60s random jitter added.
function jitteredMs(baseSec) {
  const jitterSec = 20 + Math.random() * 40; // +20s..+60s
  return Math.round((baseSec + jitterSec) * 1000);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// Human-readable "next in" duration: minutes under an hour, hours+minutes over.
function fmtEta(ms) {
  const totalMin = ms / 60000;
  if (totalMin < 60) return `~${totalMin.toFixed(1)} min`;
  const h = Math.floor(totalMin / 60);
  const m = Math.round(totalMin % 60);
  return `~${h}h ${m}m`;
}

// Both boost calls go through the same mutex as game actions so nothing races
// the strictly-increasing timestamp the ingest endpoint enforces.

// Arm the next run of one mine at x2. Mirrors the game's "▶x2" button.
function armMineBoost(mineId) {
  return enqueue(async () => {
    const res = await axios.post(GRAPHQL_URL, {
      query: `mutation SkipAdWatch($input: SkipAdWatchInput!) {
        skipAdWatch(input: $input) { success adWatchCount { adPlacement count resetsAt } } }`,
      variables: { input: { adPlacement: MINE_AD_PLACEMENT, customData: mineId } },
    }, { headers: buildHeaders(await authHeader()) });
    // GraphQL reports failures in the body with HTTP 200, not as a status code.
    const err = res.data?.errors?.[0]?.message;
    if (err) throw new Error(err);
    return res.data?.data?.skipAdWatch;
  });
}

// Top the account-wide land-plot boost back up. The server clamps endTime to
// 12h ahead, so calling this more often than needed is harmless.
function refreshGlobalBoost() {
  return enqueue(async () => {
    const res = await axios.post(BOOSTER_URL, { startTime: Date.now() },
      { headers: buildHeaders(await authHeader()) });
    return res.data?.data?.boosters || [];
  });
}

// Cross-paired, staggered supply chain. Each loop CLAIMS its UPSTREAM tier's
// output (= the raw material this tier consumes), then STARTS its own factories:
//   earth : (no claim) -> START_MINE earth
//   mud   : CLAIM_MINE earth        -> START_FACTORY mud
//   clay  : CLAIM_AREA mud area     -> START_FACTORY clay
//   sand  : CLAIM_AREA clay area    -> START_FACTORY sand
//   copper: CLAIM_AREA sand area    -> START_FACTORY copper
// Loops stay independent (own timer/duration); only the claim target shifts to
// the tier above. The server rejects out-of-order timestamps, so a global mutex
// (sendAction) serializes everything and a small gap keeps requests spaced.
const GAP_MS = 250;

// CLAIM_AREA needs the amount of pending output to harvest. The game sends the
// exact pending count (e.g. 371); the server caps any larger value to "claim
// all", so we send a number bigger than any area could hold to always drain it.
// (CLAIM_MINE needs no such field — it always claims everything.)
const CLAIM_ALL = 1_000_000_000;

// upstream: { kind: 'mine'|'area', id } — what THIS tier claims before starting.
async function claimUpstream(type, upstream) {
  if (!upstream) return; // earth has no upstream
  if (upstream.kind === 'mine') {
    try {
      const { ok, account } = await sendAction('CLAIM_MINE', { mineId: upstream.id });
      if (ok) log.info(type, `CLAIM_MINE(earth) ${upstream.id.slice(0, 8)} OK — ${summarize(account)}`);
      else log.warn(type, `CLAIM_MINE(earth) not processed`);
    } catch (err) {
      log.warn(type, `CLAIM_MINE(earth): ${errMsg(err)}`);
      if (isCritical(err)) notify('crit', type, `CLAIM_MINE(earth): ${errMsg(err)}`);
    }
  } else {
    try {
      const { ok } = await sendAction('CLAIM_AREA', { areaId: upstream.id, amountToClaim: CLAIM_ALL });
      if (ok) log.info(type, `CLAIM_AREA(${upstream.name}) ${upstream.id.slice(0, 8)} OK`);
      else log.warn(type, `CLAIM_AREA(${upstream.name}) not processed`);
    } catch (err) {
      // "Nothing to claim" is normal when upstream hasn't accrued output yet.
      log.warn(type, `CLAIM_AREA(${upstream.name}): ${errMsg(err)}`);
      if (isCritical(err)) notify('crit', type, `CLAIM_AREA(${upstream.name}): ${errMsg(err)}`);
    }
  }
  await sleep(GAP_MS);
}

// One tick for a tier: claim upstream material, then (re)start this tier's units.
async function runType(type, ids, upstream) {
  await claimUpstream(type, upstream);

  // earth uses the MINE start verb; all others are factories.
  const isMine = type === 'earthMine';
  for (const id of ids) {
    try {
      if (isMine) {
        // Arm x2 first — the flag is consumed by the START_MINE that follows.
        // Out of daily quota is expected and must not block the start.
        if (BOOST_VIP) {
          try {
            const r = await armMineBoost(id);
            log.info(type, `boost armed x2 (used ${r?.adWatchCount?.count ?? '?'} today)`);
          } catch (e) {
            log.warn(type, `boost not armed: ${e.message.slice(0, 120)}`);
          }
          await sleep(GAP_MS);
        }
        const { ok } = await sendAction('START_MINE', { mineId: id });
        if (ok) log.info(type, `START_MINE ${id.slice(0, 8)} OK`);
        else { log.error(type, `START_MINE ${id.slice(0, 8)} not processed`); notify('crit', type, `START_MINE ${id.slice(0, 8)} not processed`); }
      } else {
        const { ok } = await sendAction('START_FACTORY', { factoryId: id });
        if (ok) log.info(type, `START_FACTORY ${id.slice(0, 8)} OK`);
        else { log.error(type, `START_FACTORY ${id.slice(0, 8)} not processed`); notify('crit', type, `START_FACTORY ${id.slice(0, 8)} not processed`); }
      }
    } catch (err) {
      // "is not idle" / "still running" / "Not enough balance" are all expected
      // states in normal operation, not bugs. Per user, alert on every START
      // failure anyway — critical ones get 🔴, benign ones get ⚠️.
      log.warn(type, `START ${id.slice(0, 8)}: ${errMsg(err)}`);
      notify(isCritical(err) ? 'crit' : 'error', type, `START ${id.slice(0, 8)}: ${errMsg(err)}`);
    }
    await sleep(GAP_MS);
  }
}

// Independent self-rescheduling timer for the account-wide boost.
function startBoosterTimer() {
  const tick = async () => {
    try {
      const b = await refreshGlobalBoost();
      const end = b[0]?.endTime;
      const left = end ? ((new Date(end) - Date.now()) / 3600000).toFixed(1) + 'h' : '?';
      log.info('boost', `global boost refreshed — ${b.length} plot, ends in ${left}`);
    } catch (err) {
      log.warn('boost', `refresh failed: ${errMsg(err)}`);
      if (isCritical(err)) notify('crit', 'boost', `refresh failed: ${errMsg(err)}`);
    }
    setTimeout(tick, BOOSTER_EVERY_SEC * 1000);
  };
  tick(); // run once at startup so the boost is full from the first tier tick
}

// Read boost settings from config; without VIP both boost systems stay off.
function loadBoostConfig(cfg) {
  const b = cfg.boost || {};
  BOOST_VIP = b.vip === true;
  MINE_AD_PLACEMENT = b.mineAdPlacement || 'EARTH';
  BOOSTER_EVERY_SEC = b.globalBoostEverySec || 4 * 3600;
}

// Independent self-rescheduling timer for one tier.
function startTypeTimer(type, ids, upstream, baseSec) {
  const tick = async () => {
    log.step(type, `=== tick (${ids.length} unit) ===`);
    try {
      await runType(type, ids, upstream);
    } catch (err) {
      log.error(type, `tick failed: ${errMsg(err)}`);
      notify('crit', type, `tick failed: ${errMsg(err)}`);
    }
    const ms = jitteredMs(baseSec);
    log.info(type, `next in ${(ms / 1000).toFixed(0)}s (${fmtEta(ms)})`);
    setTimeout(tick, ms);
  };
  // Stagger first ticks so the chain warms up earth -> mud -> ... in order.
  const initialDelay = CHAIN.indexOf(type) * 3000;
  setTimeout(tick, initialDelay);
}

async function main() {
  console.log(`${colors.cyan}${colors.bold}--- Craft World — FACTORY supply-chain loop ---${colors.reset}`);
  const cfg = JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
  await loadAppVersion();
  log.info('version', `x-app-version = ${APP_VERSION}`);
  try {
    await authHeader(); // ensure a valid token up front
  } catch (err) {
    notify('crit', 'auth', `Startup token refresh failed: ${errMsg(err)}`);
    throw err;
  }
  notifyNow('✅ Bot started (factory loop online).');

  // Resolve the upstream claim target for a tier: the tier directly above it in
  // CHAIN. earth (index 0) has none; mud claims earth via the MINE verb; the
  // rest claim the upstream tier's AREA.
  function upstreamFor(type) {
    const idx = CHAIN.indexOf(type);
    if (idx <= 0) return null; // earth: nothing to claim
    const up = CHAIN[idx - 1];
    if (up === 'earthMine') {
      const mineId = cfg.factories.earthMine?.[0];
      return mineId ? { kind: 'mine', id: mineId, name: 'earth' } : null;
    }
    const areaId = cfg.areas?.[up];
    return areaId ? { kind: 'area', id: areaId, name: up } : null;
  }

  loadBoostConfig(cfg);
  if (BOOST_VIP) {
    log.info('boost', `VIP on — mine x2 before each START_MINE, global boost every ${BOOSTER_EVERY_SEC / 3600}h`);
    startBoosterTimer();
  } else {
    log.warn('boost', 'VIP off — no boost calls; durations must be the un-boosted ones');
  }

  for (const type of CHAIN) {
    const ids = cfg.factories[type] || [];
    const baseSec = cfg.durations?.[type];
    if (!ids.length || !baseSec) {
      log.warn(type, 'skipped (no ids or no duration)');
      continue;
    }
    const upstream = upstreamFor(type);
    const claimDesc = upstream
      ? `claims ${upstream.kind === 'mine' ? 'MINE earth' : 'area ' + upstream.name}`
      : 'no claim';
    log.info(type, `armed — ${ids.length} unit, base ${baseSec}s, ${claimDesc}`);
    startTypeTimer(type, ids, upstream, baseSec);
  }
}

process.on('SIGINT', () => { console.log(`\n${colors.yellow}[⚠] Stopped by user${colors.reset}`); process.exit(0); });

main().catch(async e => {
  console.log(`${colors.red}[✗] Fatal: ${e.message}${colors.reset}`);
  await notifyNow(`🔴 FATAL — bot crashed: ${e.message}`);
  process.exit(1);
});
