/** Sentry is opt-in and heavy; the SDK loads only once the user agrees. */
type SentryModule = typeof import("@sentry/react");

let loaded: SentryModule | null = null;

export function loadSentry(): Promise<SentryModule> {
  return import("@sentry/react").then((module) => (loaded = module));
}

/** The SDK when it has already been loaded, null before that. */
export function sentry(): SentryModule | null {
  return loaded;
}