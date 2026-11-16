import type { HomeFeed, HomeRow } from "./types";

// The last home feed, kept so a launch never waits on the network to paint.
const FEED_CACHE = "home.feed.v1";
const RECO_CACHE = "recos.v2";

// Memory copy for the session; the store alone still costs a parse per visit.
let memory: HomeFeed | null = null;
let memoryAt = 0;
let inFlight: Promise<HomeFeed> | null = null;

export function cachedFeed(): HomeFeed | null {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(FEED_CACHE);
    if (!raw) return null;
    // A store written by an older build or another tool must not crash the home.
    const parsed = JSON.parse(raw) as Partial<HomeFeed> | null;
    if (!parsed || !Array.isArray(parsed.rows)) return null;
    const rows = parsed.rows.filter(
      (row): row is HomeRow => Boolean(row) && Array.isArray((row as HomeRow).items),
    );
    return {
      continueWatching: Array.isArray(parsed.continueWatching) ? parsed.continueWatching : [],
      rows,
      addonErrors: Array.isArray(parsed.addonErrors)
        ? parsed.addonErrors.filter((line): line is string => typeof line === "string")
        : [],
    };
  } catch {
    return null;
  }
}

/** Age of the in-memory feed in ms, or null when nothing was fetched this session. */
export function feedAge(): number | null {
  return memory ? Date.now() - memoryAt : null;
}

function saveFeed(feed: HomeFeed): void {
  memory = feed;
  memoryAt = Date.now();
  try {
    localStorage.setItem(FEED_CACHE, JSON.stringify(feed));
  } catch {
    // A full store only costs the next launch its head start.
  }
}

/** One fetch at a time: concurrent callers share the same promise. */
export function loadFeed(fetchFeed: () => Promise<HomeFeed>): Promise<HomeFeed> {
  inFlight ??= fetchFeed()
    .then((feed) => {
      saveFeed(feed);
      return feed;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

/// The last recommendation rows, so the search screen opens filled.
export function cachedRecos(): HomeRow[] {
  try {
    const raw = localStorage.getItem(RECO_CACHE);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    // Anything but a row list would reach `.map` on the search screen.
    return Array.isArray(parsed)
      ? parsed.filter((row): row is HomeRow => Boolean(row) && Array.isArray((row as HomeRow).items))
      : [];
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
