import { useCallback, useEffect, useState } from "react";
import { api } from "../../lib/bridge";
import { useApp } from "../../lib/store";
import { Badge, Button, Icon, Spinner, Toggle } from "../../components/ui";
import type { NuvioProfile, NuvioStatus } from "../../lib/types";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Nuvio Cloud account panel.
 *
 * Signs in to the same backend the official Nuvio apps use, so watched flags,
 * resume points and the library converge across Nuvio mobile, Nuvio Desktop and
 * BetterNuvio on the next sync.
 */
export function NuvioSync() {
  const { settings, saveSettings, refreshProgress, refreshLibrary } = useApp();
  const [status, setStatus] = useState<NuvioStatus | null>(null);
  const [profiles, setProfiles] = useState<NuvioProfile[]>([]);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"in" | "up" | "sync" | "out" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await api.nuvio.status();
      setStatus(next);
      setEmail((current) => current || next.email);
      if (next.signedIn) {
        setProfiles(await api.nuvio.profiles().catch(() => []));
      } else {
        setProfiles([]);
      }
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const submit = async (signUp: boolean) => {
    setBusy(signUp ? "up" : "in");
    setError(null);
    setNote(null);
    try {
      setStatus(await api.nuvio.signIn(email.trim(), password, signUp));
      setPassword("");
      setNote("Signed in. First sync finished.");
      await Promise.all([refreshProgress(), refreshLibrary()]);
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
      const report = await api.nuvio.syncNow();
      setNote(
        `Pulled ${report.progress} progress, ${report.watched} watched and ${report.library} library rows; pushed ${report.pushed}.`,
      );
      await Promise.all([refreshProgress(), refreshLibrary()]);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const signOut = async () => {
    if (!window.confirm("Sign out of Nuvio Cloud? Local history stays on this machine.")) return;
    setBusy("out");
    setError(null);
    setNote(null);
    try {
      await api.nuvio.signOut();
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const pickProfile = async (index: number) => {
    setError(null);
    setNote(null);
    try {
      await api.nuvio.setProfile(index);
      setStatus((current) => (current ? { ...current, profile: index } : current));
      await sync();
    } catch (e) {
      setError(message(e));
    }
  };

  if (!status && !error) return <Spinner label="Reading Nuvio account…" />;

  return (
    <>
      {error ? <p className="form-error">{error}</p> : null}

      {status && !status.signedIn ? (
        <section className="settings-group">
          <h2>Nuvio Cloud</h2>
          <p className="settings-hint">
            Use the email and password of your Nuvio account. Everything Nuvio already knows about your
            watching lands here on the first sync, and anything you watch here goes back.
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
                autoComplete="current-password"
              />
            </label>
          </div>
          <div className="field-row">
            <Button
              variant="primary"
              icon="key"
              onClick={() => void submit(false)}
              disabled={busy !== null || !email.trim() || !password}
            >
              {busy === "in" ? "Signing in…" : "Sign in"}
            </Button>
            <button
              type="button"
              className="link-button"
              onClick={() => void submit(true)}
              disabled={busy !== null || !email.trim() || !password}
            >
              {busy === "up" ? "Creating…" : "Create an account"}
            </button>
          </div>
          <p className="settings-note">
            <Icon name="info" size={14} />
            <span>
              The session token is kept in the local database; the password is only sent once to the
              Nuvio auth endpoint. Backend <code>{status?.baseUrl}</code>.
            </span>
          </p>
        </section>
      ) : null}

      {status?.signedIn ? (
        <section className="settings-group">
          <h2>Nuvio Cloud</h2>
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

          {profiles.length > 1 ? (
            <div className="settings-row">
              <div>
                <h3>Profile</h3>
                <p>Each Nuvio profile keeps its own history, so pick the one this desktop represents.</p>
              </div>
              <div className="field-row" style={{ margin: 0 }}>
                {profiles.map((profile) => (
                  <button
                    key={profile.id || profile.profileIndex}
                    type="button"
                    className={`chip${status.profile === profile.profileIndex ? " is-active" : ""}`}
                    onClick={() => void pickProfile(profile.profileIndex)}
                  >
                    {profile.name || `Profile ${profile.profileIndex}`}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div className="settings-row">
            <div>
              <h3>Sync automatically</h3>
              <p>Pull on launch and every few minutes while the app is open.</p>
            </div>
            <Toggle
              checked={settings?.nuvioAutoSync ?? false}
              onChange={(value) => void saveSettings({ nuvioAutoSync: value })}
              label="Sync automatically"
            />
          </div>

          {note ? (
            <p className="settings-hint" style={{ marginTop: 14, marginBottom: 0 }}>
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
              Merges are newest-write-wins on both sides. Watched flags and resume points are uploaded
              after every pull, so deleting and re-installing this app is safe.
            </span>
          </p>
        </section>
      ) : null}
    </>
  );
}

export default NuvioSync;
