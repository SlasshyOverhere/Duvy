/**
 * Recap, intro and outro markers, mirrored from `src-tauri/src/skip.rs`.
 *
 * The player never moves the playhead on its own: it only offers a button for
 * the segment under the current position. Each segment runs from half a second
 * before its start until its end; the outro runs to the post-credits scene when
 * there is one, otherwise to the credits end.
 */
export interface SkipEntry {
  recapStart?: number | null;
  recapEnd?: number | null;
  introStart?: number | null;
  introEnd?: number | null;
  outroStart?: number | null;
  outroEnd?: number | null;
  postCreditsStart?: number | null;
  postCreditsEnd?: number | null;
}

export type SkipKind = "recap" | "intro" | "outro" | "credits";

/** Seconds of runtime after the credits that count as something still playing. */
const TAIL_GAP = 20;

interface SkipSegment {
  kind: SkipKind;
  /** Timestamp to seek to. */
  at: number;
  label: string;
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
  if (recap != null) return { kind: "recap", at: recap, label: "Skip recap" };
  const intro = endOf(introStart, introEnd);
  if (intro != null) return { kind: "intro", at: intro, label: "Skip intro" };

  if (outroStart == null || outroStart <= 0 || outroStart >= duration - 2) {
    return null;
  }
  if (position < outroStart - 0.5) return null;

  const { outroEnd, postCreditsStart, postCreditsEnd } = entry;
  // A marker behind the credits would rewind the playhead.
  const later = (at: number | null | undefined, after: number) =>
    at != null && at > after + 2 && at < duration - 1 ? at : null;
  // IntroDB only files post-credits for movies, so on TV the only hint that a
  // scene follows the credits is runtime left after them.
  const marked = later(postCreditsStart, outroStart);
  const creditsEnd = later(outroEnd, outroStart);
  const scene =
    marked ??
    (creditsEnd != null && duration - creditsEnd > TAIL_GAP ? creditsEnd : null);
  const to = scene ?? duration - 1;

  // The offer ends where it lands, so a second click cannot replay the scene.
  // The second of slack absorbs a seek that lands a frame short.
  if (position < to - 1) {
    return {
      kind: "outro",
      at: to,
      label: scene != null ? "Skip to post-credits" : "Skip outro",
    };
  }
  // Credits left after the scene: the tail of the file is all that is left.
  const tail = marked != null ? later(postCreditsEnd, marked) : null;
  if (tail != null && position >= tail) {
    return { kind: "credits", at: duration - 1, label: "Skip credits" };
  }

  return null;
}
