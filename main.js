// Sweet Spot — main process.
// Owns the desktop window, the tray icon, the drop-down flyout and the
// track-change toast, and relays player state/commands between them. Audio
// plays inside the main window via Spotify's Web Playback SDK (needs the
// castlabs Widevine build of Electron).

const os = require('os');
const path = require('path');
const electron = require('electron');
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, nativeImage, globalShortcut, shell } = electron;

// The app used to be called Trayplay. Bring its sign-in, settings and caches across on
// first run so nothing needs setting up again. Runs before the modules below read them.
(function migrateFromTrayplay() {
  const fs = require('fs');
  try {
    const dest = app.getPath('userData');
    const src = ['Trayplay', 'trayplay'].map((n) => path.join(app.getPath('appData'), n)).find((d) => fs.existsSync(d));
    if (!src || path.resolve(src) === path.resolve(dest) || fs.existsSync(path.join(dest, 'settings.json'))) return;
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ['config.json', 'tokens.bin', 'settings.json', 'lb-token.bin', 'artist-info.json', 'spotify-matches.json']) {
      try { fs.copyFileSync(path.join(src, f), path.join(dest, f)); } catch {}
    }
  } catch {}
})();

const auth = require('./auth');
const settings = require('./settings');
const artistInfo = require('./artistinfo');
const discover = require('./discover');
const updater = require('./updater');

// Visual sizes of the floating panels (excluding any shadow margin).
const FLYOUT_W = 348;
const FLYOUT_H = 600;
const TOAST_W = 340;
const TOAST_H = 84;
const MINI_SIZES = { compact: { w: 400, h: 98 }, square: { w: 280, h: 280 } };
const GAP = 8;          // distance between taskbar and panel
const SHADOW_M = 36;    // transparent margin that leaves room for the CSS shadow (keep in sync with panel.css)

let mainWin = null;
let flyout = null;
let toast = null;
let mini = null;
let miniDragStart = null;
let tray = null;
let lastState = null;
let lastTrackId = null;
let flyoutHiddenAt = 0;
let toastTimer = null;
let quitting = false;

const launchedHidden = process.argv.includes('--hidden');

// Let the Web Playback SDK start audio without a click, and present as plain Chrome.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.userAgentFallback = app.userAgentFallback
  .replace(/\sElectron\/\S+/, '')
  .replace(new RegExp(`\\s${app.getName()}\\/\\S+`, 'i'), '');

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', showMain);
}

const asset = (f) => path.join(__dirname, 'assets', f);
const preload = path.join(__dirname, 'preload.js');

// ---------- Main window ----------
function createMainWindow() {
  mainWin = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 820,
    minHeight: 560,
    title: 'Sweet Spot',
    icon: asset('icon.png'),
    backgroundColor: '#121212',
    autoHideMenuBar: false,
    // Frameless so the glass reaches the edges; Sweet Spot draws its own title bar
    // and window buttons. Windows 11 still rounds the corners and adds the shadow.
    frame: false,
    roundedCorners: true,
    show: false,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false // keep the player alive while hidden in the tray
    }
  });
  mainWin.setMenuBarVisibility(false);
  const sendMax = () => mainWin.webContents.send('window:maximized', mainWin.isMaximized());
  mainWin.on('maximize', sendMax);
  mainWin.on('unmaximize', sendMax);
  mainWin.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWin.once('ready-to-show', () => {
    if (!(launchedHidden || settings.load().startMinimised)) mainWin.show();
  });

  // Minimise → disappear into the tray.
  mainWin.on('minimize', (e) => {
    e.preventDefault();
    mainWin.hide();
  });
  // Close → tray too, if that's what the user picked.
  mainWin.on('close', (e) => {
    if (!quitting && settings.load().closeToTray) {
      e.preventDefault();
      mainWin.hide();
    }
  });
  mainWin.on('closed', () => { mainWin = null; quitting = true; app.quit(); });

  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });

  // Mouse back/forward buttons (Windows sends these as app commands).
  mainWin.on('app-command', (_e, command) => {
    if (command === 'browser-backward') mainWin.webContents.send('navigate', { history: 'back' });
    if (command === 'browser-forward') mainWin.webContents.send('navigate', { history: 'forward' });
  });
}

