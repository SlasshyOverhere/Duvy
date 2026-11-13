# Architecture

## Process model

```
┌─────────────────────────────┐        invoke() / events        ┌──────────────────────────┐
│ React 19 + Vite (WebView2)  │ ◄─────────────────────────────► │ Rust core (Tauri 2)      │
│  shell, rows, details,      │                                 │  command surface          │
│  settings, player console   │                                 │  addons · metadata        │
└─────────────────────────────┘                                 │  SQLite · sources         │
                                                                └────────┬─────────────────┘
                                                                         │ libmpv handle
                                                                         ▼
                                                                ┌──────────────────────────┐
                                                                │ libmpv (in-process)      │
                                                                │ hardware decode + render │
                                                                │ paints the app window    │
                                                                └──────────────────────────┘
```

The WebView never decodes or composites video. libmpv renders straight into the app window's
client area (`--wid=<app window>` on Windows), so the picture is the bottom layer of the same
window the UI lives in. Without a window handle (non-Windows) libmpv opens its own window.

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

Playback runs in-process through libmpv, so there is no separate player to find or download.
`scripts/fetch-libmpv.ps1` pulls `libmpv-2.dll` and builds the MSVC import library once per
checkout into `src-tauri/libmpv/`, and the build bundles both with the installer.

## Frontend layout

```
src/views/            Home, Search, Details, Library, Watched, Addons, Debrid, Torrent,
                      Onboarding, Player, Settings
src/views/settings/   media servers, sync panels, updates
src/components/       shell, title bar, poster rows, stream drawer, player HUD
src/components/player/ HUD styles and skip helpers
src/lib/bridge.ts     typed invoke() wrappers (mock fallback in browser)
src/lib/store.tsx     routing, settings, library, progress, playback orchestration
src/lib/telemetry.ts  opt-in crash reports, scrubbing rules and the playback watchdog
```

## Modules

| File | Responsibility |
| --- | --- |
| `addons.rs` | Addon protocol models, URL normalisation/builders, id shaping (`tt123:2:5`). Pure and tested. |
| `streams.rs` | Turns free-form addon titles into ranked stream options: quality, size, seeders, languages, HDR and cached badges, playability. Tested. |
| `meta.rs` | Cinemeta-first metadata (episodes, cast, artwork) with a TMDB-schema fallback, cast photo cache. Tested. |
| `tmdb.rs` | Optional discovery rows, search, details and IMDb to TMDB resolution when a key is set. |
| `player.rs` | libmpv handle, player options and cache buffers, property observers, first-frame gate, subtitle styling, ticker, progress persistence. |
| `debrid.rs` | Real-Debrid, AllDebrid, Premiumize and TorBox key storage, cache checks, link unrestricting and pack-file selection. Tested parsers. |
| `trakt.rs` | Device-code auth, scrobbling, watched/progress pull and push. Tested merge helpers. |
| `*_sync.rs` | Cloud-account and addon-account sync: sign-in and pull/merge/push of profiles, progress, watched, library and addon collections, merged by normalised manifest URL. Tested helpers. |
| `servers.rs` | Jellyfin and Emby sign-in, library browsing, artwork and direct stream URLs. Tested URL builders. |
| `skip.rs` | IntroDB lookup, per-show manual intro/outro markers and the skip decision. Tested. |
| `playback_log.rs` | Playback timeline written to `playback.log` beside the database (capped), exposed in Settings. Tested. |
| `updates.rs` | Launch and hourly release checks, a cached answer for an instant corner card, signature-verified download and install on request. |
| `frame.rs` | Seek-bar previews from a scratch in-process libmpv into the system temp folder, bucketed and capped. |
| `db.rs` | SQLite schema, migrations, WAL, queries for addons, library, progress, watched, settings, people. Tested. |
| `settings.rs` | Defaults, JSON merge patch (`null` resets a field), persistence and the in-memory settings cache. |
| `secret.rs` | DPAPI `enc1:` encoding for stored credentials, with legacy plaintext pass-through. |
| `json.rs` | Small readers for untrusted JSON returned by account APIs. |
| `commands.rs` | All `#[tauri::command]` entry points, concurrent addon fan-out with budgets, source resolution, metadata merge. |
| `models.rs` | Serde shapes shared by commands and events. |
| `lib.rs` | State wiring, HTTP client, window helpers, background jobs (updates, Cinemeta seeding), command registration. |

