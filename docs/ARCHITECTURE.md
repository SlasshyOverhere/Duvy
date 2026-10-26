# Architecture

## Process model

```
┌─────────────────────────────┐        invoke() / events        ┌──────────────────────────┐
│ React 19 + Vite (WebView2)   │ ◄─────────────────────────────► │ Rust core (Tauri 2)      │
│  shell, rows, details,      │                                 │  command surface          │
│  settings, player console   │                                 │  addon client · TMDB      │
└─────────────────────────────┘                                 │  SQLite · stream ranking  │
                                                                └────────┬─────────────────┘
                                                                         │ JSON IPC (named pipe)
                                                                         ▼
                                                                ┌──────────────────────────┐
                                                                │ mpv (separate process)    │
                                                                │ hardware decode + render  │
                                                                │ paints the app window     │
                                                                └──────────────────────────┘
```

The WebView never decodes or composites video. mpv is given `--wid=<app window>` and paints its
picture straight into the app window's client area, so the video is the bottom layer of the same
window the UI lives in. There is no separate player window and no surface to move around.

The picture is only visible because the WebView above it is see-through: `lib.rs` calls
`window.set_background_color(Color(0, 0, 0, 0))`, which sets the WebView2 controller's default
background to alpha 0. The window itself stays opaque, which matters because a `transparent: true`
Tauri window uses `DwmEnableBlurBehindWindow` on the very HWND mpv presents to; an earlier attempt
at window-level transparency produced audio with no picture.

Because mpv's render window is created after the web view, it lands on top of it and would eat
every click meant for the controls. `raise_webview()` returns the `Chrome_WidgetWin*` child to
`HWND_TOP` for the first few ticks after a load so the React controls stay on top of the video.
mpv's own UI is switched off (`--osc=no --osd-bar=no --input-vo-keyboard=no`): the entire player
chrome is `src/views/Player.tsx`.

## Modules

| File | Responsibility |
| --- | --- |
| `addons.rs` | Stremio protocol models, URL normalisation/builders, id shaping (`tt123:2:5`). Pure + tested. |
| `streams.rs` | Turns free-form addon titles into ranked `StreamOption`s: quality, size, seeders, languages, HDR/cached badges, playability. Tested. |
| `tmdb.rs` | Optional discovery rows, multi-search, details (credits, videos, external ids) and IMDb→TMDB resolution. |
| `player.rs` | mpv discovery (bundled resource dir, `where mpv`, WinGet/Scoop/Program Files), spawn with explicit flags (`--wid` on the app window), pipe connection with retry, property observers, command dispatch, ticker + progress persistence. |
| `db.rs` | SQLite schema, WAL, queries for addons/library/progress/watched/settings. |
| `commands.rs` | All `#[tauri::command]` entry points, fan-out with `JoinSet`, metadata merge logic. |
| `models.rs` | Serde shapes shared by commands and events. |
| `settings.rs` | Defaults, JSON merge patch (`null` resets a field), persistence. |

## Addon request flow

1. `addons_install(url)` normalises the input (`stremio://`, trailing slash, `manifest.json`),
   fetches, validates `id`/`name`, then upserts keyed by transport URL.
2. `home_feed` reads enabled addons, takes up to 4 non-required-extra catalogs per addon and
   spawns one task per catalog. Rows are ordered by addon position, then truncated to
   `homeRowsLimit`. Duplicate titles get a `· Movies` / `· Series` suffix.
3. `search` only asks catalogs whose manifest advertises a `search` extra; TMDB results are
   appended when a key exists; results are de-duplicated by `(id, type)`.
4. `meta_details` resolves the id through the first metadata addon that supports it. `tmdb:*`
   ids are resolved through TMDB and enriched with addon episodes when an IMDb id exists.
5. `streams` builds `{type}:{imdb}:{season}:{episode}` ids, queries every stream-capable addon in
   parallel, normalises, de-duplicates by URL/infoHash, sorts by score.
6. `subtitles` does the same for `/subtitles/...` addons.

All URLs use the documented protocol shapes:

```
{base}/catalog/{type}/{id}.json
{base}/catalog/{type}/{id}/search=dune&skip=24.json
{base}/meta/{type}/{id}.json
{base}/stream/{type}/tt1234567:2:5.json
{base}/subtitles/{type}/{id}.json
```

## Playback lifecycle

