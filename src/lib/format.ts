/** A human line from anything thrown: IPC errors, addon strings, plain junk. */
export function errorMessage(error: unknown, fallback = "Something went wrong."): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  // Tauri rejects with whatever the command serialized, which may be an object.
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message) return message;
  }
  return fallback;
}

export function formatTime(seconds: number, forceHours = false): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const total = Math.floor(seconds);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  if (hours > 0 || forceHours) return `${hours}:${pad(minutes)}:${pad(secs)}`;
  return `${minutes}:${pad(secs)}`;
}

export function timeAgo(timestamp: number): string {
  if (!timestamp) return "";
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

/** Biggest file first; a source with no size sinks to the end. */
export function byFileSize(
  a: { sizeBytes?: number | null },
  b: { sizeBytes?: number | null },
): number {
  return (b.sizeBytes ?? -1) - (a.sizeBytes ?? -1);
}

/** MiB rounded to one decimal, for update sizes and progress. */
export function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

/** "1h 12m left" style label from the seconds still to play. */
export function remainingLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  // Rounded up: 90s left is "2m left", never the minute it already passed.
  const total = Math.ceil(seconds / 60);
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (!hours) return `${total}m left`;
  return minutes ? `${hours}h ${minutes}m left` : `${hours}h left`;
}

export function progressPercent(position: number, duration: number): number {
  if (!Number.isFinite(position) || !Number.isFinite(duration) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, (position / duration) * 100));
}

/** Share of the timeline cached: playhead plus the seconds mpv has buffered ahead. */
export function bufferPercent(position: number, buffered: number, duration: number): number {
  if (![position, buffered, duration].every(Number.isFinite) || duration <= 0) return 0;
  return Math.min(100, Math.max(0, ((position + buffered) / duration) * 100));
}

export function seasonLabel(season?: number | null, episode?: number | null): string {
  if (season == null || episode == null) return "";
  return `S${season} · E${episode}`;
}

export function episodeCode(video: { season?: number | null; episode?: number | null; number?: number | null }): string {
  const number = video.episode ?? video.number ?? 0;
  if (video.season == null) return `E${number}`;
  return `S${String(video.season).padStart(2, "0")}E${String(number).padStart(2, "0")}`;
}

/** Air order across the whole show: season first, so Specials stay first. */
export function airOrder(video: {
  season?: number | null;
  episode?: number | null;
  number?: number | null;
}): [number, number] {
  return [video.season ?? 1, video.episode ?? video.number ?? 0];
}

/** Everything from the first episode through `target`, for catch-up marking.
 *  Specials are only marked when the target itself is one. */
export function episodesUpTo<
  T extends { season?: number | null; episode?: number | null; number?: number | null },
>(videos: T[], target: T): T[] {
  const [targetSeason, targetEpisode] = airOrder(target);
  return videos.filter((video) => {
    const [season, episode] = airOrder(video);
    if (season === 0 && targetSeason !== 0) return false;
    return season < targetSeason || (season === targetSeason && episode <= targetEpisode);
  });
}

/** A CSS url() only for real image links, so addon art cannot break the rule. */
export function cssImage(value?: string | null): string | undefined {
  if (!value || !/^(https?:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif)[;,])/i.test(value)) {
    return undefined;
  }
  return `url("${value.replace(/["\\]/g, "\\$&")}")`;
}

/** Stable tonal backdrop for artwork placeholders, derived from a title. */
export function placeholderGradient(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 360;
  }
  // One warm-neutral ramp for every placeholder; only the step moves, so a
  // missing poster never introduces a hue the shell did not choose.
  const lift = 14 + (hash % 7);
  return `linear-gradient(145deg, hsl(32 6% ${lift}%), hsl(32 8% ${lift - 7}%))`;
}

/** "101 min" reads as "1h 41m" once it passes an hour; unparseable text stays. */
export function runtimeLabel(value?: string | null): string | null {
  if (!value) return null;
  const parts = value.matchAll(/(\d+)\s*(hours?|hrs?|h|minutes?|mins?|m)\b/gi);
  let minutes = 0;
  for (const [, amount, unit] of parts) {
    minutes += unit.toLowerCase().startsWith("h") ? Number(amount) * 60 : Number(amount);
  }
  if (minutes <= 0) return value;
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function scoreLabel(value?: string | null): string | null {
  if (!value) return null;
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  return number.toFixed(1);
}
