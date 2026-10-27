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
import { seasonLabel } from "./format";
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
  Video,
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
  toasts: Toast[];
  route: Route;
  navigate: (route: Route) => void;
  back: () => void;
  /** Leave the player for the playing title, without stacking a second copy. */
  leavePlayer: () => void;
  refreshAddons: () => Promise<void>;
  refreshLibrary: () => Promise<void>;
  refreshProgress: () => Promise<void>;
  saveSettings: (patch: Partial<Settings>) => Promise<void>;
  toggleLibrary: (item: MetaPreview) => Promise<void>;
  inLibrary: (id: string) => boolean;
  notify: (text: string, tone?: ToastTone) => void;
  dismissToast: (id: number) => void;
  progressFor: (key: string) => ProgressItem | undefined;
  playRequest: (request: PlayRequest) => Promise<void>;
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

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return "Something went wrong";
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
): StreamOption | undefined {
  const playable = options.filter(
    (stream) => stream.playable && (p2pAllowed || Boolean(stream.url)),
  );
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
  const [player, setPlayer] = useState<PlayerSnapshot | null>(null);
  const [playingSource, setPlayingSource] = useState<StreamOption | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastId = useRef(1);
  const depth = useRef(0);
  const opening = useRef(false);
  const pending = useRef(false);
  const routeRef = useRef<Route>(route);
  const lastSession = useRef<PlaybackSession | null>(null);
  const playerBase = useRef<Route | null>(null);

  const notify = useCallback((text: string, tone: ToastTone = "info") => {
    const id = toastId.current++;
    setToasts((current) => [...current.slice(-4), { id, text, tone }]);
    window.setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  const navigate = useCallback((next: Route, options?: { replace?: boolean }) => {
    // The player never stacks an entry: leaving it (or opening the next source)
    // replaces the player entry, so back can not land on a dead screen.
    const replace = Boolean(options?.replace) || routeRef.current.name === "player";
    if (!replace) {
      depth.current += 1;
      // Remember the screen the player was opened from, so leaving can pop
      // straight back to it instead of stacking a second copy of the same page.
      if (next.name === "player") playerBase.current = routeRef.current;
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
      // The entry underneath is already the right screen: pop to it.
      routeRef.current = target;
      depth.current -= 1;
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
      const next = state?.route ?? { name: "home" };
      depth.current = state?.depth ?? 0;
      routeRef.current = next;
      setRoute(next);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // A restored player entry (or a close the screen never saw) has no session:
  // leave it instead of showing the empty player.
  useEffect(() => {
    if (route.name === "player" && !player) leavePlayer();
  }, [leavePlayer, player, route.name]);

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
      setProgress(await api.progress.list());
    } catch {
      // Progress is cosmetic; a failed refresh must never break a screen.
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [info, loadedSettings, loadedAddons, loadedLibrary, loadedProgress] =
          await Promise.all([
            api.appInfo(),
            api.settings.get(),
            api.addons.list(),
            api.library.list(),
            api.progress.list(),
          ]);
        if (!alive) return;
        setAppInfo(info);
        setSettings(loadedSettings);
        setAddons(loadedAddons);
        setLibrary(loadedLibrary);
        setProgress(loadedProgress);
      } catch (error) {
        if (alive) setBootError(errorMessage(error));
      } finally {
        if (alive) setBooting(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.accent = settings.accent;
    document.documentElement.dataset.motion = settings.reduceMotion ? "reduced" : "full";
  }, [settings?.accent, settings?.reduceMotion]);

  // Keep the Nuvio account in step with the phone and the official desktop app:
  // once on launch, then every few minutes while the app stays open.
  useEffect(() => {
    if (!settings?.nuvioAutoSync) return;
    let alive = true;
    const run = async () => {
      try {
        const status = await api.nuvio.status();
        if (!status.signedIn) return;
        await api.nuvio.syncNow();
        if (!alive) return;
        await Promise.all([refreshProgress(), refreshLibrary(), refreshAddons()]);
      } catch {
        // Offline, or signed out elsewhere. The next tick tries again.
      }
    };
    void run();
    const timer = setInterval(() => void run(), 5 * 60 * 1000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [settings?.nuvioAutoSync, refreshProgress, refreshLibrary, refreshAddons]);

  // Player events are pushed from Rust while mpv is running.
  useEffect(() => {
    if (!isTauri()) return;
    const unlisteners: Array<() => void> = [];
    let disposed = false;
    const attach = async () => {
      try {
        const tick = await listen<PlayerSnapshot>("player:tick", (event) => {
          setPlayer(event.payload);
        });
        const closed = await listen("player:closed", () => {
          setPlayer(null);
          leavePlayer();
          void refreshProgress();
        });
        const ended = await listen("player:ended", () => {
          void refreshProgress();
        });
        if (disposed) {
          tick();
          closed();
          ended();
          return;
        }
        unlisteners.push(tick, closed, ended);
      } catch {
        // Without the event bridge the player still works through polling.
      }
    };
    void attach();
    return () => {
      disposed = true;
      unlisteners.forEach((unlisten) => unlisten());
    };
  }, [leavePlayer, refreshProgress]);

  const saveSettings = useCallback(
    async (patch: Partial<Settings>) => {
      const next = await api.settings.set(patch);
      setSettings(next);
      // Only re-probe the player when the executable itself changed.
      if ("mpvPath" in patch) {
        const info = await api.appInfo();
        setAppInfo(info);
      }
    },
    [],
  );

  const toggleLibrary = useCallback(
    async (item: MetaPreview) => {
      try {
        const added = await api.library.toggle({
          id: item.id,
          type: item.type,
          name: item.name,
          poster: item.poster ?? null,
          background: item.background ?? null,
          addedAt: Date.now(),
          meta: item,
        });
        await refreshLibrary();
        notify(
          added ? `Added ${item.name} to your library` : `Removed ${item.name}`,
          added ? "success" : "info",
        );
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    },
    [notify, refreshLibrary],
  );

  const inLibrary = useCallback(
    (id: string) => library.some((item) => item.id === id),
    [library],
  );

  const progressFor = useCallback(
    (key: string) => progress.find((item) => item.key === key),
    [progress],
  );

  const playRequest = useCallback(
    async (request: PlayRequest) => {
      // A double click used to start two players; the last one won, but both
      // sessions were spawned and both were pushed onto history.
      if (opening.current) return;
      opening.current = true;
      try {
        const snapshot = await api.player.open(request);
        setPlayer(snapshot);
        navigate({ name: "player" });
      } catch (error) {
        notify(errorMessage(error), "error");
      } finally {
        opening.current = false;
      }
    },
    [navigate, notify],
  );

  const buildSession = useCallback((details: Details, video: Video | null) => {
    return sessionFor(details, video);
  }, []);

  /**
   * Turn a source row into something mpv can actually open: HTTP links pass
   * through (debrid accounts may still need to unrestrict them), magnets and
   * hashes go to the local torrent engine.
   */
  const resolveStream = useCallback(
    async (stream: StreamOption): Promise<string> => {
      const direct = stream.url ?? "";
      const magnet = !direct && stream.infoHash
        ? `magnet:?xt=urn:btih:${stream.infoHash}${stream.fileIdx != null ? `&fileIdx=${stream.fileIdx}` : ""}`
        : direct;
      if (!magnet) throw new Error("That source has no link or info hash to play.");

      if (!magnet.startsWith("magnet:") && !/^[0-9a-f]{40}$/i.test(magnet)) {
        const providers = await api.debrid.providers().catch(() => []);
        const url = providers.some((provider) => provider.connected)
          ? await api.debrid.resolve(magnet)
          : magnet;
        setPlayingSource(stream);
        return url;
      }

      if (!settings?.p2pConsent) {
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
      try {
        notify(`Finding a source for ${item.name}…`);
        const details = await api.details(item.id, item.type);
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
        const resume = settings?.autoResume && !fromStart ? progressFor(session.key)?.position ?? 0 : 0;
        const options = await api.streams({
          id: details.imdbId ?? details.id,
          mediaType: details.type,
          season: session.season,
          episode: session.episode,
          imdbId: details.imdbId,
        });
        const source = pickSource(
          options,
          settings?.preferredQuality ?? "auto",
          settings?.p2pConsent ?? false,
          playingSource,
        );
        if (!source) throw noSourceError(options, settings?.p2pConsent ?? false);
        const url = await resolveStream(source);
        const label = video
          ? `${details.name} · S${video.season ?? 1}E${video.episode ?? video.number ?? 1}`
          : details.name;
        await playRequest({ url, title: label, startAt: resume, session });
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    },
    [
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
      try {
        const details = await api.details(entry.metaId, entry.type);
        const video =
          entry.type === "series"
            ? details.videos.find(
                (candidate) =>
                  candidate.season === entry.season &&
                  (candidate.episode ?? candidate.number) === entry.episode,
              ) ??
              details.videos[0] ??
              null
            : null;
        if (entry.type === "series" && !video) {
          navigate({ name: "details", id: entry.metaId, type: entry.type });
          return;
        }
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
        const sources = await api.streams({
          id: details.imdbId ?? details.id,
          mediaType: details.type,
          season: entry.season,
          episode: entry.episode,
          imdbId: details.imdbId,
        });
        const source = pickSource(
          sources,
          settings?.preferredQuality ?? "auto",
          settings?.p2pConsent ?? false,
          playingSource,
        );
        if (!source) throw noSourceError(sources, settings?.p2pConsent ?? false);
        const url = await resolveStream(source);
        notify("Resuming…");
        await playRequest({
          url,
          title: video
            ? `${details.name} · ${seasonLabel(video.season, video.episode ?? video.number)}`
            : details.name,
          startAt: entry.position,
          session,
        });
      } catch (error) {
        notify(errorMessage(error), "error");
      }
    },
    [
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
      toasts,
      route,
      navigate,
      back,
      leavePlayer,
      refreshAddons,
      refreshLibrary,
      refreshProgress,
      saveSettings,
      toggleLibrary,
      inLibrary,
      notify,
      dismissToast,
      progressFor,
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
      toasts,
      route,
      navigate,
      back,
      leavePlayer,
      refreshAddons,
      refreshLibrary,
      refreshProgress,
      saveSettings,
      toggleLibrary,
      inLibrary,
      notify,
      dismissToast,
      progressFor,
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
