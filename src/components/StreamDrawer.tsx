import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { api, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { StreamOption } from "../lib/types";
import { Badge, Button, ContextMenu, EmptyState, Icon } from "./ui";

const FILTER_KEY = "streams.filter";

// The play button keeps the row's column layout; the action menu sits beside it.
const ROW_GRID: CSSProperties = { gridTemplateColumns: "minmax(0, 1fr) auto" };
const PLAY_GRID: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "76px minmax(0, 1fr) 26px",
  gap: 14,
  alignItems: "start",
  padding: 0,
  border: 0,
  background: "none",
  textAlign: "left",
};

function readFilter(): string {
  try {
    return localStorage.getItem(FILTER_KEY) ?? "all";
  } catch {
    return "all";
  }
}

function isBrowsable(url: string) {
  return /^https?:\/\//i.test(url);
}

function copyText(text: string) {
  const clipboard = navigator.clipboard;
  if (!clipboard) return Promise.reject(new Error("Clipboard unavailable"));
  return clipboard.writeText(text);
}

const QUALITY_TONE: Record<string, "accent" | "good" | "neutral" | "warn"> = {
  "4K": "accent",
  "1080p": "good",
  "720p": "neutral",
  "480p": "neutral",
  CAM: "warn",
};

type Group = {
  addon: string;
  streams: StreamOption[];
  state: "loading" | "done" | "error";
  error: string | null;
};

function errorText(error: unknown) {
  const text = error instanceof Error ? error.message : String(error);
  return text.length > 110 ? `${text.slice(0, 110)}…` : text;
}

