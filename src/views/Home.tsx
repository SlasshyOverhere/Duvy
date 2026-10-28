import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../lib/bridge";
import { cachedFeed, feedAge, loadFeed } from "../lib/feed";
import { useApp } from "../lib/store";
import type { HomeFeed, ProgressItem } from "../lib/types";
import { Hero, ContinueCard, PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, Spinner } from "../components/ui";
import { progressPercent, seasonLabel } from "../lib/format";

const FEED_TTL = 60_000;
// The signature of the addon set the cached feed was built from.
let feedSig = "";

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
    watched,
  } = useApp();
  const addonSignature = addons.map((addon) => `${addon.url}:${addon.enabled}`).join("|");
  // A feed this session already fetched is reused instead of refetched.
  const age = feedAge();
  const fresh = feedSig === addonSignature && age !== null && age <= FEED_TTL;
  const [feed, setFeed] = useState<HomeFeed | null>(cachedFeed);
  const [loading, setLoading] = useState(!fresh);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [slide, setSlide] = useState(0);

  useEffect(() => {
    if (attempt === 0 && fresh) {
      setLoading(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setError(null);
    loadFeed(() => api.home())
      .then((result) => {
        if (!alive) return;
        feedSig = addonSignature;
        setFeed(result);
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
  }, [addonSignature, attempt]);

  const featured = (feed?.rows?.[0]?.items ?? []).slice(0, 6);
  const hero = featured[slide] ?? featured[0] ?? null;
  const nextBackdrop = featured[(slide + 1) % featured.length]?.background;

  // Warm the next backdrop so the rotation never flashes the placeholder.
  useEffect(() => {
    if (!nextBackdrop) return;
    const img = new Image();
    img.src = nextBackdrop;
  }, [nextBackdrop]);

  useEffect(() => {
    if (slide >= featured.length) setSlide(0);
  }, [featured.length, slide]);

  // Continue watching off live store state, so a mark or a clear lands without
  // reloading the whole feed.
  const continuing = useMemo(() => {
    const seen = new Set<string>();
    const rows: ProgressItem[] = [];
    for (const row of progress) {
      if (row.duration <= 0 || row.position <= 5) continue;
      if (progressPercent(row.position, row.duration) >= 90) continue;
      if (seen.has(row.metaId)) continue;
      const marked = watched.some((mark) => mark.key === row.key);
      if (marked) continue;
      seen.add(row.metaId);
      rows.push(row);
    }
    return rows.slice(0, 30);
  }, [progress, watched]);

  // One map for the card progress bars, so a row of cards costs no scans.
  const resumeProgress = useMemo(() => {
    const marked = new Set(watched.map((mark) => mark.key));
    const map = new Map<string, ProgressItem>();
    for (const entry of progress) {
      if (marked.has(entry.key)) continue;
      if (!map.has(entry.metaId)) map.set(entry.metaId, entry);
    }
    return map;
  }, [progress, watched]);

  const nextSlide = useCallback(
    () => setSlide((current) => (current + 1) % featured.length),
    [featured.length],
  );

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
          onSelect={featured.length > 1 ? setSlide : undefined}
          onNext={featured.length > 1 ? nextSlide : undefined}
        />
      ) : null}

      <div className="home-body">

        {!loading && feed && feed.rows.length === 0 ? (
          <EmptyState
            icon="puzzle"
            title="No catalog answered"
            body="Cinemeta is built in, so this is usually a connection problem. Try again, add a catalog addon, or connect TMDB for curated rows."
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

        {continuing.length > 0 ? (
          <Row
            title="Continue watching"
            detail={<span className="row-detail">Pick up where you left off</span>}
          >
            {continuing.map((entry) => (
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
            action={
              <Button onClick={() => setAttempt((count) => count + 1)}>Try again</Button>
            }
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
                entry={resumeProgress.get(item.id)}
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
