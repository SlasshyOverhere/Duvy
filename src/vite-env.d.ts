/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Sentry DSN baked in at build time. Empty means reports cannot be sent. */
  readonly VITE_SENTRY_DSN?: string;
}
