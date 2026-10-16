// Persistent user settings (userData/settings.json).

const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // General
  closeToTray: false,
  startWithWindows: false,
  startMinimised: false,
  // Notifications
  notifications: true,
  notifyOnlyWhenHidden: true,
  // Tray panel
  flyoutStyle: 'acrylic',   // 'acrylic' (blurred glass) | 'glass' (see-through) | 'solid'
  flyoutOpacity: 0.72,      // tint strength for acrylic/glass, 0.3–1
  albumWash: true,          // tint the panel with the album art colours
  // Look
  theme: 'classic',         // background theme, see src/themes.js
  accent: 'auto',           // 'auto' (album art) | 'theme' | a colour name from src/themes.js
  glass: true,              // liquid-glass look with a blurred album-art backdrop
  hoverBackdrop: true,      // backdrop follows the album art under the mouse
  libraryPinned: false,     // keep the library panel open beside the content
  queueOpen: false,         // keep the Now playing / queue panel open on the right
  lbUser: '',               // ListenBrainz username for "Made for you" playlists
  // Tray icon click opens 'flyout' or 'mini'
  trayClick: 'flyout',
  // Mini-player
  miniOpen: false,
  miniLayout: 'compact',    // 'compact' | 'square'
  miniPos: null,            // { x, y } top-left of the visible panel
  // Player
  volume: 0.7,
  autoUpdate: true,         // check GitHub for new releases on start-up and every few hours
  // Global hotkeys (Electron accelerators; empty = off)
  hotkeys: {
    playPause: 'Ctrl+Alt+Space',
    next: 'Ctrl+Alt+Right',
    previous: 'Ctrl+Alt+Left',
    volumeUp: 'Ctrl+Alt+Up',
    volumeDown: 'Ctrl+Alt+Down',
    like: 'Ctrl+Alt+L',
    toggleFlyout: 'Ctrl+Alt+M',
    toggleMini: 'Ctrl+Alt+N',
    showMain: ''
  }
};

const file = () => path.join(app.getPath('userData'), 'settings.json');
let cache = null;

function load() {
  if (cache) return cache;
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch {}
  cache = { ...DEFAULTS, ...saved, hotkeys: { ...DEFAULTS.hotkeys, ...(saved.hotkeys || {}) } };
  // Earlier versions had an on/off "accent from album art" switch.
  if (saved.accent === undefined && saved.dynamicAccent === false) cache.accent = 'theme';
  return cache;
}

function save(patch) {
  const cur = load();
  cache = {
    ...cur,
    ...patch,
    hotkeys: patch.hotkeys ? { ...cur.hotkeys, ...patch.hotkeys } : cur.hotkeys
  };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  fs.writeFileSync(file(), JSON.stringify(cache, null, 2));
  return cache;
}

module.exports = { DEFAULTS, load, save };
