# betterNuvio

An unofficial, performance-first desktop media hub. Rust + Tauri on the inside, React on the
outside, mpv for playback.

> **Unofficial.** betterNuvio is an independent reimplementation inspired by
> [Nuvio Desktop](https://github.com/NuvioMedia/NuvioDesktop). It is not affiliated with,
> endorsed by, or a fork of Nuvio Media in the legal sense — no upstream code was copied.
> See [NOTICE](NOTICE).

![Home](screenshots/home.png)

## Why this exists

Nuvio Desktop is Compose Multiplatform: the whole app, including a 2200-file shared UI layer,
runs on the JVM. betterNuvio rebuilds the same idea around a small Rust core and a WebView that
never touches a video frame:

- **Playback is out of process.** mpv decodes with `hwdec=auto-safe` and paints straight into the
  app window's client area, with a see-through web layer above it for the controls, and the UI
  drives it over mpv's JSON IPC. A 60 GB remux cannot stall the interface, and video never travels
  through the WebView.
- **Streams are parsed once, in Rust.** Quality, size, seeders, HDR/cached badges and ranking
  happen in a native module with unit tests, not per-render string work in JavaScript.
- **Addon fan-out is concurrent.** Catalogs, search, streams and subtitles run as parallel Tokio
  tasks with a shared pooled HTTP client, 18s timeout and per-host idle limits.
- **One local SQLite file in WAL mode** holds addons, library, per-episode progress, watched
  state and settings. No account, no telemetry, no cloud.

## What works today (v0.1)

- Addon manager for the open Stremio addon protocol: install from URL, enable/disable, remove.
- Home feed from your catalog addons, with duplicate row names disambiguated.
- Discover: every catalog from every addon, with "load more" pagination.
- Global search across addon search catalogs (+ TMDB when a key is set).
- Detail pages: backdrop, poster, rating, genres, cast, director, trailer, season tabs,
  episode list with per-episode progress.
- Source picker: quality, cached marker, size, seeders, languages, HDR/REMUX badges, addon filter.
- Playback embedded in the app window: resume per episode, seeking, speed, volume,
  audio/subtitle track switching, addon subtitles, auto-advance to the next episode,
  watched-at-92% bookkeeping. The video sits behind a transparent web layer and the custom
  `Player.tsx` overlay supplies every control; `Esc` returns to the app.
- Library, Continue Watching, local-file playback, four accent themes, mpv detection UI.
- Optional TMDB enrichment: curated rows, artwork, cast, trailers.

Not built yet: P2P/torrent streaming, debrid, Jellyfin/Emby, Trakt/Simkl/MDBList, profiles,
watch party, JS plugins, cloud sync, updater, i18n. The full audit and roadmap live in
[docs/FEATURE-PARITY.md](docs/FEATURE-PARITY.md).

## Requirements

- Windows 10/11 with WebView2 (preinstalled on Windows 11)
- [Rust](https://rustup.rs) 1.85+
- [Bun](https://bun.sh) 1.2+ (npm also works)
mpv is needed for playback. betterNuvio ships with a copy at
`src-tauri/resources/mpv/mpv.exe` (bundled into installers by `bun run tauri build`), and falls
back to an installed mpv on `PATH`, WinGet, Scoop or Program Files — or to whatever you point at
in Settings → Playback. That folder is git-ignored, so after a fresh clone either install mpv or
download a Windows build into it:

```powershell
winget install mpv
```

## Run

```bash
bun install
bun run tauri dev
```

`bun run dev` alone starts only the Vite frontend with an in-browser mock backend — useful for
UI work without Rust rebuilds.

## Build an installer

```bash
bun run tauri build
```

Artifacts land in `src-tauri/target/release/bundle/` (MSI and NSIS by default on Windows).

## Bring your own sources

betterNuvio ships no content and no scrapers. Everything comes from addon URLs you add.

1. **Metadata + catalogs:** `https://v3-cinemeta.strem.io` (one-click in Addons) gives artwork,
   descriptions and episodes.
2. **Streams:** add a stream addon that returns direct HTTP(S) URLs. Torrent-only sources are
   listed but disabled until the P2P engine lands.
3. **TMDB (optional):** put a free v3 API key in Settings → Integrations for curated rows and
   richer artwork.

Addon support follows the documented Stremio protocol: `manifest.json`, `/catalog/{type}/{id}`,
`/meta`, `/stream`, `/subtitles`, including `skip`/`search` extras and `tt123:1:2` episode ids.

## Where data lives

`%APPDATA%\app.betternuvio.desktop\betternuvio.db` on Windows (Tauri's app data dir).
Settings → About shows the exact path. Delete the file to reset everything.

## Project layout

```
src/                     React + TypeScript UI
  components/            shell, poster rows, stream drawer, primitives
  views/                 Home, Discover, Search, Details, Library, Addons, Settings, Player
  lib/bridge.ts          typed invoke() wrappers (mock fallback in browser)
  lib/store.tsx          routing, settings, library, progress, playback orchestration
src-tauri/src/
  addons.rs              protocol models, URL builders (+ tests)
  streams.rs             quality/size/seeders parsing and ranking (+ tests)
  tmdb.rs                optional discovery/enrichment
  player.rs              mpv discovery, spawn, JSON IPC, progress persistence
  db.rs                  SQLite schema and queries (+ tests)
  commands.rs            Tauri command surface
  lib.rs                 state wiring
docs/                    feature parity audit, architecture notes
```

Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Verification

```bash
bun run check     # TypeScript
bun run build     # production frontend bundle
cargo test --manifest-path src-tauri/Cargo.toml
```

The app was exercised end-to-end against the live Cinemeta addon: manifest install, catalog
rows, search, details/episodes, library persistence. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#verification-status) for what was and was not
verified on this machine.

## License

MIT for this repository's code. Nuvio Desktop is GPL-3.0; nothing from it is included here.
Metadata is provided by TMDB and the addons you install; this product uses the TMDB API but is
not endorsed or certified by TMDB.
