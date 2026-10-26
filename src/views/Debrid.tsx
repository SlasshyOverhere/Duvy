import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Icon, Spinner } from "../components/ui";

type Provider = { id: string; name: string; connected: boolean };

const HINTS: Record<string, string> = {
  realdebrid: "Private API token from real-debrid.com/apitoken.",
  alldebrid: "API key from alldebrid.com/apikeys.",
  premiumize: "API key from your Premiumize account page.",
  torbox: "API key from torbox.app/settings.",
};

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function DebridView() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<{ id: string; message: string } | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setProviders(await invoke<Provider[]>("providers"));
      setError(null);
    } catch (e) {
      setError({ id: "", message: message(e) });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connect = async (id: string) => {
    const key = (drafts[id] ?? "").trim();
    if (!key) return;
    setBusy(id);
    setError(null);
    try {
      await invoke("set_key", { provider: id, key });
      setDrafts((current) => ({ ...current, [id]: "" }));
      await load();
    } catch (e) {
      setError({ id, message: message(e) });
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await invoke("set_key", { provider: id, key: "" });
      await load();
    } catch (e) {
      setError({ id, message: message(e) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Debrid</p>
          <h1>Accounts</h1>
          <p className="page-sub">
            A connected account turns a cached torrent or a hoster link into a direct HTTPS stream
            that mpv can open. Keys are validated against the provider before they are stored.
          </p>
        </div>
      </header>

      {loading ? <Spinner label="Checking connected accounts…" /> : null}

      <section>
        {providers.map((provider) => {
          const working = busy === provider.id;
          return (
            <div key={provider.id}>
              <div className="settings-row">
                <div>
                  <h3>{provider.name}</h3>
                  <p>{HINTS[provider.id]}</p>
                </div>
                <div className="addon-actions">
                  <Badge tone={provider.connected ? "good" : "neutral"}>
                    {provider.connected ? "connected" : "not connected"}
                  </Badge>
                  {provider.connected ? (
                    <Button icon="x" disabled={working} onClick={() => void disconnect(provider.id)}>
                      {working ? "Working…" : "Disconnect"}
                    </Button>
                  ) : null}
                </div>
              </div>

              <form
                className="field-row"
                onSubmit={(event) => {
                  event.preventDefault();
                  void connect(provider.id);
                }}
              >
                <input
                  type="password"
                  value={drafts[provider.id] ?? ""}
                  onChange={(event) =>
                    setDrafts((current) => ({ ...current, [provider.id]: event.target.value }))
                  }
                  placeholder={provider.connected ? "Replace key" : "API key or token"}
                  aria-label={`${provider.name} API key`}
                  autoComplete="off"
                  spellCheck={false}
                />
                <Button
                  type="submit"
                  variant={provider.connected ? "soft" : "primary"}
                  disabled={working || !(drafts[provider.id] ?? "").trim()}
                >
                  {working ? "Checking…" : provider.connected ? "Replace" : "Connect"}
                </Button>
              </form>
              {error?.id === provider.id ? <p className="form-error">{error.message}</p> : null}
            </div>
          );
        })}
      </section>

      {error && !error.id ? <p className="form-error">{error.message}</p> : null}

      <footer className="page-note">
        <Icon name="info" size={15} />
        <span>
          Only one account needs to be connected. Resolution prefers any provider that already has
          the torrent cached; otherwise the torrent is queued and the request waits up to 30 seconds.
        </span>
      </footer>
    </div>
  );
}

export default DebridView;
