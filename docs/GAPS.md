# Remaining parity gaps

Snapshot of what BetterNuvio still lacks against Nuvio Desktop (`NuvioMedia/NuvioDesktop`,
KMP + Compose, GPL-3.0), taken at commit `a531db9`, upstream `5f99fb4`.

Per-area status lives in [`FEATURE-PARITY.md`](./FEATURE-PARITY.md); this file is the work
queue for what is *not* built yet.

Effort is a rough single-developer estimate, not a promise:
**S** under a day, **M** 1-3 days, **L** 1-2 weeks, **XL** multi-week or needs a backend.

Upstream code is GPL-3.0. Use it for behaviour only. No code, comments or strings are copied
into this repo.

---

## Shipped in the first pass

| Commit | Change |
| --- | --- |
| `67ee4a2` | Subtitle delay range widened to ±60 s and no longer resets per episode; volume to 200 % and remembered; `J` / `L` seek |
| `51e775f` | `posterShape` honoured on poster cards (portrait, square, landscape) |
| `952aa83` | Recent searches: last 8, deduped, clickable, removable, clearable |
| `8d3cfe5` | Stream drawer remembers the addon filter; per-row copy-link and open-in-browser |
| `a531db9` | Addon reorder, manifest refresh, and a Configure button from `behaviorHints` |

Everything below is still open.

---

## Start here

The five highest value-per-effort items, in order:

1. **DL-01 downloads + offline** - the biggest real capability hole, and it makes the torrent cache worth keeping.
2. **PF-01 profiles + PIN** - every per-profile feature is blocked behind it.
3. **PL-01 `/` PL-02 deep links + window restore** - small, and they unblock party and trailer links.
4. **SP-01..03 subtitle auto-sync and skip providers** - the player polish users actually feel.
5. **RG-04 crash reporting** - the app cannot ship without it.

---

## Playback

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| PL-01 | Subtitle auto-sync | Retiming cues against embedded audio (timeline retime, aggressive/passive mode, "synced" state) | XL | Needs audio fingerprinting or a timing service; upstream has a whole `features/autosync` module |
| PL-02 | Subtitle language policy | Preferred + secondary language, forced-only, strip SDH, preferred-only filter | M | One `subtitleLanguage` string today |
| PL-03 | Subtitle style depth | Outline width, colour swatches, render scale, position editor | S | mpv properties only, no backend work |
| PL-04 | Skip providers | IntroDB / AniSkip / AnimeSkip lookup, id resolution (MAL, Kitsu, IMDb), provider priority | L | Local hand-authored markers only today |
| PL-05 | Visible skip button | Labelled, dismissible "Skip Intro" / "Skip Recap" / "Skip Credits" with a progress ring | M | We seek silently; also needs PL-06 |
| PL-06 | Segment taxonomy | recap, credits, post-credits, per-type auto-skip toggles | M | intro + outro only |
| PL-07 | Next-episode rules | Threshold modes (percent or minutes), auto-select timeout, preload next source, binge-group match | L | Hard-coded 45 s lead; resolves only after the current episode ends |
| PL-08 | Next-episode card states | finding / failed / unaired, blurred thumb, manual dismiss | M | Plain label today |
| PL-09 | Opening overlay | Artwork, logo, title, progress while loading | S | Bare spinner on black |
| PL-10 | Pause metadata overlay | Title + synopsis on pause, with a toggle | S | |
| PL-11 | Parental guide overlay | Severity categories, with a setting | M | No data source wired |
| PL-12 | Stream info stats | Video codec, resolution, fps, bitrate, HDR, bit depth, server | M | `player.rs` parses no video stats |
| PL-13 | External player handoff | System player, forward subtitle + skip segments, return progress | L | |
| PL-14 | Desktop picture-in-picture | Always-on-top, aspect-locked mini window | L | mpv paints into the main window; needs a second window |
| PL-15 | In-app trailer player | Embedded playback, multiple trailers, letterbox detection, hero trailer | M | Opens the system browser today |
| PL-16 | Zoom resize mode | `keepaspect` + panscan, alongside fit/fill/stretch | S | |
| PL-17 | Hold-to-boost speed | Momentary multiplier on hold, plus its setting | S | |
| PL-18 | Fullscreen persistence | Remember window/fullscreen mode across sessions | S | Every playback opens windowed |
| PL-19 | mpv decoder tuning | Engine, video output, decoder priority, software-fallback threads, DV7 to HEVC, buffer sizes, VOD cache | M | Hardware toggle only |
| PL-20 | HDR passthrough | `target-colorspace-hint`, `vo` fallback chain | S | HDR is currently never signalled to the panel |
| PL-21 | Keyboard depth | Source/episode hotkeys, wheel seek, wheel volume | S | |
| PL-22 | Seek-bar preview | Already ours, upstream lacks it | - | Keep |
| PL-23 | Mobile gestures | Touch, double-tap seek, mobile PiP, iOS presets | - | Out of scope, desktop only |

