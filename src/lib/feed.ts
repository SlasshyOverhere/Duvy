import type { HomeFeed, HomeRow } from "./types";

// The last home feed, kept so a launch never waits on the network to paint.
const FEED_CACHE = "home.feed.v1";
const RECO_CACHE = "recos.v2";

// Memory copy for the session; the store alone still costs a parse per visit.
let memory: HomeFeed | null = null;
let memoryAt = 0;
// Keyed by the addon set: a feed for the old set must not answer a new one.
let inFlight: { key: string; promise: Promise<HomeFeed> } | null = null;

function validRow(row: unknown): row is HomeRow {
  const candidate = row as HomeRow | null;
  return Boolean(
    candidate &&
      typeof candidate.id === "string" &&
      typeof candidate.title === "string" &&
      Array.isArray(candidate.items),
  );
}

export function cachedFeed(): HomeFeed | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(FEED_CACHE);
    if (!raw) return null;
    // A store written by an older build or another tool must not crash the home.
    const parsed = JSON.parse(raw) as HomeFeed | null;
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    return { ...parsed, rows: parsed.rows.filter(validRow) };
  } catch {
    return null;
  }
}

/** Age of the in-memory feed in ms, or null when nothing was fetched this session. */
export function feedAge(): number | null {
  return memory ? Date.now() - memoryAt : null;
}

/** The in-memory feed when it is younger than `maxAgeMs`, otherwise null. */
export function cachedFeedFresh(maxAgeMs: number): HomeFeed | null {
  const age = feedAge();
  if (memory && age !== null && age <= maxAgeMs) return memory;
  return null;
}

export function saveFeed(feed: HomeFeed): void {
  memory = feed;
  memoryAt = Date.now();
  try {
    localStorage.setItem(FEED_CACHE, JSON.stringify(feed));
  } catch {
    // A full store only costs the next launch its head start.
  }
}

/** Concurrent callers for the same addon set share one fetch. */
export function loadFeed(key: string, fetchFeed: () => Promise<HomeFeed>): Promise<HomeFeed> {
  if (inFlight?.key === key) return inFlight.promise;
    const promise = fetchFeed()
    .then((feed) => {
      // A fetch for an older addon set must not overwrite the newer cache.
      if (inFlight?.promise !== promise) return feed;
      saveFeed(feed);
      return feed;
    })
    .finally(() => {
      if (inFlight?.promise === promise) inFlight = null;
    });
  inFlight = { key, promise };
  return promise;
}

/// The last recommendation rows, so the search screen opens filled.
export function cachedRecos(): HomeRow[] {
  try {
    const raw = localStorage.getItem(RECO_CACHE);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything but a row list would reach `.map` on the search screen.
    return Array.isArray(parsed) ? parsed.filter(validRow) : [];
  } catch {
    return [];
  }
}

export function saveRecos(rows: HomeRow[]): void {
  try {
    localStorage.setItem(RECO_CACHE, JSON.stringify(rows));
  } catch {
    // Same story: a full store only costs the next visit a spinner.
  }
}
