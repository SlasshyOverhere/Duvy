import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, openExternal } from "../lib/bridge";
import { byFileSize, errorMessage } from "../lib/format";
import { useApp } from "../lib/store";
import type { StreamOption } from "../lib/types";
import { Button, ContextMenu, EmptyState, Icon } from "./ui";

function isBrowsable(url: string) {
  return /^https?:\/\//i.test(url);
}

const RESOLUTION = /\b(2160p|1080p|720p|480p|360p|4k|uhd)\b/i;

function splitSourceLabel(label: string) {
  const match = label.match(RESOLUTION);
  if (!match) return { label, quality: "" };
  const cleaned = label
    .replace(RESOLUTION, "")
    .replace(/\s*[·|]\s*(?=[·|]|$)/g, "")
    .replace(/^[\s·|,–-]+|[\s·|,–-]+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
  return { label: cleaned || label, quality: match[0] };
}

function formatQuality(value: string) {
  return value.replace(/4k/i, "4K").replace(/uhd/i, "UHD");
}

function tidySourceDetail(lines: string[], stream: StreamOption) {
  const size = stream.size?.toLowerCase();
  const parts = lines.flatMap((line) =>
    line
      .split(/\s*[·|•]\s*/)
      .map((part) => part.trim())
      .filter(Boolean),
  );
  const kept = parts.filter((part) => {
    const lower = part.toLowerCase();
    if (size && lower === size) return false;
    if (stream.cached && /^cached$/.test(lower)) return false;
    return true;
  });
  return [...new Set(kept)].join(" · ");
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
  const [picker, setPicker] = useState(false);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    title: string;
    url: string;
  } | null>(null);
  const runId = useRef(0);
  const drawerRef = useRef<HTMLElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const pickerButtonRef = useRef<HTMLButtonElement>(null);
  const activeKey = useRef<string | null>(null);
  const targetKeys = useRef<string[]>([]);

  const targets = useMemo(
    () =>
      installed
        .filter((addon) => addon.enabled && addon.resources.includes("stream"))
        .map((addon) => ({ key: addon.url, name: addon.name })),
    [installed],
  );
  const signature = targets.map((target) => target.key).join("|");
  const requestKey = request
    ? [
        request.id,
        request.mediaType,
        request.season ?? "",
        request.episode ?? "",
        request.imdbId ?? "",
      ].join("|")
    : "";

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

  // A new title opens on All. Answers from each addon stay in their own
  // section, in install order, so a late scraper never jumps over one that
  // already answered.
  useEffect(() => {
    if (!open || !request) {
      activeKey.current = null;
      targetKeys.current = [];
      return;
    }
    if (activeKey.current === requestKey) return;
    activeKey.current = requestKey;
    targetKeys.current = targets.map((target) => target.key);
    runId.current += 1;
    setFilter("all");
    setPicker(false);
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
    // The request is compared by its parts, not identity: it is rebuilt on
    // every render by the screen that owns this drawer.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, requestKey]);

  // Addons can finish loading while the panel is open. Add their section and
  // keep every answer and the selected filter already on screen.
  useEffect(() => {
    if (!open || activeKey.current === null) return;
    const next = targets.map((target) => target.key);
    const prev = targetKeys.current;
    if (prev.length === next.length && prev.every((key, at) => key === next[at])) return;
    const before = new Set(prev);
    const after = new Set(next);
    const added = targets.filter((target) => !before.has(target.key));
    targetKeys.current = next;
    setGroups((current) => {
      const known = new Map(current.map((group) => [group.key, group]));
      return targets.map(
        (target) =>
          known.get(target.key) ?? {
            key: target.key,
            addon: target.name,
            streams: [],
            state: "loading",
            error: null,
          },
      );
    });
    added.forEach((target) => load(target.key));
    setFilter((current) => (current === "all" || after.has(current) ? current : "all"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, signature]);

  // The picker is a small listbox: outside clicks close it, Escape belongs to
  // it while it is open, and the selected row takes focus.
  useEffect(() => {
    if (!picker) return;
    pickerRef.current
      ?.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')
      ?.focus({ preventScroll: true });
    const onPointer = (event: PointerEvent) => {
      if (!pickerRef.current?.contains(event.target as Node)) setPicker(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setPicker(false);
      pickerButtonRef.current?.focus({ preventScroll: true });
    };
    window.addEventListener("pointerdown", onPointer, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("pointerdown", onPointer, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [picker]);

  useEffect(() => {
    if (open) return;
    setPicker(false);
    setMenu(null);
  }, [open]);

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

  const chooseFilter = (next: string) => {
    setFilter(next);
    setPicker(false);
    pickerButtonRef.current?.focus({ preventScroll: true });
  };

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
  const sortBySize = settings?.sourceSort !== "addon";
  const byInstallOrder = targets
    .map((target) => groups.find((group) => group.key === target.key))
    .filter((group): group is Group => Boolean(group));
  const shownGroups =
    filter === "all"
      ? byInstallOrder.filter(
          (group) => group.streams.length > 0 || group.state === "error",
        )
      : byInstallOrder.filter((group) => group.key === filter);
  const activeName =
    filter === "all" ? "All" : (targets.find((target) => target.key === filter)?.name ?? "All");

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
        <div className="drawer-bar">
          <div className="drawer-picker" ref={pickerRef}>
            <button
              ref={pickerButtonRef}
              type="button"
              className={`drawer-picker-btn${picker ? " is-open" : ""}`}
              aria-haspopup="listbox"
              aria-expanded={picker}
              aria-controls={picker ? "stream-addon-list" : undefined}
              aria-label={`Source addon: ${activeName}`}
              onClick={() => setPicker((current) => !current)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
                event.preventDefault();
                setPicker(true);
              }}
            >
              <span className="drawer-picker-label">{activeName}</span>
              <Icon name="chevron" size={15} className="drawer-picker-chevron" />
            </button>

            {picker ? (
              <div
                id="stream-addon-list"
                role="listbox"
                aria-label="Filter sources by addon"
                className="drawer-picker-menu"
                onKeyDown={(event) => {
                  const items = Array.from(
                    pickerRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
                  );
                  const at = items.indexOf(document.activeElement as HTMLButtonElement);
                  const step =
                    event.key === "ArrowDown"
                      ? 1
                      : event.key === "ArrowUp"
                        ? -1
                        : event.key === "Home"
                          ? 0
                          : event.key === "End"
                            ? 0
                            : 0;
                  if (event.key === "Tab") {
                    setPicker(false);
                    return;
                  }
                  if (!step && event.key !== "Home" && event.key !== "End") return;
                  event.preventDefault();
                  const next =
                    event.key === "Home"
                      ? 0
                      : event.key === "End"
                        ? items.length - 1
                        : at < 0
                          ? step > 0
                            ? 0
                            : items.length - 1
                          : (at + step + items.length) % items.length;
                  items[next]?.focus();
                }}
              >
                <button
                  type="button"
                  role="option"
                  aria-selected={filter === "all"}
                  className={`drawer-picker-option${filter === "all" ? " is-active" : ""}`}
                  onClick={() => chooseFilter("all")}
                >
                  <span className="drawer-picker-name">All</span>
                  <span className="drawer-picker-state">
                    {pending > 0 ? (
                      <Icon name="refresh" size={11} className="drawer-spin" />
                    ) : (
                      <span className="drawer-picker-count">{total}</span>
                    )}
                    {filter === "all" ? <span className="drawer-picker-dot" /> : null}
                  </span>
                </button>

                {targets.map((target) => {
                  const group = groups.find((item) => item.key === target.key);
                  const selected = filter === target.key;
                  const count = group?.streams.length ?? 0;
                  return (
                    <button
                      key={target.key}
                      type="button"
                      role="option"
                      aria-selected={selected}
                      className={`drawer-picker-option${selected ? " is-active" : ""}`}
                      onClick={() => chooseFilter(target.key)}
                    >
                      <span className="drawer-picker-name">{target.name}</span>
                      <span className="drawer-picker-state">
                        {group?.state === "loading" ? (
                          <Icon name="refresh" size={11} className="drawer-spin" />
                        ) : group?.state === "error" ? (
                          <Icon name="alert" size={11} />
                        ) : (
                          <span className="drawer-picker-count">{count}</span>
                        )}
                        {selected ? <span className="drawer-picker-dot" /> : null}
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : null}
          </div>

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

          <button type="button" className="drawer-close" onClick={onClose} aria-label="Close">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="drawer-body">
          {/* Nothing has answered yet: hold the shape of the list that is
              coming, so the panel never opens as an empty shell. */}
          {total === 0 && pending > 0 ? (
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

          {shownGroups.map((group) => {
            const rows = sortBySize ? group.streams.slice().sort(byFileSize) : group.streams;
            return (
              <section className="stream-group" key={group.key}>
                <h3 className="stream-group-title">{group.addon}</h3>

                {group.error ? (
                  <p className="stream-group-error" role="status">
                    {group.error}
                  </p>
                ) : null}

                {!group.error && group.state === "done" && !group.streams.length ? (
                  <p className="stream-group-note" role="status">
                    No sources from {group.addon}.
                  </p>
                ) : null}

                {rows.length ? (
                  <ul className="stream-list">
                    {rows.map((stream, index) => {
                      const url = stream.url?.trim() || null;
                      // Addons put the useful text in different places: MediaFusion
                      // writes a multi-line description, Torrentio writes a title.
                      const raw = (stream.description || stream.title || "").trim();
                      const label =
                        stream.name?.trim() || raw.split("\n")[0].trim() || "Source";
                      const body = raw.startsWith(label) ? raw.slice(label.length).trim() : raw;
                      const split = splitSourceLabel(label);
                      const qualityMark = formatQuality(
                        split.quality || (stream.quality !== "Auto" ? stream.quality : ""),
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
                      // A run of seeds/size tokens in the addon's own line is the
                      // meta row in text form; keep the parsed row instead.
                      const shownLines = bodyLines.filter((line) => {
                        const upper = line.toUpperCase();
                        const looksMeta =
                          (/👤|💾|⚙️/.test(line) && upper.includes("GB")) ||
                          (/SEED/.test(upper) && upper.includes("GB"));
                        return !looksMeta;
                      });
                      const detail = tidySourceDetail(
                        shownLines.length ? shownLines : bodyLines,
                        stream,
                      );
                      const showDetail =
                        detail.length > 0 &&
                        !split.label.toLowerCase().startsWith(detail.toLowerCase());
                      const hasMeta = Boolean(
                        stream.size ||
                          stream.seeders != null ||
                          stream.badges.length ||
                          stream.cached ||
                          audio,
                      );
                      const playLabel = [
                        `Play ${label}`,
                        stream.seeders != null
                          ? `${stream.seeders.toLocaleString()} seeders`
                          : null,
                        stream.size,
                        stream.cached ? "cached" : null,
                      ]
                        .filter(Boolean)
                        .join(", ");
                      return (
                        <li key={`${group.key}-${stream.infoHash ?? stream.url ?? index}-${index}`}>
                          <div className="stream-row">
                            <button
                              type="button"
                              className="stream-play"
                              onClick={() => stream.playable && onPlay(stream)}
                              disabled={!stream.playable}
                              title={stream.playable ? undefined : "This source has no playing link"}
                              aria-label={playLabel}
                            >
                              {qualityMark ? (
                                <span
                                  className={`stream-quality-mark${qualityMark.length <= 3 ? " is-short" : ""}${stream.cached ? " is-cached" : ""}`}
                                  aria-hidden="true"
                                >
                                  {qualityMark}
                                </span>
                              ) : null}
                              <span className="stream-copy">
                                <span className="stream-title-line">
                                  <span className="stream-title">{split.label}</span>
                                </span>
                                {showDetail ? (
                                  <span className="stream-details">
                                    <span className="stream-detail">{detail}</span>
                                  </span>
                                ) : null}
                                {hasMeta ? (
                                  <span className="stream-meta">
                                    {stream.seeders != null ? (
                                      <span
                                        className={`stream-seeds${stream.seeders === 0 ? " is-dead" : ""}`}
                                        title={`${stream.seeders.toLocaleString()} seeders`}
                                      >
                                        <span className="stream-seed-dot" aria-hidden="true" />
                                        {stream.seeders.toLocaleString()}
                                      </span>
                                    ) : null}
                                    {stream.size ? (
                                      <span className="stream-size" title="File size">
                                        {stream.size}
                                      </span>
                                    ) : null}
                                    {stream.badges.map((badge) => (
                                      <span className="stream-badge" key={badge}>
                                        {badge}
                                      </span>
                                    ))}
                                    {stream.cached ? <span className="stream-cached">Cached</span> : null}
                                    {audio ? (
                                      <span className="stream-langs">
                                        <Icon name="languages" size={11} />
                                        {audio}
                                      </span>
                                    ) : null}
                                  </span>
                                ) : null}
                              </span>
                              <span className="stream-action" aria-hidden="true">
                                <Icon name="play" size={14} />
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
            );
          })}

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
