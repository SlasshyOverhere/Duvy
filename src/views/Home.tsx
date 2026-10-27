import { useEffect, useState } from "react";
import { api } from "../lib/bridge";
import { cachedFeed, saveFeed } from "../lib/feed";
import { useApp } from "../lib/store";
import type { HomeFeed } from "../lib/types";
import { Hero, ContinueCard, PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, Spinner } from "../components/ui";
import { progressPercent, seasonLabel } from "../lib/format";

// First paint: the shape of the screen, so the wait reads as loading, not empty.
function HomeSkeleton() {
  return (
    <div className="home-skeleton" aria-hidden="true">
      <div className="sk-hero">
        <span className="sk-line sk-badge" />
        <span className="sk-line sk-title" />
        <span className="sk-line sk-title is-short" />
        <span className="sk-line sk-text" />
        <span className="sk-line sk-text is-short" />
        <span className="sk-actions">
          <span className="sk-line sk-button" />
          <span className="sk-line sk-square" />
        </span>
      </div>
      <div className="sk-row">
        <span className="sk-line sk-head" />
        <div className="sk-posters">
          {Array.from({ length: 6 }).map((_, index) => (
            <span key={index} className="sk-poster" />
          ))}
        </div>
      </div>
    </div>
  );
}

// Stremio-style: the last feed paints immediately, the network only refreshes it.
export function HomeView() {
  const {
    addons,
    navigate,
    playItem,
    resumeEntry,
    toggleLibrary,
    inLibrary,
    progress,
  } = useApp();
  const [feed, setFeed] = useState<HomeFeed | null>(cachedFeed);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [slide, setSlide] = useState(0);

  const addonSignature = addons.map((addon) => `${addon.url}:${addon.enabled}`).join("|");

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .home()
      .then((result) => {
        if (!alive) return;
        setFeed(result);
        // Keep the next launch instant, like Stremio does.
        saveFeed(result);
      })
      .catch((e: unknown) => {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [addonSignature]);

  const featured = (feed?.rows?.[0]?.items ?? []).slice(0, 6);
  const hero = featured[slide] ?? featured[0] ?? null;

  useEffect(() => {
    if (slide >= featured.length) setSlide(0);
  }, [featured.length, slide]);

  const resumeProgress = (metaId: string): number | undefined => {
    const entry = progress.find((item) => item.metaId === metaId);
    return entry ? progressPercent(entry.position, entry.duration) : undefined;
  };

  return (
    <div className="home">
      {loading && !feed ? <HomeSkeleton /> : null}

      {hero ? (
        <Hero
          item={hero}
          onOpen={() => navigate({ name: "details", id: hero.id, type: hero.type })}
          onPlay={() => void playItem(hero)}
          onLibrary={() => void toggleLibrary(hero)}
          inLibrary={inLibrary(hero.id)}
          index={slide}
          count={featured.length}
          onPrev={
            featured.length > 1
              ? () => setSlide((current) => (current - 1 + featured.length) % featured.length)
              : undefined
          }
          onNext={
            featured.length > 1
              ? () => setSlide((current) => (current + 1) % featured.length)
              : undefined
          }
        />
      ) : null}

      <div className="home-body">

        {!loading && feed && feed.rows.length === 0 ? (
          <EmptyState
            icon="puzzle"
            title="Your home screen is waiting for addons"
            body="BetterNuvio ships with no content. Add a catalog addon to fill this screen, or connect TMDB for curated rows."
            action={
              <div className="empty-actions">
                <Button
                  variant="primary"
                  icon="puzzle"
                  onClick={() => navigate({ name: "settings", section: "addons" })}
                >
                  Add an addon
                </Button>
                <Button icon="key" onClick={() => navigate({ name: "settings", section: "integrations" })}>
                  Connect TMDB
                </Button>
              </div>
            }
          />
        ) : null}

        {feed && feed.continueWatching.length > 0 ? (
          <Row
            title="Continue watching"
            detail={<span className="row-detail">Pick up where you left off</span>}
          >
            {feed.continueWatching.map((entry) => (
              <ContinueCard
                key={entry.key}
                entry={entry}
                name={entry.name}
                poster={entry.poster}
                background={entry.background}
                subtitle={
                  entry.type === "series"
                    ? `${seasonLabel(entry.season, entry.episode)}${
                        entry.episodeTitle ? ` · ${entry.episodeTitle}` : ""
                      }`
                    : "Movie"
                }
                position={entry.position}
                duration={entry.duration}
                onOpen={() => void resumeEntry(entry)}
              />
            ))}
          </Row>
        ) : null}

        {error && !feed ? (
          <EmptyState
            icon="info"
            title="Could not refresh your home feed"
            body={error}
            action={<Button onClick={() => window.location.reload()}>Try again</Button>}
          />
        ) : null}

        {feed?.addonErrors?.length ? (
          <div className="notice">
            <Icon name="info" size={16} />
            <span>{(feed.addonErrors ?? []).join(" · ")}</span>
          </div>
        ) : null}

        {feed?.rows.map((row) => (
          <Row
            key={row.id}
            title={row.title}
            detail={row.addon ? <span className="row-detail">{row.addon}</span> : undefined}
          >
            {row.items.map((item) => (
              <PosterCard
                key={`${row.id}-${item.id}`}
                item={item}
                progress={resumeProgress(item.id)}
                onOpen={() => navigate({ name: "details", id: item.id, type: item.type })}
                onPlay={() => void playItem(item)}
              />
            ))}
          </Row>
        ))}

        {loading && feed ? (
          <div className="page-loading page-loading-inline">
            <Spinner label="Refreshing catalogs" />
          </div>
        ) : null}
      </div>
    </div>
  );
}
