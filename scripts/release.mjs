#!/usr/bin/env node
// Keeps manifest.json honest. The loader and the site trust the version and hashes in it, so they must match the files.
//
//   node scripts/release.mjs                refresh the hashes
//   node scripts/release.mjs 1.3.0          set the version too (manifest.json and package.json), then refresh the hashes
//   node scripts/release.mjs --check        change nothing, exit 1 if anything is out of date
//   node scripts/release.mjs --check --against origin/main
//                                           also require a version bump when any shipped file differs from that ref
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { parseVersion, compareVersions } from "../site/version.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// Everything that ships to a user's computer or Cloudflare account. brand.js is not here: setup writes it per install.
export const FILES = ["ClaudeConnect.mjs", "installer.mjs", "agent/agent.mjs", "agent/sessions.mjs", "site/worker.js", "site/app.html", "site/version.js", "site/names.js", "site/image.js"];

const sha = path => createHash("sha256").update(readFileSync(join(ROOT, path))).digest("hex");
const readJson = path => JSON.parse(readFileSync(join(ROOT, path), "utf8"));

export function hashes() {
  return Object.fromEntries(FILES.map(f => [f, sha(f)]));
}

export function problems(manifest, pkg) {
  const out = [];
  if (!parseVersion(manifest.version)) out.push(`manifest.json version "${manifest.version}" isn't x.y.z`);
  if (pkg.version !== manifest.version) out.push(`package.json says ${pkg.version} but manifest.json says ${manifest.version}`);
  const want = hashes();
  for (const f of FILES) {
    if (!manifest.files || manifest.files[f] !== want[f]) out.push(`${f} changed since manifest.json was written`);
  }
  for (const f of Object.keys(manifest.files || {})) if (!FILES.includes(f)) out.push(`manifest.json lists ${f}, which release.mjs doesn't know about`);
  // The deployed worker can only import files that ship with it.
  const worker = readFileSync(join(ROOT, "site/worker.js"), "utf8");
  for (const m of worker.matchAll(/from "\.\/([^"]+)"/g)) {
    if (m[1] === "brand.js") continue;
    if (!existsSync(join(ROOT, "site", m[1]))) out.push(`site/worker.js imports ${m[1]}, which doesn't exist`);
    else if (!FILES.includes("site/" + m[1])) out.push(`site/worker.js imports ${m[1]}, which isn't in the release file list`);
  }
  if (!Array.isArray(manifest.notes) || !manifest.notes.length) out.push("manifest.json needs at least one line in notes");
  return out;
}

function main() {
  const args = process.argv.slice(2);
  const check = args.includes("--check");
  const against = args.includes("--against") ? args[args.indexOf("--against") + 1] : null;
  const version = args.find(a => /^\d+\.\d+\.\d+/.test(a));
  const manifest = readJson("manifest.json");
  const pkg = readJson("package.json");

  if (version) {
    if (!parseVersion(version)) throw new Error(`"${version}" isn't a version like 1.3.0`);
    manifest.version = version;
    pkg.version = version;
    manifest.released = new Date().toISOString().slice(0, 10);
  }
  if (!check) {
    manifest.files = hashes();
    writeFileSync(join(ROOT, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    writeFileSync(join(ROOT, "package.json"), JSON.stringify(pkg, null, 2) + "\n");
    console.log(`manifest.json is now ${manifest.version} with ${FILES.length} files.`);
    if (version) console.log("Edit the notes in manifest.json to say what changed, then run this again.");
  }

  const bad = problems(readJson("manifest.json"), readJson("package.json"));
  if (against) {
    let base = null;
    try {
      base = JSON.parse(execFileSync("git", ["show", `${against}:manifest.json`], { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }));
    } catch {
      console.log(`No manifest.json on ${against}, so there's no version to compare with.`);
    }
    if (base) {
      const now = readJson("manifest.json");
      const changed = FILES.filter(f => base.files && base.files[f] !== now.files[f]);
      if (changed.length && compareVersions(now.version, base.version) <= 0) {
        bad.push(`${changed.join(", ")} differ from ${against} but the version is still ${now.version}. Run: node scripts/release.mjs <new version>`);
      }
    }
  }
  if (bad.length) {
    console.error(bad.map(b => "✗ " + b).join("\n"));
    process.exit(1);
  }
  if (check) console.log(`manifest.json is up to date (${readJson("manifest.json").version}).`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main();
