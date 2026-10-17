// Spotify sign-in using Authorization Code + PKCE with a loopback redirect.
// No client secret is needed. Tokens are encrypted on disk with Electron safeStorage.

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { app, shell, safeStorage } = require('electron');

const REDIRECT_PORT = 8888;
const REDIRECT_URI = `http://127.0.0.1:${REDIRECT_PORT}/callback`;
// The Web Playback SDK requires 'streaming', 'user-read-email' and 'user-read-private'.
// Sweet Spot never reads your email; the SDK just refuses to authenticate without it.
const SCOPE_LIST = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
  'user-read-currently-playing',
  'user-read-recently-played',
  'user-library-read',
  'user-library-modify',
  // Spotify's combined library endpoints also list the follow scopes.
  'user-follow-read',
  'user-follow-modify',
  'playlist-read-private',
  'playlist-read-collaborative',
  'playlist-modify-private',
  'playlist-modify-public'
];
const SCOPES = SCOPE_LIST.join(' ');

const configFile = () => path.join(app.getPath('userData'), 'config.json');
const tokenFile = () => path.join(app.getPath('userData'), 'tokens.bin');

let tokens = null; // { access_token, refresh_token, expires_at, scope }
let refreshing = null;

function readConfig() {
  try { return JSON.parse(fs.readFileSync(configFile(), 'utf8')); } catch { return {}; }
}
function writeConfig(cfg) {
  fs.mkdirSync(path.dirname(configFile()), { recursive: true });
  fs.writeFileSync(configFile(), JSON.stringify(cfg, null, 2));
}
function getClientId() { return readConfig().clientId || ''; }
function setClientId(id) { writeConfig({ ...readConfig(), clientId: String(id).trim() }); }

function saveTokens() {
  if (!tokens) { try { fs.unlinkSync(tokenFile()); } catch {} return; }
  const json = JSON.stringify(tokens);
  const data = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(json) : Buffer.from(json);
  fs.writeFileSync(tokenFile(), data);
}
function loadTokens() {
  try {
    const buf = fs.readFileSync(tokenFile());
    const json = safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString();
    tokens = JSON.parse(json);
  } catch { tokens = null; }
  return !!tokens;
}

// True when the saved sign-in was granted every permission this version needs.
// Older sign-ins (before scopes were recorded, or missing a newly added one) need a fresh sign-in.
function hasAllScopes() {
  if (!tokens || !tokens.scope) return false;
  const granted = new Set(tokens.scope.split(/\s+/));
  return SCOPE_LIST.every((s) => granted.has(s));
}

const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function tokenRequest(params) {
  let res;
  try {
    res = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20000)
    });
  } catch {
    // No connection (e.g. Windows just started and Wi-Fi isn't up yet).
    throw Object.assign(new Error('Can’t reach Spotify'), { offline: true });
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(body.error_description || body.error || `Token request failed (${res.status})`), { status: res.status, code: body.error });
  return body;
}

function storeTokenResponse(t) {
  tokens = {
    access_token: t.access_token,
    refresh_token: t.refresh_token || (tokens && tokens.refresh_token),
    expires_at: Date.now() + (t.expires_in - 60) * 1000,
    scope: t.scope || (tokens && tokens.scope) || ''
  };
  saveTokens();
}

function login() {
  const clientId = getClientId();
  if (!clientId) return Promise.reject(new Error('No Client ID set'));
  const verifier = b64url(crypto.randomBytes(64));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(16));

  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, REDIRECT_URI);
      if (url.pathname !== '/callback') { res.writeHead(404); res.end(); return; }
      const finish = (ok, msg) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body style="font-family:Segoe UI,sans-serif;background:#121212;color:#fff;display:grid;place-items:center;height:100vh;margin:0">
          <div style="text-align:center"><h2>${ok ? 'Signed in to Sweet Spot' : 'Sign-in failed'}</h2><p style="color:#aaa">${msg}</p></div></body></html>`);
        clearTimeout(timer);
        server.close();
      };
      if (url.searchParams.get('state') !== state) { finish(false, 'State mismatch. Try again.'); return reject(new Error('State mismatch')); }
      const err = url.searchParams.get('error');
      if (err) { finish(false, err); return reject(new Error(err)); }
      try {
        const t = await tokenRequest({
          grant_type: 'authorization_code',
          code: url.searchParams.get('code'),
          redirect_uri: REDIRECT_URI,
          client_id: clientId,
          code_verifier: verifier
        });
        storeTokenResponse(t);
        finish(true, 'You can close this tab and go back to the app.');
        resolve();
      } catch (e) { finish(false, e.message); reject(e); }
    });
    const timer = setTimeout(() => { server.close(); reject(new Error('Sign-in timed out')); }, 5 * 60 * 1000);
    server.on('error', (e) => { clearTimeout(timer); reject(new Error(`Could not open port ${REDIRECT_PORT}: ${e.message}`)); });
    server.listen(REDIRECT_PORT, '127.0.0.1', () => {
      const auth = new URL('https://accounts.spotify.com/authorize');
      auth.search = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: REDIRECT_URI,
        code_challenge_method: 'S256',
        code_challenge: challenge,
        scope: SCOPES,
        state
      });
      shell.openExternal(auth.toString());
    });
  });
}

async function getAccessToken() {
  if (!tokens) return null;
  if (Date.now() < tokens.expires_at) return tokens.access_token;
  if (!refreshing) {
    refreshing = tokenRequest({
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
      client_id: getClientId()
    }).then(storeTokenResponse).finally(() => { refreshing = null; });
  }
  try { await refreshing; return tokens.access_token; }
  catch (e) {
    // Only forget the sign-in when Spotify actually rejects it (revoked, or a changed
    // Client ID). No internet, a timeout or a Spotify hiccup keeps it for next time.
    const rejected = e.status === 400 || e.status === 401 || /invalid_grant|invalid_client/.test(e.code || '');
    if (!rejected) throw Object.assign(new Error('OFFLINE'), { offline: true });
    tokens = null; saveTokens(); return null;
  }
}

function logout() { tokens = null; saveTokens(); }

module.exports = { REDIRECT_URI, getClientId, setClientId, loadTokens, hasAllScopes, login, logout, getAccessToken };
