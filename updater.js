// Updates from GitHub Releases.
// Uses electron-updater when the release has its update file (latest.yml), which
// downloads the new installer and installs it on restart. If that isn't available
// (running from source, or a release without latest.yml), it falls back to asking
// GitHub for the latest release and offering to open its download page.

const { app, shell } = require('electron');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* not installed: fallback only */ }

const REPO = 'zombifiedturkey/Sweet-Spot';
let state = { state: 'idle' };
let send = () => {};
let beforeInstall = () => {};

function emit(s) {
  state = { ...s, current: app.getVersion() };
  send(state);
}

// "1.10.0" > "1.9.2"; ignores anything after a "-" or "+".
function newer(a, b) {
  const p = (v) => String(v).replace(/^v/, '').split(/[-+]/)[0].split('.').map((n) => parseInt(n, 10) || 0);
  const [x, y] = [p(a), p(b)];
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
}

// Release notes arrive as Markdown or HTML; keep a few plain lines for the prompt.
function plainNotes(notes) {
  const text = Array.isArray(notes) ? notes.map((n) => n.note || '').join('\n') : String(notes || '');
  return text.replace(/<[^>]+>/g, '\n').replace(/[#*_`>]/g, '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 4).join('\n');
}

async function githubLatest() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'SweetSpot' }
  });
  if (res.status === 404) return null; // no releases yet
  if (!res.ok) throw new Error(`GitHub said ${res.status}`);
  const r = await res.json();
  return { version: String(r.tag_name || '').replace(/^v/, ''), notes: plainNotes(r.body), url: r.html_url };
}

const useUpdater = () => autoUpdater && app.isPackaged;

let initialised = false;
function init({ onStatus, onBeforeInstall }) {
  send = onStatus;
  beforeInstall = onBeforeInstall;
  if (initialised || !useUpdater()) return;
  initialised = true;
  autoUpdater.autoDownload = false;          // ask first
  autoUpdater.autoInstallOnAppQuit = true;   // "Later" installs when you next quit
  autoUpdater.on('error', (e) => { if (state.state === 'downloading') emit({ state: 'error', message: e.message }); });
  autoUpdater.on('download-progress', (p) => emit({ ...state, state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => emit({ state: 'ready', version: i.version }));
}

async function check({ manual = false } = {}) {
  if (['downloading', 'ready'].includes(state.state)) { send(state); return state; }
  emit({ state: 'checking', manual });
  if (useUpdater()) {
    try {
      const r = await autoUpdater.checkForUpdates();
      const info = r && r.updateInfo;
      if (info && newer(info.version, app.getVersion())) {
        emit({ state: 'available', version: info.version, notes: plainNotes(info.releaseNotes), canInstall: true, manual });
      } else emit({ state: 'none', manual });
      return state;
    } catch { /* e.g. the release has no latest.yml: try the simple check */ }
  }
  try {
    const r = await githubLatest();
    if (r && r.version && newer(r.version, app.getVersion())) {
      emit({ state: 'available', version: r.version, notes: r.notes, url: r.url, canInstall: false, manual });
    } else emit({ state: 'none', manual });
  } catch (e) {
    emit({ state: 'error', message: `Couldn’t check for updates (${e.message}).`, manual });
  }
  return state;
}

async function download() {
  if (state.state !== 'available') return;
  if (!state.canInstall) { shell.openExternal(state.url || `https://github.com/${REPO}/releases/latest`); return; }
  emit({ ...state, state: 'downloading', percent: 0 });
  try { await autoUpdater.downloadUpdate(); }
  catch (e) { emit({ state: 'error', message: `Download failed: ${e.message}` }); }
}

function install() {
  if (state.state !== 'ready') return;
  beforeInstall();
  setImmediate(() => autoUpdater.quitAndInstall(true, true)); // quiet install, then reopen
}

module.exports = { init, check, download, install, getState: () => state, _test: { newer, plainNotes } };