1. UI resolves the title/stream and calls `player_open({ url, title, startAt, session })`.
2. Rust drops any existing `Player` (which terminates the old mpv), spawns mpv with
   `--input-ipc-server=\\.\pipe\betternuvio-<pid>-<ts> --no-config --idle=yes --wid=<app window>
   --osc=no --vo=gpu-next --tone-mapping=bt.2390 --hwdec=auto-safe --cache=yes
   --sub-auto=fuzzy --log-file=<appdata>/mpv.log`, then connects to the pipe with a 3s retry loop.
3. mpv fills the window client area with the picture and draws no chrome of its own; the player
   route renders transparent and `Player.tsx` supplies the controls. `Esc` is bound to `quit` in
   mpv; the app returns to the title when mpv exits. Fullscreen is a direct style swap on the
   window handle (`window_fullscreen` → `set_fullscreen`), because the framework's fullscreen
   flag can wedge the UI thread while video is presenting into the same window.
4. It registers `observe_property` for `time-pos`, `duration`, `demuxer-cache-time`, `pause`,
   `volume`, `mute`, `speed`, `track-list`, `eof-reached`, `media-title` and issues
   `loadfile ... start=N`.
5. A reader thread parses newline-delimited JSON and updates the shared snapshot. A ticker
   thread emits `player:tick` every 500ms and, every 5s, writes progress.
6. At ≥92% the title is marked watched and its progress row is cleared; otherwise the position
   is upserted into `progress`.
7. `end-file` emits `player:ended`; the UI offers/auto-plays the next episode. Closing mpv emits
   `player:closed` and the UI navigates back to the title.

`session.key` is the resume identity: `metaId` for a film, `metaId:season:episode` for a series.

## Database

```sql
addons(url PK, addon_id, name, manifest, enabled, position, installed_at)
library(id PK, media_type, name, poster, background, added_at, meta)
progress(key PK, meta_id, media_type, name, poster, background,
         season, episode, episode_title, position, duration, updated_at)
watched(key PK, meta_id, watched, updated_at)
settings(key PK, value)          -- one JSON row, key = 'app'
```

WAL + `synchronous=NORMAL`; one connection behind a mutex. Every query touches a handful of
rows, so a pool would add latency, not remove it.

## Performance notes (design, not benchmarked)

- Video decode/render is out of process; the UI thread only paints lists.
- Addon requests are concurrent and share a pooled client; a single slow addon cannot serialize
  the home screen.
- Stream string parsing happens once per addon response in Rust (regex-free scanning), not on
  every render.
- Posters use `loading="lazy"` and a CSS gradient placeholder, so an empty/unreachable metadata
  host still produces a usable grid.
- Row artwork is fetched at the size the addon provides; no proxy or re-encode.

## Verification status

Run on this machine (Windows 11, WebView2):

- `cargo test` — 11 tests: addon URL/id builders, stream parsing/ranking, SQLite round-trips
  (addons, progress, library, watched), settings merge/reset.
- `bun run check` and `bun run build` — clean.
- Desktop app launched via `bun run tauri dev`, driven over the WebView2 DevTools protocol:
  installed Cinemeta from its live URL, loaded 4 real catalog rows (40 posters), searched
  "dune" (25 live results), opened *Dune: Prophecy* details (6 episodes, 2 season tabs, cast),
  confirmed the empty source state, saved it to the library and reloaded it from SQLite.
- Screenshots in `screenshots/` come from that run.

- Playback end to end with a bundled mpv 0.41 against a real 90s 720p H.264 file: `player_open`
  returned a duration of 90s, position advanced in real time and `mpv.log` shows `vo/gpu-next`
  rendering at 1440x920. That run used the earlier owned-surface layout; the current build paints
  into the app window itself and has not been re-run here.
- Repeated play → end-of-file → play-again → stop: no wedged window, commands stay responsive.

Not verified here:

- HDR/10-bit, Dolby Vision, network HLS sources on this machine.
- The in-window layout (video behind a transparent web layer, controls on top) is compiled but not
  yet confirmed on screen: the earlier run verified the owned-surface variant from the previous
  paragraph.
- P2P, debrid, media-server playback — not implemented.
- MSI/NSIS packaging — configured, not built here.
- macOS/Linux — code is cross-platform (named pipes vs Unix sockets), untested.

## Known sharp edges

- mpv flags are explicit (`--no-config`) for predictability; a user's `mpv.conf` is intentionally
  ignored for now.
- Track selection uses mpv track ids, which are stable only for the current file. The UI re-reads
  them on every `track-list` change.
- `tmdb:*` ids need a TMDB key even to open details.
- The source drawer marks torrent-only streams disabled instead of hiding them, so the missing
  P2P engine is visible rather than mysterious.
