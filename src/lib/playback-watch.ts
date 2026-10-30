/**
 * Playback watchdog rules.
 *
 * The player is mostly state, not exceptions: a frozen picture, a dead control
 * channel, a track that never arrives. None of it throws, so none of it reaches
 * a crash reporter. These ruleset samples the snapshot the player already
 * pushes and reports the states that can only mean a bug.
 *
 * Pure on purpose: every rule is checked from a script.
 */

export interface Sample {
  /** Wall clock, ms. */
  at: number;
  position: number;
  duration: number;
  buffered: number;
  playing: boolean;
  paused: boolean;
  ended: boolean;
  audio: number;
  subs: number;
  speed: number;
  volume: number;
}

export interface Issue {
  rule: string;
  message: string;
  data: Record<string, unknown>;
}

export interface Watch {
  createdAt: number;
  samples: Sample[];
  fired: Set<string>;
  action: { kind: string; at: number; from: Sample; to: number } | null;
}

/** A frozen playhead this long is a stall, not a slow source. */
const STALL_MS = 10_000;
const STALL_MIN_DELTA = 0.4;
/** A control that has not taken effect in this window was dropped. */
const ACTION_WINDOW_MS = 2_500;
const ACTION_GIVE_UP_MS = 8_000;
/** Backwards by more than this between two ticks, with no seek, is a rewind. */
const JUMP_BACK = 2;
/** mpv echoes whole units; a burst of writes can leave a neighbouring value. */
const VOLUME_SLACK = 2;
const HISTORY = 240;

export function createWatch(now: number): Watch {
  return { createdAt: now, samples: [], fired: new Set(), action: null };
}

export function action(watch: Watch, kind: string, from: Sample, to = 0): void {
  watch.action = { kind, at: from.at, from, to };
}

const round = (value: number) => Math.round(value * 10) / 10;

/** The last minute of the playhead, small enough to ship with a report. */
export function timeline(watch: Watch, limit = 40): string[] {
  const from = watch.samples.slice(-limit);
  if (!from.length) return [];
  const start = from[0].at;
  return from.map((item) => {
    const at = ((item.at - start) / 1000).toFixed(1);
    const flags = `${item.paused ? "paused" : item.playing ? "playing" : "idle"}${
      item.ended ? " ended" : ""
    }`;
    return `+${at}s ${Math.round(item.position)}/${Math.round(item.duration)} buf=${Math.round(
      item.buffered,
    )} audio=${item.audio} subs=${item.subs} ${flags}`;
  });
}

export function sample(watch: Watch, next: Sample): Issue[] {
  watch.samples.push(next);
  if (watch.samples.length > HISTORY) watch.samples.shift();
  // A source mpv already refused is reported once, by the tick handler.
  if (!next.playing && !next.paused && !next.ended) return [];

  const issues: Issue[] = [];
  const fire = (rule: string, message: string, data: Record<string, unknown>) => {
    if (watch.fired.has(rule)) return;
    watch.fired.add(rule);
    issues.push({ rule, message, data });
  };

  if (next.playing && !next.paused && !next.ended) {
    // The anchor is the last sample the playhead actually moved in, so a seek
    // resets it instead of leaving an older, larger position behind it.
    const anchor = watch.samples.reduce(
      (last, item) =>
        Math.abs(item.position - next.position) >= STALL_MIN_DELTA ? item : last,
      watch.samples[0],
    );
    if (next.at - anchor.at >= STALL_MS) {
      fire("stall", "Playback is playing but the position never moves", {
        position: round(next.position),
        duration: round(next.duration),
        buffered: round(next.buffered),
      });
    }
  }

  if (next.playing && next.duration <= 0 && next.at - watch.createdAt > 20_000) {
    fire("no-duration", "Playback reports no duration after 20 seconds", {
      position: round(next.position),
    });
  }

  if (next.ended && next.duration > 60 && next.position < next.duration * 0.85) {
    fire("premature-end", "Playback ended before the end of the file", {
      position: round(next.position),
      duration: round(next.duration),
    });
  }

  const previous = watch.samples[watch.samples.length - 2];
  if (previous && !next.ended && next.position + JUMP_BACK < previous.position) {
    const seeking = watch.action?.kind === "seek" && next.at - watch.action.at < ACTION_GIVE_UP_MS;
    if (!seeking) {
      fire("position-jump", "Playback position jumped backwards without a seek", {
        from: round(previous.position),
        to: round(next.position),
      });
    }
  }

  if (next.duration > 5 && next.position > 5 && next.playing && next.audio === 0) {
    fire("no-audio", "Playback reports no audio track", {
      position: round(next.position),
    });
  }

  const sent = watch.action;
  if (sent) {
    const age = next.at - sent.at;
    if (age > ACTION_WINDOW_MS && age < ACTION_GIVE_UP_MS) {
      const ignored =
        (sent.kind === "pause" && next.paused === sent.from.paused) ||
        (sent.kind === "seek" &&
          next.duration > 0 &&
          Math.abs(next.position - sent.from.position) < 2) ||
        (sent.kind === "speed" && Math.abs(next.speed - sent.to) > 0.01) ||
        (sent.kind === "volume" && Math.abs(next.volume - sent.to) > VOLUME_SLACK);
      if (ignored) {
        const data: Record<string, unknown> = {
          requested: sent.kind === "pause" ? !sent.from.paused : round(sent.to),
          position: round(next.position),
          paused: next.paused,
        };
        // The measured value is what answers "ignored, or just not yet".
        if (sent.kind === "volume") data.volume = round(next.volume);
        fire(`control-${sent.kind}`, `The player ignored a ${sent.kind} request`, data);
      }
    }
    if (age >= ACTION_GIVE_UP_MS) watch.action = null;
  }

  return issues;
}
