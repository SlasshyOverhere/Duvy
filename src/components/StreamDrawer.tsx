import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from "react";
import { api, openExternal } from "../lib/bridge";
import { byFileSize, errorMessage } from "../lib/format";
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
  const text = errorMessage(error);
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
  const { addons: installed, notify, settings } = useApp();
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
  const filtersRef = useRef<HTMLDivElement>(null);
  const drag = useRef({ down: false, moved: false, x: 0, left: 0, pointer: -1 });

  // Which edges still hide chips, so the row can say so and offer a step arrow.
  // The classes are toggled on the node directly: keeping this in React state
  // re-rendered the whole panel, stream cards included, on every scroll frame.
  const measureFrame = useRef(0);
  const measure = useCallback(() => {
    if (measureFrame.current) return;
    measureFrame.current = requestAnimationFrame(() => {
      measureFrame.current = 0;
      const node = filtersRef.current;
      if (!node) return;
      // No edge bookkeeping mid-drag: it is a layout read per frame and the
      // fade is switched off anyway while the row is being dragged.
      if (drag.current.down) return;
      const rest = node.scrollWidth - node.clientWidth - node.scrollLeft;
      node.classList.toggle("can-left", node.scrollLeft > 1);
      node.classList.toggle("can-right", rest > 1);
    });
  }, []);

  useEffect(() => () => cancelAnimationFrame(measureFrame.current), []);

  useEffect(() => {
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [measure, open, groups]);

  // The filter row is wider than the panel and a mouse has no sideways wheel,
  // so the row itself is draggable. The pointer is tracked on window rather
  // than the row: the row is only a chip tall, so a drag that drifted a pixel
  // off it used to stop dead halfway through.
  const onDragMove = useCallback((event: globalThis.PointerEvent) => {
    const node = filtersRef.current;
    if (!node || !drag.current.down || event.pointerId !== drag.current.pointer) return;
    const dx = event.clientX - drag.current.x;
    if (!drag.current.moved) {
      // A click drifts a few pixels; only a real drag may pan the row.
      if (Math.abs(dx) < 4) return;
      drag.current.moved = true;
      // Re-anchor so the row does not jump by the dead-zone distance.
      drag.current.x = event.clientX;
      drag.current.left = node.scrollLeft;
      // The edge fade is a mask over the scrolled content: left on, it makes
      // the row re-rasterise on every frame of the drag. measure() restores it.
      node.classList.remove("can-left", "can-right");
      return;
    }
    node.scrollLeft = drag.current.left - (event.clientX - drag.current.x);
  }, []);

  const onDragUp = useCallback(
    (event: globalThis.PointerEvent) => {
      if (drag.current.pointer !== -1 && event.pointerId !== drag.current.pointer) return;
      drag.current.down = false;
      drag.current.pointer = -1;
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragUp);
      window.removeEventListener("pointercancel", onDragUp);
      measure();
    },
    [onDragMove, measure],
  );

  const startDrag = (event: PointerEvent<HTMLDivElement>) => {
    const node = filtersRef.current;
    if (!node || event.button !== 0) return;
    // Touch and pen already pan a scroller natively. Driving scrollLeft from
    // pointermove on top of that fights the browser's own gesture, which reads
    // as lag and stalling, so the manual drag is for the mouse only.
    if (event.pointerType !== "mouse") return;
    drag.current = {
      down: true,
      moved: false,
      x: event.clientX,
      left: node.scrollLeft,
      pointer: event.pointerId,
    };
    window.addEventListener("pointermove", onDragMove);
    window.addEventListener("pointerup", onDragUp);
    window.addEventListener("pointercancel", onDragUp);
  };

  useEffect(() => {
    return () => {
      window.removeEventListener("pointermove", onDragMove);
      window.removeEventListener("pointerup", onDragUp);
      window.removeEventListener("pointercancel", onDragUp);
    };
  }, [onDragMove, onDragUp]);

  const chooseFilter = (next: string) => {
    if (drag.current.moved) {
      drag.current.moved = false;
      return;
    }
    // No All chip: tapping the active addon clears back to every addon.
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
        .map((addon) => ({ key: addon.url, name: addon.name, logo: addon.logo ?? null })),
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
    // The panel takes focus, not its close button: a dialog that opens with an
    // amber ring on the X reads as an error the moment it appears.
    drawerRef.current?.focus({ preventScroll: true });
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
      if (event.shiftKey && (document.activeElement === first || document.activeElement === node)) {
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
        : "Install a stream addon in Addons. Torrent sources need a debrid account in Settings → Integrations.";
  const ranked = (group: Group) =>
    group.streams.length ? 0 : group.state === "error" ? 2 : 1;
  const sortBySize = settings?.sourceSort !== "addon";
  // With size as the order, the addon holding the biggest file leads, so the
  // largest source in the panel is the first row.
  const biggest = (group: Group) =>
    group.streams.reduce((max, stream) => Math.max(max, stream.sizeBytes ?? -1), -1);
  const visible = (filter === "all" ? groups : groups.filter((group) => group.key === filter))
    .map((group) =>
      sortBySize ? { ...group, streams: group.streams.slice().sort(byFileSize) } : group,
    )
    // Answers come first, so a slow or failing addon never sits on top of a
    // list that is already ready to play.
    .sort((a, b) => ranked(a) - ranked(b) || (sortBySize ? biggest(b) - biggest(a) : 0));
  // Skeletons stand in for the current view, not the whole set: a filter that
  // is still loading must not render as a blank panel either.
  const shown = visible.reduce((sum, group) => sum + group.streams.length, 0);
  const chipKeys = groups
    .filter((group) => group.streams.length > 0 || group.state === "loading")
    .map((group) => group.key);

  if (!open) return null;

  return (
    <div className="drawer-root">
      <div className="drawer-backdrop" aria-hidden="true" onClick={onClose} />
      <aside
        ref={drawerRef}
        className="drawer"
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={subtitle ? `Sources for ${title}, ${subtitle}` : `Sources for ${title}`}
      >
        <div className="drawer-filter-bar">
          <button
            type="button"
            className={`drawer-refresh${pending > 0 ? " is-loading" : ""}`}
            onClick={() => {
              // A refresh starts a new run, so answers from the old one are stale.
              runId.current += 1;
              targets.forEach((target) => load(target.key));
            }}
            aria-label="Refresh sources"
            title="Refresh sources"
          >
            <Icon name="refresh" size={16} />
          </button>
          <div
            className="drawer-filters"
            ref={filtersRef}
            onPointerDown={startDrag}
            onScroll={measure}
            onKeyDown={(event) => {
              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
              if (!step || !chipKeys.length) return;
              event.preventDefault();
              const at = chipKeys.indexOf(filter);
              const next =
                at < 0
                  ? chipKeys[step > 0 ? 0 : chipKeys.length - 1]
                  : chipKeys[(at + step + chipKeys.length) % chipKeys.length];
              setFilter(next);
              const chip = filtersRef.current?.querySelector<HTMLElement>(
                `[data-chip="${CSS.escape(next)}"]`,
              );
              chip?.focus();
              chip?.scrollIntoView({ block: "nearest", inline: "nearest" });
            }}
            title="Drag sideways for more addons"
          >
            {groups
              .filter((group) => group.streams.length > 0 || group.state === "loading")
              .map((group) => (
                <button
                  key={group.key}
                  type="button"
                  data-chip={group.key}
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
            className="drawer-close"
            onClick={onClose}
            aria-label="Close"
          >
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="drawer-scrapers">
          <span className="drawer-scrapers-label">Active addons</span>
          <div className="drawer-scrapers-row">
            {targets.map((target) => {
              const group = groups.find((item) => item.key === target.key);
              const state = group?.state ?? "loading";
              const count = group?.streams.length ?? 0;
              return (
                <span
                  key={target.key}
                  className={`scraper-pill${state === "error" ? " is-error" : ""}${state === "done" && count === 0 ? " is-empty" : ""}`}
                  title={
                    state === "loading"
                      ? "Searching"
                      : state === "error"
                        ? (group?.error ?? "Failed")
                        : count === 0
                          ? "No sources"
                          : `${count} sources`
                  }
                >
                  {state === "loading" ? (
                    <Icon name="refresh" size={11} />
                  ) : state === "error" ? (
                    <Icon name="alert" size={11} />
                  ) : count > 0 ? (
                    <Icon name="check" size={11} />
                  ) : null}
                  {target.name}
                </span>
              );
            })}
          </div>
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

              {total > 0 && group.state === "done" && !group.streams.length && !group.error ? (
                <p className="stream-group-error" role="status">
                  No sources from {group.addon}.
                </p>
              ) : null}

              {filter === "all" && group.streams.length ? (
                <h3 className="stream-group-title">{group.addon}</h3>
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
                      !label.toLowerCase().includes(stream.quality.toLowerCase()) &&
                      !(
                        /2160p|1080p|720p|480p|360p|4k|uhd/.test(label.toLowerCase()) &&
                        /^(4k|1080p|720p|480p|cam)$/i.test(stream.quality)
                      );
                    const bodyLines = body
                      ? body
                          .split("\n")
                          .map((line) => line.replace(/\s+/g, " ").trim())
                          .filter(Boolean)
                      : [];
                    const detailHasAudio = bodyLines.some((line) => /audio\s*:/i.test(line));
                    const audio = detailHasAudio
                      ? null
                      : stream.languages.length
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
                    // A run of seeds/size tokens in the addon's own line is the
                    // meta row in text form; keep the parsed row instead.
                    const shownLines = bodyLines.filter((line) => {
                      const upper = line.toUpperCase();
                      const looksMeta = /👤|💾|⚙️/.test(line) && upper.includes("GB") || /SEED/.test(upper) && upper.includes("GB");
                      return !looksMeta;
                    });
                    const shown = shownLines.length ? shownLines : bodyLines;
                    const addonLogo = targets.find((target) => target.key === group.key)?.logo ?? null;
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
                            <span className="stream-main">
                              <span className="stream-texts">
                                <span className="stream-title">{label}</span>
                                {showQuality ? (
                                  <span className="stream-title-2">{stream.quality}</span>
                                ) : null}
                                {shown.length ? (
                                  <span className="stream-details">
                                    {shown.map((line, at) => (
                                      <span className="stream-detail" key={at}>
                                        {line}
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                                {hasMeta ? (
                                  <span className="stream-meta">
                                    {stream.seeders != null ? (
                                      <span className="stream-seeds">
                                        👤 {stream.seeders.toLocaleString()}
                                      </span>
                                    ) : null}
                                    {stream.size ? (
                                      <span className="stream-size">💾 {stream.size}</span>
                                    ) : null}
                                    {stream.badges.map((badge) => (
                                      <span key={badge}>{badge}</span>
                                    ))}
                                    {stream.cached ? <span className="stream-cached">Cached</span> : null}
                                  </span>
                                ) : null}
                                {audio ? <span className="stream-audio">{audio}</span> : null}
                              </span>
                              <span className="stream-brand" aria-hidden="true">
                                {addonLogo ? (
                                  <img
                                    className="stream-brand-logo"
                                    src={addonLogo}
                                    alt=""
                                    onError={(event) => {
                                      event.currentTarget.style.display = "none";
                                    }}
                                  />
                                ) : (
                                  <span className="stream-brand-mark">
                                    {group.addon.trim().charAt(0).toUpperCase()}
                                  </span>
                                )}
                                <span className="stream-brand-name">{group.addon}</span>
                              </span>
                            </span>
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
