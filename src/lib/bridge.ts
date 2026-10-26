import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import type {
  AddonInfo,
  AppInfo,
  Details,
  HomeFeed,
  LibraryItem,
  MetaPreview,
  PlayRequest,
  PlayerSnapshot,
  ProgressItem,
  Settings,
  StreamOption,
  SubtitleTrack,
} from "./types";

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isBrowserPreview(): boolean {
  return !isTauri();
}

export async function openExternal(url: string): Promise<void> {
  if (isTauri()) {
    await openUrl(url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
}

async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  if (!isTauri()) {
    // The browser preview is the only consumer, so its fixtures stay out of
    // the desktop bundle.
    const { mock } = await import("./mock");
    return mock(command, args) as Promise<T>;
  }
  return invoke<T>(command, args);
}

export const api = {
  appInfo: () => call<AppInfo>("app_info"),
  playbackLog: (lines?: number) => call<string[]>("playback_log", { lines }),
  mpvDetect: (path?: string) => call<AppInfo["mpv"]>("mpv_detect", { path }),

  settings: {
    get: () => call<Settings>("settings_get"),
    set: (patch: Partial<Settings>) => call<Settings>("settings_set", { patch }),
  },

  addons: {
    list: () => call<AddonInfo[]>("addons_list"),
    install: (url: string) => call<AddonInfo>("addons_install", { url }),
    remove: (url: string) => call<null>("addons_remove", { url }),
    setEnabled: (url: string, enabled: boolean) =>
      call<null>("addons_set_enabled", { url, enabled }),
  },

  home: () => call<HomeFeed>("home_feed"),
  catalog: (args: {
    addonUrl: string;
    mediaType: string;
    catalogId: string;
    query?: string;
    skip?: number;
  }) => call<{ metas: MetaPreview[] }>("catalog", args),
  search: (query: string) => call<MetaPreview[]>("search", { query }),

  details: (id: string, type: string) => call<Details>("meta_details", { id, mediaType: type }),
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

  window: {
    fullscreen: (on: boolean) => call("window_fullscreen", { on }),
  },

  player: {
    open: (request: PlayRequest) => call<PlayerSnapshot>("player_open", { request }),
    state: () => call<PlayerSnapshot | null>("player_state"),
    control: (action: string, value?: number | string | null) =>
      call<PlayerSnapshot | null>("player_control", { action, value }),
    stop: () => call<null>("player_stop"),
    subtitle: (url: string, label?: string) =>
      call<null>("player_subtitle", { url, label }),
  },
};
