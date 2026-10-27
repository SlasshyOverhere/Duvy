# BetterNuvio feature scope

> Status note (October 2026): this file is the original planning inventory and has not been kept
> in step with the code. P2P, debrid, Trakt, Nuvio Cloud sync, Jellyfin/Emby, local subtitle
> files, subtitle styling and delay, and intro/outro markers have since shipped. Use
> [`FEATURE-PARITY.md`](./FEATURE-PARITY.md) and [`ARCHITECTURE.md`](./ARCHITECTURE.md) for
> current status; the status marks below are historical.

Master feature list for BetterNuvio, derived from two references:

- **Nuvio Desktop** (`NuvioMedia/NuvioDesktop`, Kotlin Multiplatform + Compose, GPL-3.0) — audited from `composeApp/src/commonMain` (753 Kotlin files, 2493 UI strings) and its full settings tree.
- **Stremio** (desktop shell + `stremio-web` + `stremio-core`) — audited from the 2103-key English translation catalogue, the `stremio-web` route set, and the org repo inventory (`stremio-shell-ng`, `stremio-service`, `enginefs`, `stremio-video`, `stremio-local-addon`, `stremio-aggregators`).

Status is measured against **what BetterNuvio v0.1 ships today**.

Legend: `OK` shipped · `PART` partial · `GAP` not built · `NO` deliberate non-goal.

Priority: **P0** = without it the app is not a daily driver · **P1** = expected at parity · **P2** = differentiator / power feature · **P3** = skip unless asked.

---

## 0. The short version

BetterNuvio already matches the *shape* of both apps: addons, catalogs, details, streams, mpv playback, library, continue watching, settings. What is missing is almost entirely the **long tail that makes these apps feel finished**:

1. **Torrent/P2P playback** — the single biggest gap. Both references treat BitTorrent as a first-class source.
2. **Debrid + cloud library** — Nuvio's deepest single feature area (rule engine, templates, cloud browsers).
3. **External trackers** — Trakt, Simkl, MDBList: identity, scrobbling, watch-state source of truth.
4. **Profiles + PIN** — both apps ship them; needed for a shared living-room/HTPC machine.
5. **Stream selection intelligence** — regex autoplay, binge groups, presets/filters, badges.
6. **Player completeness** — subtitle styling + delay + auto-sync + live sync, skip intro/outro, next-episode card, stats overlay, PiP, always-on-top.
7. **Offline** — downloads and cache management.
8. **Media servers** — Jellyfin/Emby.
9. **Polish layer** — updater, notifications, Discord RPC, i18n, keyboard/gamepad navigation, crash reporting opt-in.

Everything below is the exhaustive union, not just that list.

---

## 1. Sources and addon system

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Stremio addon protocol (catalog/meta/stream/subtitles) | yes | yes | OK | — |
| Install via URL, manifest fetch, enable/disable, remove, reorder | yes | yes | OK | — |
| Addon collections / repository URLs (`/collection.json` style bundles) | yes (plugins too) | yes (addon collections) | GAP | P1 |
| Official vs community vs installed vs "my addons" tabs, addon search | — | yes | GAP | P1 |
| Addon catalogue page (supported types, catalogs, what it provides, best-of) | yes | yes | GAP | P2 |
| Addon configuration UI (addon-provided `/configure` page or manifest `configurationRequired`) | yes | yes | GAP | P1 |
| Addon permissions / activity disclosure (playback, library, watch activity; "I trust this addon") | — | yes | GAP | P1 |
| Protected addons (cannot uninstall) | — | yes | GAP | P3 |
| App-link addons ("this source needs an app, install it?") | — | yes | NO | P3 |
| Per-addon enable toggles for catalogs / streams / subtitles separately | yes | yes | PART (global) | P1 |
| Addon failure isolation + per-addon error surface | yes | yes | PART | P1 |
| JS scraper plugins (QuickJS sandbox) + plugin repositories | yes | no (addons only) | GAP | P2 |
| Local files addon (index local video/torrent files, drag-drop playback) | yes (local files) | yes (`stremio-local-addon`) | PART (manual local file) | P1 |
| YouTube stream resolver | yes | yes | GAP | P3 |
| Addon protocol versioning / linter-grade validation on install | partial | yes | GAP | P2 |

