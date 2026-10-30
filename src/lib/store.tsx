import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "./bridge";
import { rememberedLogo } from "./art";
import { errorMessage, seasonLabel } from "./format";
import { wentBackwards } from "./errors";
import {
  action as watchAction,
  createWatch,
  sample as watchSample,
  timeline,
  type Sample,
} from "./playback-watch";
import { note, report } from "./telemetry";
import type {
  AddonInfo,
  AppInfo,
  Details,
  LibraryItem,
  MetaPreview,
  PlaybackSession,
  PlayRequest,
  PlayerSnapshot,
  ProgressItem,
  Settings,
  StreamOption,
  StartingArt,
  UpdateInfo,
  Video,
  WatchedItem,
} from "./types";

export type Route =
  | { name: "home" }
  | { name: "search"; query?: string }
  | { name: "library" }
  | { name: "watched" }
  | { name: "settings"; section?: string }
  | { name: "details"; id: string; type: string }
  | { name: "player" };

export type ToastTone = "info" | "success" | "error";
export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
}

interface Store {
  booting: boolean;
  bootError: string | null;
  appInfo: AppInfo | null;
  settings: Settings | null;
  addons: AddonInfo[];
  library: LibraryItem[];
  progress: ProgressItem[];
  /** Progress keyed by session key, for the hot lookups on every row. */
  progressByKey: Map<string, ProgressItem>;
  /** Library ids for the hot membership checks on every card. */
  libraryIds: Set<string>;
  toasts: Toast[];
  route: Route;
  /** Non-null from the click until the source is resolved; the player opens at once. */
  starting: StartingArt | null;
  cancelStart: () => void;
  navigate: (route: Route) => void;
  back: () => void;
  /** Leave the player for the playing title, without stacking a second copy. */
  leavePlayer: () => void;
  refreshAddons: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  refreshProgress: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  /** Mark a key watched or unwatched, then refresh the rows it affects. */
  markWatched: (key: string, metaId: string, watched: boolean) => Promise<void>;
  /** Intentional stop, so the close it causes is not reported as a crash. */
  stopPlayer: () => void;
  /** A player control, watched so one that lands nowhere can be reported. */
  playerControl: (kind: string, value?: number | string | boolean | null) => void;
  toggleLibrary: (item: MetaPreview) => Promise<void>;
  inLibrary: (id: string) => boolean;
  /** The release the last check found, if any. */
  update: UpdateInfo | null;
  checkUpdate: () => Promise<UpdateInfo | null>;
  /** Hide this version from background checks. */
  skipUpdate: (version: string) => Promise<void>;
  notify: (text: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
  progressFor: (key: string) => ProgressItem | undefined;
  watched: WatchedItem[];
  playRequest: (request: PlayRequest) => Promise<boolean>;
  playItem: (item: MetaPreview, fromStart?: boolean) => Promise<void>;
  resumeEntry: (entry: ProgressItem) => Promise<void>;
  buildSession: (details: Details, video: Video | null) => PlaybackSession;
  resolveStream: (stream: StreamOption) => Promise<string>;
  /** The source behind what is playing now; the next episode prefers its pack. */
  playingSource: StreamOption | null;
}

const StoreContext = createContext<Store | null>(null);

// Playback ticks arrive several times a second. Keeping them in their own
// context means a ticking timeline re-renders the player instead of every
// screen in the app.
const PlayerContext = createContext<PlayerSnapshot | null>(null);

export function useApp(): Store {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useApp must be used inside <StoreProvider>");
  return store;
}

export function usePlayer(): PlayerSnapshot | null {
  return useContext(PlayerContext);
}

export function sessionFor(details: Details, video: Video | null): PlaybackSession {
  const season = video?.season ?? null;
  const episode = video?.episode ?? video?.number ?? null;
  return {
    key:
      season != null && episode != null
        ? `${details.id}:${season}:${episode}`
        : details.id,
    metaId: details.id,
    type: details.type,
    name: details.name,
    poster: details.poster ?? null,
    background: details.background ?? null,
    season,
    episode,
    episodeTitle: video?.title ?? null,
  };
}

const ROUTE_NAMES = new Set<Route["name"]>([
  "home",
  "search",
  "library",
  "watched",
  "settings",
  "details",
  "player",
]);

/** History state can be missing or junk after a restore; never render a blank route. */
function validRoute(value: unknown): value is Route {
  if (!value || typeof value !== "object") return false;
  const route = value as Route;
  if (!ROUTE_NAMES.has(route.name)) return false;
  return route.name !== "details" || (Boolean(route.id) && Boolean(route.type));
}

/** The same screen with the same params: a second visit is not a new stop. */
function sameRoute(a: Route, b: Route): boolean {
  if (a.name !== b.name) return false;
  if (a.name === "search" && b.name === "search") return (a.query ?? "") === (b.query ?? "");
  if (a.name === "settings" && b.name === "settings")
    return (a.section ?? "") === (b.section ?? "");
  if (a.name === "details" && b.name === "details") return a.id === b.id && a.type === b.type;
  return true;
}

/** A stored position at or past this share of the runtime counts as finished. */
const FINISHED_SHARE = 0.9;

/** Info hashes arrive as 40 hex or 32 base32 chars; anything else never becomes a magnet. */
const INFO_HASH = /^(?:[0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/;

/** Controls the watchdog checks for effect; style pushes are not actions. */
const WATCHED_CONTROLS = new Set(["pause", "seek", "speed", "volume"]);

/** A snapshot in the shape the playback rules read. */
function toSample(snap: PlayerSnapshot): Sample {
  return {
    at: Date.now(),
    position: snap.position,
    duration: snap.duration,
    buffered: snap.buffered ?? 0,
    playing: snap.playing,
    paused: snap.paused,
    ended: snap.ended,
    // Missing track lists are unknown, not empty: only a real zero is a bug.
    audio: snap.audioTracks?.length ?? -1,
    subs: snap.subTracks?.length ?? -1,
    speed: snap.speed,
    volume: snap.volume,
  };
}


/** A finished title restarts instead of resuming its last few seconds. */
function resumePosition(position: number, duration: number): number {
  if (!(duration > 0)) return position > 0 ? position : 0;
  return position / duration >= FINISHED_SHARE ? 0 : position;
}

/**
 * The preferred quality when one matches, otherwise the best source offered.
 * A stream from the pack already playing wins first, so the next episode comes
 * out of the same download instead of hunting for a new one.
 */
export function pickSource(
  options: StreamOption[],
  quality: string,
  p2pAllowed = true,
  playing?: StreamOption | null,
  remembered?: SourceMemory | null,
): StreamOption | undefined {
  const playable = options.filter(
    (stream) => stream.playable && (p2pAllowed || Boolean(stream.url)),
  );
  // The source this session used last time wins, as long as the addon still
  // offers it.
  if (remembered) {
    const same = playable.find((stream) =>
      remembered.infoHash
        ? stream.addon === remembered.addon &&
          stream.infoHash?.toLowerCase() === remembered.infoHash.toLowerCase() &&
          (remembered.fileIdx == null || stream.fileIdx === remembered.fileIdx)
        : remembered.url
          ? stream.addon === remembered.addon && stream.url === remembered.url
          : stream.addon === remembered.addon &&
            stream.quality === remembered.quality &&
            (stream.fileIdx ?? null) === remembered.fileIdx,
    );
    if (same) return same;
  }
  if (playing?.infoHash) {
    const pack = playing.infoHash.toLowerCase();
    const samePack = playable.find((stream) => stream.infoHash?.toLowerCase() === pack);
    if (samePack) return samePack;
  }
  if (quality && quality !== "auto") {
    const wanted = quality.toLowerCase();
    const match = playable.find((stream) => stream.quality.toLowerCase().includes(wanted));
    if (match) return match;
  }
  const sameAddon = playing ? playable.find((stream) => stream.addon === playing.addon) : undefined;
  return sameAddon ?? playable[0];
}

/** The whole source a session played last time, so resuming skips the hunt. */
export type SourceMemory = StreamOption;

const SOURCE_MEMORY_KEY = "duvy:sources";
const SOURCE_MEMORY_LIMIT = 200;

function readSourceMemory(): Record<string, SourceMemory> {
  try {
    const raw = window.localStorage.getItem(SOURCE_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, SourceMemory>)
      : {};
  } catch {
    return {};
  }
}

export function rememberedSource(key: string | null | undefined): SourceMemory | null {
  if (!key) return null;
  const found = readSourceMemory()[key];
  return found && typeof found.addon === "string" && typeof found.quality === "string"
    ? found
    : null;
}

export function rememberSource(key: string | null | undefined, stream: StreamOption): void {
  if (!key) return;
  try {
    const all = readSourceMemory();
    all[key] = stream;
    const keys = Object.keys(all);
    for (const stale of keys.slice(0, Math.max(0, keys.length - SOURCE_MEMORY_LIMIT))) {
      delete all[stale];
    }
    window.localStorage.setItem(SOURCE_MEMORY_KEY, JSON.stringify(all));
  } catch {
    // Storage can be blocked; the hunt simply picks fresh next time.
  }
}

/** The subtitle a session used last time, so the same track comes back. */
export interface SubtitleMemory {
  lang: string;
  trackId?: number;
  url?: string;
  label?: string;
  off?: boolean;
}

const SUBTITLE_MEMORY_KEY = "duvy:subtitles";
const SUBTITLE_MEMORY_LIMIT = 200;

function readSubtitleMemory(): Record<string, SubtitleMemory> {
  try {
    const raw = window.localStorage.getItem(SUBTITLE_MEMORY_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, SubtitleMemory>)
      : {};
  } catch {
    return {};
  }
}

export function rememberedSubtitle(key: string | null | undefined): SubtitleMemory | null {
  if (!key) return null;
  const found = readSubtitleMemory()[key];
  if (!found || typeof found !== "object") return null;
  const usable = found.off === true || found.trackId != null || typeof found.url === "string";
  return usable ? found : null;
}

export function rememberSubtitle(key: string | null | undefined, choice: SubtitleMemory): void {
  if (!key) return;
  try {
    const all = readSubtitleMemory();
    all[key] = choice;
    const keys = Object.keys(all);
    for (const stale of keys.slice(0, Math.max(0, keys.length - SUBTITLE_MEMORY_LIMIT))) {
      delete all[stale];
    }
    window.localStorage.setItem(SUBTITLE_MEMORY_KEY, JSON.stringify(all));
  } catch {
    // Storage can be blocked; the player simply picks a track again.
  }
}

/** Explain why nothing could play, without sending the user to the addons page for a consent gate. */
export function noSourceError(options: StreamOption[], p2pAllowed: boolean): Error {
  if (!p2pAllowed && options.some((stream) => stream.playable && stream.infoHash)) {
    return new Error(
      "Only torrent sources are available. Enable P2P playback in Settings to play them.",
    );
  }
  return new Error("No playable source found for this title.");
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ name: "home" });
  const [booting, setBooting] = useState(true);
  const [bootError, setBootError] = useState<string | null>(null);
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [addons, setAddons] = useState<AddonInfo[]>([]);
  const [library, setLibrary] = useState<LibraryItem[]>([]);
  const [progress, setProgress] = useState<ProgressItem[]>([]);
  const [watched, setWatched] = useState<WatchedItem[]>([]);
  const [player, setPlayer] = useState<PlayerSnapshot | null>(null);
  const [playingSource, setPlayingSource] = useState<StreamOption | null>(null);
  const [starting, setStarting] = useState<StartingArt | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const toastId = useRef(1);
  const toastTimers = useRef(new Map<number, number>());
  const depth = useRef(0);
  const opening = useRef(false);
  // The newest player's generation; events from a killed one are ignored.
  const playerGen = useRef(0);
  // A click bumps this, so a cancelled start cannot open a player afterwards.
  const startToken = useRef(0);
  // The item whose source is being found right now, so a different click can
  // say what it is waiting for instead of dying silently.
  const pending = useRef<{ id: string; name: string } | null>(null);
  const saveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const toggling = useRef(new Set<string>());
  const progressFails = useRef(0);
  const routeRef = useRef<Route>(route);
  const lastSession = useRef<PlaybackSession | null>(null);
  const playerBase = useRef<Route | null>(null);
  // Watchdog for an open that never paints, which is otherwise invisible.
  const openStartedAt = useRef(0);
  const openedAt = useRef(0);
  const firstFrame = useRef(false);
  const stopRequested = useRef(false);
  const frameErrorReported = useRef(0);
  const frameTimer = useRef<number | null>(null);
  // The playback watchdog: rules over the snapshot stream, one set per open.
  const watch = useRef(createWatch(0));
  const playerRef = useRef<PlayerSnapshot | null>(null);
  const lastTick = useRef<{ key: string; position: number; duration: number; ended: boolean } | null>(
    null,
  );

  const dismissToast = useCallback((id: number) => {
    const timer = toastTimers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    toastTimers.current.delete(id);
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const notify = useCallback(
    (text: string, tone: ToastTone = "info") => {
      // Every failure the user is told about is also a failure we could fix.
      if (tone === "error") report(text, { area: "ui" });
      const id = toastId.current++;
      setToasts((current) => [...current.slice(-4), { id, text, tone }]);
      toastTimers.current.set(id, window.setTimeout(() => dismissToast(id), 4200));
    },
    [dismissToast],
  );

  // A pending dismiss must not outlive the provider (or fire into a new toast).
  useEffect(() => {
    const timers = toastTimers.current;
    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const clearFrameWatchdog = useCallback(() => {
    if (frameTimer.current !== null) window.clearTimeout(frameTimer.current);
    frameTimer.current = null;
  }, []);

  /** An open that never shows a picture is a bug, not a slow source. */
  const armFrameWatchdog = useCallback(
    (title: string, sessionKey: string | null) => {
      clearFrameWatchdog();
      if (!isTauri()) return;
      frameTimer.current = window.setTimeout(() => {
        if (firstFrame.current || stopRequested.current) return;
        const waitedMs = Date.now() - openedAt.current;
        note("no first frame", { waitedMs });
        report(new Error("Player opened but never showed a frame"), {
          area: "playback",
          withLog: true,
          extra: { title, session: sessionKey, waitedMs },
        });
      }, 12000);
    },
    [clearFrameWatchdog],
  );

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    const current = routeRef.current;
    // Re-clicking the screen already open used to push a duplicate entry, so
    // back needed one press per click.
    if (sameRoute(current, next)) return;
    // The player never stacks an entry: leaving it (or opening the next source)
    // replaces the player entry, so back can not land on a dead screen. A
    // settings section is a tab of one screen, not a new stop.
    const replace =
      Boolean(options?.replace) ||
      current.name === "player" ||
      (current.name === "settings" && next.name === "settings");
    if (!replace) {
      depth.current += 1;
      // Remember the screen the player was opened from, so leaving can pop
      // straight back to it instead of stacking a second copy of the same page.
      if (next.name === "player") playerBase.current = current;
    }
    const state = { route: next, depth: depth.current };
    if (replace) window.history.replaceState(state, "");
    else window.history.pushState(state, "");
    routeRef.current = next;
    setRoute(next);
  }, []);

  // Land on the title that was playing, otherwise home. No-op off the player.
  const leavePlayer = useCallback(() => {
    if (routeRef.current.name !== "player") return;
    const session = lastSession.current;
    const target: Route = session
      ? { name: "details", id: session.metaId, type: session.type }
      : { name: "home" };
    const base = playerBase.current;
    playerBase.current = null;
    const sameScreen =
      base != null &&
      base.name === target.name &&
      (base.name !== "details" ||
        (target.name === "details" && base.id === target.id && base.type === target.type));
    if (sameScreen && depth.current > 0) {
      // The entry underneath is already the right screen: pop to it. Show it
      // now, so no screen navigates a second time while the pop lands.
      routeRef.current = target;
      depth.current -= 1;
      setRoute(target);
      window.history.back();
      return;
    }
    navigate(target, { replace: true });
  }, [navigate]);

  // window.history.back() on the first entry does nothing (or leaves the app),
  // so fall back to home when there is nowhere to go back to.
  const back = useCallback(() => {
    if (depth.current > 0) window.history.back();
    else {
      routeRef.current = { name: "home" };
      setRoute({ name: "home" });
    }
  }, []);

  useEffect(() => {
    window.history.replaceState({ route: { name: "home" }, depth: 0 }, "");
    const onPop = (event: PopStateEvent) => {
      const state = event.state as { route?: Route; depth?: number } | null;
      const saved = state?.route;
      const next: Route = validRoute(saved) ? saved : { name: "home" };
      depth.current =
        typeof state?.depth === "number" && state.depth > 0 ? Math.floor(state.depth) : 0;
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A restored player entry (or a close the screen never saw) has no session:
  // leave it instead of showing the empty player.
  useEffect(() => {
    if (route.name === "player" && !player && !starting) leavePlayer();
  }, [leavePlayer, player, route.name, starting]);

  // The close event carries no session, so remember the last one to return to.
  useEffect(() => {
    if (player?.session) lastSession.current = player.session;
  }, [player]);

  const refreshAddons = useCallback(async () => {
    setAddons(await api.addons.list());
  }, []);

  const refreshLibrary = useCallback(async () => {
    setLibrary(await api.library.list());
  }, []);

  const refreshProgress = useCallback(async () => {
    try {
      const [rows, marks] = await Promise.all([api.progress.list(), api.watched.list()]);
      setProgress(rows);
      setWatched(marks);
      progressFails.current = 0;
    } catch {
      // Progress is cosmetic; a failed refresh must never break a screen. Two in
      // a row is worth one quiet note that the timeline is stale.
      progressFails.current += 1;
      if (progressFails.current === 2) notify("Could not refresh progress");
    }
  }, [notify]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        // One failing slice (a broken addon store, a locked progress file) must
        // not cost the whole app: apply what loaded, then say what did not.
        const [info, loadedSettings, loadedAddons, loadedLibrary, loadedProgress, loadedWatched] =
          await Promise.allSettled([
            api.appInfo(),
            api.settings.get(),
            api.addons.list(),
            api.library.list(),
            api.progress.list(),
            api.watched.list(),
          ]);
        if (!alive) return;
        if (info.status === "rejected") throw info.reason;
        setAppInfo(info.value);
        if (loadedSettings.status === "fulfilled") setSettings(loadedSettings.value);
        if (loadedAddons.status === "fulfilled") setAddons(loadedAddons.value);
        if (loadedLibrary.status === "fulfilled") setLibrary(loadedLibrary.value);
        if (loadedProgress.status === "fulfilled") setProgress(loadedProgress.value);
        if (loadedWatched.status === "fulfilled") setWatched(loadedWatched.value);
        const failed = (
          [
            ["settings", loadedSettings.status],
            ["addons", loadedAddons.status],
            ["library", loadedLibrary.status],
            ["progress", loadedProgress.status],
            ["watched", loadedWatched.status],
          ] as const
        )
          .filter(([, status]) => status === "rejected")
          .map(([name]) => name);
        if (failed.length) notify(`Could not load ${failed.join(", ")}.`, "error");
      } catch (error) {
        if (alive) setBootError(errorMessage(error));
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [notify]);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.accent = settings.accent;
    document.documentElement.dataset.motion = settings.reduceMotion ? "reduced" : "full";
  }, [settings?.accent, settings?.reduceMotion]);

  // Keep Stremio and Nuvio in step with the phone and the official apps: once
  // on launch, then every few minutes while this app stays open.
  useEffect(() => {
    if (!settings?.nuvioAutoSync && !settings?.stremioAutoSync) return;
    let alive = true;
    let running = false;
    const run = async () => {
      // A pass that outlives its interval must not stack a second one.
      if (running) return;
      running = true;
      try {
        await api.sync.all();
        if (!alive) return;
        await Promise.all([refreshProgress(), refreshLibrary(), refreshAddons()]);
      } catch {
        // Offline, or signed out elsewhere. The next tick tries again.
      } finally {
        running = false;
      }
    };
    void run();
    const timer = setInterval(() => void run(), 2.5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [settings?.nuvioAutoSync, settings?.stremioAutoSync, refreshProgress, refreshLibrary, refreshAddons]);

  // The background check announces a new release; the prompt shows it.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<UpdateInfo>("update:available", (event) => {
      // The prompt in the middle of the window carries this, not a toast.
      setUpdate(event.payload);
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // No event bridge: a manual check in Settings still works.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // The bundled addon is installed after the first list load; pick it up live.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("addons:changed", () => {
      // The next launch lists them anyway; a failed refresh is not an error.
      void refreshAddons().catch(() => {});
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // No event bridge: the next launch loads the list anyway.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [refreshAddons]);

  // Player events are pushed from Rust while mpv is running.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    // Kept as each one attaches: a later listen failing must not strand it.
    const keep = (stop: () => void) => {
      if (disposed) stop();
      else unlisteners.push(stop);
    };
    const attach = async () => {
      try {
        keep(
          await listen<PlayerSnapshot>("player:tick", (event) => {
            if (!event.payload) return;
            const generation = event.payload.generation ?? 0;
            // A dead player's last tick can land after the next one is stored.
            if (generation !== 0 && generation < playerGen.current) return;
            playerGen.current = Math.max(playerGen.current, generation);
            setPlayer(event.payload);
            const snap = event.payload;
            if (!firstFrame.current && (snap.started === true || snap.position > 0)) {
              firstFrame.current = true;
              clearFrameWatchdog();
              note("first frame", {
                generation,
                position: Math.round(snap.position),
                duration: Math.round(snap.duration),
              });
            }
            // mpv reports a source it cannot open in the tick, so a failure to
            // play can arrive without a single thrown error.
            if (snap.error && generation !== frameErrorReported.current) {
              frameErrorReported.current = generation;
              note("mpv refused the source", { error: snap.error });
              report(new Error(`mpv: ${snap.error}`), {
                area: "playback",
                withLog: true,
                extra: {
                  position: Math.round(snap.position),
                  duration: Math.round(snap.duration),
                  buffered: Math.round(snap.buffered ?? 0),
                },
              });
            }
            playerRef.current = snap;
            if (snap.session?.key) {
              lastTick.current = {
                key: snap.session.key,
                position: snap.position,
                duration: snap.duration,
                ended: snap.ended,
              };
            }
            // Frozen playhead, dead controls, silent tracks: all state, no error.
            for (const issue of watchSample(watch.current, toSample(snap))) {
              note(`rule ${issue.rule}`, issue.data);
              report(new Error(issue.message), {
                area: "playback",
                withLog: true,
                extra: { rule: issue.rule, ...issue.data, timeline: timeline(watch.current) },
              });
            }
          }),
        );
        keep(
          await listen<number>("player:closed", (event) => {
            const generation = event.payload ?? 0;
            // Stopping takes a moment to report; a player started in that gap wins.
            if (generation !== 0 && generation < playerGen.current) return;
            // Any tick still in flight from this player is now stale.
            playerGen.current = Math.max(playerGen.current, generation + 1);
            const afterMs = Date.now() - openedAt.current;
            const diedEarly =
              !firstFrame.current && !stopRequested.current && openedAt.current > 0 && afterMs < 15000;
            clearFrameWatchdog();
            setPlayer(null);
            playerRef.current = null;
            if (diedEarly) {
              note("closed before first frame", { afterMs, generation });
              report(new Error("Player closed before the first frame"), {
                area: "playback",
                withLog: true,
                extra: { afterMs, generation },
              });
            }
            const last = lastTick.current;
            lastTick.current = null;
            if (settings?.trackProgress && last && last.position > 60 && !last.ended) {
              // The ticker writes the playhead itself; a missing row or a stale
              // one is lost progress, which looks like "it forgot where I was".
              void api.progress
                .forKey(last.key)
                .then((row) => {
                  const saved = row?.position ?? null;
                  if (saved == null || Math.abs(saved - last.position) > 120) {
                    report(new Error("Playback progress was not saved"), {
                      area: "progress",
                      extra: {
                        session: last.key,
                        stoppedAt: Math.round(last.position),
                        saved: saved == null ? null : Math.round(saved),
                      },
                    });
                  }
                })
                .catch(() => {
                  // Reading it back is diagnostic only.
                });
            }
            leavePlayer();
            void refreshProgress();
          }),
        );
        keep(
          await listen("player:ended", () => {
            void refreshProgress();
          }),
        );
      } catch {
        // Without the event bridge the player still works through polling.
        unlisteners.splice(0).forEach((unlisten) => unlisten());
      }
    };
    void attach();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [clearFrameWatchdog, leavePlayer, refreshProgress, settings?.trackProgress]);

  const saveSettings = useCallback(
    (patch: Partial<Settings>) => {
      // One write at a time: a slow earlier patch must not land after a newer
      // one and put the old value back on screen.
      const next = saveQueue.current.catch(() => {}).then(() => api.settings.set(patch));
      saveQueue.current = next;
      return next.then(async (saved) => {
        setSettings(saved);
        // Only re-probe the player when the executable itself changed.
        if ("mpvPath" in patch) {
          // The patch is saved; a failed probe must not report it as lost.
          await api.appInfo().then(setAppInfo, () => {});
        }
      });
    },
    [],
  );

  const toggleLibrary = useCallback(
    async (item: MetaPreview) => {
      // Two fast clicks on the same poster would race two toggles and land the
      // badge on the wrong state.
      if (toggling.current.has(item.id)) return;
      toggling.current.add(item.id);
      const entry: LibraryItem = {
        id: item.id,
        type: item.type,
        name: item.name,
        poster: item.poster ?? null,
        background: item.background ?? null,
        addedAt: Date.now(),
        meta: item,
      };
      try {
        const added = await api.library.toggle(entry);
        // The toggle already reports the new state, so update in place instead
        // of re-listing the whole library for every click.
        setLibrary((current) =>
          added
            ? current.some((row) => row.id === item.id)
              ? current
              : [entry, ...current]
            : current.filter((row) => row.id !== item.id),
        );
        notify(
          added ? `Added ${item.name} to your library` : `Removed ${item.name}`,
          added ? "success" : "info",
        );
      } catch (error) {
        notify(errorMessage(error), "error");
      } finally {
        toggling.current.delete(item.id);
      }
    },
    [notify],
  );

  // Marking a title watched, and noticing when that leaves a worse row behind.
  const markWatched = useCallback(
    async (key: string, metaId: string, watched: boolean) => {
      note("mark watched", { key, metaId, watched });
      await api.progress.setWatched(key, metaId, watched);
      if (watched) {
        const rows = progress.filter((row) => row.metaId === metaId);
        const marked = rows.find((row) => row.key === key);
        const newest = rows.reduce<ProgressItem | null>(
          (best, row) => (best == null || row.updatedAt > best.updatedAt ? row : best),
          null,
        );
        const older = rows
          .filter((row) => row.key !== key && row.updatedAt < (marked?.updatedAt ?? 0))
          .sort((a, b) => b.updatedAt - a.updatedAt)[0];
        // Finishing the newest episode used to leave an older one as the card
        // to resume, so the show appeared to jump backwards.
        if (marked && newest?.key === key && older && wentBackwards(older, marked)) {
          report(new Error("Watched mark leaves an earlier episode as the resume target"), {
            area: "progress",
            extra: {
              metaId,
              marked: key,
              markedAt: `${marked.season ?? "?"}x${marked.episode ?? "?"}`,
              fallback: older.key,
              fallbackAt: `${older.season ?? "?"}x${older.episode ?? "?"}`,
            },
          });
        }
      }
      await refreshProgress();
    },
    [progress, refreshProgress],
  );

  /** The user asked to stop: a close that follows is not a failure. */
  const stopPlayer = useCallback(() => {
    stopRequested.current = true;
    clearFrameWatchdog();
    void api.player.stop().catch(() => undefined);
  }, [clearFrameWatchdog]);

  /** Send control, but remember it: a control that lands nowhere is a bug. */
  const playerControl = useCallback((kind: string, value?: number | string | boolean | null) => {
    const snap = playerRef.current;
    if (snap && WATCHED_CONTROLS.has(kind)) {
      watchAction(watch.current, kind, toSample(snap), typeof value === "number" ? value : 0);
      note("control", { kind, value: typeof value === "number" ? value : null });
    }
    void api.player.control(kind, value).catch(() => undefined);
  }, []);

  const libraryIds = useMemo(() => new Set(library.map((item) => item.id)), [library]);
  const progressByKey = useMemo(
    () => new Map(progress.map((item) => [item.key, item])),
    [progress],
  );

  const inLibrary = useCallback((id: string) => libraryIds.has(id), [libraryIds]);

  const checkUpdate = useCallback(async () => {
    const found = await api.updates.check();
    // A release that was pulled is gone from the answer, so replace, not merge.
    setUpdate(found);
    return found;
  }, []);

  const skipUpdate = useCallback(
    async (version: string) => {
      await saveSettings({ ignoredUpdateVersion: version });
      setUpdate((current) => (current?.version === version ? null : current));
      notify(`Updates to ${version} stay quiet until a newer release`);
    },
    [saveSettings, notify],
  );

  const progressFor = useCallback(
    (key: string) => progressByKey.get(key),
    [progressByKey],
  );

  // The player is a screen, not a spinner on the previous one: show it at once
  // and let it carry the wait.
  const beginStart = useCallback(
    async (
      art: StartingArt & {
        poster?: string | null;
        id?: string;
        metaId?: string;
        type?: string;
      },
      sub?: string | null,
    ) => {
      const token = startToken.current + 1;
      startToken.current = token;
      const metaId = art.metaId ?? art.id ?? null;
      const cached = art.logo ?? rememberedLogo(metaId);
      // Art is a decoration, so the player opens now and the logo lands behind it.
      setStarting({
        name: art.name,
        sub: sub ?? null,
        logo: cached ?? null,
        background: art.background ?? art.poster ?? null,
      });
      navigate({ name: "player" });
      if (!cached && metaId && art.type) {
        void api
          .details(metaId, art.type)
          .then((details) => {
            if (startToken.current !== token || !details.logo) return;
            setStarting((current) => (current ? { ...current, logo: details.logo } : current));
          })
          .catch(() => {});
      }
      return token;
    },
    [navigate],
  );

  const finishStart = useCallback((token: number) => {
    if (startToken.current === token) setStarting(null);
  }, []);

  // Pop the player entry the start added, landing on the screen that launched it.
  const leaveStart = useCallback(() => {
    const base = playerBase.current;
    playerBase.current = null;
    if (base && depth.current > 0) {
      routeRef.current = base;
      depth.current -= 1;
      setRoute(base);
      window.history.back();
      return;
    }
    navigate({ name: "home" }, { replace: true });
  }, [navigate]);

  const cancelStart = useCallback(() => {
    startToken.current += 1;
    pending.current = null;
    setStarting(null);
    leaveStart();
  }, [leaveStart]);

  const playRequest = useCallback(
    async (request: PlayRequest): Promise<boolean> => {
      // A double click used to start two players; the last one won, but both
      // sessions were spawned and both were pushed onto history.
      if (opening.current) {
        // A second click within a moment is a double click. Long after that,
        // an open that never settled is why nothing plays.
        const waited = Date.now() - openStartedAt.current;
        if (waited > 3000) {
          note("open ignored, previous open pending", { waitedMs: waited, title: request.title });
          report(new Error("Play request ignored: an earlier open never settled"), {
            area: "playback",
            withLog: true,
            extra: { waitedMs: waited, title: request.title, session: request.session?.key ?? null },
          });
        }
        return false;
      }
      opening.current = true;
      openStartedAt.current = Date.now();
      note("open requested", {
        title: request.title,
        startAt: Math.round(request.startAt ?? 0),
        session: request.session?.key ?? null,
      });
      try {
        const snapshot = await api.player.open(request);
        playerGen.current = Math.max(playerGen.current, snapshot.generation ?? 0);
        setPlayer(snapshot);
        playerRef.current = snapshot;
        watch.current = createWatch(Date.now());
        lastTick.current = null;
        openedAt.current = Date.now();
        firstFrame.current = false;
        stopRequested.current = false;
        frameErrorReported.current = 0;
        armFrameWatchdog(request.title, request.session?.key ?? null);
        note("open returned", { generation: snapshot.generation ?? 0 });
        // The screen is already up while the source resolves.
        if (routeRef.current.name !== "player") navigate({ name: "player" });
        return true;
      } catch (error) {
        note("open failed", { error: errorMessage(error) });
        notify(errorMessage(error), "error");
        return false;
      } finally {
        opening.current = false;
      }
    },
    [armFrameWatchdog, navigate, notify],
  );

  const buildSession = useCallback((details: Details, video: Video | null) => {
    return sessionFor(details, video);
  }, []);

  /**
   * Turn a source row into something mpv can actually open: HTTP links pass
   * through (debrid accounts may still need to unrestrict them), torrents try
   * the connected debrid first, then the local engine behind the P2P gate.
   */
  const resolveStream = useCallback(
    async (stream: StreamOption): Promise<string> => {
      // Some addons put a magnet or a bare hash in `url`; both are torrents.
      const raw = stream.url ?? "";
      const magnetUrl = /^magnet:/i.test(raw);
      const bare = !magnetUrl && INFO_HASH.test(raw);
      const direct = magnetUrl || bare ? "" : raw;

      if (direct) {
        // Only real web links may reach mpv: no file:// or javascript: rows.
        if (!/^https?:\/\//i.test(direct)) {
          throw new Error("That source has a link mpv cannot open.");
        }
        const providers = await api.debrid.providers().catch(() => []);
        const url = providers.some((provider) => provider.connected)
          ? await api.debrid.resolve(direct)
          : direct;
        setPlayingSource(stream);
        return url;
      }

      const hashFromUrl = magnetUrl
        ? /xt=urn:btih:([0-9a-z]+)/i.exec(raw)?.[1]
        : undefined;
      const candidates = [bare ? raw : "", stream.infoHash ?? "", hashFromUrl ?? ""]
        .map((value) => value.trim())
        .filter(Boolean);
      if (!candidates.length) throw new Error("That source has no link or info hash to play.");
      const hash = candidates.find((value) => INFO_HASH.test(value));
      if (!hash) throw new Error("That source has an invalid info hash.");
      // Only the hash and the file index: a stray addon parameter never rides along.
      const magnet = `magnet:?xt=urn:btih:${hash}${stream.fileIdx != null ? `&fileIdx=${stream.fileIdx}` : ""}`;

      // A connected debrid beats the local engine: it has the file already.
      const providers = await api.debrid.providers().catch(() => []);
      let debridError: unknown = null;
      if (providers.some((provider) => provider.connected)) {
        try {
          const url = await api.debrid.resolve(magnet);
          setPlayingSource(stream);
          return url;
        } catch (error) {
          debridError = error;
        }
      }
      if (!settings?.p2pConsent) {
        // Surface the real debrid failure instead of blaming the P2P gate.
        if (debridError) throw debridError;
        throw new Error(
          "That is a torrent source. Allow P2P playback in Settings before starting it.",
        );
      }
      const url = await api.torrent.start(
        magnet,
        stream.fileIdx != null ? String(stream.fileIdx) : undefined,
      );
      setPlayingSource(stream);
      return url;
    },
    [settings?.p2pConsent],
  );

  /** Resolve metadata, resume point, and the best playable source in one go. */
  const playItem = useCallback(
    async (item: MetaPreview, fromStart = false) => {
      // One click, one chain: a second click while a source is still being
      // found used to start a whole second hunt behind the first.
      const id = fromStart ? `${item.id}:start` : item.id;
      const busy = pending.current;
      if (busy) {
        if (busy.id !== id) notify(`Already starting ${busy.name}`);
        return;
      }
      const chain = { id, name: item.name };
      pending.current = chain;
      const token = await beginStart(item);
      try {
        // A movie's tt id is what the stream addons key on, so the hunt can run
        // alongside the details fetch instead of queueing behind it.
        const early =
          item.type === "movie" && item.id.startsWith("tt")
            ? api.streams({ id: item.id, mediaType: item.type }).catch(() => null)
            : null;
        const details = await api.details(item.id, item.type);
        if (startToken.current !== token) return;
        let video: Video | null = null;
        if (details.type === "series") {
          const last = progress
            .filter((entry) => entry.metaId === details.id)
            .sort((a, b) => b.updatedAt - a.updatedAt)[0];
          video =
            (last
              ? details.videos.find(
                  (candidate) =>
                    candidate.season === last.season &&
                    (candidate.episode ?? candidate.number) === last.episode,
                )
              : undefined) ??
            details.videos[0] ??
            null;
          if (!video) throw new Error("This show has no episodes listed yet.");
        }
        const session = sessionFor(details, video);
        const memory = rememberedSource(session.key);
        const stored = progressFor(session.key);
        const resume =
          settings?.autoResume && !fromStart
            ? resumePosition(stored?.position ?? 0, stored?.duration ?? 0)
            : 0;
        let source: StreamOption | null = null;
        let url: string | null = null;
        if (memory) {
          // The same source worked last time: skip the hunt and resolve it.
          try {
            url = await resolveStream(memory);
            source = memory;
          } catch {
            url = null;
          }
        }
        if (!source) {
          const options =
            (details.type === item.type ? await early : null) ??
            (await api.streams({
              id: details.imdbId ?? details.id,
              mediaType: details.type,
              season: session.season,
              episode: session.episode,
              imdbId: details.imdbId,
            }));
          if (startToken.current !== token) return;
          const found = pickSource(
            options,
            settings?.preferredQuality ?? "auto",
            settings?.p2pConsent ?? false,
            playingSource,
            memory,
          );
          if (!found) throw noSourceError(options, settings?.p2pConsent ?? false);
          url = await resolveStream(found);
          source = found;
        }
        if (!url || !source) {
          note("hunt resolved nothing", { session: session.key });
          report(new Error("A source hunt finished with nothing to play"), {
            area: "playback",
            extra: { session: session.key, name: details.name },
          });
          return;
        }
        if (startToken.current !== token) return;
        const label = video
          ? `${details.name} · S${video.season ?? 1}E${video.episode ?? video.number ?? 1}`
          : details.name;
        const opened = await playRequest({ url, title: label, startAt: resume, session });
        if (opened) rememberSource(session.key, source);
        if (!opened && startToken.current === token) leaveStart();
      } catch (error) {
        // The screen is already open, so a failed hunt returns to where it began.
        if (startToken.current === token) {
          note("hunt failed", { error: errorMessage(error) });
          notify(errorMessage(error), "error");
          leaveStart();
        }
      } finally {
        if (pending.current === chain) pending.current = null;
        finishStart(token);
      }
    },
    [
      beginStart,
      finishStart,
      leaveStart,
      notify,
      playRequest,
      progress,
      progressFor,
      resolveStream,
      settings?.autoResume,
      settings?.p2pConsent,
      settings?.preferredQuality,
      playingSource,
    ],
  );

  /** Resume a specific Continue Watching entry (exact episode, exact position). */
  const resumeEntry = useCallback(
    async (entry: ProgressItem) => {
      const busy = pending.current;
      if (busy) {
        if (busy.id !== entry.key) notify(`Already starting ${busy.name}`);
        return;
      }
      const chain = { id: entry.key, name: entry.name };
      pending.current = chain;
      const token = await beginStart(
        entry,
        entry.type === "series" ? seasonLabel(entry.season, entry.episode) : null,
      );
      try {
        // The entry already carries every session field, and a tt id is exactly
        // what the stream addons key on, so metadata is only needed to hunt.
        const imdbId = entry.metaId.startsWith("tt") ? entry.metaId : null;
        const session: PlaybackSession = {
          key: entry.key,
          metaId: entry.metaId,
          type: entry.type,
          name: entry.name,
          poster: entry.poster ?? null,
          background: entry.background ?? null,
          season: entry.season ?? null,
          episode: entry.episode ?? null,
          episodeTitle: entry.episodeTitle ?? null,
        };
        const memory = rememberedSource(session.key);
        let source: StreamOption | null = null;
        let url: string | null = null;
        if (memory) {
          // The same source worked last time: skip the hunt and resolve it.
          try {
            url = await resolveStream(memory);
            source = memory;
          } catch {
            url = null;
          }
        }
        if (!source) {
          const details = imdbId ? null : await api.details(entry.metaId, entry.type);
          if (startToken.current !== token) return;
          if (details && entry.type === "series" && details.videos.length === 0) {
            setStarting(null);
            navigate({ name: "details", id: entry.metaId, type: entry.type });
            return;
          }
          const sources = await api.streams({
            id: imdbId ?? details?.imdbId ?? details?.id ?? entry.metaId,
            mediaType: details?.type ?? entry.type,
            season: entry.season,
            episode: entry.episode,
            imdbId: imdbId ?? details?.imdbId ?? null,
          });
          if (startToken.current !== token) return;
          const found = pickSource(
            sources,
            settings?.preferredQuality ?? "auto",
            settings?.p2pConsent ?? false,
            playingSource,
            memory,
          );
          if (!found) throw noSourceError(sources, settings?.p2pConsent ?? false);
          url = await resolveStream(found);
          source = found;
        }
        if (!url || !source) {
          note("resume resolved nothing", { session: session.key });
          report(new Error("Resuming finished with nothing to play"), {
            area: "playback",
            extra: {
              session: session.key,
              season: entry.season ?? null,
              episode: entry.episode ?? null,
            },
          });
          return;
        }
        if (startToken.current !== token) return;
        const opened = await playRequest({
          url,
          title:
            entry.type === "series"
              ? `${entry.name} · ${seasonLabel(entry.season, entry.episode)}`
              : entry.name,
          startAt: resumePosition(entry.position, entry.duration),
          session,
        });
        if (opened) rememberSource(session.key, source);
        if (!opened && startToken.current === token) leaveStart();
      } catch (error) {
        if (startToken.current === token) {
          note("resume failed", { error: errorMessage(error) });
          notify(errorMessage(error), "error");
          leaveStart();
        }
      } finally {
        if (pending.current === chain) pending.current = null;
        finishStart(token);
      }
    },
    [
      beginStart,
      finishStart,
      leaveStart,
      navigate,
      notify,
      playRequest,
      resolveStream,
      settings?.p2pConsent,
      settings?.preferredQuality,
      playingSource,
    ],
  );

  const value = useMemo<Store>(
    () => ({
      booting,
      bootError,
      appInfo,
      settings,
      addons,
      library,
      progress,
      progressByKey,
      libraryIds,
      toasts,
      route,
      starting,
      cancelStart,
      navigate,
      back,
      leavePlayer,
      refreshAddons,
      refreshLibrary,
      refreshProgress,
      saveSettings,
      markWatched,
      stopPlayer,
      playerControl,
      toggleLibrary,
      inLibrary,
      update,
      checkUpdate,
      skipUpdate,
      notify,
      dismissToast,
      progressFor,
      watched,
      playRequest,
      playItem,
      resumeEntry,
      buildSession,
      resolveStream,
      playingSource,
    }),
    [
      booting,
      bootError,
      appInfo,
      settings,
      addons,
      library,
      progress,
      progressByKey,
      libraryIds,
      toasts,
      route,
      starting,
      cancelStart,
      navigate,
      back,
      leavePlayer,
      refreshAddons,
      refreshLibrary,
      refreshProgress,
      saveSettings,
      markWatched,
      stopPlayer,
      playerControl,
      toggleLibrary,
      inLibrary,
      update,
      checkUpdate,
      skipUpdate,
      notify,
      dismissToast,
      progressFor,
      watched,
      playRequest,
      playItem,
      resumeEntry,
      buildSession,
      resolveStream,
      playingSource,
    ],
  );

  return (
    <StoreContext.Provider value={value}>
      <PlayerContext.Provider value={player}>{children}</PlayerContext.Provider>
    </StoreContext.Provider>
  );
}
