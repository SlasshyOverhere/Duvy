import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { isTauri } from "../lib/bridge";
import { useApp } from "../lib/store";
import { applyTelemetry, report } from "../lib/telemetry";

/** Applies the telemetry choice and forwards Rust panics. */
export function CrashReporting() {
  const { settings, appInfo } = useApp();
  const enabled = settings ? settings.analytics && settings.telemetry !== false : false;

  useEffect(() => {
    if (!appInfo) return;
    applyTelemetry(enabled, `duvy@${appInfo.version}`);
  }, [enabled, appInfo]);

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
        // Still in the local log.
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  return null;
}