## 2. Browse: home, discover, search

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Home feed from addon catalogs, multiple rows | yes | yes (Board) | OK | — |
| Hero / spotlight section on home | yes | yes | OK | — |
| Continue Watching shelf on home | yes | yes | OK | — |
| "New for you" / recommendations / new-episodes / new-videos rows | — | yes | GAP | P2 |
| Catalog reorder, rename, hide, pin to top, per-profile | yes | yes (drag & drop) | GAP | P1 |
| Catalog type + genre filters, sort (trending/recent/a-z/rating/year) | yes | yes | PART (type + genre) | P1 |
| Pagination / load more | yes | yes | OK | — |
| Empty / error / addon-uninstalled states | yes | yes | PART | P1 |
| Discover: multi-catalog picker + filters + "all" | yes | yes | PART | P1 |
| Search: movies/series/YouTube/TV; people (actors, directors, writers) | yes (TMDB people) | yes | PART (titles only) | P1 |
| Search: paste HTTP / magnet / info-hash / IMDb / TVDB links | — | yes | GAP | P2 |
| Search history + clear | yes | yes | GAP | P2 |
| Calendar view of upcoming episodes (subscribe as ICS) | — | yes | GAP | P3 |
| Live TV / channels with programme guide, agenda + timeline views | — | yes | GAP | P3 |
| Adult-content gate | — | yes | GAP | P2 |
| Board notifications feed (releases, recommendations) | — | yes | GAP | P3 |
| Taste/interest onboarding (pick ≥3 categories to seed recommendations) | — | yes | GAP | P3 |

## 3. Metadata and details

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Detail page: backdrop, poster, logo, synopsis, rating, genres, runtime, year | yes | yes | OK | — |
| Cast rail + full cast/crew, person detail (bio, born/died, credits, known-for) | yes | yes | PART (cast list only) | P1 |
| Trailers (in-app player + rail) | yes | yes | OK | — |
| Seasons/episodes, watched state, progress per episode | yes | yes | OK | — |
| Season view mode: posters vs text list; episode cards horizontal vs list | yes | — | GAP | P2 |
| Episode metadata: air date, overview, still, IMDb per-episode rating | yes | yes | PART | P1 |
| "More like this" / similar / recommendations | yes | yes | PART | P1 |
| Collection / belongs-to (franchise) row | yes | — | GAP | P2 |
| Production companies + networks, browse-by-entity pages | yes | — | GAP | P3 |
| Comments / reviews (Trakt) with spoiler cards + likes | yes | — | GAP | P3 |
| Release info line, certification, original language, country, status | yes | yes | PART | P1 |
| Parents guide (violence/nudity/profanity/drugs/frightening severities) | yes | — | GAP | P3 |
| Details section toggles (show/hide each block), tabbed section layout | yes | — | GAP | P2 |
| Background mode: normal / cinematic blur / dominant color | yes | — | GAP | P2 |
| Shared-element poster transition | yes | — | GAP | P3 |
| Metadata unavailable / unpublished-episode / missing-episode-number states | yes | yes | PART | P2 |
| "In cinema" + showtimes link | — | yes | GAP | P3 |
| Add-to-library from every surface + notification opt-in for new episodes | yes | yes | PART | P1 |

## 4. Library, watched state, tracking

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Add/remove library, statuses (Watching / Plan / On Hold / Completed / Dropped) | yes | yes (folders + lists) | PART (flat library) | P1 |
| Library folders / custom lists with rename + delete | — | yes | GAP | P2 |
| Sort: added, released, title, last watched, times watched, tracker order | yes | yes | PART | P1 |
| Filter: type, status, source | yes | yes | PART | P1 |
| Shelf vs grid layout toggle | yes | yes | PART | P2 |
| Mark watched/unwatched: episode, previous episodes, season, previous seasons, rest | yes | yes | PART (episode) | P1 |
| Bulk watched badge resolution (efficient bitfield) | yes | yes (`stremio-watched-bitfield`) | GAP | P2 |
| Watch-state source picker (local / Trakt / Simkl / MDBList) | yes | yes | GAP | P2 |
| Library source picker (local / cloud / Trakt / Simkl / MDBList) | yes | yes | GAP | P2 |
| Cloud sync of library + progress (own account) | yes (Supabase) | yes | GAP | P2 |
| Import: Trakt, local disk, guest account, Facebook | yes (Trakt) | yes | GAP | P2 |
| Data export request / account deletion | yes | yes | NO (no account) | P3 |

