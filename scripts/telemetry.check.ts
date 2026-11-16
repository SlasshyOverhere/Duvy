// Crash-report rules. Run with: bun scripts/telemetry.check.ts
import {
  cleanText,
  fingerprintOf,
  isNoise,
  MAX_ITEMS,
  MAX_REPORTS,
  MAX_TEXT,
  note,
  resetReportState,
  scrubValue,
  shouldReport,
  traceTail,
  wentBackwards,
} from "../src/lib/errors.ts";
import {
  action,
  createWatch,
  sample,
  type Sample,
} from "../src/lib/playback-watch.ts";

const checks: Array<{ name: string; fn: () => Promise<string[]> | string[] }> = [];

const check = (name: string, fn: () => Promise<string[]> | string[]) => {
  checks.push({ name, fn });
};

check("a link keeps its path and loses its credentials", () => {
  const out = cleanText("https://debrid.example/stream/abc.mkv?token=s3cret&user=me#t=10");
  const bad: string[] = [];
  if (out.includes("s3cret")) bad.push(`token survived: ${out}`);
  if (out.includes("?")) bad.push(`query survived: ${out}`);
  if (out.includes("#")) bad.push(`fragment survived: ${out}`);
  if (!out.includes("https://debrid.example/stream/abc.mkv")) bad.push(`path lost: ${out}`);
  return bad;
});

check("a magnet loses every parameter", () => {
  const out = cleanText("magnet:?xt=urn:btih:abc123&tr=https://tracker.example/announce?passkey=x");
  return out.includes("passkey") ? [`tracker passkey survived: ${out}`] : [];
});

check("a home directory loses the account name", () => {
  const bad: string[] = [];
  for (const path of [
    String.raw`cannot open C:\Users\suman\AppData\Roaming\duvy.db`,
    String.raw`cannot open D:\Benutzer\suman\duvy.db`,
    "cannot open /home/suman/.config/duvy.db",
    "cannot open /Users/suman/Library/duvy.db",
  ]) {
    const out = cleanText(path);
    if (out.includes("suman")) bad.push(`account name survived: ${out}`);
    if (!out.includes("[home]")) bad.push(`path not marked: ${out}`);
  }
  return bad;
});

check("an e-mail address is blanked wherever it appears", () => {
  const out = cleanText("signed in as suman@example.com");
  const key = scrubValue({ email: "suman@example.com", keep: "visible" }) as Record<string, unknown>;
  const bad: string[] = [];
  if (out.includes("suman@example.com")) bad.push(`address survived: ${out}`);
  if (!out.includes("[email]")) bad.push(`address not marked: ${out}`);
  if (JSON.stringify(key).includes("suman@example.com")) bad.push("address survived in a value");
  if (key.keep !== "visible") bad.push("plain value was lost");
  return bad;
});

check("secret keys are blanked at any depth", () => {
  const out = scrubValue({
    token: "abc",
    nested: { infoHash: "deadbeef", apiKey: "k" },
    list: [{ authorization: "Bearer x" }],
    contexts: { culture: { timezone: "Asia/Calcutta" } },
    keep: "visible",
  }) as Record<string, unknown>;
  const seen = JSON.stringify(out);
  const bad: string[] = [];
  for (const leak of ["abc", "deadbeef", "\"k\"", "Bearer x", "Asia/Calcutta"]) {
    if (seen.includes(leak)) bad.push(`${leak} survived: ${seen}`);
  }
  if (!seen.includes("visible")) bad.push(`plain value was lost: ${seen}`);
  return bad;
});

check("a huge payload is cut at the caps", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`k${index}`, "x".repeat(2000)]),
  );
  const out = scrubValue(wide) as Record<string, unknown>;
  const bad: string[] = [];
  const keys = Object.keys(out).length;
  if (keys !== MAX_ITEMS) bad.push(`${keys} keys kept, want exactly ${MAX_ITEMS}`);
  const first = out.k0;
  if (typeof first !== "string" || first.length !== MAX_TEXT) {
    bad.push(`long string kept ${typeof first === "string" ? first.length : typeof first} chars, want ${MAX_TEXT}`);
  }
  const list = scrubValue(Array.from({ length: 200 }, (_, index) => index)) as unknown[];
  if (list.length !== MAX_ITEMS) bad.push(`${list.length} list items kept, want exactly ${MAX_ITEMS}`);
  // A nested object is cut at the depth cap rather than walked to the end.
  let deep: Record<string, unknown> = { end: "x" };
  for (let index = 0; index < 12; index += 1) deep = { down: deep };
  if (!JSON.stringify(scrubValue(deep)).includes("[deep]")) bad.push("a deep object was walked to the end");
  return bad;
});

check("a link that will not parse is blanked", () => {
  const out = cleanText("see https://[bad]/stream?token=s3cret now");
  const bad: string[] = [];
  if (!out.includes("[url]")) bad.push(`an unparsable link was not blanked: ${out}`);
  if (out.includes("s3cret")) bad.push(`token survived: ${out}`);
  if (!out.includes("see ") || !out.includes(" now")) bad.push(`the surrounding text was lost: ${out}`);
  return bad;
});

