/**
 * Browser-only mock backend.
 *
 * `bun run dev` in a normal browser has no Tauri runtime, so the bridge routes
 * commands here instead. This keeps the UI debuggable with HMR and makes the
 * layout reviewable without launching the desktop shell. The desktop build
 * always talks to Rust.
 */
import type {
  AddonInfo,
  AppInfo,
  Details,
  HomeFeed,
  HomeRow,
  LibraryItem,
  MetaPreview,
  PlayerSnapshot,
  ProgressItem,
  Settings,
  StreamOption,
  SubtitleTrack,
} from "./types";

const MINUTE = 60_000;

const now = Date.now();

const TITLES_MOVIES = [
  ["Nightfall Protocol", 2024],
  ["The Cartographer", 2023],
  ["Salt & Static", 2025],
  ["Blue Hour", 2022],
  ["Oblique", 2024],
  ["The Long Quiet", 2021],
  ["Ceremony", 2023],
  ["North of Zero", 2025],
  ["Paper Tigers", 2020],
  ["Signal Fires", 2024],
  ["Hollow Coast", 2022],
  ["The Understudy", 2023],
] as const;

const TITLES_SERIES = [
  ["Vantage", 2024],
  ["Slow Machines", 2025],
  ["The Archive", 2022],
  ["Golden State", 2023],
  ["Grain", 2024],
  ["Terminal City", 2021],
  ["Lowlight", 2025],
  ["Common Ground", 2023],
  ["The Wavelength", 2024],
  ["Field Notes", 2022],
  ["Verso", 2025],
  ["Last Light", 2021],
] as const;

const GENRES = ["Drama", "Thriller", "Sci-Fi", "Mystery", "Adventure"];

function poster(seed: string) {
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}/440/660`;
}

function backdrop(seed: string) {
  return `https://picsum.photos/seed/${encodeURIComponent(seed)}-wide/1600/900`;
}

function makeItems(
  titles: readonly (readonly [string, number])[],
  type: "movie" | "series",
  prefix: string,
): MetaPreview[] {
  return titles.map(([name, year], index) => ({
    id: `${prefix}${1000 + index}`,
    type,
    name,
    poster: poster(name),
    background: backdrop(name),
    description:
      "A patient, atmospheric story about the people who stay behind when everything else moves on.",
    releaseInfo: String(year),
    imdbRating: (6.4 + ((index * 7) % 30) / 10).toFixed(1),
    genres: [GENRES[index % GENRES.length]],
    runtime: type === "movie" ? `${96 + index * 4} min` : `${3 + (index % 2)} seasons`,
    posterShape: "poster",
  }));
}

const MOVIES = makeItems(TITLES_MOVIES, "movie", "tt1");
const SERIES = makeItems(TITLES_SERIES, "series", "tt2");

const ROWS: HomeRow[] = [
  { id: "mock:movie:top", title: "Featured movies", addon: "Cinemeta", type: "movie", catalogId: "top", items: MOVIES.slice(0, 10) },
  { id: "mock:series:top", title: "Shows everyone is watching", addon: "Cinemeta", type: "series", catalogId: "top", items: SERIES.slice(0, 10) },
  { id: "mock:movie:year", title: "New this year", addon: "Cinemeta", type: "movie", catalogId: "year", items: [...MOVIES].reverse().slice(0, 10) },
  { id: "mock:series:year", title: "Fresh seasons", addon: "Cinemeta", type: "series", catalogId: "year", items: [...SERIES].reverse().slice(0, 10) },
];

let settings: Settings = {
  tmdbApiKey: "",
  accent: "ember",
  preferredQuality: "auto",
  autoPlayNext: true,
  autoResume: true,
  subtitleLanguage: "eng",
  audioLanguage: "eng",
  hardwareDecoding: true,
  seekStep: 10,
  reduceMotion: false,
  homeRowsLimit: 8,
  trackProgress: true,
  playerWindow: "mpv",
  nuvioAutoSync: true,
  stremioAutoSync: true,
  nuvioBaseUrl: "",
  nuvioApiKey: "",
  p2pConsent: false,
  p2pCacheMb: 2048,
  bufferForwardValue: 256,
  bufferForwardUnit: "mb",
  bufferBackwardValue: 75,
  bufferBackwardUnit: "mb",
  traktScrobble: true,
  autoUpdateCheck: true,
  ignoredUpdateVersion: "",
  onboarded: true,
  telemetry: null,
};