## 5. Continue watching and progress

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Continue Watching shelf + resume prompt | yes | yes | OK | — |
| Style variants (card / poster / wide / spotlight / carousel / compact) | yes | yes | PART (one style) | P2 |
| Next Up semantics (next unwatched vs furthest watched), unaired handling | yes | yes | PART | P1 |
| New episode / new season badges, air-date labels, time-left labels | yes | yes | PART (time left) | P2 |
| Blur unwatched next-up artwork | yes | yes | GAP | P2 |
| Sort: default / streaming-order / separate upcoming row | yes | yes | GAP | P2 |
| Remove from CW, start over, go to details | yes | yes | PART | P1 |
| Watch-progress source coordination + reconciliation on change | yes | yes | GAP | P2 |
| Resume across devices via account sync | yes | yes | GAP | P2 |

## 6. Stream discovery and selection

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Concurrent addon fan-out with per-addon results + timeouts | yes | yes | OK | — |
| Stream rows: quality, size, cached, seeders, languages, HDR, REMUX, addon | yes | yes | OK | — |
| Copy stream / magnet / info-hash / download links | yes | yes | PART (copy link) | P1 |
| Refresh streams / re-scrape, active scraper indicator | yes | yes | PART | P1 |
| Stream badges from JSON badge packs (Fusion-style), position + size toggles | yes | — | GAP | P2 |
| Addon logo + name on each stream | yes | yes | PART | P1 |
| Stream filter presets (include/exclude tags, per device) | yes (rule engine) | yes | GAP | P1 |
| Autoplay policy: manual / first / regex match, with preset library + timeout | yes | PART (auto-play next only) | PART (instant pick on manual) | P1 |
| Binge groups: prefer, reuse across sessions, fallback when unavailable | yes | — | GAP | P2 |
| Preload next-episode sources; reuse last link with cache duration | yes | — | GAP | P2 |
| Source scope: all / installed addons / plugins / both; allowed-addon allowlist | yes | — | GAP | P2 |
| Torrent/P2P stream stats (seeds, peers, buffer, speed) | yes | yes | GAP | P1 |
| Debrid resolution states (resolving, cached, stale, unavailable) | yes | — | GAP | P1 |
| "No streams" guidance incl. "your content settings may hide sources" | yes | yes | PART | P2 |
| Direct-link-unavailable / unsupported-format messaging | yes | yes | PART | P2 |

## 7. Playback engine

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Embedded hardened player with hardware decode | yes | yes | OK (mpv) | — |
| Hwdec mode picker (auto / disabled / accelerated / full / legacy) | yes | yes | PART (auto only) | P1 |
| Engine abstraction + in-player engine switch (reload at position) | yes (Exo/libmpv) | yes (internal/external) | GAP | P2 |
| Video output tuning: scale mode (fit/crop/stretch/original), aspect presets | yes | yes | GAP | P2 |
| Picture adjustments: brightness/contrast/saturation/gamma/deband/interpolation | yes | — | GAP | P3 |
| HDR: tone mapping, peak detection, DV profile 7 fallback | yes | — | GAP | P2 |
| NVIDIA RTX Video Super Resolution | yes | yes (NVIDIA GPU processing) | GAP | P3 |
| Playback speed control | yes | yes | OK | — |
| Volume + mute + audio passthrough/surround | yes | yes | PART | P1 |
| Seek forward/back durations, configurable arrow-key seek | yes | yes | PART | P1 |
| Buffer tuning (min/start/rebuffer/back-buffer/target MB) | yes | — | GAP | P3 |
| VOD disk cache size + cache drive management | yes | yes | PART (no knobs) | P2 |
| Pause when minimized / play in background / auto-resize window before play | — | yes | GAP | P2 |
| Launch player in separate window (advanced) | — | yes | GAP | P3 |
| Picture-in-picture | — | yes | GAP | P1 |
| Always on top + fullscreen toggles | — | yes | GAP | P2 |
| Live stream handling (go live, live badge, programme context) | — | yes | GAP | P3 |
| Resume prompt + resume/start-over choice | yes | yes | OK | — |
| Media info / stats overlay (codecs, bitrate, fps, dropped frames, engine, server) | yes | yes | GAP | P1 |
| Loading/buffering status steps with detail | yes | yes | PART | P2 |
| Playback error taxonomy + retry + "wrong stream?" recovery | yes | yes | PART | P1 |
| External player handoff (system player/VLC/nPlayer/Infuse) + remember choice | yes | yes | GAP | P1 |
| Subtitle + intro/outro forwarding to external player | yes | — | GAP | P2 |
| Stream/URL/magnet pasted directly into player | — | yes | GAP | P2 |
| RAR-archive stream reading | — | yes (`rar-stream`) | GAP | P3 |
| Transcoding profiles (server-side, casting) | — | yes | GAP | P3 |

