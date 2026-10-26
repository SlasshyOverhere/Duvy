/**
 * Intro and outro markers, mirrored from `src-tauri/src/skip.rs`.
 *
 * The player checks these on every position tick, so the rule lives here
 * instead of a round trip: the intro fires from half a second before its start
 * until two seconds before its end, the outro from half a second before its
 * start until two seconds before the file ends.
 */
export interface SkipEntry {
  introStart?: number | null;
  introEnd?: number | null;
  outroStart?: number | null;
}

export interface SkipSegment {
  kind: "intro" | "outro";
  /** Timestamp to seek to. */
  at: number;
}

export function findSkip(
  entry: SkipEntry | null,
  position: number,
  duration: number,
): SkipSegment | null {
  if (!entry || !Number.isFinite(position) || !(duration > 0)) return null;

  const { introStart, introEnd, outroStart } = entry;
  if (introStart != null && introEnd != null) {
    const end = Math.min(introEnd, duration);
    if (end - introStart > 2 && position >= introStart - 0.5 && position <= end - 2) {
      return { kind: "intro", at: end };
    }
  }

  if (
    outroStart != null &&
    outroStart > 0 &&
    outroStart < duration - 2 &&
    position >= outroStart - 0.5 &&
    position <= duration - 2
  ) {
    return { kind: "outro", at: duration };
  }

  return null;
}