export function StreamDrawer({
  title,
  subtitle,
  open,
  request,
  onClose,
  onPlay,
}: {
  title: string;
  subtitle?: string;
  open: boolean;
  request: {
    id: string;
    mediaType: string;
    season?: number | null;
    episode?: number | null;
    imdbId?: string | null;
  } | null;
  onClose: () => void;
  onPlay: (stream: StreamOption) => void;
}) {
  const { addons: installed, notify } = useApp();
  const [groups, setGroups] = useState<Group[]>([]);
  const [filter, setFilter] = useState<string>(readFilter);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    title: string;
    url: string;
  } | null>(null);
  const runId = useRef(0);

  const chooseFilter = (next: string) => {
    setFilter(next);
    try {
      localStorage.setItem(FILTER_KEY, next);
    } catch {
      // Storage can be blocked; the choice then lasts for the session only.
    }
  };

  const copyLink = (url: string) => {
    copyText(url)
      .then(() => notify("Stream link copied"))
      .catch(() => notify("Could not copy the stream link", "error"));
  };

  const openLink = (url: string) => {
    void openExternal(url).catch(() => notify("Could not open that link", "error"));
  };

  // Every addon is asked on its own, so the first answer can be shown while
  // the rest are still scraping. One dead addon only costs its own section.
  const load = useCallback(
    (addon: string) => {
      if (!request) return;
      const run = runId.current;
      setGroups((current) =>
        current.map((group) =>
          group.addon === addon ? { ...group, state: "loading", error: null } : group,
        ),
      );
      api
        .streams({ ...request, addon })
        .then((rows) => {
          if (run !== runId.current) return;
          setGroups((current) =>
            current.map((group) =>
              group.addon === addon ? { ...group, streams: rows, state: "done" } : group,
            ),
          );
        })
        .catch((error: unknown) => {
          if (run !== runId.current) return;
          setGroups((current) =>
            current.map((group) =>
              group.addon === addon
                ? { ...group, state: "error", error: errorText(error) }
                : group,
            ),
          );
        });
    },
    [request],
  );

  const targets = useMemo(
    () =>
      installed
        .filter((addon) => addon.enabled && addon.resources.includes("stream"))
        .map((addon) => addon.name),
    [installed],
  );
  const signature = targets.join("|");

  useEffect(() => {
    if (!open || !request) return;
    runId.current += 1;
    // Reopen on the addon the viewer last picked.
    setFilter(readFilter());
    setMenu(null);
    setGroups(
      targets.map((addon) => ({ addon, streams: [], state: "loading", error: null })),
    );
    targets.forEach(load);
    // The request is compared by its parts, not by identity: it is rebuilt on
    // every render by the screen that owns this drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    open,
    request?.id,
    request?.mediaType,
    request?.season,
    request?.episode,
    request?.imdbId,
    signature,
  ]);

  // A remembered addon that is gone from this list must not hide every stream.
  useEffect(() => {
    if (!open || filter === "all") return;
    if (!groups.length || groups.some((group) => group.addon === filter)) return;
    setFilter("all");
  }, [open, filter, groups]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const total = groups.reduce((sum, group) => sum + group.streams.length, 0);
  const settled = groups.every((group) => group.state !== "loading");
  const ranked = (group: Group) =>
    group.streams.length ? 0 : group.state === "error" ? 2 : 1;
  const visible = (filter === "all" ? groups : groups.filter((group) => group.addon === filter))
    .slice()
    // Answers come first, so a slow or failing addon never sits on top of a
    // list that is already ready to play.
    .sort((a, b) => ranked(a) - ranked(b));

  if (!open) return null;

  return (
    <div className="drawer-root">
      <button type="button" className="drawer-backdrop" aria-label="Close" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="Choose a stream">
        <header className="drawer-head">
          <div>
            <p className="drawer-kicker">Sources</p>
            <h2>{title}</h2>
            {subtitle ? <p className="drawer-sub">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="drawer-filters">
          <button
            type="button"
            className={`chip${filter === "all" ? " is-active" : ""}`}
            onClick={() => chooseFilter("all")}
          >
            All <span>{total}</span>
          </button>
          {groups.map((group) => (
            <button
              key={group.addon}
              type="button"
              className={`chip${filter === group.addon ? " is-active" : ""}`}
              onClick={() => chooseFilter(group.addon)}
            >
              {group.addon}{" "}
              <span>{group.state === "loading" ? "…" : group.streams.length}</span>
            </button>
          ))}
        </div>

        <div className="drawer-body">
          {visible.map((group) => (
            <section className="stream-group" key={group.addon}>
              <div className="stream-group-head">
                <span className="stream-group-title">{group.addon}</span>
                <span className="stream-group-state">
                  {group.state === "loading" ? (
                    "Searching…"
                  ) : group.state === "error" ? (
                    <>
                      Failed{" "}
                      <button
                        type="button"
                        className="link-button"
                        onClick={() => load(group.addon)}
                      >
                        Retry
                      </button>
                    </>
                  ) : (
                    `${group.streams.length} ${group.streams.length === 1 ? "source" : "sources"}`
                  )}
                </span>
              </div>

              {group.error ? <p className="stream-group-error">{group.error}</p> : null}

              {group.state === "done" && !group.streams.length && !group.error ? (
                <p className="stream-group-error">No sources for this title.</p>
              ) : null}

              {group.streams.length ? (
                <ul className="stream-list">
                  {group.streams.map((stream, index) => {
                    const url = stream.url?.trim() || null;
                    return (
                      <li key={`${group.addon}-${index}`}>
                        <div className="stream-row" style={ROW_GRID}>
                          <button
                            type="button"
                            style={{ ...PLAY_GRID, opacity: stream.playable ? 1 : 0.4 }}
                            onClick={() => stream.playable && onPlay(stream)}
                            disabled={!stream.playable}
                            aria-label={`Play ${stream.name || stream.title || "source"}`}
                          >
                            <span className="stream-quality">
                              <span
                                className={`quality quality-${QUALITY_TONE[stream.quality] ?? "neutral"}`}
                              >
                                {stream.quality}
                              </span>
                              {stream.cached ? <Badge tone="good">Cached</Badge> : null}
                            </span>
                            <span className="stream-main">
                              <span className="stream-title">
                                {stream.name || stream.title || "Source"}
                              </span>
                              <span className="stream-meta">
                                {stream.size ? <span>{stream.size}</span> : null}
                                {stream.seeders != null ? <span>{stream.seeders} seeds</span> : null}
                                {stream.languages.length ? (
                                  <span>{stream.languages.join(", ")}</span>
                                ) : null}
                              </span>
                              {stream.badges.length ? (
                                <span className="stream-badges">
                                  {stream.badges.map((badge) => (
                                    <Badge key={badge}>{badge}</Badge>
                                  ))}
                                </span>
                              ) : null}
                            </span>
                            <span className="stream-action">
                              {stream.playable ? (
                                <Icon name="play" size={16} />
                              ) : (
                                <span className="stream-locked">P2P soon</span>
                              )}
                            </span>
                          </button>
                          {url ? (
                            <button
                              type="button"
                              className="icon-btn"
                              aria-label="Stream link actions"
                              title="Stream link actions"
                              onClick={(event) =>
                                setMenu({
                                  x: event.clientX,
                                  y: event.clientY,
                                  title: stream.name || stream.title || "Stream",
                                  url,
                                })
                              }
                            >
                              <Icon name="more" size={16} />
                            </button>
                          ) : null}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : null}
            </section>
          ))}

          {menu ? (
            <ContextMenu
              x={menu.x}
              y={menu.y}
              title={menu.title}
              onClose={() => setMenu(null)}
              actions={
                isBrowsable(menu.url)
                  ? [
                      { label: "Copy link", onSelect: () => copyLink(menu.url) },
                      {
                        label: "Open in browser",
                        icon: "external",
                        onSelect: () => openLink(menu.url),
                      },
                    ]
                  : [{ label: "Copy link", onSelect: () => copyLink(menu.url) }]
              }
            />
          ) : null}

          {settled && total === 0 ? (
            <EmptyState
              icon="puzzle"
              title="No sources yet"
              body="Install a stream addon in Addons. Torrent sources play after you allow P2P in Settings → Playback."
              action={<Button onClick={onClose}>Close</Button>}
            />
          ) : null}
        </div>

        <footer className="drawer-foot">
          <span>Streams are provided by your own addons. BetterNuvio ships no content.</span>
        </footer>
      </aside>
    </div>
  );
}