## 8. Audio and subtitles

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Audio track list + switching (codec, channels, language) | yes | yes | OK | — |
| Preferred + secondary audio language, autoselect | yes | yes | PART | P1 |
| Subtitle list: embedded, addon, local file | yes | yes | PART (embedded + addon) | P1 |
| Load external subtitle file from disk | yes | yes | GAP | P1 |
| Preferred + secondary subtitle language, forced subtitles | yes | yes | PART | P1 |
| Show only preferred subtitle languages | yes | yes | GAP | P1 |
| Strip SDH / hearing-impaired tracks | yes | — | GAP | P2 |
| Subtitle styling: font, size, colour, outline colour, background colour, opacity, edges, vertical offset | yes | yes | PART (mpv defaults) | P1 |
| ASS/SSA styling passthrough (libass) + style-ASS toggle | yes | yes | PART | P2 |
| Subtitle delay adjustment (+ keyboard shortcuts, live display) | yes | yes | PART (manual ±10s, no shortcuts) | P1 |
| Subtitle auto-sync (analysis, offsets, best variant, other-language fallback) | yes (`docs/subtitle-autosync.md`) | yes ("Auto Sync") | GAP | P1 |
| Subtitle Live Sync (pick the line you hear) | — | yes | GAP | P2 |
| "Wrong subtitles?" report flow | — | yes | GAP | P3 |
| Addon subtitle loading strategy (fast / preferred prefetch / all) + per-addon failure list | yes | yes | GAP | P2 |
| Download/copy subtitle URL or ID | — | yes | GAP | P2 |

## 9. P2P / torrent streaming

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| BitTorrent engine with sequential/streaming piece selection | yes | yes (`enginefs`) | GAP | **P0** |
| First-run informed consent (IP visibility, legal notice) | yes | — | GAP | **P0** |
| Torrent profile (soft / balanced / fast / ultra-fast) | yes | yes | GAP | P1 |
| Cache size cap + clear cache with usage readout | yes | yes | GAP | P1 |
| Stats overlay: seeds/peers/buffer/speed/progress, metadata fetch stages | yes | yes | GAP | P1 |
| Hide torrent stats option | yes | — | GAP | P2 |
| Local peer discovery / DHT / trackers, VPN-friendly bind address | partial | yes | GAP | P2 |
| Streaming-server HTTP endpoint for LAN / casting | — | yes | GAP | P3 |
| Remote HTTPS endpoint toggle | — | yes | GAP | P3 |

## 10. Debrid and cloud libraries

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Provider support (Real-Debrid, AllDebrid, Premiumize, TorBox, others) | yes | — | GAP | P1 |
| API-key auth + device-code OAuth | yes | — | GAP | P1 |
| Resolve playable links, choose resolver provider | yes | — | GAP | P1 |
| Pre-resolve next links ahead of playback (lookahead count) | yes | — | GAP | P2 |
| Result management: max results, sort, per-resolution/quality caps, size range | yes | — | GAP | P2 |
| Rule engine: preferred/required/excluded for resolution, quality, visual tags, audio tags, channels, encodes, languages, release groups | yes | — | GAP | P2 |
| Filename/description templates with reset-to-default | yes | — | GAP | P2 |
| Cloud library browser (Premiumize/TorBox): file type filters, search, file pick within packs | yes | — | GAP | P2 |
| Local availability / cache checks per provider | yes | — | GAP | P1 |
| Secure credential storage in OS keychain/credential vault | — | — | GAP | **P0** |

## 11. Downloads and offline

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Download a stream/video to disk with progress | yes | yes | GAP | P1 |
| Downloads screen: In progress / Movies / Shows / completed / failed | yes | yes | GAP | P1 |
| Pause / resume / retry / remove, per-item and bulk | yes | yes | GAP | P1 |
| Download subtitle alongside video | yes | yes | GAP | P2 |
| Watch downloaded items offline, "available offline" markers | yes | yes | GAP | P1 |
| Storage usage breakdown (downloads, cache, thumbnails, temp) | yes | yes | GAP | P2 |
| Open containing folder, per-show episode counts | yes | yes | GAP | P2 |
| Background download queue + notification controls | yes | yes | GAP | P2 |
| Direct-link requirement / unsupported format messaging | yes | yes | GAP | P2 |

