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
import { errorMessage, seasonLabel } from "./format";
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

/** A stored position at or past this share of the runtime counts as finished. */
const FINISHED_SHARE = 0.9;

/** Info hashes arrive as 40 hex or 32 base32 chars; anything else never becomes a magnet. */
const INFO_HASH = /^(?:[0-9a-fA-F]{40}|[A-Za-z2-7]{32})$/;

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
  // The item whose source is being found right now, so a different click can
  // say what it is waiting for instead of dying silently.
  const pending = useRef<{ id: string; name: string } | null>(null);
  const toggling = useRef(new Set<string>());
  const progressFails = useRef(0);
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
        const [info, loadedSettings, loadedAddons, loadedLibrary, loadedProgress] =
          await Promise.allSettled([
            api.appInfo(),
            api.settings.get(),
            api.addons.list(),
            api.library.list(),
            api.progress.list(),
          ]);
        if (!alive) return;
        if (info.status === "rejected") throw info.reason;
        setAppInfo(info.value);
        if (loadedSettings.status === "fulfilled") setSettings(loadedSettings.value);
        if (loadedAddons.status === "fulfilled") setAddons(loadedAddons.value);
        if (loadedLibrary.status === "fulfilled") setLibrary(loadedLibrary.value);
        if (loadedProgress.status === "fulfilled") setProgress(loadedProgress.value);
        const failed = (
          [
            ["settings", loadedSettings.status],
            ["addons", loadedAddons.status],
            ["library", loadedLibrary.status],
            ["progress", loadedProgress.status],
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

      if (!settings?.p2pConsent) {
        // Debrid can still play a cached copy without the local engine.
        const providers = await api.debrid.providers().catch(() => []);
        if (providers.some((provider) => provider.connected)) {
          const url = await api.debrid.resolve(magnet).catch(() => "");
          if (url) {
            setPlayingSource(stream);
            return url;
          }
        }
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
      pending.current = { id, name: item.name };
      try {
        notify(`Finding a source for ${item.name}…`);
        // A movie's tt id is what the stream addons key on, so the hunt can run
        // alongside the details fetch instead of queueing behind it.
        const early =
          item.type === "movie" && item.id.startsWith("tt")
            ? api.streams({ id: item.id, mediaType: item.type })
            : null;
        const [details, prefetched] = await Promise.all([api.details(item.id, item.type), early]);
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
        const stored = progressFor(session.key);
        const resume =
          settings?.autoResume && !fromStart
            ? resumePosition(stored?.position ?? 0, stored?.duration ?? 0)
            : 0;
        const options =
          (details.type === item.type ? prefetched : null) ??
          (await api.streams({
            id: details.imdbId ?? details.id,
            mediaType: details.type,
            season: session.season,
            episode: session.episode,
            imdbId: details.imdbId,
          }));
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
      } finally {
        pending.current = null;
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
      const busy = pending.current;
      if (busy) {
        if (busy.id !== entry.key) notify(`Already starting ${busy.name}`);
        return;
      }
      pending.current = { id: entry.key, name: entry.name };
      try {
        notify(`Resuming ${entry.name}…`);
        // The entry already carries every session field, and a tt id is exactly
        // what the stream addons key on. Fetching details first only resolved
        // that same id, at the cost of a full metadata round trip before the hunt.
        const imdbId = entry.metaId.startsWith("tt") ? entry.metaId : null;
        const details = imdbId ? null : await api.details(entry.metaId, entry.type);
        if (details && entry.type === "series" && details.videos.length === 0) {
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
          id: imdbId ?? details?.imdbId ?? details?.id ?? entry.metaId,
          mediaType: details?.type ?? entry.type,
          season: entry.season,
          episode: entry.episode,
          imdbId: imdbId ?? details?.imdbId ?? null,
        });
        const source = pickSource(
          sources,
          settings?.preferredQuality ?? "auto",
          settings?.p2pConsent ?? false,
          playingSource,
        );
        if (!source) throw noSourceError(sources, settings?.p2pConsent ?? false);
        const url = await resolveStream(source);
        await playRequest({
          url,
          title:
            entry.type === "series"
              ? `${entry.name} · ${seasonLabel(entry.season, entry.episode)}`
              : entry.name,
          startAt: resumePosition(entry.position, entry.duration),
          session,
        });
      } catch (error) {
        notify(errorMessage(error), "error");
      } finally {
        pending.current = null;
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
