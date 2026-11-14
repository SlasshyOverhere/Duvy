/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN baked in at build time. Empty means reports cannot be sent. */
  readonly VITE_SENTRY_DSN?: string;
  /** PostHog project key. Empty means nothing is counted. */
  readonly VITE_POSTHOG_KEY?: string;
  /** PostHog ingest host; defaults to the US cloud. */
  readonly VITE_POSTHOG_HOST?: string;
}
