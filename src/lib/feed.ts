import type { HomeFeed, HomeRow } from "./types";

// The last home feed, kept so a launch never waits on the network to paint.
const FEED_CACHE = "home.feed.v1";
const RECO_CACHE = "recos.v2";

export function cachedFeed(): HomeFeed | null {
  try {
    const raw = localStorage.getItem(FEED_CACHE);
    return raw ? (JSON.parse(raw) as HomeFeed) : null;
  } catch {
    return null;
  }
}

export function saveFeed(feed: HomeFeed): void {
  try {
    localStorage.setItem(FEED_CACHE, JSON.stringify(feed));
  } catch {
    // A full store only costs the next launch its head start.
  }
}

/// The last recommendation rows, so the search screen opens filled.
export function cachedRecos(): HomeRow[] {
  try {
    const raw = localStorage.getItem(RECO_CACHE);
    return raw ? (JSON.parse(raw) as HomeRow[]) : [];
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
