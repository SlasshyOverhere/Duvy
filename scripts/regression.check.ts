// Updater and player lifecycle regression guards.
// Run with: bun scripts/regression.check.ts
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readPayload, validUpdate } from "../src/lib/bridge.ts";
import { findSkip } from "../src/components/player/skip.ts";
import { airsLabel } from "../src/lib/format.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(root + rel, "utf8");

const updates = read("src-tauri/src/updates.rs");
const commands = read("src-tauri/src/commands.rs");
const player = read("src-tauri/src/player.rs");
const store = read("src/lib/store.tsx");
const playerView = read("src/views/Player.tsx");
// Subtitle clamps and helpers live in the player hud module now.
const playerHud = read("src/components/player/hud.ts");
const drawer = read("src/components/StreamDrawer.tsx");
const settingsView = read("src/views/Settings.tsx");
const rustSettings = read("src-tauri/src/settings.rs");

/** Slice a top-level Rust function by balancing braces past strings and comments. */
function rustFn(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\b`));
  if (at < 0) return "";
  const open = src.indexOf("{", at);
  if (open < 0) return "";
  let depth = 0;
  for (let i = open; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const end = src.indexOf("\n", i);
      if (end < 0) break;
      i = end;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) break;
      i = end + 1;
      continue;
    }
    if (ch === '"') {
      for (i += 1; i < src.length && src[i] !== '"'; i += 1) if (src[i] === "\\") i += 1;
      continue;
    }
    if (ch === "{") depth += 1;
    else if (ch === "}" && (depth -= 1) === 0) return src.slice(at, i + 1);
  }
  return src.slice(at);
}

const checks: Array<{ name: string; fn: () => string[] | Promise<string[]> }> = [];
const run = (name: string, fn: () => string[] | Promise<string[]>) => checks.push({ name, fn });

run("air dates read as calendar days", () => {
  const out: string[] = [];
  // Midday local, so a DST shift cannot move the day count.
  const noon = (days: number) => new Date(2026, 2, 10 + days, 12).getTime();
  const cases: Array<[number, string | null]> = [
    [noon(0), "Airs today"],
    [noon(1), "Airs tomorrow"],
    [noon(5), "Airs in 5 days"],
    [noon(-1), null],
  ];
  for (const [at, want] of cases) {
    const got = airsLabel(at, noon(0));
    if (got !== want) out.push(`air date +${Math.round((at - noon(0)) / 86400000)}d read as ${got}, wanted ${want}`);
  }
  if (airsLabel(Number.NaN) !== null) out.push("a missing air date produced a label");
  return out;
});

run("untrusted payloads are read before they reach render", () => {
  const out: string[] = [];
  const feed = readPayload("home_feed", {
    rows: [
      { id: "top", title: "Top", items: [{ id: "tt1", type: "movie", name: "A" }, null] },
      { id: "", title: "no key", items: [{ id: "tt2", type: "movie", name: "B" }] },
    ],
    addonErrors: ["boom", 7, null],
  }) as { rows: Array<{ id: string; items: unknown[] }>; addonErrors: unknown[] };
  if (feed.rows.length !== 1) out.push(`a row without an id reached the home rows (${feed.rows.length} rows)`);
  if (feed.rows[0]?.items.length !== 1) out.push("a junk feed item reached the home rows");
  if (feed.addonErrors.join() !== "boom") {
    out.push(`a non-string addonErrors reached the notice: ${JSON.stringify(feed.addonErrors)}`);
  }
  // A payload of the wrong shape is emptied, never passed through as-is.
  const empty = readPayload("home_feed", { rows: "nope", addonErrors: 5 }) as {
    rows: unknown[];
    addonErrors: unknown[];
  };
  if (empty.rows.length !== 0 || empty.addonErrors.length !== 0) {
    out.push("a wrongly typed feed survived as-is");
  }
  const streams = readPayload("streams", [
    { addon: "x", quality: null, infoHash: 7 },
    null,
    "junk",
  ]) as Array<{ quality: string; infoHash: unknown }>;
  if (streams.length !== 1 || streams[0].quality !== "" || streams[0].infoHash !== null) {
    out.push("a null quality, a numeric info hash or a junk stream was not normalized");
  }
  if (
    validUpdate(null) !== null ||
    validUpdate({ version: 4 }) !== null ||
    validUpdate({ version: "" }) !== null ||
    validUpdate({ version: "   " }) !== null
  ) {
    out.push("an update without a version string was accepted");
  }
  if (validUpdate({ version: "0.2.0" })?.version !== "0.2.0") {
    out.push("a real update payload was dropped");
  }
  return out;
});

run("update check runs at launch", () => {
  const watch = rustFn(updates, "watch");
  if (!watch) return ["updates.rs: watch() not found"];
  const out: string[] = [];
  const checkAt = watch.indexOf("update_check(");
  const sleepAt = watch.indexOf("sleep(");
  if (checkAt < 0) return ["updates.rs: watch() never checks for an update"];
  if (sleepAt >= 0 && sleepAt < checkAt) out.push("watch() sleeps before the first update check");
  return out;
});

run("sentinel: update check cannot hang", () => {
  const out: string[] = [];
  const fetch = rustFn(updates, "fetch");
  if (!fetch) return ["updates.rs: fetch() not found"];
  if (!fetch.includes("updater_builder")) {
    out.push("fetch() uses the plugin default with no timeout");
  }
  if (!/\.timeout\(/.test(fetch)) {
    out.push("fetch() sets no request timeout");
  }
  return out;
});

run("sentinel: failed update check retries soon", () => {
  const out: string[] = [];
  const watch = rustFn(updates, "watch");
  if (!watch.includes("retry_after(")) {
    out.push("watch() sleeps the full recheck interval after a failed check");
  }
  if (!/\bErr\(/.test(watch)) {
    out.push("watch() swallows a failed check without retrying");
  }
  if (!/fn\s+retry_after\b/.test(updates)) {
    out.push("updates.rs: no retry_after() backoff for a failed check");
  }
  return out;
});

run("sentinel: install reuses the checked release", () => {
  const out: string[] = [];
  const install = rustFn(updates, "update_install");
  if (!install) return ["updates.rs: update_install() not found"];
  const cachedAt = install.indexOf("cached()");
  const fetchAt = install.indexOf("fetch(");
  if (cachedAt < 0) {
    out.push("update_install() does not reuse the release the check found");
  }
  // A network re-check may only happen as the fallback when nothing was cached.
  if (fetchAt >= 0 && fetchAt < cachedAt) {
    out.push("update_install() re-checks the feed before downloading");
  }
  return out;
});

run("sentinel: download progress is throttled", () => {
  const download = rustFn(updates, "download");
  if (!download) return ["updates.rs: download() not found"];
  if (!/elapsed\(\)/.test(download)) {
    return ["update:progress is emitted for every network chunk"];
  }
  return [];
});

run("sentinel: stop emits player:closed and awaits no torrent teardown", () => {
  const out: string[] = [];
  const stop = rustFn(commands, "player_stop");
  if (!stop) return ["commands.rs: player_stop() not found"];
  if (stop.indexOf('emit("player:closed"') < 0) out.push("player_stop does not emit player:closed");
  if (stop.indexOf("torrent::") >= 0) out.push("player_stop still awaits the removed torrent engine");
  return out;
});

run("sentinel: failed open closes the screen", () => {
  const open = rustFn(commands, "player_open");
  if (!open) return ["commands.rs: player_open() not found"];
  if (!open.includes('emit("player:closed"')) {
    return ["player_open leaves the player screen up when the spawn fails"];
  }
  return [];
});

run("sentinel: closed player frees the player slot", () => {
  const teardown = rustFn(player, "close");
  if (!teardown) return ["player.rs: close() not found"];
  if (!teardown.includes("ptr_eq")) {
    return ["close keeps a dead player in the state slot"];
  }
  if (!teardown.includes("player:closed")) {
    return ["close never emits player:closed, so the UI stays on a dead player"];
  }
  return [];
});

run("sentinel: end of stream keeps the player open", () => {
  const end = rustFn(player, "end_stream");
  if (!end) return ["player.rs: end_stream() not found"];
  const closeAt = end.indexOf("close(app");
  if (closeAt < 0) return ["end_stream never frees the slot"];
  // Reaching the end is not a reason to close: the epilogue and the viewer's
  // choice have to happen on screen. Any eof guard that returns before the
  // close satisfies this, whatever shape it takes.
  const guardAt = end.lastIndexOf('"eof"', closeAt);
  if (guardAt < 0) {
    return ["end_stream closes the player on end of file, killing the Up next card"];
  }
  const returns = end.indexOf("return", guardAt);
  if (returns < 0 || returns > closeAt) {
    return ["the eof guard does not return before closing the player"];
  }
  return [];
});

run("sentinel: a dropped stream is not a finished film", () => {
  const end = rustFn(player, "end_stream");
  if (!end) return ["player.rs: end_stream() not found"];
  // The Covenant reported eof at 2675s of 7383s and the screen said "Nothing
  // queued after this one." An eof that far short of the duration is a dropped
  // stream: it must be marked as one, not as the credits.
  const rule = rustFn(player, "ended_early");
  if (!rule || !/position\s*\/\s*(?:snap\.)?duration/.test(rule)) {
    return ["player.rs: no rule separates a dropped stream from a real end"];
  }
  if (!/ended_early\(/.test(end)) {
    return ["end_stream sets ended on any eof, so a dropped stream reads as the end"];
  }
  return [];
});

run("sentinel: a dropped stream is retried, not declared over", () => {
  const out: string[] = [];
  if (!/cutShort/.test(playerView)) {
    out.push("Player.tsx ignores cutShort, so a dropped stream shows the end card");
  }
  if (!/resumeDropped/.test(playerView)) {
    out.push("Player.tsx never reopens a dropped stream");
  }
  if (!/!nextEpisode\s*&&\s*!failed\s*&&\s*!dropped/.test(playerView)) {
    out.push("Player.tsx offers the end card over a dropped stream");
  }
  return out;
});

run("sentinel: skip markers only offer a button", () => {
  const out: string[] = [];
  const front = read("src/components/player/skip.ts");
  if (!/export type SkipKind =[^\n]*"recap"[^\n]*"intro"[^\n]*"outro"/.test(front)) {
    out.push("skip.ts does not offer recap, intro and outro segments");
  }
  if (/fired\.current\[segment\.kind\]/.test(playerView)) {
    out.push("Player.tsx still moves the playhead automatically");
  }
  if (!/pv-skip/.test(playerView)) {
    out.push("Player.tsx has no skip button");
  }
  return out;
});

run("outro lands on the post-credits scene when there is one", () => {
  const out: string[] = [];
  const duration = 3000;
  const at = (entry: Parameters<typeof findSkip>[0], position = duration - 100) =>
    findSkip(entry, position, duration);
  // A marked scene wins and the button names it.
  const scene = { outroStart: 2900, outroEnd: 2950, postCreditsStart: 2950 };
  const landed = at(scene);
  if (landed?.at !== 2950 || landed.label !== "Skip to post-credits") {
    out.push("skip.ts does not offer the post-credits scene");
  }
  // TV has no post-credits marker, so runtime left after the credits is the hint.
  const tv = at({ outroStart: 2900, outroEnd: 2950 });
  if (tv?.at !== 2950 || tv.label !== "Skip to post-credits") {
    out.push("skip.ts ignores the runtime left after the credits");
  }
  // Credits that run to the end leave nothing to offer but the end of the file.
  const plain = at({ outroStart: 2900, outroEnd: duration - 5 });
  if (plain?.at !== duration - 1 || plain.label !== "Skip outro") {
    out.push("skip.ts does not fall back to the end of the file");
  }
  if (at({ outroStart: 2900 })?.at !== duration - 1) {
    out.push("skip.ts skips past the end with no credits end");
  }
  if (at({ outroStart: 2900, postCreditsStart: 2000 })?.at !== duration - 1) {
    out.push("skip.ts lands on a post-credits marker before the credits");
  }
  // The offer ends where it lands, so the same click cannot replay the scene.
  if (at(scene, 2950) != null) {
    out.push("skip.ts keeps offering the outro after the seek");
  }
  // Credits after the scene are the only thing left to skip.
  const tail = { outroStart: 2900, postCreditsStart: 2950, postCreditsEnd: 2960 };
  const after = at(tail, 2965);
  if (after?.kind !== "credits" || after.at !== duration - 1) {
    out.push("skip.ts does not offer the credits after the scene");
  }
  return out;
});

run("sentinel: player snapshots carry a generation", () => {
  if (!/\bgeneration\b/.test(player)) {
    return ["player.rs: snapshots carry no generation, so stale ticks can win"];
  }
  return [];
});

run("sentinel: store ignores stale player events", () => {
  const out: string[] = [];
  if (!/playerGen/.test(store)) {
    return ["store.tsx: no generation guard on player events"];
  }
  if (!/playerGen\.current/.test(store)) {
    out.push("store.tsx: playerGen is never compared");
  }
  return out;
});

run("sentinel: playRequest reports a refused open", () => {
  const guard = /if\s*\(opening\.current\)\s*\{[\s\S]{0,900}?return false;/.exec(store);
  if (!guard) return ["playRequest returns true when another open is already running"];
  // A second click within a moment is a double click; anything later is a
  // stuck open, and staying silent about it is how "it never plays" happens.
  if (!/earlier open never settled/.test(guard[0])) {
    return ["a stale open guard refuses playback without a report"];
  }
  return [];
});

run("sentinel: cancelled start cannot clear the next start", () => {
  if (!/pending\.current === chain/.test(store)) {
    return ["a finished start clears the pending guard of a newer one"];
  }
  return [];
});

run("subtitle size can go below the old floor", async () => {
  const out: string[] = [];
  const hud = (await import(pathToFileURL(root + "src/components/player/hud.ts").href)) as unknown as {
    readSubtitleStyle: () => { size: number };
  };
  const saved = new Map<string, string>();
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: () => {} },
  };
  const sizeFor = (size: number) => {
    saved.set("duvy.subtitleStyle", JSON.stringify({ size }));
    return hud.readSubtitleStyle().size;
  };
  const cases: Array<[number, number]> = [
    [10, 10],
    [2, 10],
    [46, 46],
    [200, 90],
  ];
  for (const [stored, want] of cases) {
    const got = sizeFor(stored);
    if (got !== want) out.push(`a stored size of ${stored} reads as ${got}, want ${want}`);
  }
  // Sentinels: the stepper's own clamp, and the range Rust accepts.
  const floors = [
    ...(playerView + playerHud).matchAll(/whole\((?:stored\.size|subStyle\.size [+-] 2),\s*(\d+),\s*(\d+)/g),
  ].map((match) => Number(match[1]));
  if (floors.length < 3) {
    out.push("Player.tsx: subtitle size clamp not found in read and stepper");
  } else if (floors.some((floor) => floor > 10)) {
    out.push(`Player.tsx clamps subtitle size at ${Math.max(...floors)}, above the 10 the player accepts`);
  }
  if (!/10\.0\.\.=200\.0/.test(player)) {
    out.push("player.rs: subtitle size floor is not 10");
  }
  return out;
});

run("sentinel: continue watching compares exact episode keys", () => {
  const out: string[] = [];
  const home = read("src/views/Home.tsx");
  if (!/watchedKeys\.has\(row\.key\)/.test(home)) {
    out.push("Home.tsx hides a title by meta id instead of the watched episode key");
  }
  if (!/watchedKeys\.has\(entry\.key\)/.test(home)) {
    out.push("Home.tsx card progress is hidden by meta id instead of the episode key");
  }
  // The newest row claims the title before a finished row is dropped, or
  // finishing E2 puts E1 back on the shelf.
  const rankAt = home.indexOf("seen.has(row.metaId)");
  const skipAt = home.indexOf("watchedKeys.has(row.key)");
  if (rankAt < 0 || skipAt < 0 || rankAt > skipAt) {
    out.push("Home.tsx filters a finished row before the newest one claims the title");
  }
  return out;
});

run("sentinel: leaving at the credits counts the episode as watched", () => {
  const out: string[] = [];
  // The ticker's own final save used to land after kill's, putting the sub-92%
  // playhead back and dropping the mark the advance had just written.
  if (!/final_saved\.swap\(true/.test(rustFn(player, "spawn_ticker"))) {
    out.push("player.rs saves again after the final save, undoing a watched mark");
  }
  if (
    !/episodeCode\(video\) === episodeCode\(nextEpisode\)/.test(playerView) ||
    !/markWatched\(leaving\.key/.test(playerView)
  ) {
    out.push("Player.tsx advances to the next episode without finishing the one it leaves");
  }
  // The credits sit under the 92% the row is read with, so the mark has to count.
  if (!/watchedKeys\.has\(key\)/.test(playerView)) {
    out.push("Player.tsx episode list ignores an explicit watched mark");
  }
  return out;
});

run("sentinel: continue watching advances a finished episode", () => {
  const out: string[] = [];
  const home = read("src/views/Home.tsx");
  // A finished episode must resolve its next one, not vanish from the row, and
  // an episode already marked watched must be skipped.
  if (!/seriesCache/.test(home) || !/queue\.slice\(at \+ 1\)/.test(home)) {
    out.push("Home.tsx drops a finished episode instead of resolving the next one");
  }
  if (!/!watchedKeys\.has\(`\$\{row\.metaId\}:\$\{season\}:\$\{episode\}`\)/.test(home)) {
    out.push("Home.tsx offers an already watched episode as next up");
  }
  // `watched` collapses to one row per title, so a show marked E1 then E2
  // loses E1 and the card jumps back. The key set has to come from every mark.
  if (!/api\.watched\.keys\(\)/.test(store)) {
    out.push("store.tsx tracks watched keys from the per-title list, which hides earlier episodes");
  }
  if (!/next=\{next\}/.test(home)) {
    out.push("Home.tsx never marks a resolved next episode as next up");
  }
  const card = read("src/components/media.tsx");
  if (!/Next up/.test(card) || !/next \? null :/.test(card)) {
    out.push("ContinueCard still shows a remaining-time bar on a next-up card");
  }
  return out;
});

run("sentinel: auto-advance keeps the playing addon", () => {
  const pick = /export function pickSource\([\s\S]*?\n}/.exec(store)?.[0] ?? "";
  if (!pick) return ["store.tsx: pickSource() not found"];
  // Staying on the current addon must be decided before the quality fallback,
  // or the next episode can land on a different source mid-binge.
  const addonAt = pick.indexOf("playing.addon");
  const fallbackAt = pick.indexOf("if (wanted !== null)");
  if (addonAt < 0) return ["pickSource ignores the addon that is already playing"];
  if (fallbackAt < 0 || addonAt > fallbackAt) {
    return ["pickSource tries the preferred quality before the playing addon"];
  }
  return [];
});

run("sentinel: a source the viewer left does not come back", () => {
  const out: string[] = [];
  const pick = /export function pickSource\([\s\S]*?\n}/.exec(store)?.[0] ?? "";
  const playingAt = pick.indexOf("fromAddon");
  const memoryAt = pick.indexOf("if (remembered)");
  if (playingAt < 0 || memoryAt < 0 || playingAt > memoryAt) {
    out.push("pickSource prefers a remembered source over the addon playing now");
  }
  // The fan-out stops at the first answer, so the next episode asks the addon
  // that is playing on its own first instead of hunting over the top of it.
  if (!/addon: home/.test(playerView) || !/sources = await api\.streams\(request\)/.test(playerView)) {
    out.push("Player.tsx re-hunts the next episode from all addons, so the playing one can be missing");
  }
  if (!/liveMemory\(rememberedSource/.test(store)) {
    out.push("store.tsx resolves a remembered source from an addon that is gone");
  }
  return out;
});

run("sentinel: a pack that broke an episode is not reopened next", () => {
  const out: string[] = [];
  const pick = /export function pickSource\([\s\S]*?\n}/.exec(store)?.[0] ?? "";
  // The season's pack memory is consulted after the exact episode memory.
  const seasonAt = pick.indexOf("pack?.infoHash");
  const memoryAt = pick.indexOf("if (remembered)");
  if (seasonAt < 0) out.push("pickSource ignores the pack this season played from");
  else if (memoryAt >= 0 && seasonAt < memoryAt) {
    out.push("pickSource lets the season pack override the source this episode played");
  }
  if (!/export function rememberedPack\(/.test(store)) {
    out.push("store.tsx keeps no pack memory for a season");
  }
  if (!/all\[pack\] = stream/.test(store)) {
    out.push("rememberSource never records the pack a season played from");
  }
  for (const [name, src] of [
    ["store.tsx", store],
    ["Player.tsx", playerView],
  ] as const) {
    const calls = src.match(/pickSource\(\n[\s\S]*?\n\s*\);/g) ?? [];
    if (calls.some((call) => !/rememberedPack\(/.test(call))) {
      out.push(`${name} picks a source without the season pack memory`);
    }
  }
  return out;
});

run("sources sort biggest first, an unknown size sinks", async () => {
  const { byFileSize } = (await import(pathToFileURL(root + "src/lib/format.ts").href)) as unknown as {
    byFileSize: (a: { sizeBytes?: number | null }, b: { sizeBytes?: number | null }) => number;
  };
  const sorted = [
    { id: "small", sizeBytes: 10 },
    { id: "big", sizeBytes: 900 },
    { id: "unknown", sizeBytes: null },
    { id: "mid", sizeBytes: 500 },
    { id: "missing" },
  ]
    .sort(byFileSize)
    .map((source) => source.id);
  const want = "big,mid,small,unknown,missing";
  if (sorted.join() !== want) return [`byFileSize ordered [${sorted}], want [${want}]`];
  if (byFileSize({ sizeBytes: 10 }, { sizeBytes: 10 }) !== 0) {
    return ["byFileSize does not hold equal sizes in place"];
  }
  return [];
});

run("a runtime over an hour reads in hours", async () => {
  const { runtimeLabel } = (await import(pathToFileURL(root + "src/lib/format.ts").href)) as unknown as {
    runtimeLabel: (value?: string | null) => string | null;
  };
  const cases: [string | null, string | null][] = [
    ["101 min", "1h 41m"],
    ["120 min", "2h"],
    ["45 min", "45 min"],
    ["1h 30m", "1h 30m"],
    [null, null],
  ];
  const wrong = cases.filter(([input, want]) => runtimeLabel(input) !== want);
  return wrong.map(([input, want]) => `runtimeLabel(${input}) is not ${want}`);
});

run("sentinel: source list is ordered by file size", () => {
  const out: string[] = [];
  if (!/sort\(byFileSize\)/.test(drawer)) out.push("StreamDrawer.tsx does not sort sources by size");
  if (!/sort\(byFileSize\)/.test(playerView)) out.push("Player.tsx source panel does not sort by size");
  if (!/sourceSort: value/.test(settingsView)) out.push("Settings.tsx has no source order control");
  if (!/source_sort: "size"/.test(rustSettings)) out.push("settings.rs defaults source_sort away from size");
  return out;
});

run("sentinel: a disabled addon is not used", () => {
  const out: string[] = [];
  const addonsView = read("src/views/Addons.tsx");
  // The switch has to be there and it has to say what it does.
  if (!/api\.addons\.setEnabled/.test(addonsView)) {
    out.push("Addons.tsx has no control that switches an addon off");
  }
  if (!/addon-switch-state/.test(addonsView)) {
    out.push("Addons.tsx does not show whether the addon is on or off");
  }
  // Every fan-out asks only the addons that are switched on.
  for (const [name, body] of [
    ["home_feed", rustFn(commands, "home_feed")],
    ["search", rustFn(commands, "search")],
    ["streams", rustFn(commands, "streams")],
    ["subtitles", rustFn(commands, "subtitles")],
    ["addon_meta", rustFn(commands, "addon_meta")],
  ] as const) {
    if (!body) {
      out.push(`commands.rs: ${name}() not found`);
      continue;
    }
    if (!/filter\(\|a\| a\.enabled\)/.test(body)) {
      out.push(`commands.rs: ${name}() asks a switched-off addon`);
    }
  }
  return out;
});

run("fullscreen: a close after exit sends one request", async () => {
  const { createFullscreenController } = (await import(
    pathToFileURL(root + "src/lib/fullscreen.ts").href
  )) as unknown as typeof import("../src/lib/fullscreen.ts");
  const calls: boolean[] = [];
  const controller = createFullscreenController(
    async (on) => {
      calls.push(on);
    },
    () => undefined,
  );
  controller.sync(true);
  const exit = controller.request(false);
  // The close button lands before the exit has answered; it must not toggle.
  const close = controller.request(false);
  const settled = await Promise.all([exit, close]);
  const out: string[] = [];
  if (calls.join() !== "false") out.push(`window_fullscreen sent [${calls.join()}], want [false]`);
  if (settled.some((ok) => !ok)) out.push("a request that was already underway reported failure");
  if (controller.current) out.push("the controller still reports fullscreen after the exit");
  return out;
});

run("fullscreen: requests are serialized and failures keep state", async () => {
  const { createFullscreenController } = (await import(
    pathToFileURL(root + "src/lib/fullscreen.ts").href
  )) as unknown as typeof import("../src/lib/fullscreen.ts");
  const calls: boolean[] = [];
  let started!: () => void;
  const start = new Promise<void>((resolve) => {
    started = resolve;
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const controller = createFullscreenController(
    async (on) => {
      calls.push(on);
      if (on) {
        started();
        await gate;
        throw new Error("The window could not go fullscreen");
      }
    },
    () => undefined,
  );
  const enter = controller.request(true);
  await start;
  const exit = controller.request(false);
  release();
  const [entered, exited] = await Promise.all([enter, exit]);
  const out: string[] = [];
  if (entered !== false) out.push("a refused enter reported success");
  if (exited !== true) out.push("a no-op exit reported failure");
  if (calls.join() !== "true") out.push(`calls [${calls.join()}], want [true] only`);
  if (controller.current) out.push("a refused enter changed the known state");
  return out;
});

run("sentinel: one owner drives fullscreen", () => {
  const out: string[] = [];
  const titleBar = read("src/components/TitleBar.tsx");
  if (/api\.window\.fullscreen/.test(playerView)) {
    out.push("Player.tsx still calls api.window.fullscreen directly");
  }
  if (/api\.window\.fullscreen/.test(titleBar)) {
    out.push("TitleBar.tsx still calls api.window.fullscreen directly");
  }
  if (!/requestFullscreen/.test(playerView) || !/requestFullscreen/.test(titleBar)) {
    out.push("a fullscreen control bypasses the shared controller");
  }
  const lib = read("src-tauri/src/lib.rs");
  if (!/Already windowed/.test(rustFn(lib, "set_fullscreen"))) {
    out.push("set_fullscreen does not treat a second exit as success");
  }
  return out;
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
