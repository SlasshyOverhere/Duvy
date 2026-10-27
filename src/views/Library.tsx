import { useState } from "react";
import { useApp } from "../lib/store";
import { ContinueCard, PosterCard, Row } from "../components/media";
import { Button, EmptyState } from "../components/ui";
import { progressPercent, seasonLabel } from "../lib/format";

export function LibraryView() {
  const { library, progress, navigate, playItem, resumeEntry, toggleLibrary } = useApp();
  const [tab, setTab] = useState<"all" | "movie" | "series">("all");

  const items = library.filter((item) => (tab === "all" ? true : item.type === tab));

  // Finished titles belong in Watched, and one card per show is enough.
  const seen = new Set<string>();
  const continuing = progress.filter((entry) => {
    if (entry.duration <= 0 || entry.position >= entry.duration * 0.9) return false;
    if (seen.has(entry.metaId)) return false;
    seen.add(entry.metaId);
    return true;
  });

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <p className="kicker">Library</p>
          <h1>Saved for later</h1>
          <p className="page-sub">{library.length} titles in your collection</p>
        </div>
        <div className="segmented" role="tablist" aria-label="Library filter">
          {(
            [
              ["all", "All"],
              ["movie", "Movies"],
              ["series", "Shows"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              aria-selected={tab === value}
              className={tab === value ? "is-active" : ""}
              onClick={() => setTab(value)}
            >
              {label}
            </button>
          ))}
        </div>
      </header>

      {continuing.length > 0 ? (
        <Row title="Continue watching" detail={<span className="row-detail">In progress</span>}>
          {continuing.map((entry) => (
            <ContinueCard
              key={entry.key}
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
          title="Nothing saved yet"
          body="Use the Library button on any title to keep it here. Your watch progress shows up automatically."
          action={
            <Button variant="primary" icon="compass" onClick={() => navigate({ name: "discover" })}>
              Browse catalogs
            </Button>
          }
        />
      ) : (
        <div className="grid">
          {items.map((item) => (
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
              <button
                type="button"
                className="library-remove"
                aria-label={`Remove ${item.name}`}
                onClick={() =>
                  void toggleLibrary({
                    id: item.id,
                    type: item.type,
                    name: item.name,
                    poster: item.poster,
                    background: item.background,
                  })
                }
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
