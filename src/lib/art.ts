/* Title logo art, cached by meta id so the player can show it on the first
   frame instead of waiting for a metadata round trip. */

const ART_KEY = "duvy:logos";
const ART_LIMIT = 300;

/** Remote art is only ever an image URL; anything else is dropped on the way in. */
function usableLogo(logo: string | null | undefined): logo is string {
  if (!logo) return false;
  return /^(https?:\/\/|data:image\/)/i.test(logo);
}

function readArt(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(ART_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === "object" ? (parsed as Record<string, string>) : {};
  } catch {
    return {};
  }
}

function writeArt(all: Record<string, string>) {
  try {
    const keys = Object.keys(all);
    for (const stale of keys.slice(0, Math.max(0, keys.length - ART_LIMIT))) delete all[stale];
    window.localStorage.setItem(ART_KEY, JSON.stringify(all));
  } catch {
    // Storage can be blocked; the player falls back to the title text.
  }
}

export function rememberLogo(metaId: string | null | undefined, logo: string | null | undefined) {
  if (!metaId || !usableLogo(logo)) return;
  const all = readArt();
  if (all[metaId] === logo) return;
  all[metaId] = logo;
  writeArt(all);
}

/** One read and one write for a whole feed instead of one per card. */
export function rememberLogos(
  entries: Array<{ id: string | null | undefined; logo: string | null | undefined }>,
): void {
  const all = readArt();
  let changed = false;
  for (const entry of entries) {
    if (!entry.id || !usableLogo(entry.logo)) continue;
    if (all[entry.id] === entry.logo) continue;
    all[entry.id] = entry.logo;
    changed = true;
  }
  if (changed) writeArt(all);
}

export function rememberedLogo(metaId: string | null | undefined): string | null {
  if (!metaId) return null;
  const hit: unknown = readArt()[metaId];
  return typeof hit === "string" && usableLogo(hit) ? hit : null;
}