// Hidden menu: keeps DevTools and reload available for tinkering, without
// Electron's default shortcuts (Ctrl+R reload, Ctrl+W close…) getting in the way.
function setAppMenu() {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: 'Developer',
    submenu: [
      { role: 'toggleDevTools', accelerator: 'Ctrl+Shift+I' },
      { role: 'forceReload', accelerator: 'Ctrl+Shift+R' },
      { role: 'resetZoom', accelerator: 'Ctrl+0' },
      { role: 'zoomIn', accelerator: 'Ctrl+=' },
      { role: 'zoomOut', accelerator: 'Ctrl+-' }
    ]
  }]));
}

// ---------- Floating panels (flyout + toast) ----------
function supportsAcrylic() {
  if (process.platform !== 'win32') return false;
  const build = Number((os.release().split('.')[2]) || 0);
  return build >= 22621; // Windows 11 22H2+
}

function effectiveStyle() {
  const s = settings.load().flyoutStyle;
  return s === 'acrylic' && !supportsAcrylic() ? 'glass' : s;
}

// Acrylic uses Windows' own blur, rounded corners and shadow.
// Glass/solid use a transparent window with a CSS shadow inside a margin.
function createPanel(file, w, h, { focusable = true, movable = false } = {}) {
  const native = effectiveStyle() === 'acrylic';
  const m = native ? 0 : SHADOW_M;
  const win = new BrowserWindow({
    width: w + 2 * m,
    height: h + 2 * m,
    show: false,
    frame: false,
    // Acrylic windows keep a thick frame (for the native shadow) but are size-locked.
    resizable: native,
    minWidth: w + 2 * m, maxWidth: w + 2 * m,
    minHeight: h + 2 * m, maxHeight: h + 2 * m,
    movable,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    focusable,
    ...(native
      ? { backgroundMaterial: 'acrylic', roundedCorners: true }
      : { transparent: true, backgroundColor: '#00000000', hasShadow: false }),
    webPreferences: { preload, contextIsolation: true, nodeIntegration: false }
  });
  win._margin = m;
  win._visual = { w, h };
  // Clicks on the empty shadow margin fall through to whatever is behind it.
  if (!native) win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(__dirname, 'src', file), { query: { mode: native ? 'native' : 'css' } });
  win.setAlwaysOnTop(true, 'pop-up-menu');
  return win;
}

function createFlyout() {
  flyout = createPanel('flyout.html', FLYOUT_W, FLYOUT_H);
  flyout.on('blur', hideFlyout);
}

function createToast() {
  toast = createPanel('toast.html', TOAST_W, TOAST_H, { focusable: false });
}

function rebuildPanels() {
  const wasOpen = flyout && flyout.isVisible();
  const miniWasOpen = mini && mini.isVisible();
  if (flyout) flyout.destroy();
  if (toast) toast.destroy();
  if (mini) { mini.destroy(); mini = null; }
  createFlyout();
  createToast();
  if (wasOpen) flyout.once('ready-to-show', toggleFlyout);
  if (miniWasOpen) toggleMini(true);
}

// ---------- Mini-player ----------
function miniSize() { return MINI_SIZES[settings.load().miniLayout] || MINI_SIZES.compact; }

function createMini() {
  const { w, h } = miniSize();
  mini = createPanel('mini.html', w, h, { movable: true });
  mini.setAlwaysOnTop(true, 'floating');
  mini.on('closed', () => { mini = null; });
}

