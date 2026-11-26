import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rememberLogos } from "./art";
import { sentry } from "./sentry";
import type {
  AddonInfo,
  AppInfo,
  CastMember,
  Details,
  DebridProvider,
  HomeFeed,
  HomeRow,
  LibraryItem,
  MetaPreview,
  NuvioProfile,
  NuvioStatus,
  NuvioSyncReport,
  ParentalEntry,
  PersonDetails,
  PlayRequest,
  PlayerSnapshot,
  ProgressItem,
  SeasonSummary,
  Settings,
  StreamOption,
  StremioStatus,
  StremioSyncReport,
  SubtitleTrack,
  TrailerLink,
  TraktStatus,
  UpdateInfo,
  Video,
  WatchedItem,
  Network,
} from "./types";

/** Fixtures are dev-only: a release build always talks to Rust. */
const PREVIEW = import.meta.env.DEV;

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isBrowserPreview(): boolean {
  return PREVIEW && !isTauri();
}

// Addon responses are third-party JSON and stored rows can predate this build,
// so every payload the views render is read through here first.
const META_LIMIT = 300;

type Dict = Record<string, unknown>;

function dict(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Dict) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function textOrNull(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arr(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function strings(value: unknown): string[] {
  return arr(value).filter((item): item is string => typeof item === "string");
}

/** Coerced fields over the raw row, so keys the views read still ride along. */
function shaped<T>(raw: Dict, fields: Dict): T {
  return { ...raw, ...fields } as unknown as T;
}

function readMeta(value: unknown): MetaPreview {
  const meta = dict(value);
  return shaped<MetaPreview>(meta, {
    id: text(meta.id),
    type: text(meta.type),
    name: text(meta.name),
    poster: textOrNull(meta.poster),
    background: textOrNull(meta.background),
    logo: textOrNull(meta.logo),
    genres: Array.isArray(meta.genres) ? strings(meta.genres) : null,
  });
}

function readMetas(value: unknown): MetaPreview[] {
  return arr(value)
    .map(readMeta)
    .filter((meta) => meta.id && meta.type && meta.name)
    .slice(0, META_LIMIT);
}

function readRow(value: unknown): HomeRow {
  const row = dict(value);
  return shaped<HomeRow>(row, {
    id: text(row.id),
    title: text(row.title),
    type: text(row.type),
    catalogId: text(row.catalogId),
    items: readMetas(row.items),
  });
}

function readProgress(value: unknown): ProgressItem {
  const item = dict(value);
  return shaped<ProgressItem>(item, {
    key: text(item.key),
    metaId: text(item.metaId),
    type: text(item.type),
    name: text(item.name),
    poster: textOrNull(item.poster),
    background: textOrNull(item.background),
    season: numOrNull(item.season),
    episode: numOrNull(item.episode),
    episodeTitle: textOrNull(item.episodeTitle),
    position: num(item.position),
    duration: num(item.duration),
    updatedAt: num(item.updatedAt),
  });
}

function readProgressList(value: unknown): ProgressItem[] {
  return arr(value)
    .map(readProgress)
    .filter((item) => item.key && item.metaId);
}

function readWatchedList(value: unknown): WatchedItem[] {
  return arr(value)
    .map((entry) => {
      const item = dict(entry);
      return shaped<WatchedItem>(item, {
        key: text(item.key),
        metaId: text(item.metaId),
        type: text(item.type),
        name: text(item.name),
        poster: textOrNull(item.poster),
        background: textOrNull(item.background),
        season: numOrNull(item.season),
        episode: numOrNull(item.episode),
        watchedAt: num(item.watchedAt),
      });
    })
    .filter((item) => item.key && item.metaId);
}

function readLibrary(value: unknown): LibraryItem[] {
  return arr(value)
    .map((entry) => {
      const item = dict(entry);
      return shaped<LibraryItem>(item, {
        id: text(item.id),
        type: text(item.type),
        name: text(item.name),
        poster: textOrNull(item.poster),
        background: textOrNull(item.background),
        addedAt: num(item.addedAt),
        meta: item.meta ? readMeta(item.meta) : null,
      });
    })
    .filter((item) => item.id);
}

function readDetails(value: unknown): Details {
  const details = dict(value);
  return shaped<Details>(details, {
    id: text(details.id),
    type: text(details.type),
    name: text(details.name),
    poster: textOrNull(details.poster),
    background: textOrNull(details.background),
    logo: textOrNull(details.logo),
    imdbId: textOrNull(details.imdbId),
    genres: strings(details.genres),
    videos: arr(details.videos).map((entry) => {
      const video = dict(entry);
      return shaped<Video>(video, {
        id: text(video.id),
        title: textOrNull(video.title),
        season: numOrNull(video.season),
        episode: numOrNull(video.episode),
        number: numOrNull(video.number),
        thumbnail: textOrNull(video.thumbnail),
      });
    }),
    cast: arr(details.cast).map((entry) => {
      const member = dict(entry);
      return shaped<CastMember>(member, {
        name: text(member.name),
        character: text(member.character),
        photo: textOrNull(member.photo),
        personId: numOrNull(member.personId),
      });
    }),
    director: strings(details.director),
    writer: strings(details.writer),
    composer: strings(details.composer),
    country: strings(details.country),
    trailers: arr(details.trailers)
      .map((entry) => {
        const trailer = dict(entry);
        return shaped<TrailerLink>(trailer, {
          name: text(trailer.name),
          url: text(trailer.url),
          thumbnail: textOrNull(trailer.thumbnail),
          year: textOrNull(trailer.year),
        });
      })
      .filter((trailer) => trailer.url),
    seasons: arr(details.seasons)
      .map((entry) => {
        const season = dict(entry);
        return shaped<SeasonSummary>(season, {
          number: num(season.number),
          name: text(season.name),
          poster: textOrNull(season.poster),
          episodes: num(season.episodes),
        });
      })
      .filter((season) => season.number >= 0),
    networks: arr(details.networks)
      .map((entry) => {
        const network = dict(entry);
        return shaped<Network>(network, {
          name: text(network.name),
          logo: textOrNull(network.logo),
        });
      })
      .filter((network) => network.name),
    certification: textOrNull(details.certification),
    originCountry: strings(details.originCountry),
    originalLanguage: textOrNull(details.originalLanguage),
  });
}

function readPerson(value: unknown): PersonDetails {
  const person = dict(value);
  return shaped<PersonDetails>(person, {
    id: num(person.id),
    name: text(person.name),
    photo: textOrNull(person.photo),
    department: textOrNull(person.department),
    birthday: textOrNull(person.birthday),
    deathday: textOrNull(person.deathday),
    placeOfBirth: textOrNull(person.placeOfBirth),
    biography: textOrNull(person.biography),
    credits: num(person.credits),
    since: textOrNull(person.since),
    popular: readMetas(person.popular),
    latest: readMetas(person.latest),
    upcoming: readMetas(person.upcoming),
  });
}

function readStreams(value: unknown): StreamOption[] {
  return arr(value)
    .filter((entry) => Boolean(entry) && typeof entry === "object")
    .map((entry) => {
      const stream = dict(entry);
      return shaped<StreamOption>(stream, {
        addon: text(stream.addon),
        name: textOrNull(stream.name),
        title: textOrNull(stream.title),
        description: textOrNull(stream.description),
        url: textOrNull(stream.url),
        infoHash: textOrNull(stream.infoHash),
        fileIdx: numOrNull(stream.fileIdx),
        externalUrl: textOrNull(stream.externalUrl),
        quality: text(stream.quality),
        size: textOrNull(stream.size),
        sizeBytes: numOrNull(stream.sizeBytes),
        seeders: numOrNull(stream.seeders),
        languages: strings(stream.languages),
        badges: strings(stream.badges),
        cached: stream.cached === true,
        playable: stream.playable === true,
        score: num(stream.score),
      });
    });
}

function readSubtitles(value: unknown): SubtitleTrack[] {
  return arr(value)
    .map((entry) => {
      const track = dict(entry);
      return shaped<SubtitleTrack>(track, {
        id: text(track.id),
        url: text(track.url),
        lang: text(track.lang),
        label: text(track.label),
        addon: text(track.addon),
      });
    })
    .filter((track) => track.url);
}

/** A release notice the UI can render; anything without a version is dropped. */
export function validUpdate(value: unknown): UpdateInfo | null {
  const update = dict(value);
  const version = text(update.version).trim();
  if (!version) return null;
  return shaped<UpdateInfo>(update, {
    version,
    currentVersion: text(update.currentVersion),
    notes: textOrNull(update.notes),
    date: textOrNull(update.date),
  });
}

const readers: Record<string, (value: unknown) => unknown> = {
  home_feed: (value) => {
    const feed = dict(value);
    return {
      continueWatching: readProgressList(feed.continueWatching),
      // A row without an id cannot be keyed; it would repeat in the grid.
      rows: arr(feed.rows)
        .map(readRow)
        .filter((row) => row.id),
      addonErrors: strings(feed.addonErrors),
    };
  },
  recommendations: (value) => arr(value).map(readRow),
  catalog: (value) => ({ metas: readMetas(dict(value).metas) }),
  search: readMetas,
  similar: readMetas,
  meta_details: readDetails,
  person_details: readPerson,
  streams: readStreams,
  subtitles: readSubtitles,
  library_list: readLibrary,
  progress_list: readProgressList,
  progress_for: (value) => (value == null ? null : readProgress(value)),
  watched_list: readWatchedList,
  watched_keys: strings,
  update_check: validUpdate,
  update_cached: validUpdate,
};

export function readPayload(command: string, value: unknown): unknown {
  const read = readers[command];
  return read ? read(value) : value;
}

export async function openExternal(url: string): Promise<void> {
  // Addon manifests supply these links, so only web URLs may leave the app.
  if (!/^https?:\/\//i.test(url)) throw new Error("That link is not a web address");
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

/** Every rejected command reaches callers as an Error, never a bare string. */
export function toCommandError(command: string, reason: unknown): Error {
  if (reason instanceof Error) {
    const known = reason as Error & { command?: string };
    known.command ??= command;
    return known;
  }
  const message =
    typeof reason === "string" && reason.trim() ? reason : `Command ${command} failed`;
  const error = new Error(message) as Error & { command?: string; cause?: unknown };
  error.name = "CommandError";
  error.command = command;
  error.cause = reason;
  return error;
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    if (PREVIEW && !isTauri()) {
      // Loaded at runtime only: the desktop app never imports these fixtures.
      const { mock } = await import("./mock");
      return mock(command, args) as Promise<T>;
    }
    // One span per backend call, so a slow screen shows which command stalled.
    // Tracing is only live once the reporter is loaded, so before that
    // the call goes straight to the bridge.
    const Sentry = sentry();
    const raw = Sentry
      ? await Sentry.startSpan({ name: command, op: "ipc" }, () => invoke<unknown>(command, args))
      : await invoke<unknown>(command, args);
    return readPayload(command, raw) as T;
  } catch (error) {
    throw toCommandError(command, error);
  }
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  /** Requests per host since the last read; reading clears the counter. */
  netStats: () => call<Record<string, number>>("net_stats"),
  playbackLog: (lines?: number) => call<string[]>("playback_log", { lines }),

  settings: {
    get: () => call<Settings>("settings_get"),
    set: (patch: Partial<Settings>) => call<Settings>("settings_set", { patch }),
  },

  updates: {
    /** `null` when the running build is the newest release. */
    check: () => call<UpdateInfo | null>("update_check"),
    /** The release a previous launch found; no network round trip. */
    cached: () => call<UpdateInfo | null>("update_cached"),
    /** Only after the user asks: download, install, restart. */
    /** Downloads and installs, then the installer restarts the app. */
    install: () => call<null>("update_install"),
  },

  addons: {
    list: () => call<AddonInfo[]>("addons_list"),
    install: (url: string) => call<AddonInfo>("addons_install", { url }),
    remove: (url: string) => call<null>("addons_remove", { url }),
    setEnabled: (url: string, enabled: boolean) =>
      call<null>("addons_set_enabled", { url, enabled }),
    move: (url: string, delta: number) => call<AddonInfo[]>("addons_move", { url, delta }),
    refresh: (url: string) => call<AddonInfo>("addons_refresh", { url }),
  },

  home: async () => {
    const feed = await call<HomeFeed>("home_feed");
    // Every card on the page knows its logo, so a later start has it at once.
    rememberLogos(
      (feed.rows ?? []).flatMap((row) =>
        (row.items ?? []).map((meta) => ({ id: meta.id, logo: meta.logo })),
      ),
    );
    return feed;
  },
  recommendations: () => call<HomeRow[]>("recommendations"),
  catalog: (args: {
    addonUrl: string;
    mediaType: string;
    catalogId: string;
    query?: string;
    skip?: number;
  }) => call<{ metas: MetaPreview[] }>("catalog", args),
  search: (query: string) => call<MetaPreview[]>("search", { query }),

  details: async (id: string, type: string) => {
    const details = await call<Details>("meta_details", { id, mediaType: type });
    // The same title answers to its addon id, its source id and its imdb id.
    rememberLogos([
      { id, logo: details.logo },
      { id: details.id, logo: details.logo },
      { id: details.imdbId, logo: details.logo },
    ]);
    return details;
  },
  castPhotos: (names: string[], title: string) =>
    call<Record<string, string>>("cast_photos", { names, title }),
  person: (id: number) => call<PersonDetails>("person_details", { id }),
  similar: (mediaType: string, genre: string, exclude: string) =>
    call<MetaPreview[]>("similar", { mediaType, genre, exclude }),
  streams: (args: {
    id: string;
    mediaType: string;
    season?: number | null;
    episode?: number | null;
    imdbId?: string | null;
    addon?: string | null;
  }) => call<StreamOption[]>("streams", args),
  subtitles: (args: {
    id: string;
    mediaType: string;
    season?: number | null;
    episode?: number | null;
  }) => call<SubtitleTrack[]>("subtitles", args),
  /** IMDb parents guide, worst category first. Empty means nothing to warn about. */
  parentalGuide: (imdbId: string) =>
    call<ParentalEntry[]>("parental_guide", { imdbId }),

  library: {
    list: () => call<LibraryItem[]>("library_list"),
    toggle: (item: LibraryItem) => call<boolean>("library_toggle", { item }),
  },

  progress: {
    list: () => call<ProgressItem[]>("progress_list"),
    forKey: (key: string) => call<ProgressItem | null>("progress_for", { key }),
    clear: (key: string) => call<null>("progress_clear", { key }),
    setWatched: (key: string, metaId: string, watched: boolean) =>
      call<null>("watched_set", { key, metaId, watched }),
  },

  watched: {
    list: () => call<WatchedItem[]>("watched_list"),
    /** Every explicit mark for one title, per episode. `list` keeps one row per title. */
    marks: (metaId: string) => call<Array<[string, number]>>("watched_marks", { metaId }),
    /** Every marked key, per episode. `list` keeps one row per title. */
    keys: () => call<string[]>("watched_keys"),
  },

  window: {
    fullscreen: (on: boolean) => call<null>("window_fullscreen", { on }),
  },

  player: {
    open: (request: PlayRequest) => call<PlayerSnapshot>("player_open", { request }),
    state: () => call<PlayerSnapshot | null>("player_state"),
    control: (action: string, value?: number | string | boolean | null) =>
      call<null>("player_control", { action, value }),
    stop: () => call<null>("player_stop"),
    subtitle: (url: string, label?: string) =>
      call<null>("player_subtitle", { url, label }),
    /** One still of the picture at `seconds`, as a data URL, for the seek preview. */
    frame: (seconds: number) => call<string>("player_frame", { seconds }),
  },

  nuvio: {
    status: () => call<NuvioStatus>("nuvio_status"),
    signIn: (email: string, password: string, signUp = false) =>
      call<NuvioStatus>("nuvio_sign_in", { email, password, signUp }),
    signOut: () => call<null>("nuvio_sign_out"),
    setProfile: (index: number) => call<null>("nuvio_set_profile", { index }),
    profiles: () => call<NuvioProfile[]>("nuvio_profiles"),
    syncNow: () => call<NuvioSyncReport>("nuvio_sync_now"),
  },

  stremio: {
    status: () => call<StremioStatus>("stremio_status"),
    signIn: (email: string, password: string) =>
      call<StremioStatus>("stremio_sign_in", { email, password }),
    signOut: () => call<null>("stremio_sign_out"),
    syncNow: () => call<StremioSyncReport>("stremio_sync_now"),
  },

  /** One pass across Stremio and Nuvio, in the order that converges both. */
  sync: {
    all: () => call<null>("sync_all"),
  },

  debrid: {
    providers: () => call<DebridProvider[]>("providers"),
    setKey: (provider: string, key: string) =>
      call<null>("set_key", { provider, key }),
    resolve: (url: string) => call<string>("resolve", { url }),
    checkCache: (source: string) => call<boolean>("check_cache", { source }),
  },

  trakt: {
    status: () => call<TraktStatus>("status"),
    begin: (clientId?: string, clientSecret?: string) =>
      call<TraktStatus>("begin", { clientId, clientSecret }),
    poll: () => call<TraktStatus>("poll"),
    disconnect: () => call<null>("disconnect"),
    sync: () => call<{ pulled?: number; pushed?: number }>("sync"),
    scrobble: (action: string, key: string, progress: number) =>
      call<null>("scrobble", { action, key, progress }),
  },
};