check("a token in a link with a space is scrubbed", () => {
  const out = cleanText("open https://[bad host]/x?token=s3cret then retry the stream");
  const bad: string[] = [];
  if (out.includes("s3cret")) bad.push(`token survived: ${out}`);
  if (!out.includes("open ") || !out.includes("then retry the stream")) {
    bad.push(`the surrounding text was lost: ${out}`);
  }
  const prose = cleanText("see https://debrid.example/x now");
  if (!prose.includes("now")) bad.push(`prose after a parsed link was lost: ${prose}`);
  return bad;
});

check("expected noise is dropped, real failures are not", () => {
  const bad: string[] = [];
  if (!isNoise("ResizeObserver loop completed with undelivered notifications.")) {
    bad.push("resize loop would be reported");
  }
  if (!isNoise("The operation was aborted.")) bad.push("an abort would be reported");
  if (!isNoise("Script error.")) bad.push("a cross-origin script error would be reported");
  if (isNoise("Cannot read properties of null (reading 'title')")) bad.push("a real bug was dropped");
  if (isNoise("TypeError: x is not a function")) bad.push("a real bug was dropped");
  return bad;
});

check("the same failure reports once, a new one reports", () => {
  resetReportState();
  const bad: string[] = [];
  const error = new TypeError("same every time");
  if (!shouldReport(fingerprintOf(error))) bad.push("first report was dropped");
  if (shouldReport(fingerprintOf(error))) bad.push("duplicate report was sent");
  if (!shouldReport(fingerprintOf(new RangeError("different")))) bad.push("a new failure was dropped");
  resetReportState();
  if (!shouldReport(fingerprintOf(error))) bad.push("the reset did not clear the reported set");
  resetReportState();
  return bad;
});

check("a flood is capped at the exact session maximum", () => {
  resetReportState();
  const bad: string[] = [];
  let sent = 0;
  for (let index = 0; index < MAX_REPORTS * 3; index += 1) {
    if (shouldReport(`flood-${index}`)) sent += 1;
  }
  if (sent !== MAX_REPORTS) bad.push(`${sent} reports sent, want exactly ${MAX_REPORTS}`);
  if (shouldReport("flood-past-the-cap")) bad.push("a report was accepted past the cap");
  resetReportState();
  if (!shouldReport("flood-after-reset")) bad.push("the reset did not clear the cap");
  resetReportState();
  return bad;
});

check("a decision that cannot be serialized is still recorded", () => {
  const loop: Record<string, unknown> = {};
  loop.self = loop;
  note("circular note", loop);
  const tail = traceTail();
  const last = tail[tail.length - 1] ?? "";
  return last.includes("circular note") ? [] : ["the note was dropped with its unserializable data"];
});

check("the recorder keeps the last decisions, scrubbed", () => {
  const bad: string[] = [];
  for (let index = 0; index < 60; index += 1) {
    note("open requested", {
      index,
      session: "tt1:1:2",
      url: "https://cdn.example/s.mkv?token=leakme",
      magnet: "magnet:?xt=urn:btih:abc&tr=https://tracker.example/announce?passkey=xyz",
    });
  }
  const tail = traceTail();
  if (tail.length !== 40) bad.push(`tail length ${tail.length}, want 40`);
  if (!tail[tail.length - 1].includes("index\":59")) bad.push("the newest note is not last");
  const joined = tail.join("\n");
  if (joined.includes("leakme")) bad.push("a token survived in the trace");
  if (joined.includes("passkey")) bad.push("a tracker passkey survived in the trace");
  if (!joined.includes("tt1:1:2")) bad.push("session context was lost");
  return bad;
});

// --- playback watchdog -----------------------------------------------------

const tick = (at: number, over: Partial<Sample> = {}): Sample => ({
  at,
  position: at / 1000,
  duration: 600,
  buffered: 30,
  playing: true,
  paused: false,
  ended: false,
  audio: 2,
  subs: 0,
  speed: 1,
  volume: 100,
  ...over,
});

/** Feed a run of ticks a second apart and collect the rules that fired. */
function run(ticks: Sample[], armed?: { kind: string; to?: number }): string[] {
  const watch = createWatch(ticks[0]?.at ?? 0);
  if (armed) action(watch, armed.kind, ticks[0], armed.to);
  const fired: string[] = [];
  for (const item of ticks) {
    for (const issue of sample(watch, item)) fired.push(issue.rule);
  }
  return fired;
}

check("a frozen playhead is a stall, a moving one is not", () => {
  const bad: string[] = [];
  const frozen = run(Array.from({ length: 14 }, (_, i) => tick(i * 1000, { position: 100 })));
  if (!frozen.includes("stall")) bad.push("a frozen position was not reported");
  if (frozen.filter((rule) => rule === "stall").length !== 1) bad.push("the stall repeated");
  const moving = run(Array.from({ length: 14 }, (_, i) => tick(i * 1000, { position: 100 + i })));
  if (moving.includes("stall")) bad.push("a playing position was called a stall");
  // A seek drops the playhead: the older, larger position must not read as a
  // freeze once the playhead sits still while the new position settles.
  const sought = run([
    ...Array.from({ length: 12 }, (_, i) => tick(i * 1000, { position: 900 + i })),
    ...Array.from({ length: 6 }, (_, i) => tick((i + 12) * 1000, { position: 40 })),
  ]);
  if (sought.includes("stall")) bad.push("a seek backwards was called a stall");
  return bad;
});

