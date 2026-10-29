// Crash-report rules. Run with: bun scripts/telemetry.check.ts
import {
  cleanText,
  fingerprintOf,
  isNoise,
  note,
  scrubValue,
  shouldReport,
  traceTail,
  wentBackwards,
} from "../src/lib/errors.ts";

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
  const out = cleanText(String.raw`cannot open C:\Users\suman\AppData\Roaming\duvy.db`);
  const bad: string[] = [];
  if (out.includes("suman")) bad.push(`account name survived: ${out}`);
  if (!out.includes("[home]")) bad.push(`path not marked: ${out}`);
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

check("a huge payload is cut down", () => {
  const wide = Object.fromEntries(
    Array.from({ length: 200 }, (_, index) => [`k${index}`, "x".repeat(2000)]),
  );
  const out = scrubValue(wide) as Record<string, unknown>;
  const bad: string[] = [];
  if (Object.keys(out).length > 50) bad.push(`${Object.keys(out).length} keys kept`);
  const first = out.k0;
  if (typeof first !== "string" || first.length > 500) bad.push(`long string kept (${String(first).length})`);
  return bad;
});

check("expected noise is dropped, real failures are not", () => {
  const bad: string[] = [];
  if (!isNoise("ResizeObserver loop completed with undelivered notifications.")) {
    bad.push("resize loop would be reported");
  }
  if (!isNoise("The operation was aborted.")) bad.push("an abort would be reported");
  if (isNoise("Cannot read properties of null (reading 'title')")) bad.push("a real bug was dropped");
  return bad;
});

check("the same failure reports once", () => {
  const error = new TypeError("same every time");
  const bad: string[] = [];
  if (!shouldReport(fingerprintOf(error))) bad.push("first report was dropped");
  if (shouldReport(fingerprintOf(error))) bad.push("duplicate report was sent");
  return bad;
});

check("a flood is capped", () => {
  let sent = 0;
  for (let index = 0; index < 200; index += 1) {
    if (shouldReport(`flood-${index}`)) sent += 1;
  }
  // The cap counts every report this session, so it includes the ones above.
  return sent > 30 ? [`${sent} events escaped the cap`] : [];
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
