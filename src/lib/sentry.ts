/** Sentry is heavy; the SDK loads only when telemetry is on. */
type SentryModule = typeof import("@sentry/react");

let loaded: SentryModule | null = null;
let loading: Promise<SentryModule | null> | null = null;

/** One import per session; a failed chunk resolves null instead of rejecting. */
export function loadSentry(): Promise<SentryModule | null> {
  loading ??= import("@sentry/react").then(
    (module) => (loaded = module),
    () => null,
  );
  return loading;
}

/** The SDK when it has already been loaded, null before that. */
export function sentry(): SentryModule | null {
  return loaded;
}