## Sources, streams, debrid, servers

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| SP-01 | Regex autoplay engine | 12 presets, match target, validation, addon allow-list, source scope, selection timeout, manual mode | L | `pickSource` takes whatever answered first |
| SP-02 | "Finding source" screen | Full-screen per-addon progress with cancel | S | Drawer opens empty |
| SP-03 | Reuse-last-link cache | TTL setting, per title | M | Every play re-scrapes |
| SP-04 | Binge-group continuity | `bingeGroup` + filename matching across episodes | M | In-memory same-hash preference only, lost on restart |
| SP-05 | Stream behaviour hints | `bingeGroup`, `filename`, `videoSize` shown and used | S | `behavior_hints` parsed and discarded |
| SP-06 | Proxy headers | Honour `proxyHeaders` request/response headers | M | Header-gated streams fail today |
| SP-07 | External-only streams | `externalUrl` rows open in the browser | S | Dropped by a filter in `commands.rs` |
| SP-08 | YouTube streams | `ytId` resolution | M | Parsed then discarded |
| SP-09 | Imported badge rules | URL list import, preview, multiple active sources, badge position and size, addon logo | M | Hard-coded regex today |
| SP-10 | Refresh all sources | One action with a spinner | S | Per-addon retry only |
| SP-11 | Debrid device-code auth | Torbox / Premiumize OAuth flows | M | Key paste only |
| SP-12 | Debrid "resolve with" | Explicit provider choice | S | Fixed array order today |
| SP-13 | Real cached status | Call the existing `check_cache` from the UI | S | `cached` is a string heuristic; the command exists and nothing calls it |
| SP-14 | Instant pre-resolution | Pre-resolve the top N candidates | M | First click can wait out a 30 s poll |
| SP-15 | Debrid result rules | Max results, quality floor, DV/HDR/codec filters, size range, required/excluded tags, languages, release groups | L | |
| SP-16 | Debrid name templates | Custom stream name and description formatting | S | |
| SP-17 | Debrid cloud library | Browse and play cloud items; add-to-cloud list with status and delete | L | |
| SP-18 | P2P profiles + cache UI | soft/balanced/fast, cache size, clear cache, usage readout | M | `p2pCacheMb` is display-only |
| SP-19 | P2P consent at click | Consent dialog on first torrent play | S | Settings-only today; clicking a row throws an error string |
| SP-20 | In-player P2P stats | Buffer, peers, speed overlay with a hide toggle | S | Stats live on a separate settings page; `seeds: 0` is hard-coded |
| SP-21 | Seeder count | Real peer count | S | Hard-coded 0 |
| SP-22 | Episode-accurate file pick | Filename matching inside packs | M | Only `fileIdx`; falls back to "largest video" and can play the wrong episode |
| SP-23 | Random episode shuffle | Shuffle entry points on details, home, playback | M | Whole feature missing |
| SP-24 | Server as catalog source | Media server rows in Home and Library with TMDB matching | L | Settings-page browser only |
| SP-25 | Server progress writeback | START / PROGRESS / PAUSE / RESUME / STOP sessions | M | Static URLs only |
| SP-26 | Server watched sync | Mark played on the server, import watch state | L | |
| SP-27 | Server resume merge | Use the server position when newer | S | |
| SP-28 | Server transcode fallback | Audio and subtitle re-request when direct play fails | M | `static=true` is forced |
| SP-29 | Server per-library selection | Enable/disable libraries, re-auth, status, search, multi-server sync | M | |