check("an early end is reported, a real one is not", () => {
  const bad: string[] = [];
  const early = run([tick(0), tick(1000, { position: 100, ended: true })]);
  if (!early.includes("premature-end")) bad.push("an end at 100/600 was missed");
  const real = run([tick(0), tick(1000, { position: 599, ended: true })]);
  if (real.includes("premature-end")) bad.push("a real end was called early");
  return bad;
});

check("a dropped pause request is caught", () => {
  const bad: string[] = [];
  const dropped = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { paused: false })),
    { kind: "pause" },
  );
  if (!dropped.includes("control-pause")) bad.push("an ignored pause was missed");
  const honoured = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { paused: i > 0 })),
    { kind: "pause" },
  );
  if (honoured.includes("control-pause")) bad.push("a pause that took effect was flagged");
  return bad;
});

check("a volume request is judged by the echo, not a rounding race", () => {
  const bad: string[] = [];
  const dropped = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { volume: 100 })),
    { kind: "volume", to: 124 },
  );
  if (!dropped.includes("control-volume")) bad.push("a request that never landed was missed");
  // A burst of writes can land one unit off the last value the app recorded.
  const beside = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { volume: 125 })),
    { kind: "volume", to: 124 },
  );
  if (beside.includes("control-volume")) bad.push("a neighbouring volume was called ignored");
  const honoured = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { volume: 124 })),
    { kind: "volume", to: 124 },
  );
  if (honoured.includes("control-volume")) bad.push("a volume that took effect was flagged");
  return bad;
});

check("a seek that never lands is caught", () => {
  const bad: string[] = [];
  const dropped = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { position: 100 })),
    { kind: "seek", to: 300 },
  );
  if (!dropped.includes("control-seek")) bad.push("a seek that never moved was missed");
  const honoured = run(
    Array.from({ length: 6 }, (_, i) => tick(i * 1000, { position: i > 1 ? 300 : 100 })),
    { kind: "seek", to: 300 },
  );
  if (honoured.includes("control-seek")) bad.push("a seek that landed was flagged");
  return bad;
});

check("silent audio is caught, a track present is not", () => {
  const bad: string[] = [];
  if (!run([tick(0), tick(6000, { position: 40, audio: 0 })]).includes("no-audio")) {
    bad.push("zero audio tracks was missed");
  }
  if (run([tick(0), tick(6000, { position: 40, audio: 2 })]).includes("no-audio")) {
    bad.push("a normal audio track was flagged");
  }
  return bad;
});

check("a rewind without a seek is caught", () => {
  const bad: string[] = [];
  const jumped = run([tick(0, { position: 100 }), tick(1000, { position: 50 })]);
  if (!jumped.includes("position-jump")) bad.push("a backwards jump was missed");
  const seeking = run([tick(0, { position: 100 }), tick(1000, { position: 50 })], {
    kind: "seek",
    to: 50,
  });
  if (seeking.includes("position-jump")) bad.push("a deliberate seek was flagged");
  return bad;
});

check("a container that never reports a duration is caught", () => {
  const bad: string[] = [];
  const missing = run(Array.from({ length: 26 }, (_, i) => tick(i * 1000, { duration: 0 })));
  if (!missing.includes("no-duration")) bad.push("a missing duration went unnoticed");
  const fine = run(Array.from({ length: 26 }, (_, i) => tick(i * 1000)));
  if (fine.includes("no-duration")) bad.push("a known duration was flagged");
  return bad;
});

check("an earlier episode is caught, a later one is not", () => {
  const bad: string[] = [];
  if (!wentBackwards({ season: 1, episode: 1 }, { season: 1, episode: 2 })) {
    bad.push("E1 before E2 was missed");
  }
  if (wentBackwards({ season: 1, episode: 2 }, { season: 1, episode: 1 })) {
    bad.push("a forward move was flagged");
  }
  if (!wentBackwards({ season: 1, episode: 9 }, { season: 2, episode: 1 })) {
    bad.push("a season rollback was missed");
  }
  if (wentBackwards({ season: 2, episode: 1 }, { season: 1, episode: 9 })) {
    bad.push("a season advance was flagged");
  }
  if (wentBackwards({ season: null, episode: null }, { season: 1, episode: 2 })) {
    bad.push("a movie was compared as an episode");
  }
  return bad;
});

let failed = 0;
for (const { name, fn } of checks) {
  let detail: string[];
  try {
    detail = await fn();
  } catch (error) {
    detail = [`threw: ${(error as Error).message}`];
  }
  if (detail.length === 0) {
    console.log(`PASS  ${name}`);
  } else {
    failed += 1;
    console.log(`FAIL  ${name}`);
    for (const line of detail) console.log(`      - ${line}`);
  }
}
console.log(`\n${checks.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
