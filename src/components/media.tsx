import { memo, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { MetaPreview, ProgressItem } from "../lib/types";
import { placeholderGradient, progressPercent, remainingLabel } from "../lib/format";
import { ContextMenu, Icon, IconButton, Badge, ImdbMark, type ContextAction } from "./ui";

function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join(" · ");
}

export const PosterCard = memo(function PosterCard({
  item,
  onOpen,
  onPlay,
  progress,
  caption = false,
  wide = false,
}: {
  item: MetaPreview;
  onOpen: () => void;
  onPlay?: () => void;
  progress?: number;
  caption?: boolean;
  wide?: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { playItem, progress: history, refreshProgress, notify, watched } = useApp();
  const marked = watched.some((row) => row.metaId === item.id);
  const entry = marked ? undefined : history.find((row) => row.metaId === item.id);
  const gradient = placeholderGradient(item.name);
  const shape = item.posterShape?.toLowerCase();
  const shapeClass = shape === "square" || shape === "landscape" ? `is-${shape}` : "is-poster";

  const markWatched = (next: boolean) => {
    void api.progress
      .setWatched(entry?.key ?? item.id, item.id, next)
      .then(() => {
        notify(`${item.name} marked as ${next ? "watched" : "unwatched"}`);
        return refreshProgress();
      })
      .catch(() => notify("Could not update that", "error"));
  };

  const actions: ContextAction[] = [
    {
      label: entry ? "Resume" : "Play",
      icon: "play",
      onSelect: () => (onPlay ? onPlay() : void playItem(item)),
    },
  ];
  if (entry) {
    actions.push({
      label: "Start from beginning",
      icon: "replay10",
      onSelect: () => void playItem(item, true),
    });
  }
  actions.push({
    label: marked ? "Mark as unwatched" : "Mark as watched",
    icon: marked ? "x" : "check",
    onSelect: () => markWatched(!marked),
  });
  if (entry) {
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

  return (
    <article className={`poster-card${wide ? " is-wide" : ""}`}>
      <div
        className={`poster-frame ${shapeClass}`}
        role="button"
        tabIndex={0}
        aria-label={item.name}
        style={{ background: gradient } as CSSProperties}
        onClick={onOpen}
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({ x: event.clientX, y: event.clientY });
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            onOpen();
          }
        }}
      >
        {item.poster && !failed ? (
          <img src={item.poster} alt="" loading="lazy" onError={() => setFailed(true)} />
        ) : (
          <div className="poster-fallback">{initials(item.name)}</div>
        )}
        <div className="poster-hover">
          <span className="poster-hover-title">{item.name}</span>
          <span className="poster-hover-meta">
            {[item.releaseInfo, item.imdbRating ? `★ ${item.imdbRating}` : null]
              .filter(Boolean)
              .join(" · ")}
          </span>
        </div>
        {onPlay ? (
          <button
            type="button"
            className="poster-play"
            aria-label={`Play ${item.name}`}
            onClick={(event) => {
              event.stopPropagation();
              onPlay();
            }}
          >
            <Icon name="play" size={17} />
          </button>
        ) : null}
        {progress && progress > 0 ? (
          <div className="poster-progress">
            <span style={{ width: `${Math.min(100, progress)}%` }} />
          </div>
        ) : null}
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
        <ContextMenu
          x={menu.x}
          y={menu.y}
          title={item.name}
          actions={actions}
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
    const move = (event: PointerEvent) => {
      if (!start) return;
      const dx = event.clientX - start.x;
      if (!moved && Math.abs(dx) < 6) return;
      if (!moved) {
        moved = true;
        node.classList.add("is-dragging");
      }
      event.preventDefault();
      node.scrollLeft = start.left - dx;
    };
    const up = () => {
      start = null;
      node.classList.remove("is-dragging");
    };
    const click = (event: MouseEvent) => {
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
        <div className="row-head-right">
          {detail}
          <div className="row-arrows">
            <IconButton icon="back" label="Scroll left" size={16} onClick={() => scroll(-1)} />
            <IconButton icon="forward" label="Scroll right" size={16} onClick={() => scroll(1)} />
          </div>
        </div>
      </header>
      <div className="row-scroller" ref={scroller}>
        {children}
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
  position,
  duration,
  onOpen,
}: {
  entry: ProgressItem;
  poster?: string | null;
  background?: string | null;
  name: string;
  subtitle?: string;
  position: number;
  duration: number;
  onOpen: () => void;
}) {
  const [failed, setFailed] = useState(false);
  const [gone, setGone] = useState(false);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const { playItem, progress: history, refreshProgress, notify } = useApp();
  const percent = progressPercent(position, duration);

  const drop = (label: string, task: Promise<unknown>) => {
    void task
      .then(() => {
        setGone(true);
        notify(label);
        return refreshProgress();
      })
      .catch(() => notify("That did not stick. Try again.", "error"));
  };

  const actions: ContextAction[] = [
    { label: "Resume", icon: "play", onSelect: onOpen },
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
        drop(`Marked ${name} as watched`, api.progress.setWatched(entry.key, entry.metaId, true)),
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

  if (gone) return null;

  return (
    <button
      type="button"
      className="continue-card"
      onClick={onOpen}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenu({ x: event.clientX, y: event.clientY });
      }}
      style={{ background: placeholderGradient(name) } as CSSProperties}
    >
      {(background || poster) && !failed ? (
        <img src={background ?? poster ?? ""} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : null}
      <span className="continue-scrim" />
      <span className="continue-body">
        <span className="continue-name">{name}</span>
        {subtitle ? <span className="continue-sub">{subtitle}</span> : null}
      </span>
      {duration > 0 ? (
        <span className="continue-left">{remainingLabel(duration - position)}</span>
      ) : null}
      <span className="continue-play">
        <Icon name="play" size={16} />
      </span>
      <span className="continue-progress">
        <span style={{ width: `${Math.max(2, percent)}%` }} />
      </span>
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
  );
}

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
  const [hovered, setHovered] = useState(false);

  // A new featured title gets a clean attempt at its artwork.
  useEffect(() => setFailed(false), [item.id]);

  // Rotate the featured titles; hovering holds the current one.
  useEffect(() => {
    if (!onNext || hovered) return;
    const timer = setTimeout(onNext, 9000);
    return () => clearTimeout(timer);
  }, [item.id, hovered, onNext]);

  return (
    <section
      className="hero"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <AnimatePresence initial={false}>
        <motion.div
          key={item.id}
          className="hero-cross"
          style={{ background: placeholderGradient(item.name) } as CSSProperties}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          // The outgoing layer stays opaque under the new one, so the
          // crossfade never dips through the black hero background.
          exit={{ opacity: 1, transition: { duration: 0.6 } }}
          transition={{ duration: 0.6, ease: "easeOut" }}
        >
          {item.background && !failed ? (
            <img
              className="hero-backdrop"
              src={item.background}
              alt=""
              onError={() => setFailed(true)}
            />
          ) : null}
          <div className="hero-scrim" />
        </motion.div>
      </AnimatePresence>

      <div className="hero-body">
        <motion.div
          key={item.id}
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.32, ease: [0.22, 0.68, 0.32, 1] }}
        >
          <h1 className="hero-title">
            {item.logo ? (
              <img className="hero-logo" src={item.logo} alt={item.name} draggable={false} />
            ) : (
              item.name
            )}
          </h1>
          <div className="hero-meta">
            {item.imdbRating ? (
              <Badge tone="accent">
                <span className="rating-value">{item.imdbRating}</span>
                <ImdbMark />
              </Badge>
            ) : null}
            {item.releaseInfo ? <span>{item.releaseInfo}</span> : null}
            {item.runtime ? <span>{item.runtime}</span> : null}
            {item.genres?.slice(0, 2).map((genre) => (
              <span key={genre} className="hero-genre">
                {genre}
              </span>
            ))}
          </div>
          {item.description ? <p className="hero-overview">{item.description}</p> : null}
          <div className="hero-actions">
            <button
              type="button"
              className="btn btn-primary"
              onClick={onPlay}
              title="Watch Now"
              aria-label="Watch Now"
            >
              <Icon name="play" size={20} />
            </button>
            <button
              type="button"
              className="btn btn-square"
              onClick={onLibrary}
              title={inLibrary ? "Remove from library" : "Add to library"}
              aria-label={inLibrary ? "Remove from library" : "Add to library"}
            >
              <Icon name={inLibrary ? "check" : "plus"} size={20} />
            </button>
            <button type="button" className="hero-link" onClick={onOpen}>
              More info
            </button>
          </div>
        </motion.div>
      </div>

      {onSelect && typeof index === "number" && typeof count === "number" && count > 1 ? (
        <div className="hero-dots" role="group" aria-label="Featured titles">
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