## Downloads and offline

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| DL-01 | Download engine | Queue, pause, resume with HTTP range, retry, cancel, progress | XL | No Rust command, no view, no queue exists |
| DL-02 | Downloads screen | Grouped active / movies / shows | M | |
| DL-03 | Enqueue from stream picker | Per-row download action | S | Blocked by DL-01 |
| DL-04 | Subtitles alongside | Download the chosen subtitle with the video | S | |
| DL-05 | Offline playback | Play a finished download without a network | M | |
| DL-06 | Open downloads folder | Reveal in Explorer | S | |
| DL-07 | Library badge | Unseen downloads indicator | S | |
| DL-08 | Storage location | Choose the download directory | S | |
| DL-09 | Persistent torrent cache | Keep the P2P cache across sessions | M | Wiped on every start today |

## Profiles, accounts, sync

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| PF-01 | Local profiles | Picker, create/rename/delete (max 6), remember-last | L | Only Nuvio Cloud profile chips today |
| PF-02 | Profile avatars | Catalog + custom URL + colour | M | `avatarUrl` parsed, never rendered |
| PF-03 | Profile backgrounds | Per-profile art | S | |
| PF-04 | Profile PIN | Set, change, clear, verify, lockout, offline hash cache | M | `pinEnabled` is parsed and never enforced |
| PF-05 | Per-profile isolation | Addons, settings, credentials, plugins scoped per profile | L | Blocked by PF-01; switching currently inherits the other profile's addons |
| PF-06 | Guest account | Anonymous sign-in | S | |
| PF-07 | Device-link login | Code pairing | M | |
| PF-08 | Trakt browser authorize | Bundled client id, callback flow | M | Requires the user to create an API app today |
| PF-09 | Trakt scrobble depth | Completion scrobble at 80 %, seek stop+restart, retries | M | |
| PF-10 | Trakt auto-refresh | Foreground and periodic pull | M | "Sync now" only |
| PF-11 | Trakt CW window | 7-365 days or all history | S | |
| PF-12 | Trakt watchlist + lists | Library tabs, add/remove | L | |
| PF-13 | Trakt library source | Trakt vs local switch | M | |
| PF-14 | Trakt progress source | Provider choice with fallback | M | |
| PF-15 | Trakt related source | Trakt / TMDB / Simkl for more-like-this | S | |
| PF-16 | Trakt comments | With an enable toggle | M | |
| PF-17 | Trakt public lists | Import a list as a catalog source | M | |
| PF-18 | Trakt episode mapping | Absolute / special numbering | M | |
| PF-19 | Trakt resume import | Create entries from `/sync/playback` for unseen titles | S | Only updates existing rows |
| PF-20 | Trakt up-next seeding | Next episode from watched-show snapshots | M | |
| PF-21 | Simkl | Auth (PIN + PKCE), delta sync, scrobbles, anime id preference, anime fallback | XL | Whole integration |
| PF-22 | MDBList | Auth, ratings providers, lists as library tabs, progress sync | XL | Whole integration |
| PF-23 | Settings cloud sync | Theme, player, poster, CW, Trakt settings per profile | L | All machine-local |
| PF-24 | Collections cloud sync | Depends on CL-01 | M | |
| PF-25 | Media server cloud sync | Server list per account | M | |
| PF-26 | Credential cloud sync | TMDB, debrid, MDBList per profile | M | |
| PF-27 | Addon push to cloud | Local addon edits reaching other devices | M | Pull-only by design today |
| PF-28 | Delta sync + tombstones | Cursors, deletions propagating | L | Full pull every time; deletions never leave the device |
| PF-29 | Conflict resolution | Dirty-key set, per-source snapshot, preserve unsynced local edits | L | Plain timestamp LWW today |
| PF-30 | Bulk watched editing | Season, series, multi-select, unwatch push-back | M | Single-item toggle works |

