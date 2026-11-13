// Updater and player lifecycle regression guards.
// Run with: bun scripts/regression.check.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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

/** Slice a top-level Rust function: from `fn name` to the next `}` in column 0. */
function rustFn(src: string, name: string): string {
  const at = src.search(new RegExp(`(?:pub\\s+)?(?:async\\s+)?fn\\s+${name}\\b`));
  if (at < 0) return "";
  const end = src.indexOf("\n}", at);
  return end < 0 ? src.slice(at) : src.slice(at, end + 2);
}

const checks: Array<{ name: string; fn: () => string[] }> = [];
const run = (name: string, fn: () => string[]) => checks.push({ name, fn });

run("update check runs at launch", () => {
  const out: string[] = [];
  const watch = rustFn(updates, "watch");
  if (!watch) return ["updates.rs: watch() not found"];
  // Only a numeric sleep before the loop can delay the first check.
  const first = [...watch.matchAll(/from_secs\((\d+)\)/g)].map((m) => Number(m[1]))[0];
  if (first != null && first > 5) {
    out.push(`watch() waits ${first}s before the first update check`);
  }
  return out;
});

run("update check cannot hang", () => {
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

run("failed update check retries soon", () => {
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

run("install reuses the checked release", () => {
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

run("download progress is throttled", () => {
  const download = rustFn(updates, "download");
  if (!download) return ["updates.rs: download() not found"];
  if (!/elapsed\(\)/.test(download)) {
    return ["update:progress is emitted for every network chunk"];
  }
  return [];
});

run("stop emits player:closed and awaits no torrent teardown", () => {
  const out: string[] = [];
  const stop = rustFn(commands, "player_stop");
  if (!stop) return ["commands.rs: player_stop() not found"];
  if (stop.indexOf('emit("player:closed"') < 0) out.push("player_stop does not emit player:closed");
  if (stop.indexOf("torrent::") >= 0) out.push("player_stop still awaits the removed torrent engine");
  return out;
});

run("failed open closes the screen", () => {
  const open = rustFn(commands, "player_open");
  if (!open) return ["commands.rs: player_open() not found"];
  if (!open.includes('emit("player:closed"')) {
    return ["player_open leaves the player screen up when the spawn fails"];
  }
  return [];
});

run("closed player frees the player slot", () => {
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

run("end of stream keeps the player open", () => {
  const end = rustFn(player, "end_stream");
  if (!end) return ["player.rs: end_stream() not found"];
  const closeAt = end.indexOf("close(app");
  if (closeAt < 0) return ["end_stream never frees the slot"];
  // Reaching the end is not a reason to close: the epilogue and the viewer's
  // choice have to happen on screen.
  const guardAt = end.indexOf('reason != "eof"');
  if (guardAt < 0 || guardAt > closeAt) {
    return ["end_stream closes the player on end of file, killing the Up next card"];
  }
  return [];
});

run("a dropped stream is not a finished film", () => {
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

run("a dropped stream is retried, not declared over", () => {
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

run("skip markers only offer a button", () => {
  const out: string[] = [];
  const front = read("src/components/player/skip.ts");
  if (!/kind:\s*"intro"\s*\|\s*"outro"/.test(front)) {
    out.push("skip.ts does not offer both intro and outro segments");
  }
  if (/fired\.current\[segment\.kind\]/.test(playerView)) {
    out.push("Player.tsx still moves the playhead automatically");
  }
  if (!/pv-skip/.test(playerView)) {
    out.push("Player.tsx has no skip button");
  }
  return out;
});

run("player snapshots carry a generation", () => {
  if (!/\bgeneration\b/.test(player)) {
    return ["player.rs: snapshots carry no generation, so stale ticks can win"];
  }
  return [];
});

run("store ignores stale player events", () => {
  const out: string[] = [];
  if (!/playerGen/.test(store)) {
    return ["store.tsx: no generation guard on player events"];
  }
  if (!/playerGen\.current/.test(store)) {
    out.push("store.tsx: playerGen is never compared");
  }
  return out;
});

run("playRequest reports a refused open", () => {
  const guard = /if\s*\(opening\.current\)\s*\{[\s\S]{0,900}?return false;/.exec(store);
  if (!guard) return ["playRequest returns true when another open is already running"];
  // A second click within a moment is a double click; anything later is a
  // stuck open, and staying silent about it is how "it never plays" happens.
  if (!/earlier open never settled/.test(guard[0])) {
    return ["a stale open guard refuses playback without a report"];
  }
  return [];
});

run("cancelled start cannot clear the next start", () => {
  if (!/pending\.current === chain/.test(store)) {
    return ["a finished start clears the pending guard of a newer one"];
  }
  return [];
});

run("subtitle size can go below the old floor", () => {
  const out: string[] = [];
  const floors = [
    ...(playerView + playerHud).matchAll(/whole\((?:stored\.size|subStyle\.size [+-] 2),\s*(\d+),\s*(\d+)/g),
  ].map((match) => Number(match[1]));
  if (floors.length < 3) {
    return ["Player.tsx: subtitle size clamp not found in read and stepper"];
  }
  if (floors.some((floor) => floor > 10)) {
    out.push(`Player.tsx clamps subtitle size at ${Math.max(...floors)}, above the 10 the player accepts`);
  }
  if (!/10\.0\.\.=200\.0/.test(player)) {
    out.push("player.rs: subtitle size floor is not 10");
  }
  return out;
});

run("continue watching compares exact episode keys", () => {
  const out: string[] = [];
  const home = read("src/views/Home.tsx");
  if (!/marked\.has\(row\.key\)/.test(home)) {
    out.push("Home.tsx hides a title by meta id instead of the watched episode key");
  }
  if (!/marked\.has\(entry\.key\)/.test(home)) {
    out.push("Home.tsx card progress is hidden by meta id instead of the episode key");
  }
  // The newest row claims the title before a finished row is dropped, or
  // finishing E2 puts E1 back on the shelf.
  const rankAt = home.indexOf("seen.has(row.metaId)");
  const skipAt = home.indexOf("marked.has(row.key)");
  if (rankAt < 0 || skipAt < 0 || rankAt > skipAt) {
    out.push("Home.tsx filters a finished row before the newest one claims the title");
  }
  return out;
});

run("continue watching advances a finished episode", () => {
  const out: string[] = [];
  const home = read("src/views/Home.tsx");
  // A finished episode must resolve its next one, not vanish from the row.
  if (!/nextUpCache/.test(home) || !/queue\[at \+ 1\]/.test(home)) {
    out.push("Home.tsx drops a finished episode instead of resolving the next one");
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

run("auto-advance keeps the playing addon", () => {
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

run("a source the viewer left does not come back", () => {
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

run("source list is ordered by file size", () => {
  const out: string[] = [];
  if (!/sort\(byFileSize\)/.test(drawer)) out.push("StreamDrawer.tsx does not sort sources by size");
  if (!/sort\(byFileSize\)/.test(playerView)) out.push("Player.tsx source panel does not sort by size");
  if (!/sourceSort: value/.test(settingsView)) out.push("Settings.tsx has no source order control");
  if (!/source_sort: "size"/.test(rustSettings)) out.push("settings.rs defaults source_sort away from size");
  return out;
});

run("a disabled addon is not used", () => {
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

let failed = 0;
for (const { name, fn } of checks) {
  let detail: string[];
  try {
    detail = fn();
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
