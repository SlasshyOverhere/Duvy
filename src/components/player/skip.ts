/**
 * Intro markers, mirrored from `src-tauri/src/skip.rs`.
 *
 * The player checks these on every position tick, so the rule lives here
 * instead of a round trip: the intro fires from half a second before its start
 * until two seconds before its end. The outro is never skipped: jumping the
 * credits to the end of the file would end an episode the viewer chose to keep
 * watching, and seeking into the credits would do it every time.
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
  // Guards mirror `skip::apply`: a live or broken duration has no markers.
  if (
    !entry ||
    !Number.isFinite(position) ||
    !Number.isFinite(duration) ||
    !(duration > 0)
  ) {
    return null;
  }

  const { introStart, introEnd } = entry;
  if (introStart != null && introEnd != null) {
    // A stale marker past the end would otherwise seek to the end.
    if (
      introEnd < duration - 2 &&
      introEnd > introStart + 2 &&
      position >= introStart - 0.5 &&
      position <= introEnd - 2
    ) {
      return { kind: "intro", at: introEnd };
    }
  }

  return null;
}