## 12. Media servers

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Jellyfin connect + library browse | yes | — | GAP | P1 |
| Emby / MediaBrowser connect + browse | yes | — | GAP | P1 |
| Multi-server management, per-server page, re-auth | yes | — | GAP | P1 |
| Play from server, watched-state sync both ways | yes | — | GAP | P1 |
| Server catalog merged into Home/Discover | yes | — | GAP | P2 |
| Server user selection / state projection | yes | — | GAP | P2 |

## 13. Integrations

**Trakt** — device-code auth, watchlist + personal lists, public list browsing (trending/popular/search, likes/items counts), watch-progress source, CW history window, scrobbles, ratings, comments/reviews, personalized recommendations, list add/remove with impact warning, expiry/rate-limit errors. Status: GAP, P1.

**Simkl** — PIN auth, plan-to-watch/status lists (Watching, Plan, On Hold, Completed, Dropped), watched + progress sync, scrobbles, anime ID preference (IMDb/MAL/Kitsu/TVDB), sync interval, hide On Hold/Dropped from CW, sync-now. Status: GAP, P2.

**MDBList** — API key, external rating providers (IMDb, TMDB, Trakt, Letterboxd, Metacritic, RT, MAL, Audience), per-provider priority, ratings on hero/detail, list picker for Library, history, scrobbles. Status: GAP, P2.

**TMDB** — already used. Still missing: API-key override, language, per-module toggles (artwork, credits, collections, episodes, more-like-this, networks, companies, season posters, trailers), age ratings. Status: PART, P1.

**IMDb datasets** — `title.ratings.tsv.gz` for offline episode/show ratings. GAP, P2.

**IntroDB / AnimeSkip** — skip-data providers (see §14). GAP, P2.

**Discord Rich Presence** — browsing/watching activity, off by default. GAP, P2.

**Casting** — Chromecast discovery, device picker, remote control, casting mode (default / no-transcode). GAP, P3.

**Web remote** — LAN URL + QR code pairing to control playback from a phone. GAP, P3.

**Calendar** — ICS export/subscribe of the library's schedule. GAP, P3.

## 14. Player-adjacent features

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Skip intro / recap / outro / end credits buttons | yes (IntroDB) | yes | GAP | P1 |
| Auto-skip per segment type, thresholds (minutes or %), keep post-credits scenes | yes | PART | GAP | P2 |
| Submit intro timestamps (capture or manual MM:SS) | yes | — | GAP | P3 |
| Next-episode card (thumbnail, countdown, "playing via X in Ns", dismiss/watch now) | yes | yes | PART (auto-advance) | P1 |
| Next-episode threshold (minutes before end / percentage) | yes | yes | GAP | P2 |
| Autoplay next episode toggle + trigger config | yes | yes | PART | P1 |
| Up-next "on now" / live context | — | yes | GAP | P3 |
| Episode shuffle (random unwatched, spoiler-safe preview sheet, persisted, badge) | yes | "Watch random" | GAP | P2 |
| Parental/content warning overlay | yes | — | GAP | P3 |
| In-player episode list + sources panel without leaving playback | yes | yes | PART | P1 |
| In-player subtitle/audio/info/statistics menus via shortcuts | yes | yes | PART | P1 |
| Gesture overlay (mobile) | yes | yes | NO (desktop) | — |
| Gamepad support + controls legend | — | yes | NO (desktop) | P3 |

## 15. Accounts, profiles, parental

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Local profiles: create/edit/delete, name, avatar (catalog + custom URL), background | yes | yes | GAP | P1 |
| "Who's watching?" selection screen + switcher | yes | yes | GAP | P1 |
| Per-profile data isolation (library, progress, addons, settings) | yes | yes | GAP | P1 |
| Per-profile addon sharing ("use primary addons" / clone addons / allow manage) | yes | yes | GAP | P2 |
| 4-digit PIN lock, re-ask timeout, lock on restart, attempt lockout | yes | yes | GAP | P1 |
| Remember last profile | yes | yes | GAP | P2 |
| Optional account: email/password or device-link QR, cloud sync, sign out, delete | yes | yes | NO (local-only) | P3 |
| Guest mode (works fully offline, no backend calls) | — | yes | OK (implicitly) | — |
| Membership/supporter tiers, supporter card, contributors page | yes (Patreon) | yes (supporters) | NO | — |

