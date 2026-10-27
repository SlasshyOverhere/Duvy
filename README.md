# BetterNuvio

An unofficial, performance-first desktop media hub for Windows. Rust and Tauri on the inside,
React on the outside, mpv for playback.

> **Unofficial.** BetterNuvio is an independent implementation inspired by the feature set of
> [Nuvio Desktop](https://github.com/NuvioMedia/NuvioDesktop). It is not affiliated with,
> endorsed by, or a fork of Nuvio Media, and no upstream code was copied. It is also not
> affiliated with Trakt, Jellyfin, Emby, any debrid provider, or any addon author. See
> [NOTICE](NOTICE).

![Home](screenshots/home.png)

## Why this exists

Nuvio Desktop is Compose Multiplatform: the whole app, including a large shared UI layer, runs on
the JVM. BetterNuvio rebuilds the same idea around a small Rust core and a WebView that never
touches a video frame:

- **Playback is out of process.** mpv decodes with `hwdec=auto-safe` and paints into the app
  window's client area, with a transparent web layer above it for the controls. The UI drives it
  over mpv's JSON IPC. A large remux cannot stall the interface, and video never travels through
  the WebView.
- **Streams are parsed once, in Rust.** Quality, size, seeders, HDR and cached badges are ranked in
  a native module with unit tests, not per-render string work in JavaScript.
- **Addon fan-out is concurrent.** Catalogs, search, streams and subtitles run as parallel Tokio
  tasks with a shared pooled HTTP client, an 18s timeout and per-host idle limits.
- **One local SQLite file in WAL mode** holds addons, library, progress, watched state, settings
  and integration credentials. Credential values are encrypted with Windows DPAPI for the
  current user. No account is required, and there is no telemetry.

## What works now (0.1.0 beta)

- Stremio-protocol addons: install from URL, enable/disable, remove.
- Home rows from addon catalogs, Discover with filters and pagination, and global search across
  addon search catalogs plus TMDB when a key is set.
- Details: artwork, rating, genres, cast photos, director, trailer link, similar titles, seasons
  and episodes with per-episode progress.
- Search recommendations based on watch history.
- Stream picker: quality, size, seeders, cached marker, languages, HDR/REMUX badges, addon filter.
- Sources:
  - direct HTTP(S) streams;
  - local video files;
  - P2P via a local BitTorrent engine, off until you explicitly allow it in Settings;
  - debrid resolution through Real-Debrid, AllDebrid, Premiumize or TorBox keys you provide;
  - Jellyfin and Emby libraries and direct playback.
- Playback: embedded mpv, hardware decoding toggle, resume per episode, seeking, speed, volume,
  audio/subtitle track switching, addon subtitles, local subtitle files, subtitle styling (size,
  colour, background) and delay, auto-advance, and watched-at-92% bookkeeping.
- Manual per-show intro/outro markers that auto-skip while playing.
- Library, Continue Watching, Watched, four accent themes, custom title bar.
- Optional TMDB enrichment, Trakt device-code sync and scrobbling, and unofficial Nuvio Cloud
  sync for library, progress and watched state.

Not built yet: downloads/offline library, local profiles or PIN-protected profile switching
(only Nuvio account profile selection exists), app icon packs, translations, an auto-updater,
Simkl, MDBList, watch party, JS plugins, hover previews, subtitle auto-sync, and subtitle
folder scanning. See
[docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md) for the per-feature status.

## Requirements

- Windows 10 or 11, x64, with WebView2 (preinstalled on Windows 11)
- [Rust](https://rustup.rs) 1.85 or newer
- [Bun](https://bun.sh) 1.2 or newer

Windows installers bundle mpv, so no separate player install is needed. A source checkout does
not contain mpv: `src-tauri/resources/mpv/` is git-ignored. Either install mpv or put a Windows
build at `src-tauri/resources/mpv/mpv.exe`:

```powershell
winget install mpv
```

BetterNuvio looks for mpv at an explicit path from Settings first, then the bundled resource
directory, then `PATH`, WinGet, Scoop and the usual Program Files locations.

## Setup

```bash
bun install
bun run app        # desktop app (Tauri dev)
```

For UI work without Rust rebuilds:

```bash
bun run dev        # Vite only, with an in-browser mock backend
```

## Checks

```bash
bun run check      # tsc --noEmit
bun run build      # tsc && vite build
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs those three commands on Windows. Interactive playback and third-party services are not
covered by automated tests.

## Build an installer

```bash
bun run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/`. On Windows the configured targets produce
MSI and NSIS installers, and both include `mpv.exe` and `d3dcompiler_43.dll`. Installers are not
built by CI.

## Bring your own content

BetterNuvio ships no media, no catalogs, no addons and no scrapers. Everything comes from addon
URLs you add, servers you connect, or files you open.

1. **Metadata and catalogs:** `https://v3-cinemeta.strem.io` (one-click in Addons) gives artwork,
   descriptions and episodes.
2. **Streams:** add a stream addon that returns HTTP(S) links, magnets or info hashes. Torrent
   sources stay disabled until P2P is allowed in Settings.
3. **Debrid (optional):** add a Real-Debrid, AllDebrid, Premiumize or TorBox API key. Links are
   unrestricted through your account.
4. **TMDB (optional):** add a free v3 API key for curated rows and richer artwork.
5. **Trakt (optional):** create your own Trakt API application and enter its client id and secret.
6. **Nuvio Cloud (optional, unofficial):** sign in with a Nuvio account to sync library, progress
   and watched state. This talks to the same backend the official apps use and may break without
   notice.

Addon support follows the documented Stremio protocol: `manifest.json`,
`/catalog/{type}/{id}`, `/meta`, `/stream`, `/subtitles`, including `skip`/`search` extras and
`tt123:1:2` episode ids.

You are responsible for the addons, servers, accounts and sources you configure, and for
complying with the law and the terms of those services where you live. P2P playback makes your IP
address visible to the swarm. Debrid accounts have their own terms.

## Privacy and local data

- Everything is stored locally in one SQLite file. There is no telemetry, analytics or crash
  reporting.
- Credentials (TMDB key, Trakt tokens, debrid keys, Jellyfin/Emby tokens, Nuvio session) are kept
  in the local settings table. Each value is encrypted with Windows DPAPI for the current user
  before it is written, so a copy of the database cannot be read by another Windows account or
  on another machine. The app can still read them while you are signed in, so treat the data
  directory like any other credential store.
- Network requests go to the addons you install, image hosts, and the optional services you
  configure (TMDB, Trakt, Nuvio, debrid, Jellyfin/Emby). Addon developers and service operators
  see requests from your IP.
- P2P traffic goes directly to other peers while a torrent source is playing.
- Signing out of Trakt or Nuvio removes the stored tokens; Nuvio keeps a non-secret account
  identifier so a later sign-in can tell accounts apart. Deleting the database resets everything.

## Where data lives

`%APPDATA%\app.betternuvio.desktop\betternuvio.db` on Windows. The same folder holds `mpv.log`,
`mpv-stderr.log` and the temporary `torrent-cache` directory. Settings -> About shows the exact
data path. Delete the database file to reset the app.

## Project layout

```
src/                     React + TypeScript UI
  components/            shell, title bar, poster rows, stream drawer, player UI
  views/                 Home, Discover, Search, Details, Library, Watched, Addons, Settings, Player
  views/settings/        Nuvio sync and media server panels
  lib/bridge.ts          typed invoke() wrappers (mock fallback in browser)
  lib/store.tsx          routing, settings, library, progress, playback orchestration
src-tauri/src/
  addons.rs              protocol models, URL builders (+ tests)
  streams.rs             quality/size/seeders parsing and ranking (+ tests)
  meta.rs                Cinemeta-first metadata and cast photos (+ tests)
  tmdb.rs                optional discovery/enrichment (+ tests)
  player.rs              mpv discovery, spawn, JSON IPC, subtitle loading, progress
  torrent.rs             librqbit session and loopback HTTP stream (+ tests)
  debrid.rs              four debrid providers and link resolution (+ tests)
  trakt.rs               device auth, scrobble and watched sync (+ tests)
  nuvio_sync.rs          unofficial Nuvio Cloud sync (+ tests)
  servers.rs             Jellyfin/Emby sign-in, libraries and streams (+ tests)
  skip.rs                intro/outro markers (+ tests)
  db.rs                  SQLite schema and queries (+ tests)
  commands.rs            Tauri command surface
  lib.rs                 state wiring, window helpers
docs/                    architecture, feature parity, feature scope
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## License

MIT for this repository's code. BetterNuvio is not affiliated with Nuvio Media, and nothing from
Nuvio Desktop (GPL-3.0) is included here.

Windows bundles include a Windows build of mpv, which is free software under GPL-2.0-or-later,
plus Microsoft's `d3dcompiler_43.dll`. The bundled mpv reports version
`v0.41.0-1227-ge471496c5`; its source is published by the mpv project at
<https://github.com/mpv-player/mpv>. See [NOTICE](NOTICE) for the exact disclosure and licenses.

Metadata is provided by the addons you install and, optionally, TMDB. This product uses the TMDB
API but is not endorsed or certified by TMDB.