## Addon and metadata flow

1. `addons_install(url)` normalises the input (custom scheme, trailing slash, `manifest.json`),
   fetches, validates `id`/`name`, then upserts keyed by transport URL. Cinemeta is seeded through
   the same path on first launch, so a fresh install has metadata without setup.
2. `home_feed` loads enabled addons and takes up to 4 catalogs per addon that are movie/series and
   have no required extra. One Tokio task per catalog runs in a `JoinSet`; rows are ordered by
   addon position, truncated to the configured home row limit, and duplicate names get a
   `· Movies` / `· Shows` suffix. Optional TMDB discovery rows run in parallel with a 14s cap.
3. `search` asks catalogs whose manifest advertises a `search` extra, appends TMDB results when a
   key exists, and de-duplicates by `(id, type)`. Addon results are emitted as `search:addons` as
   each catalog answers, so the grid fills progressively instead of waiting for the slowest.
4. `meta_details` tries Cinemeta first, then a TMDB-schema mirror for ids Cinemeta does not know.
   `tmdb:*` ids are resolved through TMDB. Cast photos are fetched separately and cached in the
   `people` table.
5. `streams` builds `{type}:{imdb}:{season}:{episode}` ids, queries every stream-capable addon in
   parallel, normalises, de-duplicates by URL or info hash, and sorts by score.
6. `subtitles` does the same for `/subtitles/...` addons.

A disabled addon is off, not merely hidden: every fan-out filters on `enabled`, so the app stops
asking it for catalogs, metadata, streams and subtitles. The switch lives on the addon card and
only user-installed addons get one; Cinemeta is seeded by default and stays on.

Fan-out is bounded: each catalog, meta and stream task has its own budget, so one slow or dead
addon cannot hold a screen. Commands read settings through `settings::load_cached` instead of a
SQLite query each, and playback progress writes are merged rather than issued per tick.

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
  account. Each provider has its own JSON parser and polling rules. Torrent rows play through
  debrid only; without a connected account they are reported as unplayable.
- **Media servers:** Jellyfin and Emby items resolve to a direct `/Videos/{id}/stream` URL with
  the stored token.
- **Local files:** a path is handed to the player directly.

## Playback lifecycle

1. The UI opens the player route first and calls `player_open({ url, title, startAt, session })`
   once the source resolves. While it waits, the start screen shows the title backdrop and logo.
2. Rust drops any existing player (destroying the old libmpv handle), then opens a new one with
   `no-config`, `idle=yes`, `keep-open=no`, hardware decoding from settings, `vo=gpu-next`,
   `tone-mapping=bt.2390`, `cache=yes`, `demuxer-max-bytes` / `demuxer-max-back-bytes` from the
   buffer settings, `network-timeout=60`, `stream-lavf-o` HTTP reconnect, `cache-pause-wait=5`,
   `sub-auto=fuzzy`, subtitle/audio language preferences, and `wid=<app window>` on Windows. Logs
   go to the app data directory (`mpv.log`, `mpv-stderr.log`).
3. The handle is opened with a short retry loop. `observe_property` covers `time-pos`,
   `duration`, `demuxer-cache-time`, `paused-for-cache`, `pause`, `volume`, `mute`, `speed`,
   `track-list`, `eof-reached`, `media-title` and related fields. The snapshot reports `started`
   only after the first frame, so the UI never uncovers a black surface, and `buffering` while
   mpv waits for the network. On `file-loaded` and `video-reconfig` the snapshot also takes the
   stream's own shape from `video-params`: resolution, aspect, frame rate, bitrate and codec.
4. Property events update a shared snapshot. A ticker emits `player:tick` every 500ms and
   persists progress every 5s.
5. At 92% the title is marked watched and the progress row is kept for the Watched list. Below
   that, the position is upserted into `progress`. Continue Watching excludes rows at or above
   90% and rows already marked watched.
6. `end-file` emits `player:ended`; the UI offers or auto-plays the next episode. A stream that
   dies with an error is reloaded once from the same position; if that fails, the UI re-resolves
   the source from its addon (debrid links expire) and reopens once more before surfacing the
   failure. Closing mpv emits `player:closed` and the UI returns to the title.
