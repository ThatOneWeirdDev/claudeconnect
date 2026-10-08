#!/usr/bin/env node
// ClaudeConnect launcher.
//
// This is the only file you download by hand. It fetches the current release from GitHub, checks every file against the
// release manifest, and runs the setup that came with it. Nothing about ClaudeConnect itself is kept in this file, so it
// rarely changes, and a copy of it stays on your computer so the site's Update button can run it later.
//
//   node ClaudeConnect.mjs                 set up, or choose to update or reset an existing install
//   node ClaudeConnect.mjs --update        go straight to updating an existing install
//   node ClaudeConnect.mjs --ref v1.2.0    use a tag, branch or commit instead of main
//   node ClaudeConnect.mjs --repo you/fork use a fork
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import os from "node:os";
import crypto from "node:crypto";

const DIR = join(os.homedir(), ".claudeconnect");
const CONFIG = join(DIR, "config.json");
const STAGE = join(DIR, "stage");
const argv = process.argv.slice(2);
const opt = n => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const REMOTE = argv.includes("--remote-update");
const UPDATE_ID = opt("--update-id");
const EXPECT = opt("--expect");
const readJson = p => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
};
const prior = readJson(CONFIG) || {};
const REPO = opt("--repo") || process.env.CLAUDECONNECT_REPO || prior.repo || "ThatOneWeirdDev/claudeconnect";
const REF = opt("--ref") || process.env.CLAUDECONNECT_REF || prior.ref || "main";
const RAW = (process.env.CLAUDECONNECT_RAW || "https://raw.githubusercontent.com").replace(/\/+$/, "");
// GitHub's API says which commit REF is right now, so every file comes from that one commit. Without it (offline from the
// API, or a test pointing RAW elsewhere), every request skips GitHub's raw-file cache instead.
const GH_API = (process.env.CLAUDECONNECT_GH_API || (process.env.CLAUDECONNECT_RAW ? "" : "https://api.github.com")).replace(/\/+$/, "");
let AT = REF;
let pinned = false;
const color = (code, s) => (process.stdout.isTTY ? `\x1b[${code}m${s}\x1b[0m` : s);
const bold = s => color("1", s);
const teal = s => color("36", s);
const dim = s => color("2", s);
const RETRY_MS = Number(process.env.CLAUDECONNECT_RETRY_MS) || 3000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha256 = buf => crypto.createHash("sha256").update(buf).digest("hex");

let step = "download";

// When the site started this, it is watching. The site keeps what we say here, so it survives the restarts that follow.
async function report(which, status, message) {
  if (!REMOTE || !UPDATE_ID) return;
  const c = readJson(CONFIG);
  if (!c || !c.site) return;
  try {
    await fetch(c.site.replace(/\/$/, "") + "/agent/progress", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-token": c.token || "", "x-chatgql-key": c.secret || "", "x-agent-id": c.id || "" },
      body: JSON.stringify({ id: UPDATE_ID, step: which, status, message }),
      signal: AbortSignal.timeout(8000)
    });
  } catch {}
}

async function stop(message) {
  console.error("\n" + bold("Setup stopped: ") + message);
  await report(step, "error", message);
  rmSync(STAGE, { recursive: true, force: true });
  process.exit(1);
}

// raw.githubusercontent.com keeps each file of a branch for up to five minutes, separately, so right after a release it can
// hand out the old manifest with the new files. A commit's files never change, so a pinned download is consistent; an
// unpinned one gets past that cache on every request.
async function pinRef() {
  if (/^[0-9a-f]{40}$/i.test(REF)) {
    pinned = true;
    return;
  }
  if (!GH_API) return;
  try {
    const r = await fetch(`${GH_API}/repos/${REPO}/commits/${encodeURIComponent(REF)}`, { headers: { accept: "application/vnd.github.sha", "user-agent": "ClaudeConnect-setup" }, signal: AbortSignal.timeout(8000) });
    const sha = r.ok ? (await r.text()).trim() : "";
    if (/^[0-9a-f]{40}$/i.test(sha)) {
      AT = sha;
      pinned = true;
    }
  } catch {}
}

