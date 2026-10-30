# Features

What works in Duvy 0.1.0 beta, and where each area stops. This is a per-area snapshot, not
a delivery promise. Planned work lives in [`ROADMAP.md`](./ROADMAP.md).

Legend: **Done** works in the beta · **Partial** works but is narrower · **Planned** not built.

## Browsing

| Capability | Status | Notes |
| --- | --- | --- |
| Catalog browsing | **Done** | Home rows from installed addons, drag-to-scroll, auto-rotating art-led hero; no dedicated Discover browser |
| Global search | **Done** | Every addon with a `search` extra, plus TMDB when keyed; addon results stream in |
| Recent searches | **Done** | Last eight, deduped, clickable and removable |
| Title details | **Done** | Artwork and title logos, ratings, cast photos, trailer link, similar titles |
| Episode browser | **Done** | Season tabs, episode list, per-episode progress |
| Addon protocol | **Done** | Catalog, meta, stream and subtitle endpoints; install, remove, enable, disable |
| Addon management | **Partial** | Reorder, manifest refresh and a Configure button from `behaviorHints`; no permissions, collections or per-catalog toggles |
| Stream picker | **Done** | Quality, size, seeds, cached, HDR, languages, addon filter, copy link and open in browser; no presets or regex autoplay |
| Library | **Done** | Toggle from any title, filters, local SQLite |
| Continue watching | **Done** | One row per title, per-episode resume, updates live |
| Resume and autoplay next | **Done** | Configurable, uses the best playable source |
| Keyboard shortcuts | **Partial** | Search shortcuts, dialog dismissal and player keys; no gamepad or full map |
| Themes | **Partial** | Four accent palettes and reduce motion; no custom theme editor |
| Settings search | **Done** | Grouped navigation plus a search field over every section |
| App icons | **Planned** | Single built-in icon set |
| Translations | **Planned** | English only; the audio and subtitle language pickers are not UI translations |

## Playback

| Capability | Status | Notes |
| --- | --- | --- |
| Video engine | **Done** | libmpv in-process paints into the app window behind a transparent web layer on Windows; own window elsewhere |
| Hardware decoding | **Done** | `hwdec=auto-safe`, toggleable |
| Audio/subtitle tracks | **Done** | Read from mpv and switchable from the player console |
| External subtitles | **Done** | Addon tracks and a local file picker; the choice is remembered per episode |
| Subtitle styling | **Partial** | Size, bold, colour, outline colour, background opacity, position and delay, persisted; ASS tracks keep their own styling until edited. No custom font, outline width or render scale |
| Subtitle delay | **Done** | ±60s in 0.1s steps, applied to mpv and remembered with the rest of the style |
| Subtitle auto-sync | **Planned** | No analysis or automatic offset |
| Cache buffers | **Done** | Forward and backward demuxer buffers in seconds, minutes or megabytes from Settings |
| Speed, volume, seek | **Done** | Player console controls; volume is applied immediately |
| In-player overlay | **Done** | Custom HUD with track, subtitle, skip and style panels |
| Start screen | **Done** | Backdrop and title logo while the source resolves, then the first frame |
| Seek-bar previews | **Done** | Frame previews from a scratch in-process libmpv |
| Skip intro/outro | **Partial** | Community markers plus manual per-show overrides; automatic only, no visible skip button, recap or credits segments |
| Watch party | **Planned** | Needs a sync backend |

## Sources

| Capability | Status | Notes |
| --- | --- | --- |
| Direct HTTP streams | **Done** | Plays anything mpv can fetch |
| Local files | **Done** | Settings -> Playback -> Open a video file |
| P2P / torrent streaming | **Done** | Opt-in consent, local librqbit engine, loopback range server, peer and speed stats; one torrent at a time and no seeder count |
| Debrid | **Done** | Real-Debrid, AllDebrid, Premiumize and TorBox keys; link unrestricting plus a provider cache-check command; torrent packs play the requested file; no cloud browser or rule engine |
| Media servers (Jellyfin, Emby) | **Done** | Sign-in, library browse, artwork and direct playback; progress stays local |
| Downloads / offline | **Planned** | The torrent cache is transient and cleared, not a download library |

## Integrations

| Capability | Status | Notes |
| --- | --- | --- |
| TMDB | **Done** | Optional key; discovery rows, search, artwork, cast |
| Trakt | **Done** | User-supplied API app, device-code auth, scrobbling, watched/progress sync |
| Cloud account sync | **Done (best effort)** | Library, progress and watched state against the provider's backend; deletions are not pushed and the API may change |
| Addon-account sync | **Done (best effort)** | Addons, library and resume points pulled and pushed through the client API, deduped by manifest URL; series watched state is not fully mapped |
| Profiles | **Partial** | Only cloud-account profile selection; no local profiles or PIN |
| Simkl | **Planned** | Not built |
| MDBList | **Planned** | Not built |
| Notifications | **Partial** | Desktop notification for new releases; no notification service or per-event controls |
| Discord rich presence | **Planned** | Not built |
| Plugin runtime | **Planned** | Addon protocol only |
| Auto-updater | **Done** | Signed and verified, single channel, launch and six-hourly checks |

## Platform

| Capability | Status | Notes |
| --- | --- | --- |
| Windows | **Done** | MSI and NSIS built, signed and released by CI on tag |
| Player | **Done** | libmpv bundled with the app, no download and no external player |
| macOS / Linux | Untested | libmpv's own window fallback, no packaging support |
| Android / iOS / TV | Out of scope | Desktop only |

## Design choices

- **No account required, no telemetry, no bundled content.** Every integration is optional and
  uses credentials the user supplies.
- **Rust owns I/O.** Addon fan-out runs in parallel Tokio tasks; the UI never parses stream
  strings.
- **libmpv is linked in, not spawned.** Video decodes in-process and paints into the app window's
  client area while the web layer above it renders transparent. The UI stays responsive on large
  remuxes and video never travels through the WebView.
- **No scrapers.** Only the open addon protocol and user-configured servers; the user supplies
  every source.
- **P2P is opt-in.** Torrent sources stay disabled until consent is given, because peers see the
  user's IP address.
- **The player ships with the app.** libmpv is bundled, so installs stay self-contained and there
  is no first-run download to wait on.
- **Sync is best effort and optional.** Both account integrations use their providers' backends
  with the user's own session, and may break without notice.
