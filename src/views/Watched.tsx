import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { WatchedItem } from "../lib/types";
import { PosterCard } from "../components/media";
import { Button, EmptyState, IconButton, Spinner } from "../components/ui";
import { seasonLabel, placeholderGradient } from "../lib/format";

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const DATE_LABEL = new Intl.DateTimeFormat(undefined, {
  day: "numeric",
  month: "short",
  year: "numeric",
});

const ID_LIKE = /^[a-z]{2}\d{5,}$/i;

function titleOf(item: WatchedItem): string {
  const name = item.name?.trim() ?? "";
  if (!name || name === item.metaId || ID_LIKE.test(name)) {
    return item.type === "series" ? "Untitled show" : "Untitled movie";
  }
  return name;
}

function watchedOn(timestamp: number): string {
  const at = new Date(timestamp);
  return Number.isFinite(at.getTime()) ? DATE_LABEL.format(at) : "";
}

function episodeCode(item: WatchedItem): string {
  if (item.type !== "series") return "";
  return seasonLabel(item.season, item.episode).replace(" · ", "");
}

function errorText(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  return "Watched history could not be read.";
}

function Thumb({ src, seed }: { src?: string | null; seed: string }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="calendar-thumb" style={{ background: placeholderGradient(seed) }}>
      {src && !failed ? (
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      ) : null}
    </span>
  );
}

// Everything finished, one card per title. The calendar is the default because
// "when did I watch this" is the question a watched list usually answers.
export function WatchedView() {
  const { navigate } = useApp();
  const [items, setItems] = useState<WatchedItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<"calendar" | "posters">("calendar");
  const [expandedDay, setExpandedDay] = useState<number | null>(null);
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    let alive = true;
    setItems(null);
    setError(null);
    api.watched
      .list()
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch((failure) => {
        if (alive) setError(errorText(failure));
      });
    return () => {
      alive = false;
    };
  }, [attempt]);

  const week = useMemo(() => {
    const year = month.getFullYear();
    const index = month.getMonth();
    const lead = new Date(year, index, 1).getDay();
    const days = new Date(year, index + 1, 0).getDate();
    const byDay = new Map<number, WatchedItem[]>();
    for (const item of items ?? []) {
      const at = new Date(item.watchedAt);
      if (at.getFullYear() !== year || at.getMonth() !== index) continue;
      const day = at.getDate();
      const bucket = byDay.get(day);
      if (bucket) bucket.push(item);
      else byDay.set(day, [item]);
    }
    const cells: { day: number | null; entries: WatchedItem[] }[] = [];
    for (let i = 0; i < lead; i += 1) cells.push({ day: null, entries: [] });
    for (let day = 1; day <= days; day += 1) {
      cells.push({ day, entries: byDay.get(day) ?? [] });
    }
    while (cells.length % 7 !== 0) cells.push({ day: null, entries: [] });
    return { cells, total: [...byDay.values()].reduce((sum, list) => sum + list.length, 0) };
  }, [items, month]);

  const today = new Date();
  const isThisMonth =
    today.getFullYear() === month.getFullYear() && today.getMonth() === month.getMonth();

  const step = (direction: number) =>
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + direction, 1));

  const open = (item: WatchedItem) =>
    navigate({ name: "details", id: item.metaId, type: item.type });

  const status = error
    ? "History unavailable"
    : items
      ? items.length === 1
        ? "1 title finished"
        : `${items.length} titles finished`
      : "Loading history";

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <nav className="page-tabs" aria-label="Library">
            <button type="button" onClick={() => navigate({ name: "library" })}>
              Library
            </button>
            <button type="button" className="is-active" aria-current="page">
              Watched
            </button>
          </nav>
          <h1>Finished, not forgotten</h1>
          <p className="page-sub">{status}</p>
        </div>
        <div className="segmented" role="group" aria-label="Watched layout">
          {(
            [
              ["calendar", "Calendar"],
              ["posters", "Posters"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              aria-pressed={mode === value}
              className={mode === value ? "is-active" : ""}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {error ? (
        <EmptyState
          icon="info"
          title="Watched history could not load"
          body={error}
          action={
            <Button variant="primary" icon="refresh" onClick={() => setAttempt((count) => count + 1)}>
              Try again
            </Button>
          }
        />
      ) : !items ? (
        <div className="page-loading">
          <Spinner label="Loading watched titles" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing finished yet"
          body="Titles land here when you finish them, or when Nuvio marks them watched on another device."
          action={
            <Button variant="primary" icon="home" onClick={() => navigate({ name: "home" })}>
              Back to home
            </Button>
          }
        />
      ) : mode === "calendar" ? (
        <>
          <div className="calendar-head">
            <h2 className="calendar-month">{MONTHS[month.getMonth()]}</h2>
            <span className="calendar-year">{month.getFullYear()}</span>
            <p className="calendar-count">
              {week.total === 1 ? "1 title" : `${week.total} titles`}
            </p>
            <div className="calendar-nav">
              <IconButton icon="back" label="Previous month" size={16} onClick={() => step(-1)} />
              <IconButton
                icon="forward"
                label="Next month"
                size={16}
                onClick={() => step(1)}
              />
            </div>
          </div>

          <div className="calendar">
            {WEEKDAYS.map((label) => (
              <div className="calendar-weekday" key={label}>
                {label}
              </div>
            ))}
            {week.cells.map((cell, position) => {
              const isToday = isThisMonth && cell.day === today.getDate();
              const day = cell.day;
              const expanded = day !== null && expandedDay === day;
              const shown = expanded ? cell.entries : cell.entries.slice(0, 4);
              return (
                <div
                  key={day ?? `blank-${position}`}
                  className={`calendar-day${day ? "" : " is-blank"}${
                    isToday ? " is-today" : ""
                  }`}
                >
                  {day ? (
                    <>
                      <span className="calendar-day-num">{day}</span>
                      {shown.map((item) => {
                        const title = titleOf(item);
                        const code = episodeCode(item);
                        const when = watchedOn(item.watchedAt);
                        const label = [title, code, when].filter(Boolean).join(" · ");
                        return (
                          <button
                            type="button"
                            className="calendar-item"
                            key={`${item.metaId}-${item.season ?? 0}-${item.episode ?? item.watchedAt}`}
                            onClick={() => open(item)}
                            title={label}
                            aria-label={label}
                          >
                            <Thumb src={item.poster} seed={title} />
                            <span className="calendar-item-text">
                              {title}
                              {code ? <span className="calendar-code"> {code}</span> : null}
                            </span>
                          </button>
                        );
                      })}
                      {cell.entries.length > 4 ? (
                        <button
                          type="button"
                          className="calendar-more"
                          aria-expanded={expanded}
                          onClick={() => setExpandedDay(expanded ? null : day)}
                        >
                          {expanded ? "Show less" : `+${cell.entries.length - 4} more`}
                        </button>
                      ) : null}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      ) : (
        <div className="grid">
          {items.map((item) => {
            const title = titleOf(item);
            const meta = [episodeCode(item), watchedOn(item.watchedAt)].filter(Boolean).join(" · ");
            return (
              <div
                className="watched-cell"
                key={`${item.metaId}-${item.season ?? 0}-${item.episode ?? item.watchedAt}`}
              >
                <PosterCard
                  item={{
                    id: item.metaId,
                    type: item.type,
                    name: title,
                    poster: item.poster,
                    background: item.background,
                  }}
                  caption
                  onOpen={() => open(item)}
                />
                {meta ? <p className="watched-meta">{meta}</p> : null}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
