import { useEffect, useMemo, useRef, useState } from "react";
import { useApp } from "../lib/store";
import type { LibraryItem, MetaPreview } from "../lib/types";
import { PosterCard } from "../components/media";
import { Button, EmptyState, Icon, Loading } from "../components/ui";

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
  const { library, booting, navigate, playItem, toggleLibrary } = useApp();
  const [tab, setTab] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("recent");
  const [confirming, setConfirming] = useState<string | null>(null);
  const confirmRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const openerRef = useRef<HTMLButtonElement | null>(null);

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

  // Focus the confirmation so keyboard users land on the decision they opened,
  // then hand focus back to the control that opened it on cancel.
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
    else openerRef.current?.focus();
  }, [confirming]);

  const summary =
    booting && library.length === 0
      ? "Loading your collection"
      : items.length === library.length
        ? `${library.length} title${library.length === 1 ? "" : "s"} in your collection`
        : `${items.length} of ${library.length} titles`;

  const remove = (item: LibraryItem) => {
    setConfirming(null);
    // The card is about to disappear: land focus on the grid, or the heading
    // when this was the last title in the active filter.
    openerRef.current = null;
    if (items.length === 1) headingRef.current?.focus();
    else gridRef.current?.focus();
    void toggleLibrary({
      id: item.id,
      type: item.type,
      name: item.name,
      poster: item.poster,
      background: item.background,
    });
  };

  // Stable card props so PosterCard's memo survives unrelated re-renders.
  const cards = useMemo(
    () =>
      items.map((item) => ({
        item,
        preview: {
          id: item.id,
          type: item.type,
          name: item.name,
          poster: item.poster,
          background: item.background,
        } as MetaPreview,
        onOpen: () => navigate({ name: "details", id: item.id, type: item.type }),
        onPlay: () => void playItem({ id: item.id, type: item.type, name: item.name }),
      })),
    [items, navigate, playItem],
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <nav className="page-tabs" aria-label="Library">
            <button type="button" className="is-active" aria-current="page">
              Library
            </button>
            <button type="button" onClick={() => navigate({ name: "watched" })}>
              Watched
            </button>
          </nav>
          <h1 ref={headingRef} tabIndex={-1}>
            Saved for later
          </h1>
          <p className="page-sub">{summary}</p>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 12 }}>
          <div className="segmented" role="group" aria-label="Filter library by type">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                aria-pressed={tab === value}
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

      {booting && library.length === 0 ? (
        <Loading variant="grid" label="Loading your library" />
      ) : items.length === 0 ? (
        <EmptyState
          icon="library"
          title={EMPTY[tab].title}
          body={EMPTY[tab].body}
          action={
            tab === "all" ? (
              <Button variant="primary" icon="home" onClick={() => navigate({ name: "home" })}>
                Back to home
              </Button>
            ) : (
              <Button variant="primary" icon="library" onClick={() => setTab("all")}>
                Show all titles
              </Button>
            )
          }
        />
      ) : (
        <div
          className="grid"
          ref={gridRef}
          role="list"
          aria-label="Saved titles"
          tabIndex={-1}
        >
          {cards.map((card) => {
            const item = card.item;
            const isConfirming = confirming === item.id;
            return (
              <div className="library-cell" role="listitem" key={item.id}>
                <PosterCard item={card.preview} onOpen={card.onOpen} onPlay={card.onPlay} />
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
                    onClick={(event) => {
                      openerRef.current = event.currentTarget;
                      setConfirming(item.id);
                    }}
                  >
                    <Icon name="x" size={14} />
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
