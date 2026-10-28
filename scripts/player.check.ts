// Player HUD regression checks. Run with: bun scripts/player.check.ts
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (rel: string) => readFileSync(root + rel, "utf8");
const lineAt = (text: string, index: number) => text.slice(0, index).split("\n").length;

type Rule = { selector: string; parts: string[]; decls: Record<string, string>; media: string };

function parseCss(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: Rule[] = [];
  const stack: string[] = [];
  let i = 0;
  let start = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "{") {
      const prelude = src.slice(start, i).trim().replace(/\s+/g, " ");
      if (prelude.startsWith("@")) {
        stack.push(prelude);
        i += 1;
        start = i;
        continue;
      }
      const end = src.indexOf("}", i);
      if (end < 0) break;
      const decls: Record<string, string> = {};
      for (const chunk of src.slice(i + 1, end).split(";")) {
        const at = chunk.indexOf(":");
        if (at < 0) continue;
        decls[chunk.slice(0, at).trim().toLowerCase()] = chunk.slice(at + 1).trim().replace(/\s+/g, " ");
      }
      rules.push({
        selector: prelude,
        parts: prelude.split(",").map((p) => p.trim().replace(/\s+/g, " ")).filter(Boolean),
        decls,
        media: stack.join(" "),
      });
      i = end + 1;
      start = i;
      continue;
    }
    if (ch === "}") {
      stack.pop();
      i += 1;
      start = i;
      continue;
    }
    i += 1;
  }
  return rules;
}