// Keep the visible panel fully on a screen; default to the top-right corner.
function placeMini() {
  const { w, h } = miniSize();
  const m = mini._margin;
  const saved = settings.load().miniPos;
  let x, y;
  if (saved) {
    const d = screen.getDisplayMatching({ x: saved.x, y: saved.y, width: w, height: h });
    const wa = d.workArea;
    x = Math.max(wa.x, Math.min(saved.x, wa.x + wa.width - w));
    y = Math.max(wa.y, Math.min(saved.y, wa.y + wa.height - h));
  } else {
    const wa = screen.getPrimaryDisplay().workArea;
    x = wa.x + wa.width - w - 24;
    y = wa.y + 24;
  }
  mini.setBounds({ x: Math.round(x - m), y: Math.round(y - m), width: w + 2 * m, height: h + 2 * m });
}

function resizeMini() {
  if (!mini) return;
  const { w, h } = miniSize();
  const m = mini._margin;
  mini._visual = { w, h };
  const full = { width: w + 2 * m, height: h + 2 * m };
  mini.setMinimumSize(full.width, full.height);
  mini.setMaximumSize(full.width, full.height);
  placeMini();
}

function toggleMini(force) {
  const show = typeof force === 'boolean' ? force : !(mini && mini.isVisible());
  if (show) {
    if (!mini) createMini();
    placeMini();
    hideFlyout();
    hideToast();
    const reveal = () => { mini.showInactive(); mini.webContents.send('flyout:shown'); };
    if (mini.webContents.isLoading()) mini.webContents.once('did-finish-load', reveal); else reveal();
  } else if (mini) {
    mini.hide();
  }
  settings.save({ miniOpen: show });
}

// Work out which edge the taskbar is on, then place a panel beside the tray icon.
function taskbarEdge(display, pt) {
  const b = display.bounds;
  const wa = display.workArea;
  if (wa.y > b.y) return 'top';
  if (wa.y + wa.height < b.y + b.height) return 'bottom';
  if (wa.x > b.x) return 'left';
  if (wa.x + wa.width < b.x + b.width) return 'right';
  // Auto-hide taskbar: guess from where the tray icon sits.
  const d = { top: pt.y - b.y, bottom: b.y + b.height - pt.y, left: pt.x - b.x, right: b.x + b.width - pt.x };
  return Object.keys(d).reduce((a, k) => (d[k] < d[a] ? k : a), 'top');
}

function positionPanel(win) {
  const tb = tray.getBounds();
  const pt = tb && tb.width
    ? { x: Math.round(tb.x + tb.width / 2), y: Math.round(tb.y + tb.height / 2) }
    : screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(pt);
  const wa = display.workArea;
  const edge = taskbarEdge(display, pt);
  const { w, h } = win._visual;
  const m = win._margin;

  let x, y;
  switch (edge) {
    case 'top':    x = pt.x - w / 2; y = wa.y + GAP; break;
    case 'bottom': x = pt.x - w / 2; y = wa.y + wa.height - h - GAP; break;
    case 'left':   x = wa.x + GAP; y = pt.y - h / 2; break;
    default:       x = wa.x + wa.width - w - GAP; y = pt.y - h / 2; break;
  }
  x = Math.max(wa.x + GAP, Math.min(x, wa.x + wa.width - w - GAP));
  y = Math.max(wa.y + GAP, Math.min(y, wa.y + wa.height - h - GAP));
  win.setBounds({ x: Math.round(x - m), y: Math.round(y - m), width: w + 2 * m, height: h + 2 * m });
  win.webContents.send('panel:edge', edge);
  return edge;
}

function hideFlyout() {
  if (flyout && flyout.isVisible()) {
    flyout.hide();
    flyoutHiddenAt = Date.now();
  }
}

function toggleFlyout() {
  if (!flyout) return;
  if (flyout.isVisible()) { hideFlyout(); return; }
  // The click that closed it via blur shouldn't immediately reopen it.
  if (Date.now() - flyoutHiddenAt < 250) return;
  hideToast();
  positionPanel(flyout);
  flyout.show();
  flyout.focus();
  flyout.webContents.send('flyout:shown');
}

