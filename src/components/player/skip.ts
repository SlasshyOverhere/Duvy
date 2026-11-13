/**
 * Recap, intro and outro markers, mirrored from `src-tauri/src/skip.rs`.
 *
 * The player never moves the playhead on its own: it only offers a button for
 * the segment under the current position. Each segment runs from half a second
 * before its start until its end; the outro runs to the end of the file.
 */
export interface SkipEntry {
  recapStart?: number | null;
  recapEnd?: number | null;
  introStart?: number | null;
  introEnd?: number | null;
  outroStart?: number | null;
}

export type SkipKind = "recap" | "intro" | "outro";

interface SkipSegment {
  kind: SkipKind;
  /** Timestamp to seek to. */
  at: number;
}

export function findSkip(
  entry: SkipEntry | null,
  position: number,
  duration: number,
): SkipSegment | null {
  // Guards mirror `skip::validate`: a live or broken duration has no markers.
  if (
    !entry ||
    !Number.isFinite(position) ||
    !Number.isFinite(duration) ||
    !(duration > 0)
  ) {
    return null;
  }

  // A stale marker past the end would otherwise land on the credits.
  const endOf = (start?: number | null, end?: number | null) =>
    start != null &&
    end != null &&
    end < duration - 2 &&
    end > start + 2 &&
    position >= start - 0.5 &&
    position < end
      ? end
      : null;

  const { recapStart, recapEnd, introStart, introEnd, outroStart } = entry;
  const recap = endOf(recapStart, recapEnd);
  if (recap != null) return { kind: "recap", at: recap };
  const intro = endOf(introStart, introEnd);
  if (intro != null) return { kind: "intro", at: intro };

  if (outroStart != null && outroStart > 0 && outroStart < duration - 2) {
    if (position >= outroStart - 0.5) {
      return { kind: "outro", at: duration - 1 };
    }
  }

  return null;
}
