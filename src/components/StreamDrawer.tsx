import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api, openExternal } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { StreamOption } from "../lib/types";
import { Button, ContextMenu, EmptyState, Icon } from "./ui";

function isBrowsable(url: string) {
  return /^https?:\/\//i.test(url);
}

function copyText(text: string) {
  const clipboard = navigator.clipboard;
  if (!clipboard) return Promise.reject(new Error("Clipboard unavailable"));
  return clipboard.writeText(text);
}

type Group = {
  key: string;
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
  const [filter, setFilter] = useState<string>("all");
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
  const [edges, setEdges] = useState({ left: false, right: false });

  // Which edges still hide chips, so the row can say so and offer a step arrow.
  const measure = useCallback(() => {
    const node = filtersRef.current;
    if (!node) return;
    const rest = node.scrollWidth - node.clientWidth - node.scrollLeft;
    const next = { left: node.scrollLeft > 1, right: rest > 1 };
    setEdges((current) =>
      current.left === next.left && current.right === next.right ? current : next,
    );
  }, []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, open, groups]);

  const step = (direction: number) => {
    const node = filtersRef.current;
    if (!node) return;
    node.scrollBy({ left: direction * node.clientWidth * 0.8, behavior: "smooth" });
  };

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
    // A click drifts a few pixels; only a real drag may pan the row.
    if (!drag.current.moved && Math.abs(dx) < 8) return;
    drag.current.moved = true;
    node.scrollLeft = drag.current.left - dx;
  };

  const endDrag = () => {
    drag.current.down = false;
  };

  const chooseFilter = (next: string) => {
    if (drag.current.moved) {
      drag.current.moved = false;
      return;
    }
    // The chip you are already on clears the filter: there is no All chip.
    setFilter(next === filter ? "all" : next);
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
    (key: string) => {
      if (!request) return;
      const run = runId.current;
      setGroups((current) =>
        current.map((group) =>
          group.key === key ? { ...group, state: "loading", error: null } : group,
        ),
      );
      api
        .streams({ ...request, addon: key })
        .then((rows) => {
          if (run !== runId.current) return;
          setGroups((current) =>
            current.map((group) =>
              group.key === key ? { ...group, streams: rows, state: "done" } : group,
            ),
          );
        })
        .catch((error: unknown) => {
          if (run !== runId.current) return;
          setGroups((current) =>
            current.map((group) =>
              group.key === key
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
        .map((addon) => ({ key: addon.url, name: addon.name })),
    [installed],
  );
  const signature = targets.map((target) => target.key).join("|");

  useEffect(() => {
    if (!open || !request) return;
    runId.current += 1;
    // Always open on every addon: a remembered filter hid the answers that
    // had already arrived and left the panel looking empty.
    setFilter("all");
    setMenu(null);
    setGroups(
      targets.map((target) => ({
        key: target.key,
        addon: target.name,
        streams: [],
        state: "loading",
        error: null,
      })),
    );
    targets.forEach((target) => load(target.key));
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

  // A filter that can no longer show anything must not leave an empty panel.
  useEffect(() => {
    if (!open || filter === "all") return;
    const group = groups.find((item) => item.key === filter);
    if (!group || (group.state !== "loading" && !group.streams.length)) setFilter("all");
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
  // An addon that failed already says so in its own group; the empty state is
  // only for a panel with nothing to report.
  const failed = groups.some((group) => group.error !== null);
  const hasDisabledStreams = installed.some(
    (addon) => !addon.enabled && addon.resources.includes("stream"),
  );
  const emptyBody =
    groups.length > 0
      ? "No stream addon returned a source for this title. Refresh to ask them again."
      : hasDisabledStreams
        ? "Every stream addon is disabled. Enable one in Addons, then refresh the sources."
        : "Install a stream addon in Addons. Torrent sources play after you allow P2P in Settings → Playback.";
  const ranked = (group: Group) =>
    group.streams.length ? 0 : group.state === "error" ? 2 : 1;
  const visible = (filter === "all" ? groups : groups.filter((group) => group.key === filter))
    .slice()
    // Answers come first, so a slow or failing addon never sits on top of a
    // list that is already ready to play.
    .sort((a, b) => ranked(a) - ranked(b));
  // Skeletons stand in for the current view, not the whole set: a filter that
  // is still loading must not render as a blank panel either.
  const shown = visible.reduce((sum, group) => sum + group.streams.length, 0);

  if (!open) return null;

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={subtitle ? `Sources for ${title}, ${subtitle}` : `Sources for ${title}`}
      >
        <div className="drawer-filter-bar">
          <button
            type="button"
            className="filter-step is-left"
            onClick={() => step(-1)}
            disabled={!edges.left}
            aria-label="Earlier addons"
          >
            <Icon name="chevron" size={14} />
          </button>
          <div
            className={`drawer-filters${edges.left ? " can-left" : ""}${edges.right ? " can-right" : ""}`}
            ref={filtersRef}
            onPointerDown={startDrag}
            onPointerMove={moveDrag}
            onPointerUp={endDrag}
            onPointerCancel={endDrag}
            onScroll={measure}
            title="Drag sideways for more addons"
          >
            {targets.length ? (
              <button
                type="button"
                className={`chip chip-icon${pending > 0 ? " is-loading" : ""}`}
                onClick={() => targets.forEach((target) => load(target.key))}
                aria-label="Refresh sources"
                title="Refresh sources"
              >
                <Icon name="refresh" size={14} />
              </button>
            ) : null}
            {groups
              .filter((group) => group.streams.length > 0 || group.state === "loading")
              .map((group) => (
                <button
                  key={group.key}
                  type="button"
                  className={`chip${filter === group.key ? " is-active" : ""}`}
                  aria-pressed={filter === group.key}
                  onClick={() => chooseFilter(group.key)}
                  title={
                    filter === group.key ? "Show every addon" : `Only ${group.addon}`
                  }
                >
                  {group.addon}
                </button>
              ))}
          </div>
          <button
            type="button"
            className="filter-step is-right"
            onClick={() => step(1)}
            disabled={!edges.right}
            aria-label="More addons"
          >
            <Icon name="chevron" size={14} />
          </button>
          <button
            type="button"
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
            ref={closeRef}
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Nothing has answered yet: hold the shape of the list that is
              coming, so the panel never opens as an empty shell. */}
          {shown === 0 && pending > 0 ? (
            <ul className="stream-list" aria-hidden="true">
              {[64, 48, 72].map((width) => (
                <li className="skeleton-card" key={width}>
                  <span className="skeleton-line is-label" style={{ width: `${width}%` }} />
                  <span
                    className="skeleton-line"
                    style={{ width: `${Math.min(width + 20, 94)}%` }}
                  />
                </li>
              ))}
            </ul>
          ) : null}

          {visible.map((group) => (
            <section className="stream-group" key={group.key}>
              {group.error ? (
                <p className="stream-group-error" role="status">
                  {group.addon}: {group.error}
                </p>
              ) : null}

              {group.state === "done" && !group.streams.length && !group.error ? (
                <p className="stream-group-error" role="status">
                  No sources from {group.addon}.
                </p>
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
                      <li key={`${group.key}-${index}`}>
                        <div className="stream-card">
                          <button
                            type="button"
                            className="stream-play"
                            onClick={() => stream.playable && onPlay(stream)}
                            disabled={!stream.playable}
                            title={stream.playable ? undefined : "This source has no playing link"}
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
                            {body && stream.sizeBytes != null && stream.size ? (
                              <span className="stream-size-line">{stream.size}</span>
                            ) : null}
                          </button>
                          {url ? (
                            <button
                              type="button"
                              className="icon-btn stream-more"
                              aria-label="Stream link actions"
                              aria-haspopup="menu"
                              title="Stream link actions"
                              onClick={(event) => {
                                // A keyboard press reports 0,0: anchor the menu
                                // to the button instead of the corner.
                                const box = event.currentTarget.getBoundingClientRect();
                                setMenu({
                                  x: event.clientX || box.left,
                                  y: event.clientY || box.bottom,
                                  title: label,
                                  url,
                                });
                              }}
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

          {settled && total === 0 && !failed ? (
            <EmptyState
              icon="puzzle"
              title="No sources yet"
              body={emptyBody}
              action={<Button onClick={onClose}>Close</Button>}
            />
          ) : null}
        </div>

        <footer className="drawer-foot" role="status">
          {pending > 0 ? (
            <span className="drawer-status">
              <Icon name="refresh" size={12} className="drawer-spin" />
              Loading sources · {groups.length - pending} of {groups.length}{" "}
              {groups.length === 1 ? "addon" : "addons"}
            </span>
          ) : (
            <span>Streams are provided by your own addons. Duvy ships no content.</span>
          )}
        </footer>
      </aside>
    </div>
  );
}