function showToast(state) {
  if (!toast || (flyout && flyout.isVisible()) || (mini && mini.isVisible())) return;
  positionPanel(toast);
  toast.webContents.send('toast:show', state);
  toast.showInactive();
  toast.setAlwaysOnTop(true, 'pop-up-menu');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.webContents.send('toast:hide');
    toastTimer = setTimeout(hideToast, 220);
  }, 4500);
}

function hideToast() {
  clearTimeout(toastTimer);
  if (toast && toast.isVisible()) toast.hide();
}

function maybeNotify(state) {
  const t = state && state.track;
  if (!t || t.id === lastTrackId) return;
  const first = lastTrackId === null;
  lastTrackId = t.id;
  const s = settings.load();
  if (first || !s.notifications || state.paused) return;
  const mainInView = mainWin && mainWin.isVisible() && mainWin.isFocused();
  if (s.notifyOnlyWhenHidden && mainInView) return;
  showToast(state);
}

function showMain() {
  if (!mainWin) return;
  hideFlyout();
  if (mainWin.isMinimized()) mainWin.restore();
  mainWin.show();
  mainWin.focus();
}

function sendCommand(cmd) {
  if (mainWin) mainWin.webContents.send('player:command', cmd);
}

// ---------- Tray ----------
function buildTrayMenu() {
  const playing = lastState && !lastState.paused;
  return Menu.buildFromTemplate([
    { label: 'Open Sweet Spot', click: showMain },
    { type: 'separator' },
    { label: playing ? 'Pause' : 'Play', click: () => sendCommand({ type: 'toggle' }) },
    { label: 'Next', click: () => sendCommand({ type: 'next' }) },
    { label: 'Previous', click: () => sendCommand({ type: 'previous' }) },
    { type: 'separator' },
    { label: 'Drop-down panel', click: () => setTimeout(toggleFlyout, 50) },
    { label: 'Mini-player', type: 'checkbox', checked: !!(mini && mini.isVisible()), click: () => toggleMini() },
    { type: 'separator' },
    { label: 'Settings', click: () => { showMain(); mainWin.webContents.send('navigate', { view: 'settings' }); } },
    { label: 'Quit', click: () => { quitting = true; app.quit(); } }
  ]);
}

function createTray() {
  // .ico carries 16/24/32px versions so Windows picks a crisp one for the DPI.
  const img = nativeImage.createFromPath(asset(process.platform === 'win32' ? 'icon.ico' : 'tray.png'));
  tray = new Tray(img);
  tray.setToolTip('Sweet Spot');
  tray.on('click', () => (settings.load().trayClick === 'mini' ? toggleMini() : toggleFlyout()));
  tray.on('right-click', () => tray.popUpContextMenu(buildTrayMenu()));
  tray.on('double-click', showMain);
}

// ---------- Settings side-effects ----------
const HOTKEY_ACTIONS = {
  playPause: () => sendCommand({ type: 'toggle' }),
  next: () => sendCommand({ type: 'next' }),
  previous: () => sendCommand({ type: 'previous' }),
  volumeUp: () => sendCommand({ type: 'volumeStep', delta: 0.05 }),
  volumeDown: () => sendCommand({ type: 'volumeStep', delta: -0.05 }),
  like: () => sendCommand({ type: 'like' }),
  toggleFlyout: () => toggleFlyout(),
  toggleMini: () => toggleMini(),
  showMain: () => showMain()
};

// Returns the actions whose shortcut couldn't be registered (usually taken by another app).
function registerHotkeys() {
  globalShortcut.unregisterAll();
  const failed = [];
  const keys = settings.load().hotkeys;
  for (const [action, accel] of Object.entries(keys)) {
    if (!accel || !HOTKEY_ACTIONS[action]) continue;
    try {
      if (!globalShortcut.register(accel, HOTKEY_ACTIONS[action])) failed.push(action);
    } catch { failed.push(action); }
  }
  return failed;
}

function applyLoginItem() {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  // Remove the old start-with-Windows entry from when the app was called Trayplay.
  if (process.platform === 'win32') app.setLoginItemSettings({ openAtLogin: false, name: 'com.trayplay.app' });
  app.setLoginItemSettings({
    openAtLogin: !!settings.load().startWithWindows,
    path: process.execPath,
    // In development, electron.exe needs the app folder as its first argument.
    args: app.isPackaged ? ['--hidden'] : [app.getAppPath(), '--hidden']
  });
}

