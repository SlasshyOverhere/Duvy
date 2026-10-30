import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "../lib/bridge";
import { errorMessage } from "../lib/format";
import { useApp } from "../lib/store";
import { Button, Icon } from "./ui";

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * The update announcement, in the middle of the window: a corner toast is too
 * small to carry a version and an action. Closing it lasts for this version.
 */
export function UpdatePrompt() {
  const { update } = useApp();
  if (!update) return null;
  // Keyed, so a newer release reopens a prompt that was closed earlier.
  return <Prompt key={update.version} version={update.version} current={update.currentVersion} />;
}

function Prompt({ version, current }: { version: string; current: string }) {
  const [progress, setProgress] = useState<{ got: number; total: number | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(false);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setClosed(true);
    };
    window.addEventListener("keydown", escape);
    void listen<{ downloaded: number; total: number | null }>("update:progress", (event) => {
      setProgress({ got: event.payload.downloaded, total: event.payload.total });
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // Without the event bridge the install still runs, just without a meter.
      });
    // Fetching now is what keeps "Update now" from starting the transfer.
    void api.updates.prepare().catch(() => {});
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener("keydown", escape);
    };
  }, []);

  if (closed) return null;

  const share = progress?.total ? Math.min(100, (progress.got / progress.total) * 100) : null;
  const status = installing
    ? "Installing. Duvy closes and reopens on the new version."
    : progress?.total
      ? `Downloaded ${megabytes(progress.got)} of ${megabytes(progress.total)}.`
      : "Fetching the installer in the background.";

  const install = async () => {
    setInstalling(true);
    setError(null);
    try {
      await api.updates.install();
    } catch (e) {
      setError(errorMessage(e));
      setInstalling(false);
    }
  };

  return (
    <div className="update-backdrop">
      <div className="update-prompt" role="dialog" aria-modal="true" aria-labelledby="update-title">
        <button
          type="button"
          className="update-close"
          onClick={() => setClosed(true)}
          aria-label="Close"
        >
          <Icon name="x" size={16} />
        </button>
        <h2 id="update-title">Duvy {version} is ready</h2>
        <p>
          You are on {current}. The installer is a few megabytes, and the window comes back on
          the new version.
        </p>
        <div
          className="update-meter"
          role="progressbar"
          aria-label="Update download"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={share ?? undefined}
        >
          <span style={{ width: `${share ?? 0}%` }} />
        </div>
        <p className="update-bytes" role="status">
          {error ?? status}
        </p>
        <div className="update-actions">
          <Button variant="primary" icon="download" disabled={installing} onClick={() => void install()}>
            {installing ? "Installing" : "Update now"}
          </Button>
        </div>
      </div>
    </div>
  );
}
