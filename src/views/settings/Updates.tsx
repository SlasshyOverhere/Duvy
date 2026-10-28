import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, isTauri, openExternal } from "../../lib/bridge";
import { useApp } from "../../lib/store";
import { errorMessage } from "../../lib/format";
import { Button, Toggle } from "../../components/ui";

const RELEASES = "https://github.com/SlasshyOverhere/Duvy/releases";

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Update checking, download progress and install, for the About tab. */
export function Updates() {
  const { settings, update, checkUpdate, skipUpdate, saveSettings, notify } = useApp();
  const [checking, setChecking] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<{ got: number; total: number | null } | null>(null);

  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen<{ downloaded: number; total: number | null }>("update:progress", (event) => {
      setProgress({ got: event.payload.downloaded, total: event.payload.total });
    })
      .then((stop) => {
        if (disposed) stop();
        else unlisten = stop;
      })
      .catch(() => {
        // Without the event bridge the install still runs, just without a meter.
      });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  if (!settings) return null;

  const check = async () => {
    setChecking(true);
    setNote(null);
    try {
      const found = await checkUpdate();
      setNote(found ? null : "You are on the newest release.");
    } catch (error) {
      setNote(errorMessage(error));
    } finally {
      setChecking(false);
    }
  };

  const install = async () => {
    setInstalling(true);
    setNote(null);
    setProgress(null);
    try {
      await api.updates.install();
      setNote("Installing. Duvy restarts when it finishes.");
    } catch (error) {
      setNote(errorMessage(error));
      setInstalling(false);
    }
  };

  const share =
    progress?.total != null ? Math.min(100, (progress.got / progress.total) * 100) : null;
  const desktop = isTauri();

  return (
    <section className="settings-group">
      <h2>Updates</h2>

      <div className="settings-row">
        <div>
          <h3>Automatic checks</h3>
          <p>Look for a new release on launch, then every six hours.</p>
        </div>
        <Toggle
          checked={settings.autoUpdateCheck}
          onChange={(value) => void saveSettings({ autoUpdateCheck: value })}
          label="Automatic update checks"
        />
      </div>

      <div className="settings-row">
        <div>
          <h3>{update ? `Version ${update.version} is available` : "Check for updates"}</h3>
          <p>
            {note ??
              (update
                ? `${update.date ? `Released ${update.date}. ` : ""}Downloads, verifies the signature, then reinstalls.`
                : "Every download is checked against the app's signing key before it runs.")}
          </p>
        </div>
        <Button
          icon="refresh"
          disabled={!desktop || checking || installing}
          onClick={() => void check()}
        >
          {checking ? "Checking" : "Check now"}
        </Button>
      </div>

      {update ? (
        <>
          {update.notes ? <pre className="log-view update-notes">{update.notes}</pre> : null}
          {installing ? (
            <div
              className="update-meter"
              role="progressbar"
              aria-label="Update download"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={share ?? undefined}
            >
              <span style={share == null ? undefined : { width: `${share}%` }} />
            </div>
          ) : null}
          {installing && progress ? (
            <p className="settings-hint">
              {megabytes(progress.got)}
              {progress.total ? ` of ${megabytes(progress.total)}` : ""}
            </p>
          ) : null}
          <div className="about-actions">
            <Button
              variant="primary"
              icon="download"
              disabled={!desktop || installing}
              onClick={() => void install()}
            >
              {installing ? "Installing" : "Install and restart"}
            </Button>
            <Button disabled={installing} onClick={() => void skipUpdate(update.version)}>
              Skip this version
            </Button>
            <Button
              icon="external"
              onClick={() =>
                void openExternal(RELEASES).catch(() => notify("Could not open that link", "error"))
              }
            >
              Release notes
            </Button>
          </div>
        </>
      ) : null}
    </section>
  );
}
