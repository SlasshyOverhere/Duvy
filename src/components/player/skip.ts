/**
 * Intro and outro markers, mirrored from `src-tauri/src/skip.rs`.
 *
 * The player never moves the playhead on its own: it only offers a button for
 * the segment under the current position. The intro runs from half a second
 * before its start until its end; the outro runs from half a second before its
 * start to the end of the file.
 */
export interface SkipEntry {
  introStart?: number | null;
  introEnd?: number | null;
  outroStart?: number | null;
}

interface SkipSegment {
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

  const { introStart, introEnd, outroStart } = entry;
  if (introStart != null && introEnd != null) {
    // A stale marker past the end would otherwise land on the credits.
    if (
      introEnd < duration - 2 &&
      introEnd > introStart + 2 &&
      position >= introStart - 0.5 &&
      position < introEnd
    ) {
      return { kind: "intro", at: introEnd };
    }
  }

  if (outroStart != null && outroStart > 0 && outroStart < duration - 2) {
    if (position >= outroStart - 0.5) {
      return { kind: "outro", at: duration - 1 };
    }
  }

  return null;
}
