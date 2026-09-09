const axios = require('axios');
const fs = require('fs');
const path = require('path');

const AUTH_PATH = path.join(__dirname, 'auth.json');
const TOKEN_PATH = path.join(__dirname, 'token.txt');

// Refresh when the cached token has fewer than this many seconds of life left.
const REFRESH_MARGIN_SEC = 300;

function decodeExp(jwt) {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64').toString());
    return payload.exp || 0;
  } catch {
    return 0;
  }
}

function readCachedToken() {
  try {
    return fs.readFileSync(TOKEN_PATH, 'utf8').trim();
  } catch {
    return '';
  }
}

// Calls Firebase secure-token endpoint, writes the fresh id_token to token.txt,
// and persists a rotated refresh_token back to auth.json if Google returns one.
async function refresh() {
  const auth = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  if (!auth.apiKey || !auth.refreshToken) {
    throw new Error('auth.json missing apiKey or refreshToken');
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: auth.refreshToken,
  });

  const res = await axios.post(
    `https://securetoken.googleapis.com/v1/token?key=${auth.apiKey}`,
    body.toString(),
    { headers: { 'content-type': 'application/x-www-form-urlencoded' } }
  );

  const idToken = res.data.id_token;
  fs.writeFileSync(TOKEN_PATH, idToken);

  // Google rotates the refresh token occasionally; persist the new one.
  if (res.data.refresh_token && res.data.refresh_token !== auth.refreshToken) {
    auth.refreshToken = res.data.refresh_token;
    fs.writeFileSync(AUTH_PATH, JSON.stringify(auth, null, 2) + '\n');
  }

  return idToken;
}

// Returns a valid id_token, refreshing only if the cached one is near expiry.
// Pass force=true to refresh unconditionally (e.g. after a 401).
async function getValidToken(force = false) {
  const cached = readCachedToken();
  const now = Math.floor(Date.now() / 1000);

  if (!force && cached && decodeExp(cached) - now > REFRESH_MARGIN_SEC) {
    return cached;
  }
  return refresh();
}

module.exports = { getValidToken, refresh, decodeExp };

// Allow `node auth.js` to force a refresh and print status.
if (require.main === module) {
  refresh()
    .then((tok) => {
      const exp = decodeExp(tok);
      console.log('[OK] token refreshed, exp', new Date(exp * 1000).toISOString());
    })
    .catch((e) =>
      console.log('[ERR]', e.response?.status, JSON.stringify(e.response?.data || e.message))
    );
}