// Walk a JSX opening tag starting at `<Name`, respecting quotes and brace depth.
function openingTag(src: string, from: number): { tag: string; end: number } | null {
  let depth = 0;
  let quote = "";
  for (let i = from; i < src.length; i += 1) {
    const ch = src[i];
    if (quote) {
      if (ch === quote) quote = "";
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{") depth += 1;
    else if (ch === "}") depth -= 1;
    else if (ch === ">" && depth === 0) return { tag: src.slice(from, i + 1), end: i + 1 };
  }
  return null;
}

const playerCssRaw = read("src/components/player/player.css");
const playerCss = parseCss(playerCssRaw);
const pageCss = parseCss(read("src/styles.css"));
const playerTsx = read("src/views/Player.tsx");
const uiTsx = read("src/components/ui.tsx");

const seekSelectors = [".pv-trackrail", ".pv-buffer", ".pv-played"];
const isSeekLayer = (rule: Rule) => seekSelectors.some((s) => rule.parts.some((p) => p.includes(s)));

const checks: Array<{ name: string; fn: () => string[] | Promise<string[]> }> = [];
const run = (name: string, fn: () => string[] | Promise<string[]>) => checks.push({ name, fn });

run("seek-bar layers share one rail", () => {
  const out: string[] = [];
  const shared = playerCss.find(
    (r) =>
      seekSelectors.every((s) => r.parts.some((p) => p.includes(s))) && r.decls["top"] === "50%",
  );
  if (!shared) out.push("player.css: no shared .pv-trackrail/.pv-buffer/.pv-played rule with top: 50%");
  if (!playerCss.some(isSeekLayer)) out.push("player.css: no seek-bar layer rules parsed");

  for (const rule of playerCss.filter(isSeekLayer)) {
    const where = `${rule.selector}${rule.media ? ` ${rule.media}` : ""}`;
    if (/translateY/.test(rule.decls["transform"] ?? "")) {
      out.push(`${where}: transform: ${rule.decls["transform"]} lifts the bar off the rail`);
    }
    if (rule.decls["top"] && rule.decls["top"] !== "50%") {
      out.push(`${where}: top: ${rule.decls["top"]} disagrees with the shared top: 50%`);
    }
    const marginTop = rule.decls["margin-top"];
    if (marginTop) {
      const height = rule.decls["height"] ? parseFloat(rule.decls["height"]) : 6;
      const want = -height / 2;
      if (!Number.isFinite(parseFloat(marginTop)) || Math.abs(parseFloat(marginTop) - want) > 0.01) {
        out.push(`${where}: margin-top: ${marginTop} does not centre a ${height}px bar (want ${want}px)`);
      }
    }
  }
  for (const rule of pageCss) {
    const hit = rule.parts.find((p) => p.includes(".pv-played") || p.includes(".pv-buffer"));
    if (hit) out.push(`styles.css: ${hit} still styled here, the timeline lives in player.css`);
  }
  return out;
});

run("centre transport is centred", () => {
  const out: string[] = [];
  const rules = playerCss.filter((r) => r.parts.includes(".pv .pv-center"));
  if (!rules.length) return ["player.css: no .pv .pv-center rule"];
  for (const rule of rules) {
    const where = `.pv .pv-center${rule.media ? ` ${rule.media}` : ""}`;
    const inset = rule.decls["inset"];
    if (inset) {
      const v = inset.split(" ");
      const bottom = v.length >= 3 ? v[2] : v[0];
      if (bottom !== "0") out.push(`${where}: inset: ${inset} leaves a ${bottom} bottom offset`);
      continue;
    }
    const bottom = rule.decls["bottom"];
    if (bottom && bottom !== "0") out.push(`${where}: bottom: ${bottom}`);
  }
  return out;
});

run("panels fit the viewport", () => {
  const out: string[] = [];
  const body = playerCss.filter((r) => r.parts.includes(".pv .pv-overlay-body"));
  const bounded = body.some((r) => /(100vh|100dvh|100%)/.test(r.decls["max-height"] ?? ""));
  // Either the body scrolls, or its content wrapper does while Close stays put.
  const scrolls = [...body, ...playerCss.filter((r) => r.parts.includes(".pv .pv-overlay-scroll"))].some(
    (r) => ["overflow", "overflow-y"].some((k) => /(auto|scroll|hidden)/.test(r.decls[k] ?? "")),
  );
  if (!bounded || !scrolls) {
    out.push(".pv .pv-overlay-body: needs a bounded max-height and a scrolling body or .pv-overlay-scroll");
  }

  for (const selector of [".pv .pv-rails", ".pv .pv-rail"]) {
    const rules = playerCss.filter((r) => r.parts.includes(selector));
    if (!rules.some((r) => r.decls["min-height"] === "0")) {
      out.push(`${selector}: missing min-height: 0`);
    }
  }

  for (const rule of playerCss.filter((r) => r.parts.some((p) => p.includes(".pv-rail")))) {
    const cap = rule.decls["max-height"];
    if (cap && /(vh|vw|px)/.test(cap)) {
      out.push(`${rule.selector}: max-height: ${cap} can exceed the panel-to-window space`);
    }
  }

  const overlays = playerCss.filter((r) => r.parts.includes(".pv .pv-overlay"));
  if (!overlays.length) out.push(".pv .pv-overlay: rule missing");
  for (const rule of overlays) {
    const padding = rule.decls["padding"];
    if (!padding) continue;
    const v = padding.split(" ");
    const bottom = v.length >= 3 ? v[2] : v.length === 2 ? v[1] : v[0];
    const px = parseFloat(bottom);
    const where = `.pv .pv-overlay${rule.media ? ` ${rule.media}` : ""}`;
    if (!/px$/.test(bottom) || !Number.isFinite(px) || px < 24) {
      out.push(`${where}: bottom padding ${bottom} is under 24px`);
    }
  }
  return out;
});

run("pause is deterministic", () => {
  const out: string[] = [];
  if (/toggl[ea]-pause/.test(playerTsx)) out.push('Player.tsx still sends "toggle-pause"');

  let helper = "";
  for (const m of playerTsx.matchAll(/send\(\s*["']pause["']/g)) {
    const before = playerTsx.slice(Math.max(0, (m.index ?? 0) - 600), m.index);
    const decls = [...before.matchAll(/(?:const|let|function)\s+(\w+)/g)];
    if (decls.length) {
      helper = decls[decls.length - 1][1];
      break;
    }
  }
  if (!helper) return [...out, 'no pause helper: expected a helper that sends "pause" with a boolean'];
  if (!/send\(\s*["']pause["']\s*,\s*[^)\s]/.test(playerTsx)) {
    out.push(`helper ${helper} sends "pause" without a boolean value`);
  }

  const calls = (text: string) => new RegExp(`\\b${helper}(?:\\s*\\(|\\s*\\})`).test(text);
  const keyboard = playerTsx.indexOf('case "K":');
  if (keyboard < 0) out.push('keyboard: no case "K": branch');
  else {
    // The branch may contain early breaks, so end it at the next case label.
    const end = playerTsx.indexOf('case "ArrowLeft":', keyboard);
    const branch = playerTsx.slice(keyboard, end < 0 ? keyboard + 600 : end);
    if (!calls(branch)) out.push(`keyboard Space/K branch does not call ${helper}()`);
    else if (/\bsend\s*\(/.test(branch)) out.push("keyboard Space/K branch calls the sender directly");
  }

  const surface = playerTsx.indexOf("target.closest(\"button, input, [role='slider'], a\")");
  if (surface < 0) out.push("surface click handler not found");
  else {
    const handler = playerTsx.slice(Math.max(0, surface - 400), surface + 600);
    if (!calls(handler)) out.push(`surface click handler does not call ${helper}()`);
    else if (/\bsend\s*\(/.test(handler)) out.push("surface click handler calls the sender directly");
  }

  const centre = playerTsx.indexOf('aria-label={local.paused ? "Play" : "Pause"}');
  if (centre < 0) out.push("centre play/pause button not found");
  else {
    const open = playerTsx.lastIndexOf("<button", centre);
    const tag = open < 0 ? null : openingTag(playerTsx, open);
    if (!tag) out.push("centre pause button tag not parsed");
    else if (!calls(tag.tag)) out.push(`centre pause button does not call ${helper}()`);
    else if (/\bsend\s*\(/.test(tag.tag)) out.push("centre pause button calls the sender directly");
  }
  return out;
});

run("icon names exist", () => {
  const union = uiTsx.match(/export type IconName =([\s\S]*?);/);
  if (!union) return ["ui.tsx: IconName union not found"];
  const names = new Set([...union[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]));
  const out: string[] = [];
  const tags = [...playerTsx.matchAll(/<Icon\b/g)];
  if (!tags.length) out.push("Player.tsx: no <Icon> usages found");
  for (const m of tags) {
    const tag = openingTag(playerTsx, m.index ?? 0);
    if (!tag) continue;
    const at = tag.tag.search(/\bname\s*=/);
    if (at < 0) continue;
    const value = tag.tag.slice(at + 5).trimStart();
    let literals: string[] = [];
    if (value.startsWith('"')) {
      literals = [value.slice(1, value.indexOf('"', 1))];
    } else if (value.startsWith("{")) {
      let depth = 0;
      let end = 0;
      for (let i = 0; i < value.length; i += 1) {
        if (value[i] === "{") depth += 1;
        else if (value[i] === "}") {
          depth -= 1;
          if (depth === 0) {
            end = i;
            break;
          }
        }
      }
      const expr = value.slice(1, end);
      literals = [...expr.matchAll(/["']([^"']+)["']/g)].map((x) => x[1]);
    }
    for (const name of literals) {
      if (!names.has(name)) {
        out.push(`Player.tsx:${lineAt(playerTsx, m.index ?? 0)} Icon name "${name}" is not in IconName`);
      }
    }
  }
  return out;
});

run("buttons declare type", () => {
  const out: string[] = [];
  const tags = [...playerTsx.matchAll(/<button\b/g)];
  if (!tags.length) return ["Player.tsx: no <button> tags found"];
  for (const m of tags) {
    const tag = openingTag(playerTsx, m.index ?? 0);
    if (!tag) continue;
    if (!/\btype\s*=\s*["']button["']/.test(tag.tag)) {
      out.push(`Player.tsx:${lineAt(playerTsx, m.index ?? 0)} <button> without type="button"`);
    }
  }
  return out;
});

run("no glass over video", () => {
  const css = playerCssRaw.replace(/\/\*[\s\S]*?\*\//g, "");
  return /backdrop-filter/.test(css)
    ? ["player.css: backdrop-filter cannot sample a native mpv surface"]
    : [];
});

run("buffer maths", async () => {
  const out: string[] = [];
  const mod = (await import(pathToFileURL(root + "src/lib/format.ts").href)) as Record<string, unknown>;
  const bufferPercent = mod.bufferPercent;
  if (typeof bufferPercent !== "function") {
    return ['src/lib/format.ts does not export bufferPercent(position, buffered, duration)'];
  }
  const fn = bufferPercent as (p: number, b: number, d: number) => number;
  const cases: Array<[string, number, number]> = [
    ["(100, 50, 200)", fn(100, 50, 200), 75],
    ["overshoot (100, 500, 200)", fn(100, 500, 200), 100],
    ["duration 0", fn(100, 50, 0), 0],
    ["NaN position", fn(Number.NaN, 50, 200), 0],
    ["Infinity duration", fn(100, 50, Number.POSITIVE_INFINITY), 0],
  ];
  for (const [label, got, want] of cases) {
    if (!Number.isFinite(got) || Math.abs(got - want) > 1e-9) {
      out.push(`bufferPercent ${label} = ${got}, want ${want}`);
    }
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
