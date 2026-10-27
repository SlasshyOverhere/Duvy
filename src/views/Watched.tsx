import { useEffect, useMemo, useState } from "react";
import { api } from "../lib/bridge";
import { useApp } from "../lib/store";
import type { WatchedItem } from "../lib/types";
import { PosterCard } from "../components/media";
import { EmptyState, IconButton, Spinner } from "../components/ui";
import { seasonLabel, timeAgo, placeholderGradient } from "../lib/format";

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

// Everything finished, one card per title. The calendar is the default because
// "when did I watch this" is the question a watched list usually answers.
export function WatchedView() {
  const { navigate } = useApp();
  const [items, setItems] = useState<WatchedItem[] | null>(null);
  const [mode, setMode] = useState<"calendar" | "posters">("calendar");
  const [month, setMonth] = useState(() => {
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1);
  });

  useEffect(() => {
    let alive = true;
    api.watched
      .list()
      .then((rows) => {
        if (alive) setItems(rows);
      })
      .catch(() => {
        if (alive) setItems([]);
      });
    return () => {
      alive = false;
    };
  }, []);

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

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Watched</p>
          <h1>Finished, not forgotten</h1>
          <p className="page-sub">{items ? `${items.length} titles` : "Loading"}</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Watched layout">
          {(
            [
              ["calendar", "Calendar"],
              ["posters", "Posters"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={mode === value}
              className={mode === value ? "is-active" : ""}
              onClick={() => setMode(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {!items ? (
        <div className="page-loading">
          <Spinner label="Loading watched titles" />
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon="check"
          title="Nothing finished yet"
          body="Titles land here when you finish them, or when Nuvio marks them watched on another device."
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
              return (
                <div
                  key={cell.day ?? `blank-${position}`}
                  className={`calendar-day${cell.day ? "" : " is-blank"}${
                    isToday ? " is-today" : ""
                  }`}
                >
                  {cell.day ? (
                    <>
                      <span className="calendar-day-num">{cell.day}</span>
                      {cell.entries.slice(0, 4).map((item) => (
                        <button
                          type="button"
                          className="calendar-item"
                          key={item.metaId}
                          onClick={() => open(item)}
                          title={item.name}
                        >
                          <span
                            className="calendar-thumb"
                            style={
                              item.poster ? undefined : { background: placeholderGradient(item.name) }
                            }
                          >
                            {item.poster ? <img src={item.poster} alt="" loading="lazy" /> : null}
                          </span>
                          <span className="calendar-item-text">
                            {item.name}
                            {item.type === "series" &&
                            item.season != null &&
                            item.episode != null ? (
                              <span className="calendar-code">
                                {" "}
                                {seasonLabel(item.season, item.episode).replace(" · ", "")}
                              </span>
                            ) : null}
                          </span>
                        </button>
                      ))}
                      {cell.entries.length > 4 ? (
                        <span className="calendar-more">+{cell.entries.length - 4} more</span>
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
          {items.map((item) => (
            <div className="watched-cell" key={item.metaId}>
              <PosterCard
                item={{
                  id: item.metaId,
                  type: item.type,
                  name: item.name,
                  poster: item.poster,
                  background: item.background,
                }}
                onOpen={() => open(item)}
              />
              <p className="watched-meta">
                {item.type === "series" ? seasonLabel(item.season, item.episode) || "Show" : "Movie"}
                {item.watchedAt ? ` · ${timeAgo(item.watchedAt)}` : ""}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