## Addons, catalogs, library, details

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| AD-01 | JS plugin runtime | QuickJS host, fetch, DOM/cheerio bridge, crypto, timers, per-plugin settings forms | XL | Whole subsystem; addon protocol only today |
| AD-02 | Plugin repositories | Add repo, 6 h refresh, delete, per-scraper enable, global toggle | L | |
| AD-03 | Local addon install | File or zip on disk | M | Neither app has it; new work, not parity |
| AD-04 | Addon overview card | Counts of addons, active, catalogs | S | |
| CT-01 | Discover screen | Addon catalogs by type, catalog and genre, with pagination and a persisted selection | L | Backend `catalog` exists and is dead code |
| CT-02 | Catalog genre arg | Pass the `genre` extra through | S | Unreachable today |
| CT-03 | "See all" per row | Paginated grid with scroll restore | M | `commands.rs::catalog` + `api.catalog` already exist |
| CT-04 | Home row control | Hide, reorder, rename, pin, per-row toggles | L | One total row cap today |
| CT-05 | Hero source selection | Choose up to 2 source rows, or disable the hero | S | Hard-coded to row 0 |
| CT-06 | Upcoming row | Next-up releases | M | |
| CT-07 | Hover previews | Card hover preview and trailer, with sound toggle | L | Needs a preview pipeline |
| CT-08 | Search grouping | Per-catalog results with addon attribution, no 80-item cut | M | Three flat buckets today |
| CT-09 | Library custom lists | Create, rename, delete, privacy, membership filter | L | One flat list |
| CT-10 | Library sort + layout | 7 sorts (needs a released-date column), layout modes, per-type sections | M | 2 sorts today |
| CT-11 | Library source tabs | Trakt, Simkl, MDBList, servers, cloud | L | Blocked by PF-12 / PF-21 / PF-22 |
| CL-01 | Collections | Folder builder, cover/emoji/shape, addon + TMDB + Trakt sources, discover filters, home rows | XL | Nothing exists |
| DT-01 | Details section control | Hide and reorder 9 sections | M | |
| DT-02 | Details presentation | Episode card style, blur unwatched, tabbed layout, background mode | M | |
| DT-03 | Season view mode | Poster grid vs text, season posters | S | |
| DT-04 | Person / company / network pages | Cast cards are inert | L | |
| DT-05 | Episode stills from TMDB | `videos` is always empty | S | Stills only when an addon supplies them |
| DT-06 | Episode ratings | Field exists, never populated | M | |
| DT-07 | TMDB language | Locale setting and localized art | M | `en-US` hardcoded in 5 places |
| DT-08 | TMDB module toggles | 11 enrichment switches | M | |
| DT-09 | Anime absolute numbering | Season+episode equality breaks absolute-numbered shows | M | |
| DT-10 | Specials order | Sort specials last | S | Sorted first today |
| DT-11 | More-like-this depth | Provider rails, caching, section toggle | M | Genre-only, uncached |

## Shell, settings, theme, i18n

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| UI-01 | Custom theme editor | Hex accent, solid or 3-stop gradient, derived surfaces, live preview | L | 4 fixed accents today |
| UI-02 | Built-in palettes | 13 palettes that replace background, elevated, card and focus | M | Accents only |
| UI-03 | App icon packs | 6 packs, window + shortcut icon swap, restart flow | M | One static icon set |
| UI-04 | i18n | 26 languages, resource files, locale switching | XL | All strings hardcoded English |
| UI-05 | RTL | `dir` handling for Arabic, Hebrew, Urdu | M | Blocked by UI-04 |
| UI-06 | Settings search | Indexed across every settings page | M | |
| UI-07 | Navigation layout | Sidebar option alongside the top dock | S | |
| UI-08 | Navigation bar styles | adaptive / expanded / compact / classic, glow toggle, preview | M | |
| UI-09 | Per-profile settings | Theme, language, playback prefs scoped per profile | M | Blocked by PF-01 |
| UI-10 | Poster customization | Card width, radius, hide labels, clearlogo, animated art, card depth | L | |
| UI-11 | Streams display settings | Badge size and position, player badges, background, addon logo | M | |
| UI-12 | Continue watching options | Card style, thumbnails, blur, up-next, sorting | M | |
| UI-13 | Settings sync | Across devices | M | See PF-23 |
| UI-14 | About depth | Licences list, privacy link, credits | S | |
| UI-15 | Cache management | Clear image, metadata, P2P and CW caches, with sizes | S | |
| UI-16 | UI scaling | Density and font scale, user zoom | M | |
| UI-17 | Keep-awake outside playback | Inhibit while paused or idle in the UI | S | Only mpv covers it |
| UI-18 | Middle-click autoscroll / precise wheel | Unverified whether WebView2 already does this | S | Test first |

