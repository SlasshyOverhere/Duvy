import { useEffect, useRef } from "react";
import type { StreamOption, SubtitleTrack, Track } from "../../lib/types";

export const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];
// How much of the file counts as the ending when there is no credits marker.
export const NEXT_LEAD = 45;
// Settle time before the next-episode card slides in, in seconds.
export const NEXT_DELAY = 1.5;
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
  pa: "Punjabi", pan: "Punjabi", pun: "Punjabi", ur: "Urdu", ar: "Arabic", ara: "Arabic",
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
  af: "Afrikaans", afr: "Afrikaans", sq: "Albanian", sqi: "Albanian", alb: "Albanian",
  am: "Amharic", amh: "Amharic", hy: "Armenian", hye: "Armenian", arm: "Armenian",
  az: "Azerbaijani", aze: "Azerbaijani", be: "Belarusian", bel: "Belarusian",
  bs: "Bosnian", bos: "Bosnian", bg: "Bulgarian", bul: "Bulgarian",
  ca: "Catalan", cat: "Catalan", ceb: "Cebuano",
  hr: "Croatian", hrv: "Croatian", et: "Estonian", est: "Estonian",
  gl: "Galician", glg: "Galician", ka: "Georgian", kat: "Georgian", geo: "Georgian",
  gu: "Gujarati", guj: "Gujarati", ht: "Haitian", hat: "Haitian",
  ha: "Hausa", hau: "Hausa", haw: "Hawaiian",
  is: "Icelandic", isl: "Icelandic", ice: "Icelandic", ig: "Igbo", ibo: "Igbo",
  jw: "Javanese", jav: "Javanese", kk: "Kazakh", kaz: "Kazakh",
  km: "Khmer", khm: "Khmer", rw: "Kinyarwanda", kin: "Kinyarwanda",
  ky: "Kyrgyz", kir: "Kyrgyz", lo: "Lao", lao: "Lao", la: "Latin", lat: "Latin",
  lv: "Latvian", lav: "Latvian", lt: "Lithuanian", lit: "Lithuanian",
  lb: "Luxembourgish", ltz: "Luxembourgish", mk: "Macedonian", mkd: "Macedonian", mac: "Macedonian",
  mg: "Malagasy", mlg: "Malagasy", ny: "Chichewa", nya: "Chichewa",
  ne: "Nepali", nep: "Nepali", or: "Odia", ori: "Odia", ps: "Pashto", pus: "Pashto",
  sm: "Samoan", smo: "Samoan", gd: "Scots Gaelic", gla: "Scots Gaelic",
  sr: "Serbian", srp: "Serbian", st: "Sesotho", sot: "Sesotho",
  sn: "Shona", sna: "Shona", sd: "Sindhi", snd: "Sindhi", si: "Sinhala", sin: "Sinhala",
  so: "Somali", som: "Somali", su: "Sundanese", sun: "Sundanese",
  sw: "Swahili", swa: "Swahili", tg: "Tajik", tgk: "Tajik", tt: "Tatar", tat: "Tatar",
  tk: "Turkmen", tuk: "Turkmen", ug: "Uyghur", uig: "Uyghur",
  uz: "Uzbek", uzb: "Uzbek", cy: "Welsh", cym: "Welsh", xh: "Xhosa", xho: "Xhosa",
  yi: "Yiddish", yid: "Yiddish", yo: "Yoruba", yor: "Yoruba", zu: "Zulu", zul: "Zulu",
  my: "Burmese", mya: "Burmese", bur: "Burmese",
};

for (const name of new Set(Object.values(LANG_NAMES))) {
  LANG_NAMES[name.toLowerCase()] = name;
}

