/**
 * What a crash report may carry, and how often.
 *
 * Kept free of the Sentry SDK (and of `import.meta`) so the same rules can be
 * checked from a plain script: see scripts/telemetry.check.ts.
 */

/** Keys that only ever hold a credential, an identity, or geography nobody needs. */
const SECRET_KEY =
  /token|secret|password|authorization|cookie|api[-_]?key|info[-_]?hash|magnet|timezone|culture|e-?mail|user-?name/i;

const URL_IN_TEXT = /https?:\/\/[^\s"'<>\\]+/gi;
const MAGNET_IN_TEXT = /magnet:\?[^\s"'<>]+/gi;
// Any absolute Windows path and the two POSIX home roots: the segment after the
// root is the account name, localized Windows folder or not.
const HOME_IN_TEXT = /[A-Za-z]:\\[^\\\s"']+\\[^\\\s"']+|\/(?:home|Users)\/[^/\s"']+/g;
const EMAIL_IN_TEXT = /[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g;

/** Nothing useful ever hides past this; it only inflates the event. */
export const MAX_TEXT = 500;
const MAX_DEPTH = 6;
export const MAX_ITEMS = 50;

/**
 * Drop the query string and fragment, which is where debrid, Trakt and
 * torrent-tracker credentials ride, blank e-mail addresses and the account name
 * in a local path.
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
    .replace(EMAIL_IN_TEXT, "[email]")
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
    // A null prototype keeps `__proto__` in a payload from reaching anything.
    const clean: Record<string, unknown> = Object.create(null);
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
export const MAX_REPORTS = 30;

/** Clears the session guard, so a check starts from a clean slate. */
export function resetReportState(): void {
  seen.clear();
}

const TRACE_LIMIT = 40;
const trace: string[] = [];

/**
 * The last few player decisions, in order. Silence is the bug that never
 * throws, so the tail rides along with every report.
 */
export function note(event: string, data?: Record<string, unknown>): void {
  let tail = "";
  if (data) {
    try {
      tail = ` ${JSON.stringify(data)}`;
    } catch {
      tail = "";
    }
  }
  const line = cleanText(
    `${new Date().toISOString().slice(11, 23)} ${event}${tail}`,
  ).slice(0, 600);
  trace.push(line);
  if (trace.length > TRACE_LIMIT) trace.shift();
}

export function traceTail(): string[] {
  return [...trace];
}

export function fingerprintOf(error: unknown): string {
  if (error instanceof Error) {
    const frame = (error.stack ?? "").split("\n")[1] ?? "";
    return `${error.name}: ${error.message} @ ${frame.trim()}`.slice(0, 200);
  }
  return String(error).slice(0, 200);
}

/** `a` is an episode that comes before `b` in the same show. */
export function wentBackwards(
  a: { season?: number | null; episode?: number | null },
  b: { season?: number | null; episode?: number | null },
): boolean {
  if (a.season == null || b.season == null || a.episode == null || b.episode == null) return false;
  if (a.season !== b.season) return a.season < b.season;
  return a.episode < b.episode;
}

export function shouldReport(fingerprint: string): boolean {
  if (seen.has(fingerprint)) return false;
  // A session that floods the cap has lost the point of the cap.
  if (seen.size >= MAX_REPORTS) return false;
  seen.add(fingerprint);
  return true;
}
