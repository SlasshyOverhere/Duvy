import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    title: string;
    url: string;
  } | null>(null);
  const runId = useRef(0);
  const drawerRef = useRef<HTMLElement>(null);

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
        : "Install a stream addon in Addons. Torrent sources play after you allow P2P in Settings → Playback.";
  const ranked = (group: Group) =>
    group.streams.length ? 0 : group.state === "error" ? 2 : 1;
  const sortBySize = settings?.sourceSort !== "addon";
  // With size as the order, the addon holding the biggest file leads, so the
  // largest source in the panel is the first row.
  const biggest = (group: Group) =>
    group.streams.reduce((max, stream) => Math.max(max, stream.sizeBytes ?? -1), -1);
  const visible = groups
    .map((group) =>
      sortBySize ? { ...group, streams: group.streams.slice().sort(byFileSize) } : group,
    )
    // Answers come first, so a slow or failing addon never sits on top of a
    // list that is already ready to play.
    .sort((a, b) => ranked(a) - ranked(b) || (sortBySize ? biggest(b) - biggest(a) : 0));
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
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={subtitle ? `Sources for ${title}, ${subtitle}` : `Sources for ${title}`}
      >
        <div className="drawer-filter-bar">
          <button
            type="button"
            className={`drawer-refresh${pending > 0 ? " is-loading" : ""}`}
            onClick={() => targets.forEach((target) => load(target.key))}
            aria-label="Refresh sources"
            title="Refresh sources"
          >
            <Icon name="refresh" size={16} />
          </button>
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

              {group.streams.length ? (
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
                            <span className="stream-title">{label}</span>
                            {showQuality ? (
                              <span className="stream-title-2">{stream.quality}</span>
                            ) : null}
                            {body ? <span className="stream-detail">{body}</span> : null}
                            {hasMeta ? (
                              <span className="stream-meta">
                                {stream.seeders != null ? (
                                  <span className="stream-seeds">
                                    {stream.seeders.toLocaleString()}
                                  </span>
                                ) : null}
                                {stream.size ? (
                                  <span className="stream-size">{stream.size}</span>
                                ) : null}
                                {stream.badges.map((badge) => (
                                  <span key={badge}>{badge}</span>
                                ))}
                                {stream.cached ? <span className="stream-cached">Cached</span> : null}
                              </span>
                            ) : null}
                            {audio ? <span className="stream-audio">{audio}</span> : null}
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
