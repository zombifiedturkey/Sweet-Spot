# Sweet Spot

A personal Spotify player for Windows 11. It plays music itself through Spotify's Web Playback SDK, hides in the system tray when minimised, and drops down a now-playing panel when you click the tray icon. The panel works with the taskbar on any edge, including the top.

**What it does:**

- **Liquid-glass look**: the window sits on a blurred, frosted backdrop of album art. It follows what's playing, or the album or playlist you're viewing. Hover over any cover and the backdrop fades to it. Panels, the top dock, menus and the floating player bar are glass.
- **Top dock** with Home, Search and Liked Songs. **Your Library** slides out from the left: click its button, press Ctrl+B or rest the mouse on the left edge. Pin it to keep it open.
- **Accent colours**: nine to choose from, plus *Album art* (follows the cover) and *Theme*.
- **Artist pages** show an **About** card with the bio, origin, year formed, members, genres and links. This comes from **Wikipedia** and **MusicBrainz**, free open sources that need no account, because Spotify no longer provides artist bios. Results are cached on your PC for two weeks.
- **Popular** songs sit beside each artist's discography. Spotify no longer gives personal apps an artist's top tracks, so this uses Spotify search ranking, which puts their most-played songs first, with remasters and repeats removed.
- **Discover** (in the top dock) is powered by **ListenBrainz**, a free, open music service:
  - **Instant mix:** a fresh playlist around an artist or genre, in Familiar, Mixed or Deep cuts flavours. ListenBrainz now only builds these for signed-in users, so paste your free **ListenBrainz token** into Settings (find it at listenbrainz.org → Settings → User token). Without one, Sweet Spot makes a **quick mix from Spotify search** instead.
  - **Community playlists** and **Made for you** are listed on the left. Click one and it opens in the panel on the right with its full track list, so you can flick between playlists without leaving the page.
  - **Made for you:** add your ListenBrainz username in Settings to get *Weekly Jams* and *Weekly Exploration*, a stand-in for Discover Weekly.
  - Songs are matched to Spotify automatically (matches are cached), and any playlist or mix can be **saved to your Spotify playlists**.
- **Your playlists:** create them with **+** in Your Library or **Add to playlist → New playlist…**. Edit details, delete, remove songs and **drag to reorder**.
- **Now playing panel:** the button at the far right of the player bar (or Ctrl+Q) opens a panel on the right with big album art, what it's *playing from*, and **Next up**. It stays open on every page until you click the button again, and Sweet Spot remembers whether it was open.
- **Search** shows artists, albums and playlists on the left and songs in their own scrolling box on the right.
- Desktop window with Home, Search, Liked Songs, your playlists, album and artist pages, and a queue panel.
- Player bar with play/pause, next/previous, seek, shuffle, repeat, like and volume. Your volume is remembered between launches.
- Minimise sends the app to the tray. Click the tray icon for the drop-down panel, which shows album art, controls, progress, volume and Up next.
- The drop-down can be **Frosted** (Windows 11 blur), **Glass** (see-through) or **Solid**, with adjustable opacity.
- A small pop-up appears beside the tray when the song changes. Click it to open the drop-down.
- Your track shows in the **Windows media controls** (the volume pop-up and lock screen), and your keyboard's media keys work through them.
- **Global keyboard shortcuts** that you can change.
- **Settings page** with close-to-tray, start with Windows and start minimised.
- **Right-click menus** on songs, albums and playlists: add to queue, add to playlist, like, go to album or artist, and copy a link. Rows also have a **⋯** button.
- **Other devices**: when Spotify is playing on your phone or a speaker, Sweet Spot shows and controls it. A device picker (in the player bar and the drop-down) moves playback between devices.
- **Endless lists**: Liked Songs, playlists, albums and artist pages load more as you scroll, with no cap.
- **Back and forward** buttons with full history (Alt+←/→ and mouse side buttons), plus keyboard shortcuts in the main window. Press **?** to see them.
- **Mini-player**: a small always-on-top window you can drag anywhere, in a compact bar or album-art layout.
- **Theme presets** (Classic, Midnight, Sunset, Rose, Forest, Mono) and an accent colour taken from the current album art. Page headers are tinted with each cover's colour.
- Right-click the tray icon for a quick menu. Double-click it to open the main window.

