import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, ReactNode, RefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { api, isBrowserPreview, isTauri } from "../lib/bridge";
import {
  noSourceError,
  pickSource,
  rememberSource,
  rememberSubtitle,
  rememberedSource,
  rememberedSubtitle,
  useApp,
  usePlayer,
} from "../lib/store";
import { rememberedLogo } from "../lib/art";
import type {
  Details,
  PlayerSnapshot,
  ProgressItem,
  StreamOption,
  SubtitleTrack,
  Track,
  Video,
} from "../lib/types";
import { Icon, Spinner, type IconName } from "../components/ui";
import { findSkip, type SkipEntry } from "../components/player/skip";
import { bufferPercent, episodeCode, formatTime, progressPercent, seasonLabel } from "../lib/format";
import "../components/player/player.css";

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
const NEXT_LEAD = 45;
const SUB_STYLE_KEY = "betternuvio.subtitleStyle";
const VIDEO_MODE_KEY = "betternuvio.videoMode";
const VOLUME_KEY = "betternuvio.volume";
const MAX_VOLUME = 200;
const OFF = "__off__";
const SUB_COLORS = [
  { value: "#ffffff", label: "White" },
  { value: "#f1e2c6", label: "Warm white" },
  { value: "#ffd84d", label: "Yellow" },
  { value: "#8fd8ff", label: "Sky blue" },
  { value: "#7dffc4", label: "Mint" },
  { value: "#ff8d8d", label: "Red" },
  { value: "#c9a7ff", label: "Lavender" },
  { value: "#ffb066", label: "Orange" },
];
const OUTLINE_COLORS = [
  { value: "#000000", label: "Black" },
  { value: "#ffffff", label: "White" },
  { value: "#8fd8ff", label: "Sky blue" },
  { value: "#ff8d8d", label: "Red" },
];

/** How the picture sits in the window, in the order the button cycles them. */
const VIDEO_MODES = [
  { id: "fit", label: "Fit", hint: "Whole picture, bars where the shape differs" },
  { id: "fill", label: "Fill", hint: "Crop the edges until the picture fills the window" },
  { id: "stretch", label: "Stretch", hint: "Stretch to the window, nothing cropped" },
] as const;
type VideoMode = (typeof VIDEO_MODES)[number]["id"];

type Surface =
  | "audio"
  | "subs"
  | "chapters"
  | "sources"
  | "episodes"
  | "info"
  | "keys"
  | "more"
  | null;

interface SubtitleStyle {
  size: number;
  color: string;
  /** 0-100, carried in the alpha byte of the mpv text colour. */
  opacity: number;
  background: number;
  outline: boolean;
  outlineColor: string;
  bold: boolean;
  delay: number;
  /** mpv `sub-pos`: 0 is the top edge, 100 the bottom edge. */
  position: number;
}

interface Hud {
  label: string;
  value: string;
  out: boolean;
}

const DEFAULT_SUB_STYLE: SubtitleStyle = {
  size: 46,
  color: "#ffffff",
  opacity: 100,
  background: 55,
  outline: true,
  outlineColor: "#000000",
  bold: false,
  delay: 0,
  position: 96,
};
const MAX_DELAY = 60;

/** True once a control is off its default, which is when ASS styling steps aside. */
function customStyle(style: SubtitleStyle): boolean {
  return (
    style.size !== DEFAULT_SUB_STYLE.size ||
    style.color !== DEFAULT_SUB_STYLE.color ||
    style.opacity !== DEFAULT_SUB_STYLE.opacity ||
    style.background !== DEFAULT_SUB_STYLE.background ||
    style.outline !== DEFAULT_SUB_STYLE.outline ||
    style.outlineColor !== DEFAULT_SUB_STYLE.outlineColor ||
    style.bold !== DEFAULT_SUB_STYLE.bold ||
    style.position !== DEFAULT_SUB_STYLE.position
  );
}
const NO_VARIANTS: SubVariant[] = [];

/** ISO codes and full names both arrive from mpv and from addons. */
const LANG_NAMES: Record<string, string> = {
  en: "English", eng: "English", english: "English",
  hi: "Hindi", hin: "Hindi", hindi: "Hindi",
  ta: "Tamil", tam: "Tamil", te: "Telugu", tel: "Telugu",
  ml: "Malayalam", mal: "Malayalam", kn: "Kannada", kan: "Kannada",
  bn: "Bengali", ben: "Bengali", mr: "Marathi", mar: "Marathi",
  pa: "Punjabi", pun: "Punjabi", ur: "Urdu", ar: "Arabic", ara: "Arabic",
  fa: "Persian", fas: "Persian", per: "Persian", es: "Spanish", spa: "Spanish",
  fr: "French", fra: "French", fre: "French", de: "German", deu: "German",
  ger: "German", it: "Italian", ita: "Italian", pt: "Portuguese", por: "Portuguese",
  ru: "Russian", rus: "Russian", ja: "Japanese", jpn: "Japanese",
  ko: "Korean", kor: "Korean", zh: "Chinese", zho: "Chinese", chi: "Chinese",
  tr: "Turkish", tur: "Turkish", pl: "Polish", pol: "Polish",
  nl: "Dutch", dut: "Dutch", nld: "Dutch", sv: "Swedish", swe: "Swedish",
  no: "Norwegian", nor: "Norwegian", da: "Danish", dan: "Danish",
  fi: "Finnish", fin: "Finnish", cs: "Czech", ces: "Czech", cze: "Czech",
  sk: "Slovak", slk: "Slovak", slo: "Slovak", hu: "Hungarian", hun: "Hungarian",
  uk: "Ukrainian", ukr: "Ukrainian", he: "Hebrew", heb: "Hebrew",
  el: "Greek", gre: "Greek", ell: "Greek", ro: "Romanian", ron: "Romanian",
  rum: "Romanian", th: "Thai", tha: "Thai", vi: "Vietnamese", vie: "Vietnamese",
  id: "Indonesian", ind: "Indonesian", ms: "Malay", msa: "Malay", may: "Malay",
  fil: "Filipino", tgl: "Filipino",
};

function langLabel(lang?: string | null, fallback?: string | null): string {
  const raw = (lang ?? "").trim();
  if (!raw) {
    const spare = (fallback ?? "").trim();
    return spare || "Unknown";
  }
  const key = raw.toLowerCase().split(/[-_]/)[0];
  if (LANG_NAMES[key]) return LANG_NAMES[key];
  return raw.length <= 3 ? raw.toUpperCase() : raw;
}

function readVideoMode(): VideoMode {
  const stored = window.localStorage.getItem(VIDEO_MODE_KEY);
  return VIDEO_MODES.some((mode) => mode.id === stored) ? (stored as VideoMode) : "fit";
}

function readVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw == null || raw.trim() === "") return 100;
    return whole(raw, 0, MAX_VOLUME, 100);
  } catch {
    return 100;
  }
}

interface SubVariant {
  key: string;
  label: string;
  source: string;
  lang: string;
  trackId?: number;
  url?: string;
}

interface SubGroup {
  lang: string;
  variants: SubVariant[];
}

/** Embedded tracks and addon results, folded into one language-first list. */
function groupSubtitles(tracks: Track[], addons: SubtitleTrack[] | null): SubGroup[] {
  const groups = new Map<string, SubGroup>();
  const seen = new Set<string>();
  const add = (variant: SubVariant) => {
    if (seen.has(variant.key)) return;
    seen.add(variant.key);
    const group = groups.get(variant.lang) ?? { lang: variant.lang, variants: [] };
    group.variants.push(variant);
    groups.set(variant.lang, group);
  };
  for (const track of tracks) {
    add({
      key: `e${track.id}`,
      label: track.label || langLabel(track.lang),
      source: track.external ? "Loaded file" : "Built in",
      lang: langLabel(track.lang, track.label),
      trackId: track.id,
    });
  }
  for (const sub of addons ?? []) {
    const lang = langLabel(sub.lang);
    add({
      key: `a${sub.id}${sub.url}`,
      label: sub.lang ? langLabel(sub.lang) : "Subtitle",
      source: sub.addon,
      lang,
      url: sub.url,
    });
  }
  return [...groups.values()];
}

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

function mpvColor(color: string, opacity: number): string {
  const alpha = Math.round((Math.min(100, Math.max(0, opacity)) / 100) * 255);
  const rgb = color.replace("#", "").slice(0, 6).padStart(6, "0");
  return `#${alpha.toString(16).padStart(2, "0")}${rgb}`;
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
      opacity: whole(stored.opacity, 0, 100, DEFAULT_SUB_STYLE.opacity),
      background: whole(stored.background, 0, 100, DEFAULT_SUB_STYLE.background),
      outline: stored.outline !== false,
      outlineColor: OUTLINE_COLORS.some((option) => option.value === stored.outlineColor)
        ? String(stored.outlineColor)
        : DEFAULT_SUB_STYLE.outlineColor,
      bold: stored.bold === true,
      delay: tenths(stored.delay, DEFAULT_SUB_STYLE.delay),
      position: whole(stored.position, 25, 100, DEFAULT_SUB_STYLE.position),
    };
  } catch {
    return DEFAULT_SUB_STYLE;
  }
}

function sameSource(a: StreamOption | null, b: StreamOption): boolean {
  if (!a) return false;
  return (
    a.addon === b.addon &&
    (a.url ?? "") === (b.url ?? "") &&
    (a.infoHash ?? "") === (b.infoHash ?? "") &&
    (a.fileIdx ?? -1) === (b.fileIdx ?? -1)
  );
}

