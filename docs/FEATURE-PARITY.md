# Feature parity: Nuvio Desktop → BetterNuvio

This is an audit of the upstream project (`NuvioMedia/NuvioDesktop`, Kotlin Multiplatform
+ Compose, GPL-3.0, alpha) taken from its `Dev` branch, and where BetterNuvio stands.

Nothing here is copied code. BetterNuvio is an independent Rust + TypeScript
implementation of the same *feature surface*, using documented public protocols
(Stremio addons, TMDB, mpv IPC).

The authoritative, exhaustive list (both Nuvio Desktop and Stremio, unioned, with
priorities and a release sequence) lives in [`FEATURE-SCOPE.md`](./FEATURE-SCOPE.md).
This file stays the per-area status snapshot against v0.1.

Legend: **Done** ships in v0.1 · **Partial** exists but is narrower · **Planned** not yet built.

## Core experience

| Capability | Upstream | BetterNuvio v0.1 | Notes |
| --- | --- | --- | --- |
| Catalog browsing | Done | **Done** | Home rows, Discover with catalog chips, skip pagination |
| Global search | Done | **Done** | Searches every addon with a `search` extra, plus TMDB |
| Title details | Done | **Done** | Backdrop hero, ratings, cast, trailer link, sources |
| Episode browser | Done | **Done** | Season tabs, episode art, per-episode progress |
| Addon protocol | Stremio addons | **Done** | manifest/catalog/meta/stream/subtitles, install/remove/enable |
| Stream picker | Rich, grouped, badges | **Partial** | Quality, size, seeds, cached, HDR, languages, addon filter |
| Library | Done | **Done** | Toggle from any title, filters, local SQLite |
| Continue watching | Done | **Done** | Per-episode resume, 92% completes and marks watched |
| Resume + autoplay next | Done | **Done** | Configurable, uses best playable source |
| Keyboard shortcuts | Full | **Partial** | `/` and `Ctrl/Cmd+K` search, Esc closes dialogs, mpv handles playback keys |
| Themes | Multiple + custom editor | **Partial** | Four accent palettes, reduce motion; no custom theme editor |
| App icons | 5 icon packs | **Planned** | — |
| i18n | Many languages | **Planned** | English only |

## Playback

| Capability | Upstream | BetterNuvio v0.1 | Notes |
| --- | --- | --- | --- |
| Video engine | libmpv (embedded) | **Done** | mpv over JSON IPC paints into the app window behind a transparent web layer; video never touches the WebView |
| Hardware decoding | Done | **Done** | `hwdec=auto-safe`, toggleable |
| Audio/subtitle tracks | Done | **Done** | Listed from mpv, switchable from the console |
| External subtitles | Addon + local | **Partial** | Addon tracks + mpv fuzzy local matching; no file picker yet |
| Subtitle styling | Full | **Partial** | mpv defaults, no in-app style editor yet |
| Subtitle auto-sync | Done | **Planned** | Upstream has a `docs/subtitle-autosync.md` design |
| Speed / volume / seek | Done | **Done** | Console controls |
| In-player overlay UI | Custom, gesture-driven | **Partial** | mpv's OSC and key bindings over the video; the HTML overlay is covered while a video is on screen |
| Hover previews | Done | **Planned** | Needs transcoded preview pipeline |
| Skip intro/outro | Done | **Planned** | Needs segment metadata source |
| Watch party | Done | **Planned** | Needs a sync backend |

## Sources

| Capability | Upstream | BetterNuvio v0.1 | Notes |
| --- | --- | --- | --- |
| Direct HTTP streams | Done | **Done** | Plays anything mpv can fetch |
| Local files | Done | **Done** | Settings → Playback → Open a video file |
| P2P / torrent streaming | Done (consent flow, buffer) | **Planned** | Biggest remaining gap; torrent-only sources are shown disabled |
| Debrid (RD, AD, TB, …) | Done + templates | **Planned** | Addon-resolved debrid links already work as direct URLs |
| Media servers (Jellyfin, Emby, MediaBrowser) | Done | **Planned** | Protocol clients are straightforward to add |
| Downloads / offline | Done | **Planned** | — |

## Integrations

| Capability | Upstream | BetterNuvio v0.1 | Notes |
| --- | --- | --- | --- |
| TMDB | Done | **Done** | Optional key; discovery rows, search, artwork, cast, trailer |
| Trakt | Done | **Planned** | Scrobble + library mirror |
| Simkl | Done | **Planned** | — |
| MDBList | Done | **Planned** | — |
| Cloud sync / auth | Done (Nuvio account) | **Planned** | Local-first today; no account required |
| Profiles | Done | **Planned** | DB already keys progress by profile-ready identifiers |
| Notifications | Done | **Planned** | Updater/notification service |
| Discord rich presence | Done | **Planned** | — |
| JS plugin runtime | Done (QuickJS) | **Planned** | Upstream scraper plugins |
| Auto-updater | Done | **Planned** | Tauri updater |

## Platform

| Capability | Upstream | BetterNuvio v0.1 |
| --- | --- | --- |
| Windows | MSI | **Done** (dev; MSI build configured) |
| macOS / Linux | DMG, DEB/RPM/Flatpak | Code is cross-platform; packaging untested |
| Android / iOS / TV | Yes (KMP) | Out of scope |

## Deliberate differences

- **No account, no telemetry, no bundled content.** Everything lives in one local SQLite file.
- **Rust owns I/O.** Addon fan-out runs in parallel Tokio tasks; the UI never parses stream strings.
- **mpv is a separate process, visually embedded.** It decodes in its own process and paints into
  the app window's client area while the web layer above it renders transparent, so the HTML player
  overlay acts as the chrome. The UI stays responsive on 4K remuxes and video never travels through
  the WebView.
- **No scrapers.** Only the open addon protocol; the user supplies every source URL.

## Suggested order for v0.2

1. P2P streaming with a consent gate and buffer indicator (closes the largest gap).
2. Debrid resolver + API key storage.
3. Jellyfin/Emby providers (library + playback).
4. Trakt/Simkl scrobbling and library sync.
6. Profiles, then cloud sync.
