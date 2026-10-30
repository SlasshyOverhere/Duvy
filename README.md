# Duvy

A lightweight desktop media hub for Windows: addons, library and playback in one fast window.

[![CI](https://github.com/SlasshyOverhere/Duvy/actions/workflows/ci.yml/badge.svg)](https://github.com/SlasshyOverhere/Duvy/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **Independent.** Duvy is an independent project. It is not affiliated with Trakt,
> Jellyfin, Emby, any debrid provider, or any addon author. See [NOTICE](NOTICE).

![Duvy home screen](docs/home.jpg)

## Why this exists

Most desktop media hubs run the whole app, including a large shared UI layer, on one runtime.
Duvy takes a different route: a small Rust core and a WebView that never touches a video
frame:

- **Playback is in-process.** libmpv decodes with `hwdec=auto-safe` and paints into the app
  window's client area, with a transparent web layer above it for the controls. The UI calls
  libmpv directly, so there is no player process, no IPC socket and no protocol between them. A
  large remux cannot stall the interface, and video never travels through the WebView.
- **Streams are parsed once, in Rust.** Quality, size, seeders, HDR and cached badges are ranked in
  a native module with unit tests, not per-render string work in JavaScript.
- **Addon fan-out is concurrent.** Catalogs, search, streams and subtitles run as parallel Tokio
  tasks with a shared pooled HTTP client, an 18s timeout and per-host idle limits.
- **One local SQLite file in WAL mode** holds addons, library, progress, watched state, settings
  and integration credentials. Credential values are encrypted with Windows DPAPI for the
  current user. No account is required, and there is no telemetry.

## What works now (0.1.0 beta)

- First-run onboarding: choose a sync account or skip it; playback needs no setup.
- Addon protocol: install from URL, reorder, refresh, open the addon's configure page when it
  advertises one, enable/disable and remove. Cinemeta is installed on first launch.
- Home rows from addon catalogs, an auto-rotating art-led hero, drag-to-scroll rows, poster
  context menus and Continue Watching that updates live.
- Global search across addon search catalogs plus TMDB when a key is set. Addon results stream in
  as each one answers, and the last eight searches are kept as chips.
- Details: artwork and title logos, rating, genres, cast photos, director, trailer link, similar
  titles, seasons and episodes with per-episode progress.
- Search recommendations based on watch history.
- Stream picker: quality, size, seeders, cached marker, languages, HDR/REMUX badges, addon filter,
  copy link and open in browser.
- Sources:
  - direct HTTP(S) streams;
  - local video files;
  - P2P via a local BitTorrent engine, off until you explicitly allow it in Settings;
  - debrid resolution through Real-Debrid, AllDebrid, Premiumize or TorBox keys you provide,
    including the requested file inside a torrent pack;
  - Jellyfin and Emby libraries and direct playback.
- Playback: embedded libmpv, hardware decoding toggle, configurable forward and backward cache
  buffers, resume per episode, seeking, speed, volume, audio/subtitle track switching, addon
  subtitles, local subtitle files, subtitle styling (size, bold, colour, outline, background,
  position) and delay, auto-advance, and watched-at-92% bookkeeping.
- Subtitle choices are remembered per episode, and ASS tracks keep their own styling until you
  change a style control.
- Intro and outro skipping from IntroDB community markers, with manual per-show markers that win.
- Library, Continue Watching, Watched, four accent themes, custom title bar.
- Optional TMDB enrichment, Trakt device-code sync and scrobbling, plus optional cloud and
  addon-account sync for library, progress and resume points.
- Settings with grouped navigation and search: player path, cache buffers, language pickers,
  connections and updates.
- Signed, verified updates: the app checks the release feed on launch and every six hours, warns
  with a toast and a desktop notification, and installs from Settings -> Update.

Not built yet: downloads/offline library, local profiles or PIN-protected profile switching
(only cloud-account profile selection exists), a dedicated Discover browser (browse through Home
and Search), app icon packs, translations, update channels, Simkl, MDBList, watch party, JS
plugins, hover previews, subtitle auto-sync, subtitle folder scanning and crash reporting. See
[docs/FEATURES.md](docs/FEATURES.md) for the per-feature status and
[docs/ROADMAP.md](docs/ROADMAP.md) for what is planned.

## Requirements

- Windows 10 or 11, x64, with WebView2 (preinstalled on Windows 11)
- [Rust](https://rustup.rs) 1.85 or newer
- [Bun](https://bun.sh) 1.2 or newer

Playback runs on libmpv loaded into the app process. The import library and the runtime DLL live
in `src-tauri/libmpv/`, which is not committed; fetch them once per checkout:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/fetch-libmpv.ps1
```

Installers bundle `libmpv-2.dll` next to the executable, so a released app needs no download and
no separate player install. The bundled build's license is a shipping decision: see
[NOTICE](NOTICE).

## Setup

```bash
bun install
bun run app        # desktop app (Tauri dev)
```

The first launch shows onboarding; playback is ready as soon as the app opens.

For UI work without Rust rebuilds:

```bash
bun run dev        # Vite only, with an in-browser mock backend
```

Development builds use the `app.duvy.desktop.dev` identifier, so their database and
downloaded player live beside, not inside, a production install.

## Checks

```bash
bun run check      # tsc --noEmit
bun run build      # tsc && vite build
bun run test       # player HUD regression checks
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs `check`, `build`, `test` and the Rust tests on Windows. Interactive playback and
third-party services are not covered by automated tests.

## Releasing

Releases are built and published by CI only. Push a tag and `.github/workflows/release.yml` does
the rest: it sets the version from the tag, builds the MSI and NSIS installers, signs the updater
bundles, publishes the GitHub release and uploads `latest.json` (the manifest the in-app updater
reads). The installers carry `libmpv-2.dll` beside the executable, so playback works offline.

```bash
git tag v1.0.0
git push origin v1.0.0
```

One-time setup: the workflow signs with a minisign key that has to match
`plugins.updater.pubkey` in `src-tauri/tauri.conf.json`. Add the private key as a repository
secret:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/duvy.key
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is only needed if the key has a password. Keep the key safe:
lose it and every install already in the wild can no longer verify updates.

The installer takes `src-tauri/libmpv/libmpv-2.dll` and places it next to the executable. Run
`scripts/fetch-libmpv.ps1` before a local build; the file is not committed.

A local `bun run tauri build` still works for smoke tests, but it needs the same key
(`TAURI_SIGNING_PRIVATE_KEY_PATH`) and its artifacts are never published.

## Bring your own content

Duvy ships no media, no catalogs, no addons and no scrapers. Everything comes from addon
URLs you add, servers you connect, or files you open.

1. **Metadata and catalogs:** Cinemeta is installed on first launch and gives artwork,
   descriptions and episodes. Add more from the Addons panel.
2. **Streams:** add a stream addon that returns HTTP(S) links, magnets or info hashes. Torrent
   sources stay disabled until P2P is allowed in Settings.
3. **Debrid (optional):** add a Real-Debrid, AllDebrid, Premiumize or TorBox API key. Links are
   unrestricted through your account.
4. **TMDB (optional):** add a free v3 API key for curated rows and richer artwork.
5. **Trakt (optional):** create your own Trakt API application and enter its client id and secret.
6. **Cloud sync (optional, best effort):** sign in with a supported account to sync library,
   progress and watched state. It talks to that provider's backend and may break without notice.
7. **Addon-account sync (optional, best effort):** sign in to pull addons, library and resume
   points from an existing addon client account, and push local changes back. It uses that
   provider's API and may break without notice.

Addon support follows the documented addon protocol: `manifest.json`,
`/catalog/{type}/{id}`, `/meta`, `/stream`, `/subtitles`, including `skip`/`search` extras and
`tt123:1:2` episode ids.

You are responsible for the addons, servers, accounts and sources you configure, and for
complying with the law and the terms of those services where you live. P2P playback makes your IP
address visible to the swarm. Debrid accounts have their own terms.

## Privacy and local data

- Everything is stored locally in one SQLite file. There is no telemetry, analytics or crash
  reporting.
- Credentials (TMDB key, Trakt tokens, debrid keys, Jellyfin/Emby tokens, sync sessions) are kept
  in the local settings table. Each value is encrypted with Windows DPAPI for the current user
  before it is written (existing plaintext rows are upgraded on the next launch), so a copy of
  the database cannot be read by another Windows account or on another machine. The app can still
  read them while you are signed in, so treat the data directory like any other credential store.
- Network requests go to the addons you install, image hosts, the optional services you configure
  (TMDB, Trakt, debrid, Jellyfin/Emby, sync accounts), IntroDB for skip markers, GitHub for the
  first-run player download and the update feed. Addon developers and service operators see
  requests from your IP.
- Skip lookups send only an IMDb id plus season and episode to IntroDB. Addon URLs are validated
  and fetches are bounded, and the WebView runs under a strict Content Security Policy.
- P2P traffic goes directly to other peers while a torrent source is playing.
- Signing out of Trakt or a sync account removes the stored tokens; the cloud integration keeps a
  non-secret account identifier so a later sign-in can tell accounts apart. Deleting the database
  resets everything.

## Where data lives

`%APPDATA%\app.duvy.desktop\duvy.db` on Windows. The same folder holds `mpv.log`, the temporary
`torrent-cache` directory. Seek-bar previews decode into the system temp folder and are removed
when they expire. Delete the database file to reset the app.

Development builds use `%APPDATA%\app.duvy.desktop.dev`, so they never touch production
data.

## Project layout

```
src/                     React + TypeScript UI
  components/            shell, title bar, poster rows, stream drawer
  components/player/     player HUD styles and skip helpers
  views/                 Home, Search, Details, Library, Watched, Addons, Onboarding, Player
  views/settings/        media servers, account sync panels, updates
  lib/bridge.ts          typed invoke() wrappers (mock fallback in browser)
  lib/store.tsx          routing, settings, library, progress, playback orchestration
src-tauri/src/
  addons.rs              protocol models, URL builders (+ tests)
  streams.rs             quality/size/seeders parsing and ranking (+ tests)
  meta.rs                Cinemeta-first metadata and cast photos (+ tests)
  tmdb.rs                optional discovery/enrichment (+ tests)
  player.rs              libmpv lifecycle, commands, events, subtitle loading, progress
  torrent.rs             librqbit session and loopback HTTP stream (+ tests)
  debrid.rs              four debrid providers and link resolution (+ tests)
  trakt.rs               device auth, scrobble and watched sync (+ tests)
  servers.rs             Jellyfin/Emby sign-in, libraries and streams (+ tests)
  skip.rs                IntroDB lookup, manual markers, skip decision (+ tests)
  updates.rs             update checks, background polling, install
  settings.rs            defaults, merge patch, cached load
  secret.rs              DPAPI credential encoding
  frame.rs               seek-bar preview frames
  playback_log.rs        in-memory playback timeline
  db.rs                  SQLite schema and queries (+ tests)
  commands.rs            Tauri command surface
  lib.rs                 state wiring, window helpers, background jobs
scripts/                 player HUD regression checks
docs/                    architecture, features, roadmap
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Contributing

Issues and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) for the setup,
checks and commit conventions, and [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) for the ground rules.
Security problems go through [SECURITY.md](SECURITY.md), not the public issue tracker.

## License

MIT for this repository's code. Duvy is an independent implementation; no third-party
client code is included here.

Installers bundle a Windows build of libmpv, which also contains FFmpeg, libplacebo and other
libraries, each under its own license. The build fetched by `scripts/fetch-libmpv.ps1` is
GPL-2.0-or-later; shipping it inside a closed-source installer requires either a libmpv built with
`--enable-lgpl` or GPL compliance for the distributed work. See [NOTICE](NOTICE) for the exact
disclosure and licenses.

Metadata is provided by the addons you install and, optionally, TMDB. This product uses the TMDB
API but is not endorsed or certified by TMDB.
