import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import type { LibraryItem } from "../lib/types";
import { ContinueCard, PosterCard, Row } from "../components/media";
import { Button, EmptyState } from "../components/ui";
import { progressPercent, seasonLabel } from "../lib/format";

type Filter = "all" | "movie" | "series";
type Sort = "recent" | "title";

const FILTERS: ReadonlyArray<[Filter, string]> = [
  ["all", "All"],
  ["movie", "Movies"],
  ["series", "Series"],
];

const SORTS: ReadonlyArray<[Sort, string]> = [
  ["recent", "Recently added"],
  ["title", "Title A-Z"],
];

const EMPTY: Record<Filter, { title: string; body: string }> = {
  all: {
    title: "Nothing saved yet",
    body: "Use the Library button on any title to keep it here. Your watch progress shows up automatically.",
  },
  movie: {
    title: "No movies saved",
    body: "Movies you add from any catalog land here.",
  },
  series: {
    title: "No series saved",
    body: "Series you add from any catalog land here.",
  },
};

export function LibraryView() {
  const { library, progress, navigate, playItem, resumeEntry, toggleLibrary } = useApp();
  const [tab, setTab] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);

  const counts: Record<Filter, number> = {
    all: library.length,
    movie: library.filter((item) => item.type === "movie").length,
    series: library.filter((item) => item.type === "series").length,
  };

  const items = useMemo(() => {
    const filtered = tab === "all" ? library : library.filter((item) => item.type === tab);
    return [...filtered].sort((a, b) =>
      sort === "recent"
        ? b.addedAt - a.addedAt
        : a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
  }, [library, tab, sort]);

  // Focus the confirmation so keyboard users land on the decision they opened.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);

  // Finished titles belong in Watched, and one card per show is enough.
  const seen = new Set<string>();
  const continuing = progress.filter((entry) => {
    if (entry.duration <= 0 || entry.position >= entry.duration * 0.9) return false;
    if (seen.has(entry.metaId)) return false;
    seen.add(entry.metaId);
    return true;
  });

  const remove = (item: LibraryItem) => {
    setConfirming(null);
    void toggleLibrary({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
    });
  };

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Library</p>
          <h1>Saved for later</h1>
          <p className="page-sub">
            {items.length === library.length
              ? `${library.length} title${library.length === 1 ? "" : "s"} in your collection`
              : `${items.length} of ${library.length} titles`}
          </p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div className="segmented" role="tablist" aria-label="Filter library by type">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                role="tab"
                aria-selected={tab === value}
                className={tab === value ? "is-active" : ""}
                onClick={() => setTab(value)}
              >
                {label} {counts[value]}
              </button>
            ))}
          </div>
          <div className="segmented" role="group" aria-label="Sort library">
            {SORTS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={sort === value}
                className={sort === value ? "is-active" : ""}
                onClick={() => setSort(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
      </header>

      {continuing.length > 0 ? (
        <Row title="Continue watching" detail={<span className="row-detail">In progress</span>}>
          {continuing.map((entry) => (
            <ContinueCard
              key={entry.key}
              entry={entry}
              name={entry.name}
              poster={entry.poster}
              background={entry.background}
              subtitle={
                entry.type === "series"
                  ? `${seasonLabel(entry.season, entry.episode)}${entry.episodeTitle ? ` · ${entry.episodeTitle}` : ""}`
                  : `${Math.round(progressPercent(entry.position, entry.duration))}% watched`
              }
              position={entry.position}
              duration={entry.duration}
              onOpen={() => void resumeEntry(entry)}
            />
          ))}
        </Row>
      ) : null}

      {items.length === 0 ? (
        <EmptyState
          icon="library"
          title={EMPTY[tab].title}
          body={EMPTY[tab].body}
          action={
            tab === "all" ? (
              <Button variant="primary" icon="compass" onClick={() => navigate({ name: "discover" })}>
                Browse catalogs
              </Button>
            ) : (
              <Button variant="primary" icon="library" onClick={() => setTab("all")}>
                Show all titles
              </Button>
            )
          }
        />
      ) : (
        <div className="grid">
          {items.map((item) => {
            const isConfirming = confirming === item.id;
            return (
              <div className="library-cell" key={item.id}>
                <PosterCard
                  item={{
                    id: item.id,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                    background: item.background,
                  }}
                  onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
                  onPlay={() => void playItem({ id: item.id, type: item.type, name: item.name })}
                />
                {isConfirming ? (
                  <div
                    ref={confirmRef}
                    tabIndex={-1}
                    role="group"
                    aria-label={`Remove ${item.name} from your library?`}
                    style={{ display: "grid", gap: 8, marginTop: 10 }}
                    onKeyDown={(event) => {
                      if (event.key === "Escape") {
                        event.stopPropagation();
                        setConfirming(null);
                      }
                    }}
                  >
                    <Button variant="danger" full onClick={() => remove(item)}>
                      Remove
                    </Button>
                    <Button variant="ghost" full onClick={() => setConfirming(null)}>
                      Keep
                    </Button>
                  </div>
                ) : (
                  <button
                    type="button"
                    className="library-remove"
                    aria-label={`Remove ${item.name} from your library`}
                    onClick={() => setConfirming(item.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
