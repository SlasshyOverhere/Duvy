import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "../lib/bridge";
import type { DebridProvider } from "../lib/types";
import { Badge, Button, Icon, Loading } from "../components/ui";

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
  const [providers, setProviders] = useState<DebridProvider[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [revealed, setRevealed] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const pending = useRef(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setProviders(await api.debrid.providers());
      setLoadError(null);
    } catch (e) {
      setLoadError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const clearError = (id: string) =>
    setErrors((current) => {
      if (!(id in current)) return current;
      const next = { ...current };
      delete next[id];
      return next;
    });

  const fail = (id: string, text: string) =>
    setErrors((current) => ({ ...current, [id]: text }));

  const clearDraft = (id: string) => {
    setDrafts((current) => ({ ...current, [id]: "" }));
    setRevealed((current) => ({ ...current, [id]: false }));
  };

  // set_key already confirmed the change, so the badge stays honest if the reload below fails.
  const mark = (id: string, connected: boolean) =>
    setProviders((current) =>
      current.map((item) => (item.id === id ? { ...item, connected } : item)),
    );

  const connect = async (provider: DebridProvider) => {
    if (pending.current) return;
    const key = (drafts[provider.id] ?? "").trim();
    clearError(provider.id);
    if (!key) {
      fail(provider.id, `Enter your ${provider.name} key first.`);
      return;
    }
    pending.current = true;
    setBusy(provider.id);
    try {
      await api.debrid.setKey(provider.id, key);
      mark(provider.id, true);
      clearDraft(provider.id);
      await load();
    } catch (e) {
      fail(provider.id, message(e));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  const disconnect = async (provider: DebridProvider) => {
    if (pending.current) return;
    if (!window.confirm(`Disconnect ${provider.name}? The stored key is deleted.`)) return;
    clearError(provider.id);
    pending.current = true;
    setBusy(provider.id);
    try {
      await api.debrid.setKey(provider.id, "");
      mark(provider.id, false);
      await load();
    } catch (e) {
      fail(provider.id, message(e));
    } finally {
      pending.current = false;
      setBusy(null);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Debrid accounts</h1>
          <p className="page-sub">
            A debrid account turns a torrent the provider already has cached into a direct HTTPS link,
            so playback starts without waiting on peers. Keys are checked with the provider, then stored
            in this app's local settings database.
          </p>
        </div>
      </header>

      {loading ? <Loading variant="list" label="Reading connected accounts" /> : null}
      {loadError ? (
        <p className="form-error" role="alert">
          {loadError}
        </p>
      ) : null}

      {providers.map((provider) => {
        const working = busy === provider.id;
        const locked = busy !== null;
        const draft = drafts[provider.id] ?? "";
        const shown = revealed[provider.id] ?? false;
        const error = errors[provider.id];

        return (
          <section className="settings-group" key={provider.id}>
            <div className="settings-row">
              <div>
                <h3>{provider.name}</h3>
                <p>{HINTS[provider.id] ?? "API key from the provider's account page."}</p>
              </div>
              <div className="addon-actions" aria-live="polite">
                <Badge tone={provider.connected ? "good" : "neutral"}>
                  {provider.connected ? "Connected" : "Not connected"}
                </Badge>
                {provider.connected ? (
                  <Button icon="x" disabled={locked} onClick={() => void disconnect(provider)}>
                    {working ? "Working…" : "Disconnect"}
                  </Button>
                ) : null}
              </div>
            </div>

            <form
              className="field-row"
              onSubmit={(event) => {
                event.preventDefault();
                if (!locked) void connect(provider);
              }}
            >
              <input
                type={shown ? "text" : "password"}
                value={draft}
                onChange={(event) => {
                  const value = event.target.value;
                  setDrafts((current) => ({ ...current, [provider.id]: value }));
                  clearError(provider.id);
                }}
                placeholder={
                  provider.connected ? "Paste a new key to replace the stored one" : "Paste your API key"
                }
                aria-label={`${provider.name} API key`}
                autoComplete="off"
                autoCapitalize="off"
                spellCheck={false}
                disabled={locked}
              />
              <Button
                disabled={locked}
                title={shown ? "Hide the key" : "Show the key"}
                onClick={() =>
                  setRevealed((current) => ({ ...current, [provider.id]: !shown }))
                }
              >
                {shown ? "Hide" : "Show"}
              </Button>
              <Button
                type="submit"
                variant={provider.connected ? "soft" : "primary"}
                disabled={locked}
              >
                {working ? "Checking…" : provider.connected ? "Replace" : "Connect"}
              </Button>
            </form>
            {error ? (
              <p className="form-error" role="alert">
                {error}
              </p>
            ) : null}
          </section>
        );
      })}

      <footer className="page-note">
        <Icon name="info" size={15} />
        <span>
          One connected account is enough. Playback prefers any provider that already has the torrent
          cached; otherwise it is queued and the request waits up to 30 seconds.
        </span>
      </footer>
    </div>
  );
}

export default DebridView;