let addons: AddonInfo[] = [
  {
    url: "https://v3-cinemeta.strem.io",
    addonId: "com.linvo.cinemeta",
    name: "Cinemeta",
    version: "3.0.14",
    description: "Metadata and catalogs for movies and series.",
    logo: null,
    enabled: true,
    types: ["movie", "series"],
    resources: ["catalog", "meta"],
    catalogs: [
      { type: "movie", id: "top", name: "Popular" },
      { type: "series", id: "top", name: "Popular" },
    ],
  },
  {
    url: "https://example-addon.dev/streams",
    addonId: "dev.example.streams",
    name: "Demo Streams",
    version: "1.2.0",
    description: "Sample direct-link provider used by the browser preview.",
    logo: null,
    enabled: true,
    types: ["movie", "series"],
    resources: ["stream"],
    catalogs: [],
  },
];

const library: LibraryItem[] = [
  {
    id: MOVIES[1].id,
    type: "movie",
    name: MOVIES[1].name,
    poster: MOVIES[1].poster,
    background: MOVIES[1].background,
    addedAt: now - 3 * 24 * 60 * MINUTE,
    meta: MOVIES[1],
  },
];

const progress: ProgressItem[] = [
  {
    key: `${SERIES[0].id}:1:3`,
    metaId: SERIES[0].id,
    type: "series",
    name: SERIES[0].name,
    poster: SERIES[0].poster,
    background: SERIES[0].background,
    season: 1,
    episode: 3,
    episodeTitle: "The Long Way Around",
    position: 1840,
    duration: 3120,
    updatedAt: now - 2 * 60 * MINUTE,
  },
  // An earlier episode kept behind: finishing episode 3 is exactly when the
  // card used to fall back to this row.
  {
    key: `${SERIES[0].id}:1:2`,
    metaId: SERIES[0].id,
    type: "series",
    name: SERIES[0].name,
    poster: SERIES[0].poster,
    background: SERIES[0].background,
    season: 1,
    episode: 2,
    episodeTitle: "The Cartographer's Apprentice",
    position: 1200,
    duration: 3120,
    updatedAt: now - 3 * 60 * MINUTE,
  },
  {
    key: MOVIES[2].id,
    metaId: MOVIES[2].id,
    type: "movie",
    name: MOVIES[2].name,
    poster: MOVIES[2].poster,
    background: MOVIES[2].background,
    season: null,
    episode: null,
    episodeTitle: null,
    position: 2260,
    duration: 6300,
    updatedAt: now - 26 * 60 * MINUTE,
  },
];

function allItems() {
  return [...MOVIES, ...SERIES];
}

function findMeta(id: string): MetaPreview | undefined {
  return allItems().find((item) => item.id === id);
}

function detailsFor(id: string): Details {
  const meta = findMeta(id) ?? MOVIES[0];
  const isSeries = meta.type === "series";
  const videos = isSeries
    ? Array.from({ length: 8 }, (_, index) => ({
        id: `${meta.id}:1:${index + 1}`,
        title: [
          "Cold Open",
          "The Long Way Around",
          "Paper Walls",
          "Interference",
          "Quiet Hours",
          "The Return",
          "Signal Lost",
          "Afterglow",
        ][index],
        season: 1,
        episode: index + 1,
        number: index + 1,
        overview:
          "An hour of slow-burn tension, a few difficult conversations, and one decision nobody can take back.",
        thumbnail: backdrop(`${meta.name}-ep-${index}`),
        released: new Date(now - (8 - index) * 7 * 24 * 60 * MINUTE).toISOString(),
        rating: (7 + (index % 3) * 0.4).toFixed(1),
      }))
    : [];

  return {
    id: meta.id,
    type: meta.type,
    name: meta.name,
    poster: meta.poster,
    background: meta.background,
    description:
      "A patient, atmospheric story about the people who stay behind when everything else moves on. Shot on location over three seasons, with a score recorded in a decommissioned power station.",
    releaseInfo: meta.releaseInfo,
    year: meta.releaseInfo,
    rating: meta.imdbRating,
    genres: meta.genres ?? [],
    runtime: meta.runtime,
    status: isSeries ? "Returning series" : "Released",
    videos,
    cast: [
      { name: "Mira Okafor", character: "Lead", photo: null },
      { name: "Tomas Weber", character: "Supporting", photo: null },
      { name: "Aiko Tanaka", character: "Supporting", photo: null },
      { name: "Daniel Reyes", character: "Guest", photo: null },
    ],
    director: ["J. Marchetti"],
    writer: ["J. Marchetti", "Lena Hart"],
    country: ["United States"],
    trailer: null,
    imdbId: meta.id,
    tmdbId: null,
    source: "mock",
  };
}

