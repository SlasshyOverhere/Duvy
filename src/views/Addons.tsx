import { useState } from "react";
import { api, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { AddonInfo } from "../lib/types";
import { Badge, Button, EmptyState, Icon, Loading, Toggle, type IconName } from "../components/ui";

const RESOURCE_LABELS: Record<string, string> = {
  catalog: "Catalogs",
  stream: "Streams",
  subtitles: "Subtitles",
  meta: "Metadata",
};

function errorText(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error instanceof Error && error.message) return error.message;
  if (error && typeof error === "object" && "message" in error) {
    return String((error as { message: unknown }).message);
  }
  return "Something went wrong";
}

function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) throw new Error("Enter an addon URL");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new Error(`"${value}" is not a valid URL`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Addon URL must start with http:// or https://");
  }
  if (!parsed.hostname.includes(".") && parsed.hostname !== "localhost") {
    throw new Error(`"${parsed.hostname}" is not a valid host`);
  }
  return withScheme;
}

function catalogCount(addon: AddonInfo): string {
  if (!addon.resources.includes("catalog")) return "";
  const count = addon.catalogs.length;
  return `${count} ${count === 1 ? "catalog" : "catalogs"}`;
}

function CardButton({
  icon,
  label,
  disabled,
  rotate,
  onClick,
}: {
  icon: IconName;
  label: string;
  disabled?: boolean;
  rotate?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className="icon-btn"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon name={icon} size={16} style={rotate ? { transform: `rotate(${rotate}deg)` } : undefined} />
    </button>
  );
}

