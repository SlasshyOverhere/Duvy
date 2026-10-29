import * as Sentry from "@sentry/react";
import { cleanText, fingerprintOf, isNoise, scrubValue, shouldReport } from "./errors";

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
    // Errors only: the free tier is metered, and traces would eat it.
    tracesSampleRate: 0,
    maxBreadcrumbs: 30,
    ignoreErrors: IGNORED,
    // A session envelope is a separate quota and tells us nothing here.
    integrations: (defaults) => defaults.filter((item) => item.name !== "BrowserSession"),
    beforeSend(event) {
      return scrubValue(event) as typeof event;
    },
  });
}

/**
 * Point the reporter at the user's choice. The SDK is only started once the
 * user agrees, and the flag is what silences it again afterwards. Safe to call
 * on every render.
 */
export function applyTelemetry(enabled: boolean, release?: string): void {
  if (!telemetryAvailable) return;
  if (enabled) start(release);
  active = enabled && started;
  const client = Sentry.getClient();
  if (client) client.getOptions().enabled = active;
}

export type ReportLevel = "error" | "fatal" | "warning" | "info";

/**
 * Record a failure for the next fix session. A no-op unless the user opted in,
 * unless the build has no endpoint, or unless this exact failure was reported
 * already.
 */
export function report(
  error: unknown,
  options?: { area?: string; level?: ReportLevel; extra?: Record<string, unknown> },
): void {
  if (!active) return;
  const message = error instanceof Error ? error.message : String(error);
  if (isNoise(message) || !shouldReport(fingerprintOf(error))) return;
  Sentry.withScope((scope) => {
    if (options?.area) scope.setTag("area", options.area);
    if (options?.level) scope.setLevel(options.level);
    if (options?.extra) {
      scope.setExtras(scrubValue(options.extra) as Record<string, unknown>);
    }
    if (error instanceof Error) Sentry.captureException(error);
    else Sentry.captureMessage(cleanText(message), options?.level ?? "error");
  });
}