---

## 1. One-time setup

### Install the tools

1. **Node.js 20 or newer (LTS)** from https://nodejs.org.
2. **Git** from https://git-scm.com. npm needs it to fetch the special Electron build.
3. **Python 3** from https://python.org. It's only used for the signing step in section 3.

### Create your Spotify developer app

You must be signed in with your **Premium** account. Spotify now requires Premium for developer apps.

1. Go to https://developer.spotify.com/dashboard and click **Create app**.
2. Enter any name and description you like.
3. Under **Redirect URIs**, add exactly:
   `http://127.0.0.1:8888/callback`
4. Under "Which API/SDKs are you planning to use?", tick **Web API** and **Web Playback SDK**.
5. Save the app, then copy the **Client ID**. You don't need the client secret.
6. If you plan to sign in with a different Spotify account than the one that owns the app, add that account's email under **User Management**.

---

## 2. Install and run

Open a terminal in this folder and run:

```
npm install
npm start
```

On first launch, paste your Client ID and click **Sign in with Spotify**. Your browser opens Spotify's login page. Once you approve, the app takes over.

The sign-in is remembered, and your tokens are encrypted with Windows' own data protection.

---

## 3. If playback won't start: VMP signing

Spotify's audio is DRM-protected, which is why this app uses the **castlabs** build of Electron with Widevine built in. Spotify's licence server may also insist that the app is *VMP-signed*.

You'll know you need this step if:

- the app shows "Player couldn't start", or
- tracks fail with a licence or EME error.

Signing is free and takes a few minutes:

```
pip install --upgrade castlabs-evs
python -m castlabs_evs.account signup
npm run vmp-sign
```

The `signup` command creates a free castlabs EVS account and only needs doing once. Run `npm run vmp-sign` again whenever `npm install` re-downloads Electron.

---

## 4. Using it

| Action | What happens |
| --- | --- |
| Minimise (–) | Window hides to the tray; music keeps playing |
| Click tray icon | Drop-down panel opens beside the icon |
| Click elsewhere / Esc | Panel closes |
| Space (in panel) | Play / pause |
| Ctrl + ← / → (in panel) | Previous / next |
| ↑ / ↓ or mouse wheel on the volume bar (in panel) | Volume |
| Double-click a song in Up next (drop-down or queue panel) | Plays it and jumps the queue to that point |
| Open-in-window icon (panel) | Shows the main window |
| Right-click tray icon | Open, Play/Pause, Next, Previous, Drop-down, Mini-player, Settings, Quit |
| Drag the mini-player | Moves it; its position is remembered |
| Double-click the mini-player | Opens the main window |
| Scroll on the mini-player | Volume |
| Close (×) | Quits, or hides to the tray if **Close to tray** is on |
| Drag the top bar | Moves the window; double-click it to maximise |
| Library button / Ctrl+B / left screen edge | Opens Your Library; 📌 keeps it open |

Open **Settings** from the gear icon at the bottom of the sidebar, or from the tray menu.

**Inside the main window:**

| Shortcut | Action |
| --- | --- |
| Space | Play / pause |
| Ctrl+→ / ← | Next / previous |
| Shift+→ / ← | Skip forward / back 10 seconds |
| Ctrl+↑ / ↓ | Volume |
| Ctrl+S / Ctrl+R | Shuffle / repeat |
| Alt+Shift+B | Like / unlike current song |
| Ctrl+L | Search |
| Alt+← / → | Back / forward |
| Ctrl+Q | Now playing panel |
| Ctrl+B | Your Library |
| Ctrl+M | Mini-player |
| Ctrl+, | Settings |
| ? | List of shortcuts |