function broadcastSettings() {
  const s = { ...settings.load(), effectiveStyle: effectiveStyle(), acrylicSupported: supportsAcrylic() };
  for (const w of [mainWin, flyout, toast, mini]) if (w && !w.isDestroyed()) w.webContents.send('settings:changed', s);
  return s;
}

// ---------- IPC ----------
ipcMain.handle('auth:status', () => {
  const hasTokens = auth.loadTokens();
  const scopesOk = hasTokens && auth.hasAllScopes();
  return {
    clientId: auth.getClientId(),
    signedIn: scopesOk,
    // Signed in before, but a newer version needs an extra permission.
    needsReauth: hasTokens && !scopesOk,
    redirectUri: auth.REDIRECT_URI
  };
});
ipcMain.handle('auth:setClientId', (_e, id) => { auth.setClientId(id); return true; });
ipcMain.handle('auth:login', async () => {
  await auth.login();
  showMain();
  return true;
});
ipcMain.handle('auth:logout', () => { auth.logout(); return true; });
ipcMain.handle('auth:token', async () => {
  try { return await auth.getAccessToken(); }
  catch (e) { return e.offline ? { offline: true } : null; }
});

ipcMain.handle('settings:get', () => ({
  ...settings.load(),
  effectiveStyle: effectiveStyle(),
  acrylicSupported: supportsAcrylic(),
  hotkeyFailures: registerHotkeys.lastFailed || [],
  appVersion: app.getVersion(),
  updatesFromSource: !app.isPackaged
}));
ipcMain.handle('settings:set', (_e, patch) => {
  const before = settings.load();
  const styleBefore = effectiveStyle();
  settings.save(patch || {});
  let hotkeyFailures = registerHotkeys.lastFailed || [];
  if (patch.hotkeys) hotkeyFailures = registerHotkeys.lastFailed = registerHotkeys();
  if ('startWithWindows' in patch && patch.startWithWindows !== before.startWithWindows) applyLoginItem();
  if ('autoUpdate' in patch && patch.autoUpdate !== before.autoUpdate) startUpdates();
  if (effectiveStyle() !== styleBefore) rebuildPanels();
  else if ('miniLayout' in patch && patch.miniLayout !== before.miniLayout) resizeMini();
  return { ...broadcastSettings(), hotkeyFailures };
});
ipcMain.on('settings:preview-toast', () => {
  if (lastState && lastState.track) showToast(lastState);
});

// Player state flows main window → main process → flyout + tray (+ toast on track change).
ipcMain.on('state:update', (_e, state) => {
  lastState = state;
  for (const w of [flyout, mini]) if (w && !w.isDestroyed()) w.webContents.send('state', state);
  if (tray) {
    const t = state && state.track;
    const tip = t ? `${t.name} — ${t.artists}` : 'Sweet Spot';
    tray.setToolTip(tip.length > 127 ? tip.slice(0, 124) + '…' : tip);
  }
  maybeNotify(state);
});
ipcMain.handle('state:get', () => lastState);
ipcMain.handle('lb:search', (_e, q) => discover.searchPlaylists(q));
ipcMain.handle('lb:playlist', (_e, id, opts) => discover.getPlaylist(id, { background: !!(opts && opts.background) }));
ipcMain.handle('lb:radio', (_e, { prompt, mode }) => discover.radio(prompt, mode));
ipcMain.handle('lb:createdfor', (_e, user) => discover.createdFor(user));
ipcMain.handle('lb:token:set', (_e, token) => discover.setToken(token));
ipcMain.handle('lb:token:status', () => discover.tokenStatus());
ipcMain.handle('match:get', (_e, keys) => discover.getMatches(keys || []));
ipcMain.handle('match:put', (_e, entries) => discover.putMatches(entries || {}));
ipcMain.handle('artist:info', (_e, { id, name, genres }) =>
  artistInfo.getArtistInfo(id, name, genres).catch((e) => ({ found: false, error: e.message })));

