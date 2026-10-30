import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../lib/bridge";
import { useApp } from "../lib/store";
import { applyTelemetry, report, telemetryAvailable } from "../lib/telemetry";

/**
 * Asks once, then honours the answer: the SDK is only live while the user has
 * agreed, and the same switch lives in Settings, Privacy.
 */
export function CrashReporting() {
  const { settings, appInfo, saveSettings } = useApp();
  const choice = settings?.telemetry ?? null;

  useEffect(() => {
    if (!appInfo) return;
    applyTelemetry(choice === true, `duvy@${appInfo.version}`);
  }, [choice, appInfo]);

  // A panic in the Rust side aborts the process, so the shell hands it over.
  useEffect(() => {
    if (!isTauri()) return;
    let stop: (() => void) | undefined;
    let disposed = false;
    void listen<string>("app:error", (event) => {
      report(new Error(event.payload), { area: "rust", level: "fatal" });
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // No event bridge: the panic is still in the local log.
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  if (!telemetryAvailable || !settings?.onboarded || choice !== null) return null;

  return (
    <div className="consent">
      <div className="consent-card" role="dialog" aria-modal="true" aria-labelledby="consent-title">
        <h2 id="consent-title">Send crash reports?</h2>
        <p>
          When something in Duvy breaks, the error can go to Sentry so it can be fixed later. A
          report carries the error, the screen it happened on, the app version and the last few
          playback steps: title, episode, position. It can also include a short
          recording of the window with every word and picture blanked out, and how long
          each screen took.
        </p>
        <p className="consent-fine">
          No accounts, tokens or file paths, and links are cut down to the host. Off until you say
          yes, and you can change it anytime in Settings, Privacy.
        </p>
        <div className="consent-actions">
          <button
            type="button"
            className="btn btn-primary"
            autoFocus
            onClick={() => void saveSettings({ telemetry: true })}
          >
            Send reports
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void saveSettings({ telemetry: false })}
          >
            No thanks
          </button>
        </div>
      </div>
    </div>
  );
}
