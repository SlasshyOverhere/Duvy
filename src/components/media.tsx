import {
  Fragment,
  memo,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as KeyEvent,
  type ReactNode,
} from "react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { MetaPreview, ProgressItem } from "../lib/types";
import { placeholderGradient, progressPercent, remainingLabel, runtimeLabel } from "../lib/format";
import { ContextMenu, Icon, IconButton, type ContextAction } from "./ui";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join(" · ");
}

// The frame is the click surface; this transparent button carries the click so
// the card never nests a play button inside a button role.
const OPEN_LAYER: CSSProperties = {
  position: "absolute",
  inset: 0,
  padding: 0,
  border: 0,
  background: "transparent",
  // The frame draws the focus ring; a second square one inside it reads wrong.
  outline: "none",
};

/** Keyboard path for the right-click menu: ContextMenu key or Shift+F10. */
export function menuFromKey(event: KeyEvent<HTMLElement>) {
  if (event.key !== "ContextMenu" && !(event.shiftKey && event.key === "F10")) return null;
  event.preventDefault();
  const box = event.currentTarget.getBoundingClientRect();
  return { x: box.left + 16, y: box.top + 16 };
}

// Mounted only while the menu is open, so the card itself stays unsubscribed.
function PosterMenu({
  x,
  y,
  item,
  entry,
  onPlay,
  onClose,
}: {
  x: number;
  y: number;
  item: MetaPreview;
  entry?: ProgressItem;
  onPlay?: () => void;
  onClose: () => void;
}) {
  const { playItem, progress: history, markWatched, refreshProgress, notify, watched } = useApp();
  const marked = watched.some((row) => row.metaId === item.id);
  // Cards may not carry an entry; the lookup only costs anything while open.
  const hit = entry ?? history.find((row) => row.metaId === item.id);
  // A finished title is not a resume target.
  const current = marked ? undefined : hit;

  const setWatched = (next: boolean) => {
    const apply = async () => {
      if (next) {
        // A show with no resume point has no episode to mark; the action is
        // hidden in that case, so this only runs for a movie or a real episode.
        const key = current?.key ?? item.id;
        await markWatched(key, item.id, true);
        return;
      }
      // Unmarking a show has to clear every episode, not just the newest one.
      const marks = await api.watched.marks(item.id);
      const keys = marks.length ? marks.map(([key]) => key) : current ? [current.key] : [];
      for (const key of keys) await api.progress.setWatched(key, item.id, false);
      await refreshProgress();
    };
    void apply()
      .then(() => notify(`${item.name} marked as ${next ? "watched" : "unwatched"}`))
      .catch(() => notify("Could not update that", "error"));
  };

  const actions: ContextAction[] = [
    {
      label: current ? "Resume" : "Play",
      icon: "play",
      onSelect: () => (onPlay ? onPlay() : void playItem(item)),
    },
  ];
  if (current) {
    actions.push({
      label: "Start from beginning",
      icon: "replay10",
      onSelect: () => void playItem(item, true),
    });
  }
  // A series with no episode to point at cannot be marked from a card.
  if (marked || current || item.type === "movie") {
    actions.push({
      label: marked ? "Mark as unwatched" : "Mark as watched",
      icon: marked ? "x" : "check",
      onSelect: () => setWatched(!marked),
    });
  }
  if (current) {
    actions.push({
      label: "Remove from continue watching",
      icon: "trash",
      onSelect: () => {
        const rows = history.filter((row) => row.metaId === item.id);
        void Promise.all(rows.map((row) => api.progress.clear(row.key)))
          .then(() => {
            notify(`Removed ${item.name} from continue watching`);
            return refreshProgress();
          })
          .catch(() => notify("Could not clear that progress", "error"));
      },
    });
  }

  return <ContextMenu x={x} y={y} title={item.name} actions={actions} onClose={onClose} />;
}

