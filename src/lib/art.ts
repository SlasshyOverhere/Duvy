/* Title logo art, cached by meta id so the player can show it on the first
   frame instead of waiting for a metadata round trip. */

const ART_KEY = "duvy:logos";
const ART_LIMIT = 300;

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
  if (!metaId || !logo) return;
  const all = readArt();
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
    if (!entry.id || !entry.logo) continue;
    all[entry.id] = entry.logo;
    changed = true;
  }
  if (changed) writeArt(all);
}

export function rememberedLogo(metaId: string | null | undefined): string | null {
  if (!metaId) return null;
  return readArt()[metaId] ?? null;
}