const LANG_ALIASES = Object.keys(LANG_NAMES).sort((a, b) => b.length - a.length);
const LANG_BREAK = /[\s()\[\-_·|/.,]/;
const QUALIFIER_TAIL = /\s+(?:sdh|cc|hi|hearing impaired|forced|foreign|commentary|director'?s commentary|dubbed|subbed|full|signs?|songs?|karaoke)$/i;

function knownLanguage(value: string): string | null {
  const key = value.trim().toLowerCase();
  if (!key) return null;
  if (LANG_NAMES[key]) return LANG_NAMES[key];
  for (const alias of LANG_ALIASES) {
    if (!key.startsWith(alias)) continue;
    const next = key.charAt(alias.length);
    if (!next || LANG_BREAK.test(next)) return LANG_NAMES[alias] ?? null;
  }
  return null;
}

function qualifierBase(value: string): string | null {
  const raw = value.trim();
  let base = raw.replace(/\s+[-–—|:·/]\s*.+$/, "").trim();
  base = base.replace(/\s*[\(\[\{][^)\]}]*[)\]\}]\s*$/, "").trim();
  base = base.replace(QUALIFIER_TAIL, "").trim();
  return base && base !== raw ? base : null;
}

/** Base language for grouping; qualifiers such as SDH stay in the variant label. */
export function langLabel(lang?: string | null, fallback?: string | null): string {
  const raw = (lang ?? "").trim() || (fallback ?? "").trim();
  if (!raw) return "Unknown";
  return knownLanguage(raw) ?? qualifierBase(raw) ?? (raw.length <= 3 ? raw.toUpperCase() : raw);
}

/** Full picker label; addon labels and qualifiers survive. */
export function subtitleLabel(lang?: string | null, fallback?: string | null): string {
  const raw = (lang ?? "").trim() || (fallback ?? "").trim();
  if (!raw) return "Subtitle";
  const exact = LANG_NAMES[raw.toLowerCase()];
  if (exact) return exact;
  const region = /^([a-z]{2,3})[-_][a-z0-9]{2,8}$/i.exec(raw);
  if (region) return LANG_NAMES[region[1].toLowerCase()] ?? raw.toUpperCase();
  return raw.length <= 3 ? raw.toUpperCase() : raw;
}

function addonLabel(label?: string | null): string | null {
  const value = (label ?? "").trim();
  return value && !value.toLowerCase().startsWith("http") ? value : null;
}

export function readVideoMode(): VideoMode {
  try {
    const stored = window.localStorage.getItem(VIDEO_MODE_KEY);
    return VIDEO_MODES.some((mode) => mode.id === stored) ? (stored as VideoMode) : "fit";
  } catch {
    return "fit";
  }
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

/** The addon row stands in for the external track it loaded. */
export function withoutLoadedAddon(tracks: Track[], label?: string | null): Track[] {
  const wanted = (label ?? "").trim().toLowerCase();
  if (!wanted) return tracks;
  return tracks.filter((track) => {
    if (!track.external) return true;
    const have = track.label.trim().toLowerCase();
    return have !== wanted && !have.endsWith(`(${wanted})`);
  });
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
      label: track.label || subtitleLabel(track.lang, track.label),
      source: track.external ? "Loaded file" : "Built in",
      lang: langLabel(track.lang, track.label),
      trackId: track.id,
    });
  }
  for (const sub of addons ?? []) {
    add({
      // A separator no id or URL can contain, so two results cannot collide.
      key: `a${sub.id}\u0000${sub.url}`,
      label: addonLabel(sub.label) ?? subtitleLabel(sub.lang, sub.label),
      source: sub.addon,
      lang: langLabel(sub.lang, sub.label),
      url: sub.url,
    });
  }
  return [...groups.values()];
}

export function whole(value: unknown, min: number, max: number, fallback: number): number {
  if (value == null || value === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

export function tenths(value: unknown, fallback: number): number {
  if (value == null || value === "") return fallback;
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
  const level = Number.isFinite(opacity) ? opacity : 100;
  const alpha = Math.round((Math.min(100, Math.max(0, level)) / 100) * 255);
  const rgb = /^#?([0-9a-f]{6})$/i.exec(color)?.[1] ?? "ffffff";
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
