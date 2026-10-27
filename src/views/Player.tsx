import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isBrowserPreview, isTauri } from "../lib/bridge";
import { pickSource, useApp, usePlayer } from "../lib/store";
import type { Details, PlayerSnapshot, SubtitleTrack, Video } from "../lib/types";
import { Icon, Spinner } from "../components/ui";
import { findSkip, type SkipEntry } from "../components/player/skip";
import { episodeCode, formatTime, progressPercent, seasonLabel } from "../lib/format";
import "../components/player/player.css";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const NEXT_LEAD = 45;
const SUB_STYLE_KEY = "betternuvio.subtitleStyle";
const SUB_COLORS = [
  { value: "#ffffff", label: "White" },
  { value: "#f1e2c6", label: "Warm white" },
  { value: "#ffd84d", label: "Yellow" },
  { value: "#8fd8ff", label: "Sky blue" },
];

type Surface = "tracks" | "keys" | "stats" | null;

interface SubtitleStyle {
  size: number;
  color: string;
  background: number;
  delay: number;
}

interface Hud {
  label: string;
  value: string;
  out: boolean;
}

const DEFAULT_SUB_STYLE: SubtitleStyle = { size: 46, color: "#ffffff", background: 55, delay: 0 };
const MAX_DELAY = 10;

function whole(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function tenths(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_DELAY, Math.max(-MAX_DELAY, Math.round(number * 10) / 10));
}

/** mpv takes #AARRGGBB, so the 0-100 box opacity becomes the alpha byte. */
function mpvBackground(percent: number): string {
  const alpha = Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);
  return `#${alpha.toString(16).padStart(2, "0")}000000`;
}

function delayLabel(delay: number): string {
  if (delay === 0) return "0.0s";
  return `${delay > 0 ? "+" : "−"}${Math.abs(delay).toFixed(1)}s`;
}

function readSubtitleStyle(): SubtitleStyle {
  try {
    const raw = window.localStorage.getItem(SUB_STYLE_KEY);
    if (!raw) return DEFAULT_SUB_STYLE;
    const stored = JSON.parse(raw) as Partial<SubtitleStyle> | null;
    if (!stored || typeof stored !== "object") return DEFAULT_SUB_STYLE;
    return {
      size: whole(stored.size, 30, 90, DEFAULT_SUB_STYLE.size),
      color: SUB_COLORS.some((option) => option.value === stored.color)
        ? String(stored.color)
        : DEFAULT_SUB_STYLE.color,
      background: whole(stored.background, 0, 100, DEFAULT_SUB_STYLE.background),
      delay: tenths(stored.delay, DEFAULT_SUB_STYLE.delay),
    };
  } catch {
    return DEFAULT_SUB_STYLE;
  }
}

/**
 * Playback screen.
 *
 * The picture is painted into the window behind this layer, so the page itself
 * has to stay transparent. Only the shade gradients and the deck that sits on
 * top of them are visible; everything else is the video.
 */
