import { useEffect, useRef } from "react";
import type { StreamOption, SubtitleTrack, Track } from "../../lib/types";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
// How much of the file counts as the ending when there is no credits marker.
export const NEXT_LEAD = 45;
export const SUB_STYLE_KEY = "duvy.subtitleStyle";
export const VIDEO_MODE_KEY = "duvy.videoMode";
export const VOLUME_KEY = "duvy.volume";
export const MAX_VOLUME = 200;
export const OFF = "__off__";
export const SUB_COLORS = [
  { value: "#ffffff", label: "White" },
  { value: "#f1e2c6", label: "Warm white" },
  { value: "#ffd84d", label: "Yellow" },
  { value: "#8fd8ff", label: "Sky blue" },
  { value: "#7dffc4", label: "Mint" },
  { value: "#ff8d8d", label: "Red" },
  { value: "#c9a7ff", label: "Lavender" },
  { value: "#ffb066", label: "Orange" },
];
export const OUTLINE_COLORS = [
  { value: "#000000", label: "Black" },
  { value: "#ffffff", label: "White" },
  { value: "#8fd8ff", label: "Sky blue" },
  { value: "#ff8d8d", label: "Red" },
];

/** How the picture sits in the window, in the order the button cycles them. */
export const VIDEO_MODES = [
  { id: "fit", label: "Fit", hint: "Whole picture, bars where the shape differs" },
  { id: "fill", label: "Fill", hint: "Crop the edges until the picture fills the window" },
  { id: "stretch", label: "Stretch", hint: "Stretch to the window, nothing cropped" },
] as const;
export type VideoMode = (typeof VIDEO_MODES)[number]["id"];

export type Surface =
  | "audio"
  | "subs"
  | "chapters"
  | "sources"
  | "episodes"
  | "info"
  | "keys"
  | "more"
  | null;

export interface SubtitleStyle {
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

export interface Hud {
  label: string;
  value: string;
  out: boolean;
}

export const DEFAULT_SUB_STYLE: SubtitleStyle = {
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
export function customStyle(style: SubtitleStyle): boolean {
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
export const NO_VARIANTS: SubVariant[] = [];

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

export function langLabel(lang?: string | null, fallback?: string | null): string {
  const raw = (lang ?? "").trim();
  if (!raw) {
    const spare = (fallback ?? "").trim();
    return spare || "Unknown";
  }
  const key = raw.toLowerCase().split(/[-_]/)[0];
  if (LANG_NAMES[key]) return LANG_NAMES[key];
  return raw.length <= 3 ? raw.toUpperCase() : raw;
}

export function readVideoMode(): VideoMode {
  const stored = window.localStorage.getItem(VIDEO_MODE_KEY);
  return VIDEO_MODES.some((mode) => mode.id === stored) ? (stored as VideoMode) : "fit";
}

export function readVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw == null || raw.trim() === "") return 100;
    return whole(raw, 0, MAX_VOLUME, 100);
  } catch {
    return 100;
  }
}

export interface SubVariant {
  key: string;
  label: string;
  source: string;
  lang: string;
  trackId?: number;
  url?: string;
}

export interface SubGroup {
  lang: string;
  variants: SubVariant[];
}

/** Embedded tracks and addon results, folded into one language-first list. */
export function groupSubtitles(tracks: Track[], addons: SubtitleTrack[] | null): SubGroup[] {
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

export function whole(value: unknown, min: number, max: number, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function tenths(value: unknown, fallback: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(MAX_DELAY, Math.max(-MAX_DELAY, Math.round(number * 10) / 10));
}

/** mpv takes #AARRGGBB, so the 0-100 box opacity becomes the alpha byte. */
export function mpvBackground(percent: number): string {
  const alpha = Math.round((Math.min(100, Math.max(0, percent)) / 100) * 255);
  return `#${alpha.toString(16).padStart(2, "0")}000000`;
}

export function mpvColor(color: string, opacity: number): string {
  const alpha = Math.round((Math.min(100, Math.max(0, opacity)) / 100) * 255);
  const rgb = color.replace("#", "").slice(0, 6).padStart(6, "0");
  return `#${alpha.toString(16).padStart(2, "0")}${rgb}`;
}

export function delayLabel(delay: number): string {
  if (delay === 0) return "0.0s";
  return `${delay > 0 ? "+" : "−"}${Math.abs(delay).toFixed(1)}s`;
}

export function readSubtitleStyle(): SubtitleStyle {
  try {
    const raw = window.localStorage.getItem(SUB_STYLE_KEY);
    if (!raw) return DEFAULT_SUB_STYLE;
    const stored = JSON.parse(raw) as Partial<SubtitleStyle> | null;
    if (!stored || typeof stored !== "object") return DEFAULT_SUB_STYLE;
    return {
      size: whole(stored.size, 10, 90, DEFAULT_SUB_STYLE.size),
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

export function sameSource(a: StreamOption | null, b: StreamOption): boolean {
  if (!a) return false;
  return (
    a.addon === b.addon &&
    (a.url ?? "") === (b.url ?? "") &&
    (a.infoHash ?? "") === (b.infoHash ?? "") &&
    (a.fileIdx ?? -1) === (b.fileIdx ?? -1)
  );
}

/** The torrent address behind the source that is playing, when it has one. */
export function magnetFor(stream: StreamOption | null): string | null {
  if (!stream) return null;
  const raw = stream.url ?? "";
  if (/^magnet:/i.test(raw)) return raw;
  if (!stream.infoHash) return null;
  return `magnet:?xt=urn:btih:${stream.infoHash}${stream.fileIdx != null ? `&fileIdx=${stream.fileIdx}` : ""}`;
}

/** Hands focus back to the control that opened a dialog when it goes away. */
export function useReturnFocus() {
  // Read during render: autofocus has already moved focus by effect time.
  const previous = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(
    () => () => {
      // Another panel replaced this one and already holds focus.
      if (document.activeElement?.closest("[role='dialog']")) return;
      if (previous.current?.isConnected) previous.current.focus();
    },
    [],
  );
}

/** Floating panel anchored bottom-right, above the transport. */
