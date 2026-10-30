import * as Sentry from "@sentry/react";
import { api, isTauri } from "./bridge";
import {
  cleanText,
  fingerprintOf,
  isNoise,
  note,
  scrubValue,
  shouldReport,
  traceTail,
} from "./errors";

/**
 * Crash reporting is opt-in and only exists in a release build that was built
 * with a DSN: a local build has no endpoint, so nothing is ever sent.
 */
const DSN = (import.meta.env.VITE_SENTRY_DSN ?? "").trim();

export const telemetryAvailable = Boolean(import.meta.env.PROD && DSN);

/** Noise the SDK would otherwise report on its own, before our gate runs. */
const IGNORED = [
  "ResizeObserver loop completed with undelivered notifications.",
  "ResizeObserver loop limit exceeded",
];

let started = false;
let active = false;

function start(release?: string) {
  if (started) return;
  started = true;
  Sentry.init({
    dsn: DSN,
    release,
    environment: "production",
    // Sampled, not every session: the free tier is metered.
    tracesSampleRate: 0.2,
    // A tenth of sessions, and always the one that broke.
    replaysSessionSampleRate: 0.1,
    replaysOnErrorSampleRate: 1,
    maxBreadcrumbs: 30,
    ignoreErrors: IGNORED,
    integrations: (defaults) => [
      ...defaults,
      Sentry.browserTracingIntegration(),
      // A recording of a private player: blank the words, block the picture.
      Sentry.replayIntegration({ maskAllText: true, blockAllMedia: true }),
    ],
    beforeSend(event) {
      return scrubValue(event) as typeof event;
    },
  });
}

/**
 * Point the reporter at the user's choice. Safe to call on every render: the
 * SDK is started once, and the flag is what turns sending on or off.
 */
export function applyTelemetry(enabled: boolean, release?: string): void {
  if (!telemetryAvailable) return;
  if (enabled) start(release);
  active = enabled && started;
  const client = Sentry.getClient();
  if (client) client.getOptions().enabled = active;
}

/**
 * Record a decision that failed silently. Kept next to the reporting rules so
 * the buffer itself can be checked without the SDK.
 */
export { note };

export type ReportLevel = "error" | "fatal" | "warning" | "info";

/**
 * Record a failure for the next fix session. A no-op unless the user opted in,
 * unless the build has no endpoint, or unless this exact failure was reported
 * already. `withLog` attaches the player's own timing log, which is the only
 * record when mpv fails without throwing.
 */
export function report(
  error: unknown,
  options?: { area?: string; level?: ReportLevel; extra?: Record<string, unknown>; withLog?: boolean },
): void {
  if (!active) return;
  const message = error instanceof Error ? error.message : String(error);
  if (isNoise(message) || !shouldReport(fingerprintOf(error))) return;

  const extra: Record<string, unknown> = {
    ...(scrubValue(options?.extra ?? {}) as Record<string, unknown>),
    trace: traceTail(),
  };
  const level = options?.level ?? "error";

  const send = (log?: string[]) => {
    Sentry.withScope((scope) => {
      if (options?.area) scope.setTag("area", options.area);
      scope.setLevel(level);
      scope.setExtras(log ? { ...extra, player: log } : extra);
      if (error instanceof Error) Sentry.captureException(error);
      else Sentry.captureMessage(cleanText(message), level);
    });
  };

  if (options?.withLog && isTauri()) {
    // The log read is local and fast; a failure to read is not worth losing
    // the report over.
    void api.playbackLog(40).then(send, () => send());
    return;
  }
  send();
}