async function get(path) {
  const url = `${RAW}/${REPO}/${AT}/${path}${pinned ? "" : `?cb=${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`}`;
  let r;
  try {
    r = await fetch(url, { headers: { "user-agent": "ClaudeConnect-setup" }, signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new Error(`couldn't reach ${new URL(url).host} (${String((e && e.cause && e.cause.code) || e.message || e)})`);
  }
  if (r.status === 404) throw new Error(`${path} isn't at ${REPO}@${REF}`);
  if (!r.ok) throw new Error(`${new URL(url).host} answered ${r.status} for ${path}`);
  return Buffer.from(await r.arrayBuffer());
}

const SAFE_PATH = /^(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*$/;
const VERSION = /^(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-[0-9A-Za-z.-]{1,32})?$/;

function older(a, b) {
  const x = VERSION.exec(a);
  const y = VERSION.exec(b);
  if (!x || !y) return false;
  for (let i = 1; i <= 3; i++) if (Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]);
  return false;
}

function check(manifest) {
  if (!manifest || !VERSION.test(String(manifest.version)) || !manifest.files || typeof manifest.files !== "object") throw new Error("the release manifest is malformed");
  for (const [rel, hash] of Object.entries(manifest.files)) {
    const top = rel.split("/")[0];
    if (!SAFE_PATH.test(rel) || (rel.includes("/") && top !== "site" && top !== "agent")) throw new Error(`the release manifest lists a file it shouldn't (${rel})`);
    if (!/^[0-9a-f]{64}$/.test(String(hash))) throw new Error(`the release manifest has a bad checksum for ${rel}`);
  }
  for (const need of ["installer.mjs", "agent/agent.mjs", "site/worker.js", "site/app.html"]) if (!manifest.files[need]) throw new Error(`the release is missing ${need}`);
  return manifest;
}

// GitHub's CDN can hand back a file from a moment ago. Anything that doesn't match its checksum gets another try.
async function manifestWithRetry() {
  let last = null;
  for (let i = 0; i < 4; i++) {
    try {
      // the release asked for may have landed after this pinned an older commit
      if (i > 0 && pinned && AT !== REF) await pinRef();
      const raw = await get("manifest.json");
      let parsed = null;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        throw new Error(`the release manifest at ${REPO}@${REF} couldn't be read`);
      }
      const manifest = check(parsed);
      if (EXPECT && older(manifest.version, EXPECT)) throw new Error(`GitHub is still serving ${manifest.version}, not ${EXPECT} yet`);
      return { manifest, raw };
    } catch (e) {
      last = e;
      if (i < 3) await sleep(RETRY_MS);
    }
  }
  throw last;
}

async function main() {
  console.log(bold("\nClaudeConnect") + dim(`  ${REPO}@${REF}`));
  await report("download", "active");
  await pinRef();
  // A release merged in the middle of this can leave the manifest and a file from different commits (unpinned only): then
  // the manifest is read again and the download starts over, once.
  let manifest, raw, names;
  for (let round = 0; ; round++) {
    let rel;
    try {
      rel = await manifestWithRetry();
    } catch (e) {
      await stop(`${e.message}. Check your connection and run this again.`);
    }
    ({ manifest, raw } = rel);
    console.log(`${teal("▸ ")}${bold("Downloading " + manifest.version)}`);
    rmSync(STAGE, { recursive: true, force: true });
    mkdirSync(STAGE, { recursive: true });
    names = Object.keys(manifest.files);
    let why = "";
    for (const name of names) {
      let ok = false;
      for (let i = 0; i < 3 && !ok; i++) {
        try {
          const buf = await get(name);
          if (sha256(buf) === manifest.files[name]) {
            const dest = join(STAGE, name);
            mkdirSync(dirname(dest), { recursive: true });
            writeFileSync(dest, buf);
            ok = true;
          } else {
            why = `${name} didn't match its checksum`;
            await sleep(RETRY_MS);
          }
        } catch (e) {
          why = e.message;
          await sleep(RETRY_MS);
        }
      }
      if (!ok) break;
      why = "";
    }
    if (!why) break;
    if (pinned || round > 0) {
      step = "verify";
      await stop(`${why}. Nothing was changed. Try again in a minute.`);
    }
  }
  writeFileSync(join(STAGE, "manifest.json"), raw);
  // The installer imports its helpers as ES modules; this tells Node so, wherever the download folder happens to be.
  writeFileSync(join(STAGE, "package.json"), JSON.stringify({ name: "claudeconnect-setup", private: true, type: "module" }));
  await report("download", "done");
  await report("verify", "active");
  step = "site";
  console.log(dim(`  ${names.length} files downloaded and checked.`));

  const r = spawnSync(process.execPath, [join(STAGE, "installer.mjs"), ...argv], {
    stdio: "inherit",
    env: { ...process.env, CLAUDECONNECT_REPO: REPO, CLAUDECONNECT_REF: REF }
  });
  rmSync(STAGE, { recursive: true, force: true });
  if (r.error) await stop(`couldn't start the setup (${r.error.message})`);
  process.exit(r.status === null ? 1 : r.status);
}

if (Number(process.versions.node.split(".")[0]) < 22) {
  console.error(`ClaudeConnect needs Node.js 22 or newer, and you have ${process.version}. Install the current LTS from nodejs.org, then run this again.`);
  process.exit(1);
}
if (!existsSync(os.homedir())) {
  console.error("Couldn't find your home folder.");
  process.exit(1);
}
await main();
