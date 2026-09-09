const axios = require('axios');
const { v7: uuidv7 } = require('uuid');
const fs = require('fs').promises;
const { getValidToken } = require('./auth');

const colors = {
  reset: "\x1b[0m", cyan: "\x1b[36m", green: "\x1b[32m",
  yellow: "\x1b[33m", red: "\x1b[31m", bold: "\x1b[1m",
};
const log = {
  info: (m) => console.log(`${colors.green}[✓] ${m}${colors.reset}`),
  warn: (m) => console.log(`${colors.yellow}[⚠] ${m}${colors.reset}`),
  error: (m) => console.log(`${colors.red}[✗] ${m}${colors.reset}`),
  step: (m) => console.log(`${colors.cyan}[➤] ${m}${colors.reset}`),
};

const BASE_URL = 'https://craft-world.gg/api/1/user-actions/ingest';
const INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

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
    "x-app-version": "1.15.1",
    "authorization": authToken,
  };
}

function summarize(account) {
  if (!account) return '';
  const earth = account.resources?.find(r => r.symbol === 'EARTH')?.amount ?? 0;
  const refillSec = Math.round((account.powerMillisecondsUntilRefill ?? 0) / 1000);
  return `power=${account.power} | EARTH=${earth.toFixed(2)} | refill in ${refillSec}s`;
}

// Sends a single action; force-refreshes the token and retries once on 401.
async function sendAction(actionType, payload) {
  const run = async (force) => {
    const headers = buildHeaders(await authHeader(force));
    const actionId = uuidv7();
    const body = { data: [{ id: actionId, actionType, payload, time: Date.now() }] };
    const res = await axios.post(BASE_URL, body, { headers });
    return {
      ok: (res.data?.data?.processed || []).includes(actionId),
      account: res.data?.data?.account,
    };
  };
  try {
    return await run(false);
  } catch (err) {
    if (err.response?.status === 401) {
      log.warn('Got 401, forcing token refresh and retrying...');
      return run(true);
    }
    throw err;
  }
}

function errMsg(err) {
  return err.response
    ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data).slice(0, 200)}`
    : err.message;
}

async function readMineId() {
  const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
  if (!cfg.mineId) throw new Error('mineId not set in config.json');
  return cfg.mineId;
}

async function main() {
  console.log(`${colors.cyan}${colors.bold}--- Craft World — MINE loop (dinosaur) ---${colors.reset}`);
  const mineId = await readMineId();
  await authHeader(); // ensure a valid token up front

  log.info(`mineId   = ${mineId}`);
  log.info(`interval = ${INTERVAL_MS / 1000 / 60} min`);

  let cycle = 0;
  while (true) {
    cycle++;
    log.step(`=== CYCLE ${cycle} ===`);

    // 1) Claim whatever the mine produced (harmless if nothing to claim).
    try {
      const { ok, account } = await sendAction('CLAIM_MINE', { mineId });
      if (ok) log.info(`CLAIM_MINE OK — ${summarize(account)}`);
      else log.warn('CLAIM_MINE not processed (maybe nothing to claim yet)');
    } catch (err) {
      log.warn(`CLAIM_MINE skipped: ${errMsg(err)}`);
    }

    // 2) Start the mine again.
    try {
      const { ok, account } = await sendAction('START_MINE', { mineId });
      if (ok) log.info(`START_MINE OK — ${summarize(account)}`);
      else log.error('START_MINE not processed');
    } catch (err) {
      log.error(`START_MINE failed: ${errMsg(err)}`);
    }

    log.info(`Sleeping ${INTERVAL_MS / 1000 / 60} min...`);
    await new Promise(r => setTimeout(r, INTERVAL_MS));
  }
}

process.on('SIGINT', () => { log.warn('Stopped by user'); process.exit(0); });

main().catch(e => { log.error(`Fatal: ${e.message}`); process.exit(1); });
