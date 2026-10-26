import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openExternal } from "../lib/bridge";
import { Badge, Button, Icon, Spinner } from "../components/ui";

type TraktStatus = {
  connected: boolean;
  username: string;
  lastSync: number;
  userCode: string;
  verificationUrl: string;
};

type SyncResult = { pulled: number; pushed: number };

const APPS = "https://trakt.tv/oauth/applications";
const ACTIVATE = "https://trakt.tv/activate";

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function TraktView() {
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<"connect" | "sync" | "disconnect" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const polling = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await invoke<TraktStatus>("status"));
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const poll = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const next = await invoke<TraktStatus>("poll");
      setStatus(next);
      if (next.connected) setError(null);
    } catch (e) {
      setError(message(e));
      await refresh();
    } finally {
      polling.current = false;
    }
  }, [refresh]);

  const pending = Boolean(status?.userCode);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(() => void poll(), 5000);
    return () => window.clearInterval(timer);
  }, [pending, poll]);

  const connect = async () => {
    setBusy("connect");
    setError(null);
    setResult(null);
    try {
      // Empty fields reuse the credentials already saved on this machine.
      const next = await invoke<TraktStatus>("begin", {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
      });
      setStatus(next);
      setClientSecret("");
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const sync = async () => {
    setBusy("sync");
    setError(null);
    setResult(null);
    try {
      setResult(await invoke<SyncResult>("sync"));
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect Trakt? History already stored locally stays on this machine.")) {
      return;
    }
    setBusy("disconnect");
    setError(null);
    setResult(null);
    try {
      await invoke("disconnect");
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Trakt</p>
          <h1>Watch history, mirrored</h1>
          <p className="page-sub">
            Watched flags, episode history and resume points move both ways through your own Trakt API
            app. Nothing leaves this machine until you connect.
          </p>
        </div>
      </header>

      {!status && !error ? <Spinner label="Reading local settings…" /> : null}

      {error ? <p className="form-error">{error}</p> : null}

      {status && !status.connected && pending ? (
        <section className="settings-group">
          <h2>Approve this device</h2>
          <p className="settings-hint">
            Type the code below at trakt.tv/activate while signed in to Trakt. This window checks back
            every few seconds and finishes on its own.
          </p>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 20,
              flexWrap: "wrap",
              margin: "4px 0 18px",
            }}
          >
            <code
              style={{
                fontSize: "clamp(1.9rem, 4vw, 2.6rem)",
                letterSpacing: "0.22em",
                fontWeight: 700,
                lineHeight: 1.1,
                padding: "10px 18px 10px 22px",
                border: "1px solid var(--line-strong)",
                borderRadius: "var(--radius)",
              }}
            >
              {status.userCode}
            </code>
            <Button icon="external" onClick={() => void openExternal(status.verificationUrl || ACTIVATE)}>
              Open trakt.tv/activate
            </Button>
          </div>
          <button
            type="button"
            className="link-button"
            onClick={() => void connect()}
            disabled={busy !== null}
          >
            {busy === "connect" ? "Requesting a new code…" : "Start over with a new code"}
          </button>
        </section>
      ) : null}

      {status && !status.connected && !pending ? (
        <section className="settings-group">
          <h2>Connect</h2>
          <p className="settings-hint">
            Trakt does not issue a shared API key. Create a free API app at{" "}
            <button type="button" className="link-button" onClick={() => void openExternal(APPS)}>
              trakt.tv/oauth/applications
            </button>
            , set its redirect URI to <code>urn:ietf:wg:oauth:2.0:oob</code>, then paste the client id
            and secret here. The device-code flow never uses the redirect.
          </p>
          <div className="field-grid">
            <label className="field">
              <span>Client ID</span>
              <input
                value={clientId}
                onChange={(event) => setClientId(event.target.value)}
                placeholder="Client id from your Trakt API app"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
            <label className="field">
              <span>Client secret</span>
              <input
                type="password"
                value={clientSecret}
                onChange={(event) => setClientSecret(event.target.value)}
                placeholder="Client secret from your Trakt API app"
                spellCheck={false}
                autoComplete="off"
              />
            </label>
          </div>
          <div className="field-row">
            <Button
              variant="primary"
              icon="key"
              onClick={() => void connect()}
              disabled={busy !== null}
            >
              {busy === "connect" ? "Contacting Trakt…" : "Connect with a device code"}
            </Button>
          </div>
          <p className="settings-note">
            <Icon name="info" size={14} />
            <span>
              The pair is stored in the local database. Leave both fields empty to reuse the saved
              credentials.
            </span>
          </p>
        </section>
      ) : null}

      {status?.connected ? (
        <section className="settings-group">
          <h2>Connected</h2>
          <div className="settings-row">
            <div>
              <h3>{status.username || "Trakt account"}</h3>
              <p>History merges newest-write-wins, so neither device overwrites the other blindly.</p>
            </div>
            <Badge tone="good">connected</Badge>
          </div>
          <div className="settings-row">
            <div>
              <h3>Last sync</h3>
              <p>
                {status.lastSync
                  ? new Date(status.lastSync).toLocaleString()
                  : "Never synced from this device."}
              </p>
            </div>
            <Button icon="refresh" onClick={() => void sync()} disabled={busy !== null}>
              {busy === "sync" ? "Syncing…" : "Sync now"}
            </Button>
          </div>
          {result ? (
            <p className="settings-hint" style={{ marginTop: 14, marginBottom: 0 }}>
              Pulled {result.pulled} {result.pulled === 1 ? "row" : "rows"} from Trakt, pushed{" "}
              {result.pushed} {result.pushed === 1 ? "row" : "rows"} back.
            </p>
          ) : null}
          <div className="field-row">
            <Button
              variant="danger"
              icon="trash"
              onClick={() => void disconnect()}
              disabled={busy !== null}
            >
              {busy === "disconnect" ? "Disconnecting…" : "Disconnect"}
            </Button>
          </div>
          <p className="settings-note">
            <Icon name="info" size={14} />
            <span>
              Pulling reads watched movies, watched episodes and paused playback. Pushing uploads local
              watched rows Trakt has not seen. Titles with no IMDb or TMDB id are skipped rather than
              guessed.
            </span>
          </p>
        </section>
      ) : null}

      <footer className="page-note">
        <Icon name="info" size={15} />
        <span>
          Trakt is a third-party service. BetterNuvio is not affiliated with or endorsed by Trakt.
        </span>
      </footer>
    </div>
  );
}

export default TraktView;
