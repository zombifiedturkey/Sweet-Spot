const { contextBridge, ipcRenderer } = require('electron');

const on = (channel) => (fn) => {
  const handler = (_e, data) => fn(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld('sweetspot', {
  // Auth
  authStatus: () => ipcRenderer.invoke('auth:status'),
  setClientId: (id) => ipcRenderer.invoke('auth:setClientId', id),
  login: () => ipcRenderer.invoke('auth:login'),
  logout: () => ipcRenderer.invoke('auth:logout'),
  getToken: () => ipcRenderer.invoke('auth:token'),
  artistInfo: (id, name, genres) => ipcRenderer.invoke('artist:info', { id, name, genres }),

  // Discover (ListenBrainz) + Spotify match cache
  lbSearch: (q) => ipcRenderer.invoke('lb:search', q),
  lbPlaylist: (id) => ipcRenderer.invoke('lb:playlist', id),
  lbRadio: (prompt, mode) => ipcRenderer.invoke('lb:radio', { prompt, mode }),
  lbCreatedFor: (user) => ipcRenderer.invoke('lb:createdfor', user),
  lbSetToken: (token) => ipcRenderer.invoke('lb:token:set', token),
  lbTokenStatus: () => ipcRenderer.invoke('lb:token:status'),
  matchGet: (keys) => ipcRenderer.invoke('match:get', keys),
  matchPut: (entries) => ipcRenderer.invoke('match:put', entries),

  // Settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  onSettings: on('settings:changed'),
  previewToast: () => ipcRenderer.send('settings:preview-toast'),

  // Player state sync
  pushState: (state) => ipcRenderer.send('state:update', state),
  getState: () => ipcRenderer.invoke('state:get'),
  onState: on('state'),

  // Commands (flyout/tray/hotkeys → player window)
  command: (cmd) => ipcRenderer.send('player:command', cmd),
  onCommand: on('player:command'),
  onNavigate: on('navigate'),

  // Windows and panels
  showMain: () => ipcRenderer.send('window:showMain'),
  windowControl: (action) => ipcRenderer.send('window:control', action),
  isMaximized: () => ipcRenderer.invoke('window:isMaximized'),
  onMaximized: on('window:maximized'),
  hideFlyout: () => ipcRenderer.send('flyout:hide'),
  onFlyoutShown: on('flyout:shown'),
  onPanelEdge: on('panel:edge'),
  panelMouse: (inside) => ipcRenderer.send('panel:mouse', inside),
  onToastShow: on('toast:show'),
  onToastHide: on('toast:hide'),
  toastClick: () => ipcRenderer.send('toast:click'),
  toggleMini: (force) => ipcRenderer.send('mini:toggle', force),
  miniDrag: (phase, dx, dy) => ipcRenderer.send('mini:drag', phase, dx, dy),
  pauseHotkeys: (paused) => ipcRenderer.send('hotkeys:pause', paused)
});
