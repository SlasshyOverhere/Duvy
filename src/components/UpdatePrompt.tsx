import { useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri } from "../lib/bridge";
import { errorMessage, megabytes } from "../lib/format";
import { useApp } from "../lib/store";
import { Button, Icon } from "./ui";

// Dismissal outlives the card, so opening the player and coming back is quiet.
let dismissed = "";

/** A corner card, so an update never blocks the screen the user is on. */
export function UpdatePrompt() {
  const { update, route } = useApp();
  if (!update || route.name === "player") return null;
  // Keyed, so a newer release reopens a card that was dismissed earlier.
  return <Prompt key={update.version} version={update.version} current={update.currentVersion} />;
}

function Prompt({ version, current }: { version: string; current: string }) {
  const [progress, setProgress] = useState<{ got: number; total: number | null } | null>(null);
  const [installing, setInstalling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [closed, setClosed] = useState(dismissed === version);
  const busy = useRef(false);
  busy.current = installing;

  const dismiss = () => {
    dismissed = version;
    setClosed(true);
  };

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy.current) dismiss();
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
    return () => {
      disposed = true;
      stop?.();
      window.removeEventListener("keydown", escape);
    };
  }, []);

  if (closed) return null;

  const share = progress?.total ? Math.min(100, (progress.got / progress.total) * 100) : null;

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
    <aside className="update-card" role="status" aria-live="polite">
      <button
        type="button"
        className="update-close"
        onClick={dismiss}
        disabled={installing}
        aria-label="Dismiss"
      >
        <Icon name="x" size={14} />
      </button>
      <div className="update-card-head">
        <Icon name="download" size={16} />
        <h2>Duvy {version} is available</h2>
      </div>
      <p>
        You are on {current}. Downloads and installs only when you ask, and the window reopens on
        the new version.
      </p>
      {installing ? (
        <>
          <div
            className="update-meter"
            role="progressbar"
            aria-label="Update download"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={share ?? undefined}
          >
            <span style={{ transform: `scaleX(${(share ?? 0) / 100})` }} />
          </div>
          <p className="update-bytes">
            {progress?.total
              ? `Downloaded ${megabytes(progress.got)} of ${megabytes(progress.total)}.`
              : "Downloading the installer."}
          </p>
        </>
      ) : null}
      {error ? (
        <p className="update-bytes" role="alert">
          {error}
        </p>
      ) : null}
      <div className="update-actions">
        <Button
          variant="primary"
          icon="download"
          disabled={installing}
          onClick={() => void install()}
        >
          {installing ? "Installing" : "Update now"}
        </Button>
        <Button variant="text" disabled={installing} onClick={dismiss}>
          Later
        </Button>
      </div>
    </aside>
  );
}
