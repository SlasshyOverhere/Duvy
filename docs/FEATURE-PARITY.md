# Feature parity: Nuvio Desktop to BetterNuvio

Status of BetterNuvio 0.1.0 beta against the feature surface of the upstream project
(`NuvioMedia/NuvioDesktop`, Kotlin Multiplatform and Compose, GPL-3.0, alpha). This is a
per-area snapshot, not a delivery promise.

Nothing here is copied code. BetterNuvio is an independent Rust and TypeScript implementation
using documented public protocols (Stremio addons, TMDB, Trakt, Jellyfin/Emby, mpv IPC).

The longer planning list lives in [`FEATURE-SCOPE.md`](./FEATURE-SCOPE.md). That file predates
several implemented features; where it disagrees, this page and
[`ARCHITECTURE.md`](./ARCHITECTURE.md) are authoritative.

Legend: **Done** works in the beta · **Partial** works but is narrower · **Planned** not built.

## Core experience

| Capability | Upstream | BetterNuvio | Notes |
| --- | --- | --- | --- |
| Catalog browsing | Done | **Done** | Home rows, Discover with filters, skip pagination |
| Global search | Done | **Done** | Every addon with a `search` extra, plus TMDB when keyed |
| Title details | Done | **Done** | Artwork, ratings, cast photos, trailer link, similar titles |
| Episode browser | Done | **Done** | Season tabs, episode list, per-episode progress |
| Addon protocol | Stremio addons | **Done** | manifest/catalog/meta/stream/subtitles; install, remove, enable, disable |
| Addon management | Rich | **Partial** | No reorder, addon configuration page, permissions or collections |
| Stream picker | Rich, grouped, badges | **Done** | Quality, size, seeds, cached, HDR, languages, addon filter; no presets or regex autoplay |
| Library | Done | **Done** | Toggle from any title, filters, local SQLite |
| Continue watching | Done | **Done** | One row per title, per-episode resume |
| Resume and autoplay next | Done | **Done** | Configurable, uses the best playable source |
| Keyboard shortcuts | Full | **Partial** | Search shortcuts, dialog dismissal, player keys; no gamepad or full map |
| Themes | Multiple plus custom editor | **Partial** | Four accent palettes, reduce motion; no custom theme editor |
| App icons | 5 icon packs | **Planned** | Single built-in icon set |
| i18n | Many languages | **Planned** | English only |

## Playback

| Capability | Upstream | BetterNuvio | Notes |
| --- | --- | --- | --- |
| Video engine | libmpv embedded | **Done** | mpv over JSON IPC paints into the app window behind a transparent web layer on Windows; separate window fallback elsewhere |
| Hardware decoding | Done | **Done** | `hwdec=auto-safe`, toggleable |
| Audio/subtitle tracks | Done | **Done** | Read from mpv and switchable from the player console |
| External subtitles | Addon plus local | **Done** | Addon tracks and a local file picker |
| Subtitle styling | Full | **Partial** | Size, colour and background opacity; no custom font, outline or position editor |
| Subtitle delay and auto-sync | Done | **Planned** | No offset controls or analysis |
| Speed, volume, seek | Done | **Done** | Player console controls |
| In-player overlay | Custom, gesture driven | **Done** | Custom HUD with track, subtitle, skip and style panels |
| Hover previews | Done | **Planned** | Needs a preview pipeline |
| Skip intro/outro | Done | **Done** | Manual per-show markers with automatic skipping; no metadata provider |
| Watch party | Done | **Planned** | Needs a sync backend |

## Sources

| Capability | Upstream | BetterNuvio | Notes |
| --- | --- | --- | --- |
| Direct HTTP streams | Done | **Done** | Plays anything mpv can fetch |
| Local files | Done | **Done** | Settings -> Playback -> Open a video file |
| P2P / torrent streaming | Done (consent, buffer) | **Done** | Opt-in consent, local librqbit engine, loopback range server, peer and speed stats; one torrent at a time and no seeder count |
| Debrid (RD, AD, PB, TB) | Done plus templates | **Done** | Real-Debrid, AllDebrid, Premiumize and TorBox keys; link unrestricting plus a provider cache-check command; no cloud browser or rule engine |
| Media servers (Jellyfin, Emby) | Done | **Done** | Sign-in, library browse, artwork and direct playback; progress stays local |
| Downloads / offline | Done | **Planned** | The torrent cache is transient and cleared, not a download library |

## Integrations

| Capability | Upstream | BetterNuvio | Notes |
| --- | --- | --- | --- |
| TMDB | Done | **Done** | Optional key; discovery rows, search, artwork, cast |
| Trakt | Done | **Done** | User-supplied API app, device-code auth, scrobbling, watched/progress sync |
| Nuvio Cloud sync | Official account | **Done (unofficial)** | Library, progress and watched sync against the official backend; deletions are not pushed and the API may change |
| Profiles | Done | **Partial** | Only Nuvio account profile selection; no local profiles or PIN |
| Simkl | Done | **Planned** | Not built |
| MDBList | Done | **Planned** | Not built |
| Notifications | Done | **Planned** | No notification service |
| Discord rich presence | Done | **Planned** | Not built |
| JS plugin runtime | Done (QuickJS) | **Planned** | Addon protocol only |
| Auto-updater | Done | **Planned** | No updater |

## Platform

| Capability | Upstream | BetterNuvio |
| --- | --- | --- |
| Windows | MSI | **Done** in development; MSI and NSIS configured, not built by CI |
| macOS / Linux | DMG, DEB/RPM/Flatpak | Untested; separate mpv window fallback, no packaging support |
| Android / iOS / TV | Yes (KMP) | Out of scope |

## Deliberate differences

- **No account required, no telemetry, no bundled content.** Nuvio Cloud, Trakt, debrid and media
  servers are optional and use credentials the user supplies.
- **Rust owns I/O.** Addon fan-out runs in parallel Tokio tasks; the UI never parses stream
  strings.
- **mpv is a separate process, visually embedded.** It decodes in its own process and paints into
  the app window's client area while the web layer above it renders transparent. The UI stays
  responsive on large remuxes and video never travels through the WebView.
- **No scrapers.** Only the open addon protocol and user-configured servers; the user supplies
  every source.
- **P2P is opt-in.** Torrent sources stay disabled until consent is given, because peers see the
  user's IP address.

## Suggested order for the next release

1. Downloads and offline playback.
2. Local profiles with PIN protection.
3. Auto-updater and signed release builds.
4. Subtitle delay, auto-sync and a fuller style editor.
5. Translations.
6. Simkl and MDBList.