## 16. Appearance and personalization

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Dark/light + multiple named themes (Nuvio: 13 presets; Stremio: 9) | yes | yes | PART (4 accents, dark only) | P1 |
| Custom theme: gradient (3 stops) or solid, HSL/hex editor, live preview, save | yes | PART (colour picker) | GAP | P2 |
| Light mode | — | yes | GAP | P2 |
| AMOLED pure black | yes | yes (Black theme) | GAP | P2 |
| Accent colour picker | yes | yes | PART | P1 |
| Navigation layout: sidebar / top bar / bottom bar; standard vs minimal; adaptive/compact/expanded | yes | yes | PART (fixed sidebar) | P2 |
| Sidebar/top-bar style variants + glass effects | yes | — | GAP | P3 |
| Poster customization: width presets + custom, corner radius presets + custom, hide labels, landscape posters | yes | — | GAP | P2 |
| Custom poster source URL pattern with `{id}`/`{id_type}`/`{type}`, per-surface opt-in | yes | — | GAP | P2 |
| Card depth effect (lit edge, sheen, glow strength, apply-to surfaces) | yes | — | GAP | P3 |
| Hover preview: enable, delay, trailer preview, trailer sound, start time | yes | — | GAP | P2 |
| Continue Watching style variants | yes | yes | GAP | P2 |
| Show title under catalog items | — | yes | GAP | P3 |
| Interface zoom | — | yes | GAP | P2 |
| Reduce motion | partial | yes (animations) | PART | P2 |
| App icons (5–6 packs) | yes | — | GAP | P3 |
| Splash/branding | yes | yes | PART | P3 |

## 17. System, platform, privacy

| Feature | Nuvio | Stremio | BetterNuvio | Pri |
|---|---|---|---|---|
| Auto-updater: channels (stable/beta/all), release notes, progress, install | yes | yes | GAP | P1 |
| Episode-release notifications (local scheduling, test, permission states) | yes | yes | GAP | P2 |
| Desktop notifications toggle + network status notifications | yes | yes | GAP | P2 |
| Launch on startup | — | yes | GAP | P2 |
| Close-to-tray vs quit; quit-on-close; remember window bounds | partial | yes | GAP | P1 |
| Storage manager with per-category usage + clear | yes | yes | GAP | P2 |
| Crash reporting (opt-in with explicit payload disclosure) | yes (Sentry) | yes | GAP | P2 |
| Analytics opt-in | yes | yes | NO (no telemetry) | NO |
| Offline/online banners | yes | yes | PART | P2 |
| Proxy / custom headers / rate-limit handling for addons | partial | yes | GAP | P2 |
| Custom/self-hosted backend validation + trust warnings | yes | yes (server URL override) | NO (no backend) | — |
| Keychain-backed credential vault | — | — | GAP | **P0** |
| Multi-window / detachable player | — | yes (separate mpv window) | GAP | P3 |
| macOS + Linux builds, code signing, auto-update artifacts | untested | yes | GAP | P1 |
| i18n: many locales, per-surface language (UI vs subtitles) | yes (25+) | yes | GAP | P1 |
| RTL layout support | yes | yes | GAP | P2 |
| Keyboard shortcuts + discoverable cheat-sheet | partial | yes | PART (3 keys) | P1 |
| Spatial/arrow-key navigation for TV-style use | yes (TV) | yes (`spatial-navigation`) | GAP | P3 |
| Accessibility: focus rings, screen-reader labels, reduced motion, contrast | partial | partial | PART | P1 |

## 18. Architecture things both references have that we must respect

| Concern | Note for BetterNuvio |
|---|---|
| Addon execution isolation | Addons are remote HTTP; never execute their JS in the UI. Plugins (if added) run in a sandboxed runtime in Rust. |
| Streaming server vs in-process | Stremio runs a local HTTP streaming server (`stremio-service`) so external players/casting work. We use mpv IPC, so external handoff needs a small local relay or an http URL. Decide before building external players. |
| Watched-state model | Episode-level bitfield per meta item, with per-season rollups. Needed before Trakt/Simkl sync. |
| Progress identity | `(metaId, season, episode, videoId)` + duration + updatedAt, one row per profile. |
| Credential storage | Windows Credential Manager / macOS Keychain via `keyring` crate. Never in SQLite plaintext. |
| Torrent engine | `librqbit` (pure Rust, embeddable) is the pragmatic pick; `enginefs`-style sequential streaming on top. |
| Player controls | Every in-app control must be reachable by keyboard; HTPC users have no mouse. |