DevTools are on Ctrl+Shift+I if you want to inspect the UI while customising it.

**System-wide shortcuts** (they work anywhere in Windows and can be changed in Settings):

| Shortcut | Action |
| --- | --- |
| Ctrl+Alt+Space | Play / pause |
| Ctrl+Alt+→ / ← | Next / previous |
| Ctrl+Alt+↑ / ↓ | Volume up / down |
| Ctrl+Alt+L | Like / unlike the current song |
| Ctrl+Alt+M | Open the tray panel |
| Ctrl+Alt+N | Show / hide the mini-player |

If a shortcut shows **In use**, another app has already claimed it; pick a different one.

Sweet Spot appears as a Spotify Connect device called **Sweet Spot**. You can also send playback to it from your phone.

---

## 5. Customising the look

- **Glass:** turn the liquid-glass look and the hover backdrop on or off in **Settings → Appearance**. Blur strength and tint are near the top of `src/styles.css` (`.glass` and `.bd-layer`). The glass tint colour is `--glass-rgb` in `src/theme.css`.
- **Accent colours:** pick one in Settings. The list lives in `src/themes.js` if you want to add your own.
- **Colours, fonts and corner radius:** all in `src/theme.css`. These are what the **Classic** theme uses; the other presets live in `src/themes.js`, and you can add your own there.
- **Desktop layout:** `src/index.html` and `src/styles.css`.
- **Tray panel layout:** `src/flyout.html` and `src/flyout.css`.
- **Mini-player layout:** `src/mini.html` and `src/mini.css`. Sizes are in `MINI_SIZES` in `main.js`.
- **Panel glass, shadow and slide-in animation:** `src/panel.css`. This is shared by the drop-down and the song-change pop-up.
- **Panel size:** `FLYOUT_W` and `FLYOUT_H` at the top of `main.js`.
- **Transparency:** set **Style** and **Opacity** in Settings. Frosted needs Windows 11 22H2 or later; on older builds Sweet Spot uses Glass instead.

---

## 6. Spotify limits to know about

These are Spotify's rules for personal (Development Mode) apps since early 2026, not bugs in Sweet Spot:

- **Search** returns up to 10 results per category.
- **Playlist track lists** are only visible for playlists you own or collaborate on. Followed playlists still show and play; they just don't list their tracks.
- **Spotify's own made-for-you and editorial playlists** (Discover Weekly, Daily Mixes and so on) can't be listed by apps like this since November 2024. Discover's ListenBrainz playlists are the replacement.
- **Artist "Top tracks"** and **New releases** aren't available. Artist pages work out a Popular list from search ranking instead.
- Up to **5 Spotify accounts** can use the app, and the app owner's Premium must stay active.
- **Other devices** are checked every few seconds rather than instantly, so changes made on your phone can take a moment to show.

---

## Files

```
main.js          Main process: windows, tray, panel positioning, hotkeys, start-up
auth.js          Spotify sign-in (PKCE) and encrypted token storage
discover.js      ListenBrainz (search, instant mixes, made-for-you) + Spotify match cache
artistinfo.js    Artist About info (Wikipedia + MusicBrainz) with a local cache
settings.js      Saved settings (stored in %APPDATA%\\Sweet Spot\\settings.json)
preload.js       Safe bridge between the windows and the main process
src/index.html   Desktop window          src/app.js      Desktop logic + player
src/flyout.html  Tray drop-down panel    src/flyout.js   Panel logic
src/toast.html   Song-change pop-up      src/panel.css/js Shared panel glass + shadow
src/mini.html    Mini-player             src/mini.js     Mini-player logic
src/themes.js    Theme presets + album-art accent colour
src/spotify.js   Spotify Web API client  src/icons.js    SVG icons
src/theme.css    Colours and fonts (edit me)
assets/          App and tray icons
```

## Still to come

- **Synced lyrics**
- **Installer:** a packaged `.exe`