7. Recap/intro/outro markers are read per meta id. Manual markers win; when none are stored, the UI
   asks IntroDB for community timestamps (`skip_lookup`) and caches the result. While the playhead
   sits inside a marked segment the UI offers a skip button, and at the outro marker the up-next
   card takes over.
8. Subtitles come from addon tracks (`sub-add`), a file picker, or the track remembered for that
   episode. Style controls map to mpv subtitle properties and are persisted globally; an ASS track
   keeps its own styling until a control is touched. The delay is ±60s in 0.1s steps. Automatic
   sync is not implemented.

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
`trakt`, the sync accounts and `skip`. WAL and `synchronous=NORMAL`; one connection behind a
mutex. Every query touches a small number of rows, so a pool would add latency, not remove it.
Settings are cached in memory (`settings::load_cached`) and invalidated on write, so commands do
not read SQLite per call.

## Privacy and trust boundaries

- No analytics or usage tracking is built in. Crash reports are opt-in and off by default; they
  only exist in a release build that was compiled with a Sentry DSN, and the user is asked once,
  after onboarding, with the same switch in Settings -> Privacy. The UI loads the Sentry SDK only
  after consent. `errors.ts` scrubs the event before it leaves: links lose their query and
  fragment, magnets are redacted, home paths lose the account name, secret-shaped keys are
  blanked, payloads are truncated, duplicates are dropped and a session is capped. Any replay is
  masked and media is blocked. A Rust panic is forwarded as `app:error` and reported the same way;
  `playback.log` stays local in every build.
- Credential values in the local settings table are encrypted with Windows DPAPI for the current
  user before they are written, and legacy plaintext rows are upgraded when the database opens.
  A database copied to another Windows account or machine cannot be decrypted. The app can still
  read them while the user is signed in, so the data directory is a credential store.
- Disconnecting Trakt revokes the token best effort and clears it locally, keeping the API app
  credentials so a reconnect does not need a re-paste. Signing out of an account session clears
  the stored tokens; the cloud sync keeps a non-secret account id so a later sign-in can tell
  accounts apart.
- Addon URLs are validated and response bodies are bounded before parsing. The WebView runs under
  a strict CSP (`default-src 'self'`, no frames or objects, images and media limited to the
  schemes the UI needs).
- Outbound requests share one reqwest client with an 18s timeout and an 8s connect timeout, with
  tighter per-command budgets where a screen must not wait.
- Updates are checked against GitHub and installed only after the updater signature verifies.
- Skip lookups send an IMDb id plus season/episode to IntroDB. Account sync talks to each
  provider's official backend using the user's own session.

## Verification

Automated checks in CI (`windows-latest`):

```bash
bun run check
bun run build
bun run test
cargo test --manifest-path src-tauri/Cargo.toml
```

`bun run test` runs three script suites: `player.check.ts` guards the player HUD layout and
control wiring, `regression.check.ts` guards the updater and player lifecycle wiring, and
`telemetry.check.ts` guards crash-report scrubbing, deduplication and the playback watchdog.

The Rust unit tests cover addon URL/id building, stream parsing and ranking, metadata helpers,
SQLite round-trips, settings merge/reset, debrid parsers, Trakt and account-sync merge
helpers, server URL builders, IntroDB segment mapping and skip decisions.

Not covered by automated tests, and not a support guarantee: playback against real streams,
hardware decoding, HDR, debrid accounts, Trakt and account sync, Jellyfin/Emby
servers and installer packaging. Those paths require accounts, servers or media that CI does not
have.

## Known limits

- Windows is the supported platform. The in-window player path is Windows-specific; other
  platforms fall back to libmpv's own window and are untested.
- One player and one torrent at a time.
- No downloads/offline library, local profiles or PIN, translations, app icon packs or a
  dedicated Discover browser.
- Crash reports need a release build with a Sentry DSN; a local build has no endpoint and sends
  nothing even when reports are switched on.
- Intro/outro skipping is a button, never automatic, and only recap, intro and outro segments are
  understood (no credits or post-credits taxonomy).
- Torrent stats expose peers and live speed, but not a seeder count, so the engine reports 0.
- The addon implementation supports the documented catalog/meta/stream/subtitle subset. Addon
  configuration pages, addon permissions and addon collections are not implemented.
- Player options are explicit (`no-config`), so a user's `mpv.conf` is ignored.
- `tmdb:*` ids need a TMDB key even to open details.
