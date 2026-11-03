import { useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { api } from "../lib/bridge";
import { cachedFeed, feedAge, loadFeed } from "../lib/feed";
import { useApp } from "../lib/store";
import type { HomeFeed, MetaPreview, ProgressItem } from "../lib/types";
import { Hero, ContinueCard, PosterCard, Row } from "../components/media";
import { Button, EmptyState, Icon, Spinner } from "../components/ui";
import { progressPercent, seasonLabel } from "../lib/format";

const FEED_TTL = 60_000;
// The signature of the addon set the cached feed was built from.
let feedSig = "";

/** Next episode after a finished one, or null when the show is over. */
const nextUpCache = new Map<string, ProgressItem | null>();

function cachedNextUp(): Map<string, ProgressItem> {
  const map = new Map<string, ProgressItem>();
  for (const [key, entry] of nextUpCache) {
    if (entry) map.set(key, entry);
  }
  return map;
}

// Six of the row's top twenty, drawn per feed, so a launch does not open on the
// same poster three days running. The row itself still starts at number one.
function pickFeatured(items: MetaPreview[]): MetaPreview[] {
  const pool = items.slice(0, 20);
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 6);
}

// Screen-reader only: the page keeps a level-one heading even without a hero.
const srOnly: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  border: 0,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
};

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
  const [nextUp, setNextUp] = useState<Map<string, ProgressItem>>(cachedNextUp);

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

  const featured = useMemo(
    () => pickFeatured(feed?.rows?.[0]?.items ?? []),
    [feed],
  );
  const hero = featured[slide] ?? featured[0] ?? null;
  const nextBackdrop = featured[(slide + 1) % featured.length]?.background;

  // A cached feed can predate this build; rows are the only field the screen needs.
  const feedRows = useMemo(
    () => (feed?.rows ?? []).filter((row) => (row.items?.length ?? 0) > 0),
    [feed],
  );

  // Warm the next backdrop so the rotation never flashes the placeholder.
  useEffect(() => {
    if (!nextBackdrop) return;
    const img = new Image();
    img.src = nextBackdrop;
  }, [nextBackdrop]);

  useEffect(() => {
    if (slide >= featured.length) setSlide(0);
  }, [featured.length, slide]);

  // The newest row per title decides what the card shows. A finished episode
  // is kept until its next one is resolved, so the show never drops off the row.
  const latestRows = useMemo(() => {
    const seen = new Set<string>();
    const rows: ProgressItem[] = [];
    for (const row of progress) {
      if (seen.has(row.metaId)) continue;
      seen.add(row.metaId);
      if (row.duration <= 0 || row.position <= 5) continue;
      rows.push(row);
    }
    return rows;
  }, [progress]);

  // Continue watching off live store state, so a mark or a clear lands without
  // reloading the whole feed.
  const continuing = useMemo(() => {
    const marked = new Set(watched.map((mark) => mark.key));
    const rows: { entry: ProgressItem; next: boolean }[] = [];
    for (const row of latestRows) {
      const finished =
        marked.has(row.key) || progressPercent(row.position, row.duration) >= 90;
      if (!finished) {
        rows.push({ entry: row, next: false });
        continue;
      }
      if (row.type !== "series") continue;
      const next = nextUp.get(row.key);
      if (next) rows.push({ entry: next, next: true });
    }
    return rows.slice(0, 30);
  }, [latestRows, watched, nextUp]);

  // A finished episode needs the next one from the catalog; it is not in the
  // progress row. Cache per episode so a refresh never refetches a known title.
  useEffect(() => {
    const finishedKeys = new Set(watched.map((mark) => mark.key));
    const pending = latestRows.filter(
      (row) =>
        row.type === "series" &&
        (finishedKeys.has(row.key) || progressPercent(row.position, row.duration) >= 90) &&
        !nextUpCache.has(row.key),
    );
    if (pending.length === 0) {
      setNextUp(cachedNextUp());
      return;
    }
    let alive = true;
    void Promise.allSettled(
      pending.map(async (row) => {
        const details = await api.details(row.metaId, row.type);
        const queue = [...details.videos].sort(
          (a, b) =>
            (a.season ?? 0) - (b.season ?? 0) ||
            (a.episode ?? a.number ?? 0) - (b.episode ?? b.number ?? 0),
        );
        const at = queue.findIndex(
          (video) =>
            video.season === row.season &&
            (video.episode ?? video.number) === row.episode,
        );
        const video = at >= 0 ? queue[at + 1] : undefined;
        const season = video?.season ?? null;
        const episode = video ? (video.episode ?? video.number ?? null) : null;
        nextUpCache.set(
          row.key,
          video && season != null && episode != null
            ? {
                key: `${row.metaId}:${season}:${episode}`,
                metaId: row.metaId,
                type: row.type,
                name: row.name,
                poster: row.poster,
                background: video.thumbnail ?? row.background ?? row.poster,
                season,
                episode,
                episodeTitle: video.title ?? null,
                position: 0,
                duration: 0,
                updatedAt: row.updatedAt,
              }
            : null,
        );
      }),
    ).then(() => {
      if (!alive) return;
      setNextUp(cachedNextUp());
    });
    return () => {
      alive = false;
    };
  }, [latestRows, watched]);

  // One map for the card progress bars, so a row of cards costs no scans.
  const resumeProgress = useMemo(() => {
    const marked = new Set(watched.map((mark) => mark.key));
    const seen = new Set<string>();
    const map = new Map<string, ProgressItem>();
    for (const entry of progress) {
      // Same rule as the row above: the newest row decides the title.
      if (seen.has(entry.metaId)) continue;
      seen.add(entry.metaId);
      if (!marked.has(entry.key)) map.set(entry.metaId, entry);
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

        {hero ? null : <h1 style={srOnly}>Home</h1>}

        {!loading && feed && feedRows.length === 0 ? (
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
                <Button icon="key" variant="text" onClick={() => navigate({ name: "settings", section: "integrations" })}>
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
            {continuing.map(({ entry, next }) => (
              <ContinueCard
                key={entry.key}
                entry={entry}
                next={next}
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

        {error && feed ? (
          <div className="notice">
            <Icon name="info" size={16} />
            <span>Could not refresh your home feed: {error}</span>
          </div>
        ) : null}

        {feed?.addonErrors?.length ? (
          <div className="notice">
            <Icon name="info" size={16} />
            <span>{(feed.addonErrors ?? []).join(" · ")}</span>
          </div>
        ) : null}

        {feedRows.map((row) => (
          <Row
            key={row.id}
            title={row.title}
            detail={row.addon ? <span className="row-detail">{row.addon}</span> : undefined}
          >
            {row.items.map((item) => (
              <PosterCard
                key={`${row.id}-${item.id}-${item.type}`}
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
