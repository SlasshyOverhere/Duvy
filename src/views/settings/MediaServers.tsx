import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Icon, Spinner } from "../../components/ui";

type Server = {
  id: string;
  kind: string;
  name: string;
  url: string;
  username: string;
};

type ServerItem = {
  id: string;
  name: string;
  kind: string;
  year: number | null;
  image: string;
};

type Kind = "jellyfin" | "emby";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function kindLabel(kind: string) {
  return kind === "emby" ? "Emby" : "Jellyfin";
}

function Poster({
  item,
  playing,
  onPlay,
}: {
  item: ServerItem;
  playing: boolean;
  onPlay: () => void;
}) {
  const [failed, setFailed] = useState(false);

  return (
    <article className="poster-card">
      <div className="poster-frame">
        {failed ? (
          <div className="poster-fallback" style={{ color: "var(--faint)" }}>
            <Icon name="film" size={20} />
          </div>
        ) : (
          // Jellyfin serves artwork behind the user session, so this URL carries
          // no token: servers that allow anonymous images show the poster, the
          // rest fall back to the placeholder above.
          <img src={item.image} alt="" loading="lazy" onError={() => setFailed(true)} />
        )}
        {item.kind === "Movie" ? (
          <button
            type="button"
            className="poster-play"
            aria-label={`Play ${item.name}`}
            title={`Play ${item.name}`}
            disabled={playing}
            onClick={onPlay}
          >
            <Icon name="play" size={17} />
          </button>
        ) : null}
      </div>
      <div className="poster-caption">
        <span className="poster-name">{item.name}</span>
        <span className="poster-sub">
          {[item.kind === "Series" ? "Series" : "Film", item.year].filter(Boolean).join(" · ")}
        </span>
      </div>
    </article>
  );
}

/**
 * Jellyfin and Emby accounts plus a library browser.
 *
 * Sign-in happens once per server; the token stays in the Rust-side store and
 * only the account shape crosses the bridge.
 */
export function MediaServers() {
  const [servers, setServers] = useState<Server[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const [kind, setKind] = useState<Kind>("jellyfin");
  const [url, setUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");

  const [browseId, setBrowseId] = useState<string | null>(null);
  const [items, setItems] = useState<ServerItem[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [playing, setPlaying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setServers(await invoke<Server[]>("srv_list"));
      setError(null);
    } catch (e) {
      setError(message(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    setBusy("add");
    setError(null);
    try {
      setServers(await invoke<Server[]>("srv_add", { kind, url, username, password }));
      setUrl("");
      setUsername("");
      setPassword("");
      setBrowseId(null);
      setItems([]);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      setServers(await invoke<Server[]>("srv_remove", { id }));
      if (browseId === id) {
        setBrowseId(null);
        setItems([]);
      }
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const browse = async (server: Server) => {
    if (browseId === server.id) {
      setBrowseId(null);
      setItems([]);
      return;
    }
    setError(null);
    setBrowsing(true);
    setBrowseId(server.id);
    setItems([]);
    try {
      setItems(await invoke<ServerItem[]>("srv_items", { id: server.id }));
    } catch (e) {
      setError(message(e));
      setBrowseId(null);
    } finally {
      setBrowsing(false);
    }
  };

  const play = async (serverId: string, item: ServerItem) => {
    setPlaying(item.id);
    setError(null);
    try {
      const streamUrl = await invoke<string>("srv_stream", {
        id: serverId,
        itemId: item.id,
      });
      await invoke("player_open", { request: { url: streamUrl, title: item.name } });
    } catch (e) {
      setError(message(e));
    } finally {
      setPlaying(null);
    }
  };

  return (
    <>
      {error ? <p className="form-error">{error}</p> : null}

      <section className="settings-group">
        <h2>Media servers</h2>
        <p className="settings-hint">
          Browse a Jellyfin or Emby library without leaving the app. The password is only used to
          sign in; the access token stays in the local database.
        </p>

        {loading ? <Spinner label="Reading media servers…" /> : null}

        {!loading && servers.length === 0 ? (
          <p className="settings-hint" style={{ marginBottom: 0 }}>
            No servers yet. Add one below.
          </p>
        ) : null}

        {servers.map((server) => (
          <div key={server.id}>
            <div className="settings-row">
              <div>
                <h3>{server.name}</h3>
                <p>
                  {server.url} · {server.username}
                </p>
              </div>
              <div className="field-row" style={{ margin: 0 }}>
                <Badge tone="neutral">{kindLabel(server.kind)}</Badge>
                <Button
                  icon="library"
                  onClick={() => void browse(server)}
                  disabled={browsing && browseId !== server.id}
                >
                  {browseId === server.id ? "Hide" : "Browse"}
                </Button>
                <Button
                  variant="danger"
                  icon="trash"
                  onClick={() => void remove(server.id)}
                  disabled={busy === server.id}
                >
                  Remove
                </Button>
              </div>
            </div>

            {browseId === server.id ? (
              browsing ? (
                <Spinner label="Loading library…" />
              ) : items.length === 0 ? (
                <p className="settings-hint">That library returned no movies or series.</p>
              ) : (
                <div className="grid" style={{ marginTop: 18 }}>
                  {items.map((item) => (
                    <Poster
                      key={item.id}
                      item={item}
                      playing={playing === item.id}
                      onPlay={() => void play(server.id, item)}
                    />
                  ))}
                </div>
              )
            ) : null}
          </div>
        ))}
      </section>

      <section className="settings-group">
        <h2>Add a server</h2>
        <p className="settings-hint">
          Use the address of the server itself, port included. The same account you use in the
          Jellyfin or Emby app works here.
        </p>

        <div className="field">
          <span>Kind</span>
          <div className="field-row" style={{ marginTop: 0 }}>
            {(["jellyfin", "emby"] as Kind[]).map((value) => (
              <button
                key={value}
                type="button"
                className={`chip${kind === value ? " is-active" : ""}`}
                onClick={() => setKind(value)}
              >
                {kindLabel(value)}
              </button>
            ))}
          </div>
        </div>

        <div className="field-grid">
          <label className="field">
            <span>Address</span>
            <input
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              placeholder="http://192.168.1.10:8096"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Username</span>
            <input
              value={username}
              onChange={(event) => setUsername(event.target.value)}
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
              placeholder="Never stored"
              autoComplete="current-password"
            />
          </label>
        </div>

        <div className="field-row">
          <Button
            variant="primary"
            icon="plus"
            onClick={() => void add()}
            disabled={busy === "add" || !url.trim() || !username.trim()}
          >
            {busy === "add" ? "Signing in…" : "Add server"}
          </Button>
        </div>

        <p className="settings-note">
          <Icon name="info" size={14} />
          <span>
            Posters are loaded without a token, so a server that hides artwork from anonymous
            visitors shows an empty frame. Stream links stay on this machine and go straight to mpv.
          </span>
        </p>
      </section>
    </>
  );
}

export default MediaServers;
