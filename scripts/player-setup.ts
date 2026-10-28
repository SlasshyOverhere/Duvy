// Puts a real mpv in the bundled resource dir before `tauri dev` runs.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Published by .github/workflows/player.yml; the app installs from here too.
const RELEASE = "https://github.com/SlasshyOverhere/BetterNuvio/releases/download/player-1";
// The build that release is cut from, used until the release exists.
const UPSTREAM = {
  url: "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-x86_64-20261021-git-e471496c56.7z",
  sha: "4a355f3e89c83fabc730d33fb4e759dfec747806ed2287b61a90d1681b83e8d3",
};
const FILES = ["mpv.exe", "d3dcompiler_43.dll"];

const DIR = join(fileURLToPath(new URL("..", import.meta.url)), "src-tauri", "resources", "mpv");
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const hashOf = (path: string) => (existsSync(path) ? sha(readFileSync(path)) : null);
const present = () =>
  FILES.every((name) => {
    const path = join(DIR, name);
    return existsSync(path) && statSync(path).size > 0;
  });

async function fromRelease(): Promise<boolean> {
  const response = await fetch(`${RELEASE}/sha256.txt`);
  if (!response.ok) return false;
  const manifest = (await response.text())
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter((parts) => parts.length === 2 && parts[0].length === 64)
    .map(([hash, name]) => ({ hash, name: name.replace(/^\*/, "") }));
  if (!manifest.length) return false;

  for (const { hash, name } of manifest) {
    const target = join(DIR, name);
    if (hashOf(target) === hash) continue;
    console.log(`player-setup: fetching ${name}`);
    const asset = await fetch(`${RELEASE}/${name}`);
    if (!asset.ok) throw new Error(`${name} answered HTTP ${asset.status}`);
    const body = new Uint8Array(await asset.arrayBuffer());
    if (sha(body) !== hash) throw new Error(`${name} did not match its published checksum`);
    writeFileSync(`${target}.part`, body);
    renameSync(`${target}.part`, target);
  }
  return true;
}

async function fromUpstream() {
  console.log("player-setup: fetching the pinned mpv build (34 MB, once)");
  const response = await fetch(UPSTREAM.url);
  if (!response.ok) throw new Error(`the mpv archive answered HTTP ${response.status}`);
  const body = new Uint8Array(await response.arrayBuffer());
  if (sha(body) !== UPSTREAM.sha) throw new Error("the mpv archive did not match its checksum");

  const archive = join(DIR, "mpv.7z");
  writeFileSync(archive, body);
  const tar = spawnSync("tar", ["-xf", archive, "-C", DIR, ...FILES], { stdio: "inherit" });
  rmSync(archive, { force: true });
  if (tar.status !== 0) throw new Error("the mpv archive could not be unpacked");
}

mkdirSync(DIR, { recursive: true });
if (!present()) {
  try {
    if (!(await fromRelease())) await fromUpstream();
  } catch (error) {
    console.error(`player-setup: ${(error as Error).message}`);
    process.exit(1);
  }
}
if (!present()) {
  console.error("player-setup: mpv is still missing from src-tauri/resources/mpv.");
  process.exit(1);
}