export const PosterCard = memo(function PosterCard({
  item,
  onOpen,
  onPlay,
  entry,
  caption = false,
  wide = false,
}: {
  item: MetaPreview;
  onOpen: () => void;
  onPlay?: () => void;
  entry?: ProgressItem;
  caption?: boolean;
  wide?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const gradient = placeholderGradient(item.name);
  const percent = entry ? progressPercent(entry.position, entry.duration) : 0;
  const shape = item.posterShape?.toLowerCase();
  const shapeClass = shape === "square" || shape === "landscape" ? `is-${shape}` : "is-poster";

  return (
    <article className={`poster-card${wide ? " is-wide" : ""}`}>
      <div
        className={`poster-frame ${shapeClass}`}
        style={{ background: gradient } as CSSProperties}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {item.poster && !failed ? (
          <img
            src={item.poster}
            alt=""
            loading="lazy"
            decoding="async"
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="poster-fallback">
            {initials(item.name)}
          </div>
        )}
        {percent > 0 ? (
          <div className="poster-progress">
            <span style={{ width: `${Math.min(100, percent)}%` }} />
          </div>
        ) : null}
        <button
          type="button"
          aria-label={`Open ${item.name}`}
          style={OPEN_LAYER}
          onClick={onOpen}
          onKeyDown={(event) => {
            const at = menuFromKey(event);
            if (at) setMenu(at);
          }}
        />
        <div className="poster-hover">
          {item.logo && !logoFailed ? (
            <img
              className="poster-hover-logo"
              src={item.logo}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="poster-hover-title">{item.name}</span>
          )}
          <span className="poster-hover-meta">
            {[item.releaseInfo, runtimeLabel(item.runtime), item.imdbRating ? `${item.imdbRating} IMDb` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      </div>
      {caption ? (
        <div className="poster-caption">
          <span className="poster-name">{item.name}</span>
          <span className="poster-sub">
            {[item.releaseInfo, item.type === "series" ? "Show" : "Movie"]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
      ) : null}
      {menu ? (
        <PosterMenu
          x={menu.x}
          y={menu.y}
          item={item}
          entry={entry}
          onPlay={onPlay}
          onClose={() => setMenu(null)}
        />
      ) : null}
    </article>
  );
});

export function Row({
  title,
  detail,
  children,
}: {
  title: string;
  detail?: ReactNode;
  children: ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atStart, setAtStart] = useState(true);
  const [atEnd, setAtEnd] = useState(false);

  const measure = () => {
    const node = scroller.current;
    if (!node) return;
    setAtStart(node.scrollLeft < 8);
    setAtEnd(node.scrollLeft + node.clientWidth >= node.scrollWidth - 8);
  };

  // Cards arrive after the first paint, so the arrows re-measure with them.
  useEffect(measure, [children]);

  const scroll = (direction: number) => {
    const node = scroller.current;
    if (!node) return;
    node.scrollBy({ left: direction * node.clientWidth * 0.82, behavior: "smooth" });
  };

  // Grab-and-drag the row like a touch surface; a drag never opens a card.
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    let start: { x: number; left: number } | null = null;
    let moved = false;

    const down = (event: PointerEvent) => {
      if (event.button !== 0 || event.pointerType !== "mouse") return;
      start = { x: event.clientX, left: node.scrollLeft };
      moved = false;
    };
    const up = () => {
      start = null;
      node.classList.remove("is-dragging");
    };
    const move = (event: PointerEvent) => {
      if (!start) return;
      // A pointer released outside the window never reaches pointerup.
      if (!event.buttons) {
        up();
        return;
      }
      const dx = event.clientX - start.x;
      if (!moved && Math.abs(dx) < 6) return;
      if (!moved) {
        moved = true;
        node.classList.add("is-dragging");
      }
      event.preventDefault();
      node.scrollLeft = start.left - dx;
    };
    const click = (event: MouseEvent) => {
      // Keyboard activation carries no detail, so a stale drag flag cannot eat it.
      if (!event.detail) {
        moved = false;
        return;
      }
      if (!moved) return;
      event.preventDefault();
      event.stopPropagation();
      moved = false;
    };
    const dragStart = (event: DragEvent) => event.preventDefault();

    node.addEventListener("pointerdown", down);
    node.addEventListener("click", click, true);
    node.addEventListener("dragstart", dragStart);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
    return () => {
      node.removeEventListener("pointerdown", down);
      node.removeEventListener("click", click, true);
      node.removeEventListener("dragstart", dragStart);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
    };
  }, []);

  return (
    <section className="row">
      <header className="row-head">
        <h2>{title}</h2>
        {detail ? <div className="row-head-right">{detail}</div> : null}
      </header>
      <div className="row-track">
        <div className="row-scroller" ref={scroller} onScroll={measure}>
          {children}
        </div>
        <div className="row-arrows">
          <IconButton
            icon="back"
            label="Scroll left"
            size={18}
            className={atStart ? "is-edge is-hidden" : "is-edge"}
            onClick={() => scroll(-1)}
          />
          <IconButton
            icon="forward"
            label="Scroll right"
            size={18}
            className={atEnd ? "is-edge is-hidden" : "is-edge"}
            onClick={() => scroll(1)}
          />
        </div>
      </div>
    </section>
  );
}

export function ContinueCard({
  entry,
  poster,
  background,
  name,
  subtitle,
  meta,
  position,
  duration,
  next = false,
  onOpen,
  onPlay,
}: {
  entry: ProgressItem;
  poster?: string | null;
  background?: string | null;
  name: string;
  subtitle?: string;
  meta?: MetaPreview;
  position: number;
  duration: number;
  next?: boolean;
  onOpen: () => void;
  onPlay: () => void;
}) {
  const [still, setStill] = useState(background ?? poster ?? null);
  const [logoFailed, setLogoFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { playItem, progress: history, markWatched, refreshProgress, notify } = useApp();
  const raw = progressPercent(position, duration);
  const percent = Number.isFinite(raw) ? raw : 0;
  const left = duration - position;
  // Progress rows carry no art or score, so the feed row for the same title is
  // reused when there is one, and an IMDb id still has its logo for free.
  const logo =
    meta?.logo ??
    (entry.metaId.startsWith("tt")
      ? `https://images.metahub.space/logo/medium/${entry.metaId}/img`
      : null);
  const details = [meta?.releaseInfo, runtimeLabel(meta?.runtime), meta?.imdbRating ? `${meta.imdbRating} IMDb` : null]
    .filter(Boolean)
    .join(" · ");

  const drop = (label: string, task: Promise<unknown>) => {
    void task
      .then(() => {
        notify(label);
        // The parent list drops the card once the refresh lands; hiding it here
        // would strand it invisible if the readback failed.
        return refreshProgress();
      })
      .catch(() => notify("That did not stick. Try again.", "error"));
  };

  const actions: ContextAction[] = [
    { label: next ? "Play next episode" : "Resume", icon: "play", onSelect: onPlay },
    {
      label: "Start from beginning",
      icon: "replay10",
      onSelect: () =>
        void playItem(
          { id: entry.metaId, type: entry.type, name: entry.name, poster: entry.poster },
          true,
        ),
    },
    {
      label: "Mark as watched",
      icon: "check",
      onSelect: () =>
        drop(`Marked ${name} as watched`, markWatched(entry.key, entry.metaId, true)),
    },
    {
      label: "Remove from continue watching",
      icon: "trash",
      onSelect: () => {
        const keys = history.filter((row) => row.metaId === entry.metaId).map((row) => row.key);
        drop(
          `Removed ${name} from continue watching`,
          Promise.all((keys.length ? keys : [entry.key]).map((key) => api.progress.clear(key))),
        );
      },
    },
  ];

  return (
    <div className="continue-item">
      <button
        type="button"
        className="continue-card"
        aria-label={`${name}${next ? ", next up" : ""}`}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          const at = menuFromKey(event);
          if (at) setMenu(at);
        }}
        style={{ background: placeholderGradient(name) } as CSSProperties}
      >
        {still ? (
          <img
            src={still}
            alt=""
            loading="lazy"
            decoding="async"
            // A dead still falls back to the poster, then to the gradient.
            onError={() => setStill(still === poster ? null : (poster ?? null))}
          />
        ) : null}
        <span className="continue-veil" />
        <span className="continue-hover">
          {logo && !logoFailed ? (
            <img
              className="continue-hover-logo"
              src={logo}
              alt=""
              loading="lazy"
              decoding="async"
              onError={() => setLogoFailed(true)}
            />
          ) : (
            <span className="continue-hover-name">{name}</span>
          )}
          {details ? <span className="continue-hover-sub">{details}</span> : null}
          {subtitle ? <span className="continue-hover-sub">{subtitle}</span> : null}
          {next ? (
            <span className="continue-hover-sub">Next up</span>
          ) : Number.isFinite(left) && left > 0 ? (
            <span className="continue-hover-sub">{remainingLabel(left)}</span>
          ) : null}
        </span>
        {next ? null : (
          <span className="continue-progress">
            <span style={{ width: `${percent}%` }} />
          </span>
        )}
        {menu ? (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            title={name}
            actions={actions}
            onClose={() => setMenu(null)}
          />
        ) : null}
      </button>
      <div className="continue-caption">
        <span className="continue-name">{name}</span>
        <span className="continue-sub">
          {subtitle ? <>{subtitle} · </> : null}
          {next ? "Next up" : Number.isFinite(left) && left > 0 ? remainingLabel(left) : null}
        </span>
      </div>
    </div>
  );
}

// How long a featured title holds the hero. The dot progress reads from this.
const SLIDE_MS = 9000;

export function Hero({
  item,
  onOpen,
  onPlay,
  onLibrary,
  inLibrary,
  onNext,
  onSelect,
  index,
  count,
}: {
  item: MetaPreview;
  onOpen: () => void;
  onPlay: () => void;
  onLibrary: () => void;
  inLibrary: boolean;
  onNext?: () => void;
  onSelect?: (index: number) => void;
  index?: number;
  count?: number;
}) {
  const [failed, setFailed] = useState(false);
  const [logoFailed, setLogoFailed] = useState(false);
  const [paused, setPaused] = useState(false);
  // Bumped whenever the rotation clock restarts, to replay the dot fill.
  const [run, setRun] = useState(0);
  // The outgoing artwork stays under the incoming one so the crossfade never
  // dips through the black hero background. The first one does not fade in:
  // the hero is already the first frame on screen.
  const [layers, setLayers] = useState<{ item: MetaPreview; animate: boolean }[]>([
    { item, animate: false },
  ]);

  useEffect(() => {
    setLayers((current) =>
      current[current.length - 1]?.item.id === item.id
        ? current
        : [...current.slice(-1), { item, animate: true }],
    );
  }, [item]);

  // A new featured title gets a clean attempt at its artwork.
  useEffect(() => {
    setFailed(false);
    setLogoFailed(false);
  }, [item.id]);

  // Rotate the featured titles; hovering or focusing holds the current one.
  useEffect(() => {
    if (!onNext || paused) return;
    // Every restart of the clock restarts the dot fill, so the bar always
    // measures the time that is actually left.
    setRun((value) => value + 1);
    const timer = setTimeout(onNext, SLIDE_MS);
    return () => clearTimeout(timer);
  }, [item.id, paused, onNext]);

  return (
    <section
      className="hero"
      style={{ "--hero-slide": `${SLIDE_MS}ms` } as CSSProperties}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      {layers.map((layer) => {
        const current = layer.item.id === item.id;
        return (
          <div
            key={layer.item.id}
            className={`hero-cross${layer.animate ? " is-current" : ""}`}
            style={{ background: placeholderGradient(layer.item.name) } as CSSProperties}
            onAnimationEnd={layer.animate ? () => setLayers((all) => all.slice(-1)) : undefined}
          >
            {layer.item.background && !(current && failed) ? (
              <img
                className="hero-backdrop"
                src={layer.item.background}
                alt=""
                onError={current ? () => setFailed(true) : undefined}
              />
            ) : null}
            <div className="hero-scrim" />
          </div>
        );
      })}

      <div className="hero-body">
        <div key={item.id} className="hero-enter">
          <h1 className="hero-title">
            {item.logo && !logoFailed ? (
              <img
                className="hero-logo"
                src={item.logo}
                alt={item.name}
                draggable={false}
                onError={() => setLogoFailed(true)}
              />
            ) : (
              item.name
            )}
          </h1>
          <div className="hero-copy">
            <div className="hero-meta">
              {[
                item.imdbRating ? (
                  <span key="rating" className="hero-meta-item">
                    <Icon name="star" size={16} />
                    {item.imdbRating}
                  </span>
                ) : null,
                item.releaseInfo ? (
                  <span key="year" className="hero-meta-item">
                    <Icon name="calendar" size={16} />
                    {item.releaseInfo}
                  </span>
                ) : null,
                runtimeLabel(item.runtime) ? (
                  <span key="runtime" className="hero-meta-item">
                    <Icon name="clock" size={16} />
                    {runtimeLabel(item.runtime)}
                  </span>
                ) : null,
                ...(item.genres ?? [])
                  .slice(0, 3)
                  .map((genre) => (
                    <span key={genre} className="hero-meta-item">
                      <Icon name="tag" size={16} />
                      {genre}
                    </span>
                  )),
              ]
                .filter(Boolean)
                .map((node, index) => (
                  <Fragment key={index}>
                    {index > 0 ? (
                      <span className="hero-sep" aria-hidden="true">
                        •
                      </span>
                    ) : null}
                    {node}
                  </Fragment>
                ))}
            </div>
            {item.description ? <p className="hero-overview">{item.description}</p> : null}
            <div className="hero-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={onPlay}
                title="Play"
                aria-label="Play"
              >
                <Icon name="play" size={22} />
              </button>
              <button
                type="button"
                className="hero-icon-btn"
                onClick={onLibrary}
                title={inLibrary ? "Remove from library" : "Add to library"}
                aria-label={inLibrary ? "Remove from library" : "Add to library"}
              >
                <Icon name={inLibrary ? "check" : "plus"} size={22} />
              </button>
              <button
                type="button"
                className="hero-icon-btn"
                onClick={onOpen}
                title="More info"
                aria-label="More info"
              >
                <Icon name="info" size={22} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {onSelect && typeof index === "number" && typeof count === "number" && count > 1 ? (
        <div
          key={run}
          className={`hero-dots${paused ? " is-paused" : ""}`}
          role="group"
          aria-label="Featured titles"
        >
          {Array.from({ length: count }, (_, dot) => (
            <button
              key={dot}
              type="button"
              className={dot === index ? "hero-dot is-active" : "hero-dot"}
              aria-current={dot === index}
              aria-label={`Featured title ${dot + 1} of ${count}`}
              onClick={() => onSelect(dot)}
            />
          ))}
        </div>
      ) : null}
    </section>
  );
}
