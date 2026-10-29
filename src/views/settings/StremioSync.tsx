import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/bridge";
import { useApp } from "../../lib/store";
import { Badge, Button, Icon, Loading, Toggle } from "../../components/ui";
import type { StremioStatus } from "../../lib/types";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Stremio account panel.
 *
 * Signs in to the same account the official apps use, so addons, library rows
 * and resume points converge across Stremio, Nuvio and Duvy. Addons are
 * matched by manifest URL, so the same addon on two accounts stays one row.
 */
export function StremioSync() {
  const { settings, saveSettings, refreshProgress, refreshLibrary, refreshAddons } = useApp();
  const [status, setStatus] = useState<StremioStatus | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"in" | "sync" | "out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.stremio.status();
      setStatus(next);
      setError(null);
      setEmail((current) => current || next.email);
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async () => {
    setBusy("in");
    setError(null);
    setNote(null);
    try {
      setStatus(await api.stremio.signIn(email.trim(), password));
      setPassword("");
      // The backend starts the first sync but does not fail sign-in when it
      // trips, so the sync timestamp, not this note, says whether it landed.
      setNote("Signed in.");
      await Promise.all([refreshProgress(), refreshLibrary(), refreshAddons()]);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    setError(null);
    setNote(null);
    try {
      const report = await api.stremio.syncNow();
      setNote(
        `Pulled ${report.addons} addons, ${report.progress} progress, ${report.watched} watched and ${report.library} library rows; pushed ${report.pushed}.`,
      );
      await Promise.all([refreshProgress(), refreshLibrary(), refreshAddons()]);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    if (!window.confirm("Sign out of Stremio? Local history stays on this machine.")) return;
    setBusy("out");
    setError(null);
    setNote(null);
    try {
      await api.stremio.signOut();
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  if (!status) {
    if (!error) return <Loading variant="list" label="Reading Stremio account" count={2} />;
    return (
      <>
        <p className="form-error" role="alert">
          {error}
        </p>
        <section className="settings-group">
          <h2>Stremio</h2>
          <Button icon="refresh" onClick={() => void refresh()}>
            Try again
          </Button>
        </section>
      </>
    );
  }

  return (
    <>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}

      {status && !status.signedIn ? (
        <section className="settings-group">
          <h2>Stremio</h2>
          <p className="settings-hint">
            Use the email and password of your Stremio account. Addons, library rows and resume
            points land here on the first sync, and anything you watch here goes back.
          </p>
          <div className="field-grid">
            <label className="field">
              <span>Email</span>
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="you@example.com"
                autoComplete="username"
                spellCheck={false}
              />
            </label>
            <label className="field">
              <span>Password</span>
              <input
                type="password"
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                placeholder="Never stored on this machine"
                autoComplete="off"
              />
            </label>
          </div>
          <div className="field-row">
            <Button
              variant="primary"
              icon="key"
              onClick={() => void submit()}
              disabled={busy !== null || !email.trim() || !password}
            >
              {busy === "in" ? "Signing in…" : "Sign in"}
            </Button>
          </div>
          <p className="settings-note">
            <Icon name="info" size={14} />
            <span>
              The password is sent once to Stremio's own API; only the session key is kept locally.
              Addons are matched by manifest URL, so the same addon is never stored twice.
            </span>
          </p>
        </section>
      ) : null}

      {status?.signedIn ? (
        <section className="settings-group">
          <h2>Stremio</h2>
          <div className="settings-row">
            <div>
              <h3>{status.email}</h3>
              <p>
                {status.lastSync
                  ? `Last sync ${new Date(status.lastSync).toLocaleString()}`
                  : "Never synced from this desktop."}
              </p>
            </div>
            <Badge tone="good">connected</Badge>
          </div>

          <div className="settings-row">
            <div>
              <h3>Sync automatically</h3>
              <p>Pull on launch and every few minutes while the app is open.</p>
            </div>
            <Toggle
              checked={settings?.stremioAutoSync ?? false}
              onChange={(value) =>
                void saveSettings({ stremioAutoSync: value }).catch((e) => setError(message(e)))
              }
              label="Sync automatically"
            />
          </div>

          {note ? (
            <p
              className="settings-hint"
              role="status"
              style={{ marginTop: 14, marginBottom: 0 }}
            >
              {note}
            </p>
          ) : null}

          <div className="field-row">
            <Button icon="refresh" onClick={() => void sync()} disabled={busy !== null}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
            <Button
              variant="danger"
              icon="trash"
              onClick={() => void signOut()}
              disabled={busy !== null}
            >
              {busy === "out" ? "Signing out…" : "Sign out"}
            </Button>
          </div>
          <p className="settings-note">
            <Icon name="info" size={14} />
            <span>
              Pulls addons and library rows, then pushes the merged union back. The same addon on
              Stremio, Nuvio and this machine is stored once.
            </span>
          </p>
        </section>
      ) : null}
    </>
  );
}

export default StremioSync;
