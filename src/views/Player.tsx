import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isBrowserPreview, isTauri } from "../lib/bridge";
import { useApp, usePlayer } from "../lib/store";
import type { Details, PlayerSnapshot, SubtitleTrack, Video } from "../lib/types";
import { Icon, Spinner } from "../components/ui";
import { formatTime, progressPercent, seasonLabel } from "../lib/format";

/**
 * Playback screen.
 *
 * The picture is painted into the window behind this layer, so the page itself
 * has to stay transparent. Only the shade gradients and the deck that sits on
 * top of them are visible; everything else is the video.
 */
export function PlayerView() {
  const { settings, notify, navigate, playRequest, buildSession } = useApp();
  const player = usePlayer();
  const [local, setLocal] = useState<PlayerSnapshot | null>(player);
  const [panel, setPanel] = useState(false);
  const [help, setHelp] = useState(false);
  const [chrome, setChrome] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [subs, setSubs] = useState<SubtitleTrack[] | null>(null);
  const [busy, setBusy] = useState(false);
  // Seconds spent waiting for the source so far, so a slow provider is
  // visible instead of an unchanging spinner.
  const [waited, setWaited] = useState(0);

  const advanced = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const dragging = useRef(false);
  const wasPlaying = useRef(false);
  const fsNow = useRef(false);

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

  useEffect(() => {
    advanced.current = false;
    // A new episode brings its own subtitle list; keep the old one out.
    setSubs(null);
  }, [session?.key]);

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
        const source = sources.find((stream) => stream.playable && stream.url);
        if (!source?.url) throw new Error("No playable source for that episode.");
        await playRequest({
          url: source.url,
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
    [buildSession, details, notify, playRequest],
  );

  useEffect(() => {
    if (!local?.ended || !settings?.autoPlayNext || !nextEpisode || advanced.current) return;
    advanced.current = true;
    void playVideo(nextEpisode);
  }, [local?.ended, settings?.autoPlayNext, nextEpisode, playVideo]);

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
    (position: number) => {
      send("seek", Math.max(0, position));
    },
    [send],
  );

  const seekRel = useCallback(
    (delta: number) => {
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

  const bump = useCallback(() => {
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    if (local?.paused || local?.ended || panel || help) return;
    hideTimer.current = window.setTimeout(() => setChrome(false), 2600);
  }, [local?.paused, local?.ended, panel, help]);

  useEffect(() => {
    bump();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [bump]);

  const step = settings?.seekStep ?? 10;

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

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName)) return;
      switch (event.key) {
        case " ":
        case "k":
          event.preventDefault();
          togglePause();
          break;
        case "ArrowLeft":
          seekRel(-step);
          break;
        case "ArrowRight":
          seekRel(step);
          break;
        case "ArrowUp":
          event.preventDefault();
          setVolume((local?.volume ?? 100) + 5);
          break;
        case "ArrowDown":
          event.preventDefault();
          setVolume((local?.volume ?? 100) - 5);
          break;
        case "f":
          void toggleFullscreen();
          break;
        case "m":
          send("mute");
          break;
        case "s":
          void loadSubtitles();
          setPanel((current) => !current);
          break;
        case "?":
          setHelp((current) => !current);
          break;
        case "Escape":
          if (help) setHelp(false);
          else if (panel) setPanel(false);
          else if (fsNow.current) void toggleFullscreen();
          else void stop();
          break;
        default:
          return;
      }
      bump();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [
    bump,
    help,
    loadSubtitles,
    local?.volume,
    panel,
    seekRel,
    send,
    setVolume,
    step,
    stop,
    togglePause,
    toggleFullscreen,
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

  const duration = local.duration || 0;
  const audioTracks = local.audioTracks ?? [];
  const subTracks = local.subTracks ?? [];
  const shownPosition = scrub ?? local.position;
  const percent = progressPercent(shownPosition, duration);
  const bufferedPercent =
    duration > 0 && local.buffered ? Math.min(100, (local.buffered / duration) * 100) : 0;
  const remaining = Math.max(0, duration - shownPosition);
  const loading = !local.ended && duration <= 0;
  const title = session?.name ?? local.title;
  const activeSub = subTracks.find((track) => track.id === local.activeSub) ?? null;

  const ratioFromEvent = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
  };

  const shortcuts: Array<[string, string]> = [
    ["Space / K", "Play and pause"],
    ["← →", `Back and forward ${step}s`],
    ["↑ ↓", "Volume"],
    ["F", "Fullscreen"],
    ["M", "Mute"],
    ["S", "Tracks"],
    ["Esc", "Leave playback"],
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
        togglePause();
      }}
    >
      <div className="pv-shade" aria-hidden="true" />

      <header className="pv-top">
        <button type="button" className="pv-icon" onClick={() => void stop()} aria-label="Back to title">
          <Icon name="back" size={18} />
        </button>
        <div className="pv-id">
          <p className="pv-index">
            {session?.season != null ? seasonLabel(session.season, session.episode) : "Feature"}
            {local.ended ? " · finished" : local.paused ? " · paused" : ""}
          </p>
          <h1 className="pv-name" title={title}>
            {title}
          </h1>
          {session?.episodeTitle ? <p className="pv-ep">{session.episodeTitle}</p> : null}
        </div>
        <button
          type="button"
          className={`pv-icon${help ? " is-on" : ""}`}
          onClick={() => setHelp((current) => !current)}
          aria-label="Keyboard shortcuts"
        >
          <Icon name="key" size={17} />
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

      {help ? (
        <section className="pv-help" aria-label="Keyboard shortcuts">
          {shortcuts.map(([keys, what]) => (
            <p key={keys}>
              <kbd>{keys}</kbd>
              <span>{what}</span>
            </p>
          ))}
        </section>
      ) : null}

      {local.ended ? (
        <section className="pv-next">
          <p className="pv-next-label">{nextEpisode ? "Up next" : "End of the line"}</p>
          {nextEpisode ? (
            <>
              <h2>
                {seasonLabel(nextEpisode.season, nextEpisode.episode ?? nextEpisode.number)}
                {nextEpisode.title ? ` · ${nextEpisode.title}` : ""}
              </h2>
              <div className="pv-next-actions">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void playVideo(nextEpisode)}
                >
                  <Icon name="play" size={15} />
                  {busy ? "Loading…" : "Play next"}
                </button>
                <button type="button" className="btn btn-ghost" onClick={() => void stop()}>
                  Close
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Nothing queued after this one.</h2>
              <div className="pv-next-actions">
                <button type="button" className="btn btn-ghost" onClick={() => void stop()}>
                  Close
                </button>
              </div>
            </>
          )}
        </section>
      ) : null}

      {panel ? (
        <aside className="pv-panel">
          <div className="pv-panel-head">
            <h2>Tracks</h2>
            <button type="button" className="pv-icon" onClick={() => setPanel(false)} aria-label="Close">
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

          <label className="pv-field">
            <span>Speed</span>
            <select
              value={String(local.speed)}
              onChange={(event) => send("speed", Number(event.target.value))}
            >
              {[0.5, 0.75, 1, 1.25, 1.5, 2].map((speed) => (
                <option key={speed} value={speed}>
                  {speed}×
                </option>
              ))}
            </select>
          </label>

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

      <footer className="pv-deck">
        <div
          className="pv-track"
          role="slider"
          tabIndex={0}
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(shownPosition)}
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
          <i className="pv-head" style={{ left: `${percent}%` }} />
        </div>

        <div className="pv-row">
          <button
            type="button"
            className="pv-play"
            aria-label={local.paused ? "Play" : "Pause"}
            onClick={togglePause}
          >
            <Icon name={local.paused ? "play" : "pause"} size={26} />
          </button>

          <p className="pv-clock">
            <span>{formatTime(shownPosition)}</span>
            <span className="pv-clock-sep">/</span>
            <span className="pv-clock-total">{formatTime(duration)}</span>
            <span className="pv-clock-left">−{formatTime(remaining)}</span>
          </p>

          <div className="pv-steps">
            <button type="button" className="pv-step" onClick={() => seekRel(-step)} aria-label={`Back ${step} seconds`}>
              −{step}
            </button>
            <button type="button" className="pv-step" onClick={() => seekRel(step)} aria-label={`Forward ${step} seconds`}>
              +{step}
            </button>
          </div>

          {prevEpisode ? (
            <button
              type="button"
              className="pv-text"
              disabled={busy}
              onClick={() => void playVideo(prevEpisode)}
            >
              Previous
            </button>
          ) : null}
          {nextEpisode ? (
            <button
              type="button"
              className="pv-text"
              disabled={busy}
              onClick={() => void playVideo(nextEpisode)}
            >
              Next
            </button>
          ) : null}

          <div className="pv-right">
            <div className="pv-vol">
              <button
                type="button"
                className="pv-icon"
                aria-label={local.muted ? "Unmute" : "Mute"}
                onClick={() => send("mute")}
              >
                <Icon name={local.muted ? "mute" : "volume"} size={18} />
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
              className={`pv-text${activeSub ? " is-set" : ""}`}
              onClick={() => {
                setPanel((current) => !current);
                void loadSubtitles();
              }}
            >
              {activeSub?.label ?? "Subs"}
            </button>

            <button
              type="button"
              className={`pv-icon${panel ? " is-on" : ""}`}
              onClick={() => {
                setPanel((current) => !current);
                void loadSubtitles();
              }}
              aria-label="Tracks"
            >
              <Icon name="sliders" size={18} />
            </button>

            <button
              type="button"
              className="pv-icon"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <Icon name={fullscreen ? "compress" : "expand"} size={18} />
            </button>

            <button type="button" className="pv-icon pv-close" onClick={() => void stop()} aria-label="Stop playback">
              <Icon name="stop" size={14} />
            </button>
          </div>
        </div>
      </footer>
    </div>
  );
}