## Watch party (backend epic)

Upstream is a Supabase RPC surface plus a private realtime channel. This is a backend project
before it is a client port.

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| WP-01 | Party backend | create, join, preview, heartbeat, update, leave, end, kick, chat, clock, kill-switch | XL | Nothing self-hostable client-side |
| WP-02 | Sync engine | 1.5 s seek threshold, 5 % rate nudge, pause tolerance, buffering gate | L | |
| WP-03 | Presence | Member status and "behind by Xs" | M | |
| WP-04 | Chat | History, dedupe, client ids | M | |
| WP-05 | Host controls | Host-only control mode, kick, end | S | |
| WP-06 | Shared stream | Host hands the playable URL to guests; refuses localhost | M | |
| WP-07 | Companion seat | Second device as remote and chat | M | |

## Platform, updates, release

| # | Gap | What is missing | Effort | Notes |
| --- | --- | --- | --- | --- |
| RG-01 | Auto-updater | Check on launch and manual, ignore-version | L | Done. No stable/beta channels |
| RG-02 | Update download + install | Progress, installer handoff, relaunch | M | Done |
| RG-03 | Delta updates | zsync metadata | M | |
| RG-04 | Crash reporting | Sentry (or equivalent), DSN, opt-out, PII scrubbing | M | No crash path at all |
| RG-05 | Release CI | Build matrix, signing, notarization, checksums, auto-published notes | L | 21-line CI today |
| RG-06 | Signing config | Certificates and notarization in `tauri.conf.json` | M | |
| RG-07 | Deep links | `nuvio://` and `stremio://` registration, launch args, routing to meta / downloads / party | M | Nothing registered |
| RG-08 | Window state restore | Geometry, maximized, fullscreen on relaunch | S | Recreates 1440x920 every launch |
| RG-09 | Discord rich presence | IPC integration | M | |
| RG-10 | Windows renderer choice | OpenGL vs default WebView2 | S | |
| RG-11 | libmpv embedding | Render-API bridge instead of a separate `mpv.exe` on `--wid` | XL | Works today; this is architecture, not a bug |
| RG-12 | Linux / macOS builds | Packaging and platform player code | - | Out of scope, Windows-only |

---

## Not gaps

Verified absent upstream too. Do not "fix" these for parity:

- Addon store browsing, local zip install, addon permissions screen. `store.json` is an AltStore iOS manifest, referenced by no Kotlin source.
- Light theme, light/dark/system switch. Upstream is dark-only with 13 dark palettes.
- Notifications, account deletion. Both are disabled on desktop upstream.
- Tray, minimize-to-tray, single instance, always-on-top, SMTC media keys, gamepad/TV navigation, onboarding wizard, backup/restore, export, rebindable shortcuts.
- Screenshot, sleep timer, playback stats graph.
- Manual torrent file selection, minimum-seeder filter, cached-only toggle, in-picker sort, download storage picker. (Storage location is still worth adding on its own merits, DL-08.)

## Where our docs are wrong

- `README.md` and `FEATURE-PARITY.md` claim Discover with filters. There is no addon-catalog
  Discover screen; `commands.rs::catalog` exists and is unused. See CT-01.
- `FEATURE-PARITY.md` implies watched-state parity. Only single-item toggle is wired.
- `FEATURE-PARITY.md` marks hover previews, icon packs, Simkl, MDBList and downloads as
  Planned. All still accurate.

---

## Suggested milestones

1. **Playback polish** - PL-03, PL-05, PL-06, PL-08, PL-09, PL-12, PL-16, PL-17, PL-18, PL-20, PL-21.
2. **Sources** - SP-01..03, SP-06..13, SP-19..22.
3. **Downloads** - DL-01..09.
4. **Profiles** - PF-01..07, then UI-09.
5. **Platform basics** - RG-07, RG-08, RG-01..04.
6. **Tracking** - PF-09..20, then PF-21, PF-22.
7. **Catalog surface** - CT-01..08, DT-01..07.
8. **Localization** - UI-04, UI-05.
9. **Watch party** - WP-01..07, backend first.
10. **Customization** - UI-01, UI-02, UI-10..12.