/** Floating panel anchored bottom-right, above the transport. */
function Overlay({
  label,
  onClose,
  children,
}: {
  label: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="pv-overlay"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="pv-overlay-body"
        role="dialog"
        aria-label={label}
        aria-modal="true"
        onClick={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      >
        <header className="pv-overlay-head">
          <h2 className="pv-overlay-title">{label}</h2>
          <button
            type="button"
            className="pv-overlay-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="pv-overlay-scroll">{children}</div>
      </section>
    </div>
  );
}

/** Side sheet from the right, the shape Nuvio uses for sources and episodes. */
function SidePanel({
  label,
  title,
  onClose,
  children,
}: {
  label: string;
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  return (
    <div
      className="pv-side-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <aside className="pv-side" role="dialog" aria-label={label} aria-modal="true">
        <header className="pv-side-head">
          <h2>{title}</h2>
          <button
            type="button"
            className="pv-overlay-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </header>
        <div className="pv-side-body">{children}</div>
      </aside>
    </div>
  );
}

function Stepper({
  value,
  onDown,
  onUp,
  downLabel,
  upLabel,
}: {
  value: string;
  onDown: () => void;
  onUp: () => void;
  downLabel: string;
  upLabel: string;
}) {
  return (
    <div className="pv-stepper">
      <button type="button" onClick={onDown} aria-label={downLabel}>
        <Icon name="minus" size={16} />
      </button>
      <b>{value}</b>
      <button type="button" onClick={onUp} aria-label={upLabel}>
        <Icon name="plus" size={16} />
      </button>
    </div>
  );
}

function StyleSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="pv-style-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

/**
 * Seek bar. Owns the hover tip and its still, so pointer moves repaint this row
 * instead of the whole screen.
 */
const SeekTrack = memo(function SeekTrack({
  duration,
  shownPosition,
  percent,
  bufferedPercent,
  step,
  resetKey,
  dragging,
  frameCache,
  frameBucket,
  onSeek,
  onSeekRel,
  onScrub,
  onBump,
}: {
  duration: number;
  shownPosition: number;
  percent: number;
  bufferedPercent: number;
  step: number;
  resetKey: string | undefined;
  dragging: RefObject<boolean>;
  frameCache: RefObject<Map<number, string>>;
  frameBucket: RefObject<number>;
  onSeek: (target: number) => void;
  onSeekRel: (delta: number) => void;
  onScrub: (value: number | null) => void;
  onBump: () => void;
}) {
  const [hover, setHover] = useState<{ time: number; ratio: number } | null>(null);
  const [frame, setFrame] = useState<{ time: number; src: string } | null>(null);
  // Measured once per gesture: a rect read on every move forces a sync layout.
  const rect = useRef<DOMRect | null>(null);
  const frameSeq = useRef(0);
  const raf = useRef(0);
  const queued = useRef<{ ratio: number; drag: boolean } | null>(null);

  // A new episode or source invalidates both the tip and its still.
  useEffect(() => {
    frameSeq.current += 1;
    setHover(null);
    setFrame(null);
  }, [resetKey]);

  useEffect(() => () => window.cancelAnimationFrame(raf.current), []);

  const ratioAt = (clientX: number, element: HTMLDivElement) => {
    const box = rect.current ?? element.getBoundingClientRect();
    return Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  };

  // One state write per frame, however fast the pointer reports.
  const queue = (event: ReactPointerEvent<HTMLDivElement>) => {
    const ratio = ratioAt(event.clientX, event.currentTarget);
    queued.current = { ratio, drag: dragging.current };
    if (raf.current) return;
    raf.current = window.requestAnimationFrame(() => {
      raf.current = 0;
      const next = queued.current;
      if (!next) return;
      setHover({ time: next.ratio * duration, ratio: next.ratio });
      if (next.drag) onScrub(next.ratio * duration);
    });
  };

  // One still per five seconds of the bar, and only once the pointer rests.
  useEffect(() => {
    if (dragging.current || !hover) return;
    const bucket = Math.round(hover.time / 5) * 5;
    if (bucket < 5 || bucket === frameBucket.current) return;
    const cached = frameCache.current.get(bucket);
    if (cached) {
      frameBucket.current = bucket;
      setFrame({ time: bucket, src: cached });
      return;
    }
    const seq = ++frameSeq.current;
    const timer = window.setTimeout(() => {
      void api.player
        .frame(bucket)
        .then((src) => {
          if (!src || frameSeq.current !== seq) return;
          // Marked only once it lands: a cancelled hover must retry this bucket.
          frameBucket.current = bucket;
          frameCache.current.set(bucket, src);
          if (frameCache.current.size > 8) {
            const oldest = frameCache.current.keys().next().value;
            if (oldest != null) frameCache.current.delete(oldest);
          }
          setFrame({ time: bucket, src });
        })
        .catch(() => undefined);
    }, 300);
    return () => window.clearTimeout(timer);
  }, [frameBucket, frameCache, hover]);

  const hoverBucket = hover ? Math.round(hover.time / 5) * 5 : 0;
  const shot = frame && frame.time === hoverBucket ? frame.src : null;

  return (
    <div
      className={`pv-track${dragging.current ? " is-dragging" : ""}`}
      role="slider"
      tabIndex={0}
      aria-label="Seek"
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(shownPosition)}
      aria-valuetext={formatTime(shownPosition)}
      onPointerEnter={(event) => {
        rect.current = event.currentTarget.getBoundingClientRect();
      }}
      onPointerDown={(event) => {
        if (!duration) return;
        rect.current = event.currentTarget.getBoundingClientRect();
        dragging.current = true;
        event.currentTarget.setPointerCapture(event.pointerId);
        const ratio = ratioAt(event.clientX, event.currentTarget);
        setHover({ time: ratio * duration, ratio });
        onScrub(ratio * duration);
      }}
      onPointerMove={(event) => {
        if (!duration) return;
        queue(event);
      }}
      onPointerLeave={() => {
        if (!dragging.current) setHover(null);
      }}
      onPointerUp={(event) => {
        if (!dragging.current) return;
        dragging.current = false;
        const target = ratioAt(event.clientX, event.currentTarget) * duration;
        // Held at the target until the seek echo catches up.
        onScrub(target);
        setHover(null);
        onSeek(target);
        onBump();
      }}
      onPointerCancel={() => {
        dragging.current = false;
        onScrub(null);
        setHover(null);
      }}
      onLostPointerCapture={() => {
        // Capture is also lost on a normal release; only an early loss aborts.
        if (!dragging.current) return;
        dragging.current = false;
        onScrub(null);
        setHover(null);
      }}
      onKeyDown={(event) => {
        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
        event.preventDefault();
        onSeekRel((event.key === "ArrowLeft" ? -1 : 1) * step);
      }}
    >
      <span className="pv-trackrail" />
      <span className="pv-buffer" style={{ width: `${bufferedPercent}%` }} />
      <span className="pv-played" style={{ width: `${percent}%` }} />
      <span className="pv-knob" style={{ left: `${percent}%` }} aria-hidden="true" />

      {hover ? (
        <span
          className="pv-tip"
          style={{ left: `clamp(92px, ${hover.ratio * 100}%, calc(100% - 92px))` }}
        >
          {shot ? (
            <span className="pv-tip-shot">
              <img src={shot} alt="" draggable={false} />
            </span>
          ) : null}
          <b>{formatTime(hover.time)}</b>
        </span>
      ) : null}
    </div>
  );
});

const SourcesPanel = memo(function SourcesPanel({
  heading,
  sources,
  visibleSources,
  addonNames,
  sourceBusy,
  sourceFilter,
  playingSource,
  onFilter,
  onRefresh,
  onPick,
  onClose,
}: {
  heading: string;
  sources: StreamOption[] | null;
  visibleSources: StreamOption[];
  addonNames: string[];
  sourceBusy: boolean;
  sourceFilter: string | null;
  playingSource: StreamOption | null;
  onFilter: (addon: string | null) => void;
  onRefresh: () => void;
  onPick: (stream: StreamOption) => void;
  onClose: () => void;
}) {
  return (
    <SidePanel label="Sources" title="Sources" onClose={onClose}>
      <p className="pv-side-sub">{heading}</p>
      <div className="pv-filters">
        <button
          type="button"
          className={`pv-filter${sourceFilter === null ? " is-on" : ""}`}
          onClick={() => onFilter(null)}
        >
          All
        </button>
        {addonNames.map((addon) => (
          <button
            key={addon}
            type="button"
            className={`pv-filter${sourceFilter === addon ? " is-on" : ""}`}
            onClick={() => onFilter(addon)}
          >
            {addon}
          </button>
        ))}
        <button
          type="button"
          className="pv-filter pv-filter--action"
          disabled={sourceBusy}
          onClick={onRefresh}
        >
          <Icon name="refresh" size={15} />
          {sourceBusy ? "Loading" : "Refresh"}
        </button>
      </div>
      <div className="pv-side-list">
        {sourceBusy && !sources ? (
          <Spinner label="Finding sources" />
        ) : visibleSources.length === 0 ? (
          <p className="pv-side-empty">No sources returned for this episode.</p>
        ) : (
          visibleSources.map((stream, at) => {
            const current = sameSource(playingSource, stream);
            return (
              <button
                key={`${stream.addon}-${stream.infoHash ?? stream.url ?? at}-${at}`}
                type="button"
                className={`pv-source-row${current ? " is-on" : ""}`}
                disabled={!stream.playable || sourceBusy}
                onClick={() => onPick(stream)}
              >
                <span className="pv-source-text">
                  <span className="pv-source-name">
                    {stream.name ?? stream.addon ?? "Source"}
                    {current ? <em>Playing</em> : null}
                  </span>
                  <span className="pv-source-meta">
                    {[
                      stream.quality,
                      stream.addon,
                      stream.size,
                      stream.seeders != null ? `${stream.seeders} seeds` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                  {stream.description ? (
                    <span className="pv-source-note">
                      {stream.description.replace(/\n/g, " · ")}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </SidePanel>
  );
});

const EpisodesPanel = memo(function EpisodesPanel({
  queue,
  season,
  currentSeason,
  currentEpisode,
  metaId,
  progress,
  busy,
  onSeason,
  onPick,
  onClose,
}: {
  queue: Video[];
  season: number | null;
  currentSeason: number | null;
  currentEpisode: number | null;
  metaId: string;
  progress: Map<string, ProgressItem>;
  busy: boolean;
  onSeason: (value: number) => void;
  onPick: (video: Video) => void;
  onClose: () => void;
}) {
  const seasonOptions = useMemo(
    () =>
      [...new Set(queue.map((video) => video.season ?? 0))].sort(
        (a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b),
      ),
    [queue],
  );
  const seasonEpisodes = useMemo(
    () => queue.filter((video) => (video.season ?? 0) === (season ?? 0)),
    [queue, season],
  );

  return (
    <SidePanel label="Episodes" title="Episodes" onClose={onClose}>
      {seasonOptions.length > 0 ? (
        <div className="pv-filters">
          {seasonOptions.map((value) => (
            <button
              key={value}
              type="button"
              className={`pv-filter${(season ?? 0) === value ? " is-on" : ""}`}
              onClick={() => onSeason(value)}
            >
              {value === 0 ? "Specials" : `Season ${value}`}
            </button>
          ))}
        </div>
      ) : null}
      <div className="pv-side-list">
        {seasonEpisodes.length === 0 ? (
          <p className="pv-side-empty">No episodes available.</p>
        ) : (
          seasonEpisodes.map((video) => {
            const episode = video.episode ?? video.number ?? 0;
            const on = currentSeason === (video.season ?? 0) && currentEpisode === episode;
            const key =
              video.season != null ? `${metaId}:${video.season}:${episode}` : metaId;
            const saved = key ? progress.get(key) : undefined;
            const watched = Boolean(saved && saved.duration > 0 && saved.position / saved.duration >= 0.92);
            const pct =
              saved && saved.duration > 0
                ? Math.min(100, (saved.position / saved.duration) * 100)
                : 0;
            return (
              <button
                key={video.id}
                type="button"
                className={`pv-episode-row${on ? " is-on" : ""}`}
                disabled={busy}
                onClick={() => onPick(video)}
              >
                {video.thumbnail ? (
                  <img src={video.thumbnail} alt="" loading="lazy" decoding="async" />
                ) : (
                  <span className="pv-episode-blank" aria-hidden="true" />
                )}
                <span className="pv-episode-text">
                  <span className="pv-episode-code">
                    {episodeCode({ season: video.season, episode })}
                    {on ? <em>Playing</em> : watched ? <em>Watched</em> : null}
                  </span>
                  <span className="pv-episode-name">
                    {video.title || `Episode ${episode}`}
                  </span>
                  {video.overview ? (
                    <span className="pv-episode-note">{video.overview}</span>
                  ) : null}
                  {pct > 0 && !watched ? (
                    <span className="pv-episode-progress" aria-hidden="true">
                      <span style={{ width: `${pct}%` }} />
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })
        )}
      </div>
    </SidePanel>
  );
});

const SubtitlesPanel = memo(function SubtitlesPanel({
  subs,
  groups,
  offSelected,
  currentLang,
  currentVariants,
  styleOn,
  activeSub,
  loadedSub,
  subStyle,
  onLang,
  onChoose,
  onOff,
  onReload,
  onLoadFile,
  onPatch,
  onNudge,
  onReset,
  onClose,
}: {
  subs: SubtitleTrack[] | null;
  groups: SubGroup[];
  offSelected: boolean;
  currentLang: string | null;
  currentVariants: SubVariant[];
  styleOn: boolean;
  activeSub: number | null;
  loadedSub: { lang: string; url: string } | null;
  subStyle: SubtitleStyle;
  onLang: (lang: string | null) => void;
  onChoose: (variant: SubVariant) => void;
  onOff: () => void;
  onReload: () => void;
  onLoadFile: () => void;
  onPatch: (patch: Partial<SubtitleStyle>) => void;
  onNudge: (delta: number) => void;
  onReset: () => void;
  onClose: () => void;
}) {
  return (
    <Overlay label="Subtitles" onClose={onClose}>
      <div className="pv-rails">
        <section className="pv-rail pv-rail--lang">
          <h3>Languages</h3>
          <div className="pv-rail-list" role="listbox" aria-label="Subtitle language">
            <button
              type="button"
              role="option"
              aria-selected={offSelected}
              className={`pv-rail-row${offSelected ? " is-on" : ""}`}
              onClick={onOff}
            >
              <span className="pv-rail-row-text">
                <span className="pv-rail-row-title">None</span>
              </span>
              {offSelected ? <Icon name="check" size={20} /> : null}
            </button>
            {groups.map((group) => {
              const on = !offSelected && currentLang === group.lang;
              return (
                <button
                  key={group.lang}
                  type="button"
                  role="option"
                  aria-selected={on}
                  className={`pv-rail-row${on ? " is-on" : ""}`}
                  onClick={() => onLang(group.lang)}
                >
                  <span className="pv-rail-row-text">
                    <span className="pv-rail-row-title">{group.lang}</span>
                  </span>
                  <span className="pv-count">{group.variants.length}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="pv-rail pv-rail--variants">
          <h3>Subtitles</h3>
          {subs === null ? (
            <Spinner label="Finding subtitles" />
          ) : currentVariants.length === 0 ? (
            <div className="pv-rail-empty">
              <p>No subtitles in this language.</p>
              <button type="button" className="pv-text-action" onClick={onReload}>
                Find subtitles
              </button>
            </div>
          ) : (
            <div className="pv-rail-list" role="listbox" aria-label="Subtitle variant">
              {currentVariants.map((variant) => {
                const on =
                  variant.trackId != null
                    ? activeSub === variant.trackId
                    : loadedSub?.url === variant.url;
                return (
                  <button
                    key={variant.key}
                    type="button"
                    role="option"
                    aria-selected={on}
                    className={`pv-rail-row pv-rail-row--stack${on ? " is-on" : ""}`}
                    onClick={() => onChoose(variant)}
                  >
                    <span className="pv-rail-row-text">
                      <span className="pv-source-tag">{variant.source}</span>
                      <span className="pv-rail-row-title">{variant.label}</span>
                    </span>
                    {on ? <Icon name="check" size={20} /> : null}
                  </button>
                );
              })}
            </div>
          )}
          <button type="button" className="pv-text-action" onClick={onLoadFile}>
            <Icon name="plus" size={14} /> Load a file
          </button>
        </section>

        {styleOn ? (
          <section className="pv-rail pv-rail--style">
            <h3>Style</h3>
            <div className="pv-style">
              <StyleSection title="Delay">
                <Stepper
                  value={delayLabel(subStyle.delay)}
                  onDown={() => onNudge(-0.1)}
                  onUp={() => onNudge(0.1)}
                  downLabel="Subtitles 0.1 seconds earlier"
                  upLabel="Subtitles 0.1 seconds later"
                />
                <button
                  type="button"
                  className="pv-text-action"
                  onClick={() => onPatch({ delay: 0 })}
                >
                  Reset
                </button>
              </StyleSection>

              <StyleSection title="Font size">
                <Stepper
                  value={`${subStyle.size}`}
                  onDown={() => onPatch({ size: whole(subStyle.size - 2, 30, 90, 46) })}
                  onUp={() => onPatch({ size: whole(subStyle.size + 2, 30, 90, 46) })}
                  downLabel="Smaller subtitles"
                  upLabel="Larger subtitles"
                />
              </StyleSection>

              <StyleSection title="Bold">
                <button
                  type="button"
                  className={`pv-toggle${subStyle.bold ? " is-on" : ""}`}
                  aria-label="Bold subtitles"
                  aria-pressed={subStyle.bold}
                  onClick={() => onPatch({ bold: !subStyle.bold })}
                >
                  {subStyle.bold ? "On" : "Off"}
                </button>
              </StyleSection>

              <StyleSection title="Colour">
                <div className="pv-swatches">
                  {SUB_COLORS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`pv-swatch${subStyle.color === option.value ? " is-on" : ""}`}
                      style={{ background: option.value }}
                      aria-label={option.label}
                      aria-pressed={subStyle.color === option.value}
                      onClick={() => onPatch({ color: option.value })}
                    />
                  ))}
                </div>
              </StyleSection>

              <StyleSection title="Text opacity">
                <Stepper
                  value={`${subStyle.opacity}%`}
                  onDown={() => onPatch({ opacity: whole(subStyle.opacity - 10, 0, 100, 100) })}
                  onUp={() => onPatch({ opacity: whole(subStyle.opacity + 10, 0, 100, 100) })}
                  downLabel="Subtitles more transparent"
                  upLabel="Subtitles more opaque"
                />
              </StyleSection>

              <StyleSection title="Background">
                <Stepper
                  value={`${subStyle.background}%`}
                  onDown={() => onPatch({ background: whole(subStyle.background - 10, 0, 100, 55) })}
                  onUp={() => onPatch({ background: whole(subStyle.background + 10, 0, 100, 55) })}
                  downLabel="Lighter subtitle background"
                  upLabel="Darker subtitle background"
                />
              </StyleSection>

              <StyleSection title="Outline">
                <button
                  type="button"
                  className={`pv-toggle${subStyle.outline ? " is-on" : ""}`}
                  aria-label="Subtitle outline"
                  aria-pressed={subStyle.outline}
                  onClick={() => onPatch({ outline: !subStyle.outline })}
                >
                  {subStyle.outline ? "On" : "Off"}
                </button>
                <div className="pv-swatches">
                  {OUTLINE_COLORS.map((option) => (
                    <button
                      key={option.value}
                      type="button"
                      className={`pv-swatch${subStyle.outlineColor === option.value ? " is-on" : ""}`}
                      style={{ background: option.value }}
                      aria-label={`${option.label} outline`}
                      aria-pressed={subStyle.outlineColor === option.value}
                      onClick={() => onPatch({ outlineColor: option.value, outline: true })}
                    />
                  ))}
                </div>
              </StyleSection>

              <StyleSection title="Position">
                <Stepper
                  value={`${subStyle.position}%`}
                  onDown={() => onPatch({ position: whole(subStyle.position - 5, 25, 100, 96) })}
                  onUp={() => onPatch({ position: whole(subStyle.position + 5, 25, 100, 96) })}
                  downLabel="Move subtitles up"
                  upLabel="Move subtitles down"
                />
              </StyleSection>

              <button type="button" className="pv-text-action" onClick={onReset}>
                Reset defaults
              </button>
            </div>
          </section>
        ) : null}
      </div>
    </Overlay>
  );
});


/**
 * Playback screen.
 *
 * The picture is painted into the window behind this layer, so the page itself
 * has to stay transparent. Only the shade gradients and the HUD on top of them
 * are visible; everything else is the video.
 */
export function PlayerView() {
  const {
    settings,
    notify,
    navigate,
    route,
    playRequest,
    buildSession,
    appInfo,
    resolveStream,
    playingSource,
    progressFor,
    progressByKey,
    leavePlayer,
    starting,
    cancelStart,
  } = useApp();
  const player = usePlayer();
  // The browser preview has no Tauri events, so its poll is its own source.
  const [preview, setPreview] = useState<PlayerSnapshot | null>(null);
  const snapshot = player ?? preview;
  // Held so the closing render keeps its session instead of flashing empty.
  const lastSnap = useRef<PlayerSnapshot | null>(snapshot);
  if (snapshot) lastSnap.current = snapshot;
  const local = snapshot ?? lastSnap.current;
  // Optimistic pause and mute: the icons must not wait up to a tick for the echo.
  const [pending, setPending] = useState<{ paused?: boolean; muted?: boolean }>({});
  const [surface, setSurface] = useState<Surface>(null);
  const [chrome, setChrome] = useState(true);
  const [locked, setLocked] = useState(false);
  // Narrow player: the right-hand action row folds into one popup.
  const [btnMenu, setBtnMenu] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [subs, setSubs] = useState<SubtitleTrack[] | null>(null);
  const [busy, setBusy] = useState(false);

  const [hud, setHud] = useState<Hud | null>(null);
  // Stremio's centre card: the level moved, so show it big for a moment.
  const [volOsd, setVolOsd] = useState(false);
  // The slider is driven locally; a tick from mpv would yank the thumb back
  // mid-drag, which is what made the control feel heavy.
  const [volLevel, setVolLevel] = useState(() => readVolume());
  const [subStyle, setSubStyle] = useState<SubtitleStyle>(readSubtitleStyle);
  const [nextOff, setNextOff] = useState(false);
  const [showRemaining, setShowRemaining] = useState(false);
  const [videoMode, setVideoMode] = useState<VideoMode>(readVideoMode);
  const [selectedLang, setSelectedLang] = useState<string | null>(null);
  const [loadedSub, setLoadedSub] = useState<{ lang: string; url: string } | null>(null);
  const [sources, setSources] = useState<StreamOption[] | null>(null);
  const [sourceFilter, setSourceFilter] = useState<string | null>(null);
  const [sourceBusy, setSourceBusy] = useState(false);
  const [season, setSeason] = useState<number | null>(null);
  // Stills for the seek tip live in SeekTrack; only the cache is shared.
  const frameCache = useRef(new Map<number, string>());
  const frameBucket = useRef(0);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [thumbBroken, setThumbBroken] = useState(false);
  const [markers, setMarkers] = useState<SkipEntry | null>(null);
  const [markMsg, setMarkMsg] = useState<string | null>(null);

  const advanced = useRef(false);
  const hideTimer = useRef<number | null>(null);
  const dragging = useRef(false);
  const bumpAt = useRef(0);
  // When the seek bar was last moved, so a lost echo cannot hold the thumb.
  const scrubAt = useRef(0);
  const scrubTimer = useRef<number | null>(null);
  const wasPlaying = useRef(false);
  const fsNow = useRef(false);
  const volRef = useRef(readVolume());
  const speedRef = useRef(1);
  const posRef = useRef(0);
  const hudTimer = useRef<number | null>(null);
  const hudOutTimer = useRef<number | null>(null);
  const volOsdTimer = useRef<number | null>(null);
  const volSeen = useRef<number | null>(null);
  // When the level was last set here, so stale ticks cannot fight the slider.
  const volTouched = useRef(0);
  // One engine write per frame, however fast the slider is dragged.
  const volFrame = useRef(0);
  const wheelAt = useRef(0);
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
  // False once the screen closes, so a slow open cannot navigate back into it.
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  // A control sent to a player that already exited must not turn into an
  // unhandled rejection; the next snapshot is the source of truth anyway.
  const send = useCallback(
    (action: string, value?: number | string | boolean | null) => {
      void api.player.control(action, value).catch(() => undefined);
    },
    [],
  );

  const pushSubStyle = useCallback(() => {
    // ASS tracks carry their own fonts and colours; they only listen to these
    // once the user has actually moved a control.
    send("sub-ass-override", customStyle(subStyle));
    send("sub-font-size", subStyle.size);
    send("sub-color", mpvColor(subStyle.color, subStyle.opacity));
    send("sub-back-color", mpvBackground(subStyle.background));
    send("sub-delay", subStyle.delay);
    send("sub-pos", subStyle.position);
    send("sub-bold", subStyle.bold);
    send("sub-border-size", subStyle.outline ? 2 : 0);
    send("sub-border-color", subStyle.outlineColor);
  }, [send, subStyle]);

  // A new mpv starts at defaults, so a source switch pushes every preference again.
  const pushPlaybackPrefs = useCallback(() => {
    send("volume", volRef.current);
    send("mute", Boolean(local?.muted));
    send("speed", speedRef.current);
    send("video-mode", videoMode);
    pushSubStyle();
  }, [local?.muted, pushSubStyle, send, videoMode]);

  // Playback can end behind the overlay. When the store clears the player we
  // return to the title instead of leaving a dead screen behind.
  useEffect(() => {
    if (player) {
      wasPlaying.current = true;
      return;
    }
    if (!wasPlaying.current) return;
    wasPlaying.current = false;
    // The store already leaves the player route; navigating again pushes twice.
    if (route.name !== "player") return;
    const session = local?.session;
    navigate(
      session
        ? { name: "details", id: session.metaId, type: session.type }
        : { name: "home" },
    );
  }, [player, local?.session, navigate, route.name]);

  // A tick that agrees settles the override; the timer covers a refused one.
  useEffect(() => {
    if (!local) return;
    setPending((current) => {
      let changed = false;
      const next = { ...current };
      if (next.paused !== undefined && local.paused === next.paused) {
        delete next.paused;
        changed = true;
      }
      if (next.muted !== undefined && local.muted === next.muted) {
        delete next.muted;
        changed = true;
      }
      return changed ? next : current;
    });
  }, [local]);

  // No tick arrives while the state is unchanged, so a refusal expires here.
  useEffect(() => {
    if (pending.paused === undefined && pending.muted === undefined) return;
    const timer = window.setTimeout(() => setPending({}), 1200);
    return () => window.clearTimeout(timer);
  }, [pending]);

  // The browser preview has no Tauri events, so poll the mock backend.
  useEffect(() => {
    if (!isBrowserPreview()) return;
    const timer = window.setInterval(() => {
      void api.player
        .state()
        .then(setPreview)
        .catch(() => undefined);
    }, 800);
    return () => window.clearInterval(timer);
  }, []);

  const session = local?.session ?? null;
  // The session object is rebuilt every tick; callbacks read the latest here.
  const sessionRef = useRef(session);
  sessionRef.current = session;
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

  const duration = local?.duration ?? 0;
  const position = local?.position ?? 0;
  // The override wins until a tick settles it.
  const paused = pending.paused ?? local?.paused ?? false;
  const muted = pending.muted ?? local?.muted ?? false;
  const shownPosition = scrub ?? position;
  const remaining = Math.max(0, duration - shownPosition);
  const failed = local?.error ?? null;
  // The first painted frame; older snapshots omit the field.
  const firstFrame = (local as (PlayerSnapshot & { started?: boolean }) | null)?.started === true;
  // A live stream never reports a duration, so only silence before the first
  // frame counts as loading.
  const loading = Boolean(local && !local.ended && !local.error && !firstFrame && duration <= 0);
  // A zero level is silent too, so the icon and label must agree with it.
  const silent = muted || volLevel === 0;
  const audioTracks = local?.audioTracks ?? [];
  const subTracks = local?.subTracks ?? [];
  const chapters = local?.chapters ?? [];

  // Track ids are the cheap signature: the array identity changes every tick.
  const subKey = subTracks.map((track) => track.id).join();
  const subGroups = useMemo(() => groupSubtitles(subTracks, subs), [subKey, subs]);

  const addonNames = useMemo(
    () => [...new Set((sources ?? []).map((entry) => entry.addon))],
    [sources],
  );
  const visibleSources = useMemo(
    () =>
      sources ? (sourceFilter ? sources.filter((entry) => entry.addon === sourceFilter) : sources) : [],
    [sources, sourceFilter],
  );

  const activeSub = subTracks.find((track) => track.id === local?.activeSub) ?? null;
  const activeAudio = audioTracks.find((track) => track.id === local?.activeAudio) ?? null;
  const mode = VIDEO_MODES.find((entry) => entry.id === videoMode) ?? VIDEO_MODES[0];
  const step = settings?.seekStep ?? 10;
  const nextCountdown = Math.max(0, Math.ceil((duration || 0) - position));
  const nextAutoPlay = settings?.autoPlayNext ?? false;
  const showNext = Boolean(
    nextEpisode &&
      !nextOff &&
      !failed &&
      (local?.ended || (duration > 60 && nextCountdown <= NEXT_LEAD)),
  );

  const playVideo = useCallback(
    async (video: Video) => {
      if (!details) return;
      setBusy(true);
      try {
        const nextSession = buildSession(details, video);
        const memory = rememberedSource(nextSession.key);
        const sources = await api.streams({
          id: details.imdbId ?? details.id,
          mediaType: details.type,
          season: video.season,
          episode: video.episode ?? video.number,
          imdbId: details.imdbId,
        });
        const source = pickSource(
          sources,
          settings?.preferredQuality ?? "auto",
          settings?.p2pConsent ?? false,
          playingSource,
          memory,
        );
        if (!source) throw noSourceError(sources, settings?.p2pConsent ?? false);
        const url = await resolveStream(source);
        // A pending open that resolves after the screen closed must bail.
        if (!alive.current) return;
        const saved = progressFor(nextSession.key);
        const startAt =
          saved && saved.duration > 0 && saved.position / saved.duration < 0.9
            ? saved.position
            : 0;
        const opened = await playRequest({
          url,
          title: `${details.name} · ${seasonLabel(video.season, video.episode ?? video.number)}`,
          startAt,
          session: nextSession,
        });
        if (opened) rememberSource(nextSession.key, source);
        if (!alive.current) return;
        pushPlaybackPrefs();
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setBusy(false);
      }
    },
    [
      buildSession,
      details,
      notify,
      playRequest,
      progressFor,
      pushPlaybackPrefs,
      resolveStream,
      settings?.p2pConsent,
      settings?.preferredQuality,
      playingSource,
    ],
  );

  const leaveFullscreen = useCallback(() => {
    // A browser fullscreen left set would outlive this screen.
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    if (!fsNow.current) return;
    fsNow.current = false;
    setFullscreen(false);
    delete document.documentElement.dataset.fullscreen;
    void api.window.fullscreen(false);
  }, []);

  // The browser can leave fullscreen on its own (Esc, gesture), so state follows it.
  useEffect(() => {
    const onChange = () => {
      const on = Boolean(document.fullscreenElement);
      fsNow.current = on;
      setFullscreen(on);
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const stop = useCallback(() => {
    alive.current = false;
    leaveFullscreen();
    // Leave the screen first: a stuck IPC call must not trap the user.
    leavePlayer();
    void api.player.stop().catch(() => undefined);
  }, [leaveFullscreen, leavePlayer]);

  // Never leave the window frameless after the overlay goes away.
  useEffect(() => () => leaveFullscreen(), [leaveFullscreen]);

  // mpv gets the target state, not a toggle: two senders can never cancel out.
  const togglePause = useCallback(() => {
    setPending((current) => ({ ...current, paused: !paused }));
    send("pause", !paused);
  }, [paused, send]);

  const seekTo = useCallback(
    (target: number, user = true) => {
      // A user going back before the intro re-arms the skip for it; the
      // auto-skip path must not.
      if (user && markers?.introStart != null && target < markers.introStart) {
        fired.current = { intro: false, outro: false };
      }
      // The last second reads as the end of the file, so it is not a target.
      const upper = duration > 0 ? Math.max(0, duration - 1) : Number.POSITIVE_INFINITY;
      send("seek", Math.min(upper, Math.max(0, target)));
    },
    [duration, markers, send],
  );

  const seekRel = useCallback(
    (delta: number) => {
      if (markers?.introStart != null && posRef.current + delta < markers.introStart) {
        fired.current = { intro: false, outro: false };
      }
      send("seek-rel", delta);
    },
    [markers, send],
  );

  // Every seek-bar move stamps the hold, so a release gets a fresh window.
  const holdScrub = useCallback((value: number | null) => {
    scrubAt.current = Date.now();
    setScrub(value);
    if (scrubTimer.current) window.clearTimeout(scrubTimer.current);
    // A refused seek never echoes, so the hold must expire on its own.
    scrubTimer.current =
      value == null ? null : window.setTimeout(() => setScrub(null), 1500);
  }, []);

  const setVolume = useCallback(
    (value: number) => {
      // The ref moves now so a burst of events lands on the last value; the
      // state, storage and engine writes happen once per frame.
      volRef.current = Math.min(MAX_VOLUME, Math.max(0, Math.round(value)));
      volTouched.current = Date.now();
      if (volFrame.current) return;
      volFrame.current = window.requestAnimationFrame(() => {
        volFrame.current = 0;
        const next = volRef.current;
        setVolLevel(next);
        setVolOsd(true);
        if (volOsdTimer.current) window.clearTimeout(volOsdTimer.current);
        volOsdTimer.current = window.setTimeout(() => setVolOsd(false), 1200);
        try {
          window.localStorage.setItem(VOLUME_KEY, String(next));
        } catch {
          // Storage can be blocked; the level still applies to this session.
        }
        send("volume", next);
      });
    },
    [send],
  );

  const toggleFullscreen = useCallback(async () => {
    if (!isTauri()) {
      if (document.fullscreenElement) {
        await document.exitFullscreen().catch(() => undefined);
      } else {
        await document.documentElement.requestFullscreen().catch(() => undefined);
      }
      // The event listener normally syncs this; a refused request must not.
      setFullscreen(Boolean(document.fullscreenElement));
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
      if (volOsdTimer.current) window.clearTimeout(volOsdTimer.current);
      if (scrubTimer.current) window.clearTimeout(scrubTimer.current);
      if (volFrame.current) window.cancelAnimationFrame(volFrame.current);
    },
    [],
  );

  // The level changed: flash the centre card, the way Stremio does.
  useEffect(() => {
    const level = local?.volume ?? null;
    if (level != null && volSeen.current != null && level !== volSeen.current) {
      setVolOsd(true);
      if (volOsdTimer.current) window.clearTimeout(volOsdTimer.current);
      volOsdTimer.current = window.setTimeout(() => setVolOsd(false), 1500);
    }
    volSeen.current = level;
  }, [local?.volume]);

  const changeVolume = useCallback(
    (delta: number) => {
      setVolume(volRef.current + delta);
    },
    [setVolume],
  );

  const toggleMute = useCallback(() => {
    // A zero level is already silent, so muting it again would do nothing.
    if (silent && Math.round(local?.volume ?? 0) === 0) {
      const restored = Math.round(MAX_VOLUME / 4);
      volRef.current = restored;
      setVolume(restored);
      setPending((current) => ({ ...current, muted: false }));
      send("mute", false);
      return;
    }
    // Send the target, not a toggle: mpv cycles and two senders would cancel.
    const next = !silent;
    setPending((current) => ({ ...current, muted: next }));
    send("mute", next);
  }, [local?.volume, send, setVolume, silent]);

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

  // Nuvio's speed control cycles through the list and wraps.
  const cycleSpeed = useCallback(() => {
    const found = SPEEDS.findIndex((speed) => Math.abs(speed - speedRef.current) < 0.01);
    const next = SPEEDS[(found === -1 ? SPEEDS.indexOf(1) : found + 1) % SPEEDS.length];
    speedRef.current = next;
    send("speed", next);
    showHud("Speed", `${next}×`);
  }, [send, showHud]);

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

  const cycleVideoMode = useCallback(() => {
    const at = VIDEO_MODES.findIndex((mode) => mode.id === videoMode);
    const next = VIDEO_MODES[(at + 1) % VIDEO_MODES.length];
    setVideoMode(next.id);
    try {
      window.localStorage.setItem(VIDEO_MODE_KEY, next.id);
    } catch {
      // Storage can be blocked; the mode still applies to this session.
    }
    send("video-mode", next.id);
    showHud("Picture", next.label);
  }, [send, showHud, videoMode]);

  const toggleSurface = useCallback((next: Exclude<Surface, null>) => {
    setSurface((current) => (current === next ? null : next));
  }, []);

  const loadSubtitles = useCallback(
    async (force = false) => {
      if (!session || (subs && !force)) return;
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
    },
    [session?.metaId, session?.type, session?.season, session?.episode, subs],
  );

  const loadSources = useCallback(
    async (force = false) => {
      if (!session || (sources && !force)) return;
      setSourceBusy(true);
      try {
        const result = await api.streams({
          id: details?.imdbId ?? details?.id ?? session.metaId,
          mediaType: session.type,
          season: session.season,
          episode: session.episode,
          imdbId: details?.imdbId,
        });
        setSources(result);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setSourceBusy(false);
      }
    },
    [details?.id, details?.imdbId, notify, session?.metaId, session?.type, session?.season, session?.episode, sources],
  );

  const openSubs = useCallback(() => {
    if (surface === "subs") {
      setSurface(null);
      return;
    }
    setSurface("subs");
    void loadSubtitles();
    setSelectedLang(activeSub ? langLabel(activeSub.lang, activeSub.label) : loadedSub?.lang ?? null);
  }, [activeSub?.lang, activeSub?.label, loadSubtitles, loadedSub?.lang, surface]);

  const chooseSub = useCallback(
    (variant: SubVariant) => {
      // Asking for the same addon again would add a second mpv track.
      if (variant.url && loadedSub?.url === variant.url) return;
      setSelectedLang(variant.lang);
      if (variant.trackId != null) {
        setLoadedSub(null);
        send("sub", variant.trackId);
        rememberSubtitle(sessionRef.current?.key, { lang: variant.lang, trackId: variant.trackId });
        return;
      }
      if (!variant.url) return;
      setLoadedSub({ lang: variant.lang, url: variant.url });
      rememberSubtitle(sessionRef.current?.key, {
        lang: variant.lang,
        url: variant.url,
        label: variant.label,
      });
      void api.player
        .subtitle(variant.url, variant.lang)
        .then(() => notify(`${variant.lang} subtitles`))
        .catch((error) => notify(error instanceof Error ? error.message : String(error), "error"));
    },
    [loadedSub?.url, notify, send],
  );

  const turnSubsOff = useCallback(() => {
    setLoadedSub(null);
    setSelectedLang(OFF);
    send("sub", null);
    rememberSubtitle(sessionRef.current?.key, { lang: "", off: true });
  }, [send]);

  const openEpisodes = useCallback(() => {
    setSeason(session?.season ?? queue[0]?.season ?? null);
    toggleSurface("episodes");
  }, [queue, session?.season, toggleSurface]);

  const switchSource = useCallback(
    async (stream: StreamOption) => {
      const session = sessionRef.current;
      if (!session) return;
      setSourceBusy(true);
      try {
        const url = await resolveStream(stream);
        if (!alive.current) return;
        const opened = await playRequest({
          url,
          title: local?.title || session.name,
          startAt: posRef.current,
          session,
        });
        if (opened) rememberSource(session.key, stream);
        if (!alive.current) return;
        // The same session object is reused, so nothing else re-applies the
        // settings to the new mpv.
        setLoadedSub(null);
        setSelectedLang(null);
        frameCache.current.clear();
        frameBucket.current = 0;
        pushPlaybackPrefs();
        setSurface(null);
      } catch (e) {
        notify(e instanceof Error ? e.message : String(e), "error");
      } finally {
        setSourceBusy(false);
      }
    },
    [local?.title, notify, playRequest, pushPlaybackPrefs, resolveStream],
  );

  // While a control holds keyboard focus the chrome stays, so the focus ring
  // does not vanish mid-keyboard navigation.
  const controlFocused = useCallback(() => {
    const active = document.activeElement;
    return Boolean(
      active instanceof HTMLElement &&
        active !== document.body &&
        rootRef.current?.contains(active) &&
        active.matches("button, input, [role='slider'], a") &&
        active.matches(":focus-visible"),
    );
  }, []);

  const bump = useCallback(() => {
    // Pointer moves arrive far faster than the chrome needs to react.
    const now = Date.now();
    if (now - bumpAt.current < 150) return;
    bumpAt.current = now;
    if (locked) return;
    setChrome(true);
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    // Keep the close controls on screen while a source is opening or has failed.
    if (loading || failed || paused || local?.ended || surface || showNext) return;
    if (dragging.current || controlFocused()) return;
    hideTimer.current = window.setTimeout(() => {
      if (dragging.current || controlFocused()) return;
      setChrome(false);
    }, 2600);
  }, [controlFocused, loading, failed, paused, local?.ended, surface, showNext, locked]);

  useEffect(() => {
    bump();
    return () => {
      if (hideTimer.current) window.clearTimeout(hideTimer.current);
    };
  }, [bump]);

  // A panel belongs to the chrome; when the chrome leaves, so does the panel.
  useEffect(() => {
    if (!chrome) setSurface(null);
  }, [chrome]);

  // An open panel holds the chrome on screen, even if the idle timer was
  // already running when it opened.
  useEffect(() => {
    if (!surface) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setChrome(true);
  }, [surface]);

  // Locking hides every control; a panel cannot stay open over the lock.
  useEffect(() => {
    if (!locked) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setChrome(false);
    setSurface(null);
  }, [locked]);

  // Keep the chrome on screen while the next-episode card is offered, so the
  // card has the timeline it belongs above.
  useEffect(() => {
    if (!showNext) return;
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    setChrome(true);
  }, [showNext]);

  const dismissNext = useCallback(() => {
    setNextOff(true);
    // Keep the end-of-file handler from starting the episode the viewer
    // explicitly waved off.
    advanced.current = true;
  }, []);

  // Each episode is a fresh session: clear everything that belonged to the
  // previous one, including a dismissed next-episode card.
  useEffect(() => {
    advanced.current = false;
    setSubs(null);
    setSources(null);
    setSourceFilter(null);
    setSelectedLang(null);
    setNextOff(false);
    setThumbBroken(false);
    setSurface(null);
    setLoadedSub(null);
    frameCache.current.clear();
    frameBucket.current = 0;
  }, [session?.key]);

  // Markers are stored per episode, keyed like the session. The command still
  // names the argument `metaId`. With no hand-set markers, IntroDB supplies the
  // community timestamps, so most shows skip without any setup.
  const imdbId = details?.imdbId ?? null;
  useEffect(() => {
    fired.current = { intro: false, outro: false };
    setMarkers(null);
    setMarkMsg(null);
    const key = session?.key;
    if (!key || !isTauri()) return;
    let live = true;
    invoke<SkipEntry | null>("skip_get", { metaId: key })
      .then(
        (entry) =>
          entry ??
          invoke<SkipEntry | null>("skip_lookup", {
            imdbId,
            season: session?.season ?? null,
            episode: session?.episode ?? null,
          }),
      )
      .then((entry) => {
        if (live) setMarkers(entry);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [session?.key, imdbId, session?.season, session?.episode]);

  // The saved level is pushed once per session, then echoes keep the ref true.
  const volumeSession = useRef<string | null>(null);
  useEffect(() => {
    if (!local) return;
    const key = session?.key ?? "";
    if (volumeSession.current !== key) {
      volumeSession.current = key;
      const next = readVolume();
      volRef.current = next;
      setVolLevel(next);
      send("volume", next);
      return;
    }
    // A tick that predates the last set here must not rewind the slider.
    if (Date.now() - volTouched.current < 800) return;
    volRef.current = Math.round(local.volume);
    setVolLevel(Math.round(local.volume));
  }, [local?.volume, send, session?.key]);

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

  // Markers move the playhead through the same path the skip buttons use. The
  // check is local, so it costs nothing per tick.
  useEffect(() => {
    if (!markers || loading || scrub != null) return;
    const segment = findSkip(markers, position, duration);
    if (!segment || fired.current[segment.kind]) return;
    fired.current[segment.kind] = true;
    seekTo(segment.at, false);
  }, [markers, position, duration, loading, scrub, seekTo]);

  // The thumb stays where it was dropped until the seek echo catches up; a
  // refused seek expires on the next tick after the hold window.
  useEffect(() => {
    if (scrub == null || dragging.current) return;
    if (Math.abs(position - scrub) < 1.5 || Date.now() - scrubAt.current > 1500) setScrub(null);
  }, [position, scrub]);

  // The preview above is only a preview: mpv draws the real subtitles, so the
  // same values are pushed to it, debounced so dragging a slider stays cheap.
  useEffect(() => {
    const timer = window.setTimeout(pushSubStyle, 150);
    return () => window.clearTimeout(timer);
  }, [session?.key, pushSubStyle]);

  // A session comes back with the subtitle it was left on, once per open.
  const subRestored = useRef<string | null>(null);
  const playerReady = Boolean(local);
  useEffect(() => {
    const key = session?.key;
    if (!key || !playerReady || subRestored.current === key) return;
    subRestored.current = key;
    const saved = rememberedSubtitle(key);
    if (!saved) return;
    if (saved.off) {
      setLoadedSub(null);
      setSelectedLang(OFF);
      send("sub", null);
      return;
    }
    setSelectedLang(saved.lang);
    if (saved.trackId != null) {
      setLoadedSub(null);
      send("sub", saved.trackId);
      return;
    }
    if (!saved.url) return;
    setLoadedSub({ lang: saved.lang, url: saved.url });
    void api.player.subtitle(saved.url, saved.label ?? saved.lang).catch(() => undefined);
  }, [session?.key, playerReady, send]);

  // The picture mode lives on the mpv process, so each new one gets it again.
  useEffect(() => {
    send("video-mode", videoMode);
    // Only on a new session: the cycle button already pushes its own change.
  }, [send, session?.key]);

  // Local storage is the persistence layer, except delay which is session-only.
  useEffect(() => {
    try {
      window.localStorage.setItem(SUB_STYLE_KEY, JSON.stringify(subStyle));
    } catch {
      // Storage can be full or blocked; the panel still works for this session.
    }
  }, [subStyle]);

  const patchSubStyle = useCallback((patch: Partial<SubtitleStyle>) => {
    setSubStyle((current) => ({ ...current, ...patch }));
  }, []);

  const nudgeDelay = useCallback((delta: number) => {
    setSubStyle((current) => ({ ...current, delay: tenths(current.delay + delta, current.delay) }));
  }, []);

  const saveMarker = useCallback(
    async (patch: SkipEntry, label: string) => {
      const key = session?.key;
      if (!key) return;
      if (!isTauri()) {
        setMarkMsg("Markers save in the desktop app");
        return;
      }
      const at = posRef.current;
      // skip_set replaces the entry whole, so the other marker is carried over.
      // A save can land before skip_get: read the stored entry first then.
      const known =
        markers ??
        (await invoke<SkipEntry | null>("skip_get", { metaId: key }).catch(() => null));
      const merged: SkipEntry = { ...(known ?? {}), ...patch };
      try {
        const entry = await invoke<SkipEntry | null>("skip_set", {
          metaId: key,
          entry: merged,
        });
        setMarkers(entry);
        setMarkMsg(`${label} at ${formatTime(at)} saved`);
      } catch (e) {
        setMarkMsg(e instanceof Error ? e.message : String(e));
      }
    },
    [markers, session?.key],
  );

  // Ended episodes advance on their own only when the setting allows it and
  // the card has not been dismissed.
  useEffect(() => {
    if (
      !local?.ended ||
      local.error ||
      !settings?.autoPlayNext ||
      !nextEpisode ||
      advanced.current ||
      nextOff
    ) {
      return;
    }
    advanced.current = true;
    void playVideo(nextEpisode);
  }, [local?.ended, local?.error, settings?.autoPlayNext, nextEpisode, nextOff, playVideo]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      // A slider keeps focus after a drag; it must not swallow the shortcuts.
      const typing =
        target instanceof HTMLElement &&
        (target.isContentEditable ||
          (["INPUT", "SELECT", "TEXTAREA"].includes(target.tagName) &&
            !(target instanceof HTMLInputElement && target.type === "range")));
      if (typing) return;
      const key = event.key;
      if (locked && key !== "Escape") return;
      // A panel owns the keyboard; Escape still closes it.
      if (surface && key !== "Escape") return;
      // Holding a seek or volume key keeps stepping; every other key acts once.
      const seeks = /^(Arrow(Left|Right|Up|Down)|j|J|l|L)$/.test(key);
      if (event.repeat && !seeks) return;
      let handled = true;
      switch (key) {
        case " ":
        case "k":
        case "K":
          // Space on a focused player button is already a click; that path owns it.
          if (key === " " && target instanceof HTMLButtonElement && target.closest(".pv")) break;
          if (event.repeat) break;
          event.preventDefault();
          togglePause();
          break;
        case "ArrowLeft":
        case "ArrowRight":
          event.preventDefault();
          seekRel((key === "ArrowLeft" ? -1 : 1) * (event.shiftKey ? 60 : step));
          break;
        case "j":
        case "J":
          event.preventDefault();
          seekRel(-10);
          break;
        case "l":
        case "L":
          event.preventDefault();
          seekRel(10);
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
          toggleSurface("info");
          break;
        case "?":
          toggleSurface("keys");
          break;
        case "Escape":
          if (locked) {
            setLocked(false);
            setChrome(true);
          } else if (surface) setSurface(null);
          else if (showNext) dismissNext();
          else if (fsNow.current) leaveFullscreen();
          // Escape never ends playback; leaving is the explicit Close.
          else setChrome(false);
          return;
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
    leaveFullscreen,
    locked,
    nextEpisode,
    playVideo,
    seekRel,
    showNext,
    step,
    surface,
    toggleFullscreen,
    toggleMute,
    togglePause,
    toggleSurface,
  ]);

  // Wheel over the picture changes the level, the way a media player does.
  const playing = Boolean(local);
  useEffect(() => {
    if (!playing) return;
    const onWheel = (event: WheelEvent) => {
      // Panels own their scrolling; only the bare picture takes the wheel.
      if (surface || locked) return;
      // One step per gesture beat, or a trackpad floods the engine.
      const at = Date.now();
      if (at - wheelAt.current < 60) return;
      wheelAt.current = at;
      event.preventDefault();
      changeVolume(event.deltaY < 0 ? 5 : -5);
    };
    window.addEventListener("wheel", onWheel, { passive: false });
    return () => window.removeEventListener("wheel", onWheel);
  }, [changeVolume, locked, playing, surface]);

  const loadSubtitleFile = useCallback(async () => {
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
  }, [notify]);

  // Stable handlers keep the memoized panels out of the tick re-render.
  const closeSurface = useCallback(() => setSurface(null), []);
  const refreshSources = useCallback(() => void loadSources(true), [loadSources]);
  const reloadSubs = useCallback(() => void loadSubtitles(true), [loadSubtitles]);
  const resetSubStyle = useCallback(() => setSubStyle(DEFAULT_SUB_STYLE), []);
  const pickEpisode = useCallback(
    (video: Video) => {
      setSurface(null);
      void playVideo(video);
    },
    [playVideo],
  );

  // Panel rows and transport actions, rebuilt only when their inputs move.
  const shortcutRows = useMemo<Array<[string, string]>>(
    () => [
      ["Space / K", "Play and pause"],
      ["← / →", `Seek ${step}s`],
      ["Shift + ← / →", "Seek 60s"],
      ["J / L", "Seek 10s back and ahead"],
      ["↑ / ↓", "Volume up and down"],
      ["M", "Mute"],
      ["S", "Cycle subtitles"],
      ["A", "Cycle audio"],
      ["+ / −", "Speed up and down"],
      ["N", "Next episode"],
      ["I", "Stream info"],
      ["F", "Fullscreen"],
      ["?", "This sheet"],
      ["Esc", "Close a panel, or leave"],
    ],
    [step],
  );

  const playbackRows = useMemo<Array<[string, string]>>(
    () => [
      ["State", local?.ended ? "Ended" : local?.paused ? "Paused" : "Playing"],
      ["Position", `${formatTime(position)} / ${formatTime(duration)}`],
      ["Cached to", formatTime(local?.buffered ?? 0)],
      ["Speed", `${local?.speed ?? 1}×`],
      ["Volume", `${Math.round(local?.volume ?? 0)}%${local?.muted ? " (muted)" : ""}`],
      ["Engine", appInfo?.mpv?.version ?? "mpv"],
    ],
    [
      appInfo?.mpv?.version,
      duration,
      local?.buffered,
      local?.ended,
      local?.muted,
      local?.paused,
      local?.speed,
      local?.volume,
      position,
    ],
  );

  const sourceRows = useMemo<Array<[string, string | null]>>(
    () => [
      ["Stream", playingSource?.title ?? playingSource?.name ?? null],
      ["Quality", playingSource?.quality ?? null],
      ["Size", playingSource?.size ?? null],
    ],
    [playingSource?.title, playingSource?.name, playingSource?.quality, playingSource?.size],
  );

  const audioRows = useMemo<Array<[string, string | null]>>(
    () => [
      ["Track", activeAudio?.label ?? "Default"],
      ["Language", activeAudio?.lang ? langLabel(activeAudio.lang) : null],
      ["Channels and codec", activeAudio?.details ?? null],
      ["Source", activeAudio ? (activeAudio.external ? "Loaded file" : "Built in") : null],
    ],
    [
      activeAudio?.label,
      activeAudio?.lang,
      activeAudio?.details,
      activeAudio?.external,
      Boolean(activeAudio),
    ],
  );

  const subtitleRows = useMemo<Array<[string, string | null]>>(
    () => [
      ["Track", loadedSub ? `${loadedSub.lang} (addon)` : activeSub?.label ?? null],
      ["Language", activeSub?.lang ? langLabel(activeSub.lang) : loadedSub?.lang ?? null],
      [
        "Source",
        loadedSub ? "Addon" : activeSub ? (activeSub.external ? "Loaded file" : "Built in") : null,
      ],
    ],
    [activeSub?.label, activeSub?.lang, activeSub?.external, Boolean(activeSub), loadedSub],
  );

  const actions = useMemo(() => {
    const rows: Array<{
      key: string;
      icon: IconName;
      label: string;
      on: () => void;
    }> = [];
    rows.push({
      key: "info",
      icon: "info",
      label: "Stream info",
      on: () => toggleSurface("info"),
    });
    rows.push({
      key: "speed",
      icon: "speed",
      label: `Speed ${local?.speed ?? 1}×`,
      on: cycleSpeed,
    });
    rows.push({
      key: "subs",
      icon: "subtitle",
      label: "Subtitles",
      on: openSubs,
    });
    rows.push({
      key: "audio",
      icon: "audio",
      label: "Audio",
      on: () => toggleSurface("audio"),
    });
    if (details?.type === "series") {
      rows.push({
        key: "episodes",
        icon: "episodes",
        label: "Episodes",
        on: openEpisodes,
      });
    }
    if (chapters.length > 0) {
      rows.push({
        key: "chapters",
        icon: "chapters",
        label: "Chapters",
        on: () => toggleSurface("chapters"),
      });
    }
    rows.push({
      key: "sources",
      icon: "sources",
      label: "Sources",
      on: () => {
        toggleSurface("sources");
        void loadSources();
      },
    });
    rows.push({
      key: "mode",
      icon: "aspect",
      label: mode.label,
      on: cycleVideoMode,
    });
    rows.push({
      key: "more",
      icon: "more",
      label: "More actions",
      on: () => toggleSurface("more"),
    });
    return rows;
  }, [
    chapters.length,
    cycleSpeed,
    cycleVideoMode,
    details?.type,
    loadSources,
    local?.speed,
    mode.label,
    openEpisodes,
    openSubs,
    toggleSurface,
  ]);

  if (!local) {
    // Clicked play: the screen opens at once and the source resolves behind it.
    if (starting) {
      return (
        <div className="pv pv--awake">
          <div className="pv-wait">
            {starting.background ? (
              <img className="pv-wait-bg" src={starting.background} alt="" draggable={false} />
            ) : null}
            {starting.logo ? (
              <img className="pv-pulse" src={starting.logo} alt="" draggable={false} />
            ) : (
              <h1 className="pv-wait-title">{starting.name}</h1>
            )}
            {starting.sub ? <p className="pv-wait-label">{starting.sub}</p> : null}
            <p className="pv-hint">Finding a source…</p>
            <button type="button" className="btn btn-ghost" onClick={cancelStart}>
              Back
            </button>
          </div>
        </div>
      );
    }
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
  // mpv reports the cache relative to the playhead; the bar wants where it ends.
  const bufferedPercent = bufferPercent(position, local.buffered ?? 0, duration);
  const title = session?.name ?? local.title;
  const artLogo = details?.logo ?? rememberedLogo(session?.metaId) ?? null;
  const artBackground =
    details?.background ?? session?.background ?? session?.poster ?? null;
  const nextThumb = thumbBroken ? null : nextEpisode?.thumbnail ?? null;
  const activeLang = activeSub ? langLabel(activeSub.lang, activeSub.label) : loadedSub?.lang ?? null;
  const currentLang = selectedLang === OFF ? null : selectedLang ?? activeLang ?? null;
  const currentVariants = subGroups.find((group) => group.lang === currentLang)?.variants ?? NO_VARIANTS;
  const offSelected =
    selectedLang === OFF || (selectedLang === null && !activeSub && !loadedSub);
  // Styling is a player-wide preference: it must not wait for a track to be
  // matched to a variant, or the panel vanishes on the first tick after a load.
  const styleOn = Boolean(activeSub || loadedSub);
  const volumeFill = Math.min(100, Math.max(0, (volLevel / MAX_VOLUME) * 100));

  const chapterIndex = chapters.reduce(
    (found, chapter, at) => (chapter.start <= shownPosition + 0.25 ? at : found),
    -1,
  );

  const sourceTitle = playingSource
    ? playingSource.name ?? playingSource.addon ?? "Source"
    : null;

  const cycleLock = () => {
    setLocked((current) => !current);
    setChrome(true);
  };

  return (
    <div
      ref={rootRef}
      className={`pv${chrome ? " pv--awake" : ""}${failed ? " pv--failed" : ""}${locked ? " pv--locked" : ""}${surface ? " pv--panel" : ""}`}
      onPointerMove={bump}
      onFocusCapture={() => {
        if (!locked) setChrome(true);
      }}
      onClick={(event) => {
        if (locked) return;
        const target = event.target as Element;
        // A control owns its own click; the rest of the frame is the video.
        if (target.closest("button, input, [role='slider'], a")) return;
        if (surface) return;
        if (!chrome) {
          bump();
          return;
        }
        togglePause();
      }}
    >
      <div className="pv-shade" aria-hidden="true" />

      {/* The player covers the titlebar; this is the window's handle while windowed. */}
      {!fullscreen ? <div className="pv-drag" data-tauri-drag-region aria-hidden="true" /> : null}

      {!locked ? (
        <header className="pv-top">
          <button
            type="button"
            className="pv-top-btn pv-top-back"
            onClick={() => void stop()}
            aria-label="Close player"
            title="Close player"
          >
            <Icon name="back" size={26} />
          </button>
          <div className="pv-top-text">
            <h2 className="pv-top-title" title={title}>
              {title}
            </h2>
            {session?.season != null ? (
              <p className="pv-top-sub">
                {episodeCode({ season: session.season, episode: session.episode })}
                {session.episodeTitle ? ` · ${session.episodeTitle}` : ""}
              </p>
            ) : null}
          </div>
          <div className="pv-top-right">
            <button
              type="button"
              className="pv-top-btn"
              onClick={() => void toggleFullscreen()}
              aria-label={fullscreen ? "Exit fullscreen" : "Fullscreen"}
              title={fullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              <Icon name={fullscreen ? "compress" : "expand"} size={24} />
            </button>
            <button
              type="button"
              className="pv-top-btn"
              onClick={cycleLock}
              aria-label="Lock controls"
              title="Lock controls"
            >
              <Icon name="lock" size={24} />
            </button>
          </div>
        </header>
      ) : null}

      {failed ? (
        <section className="pv-next pv-next--failed" role="alert" aria-live="assertive">
          <button
            type="button"
            className="pv-icon pv-failed-close"
            onClick={() => void stop()}
            aria-label="Close player"
            title="Close player"
          >
            <Icon name="x" size={16} />
          </button>
          <p className="pv-failed-title" title={title}>
            {title}
          </p>
          <p className="pv-next-label">Playback stopped</p>
          <h2>This source did not play.</h2>
          <p className="pv-failed-body">
            {failed} Check the source or pick another one from the title page.
          </p>
          <div className="pv-next-actions">
            <button type="button" className="btn btn-primary" onClick={() => void stop()}>
              {session ? "Choose another source" : "Back to home"}
            </button>
          </div>
        </section>
      ) : null}

      {loading ? (
        <div className="pv-wait">
          {artBackground ? (
            <img className="pv-wait-bg" src={artBackground} alt="" draggable={false} />
          ) : null}
          {artLogo ? (
            <img className="pv-pulse" src={artLogo} alt="" draggable={false} />
          ) : (
            <h1 className="pv-wait-title">{title}</h1>
          )}
        </div>
      ) : null}

      {locked && !failed ? (
        <div
          className="pv-locked-layer"
          onClick={() => {
            setLocked(false);
            setChrome(true);
          }}
        >
          <button
            type="button"
            className="pv-locked-btn"
            onClick={() => {
              setLocked(false);
              setChrome(true);
            }}
            aria-label="Unlock controls"
          >
            <Icon name="lock" size={30} />
          </button>
          <p className="pv-locked-hint">Tap to unlock</p>
          <div className="pv-locked-progress" aria-hidden="true">
            <span style={{ width: `${percent}%` }} />
          </div>
          <div className="pv-locked-times">
            <span>{formatTime(shownPosition)}</span>
            <span>{formatTime(duration)}</span>
          </div>
        </div>
      ) : null}

      {surface !== null && !locked ? (
        <>
          {surface === "audio" ? (
            <Overlay label="Audio tracks" onClose={closeSurface}>
              {audioTracks.length === 0 ? (
                <p className="pv-overlay-empty">No audio tracks available.</p>
              ) : (
                <div className="pv-rail-list" role="listbox" aria-label="Audio tracks">
                  {audioTracks.map((track) => {
                    const on = local.activeAudio === track.id;
                    return (
                      <button
                        key={track.id}
                        type="button"
                        role="option"
                        aria-selected={on}
                        className={`pv-rail-row${on ? " is-on" : ""}`}
                        onClick={() => send("audio", track.id)}
                      >
                        <span className="pv-rail-row-text">
                          <span className="pv-rail-row-title">{track.label}</span>
                          <span className="pv-rail-row-meta">
                            {track.details ?? (track.external ? "Loaded file" : "Built in")}
                          </span>
                        </span>
                        {on ? <Icon name="check" size={20} /> : null}
                      </button>
                    );
                  })}
                </div>
              )}
            </Overlay>
          ) : null}

          {surface === "subs" ? (
            <SubtitlesPanel
              subs={subs}
              groups={subGroups}
              offSelected={offSelected}
              currentLang={currentLang}
              currentVariants={currentVariants}
              styleOn={styleOn}
              activeSub={local.activeSub ?? null}
              loadedSub={loadedSub}
              subStyle={subStyle}
              onLang={setSelectedLang}
              onChoose={chooseSub}
              onOff={turnSubsOff}
              onReload={reloadSubs}
              onLoadFile={loadSubtitleFile}
              onPatch={patchSubStyle}
              onNudge={nudgeDelay}
              onReset={resetSubStyle}
              onClose={closeSurface}
            />
          ) : null}

          {surface === "info" ? (
            <Overlay label="Stream info" onClose={closeSurface}>
              <div className="pv-info">
                <section>
                  <h3>Source</h3>
                  <p className="pv-info-lead">
                    {playingSource?.addon ?? "Source"}
                    {sourceTitle ? <span>{sourceTitle}</span> : null}
                  </p>
                  {playingSource?.description ? (
                    <p className="pv-info-note">{playingSource.description.replace(/\n/g, " · ")}</p>
                  ) : null}
                  <dl>
                    {sourceRows.map(([label, value]) =>
                      value ? (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                </section>

                <section>
                  <h3>Audio</h3>
                  <dl>
                    {audioRows.map(([label, value]) =>
                      value ? (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                </section>

                <section>
                  <h3>Subtitles</h3>
                  <dl>
                    {subtitleRows.map(([label, value]) =>
                      value ? (
                        <div key={label}>
                          <dt>{label}</dt>
                          <dd>{value}</dd>
                        </div>
                      ) : null,
                    )}
                  </dl>
                </section>

                <section>
                  <h3>Playback</h3>
                  <dl>
                    {playbackRows.map(([label, value]) => (
                      <div key={label}>
                        <dt>{label}</dt>
                        <dd>{value}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              </div>
            </Overlay>
          ) : null}

          {surface === "chapters" ? (
            <SidePanel
              label="Chapters"
              title={`Chapters (${chapters.length})`}
              onClose={closeSurface}
            >
              <div className="pv-side-list">
                {chapters.map((chapter, at) => {
                  const on = at === chapterIndex;
                  return (
                    <button
                      key={`${chapter.start}-${at}`}
                      type="button"
                      className={`pv-chapter-row${on ? " is-on" : ""}`}
                      onClick={() => seekTo(chapter.start)}
                    >
                      <span className="pv-chapter-mark">
                        {on ? <Icon name="play" size={16} /> : at + 1}
                      </span>
                      <span className="pv-chapter-text">
                        <span className="pv-chapter-name">
                          {chapter.title?.trim() || `Chapter ${at + 1}`}
                        </span>
                        {on ? (
                          <span className="pv-chapter-progress" aria-hidden="true">
                            <span
                              style={{
                                width: `${
                                  duration > chapter.start
                                    ? Math.min(
                                        100,
                                        ((shownPosition - chapter.start) /
                                          (duration - chapter.start)) *
                                          100,
                                      )
                                    : 0
                                }%`,
                              }}
                            />
                          </span>
                        ) : null}
                      </span>
                      <span className="pv-chapter-time">{formatTime(chapter.start)}</span>
                    </button>
                  );
                })}
              </div>
            </SidePanel>
          ) : null}

          {surface === "sources" ? (
            <SourcesPanel
              heading={
                session?.season != null
                  ? `${episodeCode({ season: session.season, episode: session.episode })}${
                      session.episodeTitle ? ` · ${session.episodeTitle}` : ""
                    }`
                  : title
              }
              sources={sources}
              visibleSources={visibleSources}
              addonNames={addonNames}
              sourceBusy={sourceBusy}
              sourceFilter={sourceFilter}
              playingSource={playingSource}
              onFilter={setSourceFilter}
              onRefresh={refreshSources}
              onPick={switchSource}
              onClose={closeSurface}
            />
          ) : null}

          {surface === "episodes" ? (
            <EpisodesPanel
              queue={queue}
              season={season}
              currentSeason={session?.season ?? null}
              currentEpisode={session?.episode ?? null}
              metaId={session?.metaId ?? ""}
              progress={progressByKey}
              busy={busy}
              onSeason={setSeason}
              onPick={pickEpisode}
              onClose={closeSurface}
            />
          ) : null}

          {surface === "keys" ? (
            <Overlay label="Keyboard shortcuts" onClose={closeSurface}>
              <div className="pv-keys">
                {shortcutRows.map(([keys, what]) => (
                  <p key={keys}>
                    <kbd>{keys}</kbd>
                    <span>{what}</span>
                  </p>
                ))}
              </div>
            </Overlay>
          ) : null}

          {surface === "more" ? (
            <Overlay label="Playback options" onClose={closeSurface}>
              <div className="pv-rail-list pv-rail-list--menu">
                <button
                  type="button"
                  className="pv-rail-row"
                  onClick={() => setSurface("info")}
                >
                  <span className="pv-rail-row-text">
                    <span className="pv-rail-row-title">Stream info</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="pv-rail-row"
                  onClick={() => setSurface("keys")}
                >
                  <span className="pv-rail-row-text">
                    <span className="pv-rail-row-title">Keyboard shortcuts</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="pv-rail-row"
                  onClick={() => void loadSubtitleFile()}
                >
                  <span className="pv-rail-row-text">
                    <span className="pv-rail-row-title">Load subtitle file</span>
                  </span>
                </button>
              </div>
              <div className="pv-more-marks">
                <p className="pv-section-label">Skip intro markers for this episode</p>
                <div className="pv-row">
                  <button
                    type="button"
                    className="pv-text-action"
                    onClick={() => void saveMarker({ introStart: posRef.current }, "Intro start")}
                  >
                    Set start here
                  </button>
                  <button
                    type="button"
                    className="pv-text-action"
                    onClick={() => void saveMarker({ introEnd: posRef.current }, "Intro end")}
                  >
                    Set end here
                  </button>
                </div>
                {markMsg ? <p className="pv-hint">{markMsg}</p> : null}
              </div>
            </Overlay>
          ) : null}
        </>
      ) : null}

      {showNext && nextEpisode ? (
        <section className="pv-upnext" aria-label="Next episode">
          <div className="pv-upnext-poster">
            {nextThumb ? (
              <img
                className="pv-upnext-thumb"
                src={nextThumb}
                alt=""
                loading="lazy"
                decoding="async"
                onError={() => setThumbBroken(true)}
              />
            ) : (
              <span className="pv-upnext-blank" aria-hidden="true">
                <Icon name="episodes" size={36} />
              </span>
            )}
          </div>
          <div className="pv-upnext-info">
            <div className="pv-upnext-copy">
              <p className="pv-upnext-label">Up next</p>
              <p className="pv-upnext-name">
                {episodeCode(nextEpisode)} · {nextEpisode.title || "Next episode"}
              </p>
              <p className="pv-upnext-meta">
                {nextAutoPlay
                  ? local.ended
                    ? "Starting now"
                    : `Starting in ${nextCountdown}s`
                  : "Ready when you are"}
              </p>
            </div>
            <div className="pv-upnext-actions">
              <button
                type="button"
                className="pv-upnext-btn"
                onClick={dismissNext}
              >
                <Icon name="x" size={20} />
                Dismiss
              </button>
              <button
                type="button"
                className="pv-upnext-btn pv-upnext-btn--play"
                disabled={busy}
                onClick={() => void playVideo(nextEpisode)}
              >
                <Icon name="play" size={20} />
                {busy ? "Loading" : "Watch now"}
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {local.ended && !nextEpisode && !failed ? (
        <section className="pv-upnext pv-upnext--end">
          <div className="pv-upnext-info">
            <div className="pv-upnext-copy">
              <p className="pv-upnext-label">End</p>
              <p className="pv-upnext-name">Nothing queued after this one.</p>
            </div>
            <div className="pv-upnext-actions">
              <button type="button" className="pv-upnext-btn" onClick={() => void stop()}>
                Close
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {!locked ? (
        <footer className="pv-timeline">
          <div className="pv-seek">
            <span className="pv-seek-time">{formatTime(shownPosition)}</span>

            <SeekTrack
              duration={duration}
              shownPosition={shownPosition}
              percent={percent}
              bufferedPercent={bufferedPercent}
              step={step}
              resetKey={session?.key}
              dragging={dragging}
              frameCache={frameCache}
              frameBucket={frameBucket}
              onSeek={seekTo}
              onSeekRel={seekRel}
              onScrub={holdScrub}
              onBump={bump}
            />

            <button
              type="button"
              className="pv-seek-time pv-seek-time--end"
              onClick={() => setShowRemaining((current) => !current)}
              aria-label={showRemaining ? "Show total length" : "Show time remaining"}
              title={showRemaining ? "Total length" : "Time remaining"}
            >
              {showRemaining ? `−${formatTime(remaining)}` : formatTime(duration)}
            </button>
          </div>

          <div className="pv-controls">
            <button
              type="button"
              className="pv-cbtn"
              aria-label={paused ? "Play" : "Pause"}
              title={paused ? "Play" : "Pause"}
              onClick={togglePause}
            >
              <Icon name={paused ? "play" : "pause"} size={26} />
            </button>
            {nextEpisode ? (
              <button
                type="button"
                className="pv-cbtn"
                aria-label="Next episode"
                title="Next episode"
                disabled={busy}
                onClick={() => void playVideo(nextEpisode)}
              >
                <Icon name="next" size={26} />
              </button>
            ) : null}
            <button
              type="button"
              className="pv-cbtn"
              aria-label={silent ? "Unmute" : "Mute"}
              title={silent ? "Unmute" : "Mute"}
              onClick={toggleMute}
            >
              <Icon name={silent ? "mute" : "volume"} size={26} />
            </button>
            <div className="pv-vslider">
              <input
                type="range"
                min={0}
                max={MAX_VOLUME}
                value={volLevel}
                aria-label="Volume"
                style={{
                  backgroundImage: `linear-gradient(to right, #fff ${volumeFill}%, rgba(255, 255, 255, 0.2) ${volumeFill}%)`,
                }}
                onChange={(event) => setVolume(Number(event.target.value))}
              />
            </div>

            <div className="pv-spacer" />

            <div
              className={`pv-cluster${btnMenu ? " is-open" : ""}`}
              onClick={() => setBtnMenu(false)}
            >
              {actions.map((action) => (
                <button
                  key={action.key}
                  type="button"
                  className={`pv-cbtn${surface === action.key ? " is-on" : ""}`}
                  aria-label={action.label}
                  title={action.label}
                  aria-expanded={surface === action.key ? true : undefined}
                  onClick={action.on}
                >
                  <Icon name={action.icon} size={24} />
                </button>
              ))}
            </div>

            <button
              type="button"
              className="pv-cbtn pv-cbtn--fold"
              aria-label="More actions"
              title="More actions"
              aria-expanded={btnMenu}
              onClick={() => {
                setBtnMenu((current) => !current);
                bump();
              }}
            >
              <Icon name="more" size={24} />
            </button>
          </div>
        </footer>
      ) : null}

      {hud ? (
        <div className={`pv-indicator${hud.out ? " is-out" : ""}`} role="status" aria-live="polite">
          {hud.label} {hud.value}
        </div>
      ) : null}

      {volOsd && !locked ? (
        <div className="pv-volosd" aria-hidden="true">
          <Icon name={silent ? "mute" : "volume"} size={72} />
          <span className="pv-volosd-bar">
            <span style={{ width: `${volumeFill}%` }} />
          </span>
        </div>
      ) : null}
    </div>
  );
}