---

## 19. Required-feature checklist (the deliverable)

### P0 — must exist before v0.2 is called usable
1. P2P streaming with informed consent, buffer-before-play, and a stats overlay.
2. Credential vault (OS keychain) — prerequisite for debrid/trackers/media servers.
3. Stream selection policy: manual / first / regex, with timeout.
4. Subtitle delay + auto-sync + full styling.
5. External subtitle file loading.
6. Stats/media-info overlay + recovery from playback errors.
7. Keyboard-complete player and app navigation.

### P1 — parity with both references
8. Debrid: providers, resolve, cache-check, cloud library browser.
9. Trakt (auth, scrobble, lists, progress source).
10. Profiles + PIN + per-profile isolation.
11. Skip intro/recap/outro (IntroDB) + next-episode card with threshold.
12. Downloads + offline playback + storage manager.
13. Jellyfin + Emby (connect, browse, play, watched sync).
14. Addon collections, addon config UI, permissions disclosure, per-capability toggles.
15. Stream filter presets + badges + binge groups.
16. Home/Discover catalog management (hide, rename, reorder, pin).
17. Continue Watching: Next Up rules, badges, blur, sort modes, style variants.
18. Library: statuses, folders, sorts, filters, bulk watched actions.
19. i18n scaffolding + at least the locales Nuvio ships; per-surface language.
20. Auto-updater with channels.
21. Subtitle/audio language preferences incl. secondary + forced + SDI strip.
22. External player handoff with remember-choice.
23. PiP, always-on-top, pause-on-minimize.
24. Search history + people search + link/magnet paste.
25. Trailer/hover previews + poster customization.
26. Themes: light mode, AMOLED, custom gradient themes, nav layouts.

### P2 — depth and differentiators
27. Simkl + MDBList + external ratings sources.
28. Debrid rule engine + templates + pre-resolution.
29. Movies/shows metadata depth: collections, production/network entity pages, IMDb episode ratings, age ratings, parents guide.
30. Episode shuffle.
31. Collections/folders system on Home (Nuvio-style, incl. TMDB Discover sources).
32. JS plugin runtime (sandboxed) + plugin repos.
33. Discord RPC.
34. Notifications for episode releases.
35. Cloud sync of library/progress (own backend, optional).
36. Crash reporting opt-in.
37. Subtitle live-sync, SDH stripping, addon subtitle strategies.
38. Custom poster source, card depth, hover trailer audio.
39. Live TV module (only if a channel addon is a target).
40. Multiple app icons, spatial navigation, gamepad.

### P3 — skip by default
Casting/Chromecast, web remote + QR, calendar ICS, RAR streaming, in-app downloads of DRM'd services, Facebook login/import, membership tiers, analytics, self-hosted backend, multi-window player, transcoding profiles, browser extension.

### Explicit non-goals
- No bundled or hosted content, no scrapers.
- No telemetry or analytics; crash reports opt-in only, payload shown before send.
- No account required; all state local by default, sync is opt-in.
- No mobile/TV builds for now (but keyboard/spatial navigation keeps the door open).
- No upstream GPL code copied; protocol compatibility only.

---

## 20. Suggested sequencing

| Release | Contents |
|---|---|
| **v0.2 “Sources”** | P2P + consent + stats, keychain vault, stream policies/presets, subtitle delay/styling/auto-sync, external subs, media-info overlay, keyboard completeness |
| **v0.3 “Identity”** | Profiles + PIN, library statuses/folders, bulk watched, Next Up rules, Trakt, watched-state model |
| **v0.4 “Debrid”** | Debrid providers + resolve + cache checks + rule engine, cloud library browser, downloads |
| **v0.5 “Home”** | Media servers, collections system, hover previews, poster customization, themes/light mode, i18n, updater |
| **v0.6 “Extras”** | Simkl/MDBList, notifications, shuffle, Discord RPC, plugins, crash reporting, cloud sync |

Rationale: sources before identity (nothing to track without playback), identity before debrid (rule engine is per-profile), debrid before polish (it changes the stream row model), polish last because it is the most churn-prone.
