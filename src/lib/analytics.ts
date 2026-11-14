import { isTauri } from "./bridge";

/**
 * Anonymous usage counts: opens, playbacks and how much was watched. Never a
 * title, an account or a link. Off unless the build carries a key, and off
 * again the moment the user says so in Settings, Privacy.
 */
const KEY = (import.meta.env.VITE_POSTHOG_KEY ?? "").trim();
const HOST = (import.meta.env.VITE_POSTHOG_HOST || "https://us.i.posthog.com").replace(/\/+$/, "");
const INSTALL_KEY = "duvy:install";

/** A key is what turns counting on; dev builds tag their events and still send. */
export const analyticsAvailable = Boolean(KEY && isTauri());
const ENVIRONMENT = import.meta.env.PROD ? "production" : "development";

type Props = Record<string, string | number | boolean>;

let enabled = false;
let version = "";

/** A random id per install, so active users count without a sign-in. */
function installId(): string {
  try {
    const known = window.localStorage.getItem(INSTALL_KEY);
    if (known) return known;
    // Not crypto.randomUUID: it needs a secure context, and a null origin here
    // would silently cost every event.
    const fresh = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    window.localStorage.setItem(INSTALL_KEY, fresh);
    return fresh;
  } catch {
    return "";
  }
}

/** Point the tracker at the user's choice. Safe to call on every render. */
export function applyAnalytics(on: boolean, appVersion?: string): void {
  enabled = analyticsAvailable && on;
  if (appVersion) version = appVersion;
}

export function track(event: string, props: Props = {}): void {
  if (!enabled) return;
  const id = installId();
  if (!id) return;
  // Fire and forget: analytics must never slow a click or surface an error.
  void fetch(`${HOST}/i/v0/e/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    keepalive: true,
    body: JSON.stringify({
      api_key: KEY,
      event,
      distinct_id: id,
      properties: {
        ...props,
        app_version: version,
        environment: ENVIRONMENT,
        $process_person_profile: false,
      },
    }),
  }).catch(() => undefined);
}