// Addon management lives in Settings, so this is the body without a page shell.
export function AddonsPanel() {
  const { addons, booting, refreshAddons, notify } = useApp();
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUrl, setPendingUrl] = useState<string | null>(null);
  const [confirmUrl, setConfirmUrl] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<{ url: string; message: string } | null>(null);

  const install = async (raw: string) => {
    setBusy(true);
    setError(null);
    try {
      const target = normalizeUrl(raw);
      const installed = await api.addons.install(target);
      await refreshAddons();
      setUrl("");
      notify(`${installed.name} installed`, "success");
    } catch (e) {
      const message = errorText(e);
      setError(message);
      notify(message, "error");
    } finally {
      setBusy(false);
    }
  };

  const setEnabled = async (addon: AddonInfo, enabled: boolean) => {
    setPendingUrl(addon.url);
    try {
      await api.addons.setEnabled(addon.url, enabled);
      await refreshAddons();
    } catch (e) {
      notify(errorText(e), "error");
      await refreshAddons();
    } finally {
      setPendingUrl(null);
    }
  };

  const remove = async (addon: AddonInfo) => {
    setPendingUrl(addon.url);
    try {
      await api.addons.remove(addon.url);
      await refreshAddons();
      setConfirmUrl(null);
      notify(`${addon.name} removed`);
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setPendingUrl(null);
    }
  };

  const move = async (addon: AddonInfo, delta: number) => {
    setPendingUrl(addon.url);
    try {
      await api.addons.move(addon.url, delta);
      await refreshAddons();
    } catch (e) {
      notify(errorText(e), "error");
    } finally {
      setPendingUrl(null);
    }
  };

  const refresh = async (addon: AddonInfo) => {
    setPendingUrl(addon.url);
    setRefreshError(null);
    try {
      await api.addons.refresh(addon.url);
      await refreshAddons();
    } catch (e) {
      setRefreshError({ url: addon.url, message: errorText(e) });
    } finally {
      setPendingUrl(null);
    }
  };

  const loading = booting || (busy && addons.length === 0);

  return (
    <>
      <section className="install-card">
        <div className="install-copy">
          <h2>Install from URL</h2>
          <p>Paste an addon manifest or transport URL. `manifest.json` is resolved automatically.</p>
        </div>
        <form
          className="install-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!busy && url.trim()) void install(url);
          }}
        >
          <input
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://example.com/manifest.json"
            aria-label="Addon URL"
            aria-invalid={error ? true : undefined}
            spellCheck={false}
            disabled={busy}
          />
          <Button type="submit" variant="primary" icon="download" disabled={busy || !url.trim()}>
            {busy ? "Installing…" : "Install"}
          </Button>
        </form>
        <div className="install-quick">
          <Button
            onClick={() => void install("https://v3-cinemeta.strem.io")}
            disabled={busy}
          >
            Add Cinemeta (metadata only)
          </Button>
          <span>Catalog and metadata addon. Add a stream addon of your choice for playback.</span>
        </div>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
      </section>

      {loading ? <Loading variant="list" label="Loading addons" /> : null}

      {!loading && addons.length === 0 ? (
        <EmptyState
          icon="puzzle"
          title="No addons installed"
          body="Without a catalog addon the home screen stays empty. Without a stream addon, playback has no sources."
        />
      ) : null}

      <div className="addon-list">
        {addons.map((addon, index) => {
          const pending = pendingUrl === addon.url;
          const pendingAny = pendingUrl !== null;
          const confirming = confirmUrl === addon.url;
          const catalogs = catalogCount(addon);
          const configureUrl = addon.configureUrl;

          return (
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
                  {addon.configurationRequired ? <Badge tone="warn">Setup required</Badge> : null}
                  {addon.enabled ? null : <Badge tone="warn">Disabled</Badge>}
                </div>
                <p className="addon-url">{addon.url}</p>
                {addon.description ? <p className="addon-desc">{addon.description}</p> : null}
                <div className="addon-tags">
                  {addon.resources
                    .filter((resource) => RESOURCE_LABELS[resource])
                    .map((resource) => (
                      <Badge key={resource} tone={resource === "stream" ? "accent" : "neutral"}>
                        {RESOURCE_LABELS[resource]}
                      </Badge>
                    ))}
                  {catalogs ? <span className="addon-count">{catalogs}</span> : null}
                </div>
                {refreshError && refreshError.url === addon.url ? (
                  <p className="form-error" role="alert">
                    {refreshError.message}
                  </p>
                ) : null}
              </div>
              <div className="addon-actions" style={{ flexWrap: "wrap", justifyContent: "flex-end" }}>
                {confirming ? (
                  <>
                    <Button
                      variant="danger"
                      icon="trash"
                      disabled={pending}
                      onClick={() => void remove(addon)}
                    >
                      {pending ? "Removing…" : "Remove"}
                    </Button>
                    <Button disabled={pending} onClick={() => setConfirmUrl(null)}>
                      Cancel
                    </Button>
                  </>
                ) : (
                  <>
                    <CardButton
                      icon="chevron"
                      label={`Move ${addon.name} up`}
                      rotate={-90}
                      disabled={pendingAny || index === 0}
                      onClick={() => void move(addon, -1)}
                    />
                    <CardButton
                      icon="chevron"
                      label={`Move ${addon.name} down`}
                      rotate={90}
                      disabled={pendingAny || index === addons.length - 1}
                      onClick={() => void move(addon, 1)}
                    />
                    <CardButton
                      icon="refresh"
                      label={`Refresh ${addon.name}`}
                      disabled={pendingAny}
                      onClick={() => void refresh(addon)}
                    />
                    {configureUrl ? (
                      <Button
                        icon="external"
                        onClick={() =>
                          void openExternal(configureUrl).catch(() =>
                            notify("Could not open the addon settings", "error"),
                          )
                        }
                      >
                        Configure
                      </Button>
                    ) : null}
                    <Toggle
                      checked={addon.enabled}
                      label={`${addon.enabled ? "Disable" : "Enable"} ${addon.name}`}
                      disabled={pending}
                      onChange={(value) => void setEnabled(addon, value)}
                    />
                    <button
                      type="button"
                      className="icon-btn danger"
                      aria-label={`Remove ${addon.name}`}
                      disabled={pending}
                      onClick={() => setConfirmUrl(addon.url)}
                    >
                      <Icon name="trash" size={17} />
                    </button>
                  </>
                )}
              </div>
            </article>
          );
        })}
      </div>

      <footer className="page-note">
        <Icon name="info" size={15} />
        <span>
          P2P/torrent streaming, debrid and media-server support are on the roadmap. This build plays direct
          HTTP sources and local files.
        </span>
      </footer>
    </>
  );
}