function streamsFor(id: string): StreamOption[] {
  return [
    {
      addon: "Demo Streams",
      name: "Remux · 4K HDR",
      title: `${id} · 2160p · HDR10 · DTS-HD`,
      description: "BluRay remux · 42.6 GB · cached",
      url: "https://example.com/stream/remux.mkv",
      infoHash: null,
      fileIdx: null,
      externalUrl: null,
      quality: "4K",
      size: "42.6 GB",
      seeders: 182,
      languages: ["English", "Multi"],
      badges: ["REMUX", "HDR", "DDP"],
      cached: true,
      playable: true,
      score: 118,
    },
    {
      addon: "Demo Streams",
      name: "WEB-DL · 1080p",
      title: `${id} · 1080p · DD+ 5.1`,
      description: "WEB-DL · 8.4 GB · cached",
      url: "https://example.com/stream/1080p.mkv",
      infoHash: null,
      fileIdx: null,
      externalUrl: null,
      quality: "1080p",
      size: "8.4 GB",
      seeders: 240,
      languages: ["English"],
      badges: ["x265"],
      cached: true,
      playable: true,
      score: 101,
    },
    {
      addon: "Demo Streams",
      name: "WEB-DL · 720p",
      title: `${id} · 720p`,
      description: "WEB-DL · 2.1 GB",
      url: "https://example.com/stream/720p.mkv",
      infoHash: null,
      fileIdx: null,
      externalUrl: null,
      quality: "720p",
      size: "2.1 GB",
      seeders: 94,
      languages: ["English"],
      badges: [],
      cached: false,
      playable: true,
      score: 68,
    },
    {
      addon: "Demo Streams",
      name: "Torrent · 2160p",
      title: `${id} · 2160p · torrent`,
      description: "Peer-to-peer · 19.2 GB",
      url: null,
      infoHash: "8f2c1d9b7a6e5f40312233445566778899aabbcc",
      fileIdx: 0,
      externalUrl: null,
      quality: "4K",
      size: "19.2 GB",
      seeders: 312,
      languages: ["English"],
      badges: ["HDR"],
      cached: false,
      playable: false,
      score: 96,
    },
  ];
}

let player: { start: number; offset: number; paused: boolean; duration: number; title: string; session?: PlayerSnapshot["session"] } | null = null;

function snapshot(): PlayerSnapshot | null {
  if (!player) return null;
  const elapsed = player.paused ? player.offset : player.offset + (Date.now() - player.start) / 1000;
  return {
    playing: true,
    paused: player.paused,
    position: Math.min(elapsed, player.duration),
    duration: player.duration,
    title: player.title,
    volume: 100,
    muted: false,
    speed: 1,
    ended: elapsed >= player.duration,
    audioTracks: [{ id: 1, label: "English · 5.1", lang: "eng", selected: true, external: false }],
    subTracks: [
      { id: 1, label: "English", lang: "eng", selected: true, external: false },
      { id: 2, label: "English SDH", lang: "eng", selected: false, external: true },
    ],
    activeAudio: 1,
    activeSub: 1,
    session: player.session ?? null,
  };
}

const delay = (ms = 90) => new Promise((resolve) => setTimeout(resolve, ms));

