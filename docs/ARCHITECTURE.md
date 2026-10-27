# Architecture

## Process model

```
┌─────────────────────────────┐        invoke() / events        ┌──────────────────────────┐
│ React 19 + Vite (WebView2)  │ ◄─────────────────────────────► │ Rust core (Tauri 2)      │
│  shell, rows, details,      │                                 │  command surface          │
│  settings, player console   │                                 │  addons · metadata        │
└─────────────────────────────┘                                 │  SQLite · sources         │
                                                                └────────┬─────────────────┘
                                                                         │ JSON IPC (named pipe)
                                                                         ▼
                                                                ┌──────────────────────────┐
                                                                │ mpv (separate process)   │
                                                                │ hardware decode + render │
                                                                │ paints the app window    │
                                                                └──────────────────────────┘
```

The WebView never decodes or composites video. On Windows, mpv is given `--wid=<app window>` and
paints straight into the app window's client area, so the picture is the bottom layer of the same
window the UI lives in. If no window handle is available (non-Windows), mpv opens its own window
and is still driven over IPC.

The picture is visible because the WebView above it is see-through: `lib.rs` sets the WebView2
background to alpha 0. The native window stays opaque, because window-level transparency on the
HWND that mpv presents to produced audio with no picture in an earlier attempt.

mpv's render window is created after the web view and would otherwise sit on top and swallow
every click meant for the controls. `raise_webview()` returns the `Chrome_WidgetWin*` child to
`HWND_TOP` for the first few ticks after a load. mpv draws no chrome of its own (`--osc=no
--osd-bar=no --input-vo-keyboard=no --input-default-bindings=no`); the player UI is
`src/views/Player.tsx`. Fullscreen is a direct style swap on the window handle
(`window_fullscreen` -> `set_fullscreen`), because the framework's fullscreen path can wedge the
UI thread while video is presenting into the same window.

## Modules

| File | Responsibility |
| --- | --- |
| `addons.rs` | Stremio protocol models, URL normalisation/builders, id shaping (`tt123:2:5`). Pure and tested. |
| `streams.rs` | Turns free-form addon titles into ranked stream options: quality, size, seeders, languages, HDR and cached badges, playability. Tested. |
| `meta.rs` | Cinemeta-first metadata (episodes, cast, artwork) with a TMDB-schema fallback, cast photo cache. Tested. |
| `tmdb.rs` | Optional discovery rows, search, details and IMDb to TMDB resolution when a key is set. |
| `player.rs` | mpv discovery, spawn flags, IPC connection, property observers, subtitle loading, ticker, progress persistence. |
| `torrent.rs` | One `librqbit` session per playback, metadata resolution, loopback HTTP range server, cache bound, stats and teardown. Tested parsers. |
| `debrid.rs` | Real-Debrid, AllDebrid, Premiumize and TorBox key storage, cache checks and link unrestricting. Tested parsers. |
| `trakt.rs` | Device-code auth, scrobbling, watched/progress pull and push. Tested merge helpers. |
| `nuvio_sync.rs` | Unofficial Nuvio Cloud sign-in and full pull/merge/push of profiles, progress, watched and library. Tested helpers. |
| `servers.rs` | Jellyfin and Emby sign-in, library browsing, artwork and direct stream URLs. Tested URL builders. |
| `skip.rs` | Per-show intro/outro markers and the skip decision. Tested. |
| `playback_log.rs` | Small in-memory timeline of playback steps, exposed in Settings. |
| `db.rs` | SQLite schema, migrations, WAL, queries for addons, library, progress, watched, settings, people. Tested. |
| `settings.rs` | Defaults, JSON merge patch (`null` resets a field), persistence. |
| `commands.rs` | All `#[tauri::command]` entry points, concurrent addon fan-out, source resolution, metadata merge. |
| `models.rs` | Serde shapes shared by commands and events. |
| `lib.rs` | State wiring, HTTP client, window helpers, command registration. |

## Addon and metadata flow

1. `addons_install(url)` normalises the input (`stremio://`, trailing slash, `manifest.json`),
   fetches, validates `id`/`name`, then upserts keyed by transport URL.
2. `home_feed` loads enabled addons and takes up to 4 catalogs per addon that are movie/series and
   have no required extra. One Tokio task per catalog runs in a `JoinSet`; rows are ordered by
   addon position, truncated to the configured home row limit, and duplicate names get a
   `· Movies` / `· Shows` suffix. Optional TMDB discovery rows run in parallel with a 14s cap.
3. `search` asks catalogs whose manifest advertises a `search` extra, appends TMDB results when a
   key exists, and de-duplicates by `(id, type)`.
4. `meta_details` tries Cinemeta first, then a TMDB-schema mirror for ids Cinemeta does not know.
   `tmdb:*` ids are resolved through TMDB. Cast photos are fetched separately and cached in the
   `people` table.
5. `streams` builds `{type}:{imdb}:{season}:{episode}` ids, queries every stream-capable addon in
   parallel, normalises, de-duplicates by URL or info hash, and sorts by score.
6. `subtitles` does the same for `/subtitles/...` addons.

All requests use the documented protocol shapes:

