import { invoke } from "@tauri-apps/api/core";
import * as Sentry from "@sentry/react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { rememberLogos } from "./art";
import type {
  AddonInfo,
  AppInfo,
  Details,
  DebridProvider,
  HomeFeed,
  HomeRow,
  LibraryItem,
  MetaPreview,
  NuvioProfile,
  NuvioStatus,
  NuvioSyncReport,
  PlayRequest,
  PlayerSetup,
  PlayerSnapshot,
  ProgressItem,
  Settings,
  StreamOption,
  StremioStatus,
  StremioSyncReport,
  SubtitleTrack,
  TorrentStats,
  TraktStatus,
  UpdateInfo,
  WatchedItem,
} from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isBrowserPreview(): boolean {
  return !isTauri();
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

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    // Loaded at runtime only: the desktop app never imports these fixtures.
    const { mock } = await import("./mock");
    return mock(command, args) as Promise<T>;
  }
  // One span per backend call, so a slow screen shows which command stalled.
  return Sentry.startSpan({ name: command, op: "ipc" }, () => invoke<T>(command, args));
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  playbackLog: (lines?: number) => call<string[]>("playback_log", { lines }),
  mpvDetect: (path?: string) => call<AppInfo["mpv"]>("mpv_detect", { path }),

  playerSetup: {
    status: () => call<PlayerSetup>("player_setup_status"),
    start: () => call<boolean>("player_setup_start"),
  },

  settings: {
    get: () => call<Settings>("settings_get"),
    set: (patch: Partial<Settings>) => call<Settings>("settings_set", { patch }),
  },

  updates: {
    /** `null` when the running build is the newest release. */
    check: () => call<UpdateInfo | null>("update_check"),
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
      (feed.rows ?? []).flatMap((row) => row.items.map((meta) => ({ id: meta.id, logo: meta.logo }))),
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

  torrent: {
    start: (source: string, fileHint?: string) =>
      call<string>("start", { source, fileHint }),
    stats: () => call<TorrentStats>("stats"),
    stop: () => call<null>("stop"),
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