export async function mock(command: string, args?: Record<string, unknown>): Promise<unknown> {
  await delay();
  const payload = (args ?? {}) as Record<string, any>;

  switch (command) {
    case "app_info":
      return {
        version: "0.1.0-preview",
        platform: "browser preview",
        dataDir: "~/Duvy",
      } satisfies AppInfo;

    case "settings_get":
      return settings;
    case "settings_set":
      settings = { ...settings, ...(payload.patch ?? {}) };
      return settings;

    // Account sync talks to real backends, so the preview reports signed out.
    case "stremio_status":
      return { signedIn: false, email: "", lastSync: 0 };
    case "stremio_sign_in":
      throw new Error("Stremio sign-in needs the desktop app");
    case "stremio_sign_out":
      return null;
    case "stremio_sync_now":
      throw new Error("Stremio sync needs the desktop app");
    case "sync_all":
      return null;

    // The preview has no release feed to ask, and a fake update would offer a
    // button that cannot install anything.
    case "update_check":
      return null;
    case "update_install":
      throw new Error("Updates need the desktop app");

    case "addons_list":
      return addons;
    case "addons_install": {
      const url = String(payload.url ?? "").trim();
      if (!url) throw new Error("Enter an addon URL");
      const installed: AddonInfo = {
        url,
        addonId: `custom.${Date.now()}`,
        name: "Custom addon",
        version: "1.0.0",
        description: "Installed in the browser preview.",
        logo: null,
        enabled: true,
        types: ["movie", "series"],
        resources: ["catalog", "meta", "stream"],
        catalogs: [{ type: "movie", id: "top", name: "Popular" }],
      };
      addons = [installed, ...addons];
      return installed;
    }
    case "addons_remove":
      addons = addons.filter((addon) => addon.url !== payload.url);
      return null;
    case "addons_set_enabled":
      addons = addons.map((addon) =>
        addon.url === payload.url ? { ...addon, enabled: Boolean(payload.enabled) } : addon,
      );
      return null;

    case "home_feed":
      return {
        continueWatching: progress,
        rows: ROWS,
        addonErrors: [],
      } satisfies HomeFeed;

    case "recommendations":
      return ROWS.slice(0, 2);

    case "catalog": {
      const source = payload.mediaType === "series" ? SERIES : MOVIES;
      const skip = Number(payload.skip ?? 0);
      return { metas: [...source, ...source].slice(skip, skip + 24) };
    }

    case "search": {
      const query = String(payload.query ?? "").toLowerCase();
      if (!query) return [];
      return allItems().filter((item) => item.name.toLowerCase().includes(query));
    }

    case "meta_details":
      return detailsFor(String(payload.id));

    case "streams": {
      const rows = streamsFor(String(payload.id));
      const only = payload.addon;
      return typeof only === "string" ? rows.filter((row) => row.addon === only) : rows;
    }

    case "subtitles":
      return [
        { id: "sub-1", url: "https://example.com/sub/en.srt", lang: "English", addon: "OpenSubtitles" },
        { id: "sub-2", url: "https://example.com/sub/en.sdh.srt", lang: "English SDH", addon: "OpenSubtitles" },
        { id: "sub-3", url: "https://example.com/sub/es.srt", lang: "Spanish", addon: "OpenSubtitles" },
      ] satisfies SubtitleTrack[];

    case "library_list":
      return library;
    case "library_toggle": {
      const item = payload.item as LibraryItem;
      const exists = library.some((entry) => entry.id === item.id);
      if (exists) {
        library.splice(0, library.length, ...library.filter((entry) => entry.id !== item.id));
        return false;
      }
      library.unshift({ ...item, addedAt: Date.now() });
      return true;
    }

    case "progress_list":
      return progress;
    case "progress_for":
      return progress.find((entry) => entry.key === payload.key) ?? null;
    case "progress_clear": {
      const index = progress.findIndex((entry) => entry.key === payload.key);
      if (index >= 0) progress.splice(index, 1);
      return null;
    }
    case "watched_set":
      return null;
    case "cast_photos":
      return {};
    case "similar":
      return [];
    case "watched_list": {
      const seen = new Set<string>();
      return progress
        .filter((entry) => entry.duration > 0 && entry.position >= entry.duration * 0.9)
        .filter((entry) => {
          if (seen.has(entry.metaId)) return false;
          seen.add(entry.metaId);
          return true;
        })
        .map((entry) => ({
          key: entry.key,
          metaId: entry.metaId,
          type: entry.type,
          name: entry.name,
          poster: entry.poster ?? null,
          background: entry.background ?? null,
          season: entry.season ?? null,
          episode: entry.episode ?? null,
          watchedAt: entry.updatedAt,
        }));
    }

    case "player_open": {
      const request = payload.request as { url: string; title: string; startAt?: number; session?: PlayerSnapshot["session"] };
      player = {
        start: Date.now(),
        offset: request.startAt ?? 0,
        paused: false,
        duration: request.session?.type === "series" ? 3120 : 6300,
        title: request.title,
        session: request.session,
      };
      return snapshot();
    }
    case "player_state":
      return snapshot();
    case "player_control": {
      if (!player) return null;
      const action = String(payload.action ?? "");
      const value = payload.value as number | null;
      if (action === "toggle-pause") {
        player.offset = snapshot()?.position ?? player.offset;
        player.start = Date.now();
        player.paused = !player.paused;
      }
      if (action === "seek" && value != null) {
        player.offset = value;
        player.start = Date.now();
      }
      if (action === "seek-rel" && value != null) {
        const position = snapshot()?.position ?? 0;
        player.offset = Math.max(0, position + value);
        player.start = Date.now();
      }
      if (action === "stop") player = null;
      return snapshot();
    }
    case "player_stop":
      player = null;
      return null;
    case "player_subtitle":
      return null;
    // The preview lives in a browser tab, so the window is already the tab.
    case "window_fullscreen":
      return null;

    default:
      throw new Error("That needs the desktop app");
  }
}
