import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Badge, Button, Icon, Loading } from "../../components/ui";

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
  seriesId?: string | null;
  seriesName?: string | null;
  season?: number | null;
  episode?: number | null;
};

type Kind = "jellyfin" | "emby";

function message(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function kindLabel(kind: string) {
  return kind === "emby" ? "Emby" : "Jellyfin";
}

function playable(item: ServerItem) {
  return item.kind === "Movie" || item.kind === "Episode";
}

function episodeLabel(item: ServerItem) {
  const season = item.season != null ? `S${item.season}` : "";
  const episode = item.episode != null ? `E${item.episode}` : "";
  return `${season}${episode}`;
}

function caption(item: ServerItem) {
  if (item.kind === "Episode") {
    return [item.seriesName, episodeLabel(item)].filter(Boolean).join(" · ");
  }
  const kind = item.kind === "Series" ? "Show" : item.kind === "Season" ? "Season" : "Movie";
  return [kind, item.year].filter(Boolean).join(" · ");
}

function playTitle(item: ServerItem) {
  if (item.kind !== "Episode") return item.name;
  return [item.seriesName, episodeLabel(item), item.name].filter(Boolean).join(" · ");
}

function Poster({
  item,
  playing,
  onPlay,
  onOpen,
}: {
  item: ServerItem;
  playing: boolean;
  onPlay: () => void;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const canPlay = playable(item);

  return (
    <article className="poster-card">
      <div className="poster-frame">
        {failed ? (
          <div className="poster-fallback" style={{ color: "var(--faint)" }}>
            <Icon name={item.kind === "Episode" || item.kind === "Movie" ? "film" : "tv"} size={20} />
          </div>
        ) : (
          // Jellyfin serves artwork behind the user session, so this URL carries
          // no token: servers that allow anonymous images show the poster, the
          // rest fall back to the placeholder above.
          <img src={item.image} alt="" loading="lazy" onError={() => setFailed(true)} />
        )}
        <button
          type="button"
          className="poster-play"
          aria-label={`${canPlay ? "Play" : "Open"} ${item.name}`}
          title={`${canPlay ? "Play" : "Open"} ${item.name}`}
          disabled={playing}
          onClick={canPlay ? onPlay : onOpen}
        >
          <Icon name={canPlay ? "play" : "chevron"} size={17} />
        </button>
      </div>
      <div className="poster-caption">
        <span className="poster-name">{item.name}</span>
        <span className="poster-sub">{caption(item)}</span>
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
  const [trail, setTrail] = useState<ServerItem[]>([]);
  const [items, setItems] = useState<ServerItem[]>([]);
  const [browsing, setBrowsing] = useState(false);
  const [browseError, setBrowseError] = useState<string | null>(null);
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

  const closeBrowse = () => {
    setBrowseId(null);
    setTrail([]);
    setItems([]);
    setBrowseError(null);
  };

  const loadItems = async (serverId: string, parent?: ServerItem) => {
    setBrowsing(true);
    setBrowseError(null);
    setItems([]);
    try {
      setItems(
        await invoke<ServerItem[]>(
          "srv_items",
          parent ? { id: serverId, parentId: parent.id } : { id: serverId },
        ),
      );
    } catch (e) {
      setBrowseError(message(e));
    } finally {
      setBrowsing(false);
    }
  };

  const add = async () => {
    setBusy("add");
    setError(null);
    try {
      setServers(await invoke<Server[]>("srv_add", { kind, url, username, password }));
      setUrl("");
      setUsername("");
      setPassword("");
      closeBrowse();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const remove = async (id: string) => {
    if (!window.confirm("Remove this media server? Its saved sign-in is deleted.")) return;
    setBusy(id);
    setError(null);
    try {
      setServers(await invoke<Server[]>("srv_remove", { id }));
      if (browseId === id) closeBrowse();
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(null);
    }
  };

  const browse = async (server: Server) => {
    if (browseId === server.id) {
      closeBrowse();
      return;
    }
    setBrowseId(server.id);
    setTrail([]);
    await loadItems(server.id);
  };

  const open = async (item: ServerItem) => {
    if (!browseId) return;
    setTrail((previous) => [...previous, item]);
    await loadItems(browseId, item);
  };

  const up = async () => {
    if (!browseId || trail.length === 0) return;
    const next = trail.slice(0, -1);
    setTrail(next);
    await loadItems(browseId, next[next.length - 1]);
  };

  const play = async (serverId: string, item: ServerItem) => {
    setPlaying(item.id);
    setError(null);
    try {
      const streamUrl = await invoke<string>("srv_stream", {
        id: serverId,
        itemId: item.id,
      });
      await invoke("player_open", { request: { url: streamUrl, title: playTitle(item) } });
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

        {loading ? <Loading variant="list" label="Reading media servers" count={2} /> : null}

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
              <div style={{ marginTop: 18 }}>
                <div className="field-row" style={{ margin: 0, alignItems: "center" }}>
                  {trail.length > 0 ? (
                    <Button icon="back" onClick={() => void up()}>
                      Back
                    </Button>
                  ) : null}
                  <span className="settings-hint" style={{ margin: 0 }}>
                    {trail.length > 0
                      ? trail.map((entry) => entry.name).join(" / ")
                      : "Movies and shows"}
                  </span>
                </div>

                {browseError ? (
                  <div style={{ marginTop: 12 }}>
                    <p className="form-error">{browseError}</p>
                    <Button
                      icon="refresh"
                      onClick={() => void loadItems(server.id, trail[trail.length - 1])}
                    >
                      Try again
                    </Button>
                  </div>
                ) : browsing ? (
                  <Loading variant="grid" label="Loading library" count={6} />
                ) : items.length === 0 ? (
                  <p className="settings-hint">
                    {trail.length > 0
                      ? `No seasons or episodes in ${trail[trail.length - 1].name}.`
                      : "That library returned no movies or shows."}
                  </p>
                ) : (
                  <div className="grid" style={{ marginTop: 18 }}>
                    {items.map((item) => (
                      <Poster
                        key={item.id}
                        item={item}
                        playing={playing === item.id}
                        onPlay={() => void play(server.id, item)}
                        onOpen={() => void open(item)}
                      />
                    ))}
                  </div>
                )}
              </div>
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
