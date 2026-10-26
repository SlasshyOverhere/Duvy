import { useState } from "react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import { Badge, Button, EmptyState, Icon, Spinner, Toggle } from "../components/ui";

export function AddonsView() {
  const { addons, refreshAddons, notify } = useApp();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const install = async (target: string) => {
    setBusy(true);
    setError(null);
    try {
      const installed = await api.addons.install(target);
      await refreshAddons();
      setUrl("");
      notify(`${installed.name} installed`, "success");
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setError(message);
      notify(message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Addons</p>
          <h1>Bring your own sources</h1>
          <p className="page-sub">
            BetterNuvio speaks the open Stremio addon protocol. Nothing is bundled and nothing is scraped —
            every catalog, metadata record and stream comes from a URL you add.
          </p>
        </div>
      </header>

      <section className="install-card">
        <div className="install-copy">
          <h2>Install from URL</h2>
          <p>Paste an addon manifest or transport URL. `manifest.json` is resolved automatically.</p>
        </div>
        <form
          className="install-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (url.trim()) void install(url.trim());
          }}
        >
          <input
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/manifest.json"
            aria-label="Addon URL"
            spellCheck={false}
          />
          <Button type="submit" variant="primary" icon="download" disabled={busy || !url.trim()}>
            {busy ? "Installing…" : "Install"}
          </Button>
        </form>
        <div className="install-quick">
          <Button icon="sparkles" onClick={() => void install("https://v3-cinemeta.strem.io")} disabled={busy}>
            Add Cinemeta (metadata only)
          </Button>
          <span>Catalog and metadata addon. Add a stream addon of your choice for playback.</span>
        </div>
        {error ? <p className="form-error">{error}</p> : null}
      </section>

      {busy && addons.length === 0 ? <Spinner label="Fetching manifest…" /> : null}

      {addons.length === 0 && !busy ? (
        <EmptyState
          icon="puzzle"
          title="No addons installed"
          body="Without a catalog addon the home screen stays empty. Without a stream addon, playback has no sources."
        />
      ) : null}

      <div className="addon-list">
        {addons.map((addon) => (
          <article className={`addon-card${addon.enabled ? "" : " is-off"}`} key={addon.url}>
            <div className="addon-logo">
              {addon.logo ? (
                <img src={addon.logo} alt="" />
              ) : (
                <span>{addon.name.slice(0, 1)}</span>
              )}
            </div>
            <div className="addon-main">
              <div className="addon-title">
                <h3>{addon.name}</h3>
                {addon.version ? <span className="addon-version">v{addon.version}</span> : null}
              </div>
              <p className="addon-url">{addon.url}</p>
              {addon.description ? <p className="addon-desc">{addon.description}</p> : null}
              <div className="addon-tags">
                {addon.resources.map((resource) => (
                  <Badge key={resource} tone={resource === "stream" ? "accent" : "neutral"}>
                    {resource}
                  </Badge>
                ))}
                <span className="addon-count">
                  {addon.catalogs.length} {addon.catalogs.length === 1 ? "catalog" : "catalogs"}
                </span>
              </div>
            </div>
            <div className="addon-actions">
              <Toggle
                checked={addon.enabled}
                label={`Enable ${addon.name}`}
                onChange={(value) => {
                  void api.addons.setEnabled(addon.url, value).then(refreshAddons);
                }}
              />
              <button
                type="button"
                className="icon-btn danger"
                aria-label={`Remove ${addon.name}`}
                onClick={() => {
                  if (!window.confirm(`Remove ${addon.name}?`)) return;
                  void api.addons.remove(addon.url).then(async () => {
                    await refreshAddons();
                    notify(`${addon.name} removed`);
                  });
                }}
              >
                <Icon name="trash" size={17} />
              </button>
            </div>
          </article>
        ))}
      </div>

      <footer className="page-note">
        <Icon name="info" size={15} />
        <span>
          P2P/torrent streaming, debrid and media-server support are on the roadmap. This build plays direct
          HTTP sources and local files.
        </span>
      </footer>
    </div>
  );
}
