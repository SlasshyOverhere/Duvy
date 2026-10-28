import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { StreamOption } from "../lib/types";
import { Button, ContextMenu, EmptyState, Icon } from "./ui";

const FILTER_KEY = "streams.filter";

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
  const drawerRef = useRef<HTMLElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const filtersRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ down: false, moved: false, x: 0, left: 0 });

  // The filter row is wider than the panel and a mouse has no sideways wheel,
  // so the row itself is draggable.
  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const node = filtersRef.current;
    if (!node) return;
    drag.current = { down: true, moved: false, x: event.clientX, left: node.scrollLeft };
  };

  const moveDrag = (event: PointerEvent<HTMLDivElement>) => {
    const node = filtersRef.current;
    if (!node || !drag.current.down) return;
    if (event.buttons === 0) {
      drag.current.down = false;
      return;
    }
    const dx = event.clientX - drag.current.x;
    if (Math.abs(dx) > 4) drag.current.moved = true;
    node.scrollLeft = drag.current.left - dx;
  };

  const endDrag = () => {
    drag.current.down = false;
  };

  const chooseFilter = (next: string) => {
    if (drag.current.moved) return;
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

  // Focus moves into the drawer on open and back to the opener on close, and
  // Tab stays inside it: it is a modal surface, so the page behind is off limits.
  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    return () => {
      opener?.focus?.();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const node = drawerRef.current;
      if (!node) return;
      const items = Array.from(
        node.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select, textarea, [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((item) => item.offsetParent !== null);
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const total = groups.reduce((sum, group) => sum + group.streams.length, 0);
  const settled = groups.every((group) => group.state !== "loading");
  const pending = groups.filter((group) => group.state === "loading").length;
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
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label="Choose a stream"
      >
        <header className="drawer-head">
          <div>
            <p className="drawer-kicker">Sources</p>
            <h2>{title}</h2>
            {subtitle ? <p className="drawer-sub">{subtitle}</p> : null}
          </div>
          <button
            type="button"
            className="icon-btn"
            onClick={onClose}
            aria-label="Close"
            ref={closeRef}
          >
            <Icon name="x" size={18} />
          </button>
        </header>

        <div className="drawer-filters" ref={filtersRef} onPointerDown={startDrag} onPointerMove={moveDrag} onPointerUp={endDrag} onPointerCancel={endDrag}>
          <button
            type="button"
            className={`chip chip-icon${pending > 0 ? " is-loading" : ""}`}
            onClick={() => targets.forEach(load)}
            aria-label="Refresh sources"
            title="Refresh sources"
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            type="button"
            className={`chip${filter === "all" ? " is-active" : ""}`}
            aria-pressed={filter === "all"}
            onClick={() => chooseFilter("all")}
          >
            All
          </button>
          {groups
            .filter((group) => group.streams.length > 0 || group.state === "loading")
            .map((group) => (
              <button
                key={group.addon}
                type="button"
                className={`chip${filter === group.addon ? " is-active" : ""}`}
                aria-pressed={filter === group.addon}
                onClick={() => chooseFilter(group.addon)}
              >
                {group.addon}
              </button>
            ))}
        </div>

        <div className="drawer-body">
          {visible.map((group) => (
            <section className="stream-group" key={group.addon}>
              {/* A filtered list is already one addon; repeating its name above
                  every group costs a line the viewer does not need. */}
              {filter === "all" || group.state !== "done" || group.streams.length === 0 ? (
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
              ) : null}

              {group.error ? <p className="stream-group-error">{group.error}</p> : null}

              {group.state === "done" && !group.streams.length && !group.error ? (
                <p className="stream-group-error">No sources for this title.</p>
              ) : null}

              {group.streams.length ? (
                <ul className="stream-list">
                  {group.streams.map((stream, index) => {
                    const url = stream.url?.trim() || null;
                    // Addons put the useful text in different places: MediaFusion
                    // writes a multi-line description, Torrentio writes a title.
                    const detail = (stream.description || stream.title || "").trim();
                    const label =
                      stream.name?.trim() || detail.split("\n")[0].trim() || "Source";
                    const body = detail.startsWith(label)
                      ? detail.slice(label.length).trim()
                      : detail;
                    const showQuality =
                      stream.quality !== "Auto" &&
                      !label.toLowerCase().includes(stream.quality.toLowerCase());
                    const audio = stream.languages.length
                      ? stream.languages.includes("Multi")
                        ? "Multi audio"
                        : stream.languages.slice(0, 3).join(", ")
                      : null;
                    const hasMeta = Boolean(
                      stream.size ||
                        stream.seeders != null ||
                        stream.badges.length ||
                        stream.cached,
                    );
                    return (
                      <li key={`${group.addon}-${index}`}>
                        <div className="stream-card">
                          <button
                            type="button"
                            className="stream-play"
                            onClick={() => stream.playable && onPlay(stream)}
                            disabled={!stream.playable}
                            aria-label={`Play ${label}`}
                          >
                            <span className="stream-head">
                              <span className="stream-label">{label}</span>
                              {showQuality ? (
                                <span className="stream-quality">{stream.quality}</span>
                              ) : null}
                            </span>
                            {body ? (
                              <span className="stream-detail">{body}</span>
                            ) : (
                              <>
                                {hasMeta ? (
                                  <span className="stream-meta">
                                    {stream.size ? (
                                      <span className="stream-size">{stream.size}</span>
                                    ) : null}
                                    {stream.seeders != null ? (
                                      <span className="stream-seeds">
                                        {stream.seeders.toLocaleString()} seeds
                                      </span>
                                    ) : null}
                                    {stream.badges.map((badge) => (
                                      <span key={badge}>{badge}</span>
                                    ))}
                                    {stream.cached ? (
                                      <span className="stream-cached">Cached</span>
                                    ) : null}
                                  </span>
                                ) : null}
                                {audio ? <span className="stream-audio">{audio}</span> : null}
                              </>
                            )}
                            {stream.sizeBytes != null && stream.size ? (
                              <span className="stream-size-line">SIZE {stream.size}</span>
                            ) : null}
                          </button>
                          {url ? (
                            <button
                              type="button"
                              className="icon-btn stream-more"
                              aria-label="Stream link actions"
                              title="Stream link actions"
                              onClick={(event) =>
                                setMenu({
                                  x: event.clientX,
                                  y: event.clientY,
                                  title: label,
                                  url,
                                })
                              }
                            >
                              <Icon name="more" size={15} />
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
          {pending > 0 ? (
            <span className="drawer-progress">
              <span className="drawer-track">
                <span
                  className="drawer-fill"
                  style={{
                    width: `${Math.round(((groups.length - pending) / groups.length) * 100)}%`,
                  }}
                />
              </span>
              <span>
                {pending} {pending === 1 ? "addon" : "addons"} still loading
              </span>
            </span>
          ) : (
            <span>Streams are provided by your own addons. BetterNuvio ships no content.</span>
          )}
        </footer>
      </aside>
    </div>
  );
}