export function PlayerView() {
  const { settings, notify, navigate, playRequest, buildSession, appInfo, resolveStream } =
    useApp();
  const player = usePlayer();
  const [local, setLocal] = useState<PlayerSnapshot | null>(player);
  const [surface, setSurface] = useState<Surface>(null);
  const [chrome, setChrome] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [subs, setSubs] = useState<SubtitleTrack[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Seconds spent waiting for the source so far, so a slow provider is
  // visible instead of an unchanging spinner.
  const [waited, setWaited] = useState(0);

  const [hud, setHud] = useState<Hud | null>(null);
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(readSubtitleStyle);
  const [nextOff, setNextOff] = useState(false);
  const [speedOpen, setSpeedOpen] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  // Stored position offered by the resume prompt, and the seconds left before
  // it settles on Resume by itself.
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [resumeLeft, setResumeLeft] = useState(8);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [markers, setMarkers] = useState<SkipEntry | null>(null);
  const [markMsg, setMarkMsg] = useState<string | null>(null);

  const advanced = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const dragging = useRef(false);
  const wasPlaying = useRef(false);
  const fsNow = useRef(false);
  const volRef = useRef(100);
  const speedRef = useRef(1);
  const posRef = useRef(0);
  const hudTimer = useRef<number | null>(null);
  const hudOutTimer = useRef<number | null>(null);
  const openedAt = useRef(Date.now());
  // A segment jumps once per playback session, even if the tick lands inside
  // the window again.
  const fired = useRef<{ intro: boolean; outro: boolean }>({ intro: false, outro: false });
  // Trakt scrobble bookkeeping: the last action sent for which key, when, and
  // how far in, so repeated states and idle ticks are not sent twice.
  const traktRef = useRef<{ key: string | null; action: string; at: number; pct: number }>({
    key: null,
    action: "",
    at: 0,
    pct: -1,
  });
  const livePct = useRef(0);

  useEffect(() => {
    setLocal(player);
  }, [player]);

  // Playback can end behind the overlay. When the store clears the player we
  // return to the title instead of leaving a dead screen behind.
  useEffect(() => {
    if (player) {
      wasPlaying.current = true;
      return;
    }
    if (!wasPlaying.current) return;
    wasPlaying.current = false;
    const session = local?.session;
    navigate(
      session
        ? { name: "details", id: session.metaId, type: session.type }
        : { name: "home" },
    );
  }, [player, local?.session, navigate]);

  // The browser preview has no Tauri events, so poll the mock backend.
  useEffect(() => {
    if (!isBrowserPreview()) return;
    const timer = window.setInterval(() => {
      void api.player
        .state()
        .then(setLocal)
        .catch(() => undefined);
    }, 800);
    return () => window.clearInterval(timer);
  }, []);

  const session = local?.session ?? null;
  const [details, setDetails] = useState<Details | null>(null);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    api
      .details(session.metaId, session.type)
      .then((result) => {
        if (alive) setDetails(result);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session?.metaId, session?.type]);

  const queue = useMemo<Video[]>(() => {
    if (!details || details.type !== "series") return [];
    return [...details.videos].sort(
      (a, b) =>
        (a.season ?? 0) - (b.season ?? 0) ||
        (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0),
    );
  }, [details]);

  const index = useMemo(() => {
    if (!session || session.season == null) return -1;
    return queue.findIndex(
      (video) =>
        video.season === session.season &&
        (video.episode ?? video.number) === session.episode,
    );
  }, [queue, session?.season, session?.episode, session?.key]);

  const nextEpisode = index >= 0 ? queue[index + 1] ?? null : null;
  const prevEpisode = index > 0 ? queue[index - 1] ?? null : null;

  const duration = local?.duration ?? 0;
  const position = local?.position ?? 0;
  const shownPosition = scrub ?? position;
  const remaining = Math.max(0, duration - shownPosition);
  const loading = Boolean(local && !local.ended && duration <= 0);
  const audioTracks = local?.audioTracks ?? [];
  const subTracks = local?.subTracks ?? [];
  const activeSub = subTracks.find((track) => track.id === local?.activeSub) ?? null;
  const step = settings?.seekStep ?? 10;
  const nextCountdown = Math.max(0, Math.ceil((duration || 0) - position));
  const nextAutoPlay = settings?.autoPlayNext ?? false;
  const showNext = Boolean(
    nextEpisode &&
      !nextOff &&
      (local?.ended || (duration > 60 && nextCountdown <= NEXT_LEAD)),
  );

  const playVideo = useCallback(
    async (video: Video) => {
      if (!details) return;
      setBusy(true);
      try {
        const nextSession = buildSession(details, video);
        const sources = await api.streams({
          id: details.imdbId ?? details.id,
          mediaType: details.type,
          season: video.season,
          episode: video.episode ?? video.number,
          imdbId: details.imdbId,
        });
        const source = pickSource(sources, settings?.preferredQuality ?? "auto");
        if (!source) throw new Error("No playable source for that episode.");
        const url = await resolveStream(source);
        await playRequest({
          url,
          title: `${details.name} · ${seasonLabel(video.season, video.episode ?? video.number)}`,
          startAt: 0,
          session: nextSession,
        });
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setBusy(false);
      }
    },
    [buildSession, details, notify, playRequest, resolveStream, settings?.preferredQuality],
  );

  const leaveFullscreen = useCallback(() => {
    if (!fsNow.current) return;
    fsNow.current = false;
    setFullscreen(false);
    void api.window.fullscreen(false);
  }, []);

  const stop = useCallback(async () => {
    const target = session
      ? ({ name: "details", id: session.metaId, type: session.type } as const)
      : ({ name: "home" } as const);
    leaveFullscreen();
    await api.player.stop().catch(() => undefined);
    navigate(target);
  }, [leaveFullscreen, navigate, session]);

  // Never leave the window frameless after the overlay goes away.
  useEffect(() => () => leaveFullscreen(), [leaveFullscreen]);

  // A control sent to a player that already exited must not turn into an
  // unhandled rejection; the next snapshot is the source of truth anyway.
  const send = useCallback((action: string, value?: number | string | null) => {
    void api.player.control(action, value).catch(() => undefined);
  }, []);

  const togglePause = useCallback(() => {
    send("toggle-pause");
  }, [send]);

  const seekTo = useCallback(
    (target: number) => {
      setResumeAt(null);
      send("seek", Math.max(0, target));
    },
    [send],
  );

  const seekRel = useCallback(
    (delta: number) => {
      setResumeAt(null);
      send("seek-rel", delta);
    },
    [send],
  );

  const setVolume = useCallback(
    (value: number) => {
      send("volume", Math.min(130, Math.max(0, value)));
    },
    [send],
  );

  const toggleFullscreen = useCallback(async () => {
    if (!isTauri()) {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
        setFullscreen(false);
      } else {
        await document.documentElement.requestFullscreen().catch(() => undefined);
        setFullscreen(true);
      }
      return;
    }
    const next = !fsNow.current;
    try {
      await api.window.fullscreen(next);
      fsNow.current = next;
      setFullscreen(next);
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  }, [notify]);

  const showHud = useCallback((label: string, value: string) => {
    if (hudTimer.current) window.clearTimeout(hudTimer.current);
    if (hudOutTimer.current) window.clearTimeout(hudOutTimer.current);
    setHud({ label, value, out: false });
    hudTimer.current = window.setTimeout(() => {
      setHud((current) => (current ? { ...current, out: true } : current));
    }, 1200);
    hudOutTimer.current = window.setTimeout(() => setHud(null), 1500);
  }, []);

  useEffect(
    () => () => {
      if (hudTimer.current) window.clearTimeout(hudTimer.current);
      if (hudOutTimer.current) window.clearTimeout(hudOutTimer.current);
    },
    [],
  );

  const changeVolume = useCallback(
    (delta: number) => {
      const next = Math.min(130, Math.max(0, Math.round(volRef.current + delta)));
      volRef.current = next;
      setVolume(next);
      showHud("Volume", `${next}%`);
    },
    [setVolume, showHud],
  );

  const toggleMute = useCallback(() => {
    send("mute");
    showHud("Sound", local?.muted ? "On" : "Muted");
  }, [local?.muted, send, showHud]);

  const changeSpeed = useCallback(
    (direction: 1 | -1) => {
      const found = SPEEDS.findIndex((speed) => Math.abs(speed - speedRef.current) < 0.01);
      const from = found === -1 ? SPEEDS.indexOf(1) : found;
      const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, from + direction))];
      speedRef.current = next;
      send("speed", next);
      showHud("Speed", `${next}×`);
    },
    [send, showHud],
  );

  const cycleSub = useCallback(() => {
    if (subTracks.length === 0) return;
    const from =
      local?.activeSub != null
        ? subTracks.findIndex((track) => track.id === local.activeSub)
        : -1;
    const next = from + 1 >= subTracks.length ? null : subTracks[from + 1].id;
    send("sub", next);
  }, [local?.activeSub, send, subTracks]);

  const cycleAudio = useCallback(() => {
    if (audioTracks.length === 0) return;
    const from =
      local?.activeAudio != null
        ? audioTracks.findIndex((track) => track.id === local.activeAudio)
        : -1;
    send("audio", audioTracks[(from + 1) % audioTracks.length].id);
  }, [audioTracks, local?.activeAudio, send]);

  const toggleSurface = useCallback((next: Exclude<Surface, null>) => {
    setSurface((current) => (current === next ? null : next));
  }, []);

  const bump = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (local?.paused || local?.ended || surface) return;
    hideTimer.current = window.setTimeout(() => setChrome(false), 2600);
  }, [local?.paused, local?.ended, surface]);

  useEffect(() => {
    bump();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [bump]);

  // The speed menu is part of the chrome, so it leaves with it.
  useEffect(() => {
    if (!chrome) setSpeedOpen(false);
  }, [chrome]);

  const dismissNext = useCallback(() => {
    setNextOff(true);
    // Keep the end-of-file handler from starting the episode the viewer
    // explicitly waved off.
    advanced.current = true;
  }, []);

  const applyResume = useCallback(
    (target: number) => {
      setResumeAt(null);
      send("seek", Math.max(0, target));
    },
    [send],
  );

  const loadSubtitles = useCallback(async () => {
    if (!session || subs) return;
    setSubs(null);
    try {
      const result = await api.subtitles({
        id: session.metaId,
        mediaType: session.type,
        season: session.season,
        episode: session.episode,
      });
      setSubs(result);
    } catch {
      setSubs([]);
    }
  }, [session, subs]);

  // Each episode is a fresh session: clear everything that belonged to the
  // previous one, including a dismissed next-episode card.
  useEffect(() => {
    advanced.current = false;
    openedAt.current = Date.now();
    setSubs(null);
    setNextOff(false);
    setThumbBroken(false);
    setResumeAt(null);
    setSurface(null);
  }, [session?.key]);

  // Markers belong to the show, so one read per playback session covers every
  // episode under that id.
  useEffect(() => {
    fired.current = { intro: false, outro: false };
    setMarkers(null);
    setMarkMsg(null);
    const metaId = session?.metaId;
    if (!metaId || !isTauri()) return;
    let alive = true;
    invoke<SkipEntry | null>("skip_get", { metaId })
      .then((entry) => {
        if (alive) setMarkers(entry);
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session?.key]);

  useEffect(() => {
    volRef.current = local?.volume ?? volRef.current;
  }, [local?.volume]);

  useEffect(() => {
    speedRef.current = local?.speed ?? speedRef.current;
  }, [local?.speed]);

  useEffect(() => {
    posRef.current = position;
    livePct.current = duration > 0 ? Math.min(100, (position / duration) * 100) : 0;
  }, [duration, position]);

  // Trakt scrobbling: start on open, pause on pause, stop on end or close, and
  // a throttled start now and then to carry the playhead. Failures are dropped
  // because the account may not be connected and playback must not wait.
  const traktKey = session?.key ?? null;
  const traktOn = Boolean(settings?.traktScrobble && traktKey);
  const scrobbleLive = Boolean(local && !local.paused && !local.ended);

  const pushScrobble = useCallback((key: string, action: "start" | "pause" | "stop") => {
    traktRef.current = { key, action, at: Date.now(), pct: livePct.current };
    void api.trakt.scrobble(action, key, livePct.current).catch(() => undefined);
  }, []);

  const reportScrobble = useCallback(
    (action: "start" | "pause" | "stop") => {
      if (!traktKey || !traktOn) return;
      const last = traktRef.current;
      if (last.key === traktKey && last.action === action) return;
      pushScrobble(traktKey, action);
    },
    [pushScrobble, traktKey, traktOn],
  );

  useEffect(() => {
    if (!traktOn || !local) return;
    reportScrobble(local.ended ? "stop" : local.paused ? "pause" : "start");
  }, [traktOn, local?.paused, local?.ended, reportScrobble]);

  useEffect(() => {
    if (!traktOn || !scrobbleLive) return;
    const timer = window.setInterval(() => {
      const last = traktRef.current;
      if (!last.key || Date.now() - last.at < 25000) return;
      if (Math.abs(livePct.current - last.pct) < 1) return;
      pushScrobble(last.key, "start");
    }, 5000);
    return () => window.clearInterval(timer);
  }, [traktOn, scrobbleLive, pushScrobble]);

  // Closing the player, changing episode, or leaving the screen ends it.
  useEffect(() => {
    if (!traktOn) return;
    return () => {
      const last = traktRef.current;
      if (last.key && last.action !== "stop") pushScrobble(last.key, "stop");
    };
  }, [traktOn, traktKey, pushScrobble]);

  // A stored position is worth offering when it is past the opening minutes
  // but not close enough to the end to count as finished.
  useEffect(() => {
    const key = session?.key;
    if (!key || !settings?.autoResume) return;
    let alive = true;
    void api.progress
      .forKey(key)
      .then((entry) => {
        if (!alive || !entry || entry.duration <= 0) return;
        // A lookup that took this long is not an "on open" prompt any more.
        if (Date.now() - openedAt.current > 30000) return;
        if (entry.position > 30 && entry.position / entry.duration < 0.92) {
          setResumeAt(entry.position);
        }
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [session?.key, settings?.autoResume]);

  // The prompt settles on Resume after eight seconds of playback. The clock
  // only starts once the picture is open, so a slow source cannot eat it, and
  // it samples the playhead so a stream that already resumed is never rewound.
  useEffect(() => {
    if (resumeAt == null || loading || showNext) return;
    setResumeLeft(8);
    let atStoredPoint = Math.abs(posRef.current - resumeAt) <= 12;
    const deadline = Date.now() + 8000;
    const tick = window.setInterval(() => {
      if (Math.abs(posRef.current - resumeAt) <= 12) atStoredPoint = true;
      setResumeLeft(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);
    const done = window.setTimeout(() => {
      if (atStoredPoint) setResumeAt(null);
      else applyResume(resumeAt);
    }, 8000);
    return () => {
      window.clearInterval(tick);
      window.clearTimeout(done);
    };
  }, [resumeAt, loading, showNext, applyResume]);

  // Markers move the playhead through the same path the skip buttons use. The
  // check is local, so it costs nothing per tick.
  useEffect(() => {
    if (!markers || loading || scrub != null) return;
    const segment = findSkip(markers, position, duration);
    if (!segment || fired.current[segment.kind]) return;
    fired.current[segment.kind] = true;
    seekTo(segment.at);
  }, [markers, position, duration, loading, scrub, seekTo]);

  // The preview above is only a preview: mpv draws the real subtitles, so the
  // same values are pushed to it, debounced so dragging a slider stays cheap.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      send("sub-font-size", subStyle.size);
      send("sub-color", subStyle.color);
      send("sub-back-color", mpvBackground(subStyle.background));
      send("sub-delay", subStyle.delay);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [send, session?.key, subStyle]);

  // Delay survives a restart, but the next episode starts on its own timing.
  const delaySession = useRef(false);
  useEffect(() => {
    if (!delaySession.current) {
      delaySession.current = true;
      return;
    }
    setSubStyle((current) => (current.delay === 0 ? current : { ...current, delay: 0 }));
  }, [session?.key]);

  // Local storage is the persistence layer; the settings blob has no key for this.
  useEffect(() => {
    try {
      window.localStorage.setItem(SUB_STYLE_KEY, JSON.stringify(subStyle));
    } catch {
      // Storage can be full or blocked; the panel still works for this session.
    }
  }, [subStyle]);

  const patchSubStyle = (patch: Partial<SubtitleStyle>) => {
    setSubStyle((current) => ({ ...current, ...patch }));
  };

  const nudgeDelay = (delta: number) => {
    setSubStyle((current) => ({ ...current, delay: tenths(current.delay + delta, current.delay) }));
  };

  const saveMarker = useCallback(
    async (patch: SkipEntry, label: string) => {
      const metaId = session?.metaId;
      if (!metaId) return;
      if (!isTauri()) {
        setMarkMsg("Markers save in the desktop app");
        return;
      }
      const at = posRef.current;
      try {
        const entry = await invoke<SkipEntry | null>("skip_set", { metaId, entry: patch });
        setMarkers(entry);
        setMarkMsg(`${label} at ${formatTime(at)} saved`);
      } catch (e) {
        setMarkMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [session?.metaId],
  );

  // Ended episodes advance on their own only when the setting allows it and
  // the card has not been dismissed.
  useEffect(() => {
    if (!local?.ended || !settings?.autoPlayNext || !nextEpisode || advanced.current || nextOff) {
      return;
    }
    advanced.current = true;
    void playVideo(nextEpisode);
  }, [local?.ended, settings?.autoPlayNext, nextEpisode, nextOff, playVideo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) || target.isContentEditable)
      ) {
        return;
      }
      const key = event.key;
      let handled = true;
      switch (key) {
        case " ":
        case "k":
        case "K":
          event.preventDefault();
          togglePause();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          event.preventDefault();
          seekRel((key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 60 : step));
          break;
        case "ArrowUp":
        case "ArrowDown":
          event.preventDefault();
          changeVolume(key === "ArrowUp" ? 5 : -5);
          break;
        case "m":
        case "M":
          toggleMute();
          break;
        case "f":
        case "F":
          void toggleFullscreen();
          break;
        case "s":
        case "S":
          cycleSub();
          break;
        case "a":
        case "A":
          cycleAudio();
          break;
        case "+":
        case "=":
          changeSpeed(1);
          break;
        case "-":
        case "_":
          changeSpeed(-1);
          break;
        case "n":
        case "N":
          if (nextEpisode && !busy) void playVideo(nextEpisode);
          break;
        case "i":
        case "I":
          toggleSurface("stats");
          break;
        case "?":
          toggleSurface("keys");
          break;
        case "Escape":
          if (speedOpen) setSpeedOpen(false);
          else if (surface) setSurface(null);
          else if (resumeAt != null) setResumeAt(null);
          else if (showNext) dismissNext();
          else if (fsNow.current) void toggleFullscreen();
          else void stop();
          break;
        default:
          handled = false;
      }
      if (handled) bump();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    bump,
    busy,
    changeSpeed,
    changeVolume,
    cycleAudio,
    cycleSub,
    dismissNext,
    nextEpisode,
    playVideo,
    resumeAt,
    seekRel,
    showNext,
    speedOpen,
    step,
    stop,
    surface,
    toggleFullscreen,
    toggleMute,
    togglePause,
    toggleSurface,
  ]);

  const loadSubtitleFile = async () => {
    if (!isTauri()) {
      notify("Picking a subtitle file needs the desktop app", "error");
      return;
    }
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Subtitles", extensions: ["srt", "ass", "ssa", "vtt", "sub"] }],
      });
      if (typeof selected !== "string") return;
      const name = selected.split(/[\\/]/).pop() ?? "Subtitle";
      await api.player.subtitle(selected, name);
      notify(`Loaded ${name}`, "success");
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), "error");
    }
  };

  // A source that never opens would otherwise spin forever with no way out.
  useEffect(() => {
    if (!local || local.ended || local.duration > 0) {
      setWaited(0);
      return;
    }
    const started = Date.now();
    setWaited(0);
    const timer = window.setInterval(() => setWaited((Date.now() - started) / 1000), 250);
    return () => window.clearInterval(timer);
  }, [local?.duration, local?.ended]);

  if (!local) {
    return (
      <div className="pv pv--awake">
        <div className="pv-empty">
          <Icon name="play" size={26} />
          <h1>Nothing is playing</h1>
          <p>Pick a title and choose a source to start.</p>
          <button type="button" className="btn btn-primary" onClick={() => navigate({ name: "home" })}>
            Back home
          </button>
        </div>
      </div>
    );
  }

  const percent = progressPercent(shownPosition, duration);
  const bufferedPercent =
    duration > 0 && local.buffered ? Math.min(100, (local.buffered / duration) * 100) : 0;
  const title = session?.name ?? local.title;
  const activeAudio = audioTracks.find((track) => track.id === local.activeAudio) ?? null;
  const nextThumb = thumbBroken ? null : nextEpisode?.thumbnail ?? null;

  const ratioFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  const shortcutRows: Array<[string, string]> = [
    ["Space / K", "Play and pause"],
    ["← / →", `Seek ${step}s`],
    ["Shift + ← / →", "Seek 60s"],
    ["↑ / ↓", "Volume up and down"],
    ["M", "Mute"],
    ["S", "Cycle subtitles"],
    ["A", "Cycle audio"],
    ["+ / −", "Speed up and down"],
    ["N", "Next episode"],
    ["I", "Playback stats"],
    ["F", "Fullscreen"],
    ["?", "This sheet"],
    ["Esc", "Close a panel, or leave"],
  ];

  const statsRows: Array<[string, string]> = [
    ["Title", title],
    ["Engine", appInfo?.mpv?.version ?? "mpv"],
    ["State", local.ended ? "Ended" : local.paused ? "Paused" : "Playing"],
    ["Position", `${formatTime(local.position)} / ${formatTime(duration)}`],
    ["Cached to", formatTime(local.buffered ?? 0)],
    ["Speed", `${local.speed}×`],
    ["Volume", `${Math.round(local.volume)}%${local.muted ? " (muted)" : ""}`],
    ["Audio", activeAudio?.label ?? "Default"],
    ["Subtitles", activeSub?.label ?? "Off"],
    ["Source", activeSub ? (activeSub.external ? "External file" : "Embedded") : "None"],
  ];

  return (
    <div
      className={`pv${chrome ? " pv--awake" : ""}`}
      onPointerMove={bump}
      onFocusCapture={() => setChrome(true)}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        if (!chrome) {
          bump();
          return;
        }
        if (surface || speedOpen) {
          setSurface(null);
          setSpeedOpen(false);
          return;
        }
        togglePause();
      }}
    >
      <div className="pv-shade" aria-hidden="true" />

      <header className="pv-top">
        <button
          type="button"
          className="pv-round"
          onClick={() => void stop()}
          aria-label="Close player"
        >
          <Icon name="back" size={19} />
        </button>
      </header>

      {loading ? (
        <div className="pv-wait">
          <Spinner label={`Opening stream · ${waited.toFixed(1)}s`} />
          {waited >= 14 ? (
            <>
              <p className="pv-hint">Still opening. This source may be slow or gone.</p>
              <button type="button" className="btn btn-ghost" onClick={() => void stop()}>
                Stop
              </button>
            </>
          ) : null}
        </div>
      ) : null}

      {surface === "keys" ? (
        <section className="pv-help" aria-label="Keyboard shortcuts">
          <div className="pv-help-head">
            <h2>Keyboard</h2>
            <button
              type="button"
              className="pv-icon"
              onClick={() => setSurface(null)}
              aria-label="Close shortcuts"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
          {shortcutRows.map(([keys, what]) => (
            <p key={keys}>
              <kbd>{keys}</kbd>
              <span>{what}</span>
            </p>
          ))}
        </section>
      ) : null}

      {surface === "stats" ? (
        <section className="pv-stats" aria-label="Playback statistics">
          <div className="pv-stats-head">
            <h2>Playback</h2>
            <button
              type="button"
              className="pv-icon"
              onClick={() => setSurface(null)}
              aria-label="Close playback statistics"
            >
              <Icon name="x" size={15} />
            </button>
          </div>
          <dl>
            {statsRows.map(([label, value]) => (
              <div key={label} className="pv-stat">
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <p className="pv-hint">
            Codec, resolution, bitrate and dropped frames are not exposed by the player bridge.
          </p>
        </section>
      ) : null}

      {resumeAt != null && !loading && !showNext ? (
        <section className="pv-resume" aria-label="Resume playback">
          <p className="pv-resume-label">Welcome back</p>
          <div className="pv-resume-actions">
            <button
              type="button"
              className="pv-resume-choice"
              onClick={() => applyResume(resumeAt)}
            >
              Resume from {formatTime(resumeAt)}
            </button>
            <button
              type="button"
              className="pv-resume-choice is-quiet"
              onClick={() => applyResume(0)}
            >
              Start over
            </button>
          </div>
          <p className="pv-hint">Continuing automatically in {resumeLeft}s</p>
        </section>
      ) : null}

      {showNext && nextEpisode ? (
        <section
          className={`pv-next${nextThumb ? " pv-next--rich" : " pv-next--closable"}`}
          aria-label="Next episode"
        >
          {nextThumb ? (
            <img
              className="pv-next-thumb"
              src={nextThumb}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setThumbBroken(true)}
            />
          ) : null}
          <div className="pv-next-body">
            <p className="pv-next-label">Up next</p>
            <h2>
              {seasonLabel(nextEpisode.season, nextEpisode.episode ?? nextEpisode.number)}
              {nextEpisode.title ? ` · ${nextEpisode.title}` : ""}
            </h2>
            <p className="pv-next-meta">
              {nextAutoPlay
                ? local.ended
                  ? "Starting now"
                  : `Starting in ${nextCountdown}s`
                : "Ready when you are"}
            </p>
            <div className="pv-next-actions">
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                onClick={() => void playVideo(nextEpisode)}
              >
                <Icon name="play" size={15} />
                {busy ? "Loading…" : "Play now"}
              </button>
            </div>
          </div>
          <button
            type="button"
            className="pv-icon pv-next-close"
            onClick={dismissNext}
            aria-label="Dismiss next episode"
          >
            <Icon name="x" size={15} />
          </button>
        </section>
      ) : null}

      {local.ended && !nextEpisode ? (
        <section className="pv-next">
          <p className="pv-next-label">End of the line</p>
          <h2>Nothing queued after this one.</h2>
          <div className="pv-next-actions">
            <button type="button" className="btn btn-ghost" onClick={() => void stop()}>
              Close
            </button>
          </div>
        </section>
      ) : null}

      {surface === "tracks" ? (
        <aside className="pv-panel" aria-label="Tracks and subtitles">
          <div className="pv-panel-head">
            <h2>Tracks</h2>
            <button type="button" className="pv-icon" onClick={() => setSurface(null)} aria-label="Close">
              <Icon name="x" size={15} />
            </button>
          </div>

          <label className="pv-field">
            <span>Audio</span>
            <select
              value={local.activeAudio ?? 0}
              onChange={(event) => send("audio", Number(event.target.value))}
            >
              {audioTracks.length === 0 ? <option value={0}>Default</option> : null}
              {audioTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.label}
                </option>
              ))}
            </select>
          </label>

          <label className="pv-field">
            <span>Subtitles</span>
            <select
              value={local.activeSub ?? 0}
              onChange={(event) => {
                const value = Number(event.target.value);
                send("sub", value === 0 ? null : value);
              }}
            >
              <option value={0}>Off</option>
              {subTracks.map((track) => (
                <option key={track.id} value={track.id}>
                  {track.label}
                  {track.external ? " (external)" : ""}
                </option>
              ))}
            </select>
          </label>

          <div className="pv-style">
            <p className="pv-field-label">Subtitle style</p>
            <div className="pv-subpreview">
              <span
                style={{
                  color: subStyle.color,
                  background: `rgba(0, 0, 0, ${subStyle.background / 100})`,
                  fontSize: `${Math.round(15 + (subStyle.size - 30) * 0.24)}px`,
                }}
              >
                Subtitles appear like this
              </span>
            </div>
            <label className="pv-range">
              <span>
                Font size <b>{subStyle.size}</b>
              </span>
              <input
                type="range"
                min={30}
                max={90}
                step={1}
                value={subStyle.size}
                aria-label="Subtitle font size"
                onChange={(event) => patchSubStyle({ size: Number(event.target.value) })}
              />
            </label>
            <label className="pv-field">
              <span>Text colour</span>
              <select
                value={subStyle.color}
                onChange={(event) => patchSubStyle({ color: event.target.value })}
              >
                {SUB_COLORS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="pv-range">
              <span>
                Background <b>{subStyle.background}%</b>
              </span>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={subStyle.background}
                aria-label="Subtitle background opacity"
                onChange={(event) => patchSubStyle({ background: Number(event.target.value) })}
              />
            </label>
            <p className="pv-hint">Saved on this device and applied to the picture.</p>
          </div>

          <div className="pv-style">
            <p className="pv-field-label">Subtitle delay</p>
            <div className="pv-row">
              <button type="button" className="pv-file" onClick={() => nudgeDelay(-0.1)}>
                −0.1s
              </button>
              <button type="button" className="pv-file" onClick={() => patchSubStyle({ delay: 0 })}>
                Reset
              </button>
              <button type="button" className="pv-file" onClick={() => nudgeDelay(0.1)}>
                +0.1s
              </button>
            </div>
            <p className="pv-hint">
              {delayLabel(subStyle.delay)} · positive shows subtitles later, and each episode starts
              at zero.
            </p>
          </div>

          <div className="pv-style">
            <p className="pv-field-label">Skip intro</p>
            <div className="pv-row">
              <button
                type="button"
                className="pv-file"
                onClick={() => void saveMarker({ introStart: posRef.current }, "Intro start")}
              >
                Set intro here
              </button>
              <button
                type="button"
                className="pv-file"
                onClick={() => void saveMarker({ introEnd: posRef.current }, "Intro end")}
              >
                Set intro end
              </button>
            </div>
            <p className="pv-hint">
              {markMsg ?? "Applies to every episode of this show."}
            </p>
          </div>

          <div className="pv-addonsubs">
            <p className="pv-field-label">From addons</p>
            {subs === null ? (
              <Spinner label="Asking subtitle addons" />
            ) : subs.length === 0 ? (
              <p className="pv-hint">No subtitle addon returned tracks.</p>
            ) : (
              <div className="pv-sublist">
                {subs.map((track) => (
                  <button
                    key={track.id}
                    type="button"
                    onClick={() => {
                      void api.player.subtitle(track.url, track.lang);
                      notify(`Loading ${track.lang} subtitles`);
                    }}
                  >
                    <span>{track.lang || "Unknown"}</span>
                    <em>{track.addon}</em>
                  </button>
                ))}
              </div>
            )}
            <button type="button" className="pv-file" onClick={() => void loadSubtitleFile()}>
              <Icon name="plus" size={13} /> Load a file
            </button>
          </div>
        </aside>
      ) : null}

      {!loading ? (
        <div className="pv-center">
          <button
            type="button"
            className="pv-center-btn"
            onClick={() => seekRel(-10)}
            aria-label="Back 10 seconds"
          >
            <Icon name="replay10" size={32} />
          </button>
          <button
            type="button"
            className="pv-center-btn pv-center-btn--play"
            onClick={togglePause}
            aria-label={local.paused ? "Play" : "Pause"}
          >
            <Icon name={local.paused ? "play" : "pause"} size={42} />
          </button>
          <button
            type="button"
            className="pv-center-btn"
            onClick={() => seekRel(10)}
            aria-label="Forward 10 seconds"
          >
            <Icon name="forward10" size={32} />
          </button>
        </div>
      ) : null}

      <footer className="pv-deck">
        <div className="pv-details">
          <h1 className="pv-title" title={title}>
            {title}
          </h1>
          {session?.season != null ? (
            <p className="pv-subtitle">
              {episodeCode({ season: session.season, episode: session.episode })}
              {session.episodeTitle ? ` · ${session.episodeTitle}` : ""}
            </p>
          ) : null}
        </div>

        <div
          className="pv-track"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(shownPosition)}
          aria-valuetext={formatTime(shownPosition)}
          onPointerDown={(event) => {
            if (!duration) return;
            dragging.current = true;
            event.currentTarget.setPointerCapture(event.pointerId);
            setScrub(ratioFromEvent(event) * duration);
          }}
          onPointerMove={(event) => {
            if (!dragging.current || !duration) return;
            setScrub(ratioFromEvent(event) * duration);
          }}
          onPointerUp={(event) => {
            if (!dragging.current) return;
            dragging.current = false;
            const target = ratioFromEvent(event) * duration;
            setScrub(null);
            seekTo(target);
          }}
          onPointerCancel={() => {
            dragging.current = false;
            setScrub(null);
          }}
          onLostPointerCapture={() => {
            dragging.current = false;
            setScrub(null);
          }}
        >
          <span className="pv-buffer" style={{ width: `${bufferedPercent}%` }} />
          <span className="pv-played" style={{ width: `${percent}%` }} />
        </div>

        <div className="pv-bar">
          <div className="pv-actions">
            {prevEpisode ? (
              <button
                type="button"
                className="pv-action pv-action--flip"
                disabled={busy}
                onClick={() => void playVideo(prevEpisode)}
                aria-label="Previous episode"
              >
                <Icon name="next" size={22} />
              </button>
            ) : null}
            {nextEpisode ? (
              <button
                type="button"
                className="pv-action"
                disabled={busy}
                onClick={() => void playVideo(nextEpisode)}
                aria-label="Next episode"
              >
                <Icon name="next" size={22} />
              </button>
            ) : null}

            <button
              type="button"
              className={`pv-action${surface === "tracks" ? " is-on" : ""}`}
              onClick={() => {
                toggleSurface("tracks");
                void loadSubtitles();
              }}
              aria-label="Audio and subtitles"
              aria-expanded={surface === "tracks"}
            >
              <Icon name="subtitle" size={22} />
            </button>

            <div className="pv-speed">
              <button
                type="button"
                className={`pv-action${speedOpen ? " is-on" : ""}`}
                onClick={() => setSpeedOpen((current) => !current)}
                aria-label={`Playback speed ${local.speed} times`}
                aria-haspopup="menu"
                aria-expanded={speedOpen}
              >
                <Icon name="speed" size={22} />
              </button>
              {speedOpen ? (
                <div className="pv-menu" role="menu" aria-label="Playback speed">
                  {SPEEDS.map((value) => (
                    <button
                      key={value}
                      type="button"
                      role="menuitemradio"
                      aria-checked={Math.abs(local.speed - value) < 0.01}
                      className={`pv-menu-item${Math.abs(local.speed - value) < 0.01 ? " is-on" : ""}`}
                      onClick={() => {
                        speedRef.current = value;
                        send("speed", value);
                        setSpeedOpen(false);
                      }}
                    >
                      {value}×
                    </button>
                  ))}
                </div>
              ) : null}
            </div>

            <button
              type="button"
              className={`pv-action${surface === "stats" ? " is-on" : ""}`}
              onClick={() => toggleSurface("stats")}
              aria-label="Playback statistics"
              aria-expanded={surface === "stats"}
            >
              <Icon name="info" size={22} />
            </button>

            <button
              type="button"
              className={`pv-action${surface === "keys" ? " is-on" : ""}`}
              onClick={() => toggleSurface("keys")}
              aria-label="Keyboard shortcuts"
              aria-expanded={surface === "keys"}
            >
              <Icon name="key" size={22} />
            </button>
          </div>

          <div className="pv-bar-right">
            <div className="pv-vol">
              <button
                type="button"
                className="pv-action"
                aria-label={local.muted ? "Unmute" : "Mute"}
                onClick={toggleMute}
              >
                <Icon name={local.muted ? "mute" : "volume"} size={22} />
              </button>
              <input
                type="range"
                min={0}
                max={130}
                value={Math.round(local.volume)}
                aria-label="Volume"
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </div>

            <button
              type="button"
              className="pv-action"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <Icon name={fullscreen ? "compress" : "expand"} size={22} />
            </button>

            <button
              type="button"
              className="pv-runtime"
              onClick={() => setShowRemaining((current) => !current)}
              aria-label="Switch between elapsed and remaining time"
            >
              {showRemaining
                ? `−${formatTime(remaining)}`
                : `${formatTime(shownPosition)} / ${formatTime(duration)}`}
            </button>
          </div>
        </div>
      </footer>

      {hud ? (
        <div
          className={`pv-hud${hud.out ? " is-out" : ""}`}
          role="status"
          aria-live="polite"
        >
          <span>{hud.label}</span>
          <b>{hud.value}</b>
        </div>
      ) : null}
    </div>
  );
}
