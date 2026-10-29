/**
 * What a crash report may carry, and how often.
 *
 * Kept free of the Sentry SDK (and of `import.meta`) so the same rules can be
 * checked from a plain script: see scripts/telemetry.check.ts.
 */

/** Keys that only ever hold a credential, or geography nobody needs to ship. */
const SECRET_KEY =
  /token|secret|password|authorization|cookie|api[-_]?key|info[-_]?hash|magnet|timezone|culture/i;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/gi;
const MAGNET_IN_TEXT = /magnet:\?[^\s"'<>]+/gi;
const HOME_IN_TEXT = /[A-Za-z]:\\Users\\[^\\\s"']+/g;

/** Nothing useful ever hides past this; it only inflates the event. */
const MAX_TEXT = 500;
const MAX_DEPTH = 6;
const MAX_ITEMS = 50;

/**
 * Drop the query string and fragment, which is where debrid, Trakt and
 * torrent-tracker credentials ride, and the account name in a local path.
 */
export function cleanText(text: string): string {
  return text
    .replace(URL_IN_TEXT, (url) => {
      try {
        const parsed = new URL(url);
        return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
      } catch {
        return "[url]";
      }
    })
    .replace(MAGNET_IN_TEXT, "magnet:?[redacted]")
    .replace(HOME_IN_TEXT, "[home]")
    .slice(0, MAX_TEXT);
}

/** Clean every string an event carries, and blank the keys that are secrets. */
export function scrubValue(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return "[deep]";
  if (typeof value === "string") return cleanText(value);
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ITEMS).map((item) => scrubValue(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const clean: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_ITEMS)) {
      clean[key] = SECRET_KEY.test(key) ? "[redacted]" : scrubValue(item, depth + 1);
    }
    return clean;
  }
  return value;
}

/** A failure the app can do nothing about, so it is never worth a report. */
const NOISE = [
  /ResizeObserver loop/i,
  /AbortError|The operation was aborted|signal is aborted/i,
  /^Script error\.?$/i,
];

export function isNoise(message: string): boolean {
  return NOISE.some((pattern) => pattern.test(message));
}

/** One report per distinct failure, and a hard cap for the session. */
const seen = new Set<string>();
const MAX_REPORTS = 30;

export function fingerprintOf(error: unknown): string {
  if (error instanceof Error) {
    const frame = (error.stack ?? "").split("\n")[1] ?? "";
    return `${error.name}: ${error.message} @ ${frame.trim()}`.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

export function shouldReport(fingerprint: string): boolean {
  if (seen.has(fingerprint)) return false;
  // A session that floods the cap has lost the point of the cap.
  if (seen.size >= MAX_REPORTS) return false;
  seen.add(fingerprint);
  return true;
}
