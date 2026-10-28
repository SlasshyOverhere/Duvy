import { useCallback, useEffect, useRef, useState } from "react";
import { api, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { TraktStatus } from "../lib/types";
import { Badge, Button, Icon, Spinner, Toggle } from "../components/ui";

type SyncResult = { pulled?: number; pushed?: number };
type Busy = "connect" | "sync" | "disconnect" | null;

const APPS = "https://trakt.tv/oauth/applications";
const ACTIVATE = "https://trakt.tv/activate";
const POLL_MS = 5000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rows(count: number): string {
  return `${count} ${count === 1 ? "row" : "rows"}`;
}

function summary(report: SyncResult): string {
  const parts: string[] = [];
  if (report.pulled != null) parts.push(`${rows(report.pulled)} pulled from Trakt`);
  if (report.pushed != null) parts.push(`${rows(report.pushed)} pushed back`);
  return parts.length ? `Sync finished: ${parts.join(", ")}.` : "Sync finished.";
}

export function TraktView() {
  const { settings, saveSettings } = useApp();
  const [status, setStatus] = useState<TraktStatus | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SyncResult | null>(null);
  const polling = useRef(false);
  const working = useRef(false);
  const savingPref = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStatus(await api.trakt.status());
    } catch (e) {
      setError(message(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!code) return;
    let stopped = false;

    const stop = () => {
      if (stopped) return;
      stopped = true;
      setCode(null);
    };

    const timer = window.setInterval(async () => {
      if (polling.current) return;
      polling.current = true;
      try {
        const next = await api.trakt.poll();
        if (stopped) return;
        setStatus(next);
        if (next.connected) {
          stop();
          setError(null);
          setResult(null);
        }
      } catch (e) {
        if (stopped) return;
        stop();
        setError(message(e));
        void refresh();
      } finally {
        polling.current = false;
      }
    }, POLL_MS);

    const expiry = window.setTimeout(() => {
      if (stopped) return;
      stop();
      setError("Stopped waiting for approval. Request a new code to try again.");
    }, POLL_TIMEOUT_MS);

    return () => {
      stopped = true;
      window.clearInterval(timer);
      window.clearTimeout(expiry);
    };
  }, [code, refresh]);

  const connect = async () => {
    if (working.current) return;
    working.current = true;
    setBusy("connect");
    setError(null);
    setResult(null);
    try {
      const next = await api.trakt.begin(clientId.trim(), clientSecret.trim());
      setStatus(next);
      setClientSecret("");
      setCode(next.connected || !next.userCode ? null : next.userCode);
    } catch (e) {
      setError(message(e));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const cancel = () => {
    setCode(null);
  };

  const sync = async () => {
    if (working.current) return;
    working.current = true;
    setBusy("sync");
    setError(null);
    setResult(null);
    try {
      const report = await api.trakt.sync();
      setResult({ pulled: report.pulled, pushed: report.pushed });
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const disconnect = async () => {
    if (working.current) return;
    if (!window.confirm("Disconnect Trakt? History already stored locally stays on this machine.")) {
      return;
    }
    working.current = true;
    setBusy("disconnect");
    setError(null);
    setResult(null);
    try {
      await api.trakt.disconnect();
      setCode(null);
      await refresh();
    } catch (e) {
      setError(message(e));
    } finally {
      working.current = false;
      setBusy(null);
    }
  };

  const setScrobble = async (value: boolean) => {
    if (savingPref.current) return;
    savingPref.current = true;
    setError(null);
    try {
      await saveSettings({ traktScrobble: value });
    } catch (e) {
      setError(message(e));
    } finally {
      savingPref.current = false;
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

      {status && !status.connected && code ? (
        <section className="settings-group">
          <h2>Approve this device</h2>
          <p className="settings-hint">
            Type the code below at trakt.tv/activate while signed in to Trakt. This window checks back
            every five seconds and finishes on its own.
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
              {code}
            </code>
            <Button icon="external" onClick={() => void openExternal(status.verificationUrl || ACTIVATE)}>
              Open trakt.tv/activate
            </Button>
          </div>
          <div
            className="field-row"
            style={{ alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" }}
          >
            <Spinner label="Waiting for approval…" />
            <Button icon="x" onClick={cancel} disabled={busy !== null}>
              Cancel
            </Button>
          </div>
          <p className="settings-note">
            <Icon name="info" size={14} />
            <span>
              The code expires after ten minutes. Cancel stops this window from checking; you can request
              a new code any time.
            </span>
          </p>
        </section>
      ) : null}

      {status && !status.connected && !code ? (
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
          <div className="settings-row">
            <div>
              <h3>Scrobble while playing</h3>
              <p>Report playback starts, pauses and stops to Trakt.</p>
            </div>
            {settings ? (
              <Toggle
                checked={settings.traktScrobble}
                onChange={(value) => void setScrobble(value)}
                label="Scrobble playback to Trakt"
              />
            ) : null}
          </div>
          {result ? (
            <p className="settings-hint" style={{ marginTop: 14, marginBottom: 0 }}>
              {summary(result)}
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
