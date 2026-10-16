# Sweet Spot

**A Spotify desktop player for Windows 11 that lets you choose your own music instead of the algorithm.**

Sweet Spot plays your Spotify music in its own liquid-glass window, tucks into the system tray with a drop-down player, and adds a Discover page built on open music projects: community playlists, instant mixes and weekly made-for-you playlists from ListenBrainz, matched to Spotify and saveable to your own playlists.

> Sweet Spot is a personal, open-source project. It isn't made by or affiliated with Spotify. You need a **Spotify Premium** account.

---

## Contents

1. [What it does](#what-it-does)
2. [Install (the easy way)](#install-the-easy-way)
3. [Step 1: Create your free Spotify developer app](#step-1-create-your-free-spotify-developer-app)
4. [Step 2: First launch and sign-in](#step-2-first-launch-and-sign-in)
5. [Step 3 (optional): Connect ListenBrainz for Discover](#step-3-optional-connect-listenbrainz-for-discover)
6. [Using Sweet Spot](#using-sweet-spot)
7. [Troubleshooting](#troubleshooting)
8. [Spotify limits to know about](#spotify-limits-to-know-about)
9. [Building from source](#building-from-source)
10. [Building the installer and publishing a release](#building-the-installer-and-publishing-a-release)
11. [Customising the look](#customising-the-look)
12. [Credits](#credits)

---

## What it does

- **Liquid-glass look**: the window sits on a blurred, frosted backdrop of album art. It follows what's playing, or the album or playlist you're viewing. Hover over any cover and the backdrop fades to it. Panels, the top dock, menus and the floating player bar are glass.
- **Top dock** with Home, Search, Discover and Liked Songs. **Your Library** slides out from the left: click its button, press Ctrl+B or rest the mouse on the left edge. Pin it to keep it open.
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

## Install (the easy way)

**You need:** Windows 10 or 11 (Windows 11 recommended for the frosted glass), a **Spotify Premium** account, and about 10 minutes for the one-time setup.

1. Go to the [**Releases**](https://github.com/zombifiedturkey/Sweet-Spot/releases) page and download the latest **`Sweet-Spot-Setup-x.x.x.exe`**.
2. Run it. Windows may show a blue **"Windows protected your PC"** box, because the installer isn't signed with a paid Microsoft certificate. Click **More info → Run anyway**.
3. Choose where to install it (the default is fine) and finish. Sweet Spot opens when the installer closes, and there's a shortcut on your desktop and in the Start menu.

No command prompt, Node.js or Python is needed for this. Then do the setup steps below.

To **update**, download the newer installer and run it over the top. Your sign-in and settings are kept. To **uninstall**, use **Settings → Apps → Installed apps → Sweet Spot**.

---

## Step 1: Create your free Spotify developer app

Spotify only lets personal apps like Sweet Spot play music through a "developer app" that you create on your own account. It's free and takes a few minutes, and it gives you a **Client ID** that you paste into Sweet Spot once.

1. Go to **https://developer.spotify.com/dashboard** and log in with your **Spotify Premium** account. Spotify requires Premium to own a developer app.
2. The first time, Spotify asks you to **accept the Developer Terms of Service**. If it asks you to **verify your email address**, click the link in the email it sends, then come back to the dashboard.
3. Click **Create app** and fill it in:
   - **App name:** `Sweet Spot` (or anything you like)
   - **App description:** anything, for example `My desktop player`
   - **Website:** leave blank
   - **Redirect URIs:** type exactly `http://127.0.0.1:8888/callback` and click **Add**. It must match exactly, including `127.0.0.1` (not `localhost`) and no slash at the end.
   - **Which API/SDKs are you planning to use?** Tick **Web API** and **Web Playback SDK**.
4. Tick the terms box and click **Save**.
5. On your new app's page, open **Settings** and copy the **Client ID**. You don't need the Client secret, so leave that hidden.
6. **Other people using your app:** if anyone else will sign in to Sweet Spot with your Client ID (a partner on their own Spotify account, say), add their name and Spotify email under **User Management** in the app's settings. Spotify allows up to 5 accounts per personal app, and each one needs Premium. Anyone setting up their own copy can simply create their own developer app instead.

---

## Step 2: First launch and sign-in

1. Open Sweet Spot. The first screen asks for your Client ID: paste it in and click **Save**.
2. Click **Sign in with Spotify**. Your web browser opens Spotify's login page.
3. Log in if asked and click **Agree** to let Sweet Spot control playback and manage your library and playlists.
4. The browser says **Signed in to Sweet Spot**. Close the tab and go back to the app.

Your music, playlists and Liked Songs load straight away, and Sweet Spot shows up as a Spotify Connect device called **Sweet Spot** on your phone and other devices.

The sign-in is remembered. Your tokens are stored encrypted with Windows' own data protection, so you won't need to do this again. If a later update needs an extra Spotify permission, Sweet Spot asks you to sign in once more.

---

## Step 3 (optional): Connect ListenBrainz for Discover

The **Discover** page uses **ListenBrainz**, a free, open-source, non-profit music service run by the MetaBrainz Foundation (the people behind MusicBrainz). Community playlist search works without an account. An account adds:

- **Instant mixes** built by ListenBrainz around an artist or genre, including similar artists. Without a token, Sweet Spot makes a simpler quick mix from Spotify search instead.
- **Made for you:** your own *Weekly Jams* and *Weekly Exploration* playlists, a stand-in for Spotify's Discover Weekly.

**Set it up:**

1. **Create a MusicBrainz account.** ListenBrainz signs you in with a MusicBrainz account. Go to **https://musicbrainz.org/register**, choose a username and password, and confirm your email address from the email they send.
2. **Sign in to ListenBrainz.** Go to **https://listenbrainz.org**, click **Sign in**, and approve with your MusicBrainz account.
3. **Copy your user token.** On ListenBrainz, open **Settings** (https://listenbrainz.org/settings/) and copy the **User token**. You don't need to create a developer application; the user token is all Sweet Spot needs.
4. **Paste it into Sweet Spot.** Open **Settings → ListenBrainz** in Sweet Spot, paste the token and click **Connect**. Sweet Spot checks it with ListenBrainz and stores it encrypted on your PC.
5. **For Made for you:** enter your ListenBrainz **username** in the same section. Then, on ListenBrainz, go to **Settings → Connect services** and connect **Spotify** so ListenBrainz can see what you listen to. ListenBrainz builds your weekly playlists once it has about a week of listening, and refreshes them every week.

**Free sources that need no account:** artist bios on artist pages come from **Wikipedia** and **Wikidata**, artist details from **MusicBrainz**, and some playlist covers from the **Cover Art Archive**. Sweet Spot reads these automatically.

---

## Using Sweet Spot

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

Open **Settings** from the gear icon at the top right, or from the tray menu.

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

## Troubleshooting

| Problem | Fix |
| --- | --- |
| Spotify says **INVALID_CLIENT: Invalid redirect URI** | The Redirect URI in your Spotify app doesn't match. In the dashboard it must be exactly `http://127.0.0.1:8888/callback`. Save, then try again. |
| **"User not registered in the Developer Dashboard"** or a 403 error after signing in | You're signing in with a Spotify account that doesn't own the developer app. Add that account's email under **User Management** (Step 1, point 6), or create your own developer app. |
| **"Premium required"** | Spotify only allows playback through its SDK on Premium accounts, and the app owner's Premium must be active. |
| **Player couldn't start** or tracks fail with a licence/EME error | The official installer is already signed for Spotify's DRM. If you built it yourself, see [VMP signing](#3-vmp-sign-electron-so-spotify-will-play). Also check that nothing is blocking `*.spotify.com` and `*.scdn.co`. |
| Sign-in page says the **port is in use** | Another program is using port 8888. Close it (or restart your PC) and sign in again. |
| Asked to **sign in again** after an update | The update needs a new Spotify permission. Sign in once and it's sorted. |
| **Instant mix** says a token is needed | Add your ListenBrainz user token in Settings (Step 3). |
| **Made for you** is empty | ListenBrainz needs about a week of your listening. Check that Spotify is connected under ListenBrainz **Settings → Connect services** and your username in Sweet Spot is correct. |
| A **keyboard shortcut** shows **In use** | Another app has claimed it. Pick a different one in Settings. |
| Windows **SmartScreen** blocks the installer | Click **More info → Run anyway**. The installer isn't code-signed because that needs a paid certificate. |

Your settings and caches live in `%APPDATA%\Sweet Spot`. Deleting that folder resets Sweet Spot to a fresh install (you'll need to enter your Client ID and sign in again).

---

## Spotify limits to know about

These are Spotify's rules for personal (Development Mode) apps since early 2026, not bugs in Sweet Spot:

- **Search** returns up to 10 results per category.
- **Playlist track lists** are only visible for playlists you own or collaborate on. Followed playlists still show and play; they just don't list their tracks.
- **Spotify's own made-for-you and editorial playlists** (Discover Weekly, Daily Mixes and so on) can't be listed by apps like this since November 2024. Discover's ListenBrainz playlists are the replacement.
- **Artist "Top tracks"** and **New releases** aren't available. Artist pages work out a Popular list from search ranking instead.
- Up to **5 Spotify accounts** can use the app, and the app owner's Premium must stay active.
- **Other devices** are checked every few seconds rather than instantly, so changes made on your phone can take a moment to show.

---

## Building from source

Use this if you want to change the code or build your own installer. Everything below is a one-time setup apart from `npm start`.

### 1. Install the tools

1. **Node.js 20 or newer (LTS)** from https://nodejs.org. Accept the defaults.
2. **Git** from https://git-scm.com. npm needs it to fetch the special Electron build.
3. **Python 3** from https://python.org. During install, tick **Add python.exe to PATH**. It's only used to VMP-sign Electron (step 3).

### 2. Get the code

```
git clone https://github.com/zombifiedturkey/Sweet-Spot.git
cd Sweet-Spot
npm install
```

`npm install` downloads the **castlabs Electron for Content Security** build (Electron with Google's Widevine DRM built in), which is what lets Spotify's protected audio play. It's a large download.

### 3. VMP-sign Electron so Spotify will play

Spotify's licence server only plays audio in apps that are **VMP-signed** (Verified Media Path). castlabs signs apps for free through their **EVS** (Electron Verification Service) account:

```
pip install --upgrade castlabs-evs
python -m castlabs_evs.account signup
npm run vmp-sign
```

- `signup` creates your free castlabs EVS account. It asks for a name, email and password and sends a confirmation code to your email. You only do this once. On later sessions, `python -m castlabs_evs.account reauth` signs you back in.
- `npm run vmp-sign` signs the Electron copy in `node_modules`. Run it again whenever `npm install` re-downloads Electron.

### 4. Run it

```
npm start
```

Then do [Step 1](#step-1-create-your-free-spotify-developer-app) and [Step 2](#step-2-first-launch-and-sign-in) if you haven't already. `npm run check` syntax-checks every file. DevTools are on **Ctrl+Shift+I**.

---

## Building the installer and publishing a release

One command builds the Windows installer:

```
npm run dist
```

This uses **electron-builder** to package Sweet Spot and creates **`dist\Sweet-Spot-Setup-<version>.exe`**. During the build, `build/vmp-sign.js` automatically VMP-signs the packaged app with your castlabs EVS account. That means the installer is ready to play Spotify on any PC, and the people installing it don't need Python or an EVS account. If the build stops at the signing step, run `python -m castlabs_evs.account reauth` and try again.

`npm run pack` builds an unpacked copy in `dist\win-unpacked` without making an installer, which is quicker for testing.

**To publish a release on GitHub:**

1. Update `"version"` in `package.json` (for example `1.1.0` → `1.2.0`) and run `npm run dist`.
2. On GitHub, open the repo's **Releases → Draft a new release**.
3. Create a tag that matches the version, such as `v1.2.0`, and give the release a title and notes.
4. Drag in **all three** files from `dist`:
   - `Sweet-Spot-Setup-1.2.0.exe`, the installer
   - `Sweet-Spot-Setup-1.2.0.exe.blockmap`, which lets updates download only what changed
   - `latest.yml`, which tells installed copies that a new version is out
5. Click **Publish release**.

### How auto-update works

Installed copies check GitHub for a newer release about 10 seconds after starting and every 6 hours, and you can check any time from **Settings → Updates**. When one is found, a card asks before doing anything:

- **Update now** downloads the new installer in the background, then offers **Restart now**. Choose **Later** and it installs the next time you quit Sweet Spot.
- If a release is missing `latest.yml`, the card offers **Download** instead, which opens the release page.
- Turn off **Check for updates automatically** in Settings to stop the checks.

Drafts and pre-releases are ignored, so you can prepare a release without anyone being prompted.

---

## Customising the look

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

## Files

```
main.js          Main process: windows, tray, panel positioning, hotkeys, start-up
auth.js          Spotify sign-in (PKCE) and encrypted token storage
discover.js      ListenBrainz (search, instant mixes, made-for-you) + Spotify match cache
artistinfo.js    Artist About info (Wikipedia + MusicBrainz) with a local cache
settings.js      Saved settings (stored in %APPDATA%\Sweet Spot\settings.json)
preload.js       Safe bridge between the windows and the main process
src/index.html   Desktop window          src/app.js      Desktop logic + player
src/flyout.html  Tray drop-down panel    src/flyout.js   Panel logic
src/toast.html   Song-change pop-up      src/panel.css/js Shared panel glass + shadow
src/mini.html    Mini-player             src/mini.js     Mini-player logic
src/themes.js    Theme presets + album-art accent colour
src/spotify.js   Spotify Web API client  src/icons.js    SVG icons
src/theme.css    Colours and fonts (edit me)
assets/          App and tray icons
build/vmp-sign.js  Installer build step that VMP-signs the app for Spotify's DRM
updater.js       Checks GitHub Releases for updates and installs them
```

---

## Credits

Sweet Spot is built on these projects and services, with thanks:

- **[Spotify Web API and Web Playback SDK](https://developer.spotify.com)**: your library, playlists, search and playback.
- **[castlabs Electron for Content Security](https://github.com/castlabs/electron-releases)** and **EVS**: Electron with Widevine DRM and free VMP signing, which make Spotify playback possible in a desktop app.
- **[Electron](https://www.electronjs.org)** and **[electron-builder](https://www.electron.build)**: the desktop app and installer.
- **[ListenBrainz](https://listenbrainz.org)** by the **[MetaBrainz Foundation](https://metabrainz.org)**: community playlists, instant mixes (LB Radio) and made-for-you playlists.
- **[MusicBrainz](https://musicbrainz.org)**: open artist data.
- **[Wikipedia](https://www.wikipedia.org)** and **[Wikidata](https://www.wikidata.org)**: artist bios.
- **[Cover Art Archive](https://coverartarchive.org)**: playlist artwork.

Sweet Spot isn't affiliated with or endorsed by Spotify or any of the above.

## Licence

[MIT](LICENSE) © 2026 zombifiedturkey