// Commands from the flyout/toast go to the window that owns the player.
ipcMain.on('player:command', (_e, cmd) => sendCommand(cmd));
ipcMain.on('window:showMain', showMain);
// Custom title-bar buttons
ipcMain.on('window:control', (_e, action) => {
  if (!mainWin) return;
  if (action === 'minimize') mainWin.minimize();          // → hides to tray (see 'minimize' handler)
  if (action === 'maximize') mainWin.isMaximized() ? mainWin.unmaximize() : mainWin.maximize();
  if (action === 'close') mainWin.close();                // → quits, or hides if Close to tray is on
});
ipcMain.handle('window:isMaximized', () => !!(mainWin && mainWin.isMaximized()));
ipcMain.on('flyout:hide', hideFlyout);
ipcMain.on('toast:click', () => { hideToast(); toggleFlyout(); });
ipcMain.on('mini:toggle', (_e, force) => toggleMini(force));
ipcMain.on('mini:drag', (_e, phase, dx, dy) => {
  if (!mini) return;
  if (phase === 'start') {
    const [x, y] = mini.getPosition();
    miniDragStart = { x, y };
  } else if (phase === 'move' && miniDragStart) {
    mini.setPosition(Math.round(miniDragStart.x + dx), Math.round(miniDragStart.y + dy));
  } else if (phase === 'end') {
    miniDragStart = null;
    const [x, y] = mini.getPosition();
    settings.save({ miniPos: { x: x + mini._margin, y: y + mini._margin } });
    placeMini(); // snap back on-screen if dragged off an edge
  }
});
// Pause global shortcuts while the user is recording a new one in Settings.
ipcMain.on('hotkeys:pause', (_e, paused) => {
  if (paused) globalShortcut.unregisterAll();
  else registerHotkeys.lastFailed = registerHotkeys();
});

// Transparent panels: only catch the mouse while it's over the visible panel.
ipcMain.on('panel:mouse', (e, inside) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win || win._margin === 0) return;
  win.setIgnoreMouseEvents(!inside, { forward: true });
});

// ---------- App lifecycle ----------
async function start() {
  // castlabs Electron exposes `components` for the Widevine CDM; stock Electron doesn't.
  if (electron.components && electron.components.whenReady) {
    try { await electron.components.whenReady(); }
    catch (e) { console.error('Widevine component failed to load:', e); }
  } else {
    console.warn('Not running the castlabs Electron build — Spotify playback will not work.');
  }
  if (process.platform === 'win32') app.setAppUserModelId('com.sweetspot.app');
  setAppMenu();
  createMainWindow();
  createFlyout();
  createToast();
  createTray();
  if (settings.load().miniOpen) toggleMini(true);
  registerHotkeys.lastFailed = registerHotkeys();
  applyLoginItem();
  startUpdates();
}

// ---------- Updates ----------
let updateTimer = null;
function startUpdates() {
  updater.init({
    onStatus: (s) => {
      if (mainWin && !mainWin.isDestroyed()) mainWin.webContents.send('update:status', s);
      if (s.state === 'available' && !s.manual && tray) tray.setToolTip(`Sweet Spot — update ${s.version} available`);
    },
    onBeforeInstall: () => { quitting = true; }
  });
  clearInterval(updateTimer);
  if (settings.load().autoUpdate === false) return;
  setTimeout(() => updater.check(), 10000);
  updateTimer = setInterval(() => updater.check(), 6 * 60 * 60 * 1000);
}
ipcMain.handle('update:check', () => updater.check({ manual: true }));
ipcMain.handle('update:get', () => updater.getState());
ipcMain.on('update:download', () => updater.download());
ipcMain.on('update:install', () => updater.install());

app.whenReady().then(start);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('before-quit', () => { quitting = true; });
app.on('window-all-closed', () => app.quit());