```
{base}/catalog/{type}/{id}.json
{base}/catalog/{type}/{id}/search=dune&skip=24.json
{base}/meta/{type}/{id}.json
{base}/stream/{type}/tt1234567:2:5.json
{base}/subtitles/{type}/{id}.json
```

## Source resolution

The UI turns a stream row into a playable URL in this order:

- **Direct HTTP(S):** played as-is, or routed through the connected debrid account first when one
  exists, since a host link may need unrestricting.
- **Debrid:** a magnet, info hash or supported host link is unrestricted through the connected
  account. Each provider has its own JSON parser and polling rules.
- **P2P:** requires `p2pConsent`. The selected magnet is added to a local `librqbit` session;
  the chosen file is served from a loopback HTTP endpoint that honours `Range`, so mpv can seek.
  The engine is torn down on stop, and a single torrent is active at a time.
- **Media servers:** Jellyfin and Emby items resolve to a direct `/Videos/{id}/stream` URL with
  the stored token.
- **Local files:** a path is handed to mpv directly.

## Playback lifecycle

1. The UI calls `player_open({ url, title, startAt, session })`.
2. Rust drops any existing player (terminating the old mpv), then spawns mpv with
   `--no-config --idle=yes --keep-open=no --input-ipc-server=\\.\pipe\betternuvio-<pid>-<ts>`,
   hardware decoding from settings, `--vo=gpu-next`, `--tone-mapping=bt.2390`, `--cache=yes`,
   `--sub-auto=fuzzy`, subtitle/audio language preferences, and `--wid=<app window>` on Windows.
   Logs go to the app data directory (`mpv.log`, `mpv-stderr.log`).
3. The IPC pipe is connected with a short retry loop. `observe_property` covers `time-pos`,
   `duration`, `demuxer-cache-time`, `pause`, `volume`, `mute`, `speed`, `track-list`,
   `eof-reached`, `media-title` and related fields.
4. A reader thread parses newline-delimited JSON into a shared snapshot. A ticker emits
   `player:tick` every 500ms and persists progress every 5s.
5. At 92% the title is marked watched and the progress row is kept for the Watched list. Below
   that, the position is upserted into `progress`. Continue Watching excludes rows at or above
   90% and rows already marked watched.
6. `end-file` emits `player:ended`; the UI offers or auto-plays the next episode. Closing mpv
   emits `player:closed` and the UI returns to the title.
7. Intro/outro markers are read per meta id; when the playhead enters a marked segment the UI
   seeks to its end. Markers are set manually from the player console.
8. Subtitles come from addon tracks (`sub-add`) or a file picker. Style controls and the ±10s
   delay map to mpv subtitle options; automatic sync is not implemented.

`session.key` is the resume identity: `metaId` for a film, `metaId:season:episode` for a series.

## Database

```sql
addons(url PK, addon_id, name, manifest, enabled, position, installed_at)
library(id PK, media_type, name, poster, background, added_at, meta)
progress(key PK, meta_id, media_type, name, poster, background,
         season, episode, episode_title, position, duration, updated_at)
watched(key PK, meta_id, watched, updated_at)
people(key PK, photo, checked_at)
settings(key PK, value)
```

`settings` stores the app settings under `app`, plus one JSON value each for `debrid`, `servers`,
`trakt`, `nuvio` and `skip`. WAL and `synchronous=NORMAL`; one connection behind a mutex. Every
query touches a small number of rows, so a pool would add latency, not remove it.

## Privacy and trust boundaries

- No telemetry, analytics or crash reporting is built in.
- Credential values in the local settings table are encrypted with Windows DPAPI for the current
  user before they are written, and legacy plaintext rows are upgraded when the database opens.
  A database copied to another Windows account or machine cannot be decrypted.
- The torrent HTTP endpoint binds to `127.0.0.1` on a random port. The BitTorrent TCP listener
  binds to a random port with UPnP disabled; peers still see the user's IP, which is why P2P is
  opt-in.
- Outbound requests share one reqwest client with an 18s timeout and an 8s connect timeout.

## Verification

Automated checks in CI (`windows-latest`):

```bash
bun run check
bun run build
cargo test --manifest-path src-tauri/Cargo.toml
```

The Rust unit tests cover addon URL/id building, stream parsing and ranking, metadata helpers,
SQLite round-trips, settings merge/reset, debrid and torrent parsers, Trakt and Nuvio merge
helpers, server URL builders and skip decisions.

Not covered by automated tests, and not a support guarantee: playback against real streams,
hardware decoding, HDR, P2P swarms, debrid accounts, Trakt, Nuvio sync, Jellyfin/Emby servers and
installer packaging. Those paths require accounts, servers or media that CI does not have.

## Known limits

- Windows is the supported platform. The in-window player path is Windows-specific; other
  platforms fall back to a separate mpv window and are untested.
- One mpv process and one torrent at a time.
- No updater, downloads/offline library, local profiles or PIN, translations or app icon packs.
- Torrent stats expose peers and live speed, but not a seeder count, so the engine reports 0.
- The addon implementation supports the documented catalog/meta/stream/subtitle subset. Addon
  configuration pages, addon permissions and addon collections are not implemented.
- mpv flags are explicit (`--no-config`), so a user's `mpv.conf` is ignored.
- `tmdb:*` ids need a TMDB key even to open details.
