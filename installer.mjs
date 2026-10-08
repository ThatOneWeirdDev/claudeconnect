#!/usr/bin/env node
// ClaudeConnect setup. ClaudeConnect.mjs downloads a release from GitHub, checks it, and runs this from the download folder.
// Run it with --remote-update (no questions) to update an existing install in place, which is what the site's Update button does.
import { spawnSync, spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync, accessSync, chmodSync, rmSync, statSync, readdirSync, openSync, readSync, closeSync, renameSync, cpSync, constants } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import crypto from "node:crypto";
import { createInterface } from "node:readline/promises";
import { SLUG_RE, NAME_RE, toSlug, cleanSiteName, cleanAddress } from "./site/names.js";
import { MAX_IMG, sniffImage, checkImage } from "./site/image.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const FOLD_CASE = IS_WIN || process.platform === "darwin";
const HOME = os.homedir();
const DIR = join(HOME, ".claudeconnect");
const LEGACY_DIR = join(HOME, ".chatgql");
const SITE = join(DIR, "site");
const CONFIG = join(DIR, "config.json");
const DEFAULT_REPO = "ThatOneWeirdDev/claudeconnect";
const WR = "npx --yes wrangler@4";
const API = process.env.CLAUDECONNECT_CF_API || "https://api.cloudflare.com/client/v4";
const RESERVED = ["alias", "assoc", "bg", "break", "builtin", "call", "case", "cat", "cd", "chdir", "claude", "clear", "cls", "color", "command", "continue", "copy", "cp", "curl", "date", "declare", "del", "dir", "do", "done", "echo", "elif", "else", "endlocal", "erase", "esac", "eval", "exec", "exit", "export", "false", "fc", "fg", "fi", "for", "ftype", "function", "gc", "gci", "gcm", "git", "gl", "goto", "gp", "gps", "gu", "gv", "hash", "help", "history", "if", "in", "jobs", "kill", "let", "local", "logout", "ls", "man", "md", "mkdir", "mklink", "move", "mv", "node", "npm", "npx", "open", "path", "pause", "popd", "prompt", "ps", "pushd", "pwd", "rd", "read", "rem", "ren", "rename", "return", "rm", "rmdir", "select", "set", "setlocal", "shift", "sl", "sleep", "sort", "source", "start", "tee", "test", "then", "time", "title", "trap", "true", "type", "ulimit", "umask", "unalias", "unset", "until", "ver", "verify", "vol", "wait", "wget", "where", "which", "while", "wrangler", "write"];
const argv = process.argv.slice(2);
const flag = n => argv.includes(n);
const opt = n => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const REMOTE_OP = opt("--remote-op");
const REMOTE = flag("--remote-update") || !!REMOTE_OP;
const UPDATE_ID = opt("--update-id");
const JOB_FILE = opt("--job-file");
const REPO = process.env.CLAUDECONNECT_REPO || DEFAULT_REPO;
const REF = process.env.CLAUDECONNECT_REF || "main";
const tty = !REMOTE && process.stdin.isTTY && process.stdout.isTTY;
const bold = s => (process.stdout.isTTY ? `\x1b[1m${s}\x1b[0m` : s);
const teal = s => (process.stdout.isTTY ? `\x1b[36m${s}\x1b[0m` : s);
const dim = s => (process.stdout.isTTY ? `\x1b[2m${s}\x1b[0m` : s);
let token = null;
let accountId = null;

function step(s) {
  console.log("\n" + teal("▸ ") + bold(s));
}

function note(s) {
  console.log(dim("  " + s));
}

class Stop extends Error {}

function fail(s) {
  if (REMOTE) throw new Stop(s);
  console.error("\n" + bold("Setup stopped: ") + s);
  process.exit(1);
}

function sh(cmd, opts = {}) {
  const env = { ...process.env, ...(opts.env || {}) };
  if (accountId) env.CLOUDFLARE_ACCOUNT_ID = accountId;
  return spawnSync(cmd, { shell: true, stdio: opts.capture ? ["inherit", "pipe", "pipe"] : "inherit", encoding: "utf8", cwd: opts.cwd || HOME, env });
}

function q(p) {
  return `"${p}"`;
}

function openUrl(u) {
  try {
    const c = IS_WIN ? spawn("cmd", ["/c", "start", "", u.replace(/&/g, "^&")], { detached: true, stdio: "ignore", windowsHide: true }) : spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { detached: true, stdio: "ignore" });
    c.on("error", () => {});
    c.unref();
  } catch {}
}

async function ask(question, def) {
  if (!tty) return def;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(question)).trim();
  rl.close();
  return a || def;
}

async function cf(method, path, body) {
  let r;
  try {
    r = await fetch(API + path, { method, headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  } catch (e) {
    return { ok: false, status: 0, result: null, error: String(e.message || e) };
  }
  const j = await r.json().catch(() => ({}));
  const error = Array.isArray(j.errors) && j.errors.length ? j.errors.map(e => e.message).join("; ") : `HTTP ${r.status}`;
  return { ok: r.ok && j.success !== false, status: r.status, result: j.result, error };
}

function cloudflareToken() {
  const r = sh(`${WR} auth token --json`, { capture: true });
  if (r.status !== 0) return null;
  const out = String(r.stdout || "");
  try {
    return JSON.parse(out.slice(out.indexOf("{"))).token || null;
  } catch {
    const last = out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
    return /^[\w.-]{20,}$/.test(last) ? last : null;
  }
}

function findClaude() {
  const local = join(HOME, ".local", "bin", IS_WIN ? "claude.exe" : "claude");
  const r = sh("claude --version", { capture: true });
  if (r.status === 0 && /\d+\.\d+\.\d+/.test(r.stdout || "")) return { cmd: "claude", path: "", version: r.stdout.match(/\d+\.\d+\.\d+/)[0] };
  if (existsSync(local)) {
    const v = spawnSync(local, ["--version"], { encoding: "utf8" });
    if (v.status === 0) return { cmd: q(local), path: local, version: (String(v.stdout).match(/\d+\.\d+\.\d+/) || [""])[0] };
  }
  return null;
}

function signedIn(cmd) {
  const st = sh(`${cmd} auth status`, { capture: true, env: { ANTHROPIC_API_KEY: "" } });
  try {
    return ["claude.ai", "oauth_token"].includes(JSON.parse(st.stdout).authMethod);
  } catch {
    return false;
  }
}

function hostName(u) {
  try {
    return new URL(u).hostname.split(".")[0];
  } catch {
    return null;
  }
}

function writable(dir) {
  try {
    accessSync(dir, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function readJson(p) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function stopLocal() {
  for (const d of [DIR, LEGACY_DIR]) {
    const agent = join(d, "agent.mjs");
    if (!existsSync(agent) || !existsSync(join(d, "config.json"))) continue;
    spawnSync(process.execPath, [agent, "stop"], { stdio: "ignore" });
    spawnSync(process.execPath, [agent, "autostart", "off"], { stdio: "ignore" });
  }
}

function isOurs(p) {
  try {
    if (statSync(p).size > 4096) return false;
    const s = readFileSync(p, "utf8");
    return /agent\.mjs/.test(s) && /[\\/]\.(claudeconnect|chatgql)[\\/]/.test(s);
  } catch {
    return false;
  }
}

function shimDirs() {
  const prefix = (sh("npm prefix -g", { capture: true }).stdout || "").trim();
  const dirs = [join(DIR, "bin"), join(LEGACY_DIR, "bin")];
  if (prefix) dirs.unshift(IS_WIN ? prefix : join(prefix, "bin"));
  return { prefix, dirs };
}

function removeShims(names, extra) {
  const { dirs } = shimDirs();
  const files = new Set(extra.filter(Boolean));
  for (const d of dirs) for (const n of names.filter(Boolean)) for (const f of IS_WIN ? [n + ".cmd"] : [n]) files.add(join(d, f));
  for (const f of files) {
    if (isOurs(f)) {
      try {
        unlinkSync(f);
      } catch {}
    }
  }
}

function pathCommands(extraDirs) {
  const seen = new Map();
  const exts = IS_WIN ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC;.PS1").toLowerCase().split(";").filter(Boolean) : [];
  const dirs = [...(process.env.PATH || "").split(IS_WIN ? ";" : ":"), ...extraDirs];
  for (const d of dirs) {
    if (!d) continue;
    let list;
    try {
      list = readdirSync(d, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of list) {
      if (e.isDirectory()) continue;
      let n = e.name;
      if (IS_WIN) {
        const ext = (n.match(/\.[^.]+$/) || [""])[0].toLowerCase();
        if (!exts.includes(ext)) continue;
        n = n.slice(0, -ext.length);
      }
      const k = FOLD_CASE ? n.toLowerCase() : n;
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(join(d, e.name));
    }
  }
  return seen;
}

function pickCommand(displayName, extraDirs) {
  const base = displayName.replace(/[^A-Za-z0-9_-]/g, "").replace(/^[-_]+/, "") || "ClaudeConnect";
  const cmds = pathCommands(extraDirs);
  const norm = s => (FOLD_CASE ? s.toLowerCase() : s);
  const reserved = new Set(RESERVED.map(norm));
  const taken = c => reserved.has(norm(c)) || (cmds.get(norm(c)) || []).some(p => !isOurs(p));
  let cmd = base;
  for (let i = 0; taken(cmd); i++) cmd = base + String(Math.floor(Math.random() * (i < 20 ? 90 : 9000)) + (i < 20 ? 10 : 1000));
  return { cmd, renamed: cmd !== base, base };
}

function pickWorkspace(name) {
  const base = join(HOME, name);
  if (!existsSync(base)) return base;
  try {
    if (statSync(base).isDirectory() && readdirSync(base).length === 0) return base;
  } catch {}
  return join(HOME, `${name} Workspace`);
}

async function loadImage(src) {
  src = src.trim().replace(/^["']|["']$/g, "");
  if (!IS_WIN) src = src.replace(/\\ /g, " ");
  let buf;
  if (/^https?:\/\//i.test(src)) {
    let r;
    try {
      r = await fetch(src, { redirect: "follow" });
    } catch {
      throw new Error("that link couldn't be reached");
    }
    if (!r.ok) throw new Error(`that link answered with an error (${r.status})`);
    buf = Buffer.from(await r.arrayBuffer());
  } else {
    const p = src.startsWith("~") ? join(HOME, src.slice(1)) : src;
    if (!existsSync(p) || !statSync(p).isFile()) throw new Error("there's no file there");
    if (statSync(p).size > MAX_IMG) throw new Error("it's bigger than 512 KB");
    buf = readFileSync(p);
  }
  if (buf.length > MAX_IMG) throw new Error("it's bigger than 512 KB");
  const type = sniffImage(buf);
  if (!type) throw new Error("it isn't a PNG, JPEG, GIF, WebP, ICO or SVG image");
  return { type, b64: buf.toString("base64") };
}

function readBrand() {
  try {
    const s = readFileSync(join(SITE, "brand.js"), "utf8");
    const j = JSON.parse(s.slice(s.indexOf("{"), s.lastIndexOf("}") + 1));
    return { logo: j.logo || null, favicon: j.favicon || null };
  } catch {
    return { logo: null, favicon: null };
  }
}

async function askImage(label, keepWhat, fallbackWhat, flagName, current) {
  let preset = opt(flagName);
  for (;;) {
    const raw = preset !== null ? preset : await ask(`  ${label}: a file path or https:// link (Enter for ${current ? keepWhat : fallbackWhat}): `, "");
    preset = null;
    const v = String(raw || "").trim();
    if (!v) return current || null;
    if (/^(default|none|built-?in)$/i.test(v)) return null;
    try {
      return await loadImage(v);
    } catch (e) {
      console.log(`  That image won't work: ${e.message}.`);
      if (!tty) fail(`The ${label.toLowerCase()} didn't work (${e.message}).`);
    }
  }
}

async function findExisting(prior) {
  const names = new Set();
  let v1 = false;
  const scripts = await cf("GET", `/accounts/${accountId}/workers/scripts`);
  const have = new Set((scripts.result || []).map(s => s.id));
  const ns = await cf("GET", `/accounts/${accountId}/workers/durable_objects/namespaces?per_page=1000`);
  for (const n of ns.result || []) {
    if (n.class === "ChatgqlHub" && have.has(n.script)) names.add(n.script);
    if (n.class === "Hub" && n.script === "chatgql" && have.has("chatgql")) {
      names.add("chatgql");
      v1 = true;
    }
  }
  if (prior.accountId === accountId || !prior.accountId) {
    for (const n of [prior.name, hostName(prior.site), hostName(prior.relay)]) if (n && have.has(n)) names.add(n);
  }
  if (names.has("chatgql") && have.has("chatgql-relay")) {
    names.add("chatgql-relay");
    v1 = true;
  }
  const kv = await cf("GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
  const kvs = (kv.result || []).filter(k => /-signin$/.test(k.title) && (names.has(k.title.replace(/-signin$/, "")) || k.id === prior.kvId));
  return { names: [...names], kvs, have, v1, kvAll: kv.result || [] };
}

async function reset(found) {
  step("Resetting");
  stopLocal();
  removeShims([prior.command, "chatgql"], [prior.shim]);
  note(`Stopped ${known} on this computer.`);
  for (const n of found.names.sort((a, b) => (b.endsWith("-relay") ? 1 : 0) - (a.endsWith("-relay") ? 1 : 0))) {
    const r = await cf("DELETE", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(n)}?force=true`);
    note(r.ok || r.status === 404 ? `Deleted the old ${n} worker.` : `Couldn't delete ${n}: ${r.error}`);
  }
  for (const k of found.kvs) {
    const r = await cf("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${k.id}`);
    if (r.ok || r.status === 404) note(`Deleted its ${k.title} storage.`);
  }
  for (const p of [CONFIG, join(LEGACY_DIR, "config.json")]) {
    try {
      rmSync(p, { force: true });
    } catch {}
  }
}

function sha256(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// The release in HERE has to be exactly what its manifest says, or nothing gets installed.
function loadPayload() {
  const manifest = readJson(join(HERE, "manifest.json"));
  if (!manifest || !manifest.version || !manifest.files) fail("The download has no release manifest. Run ClaudeConnect.mjs again.");
  for (const [rel, want] of Object.entries(manifest.files)) {
    const p = join(HERE, rel);
    if (!existsSync(p)) fail(`The download is missing ${rel}. Run ClaudeConnect.mjs again.`);
    if (sha256(readFileSync(p)) !== want) fail(`${rel} doesn't match the release manifest.${existsSync(join(HERE, ".git")) ? " Run: node scripts/release.mjs" : " Run ClaudeConnect.mjs again."}`);
  }
  return manifest;
}

function copyOut(rel, dest) {
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, readFileSync(join(HERE, rel)));
}

function installSite(manifest) {
  mkdirSync(SITE, { recursive: true });
  for (const rel of Object.keys(manifest.files)) if (rel.startsWith("site/")) copyOut(rel, join(SITE, rel.slice(5)));
}

// manifest.json goes last: the agent reads its version from it, so it only changes once everything else is in place.
function installComputer(manifest) {
  mkdirSync(DIR, { recursive: true });
  for (const rel of Object.keys(manifest.files)) if (!rel.startsWith("site/")) copyOut(rel, join(DIR, rel.replace(/^agent\//, "")));
  copyOut("manifest.json", join(DIR, "manifest.json"));
  writeFileSync(join(DIR, "package.json"), JSON.stringify({ name: "claudeconnect", private: true, type: "module" }, null, 2));
}

function wranglerConfig(o) {
  return {
    name: o.slug,
    main: "worker.js",
    account_id: o.accountId,
    compatibility_date: "2025-09-01",
    workers_dev: true,
    preview_urls: false,
    rules: [{ type: "Text", globs: ["**/*.html"], fallthrough: true }],
    durable_objects: { bindings: [{ name: "HUB", class_name: "ChatgqlHub" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["ChatgqlHub"] }],
    kv_namespaces: [{ binding: "TOKENS", id: o.kvId }],
    vars: { SITE_NAME: o.displayName, COMMAND: o.command, SHOW_FABLE: o.fable ? "1" : "0", APP_VERSION: o.version, UPDATE_REPO: o.repo, UPDATE_REF: o.ref, WORKER_NAME: o.slug },
    observability: { enabled: true }
  };
}

// Tells the site how a remote job is going. The site keeps this for you, so it survives the site and this computer restarting.
// It answers with whether you've asked to cancel. `REPORT_TO` pins reporting to one site: a move keeps telling the old site
// until that site is deleted.
let REPORT_TO = null;

async function report(step, status, message, info) {
  if (!REMOTE || !UPDATE_ID) return null;
  const c = REPORT_TO || readJson(CONFIG);
  if (!c || !c.site) return null;
  try {
    const r = await fetch(c.site.replace(/\/$/, "") + "/agent/progress", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-access-token": c.token || "", "x-chatgql-key": c.secret || "", "x-agent-id": c.id || "" },
      body: JSON.stringify({ id: UPDATE_ID, step, status, message, info }),
      signal: AbortSignal.timeout(8000)
    });
    return await r.json().catch(() => null);
  } catch {
    return null;
  }
}

function agentPid() {
  try {
    const pid = Number(readFileSync(join(DIR, "agent.pid"), "utf8").trim());
    process.kill(pid, 0);
    return pid;
  } catch {
    return 0;
  }
}

// The updater was started by the running agent, so it must not use `agent stop` (on Windows that ends the whole process tree).
async function stopAgentQuietly() {
  const pid = agentPid();
  if (!pid) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {}
  for (let i = 0; i < 50 && agentPid(); i++) await new Promise(r => setTimeout(r, 200));
  if (agentPid()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
}

function waitForConnected(logPath, from, ms) {
  return (async () => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      try {
        const size = statSync(logPath).size;
        const start = size < from ? 0 : from;
        if (size > start) {
          const fd = openSync(logPath, "r");
          const buf = Buffer.alloc(size - start);
          readSync(fd, buf, 0, buf.length, start);
          closeSync(fd);
          if (/Connected\.|Reconnected\./.test(buf.toString("utf8"))) return true;
        }
      } catch {}
      await new Promise(r => setTimeout(r, 1500));
    }
    return false;
  })();
}

async function remoteUpdate(manifest) {
  const old = readJson(CONFIG);
  if (!old || !old.accountId || !old.kvId || !old.name || !old.site) fail("This computer isn't set up yet, so there's nothing to update. Run ClaudeConnect.mjs and choose to set it up.");
  accountId = old.accountId;
  let at = "verify";
  let stopped = false;
  const agentPath = join(DIR, "agent.mjs");
  try {
    await report("verify", "done");
    at = "site";
    await report("site", "active");
    token = cloudflareToken();
    if (!token) fail(`Cloudflare didn't accept the saved sign-in. Run ${old.command || "ClaudeConnect"} update on your computer to sign in again.`);
    installSite(manifest);
    writeFileSync(join(SITE, "wrangler.jsonc"), JSON.stringify(wranglerConfig({ slug: old.name, accountId, kvId: old.kvId, displayName: old.displayName || "ClaudeConnect", command: old.command || "ClaudeConnect", fable: !!old.fable, version: manifest.version, repo: REPO, ref: REF }), null, 2));
    deploy(SITE, old, "the new version");
    await report("site", "done");
    at = "computer";
    await report("computer", "active");
    await stopAgentQuietly();
    stopped = true;
    installComputer(manifest);
    const cfg = readJson(CONFIG) || old;
    cfg.version = manifest.version;
    cfg.repo = REPO;
    cfg.ref = REF;
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await report("computer", "done");
    at = "restart";
    await report("restart", "active");
    const logPath = join(DIR, "agent.log");
    let from = 0;
    try {
      from = statSync(logPath).size;
    } catch {}
    spawnSync(process.execPath, [agentPath, "background"], { stdio: "ignore" });
    stopped = false;
    await report("restart", "done");
    at = "online";
    await report("online", "active");
    if (!(await waitForConnected(logPath, from, 120000))) fail(`The new version started but hasn't connected to the site yet. Run ${cfg.command || "ClaudeConnect"} logs on your computer to see why.`);
    await report("online", "done");
    console.log(`Updated to ${manifest.version}.`);
  } catch (e) {
    const msg = e instanceof Stop ? e.message : `Something unexpected went wrong: ${String((e && e.message) || e).slice(0, 200)}`;
    console.error(msg);
    // If the old program was stopped and the update broke before the new one started, bring one back.
    if (stopped) spawnSync(process.execPath, [agentPath, "background"], { stdio: "ignore" });
    await report(at, "error", msg);
    process.exit(1);
  }
  process.exit(0);
}

// ---- changes to the site itself, started from its Settings page. They use the site files already on this computer (the
// version that is deployed), so nothing is downloaded and nothing gets updated by accident.

const sleep = ms => new Promise(r => setTimeout(r, ms));

function jobInput() {
  let job = {};
  if (JOB_FILE) {
    try {
      job = JSON.parse(readFileSync(JOB_FILE, "utf8"));
    } catch {}
    try {
      unlinkSync(JOB_FILE);
    } catch {}
  }
  return job && typeof job === "object" ? job : {};
}

function requireInstall() {
  const old = readJson(CONFIG);
  if (!old || !old.accountId || !old.kvId || !old.name || !old.site) fail("This computer isn't set up yet, so there's nothing to change. Run ClaudeConnect.mjs and choose to set it up.");
  if (!existsSync(join(SITE, "worker.js"))) fail(`The site's files aren't on this computer. Run ${old.command || "ClaudeConnect"} update first.`);
  return old;
}

function signIn(old) {
  token = cloudflareToken();
  if (!token) fail(`Cloudflare didn't accept the saved sign-in. Run ${old.command || "ClaudeConnect"} update on your computer to sign in again.`);
}

function deploy(dir, old, what) {
  const dep = sh(`${WR} deploy -c wrangler.jsonc`, { cwd: dir, capture: true });
  process.stdout.write(String(dep.stdout || ""));
  process.stderr.write(String(dep.stderr || ""));
  if (dep.status === 0) return;
  const why = (String(dep.stderr || "") + String(dep.stdout || "")).split(/\r?\n/).map(l => l.trim()).filter(l => /error|fail|unauthori|login|auth/i.test(l)).slice(-2).join(" ");
  fail(`Cloudflare didn't accept ${what}.${why ? " " + why.slice(0, 200) : ""} Run ${old.command || "ClaudeConnect"} update on your computer to see the details.`);
}

async function restartAgent() {
  const logPath = join(DIR, "agent.log");
  let from = 0;
  try {
    from = statSync(logPath).size;
  } catch {}
  await stopAgentQuietly();
  spawnSync(process.execPath, [join(DIR, "agent.mjs"), "background"], { stdio: "ignore" });
  return waitForConnected(logPath, from, 120000);
}

function failure(e) {
  return e instanceof Stop ? e.message : `Something unexpected went wrong: ${String((e && e.message) || e).slice(0, 200)}`;
}

async function kvValue(kvId, key) {
  try {
    const r = await fetch(`${API}/accounts/${accountId}/storage/kv/namespaces/${kvId}/values/${key}`, { headers: { authorization: "Bearer " + token }, signal: AbortSignal.timeout(15000) });
    return r.ok ? JSON.parse(await r.text()) : null;
  } catch {
    return null;
  }
}

// Name, what the AI calls itself, Fable, logo and tab icon: the same site, redeployed with new settings. Chats are untouched.
async function remoteSettings(old, job) {
  accountId = old.accountId;
  let at = "site";
  try {
    await report("site", "active");
    signIn(old);
    const displayName = cleanSiteName(job.displayName) || old.displayName || "ClaudeConnect";
    const fable = typeof job.fable === "boolean" ? job.fable : !!old.fable;
    const brand = readBrand();
    for (const k of ["logo", "favicon"]) {
      if (!(k in job)) continue;
      if (job[k] === null) {
        brand[k] = null;
        continue;
      }
      const img = checkImage(job[k] && job[k].b64);
      if (img.error) fail(`The ${k === "logo" ? "logo" : "tab icon"} didn't work: ${img.error}.`);
      brand[k] = { type: img.type, b64: img.b64 };
    }
    writeFileSync(join(SITE, "brand.js"), "export default " + JSON.stringify(brand) + ";\n");
    const version = old.version || (readJson(join(DIR, "manifest.json")) || {}).version || "0.0.0";
    writeFileSync(join(SITE, "wrangler.jsonc"), JSON.stringify(wranglerConfig({ slug: old.name, accountId, kvId: old.kvId, displayName, command: old.command || "ClaudeConnect", fable, version, repo: old.repo || REPO, ref: old.ref || REF }), null, 2));
    deploy(SITE, old, "the changes");
    await report("site", "done");
    at = "computer";
    await report("computer", "active");
    const cfg = readJson(CONFIG) || old;
    Object.assign(cfg, { displayName, fable });
    delete cfg.aiName; // older installs saved a name for the AI; Claude runs with its own default instructions now
    writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    await report("computer", "done");
    at = "restart";
    await report("restart", "active");
    const online = await restartAgent();
    await report("restart", "done");
    at = "online";
    await report("online", "active");
    if (!online) fail(`The changes are in, but ${displayName} hasn't reconnected yet. Run ${old.command || "ClaudeConnect"} logs on your computer to see why.`);
    await report("online", "done");
    console.log("Settings changed.");
  } catch (e) {
    const msg = failure(e);
    console.error(msg);
    await report(at, "error", msg);
    process.exit(1);
  }
  process.exit(0);
}

// A new address is a new Worker. The old site stays up and in use until the new one is claimed and this computer has connected to
// it, so a mistake anywhere before then leaves everything as it was. Only then is the old site deleted.
async function remoteMove(old, job) {
  accountId = old.accountId;
  const slug = cleanAddress(job.address);
  let at = "prepare";
  let touched = false;
  let madeKv = null;
  let committed = false;
  let stopped = false;
  let swapped = false;
  const next = join(DIR, "site-next");
  const prev = join(DIR, "site-old");
  let newSite = "";
  try {
    await report("prepare", "active");
    if (!slug) fail("That address won't work. Use 1 to 63 lowercase letters, numbers or dashes.");
    if (slug === old.name) fail("That's the address it already has.");
    signIn(old);
    const scripts = await cf("GET", `/accounts/${accountId}/workers/scripts`);
    if (!scripts.ok) fail(`Couldn't check your Cloudflare account (${scripts.error}).`);
    if ((scripts.result || []).some(x => x.id === slug)) fail(`There's already a worker called ${slug} in this Cloudflare account. Pick a different address.`);
    const sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
    if (!sub.result || !sub.result.subdomain) fail("Couldn't work out your workers.dev address.");
    newSite = process.env.CLAUDECONNECT_SITE_ORIGIN || `https://${slug}.${sub.result.subdomain}.workers.dev`; // the override is for tests
    await report("prepare", "done");

    at = "create";
    await report("create", "active");
    const kvTitle = `${slug}-signin`;
    const kvs = await cf("GET", `/accounts/${accountId}/storage/kv/namespaces?per_page=100`);
    let kvId = ((kvs.result || []).find(k => k.title === kvTitle) || {}).id || null;
    if (!kvId) {
      const made = await cf("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title: kvTitle });
      if (!made.ok || !made.result) fail(`Couldn't create the new site's storage (${made.error}).`);
      kvId = made.result.id;
      madeKv = kvId;
    }
    rmSync(next, { recursive: true, force: true });
    cpSync(SITE, next, { recursive: true });
    const secret = crypto.randomBytes(32).toString("base64url");
    const claim = crypto.randomBytes(18).toString("base64url");
    const version = old.version || (readJson(join(DIR, "manifest.json")) || {}).version || "0.0.0";
    writeFileSync(join(next, "wrangler.jsonc"), JSON.stringify(wranglerConfig({ slug, accountId, kvId, displayName: old.displayName || "ClaudeConnect", command: old.command || "ClaudeConnect", fable: !!old.fable, version, repo: old.repo || REPO, ref: old.ref || REF }), null, 2));
    touched = true;
    deploy(next, old, "the new site");
    const tmp = join(DIR, `secrets-${crypto.randomBytes(6).toString("hex")}.json`);
    writeFileSync(tmp, JSON.stringify({ CLAIM_CODE: claim, AGENT_SECRET: secret }), { mode: 0o600 });
    const sec = sh(`${WR} secret bulk ${q(tmp)} -c wrangler.jsonc`, { cwd: next });
    try {
      unlinkSync(tmp);
    } catch {}
    if (sec.status !== 0) fail("Couldn't save the new site's secrets.");
    await report("create", "done");

    // The owner has to turn Cloudflare Access on for the new address. The page shows how, keeps this alive, and learns when
    // it worked: the new site only ever stores a sign-in once someone has passed Access and claimed it.
    at = "access";
    const info = { site: newSite, claim: `${newSite}/?claim=${claim}`, dash: `https://dash.cloudflare.com/${accountId}/workers/services/view/${slug}/production/settings`, name: slug };
    let found = null;
    const until = Date.now() + 60 * 60000;
    while (Date.now() < until) {
      const r = await report("access", "active", undefined, info);
      if (r && r.cancel) fail("Cancelled. The old site is untouched.");
      found = await kvValue(kvId, "agent-token");
      if (found && typeof found.token === "string" && typeof found.exp === "number") break;
      found = null;
      await sleep(5000);
    }
    if (!found) fail("Timed out waiting for the new site to be claimed. The old site is untouched.");
    await report("access", "done", undefined, info);

    at = "switch";
    await report("switch", "active");
    REPORT_TO = readJson(CONFIG);
    await stopAgentQuietly();
    stopped = true;
    writeFileSync(CONFIG, JSON.stringify({ ...old, name: slug, site: newSite, secret, kvId, token: found.token, tokenExp: found.exp }, null, 2), { mode: 0o600 });
    rmSync(prev, { recursive: true, force: true });
    renameSync(SITE, prev);
    swapped = true;
    renameSync(next, SITE);
    const logPath = join(DIR, "agent.log");
    let from = 0;
    try {
      from = statSync(logPath).size;
    } catch {}
    spawnSync(process.execPath, [join(DIR, "agent.mjs"), "background"], { stdio: "ignore" });
    if (!(await waitForConnected(logPath, from, 120000))) fail("This computer couldn't connect to the new site. The old site is untouched.");
    committed = true;
    stopped = false;
    await report("switch", "done");

    at = "cleanup";
    await report("cleanup", "active", undefined, info);
    await sleep(3500); // the page is polling: let it see this step before the site it is polling goes away
    const gone = await cf("DELETE", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(old.name)}?force=true`);
    if (!gone.ok && gone.status !== 404) fail(`${old.displayName || "The site"} now lives at ${newSite}, but the old site couldn't be deleted (${gone.error}). You can delete ${old.name} in the Cloudflare dashboard.`);
    await cf("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${old.kvId}`);
    rmSync(prev, { recursive: true, force: true });
    console.log(`Moved to ${newSite}. The old site is gone.`);
  } catch (e) {
    const msg = failure(e);
    console.error(msg);
    if (!committed) {
      // Put everything back as it was.
      try {
        if (swapped) {
          rmSync(SITE, { recursive: true, force: true });
          renameSync(prev, SITE);
        }
        if (stopped) {
          await stopAgentQuietly();
          writeFileSync(CONFIG, JSON.stringify(old, null, 2), { mode: 0o600 });
          spawnSync(process.execPath, [join(DIR, "agent.mjs"), "background"], { stdio: "ignore" });
        }
        if (touched) await cf("DELETE", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(slug)}?force=true`);
        if (madeKv) await cf("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${madeKv}`);
        rmSync(next, { recursive: true, force: true });
      } catch {}
    }
    await report(at, "error", msg);
    process.exit(1);
  }
  process.exit(0);
}

// The Delete button: the site and every chat in it are removed, and this computer stops serving it. The folder Claude works in is kept.
async function remoteDelete(old) {
  accountId = old.accountId;
  let at = "site";
  try {
    await report("site", "active");
    signIn(old);
    await sleep(3500); // the page is polling: let it see this step before the site it is polling goes away
    const gone = await cf("DELETE", `/accounts/${accountId}/workers/scripts/${encodeURIComponent(old.name)}?force=true`);
    if (!gone.ok && gone.status !== 404) fail(`Cloudflare wouldn't delete the site (${gone.error}).`);
    await cf("DELETE", `/accounts/${accountId}/storage/kv/namespaces/${old.kvId}`);
    at = "computer";
    const agentPath = join(DIR, "agent.mjs");
    spawnSync(process.execPath, [agentPath, "autostart", "off"], { stdio: "ignore" });
    await stopAgentQuietly();
    removeShims([old.command, "chatgql"], [old.shim]);
    rmSync(CONFIG, { force: true });
    console.log("Deleted the site and its chats.");
  } catch (e) {
    const msg = failure(e);
    console.error(msg);
    await report(at, "error", msg);
    process.exit(1);
  }
  process.exit(0);
}

if (REMOTE_OP) {
  const first = { settings: "site", move: "prepare", delete: "site" }[REMOTE_OP];
  const job = jobInput();
  if (!first) {
    console.error(`This version doesn't know how to ${REMOTE_OP}.`);
    await report("site", "error", "This version doesn't know how to do that.");
    process.exit(1);
  }
  let old = null;
  try {
    old = requireInstall();
  } catch (e) {
    console.error(failure(e));
    await report(first, "error", failure(e));
    process.exit(1);
  }
  if (REMOTE_OP === "settings") await remoteSettings(old, job);
  else if (REMOTE_OP === "move") await remoteMove(old, job);
  else await remoteDelete(old);
}

const major = Number(process.versions.node.split(".")[0]);
let payload;
try {
  if (major < 22) fail(`This needs Node.js 22 or newer, and you have ${process.version}. Install the current LTS from nodejs.org, then run this again.`);
  payload = loadPayload();
} catch (e) {
  if (!(e instanceof Stop)) throw e;
  console.error(e.message);
  await report("verify", "error", e.message);
  process.exit(1);
}
if (REMOTE) await remoteUpdate(payload);

console.log(bold(`\nClaudeConnect setup`) + dim(`  ${payload.version}`));

let prior = readJson(CONFIG) || {};
let legacy = false;
if (!prior.accountId) {
  const old = readJson(join(LEGACY_DIR, "config.json"));
  if (old && old.accountId) {
    prior = old;
    legacy = true;
  }
}
const known = prior.displayName || "ClaudeConnect";

step("Checking Claude Code");
let claude = findClaude();
if (!claude) {
  note("Not installed yet, installing it now.");
  const r = IS_WIN
    ? sh(`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://claude.ai/install.ps1 | iex"`)
    : sh(`curl -fsSL https://claude.ai/install.sh | bash`);
  claude = findClaude();
  if (r.status !== 0 || !claude) fail("Claude Code didn't install. Install it from https://claude.ai/install and run this again.");
}
note(`Claude Code ${claude.version} is installed.`);
if (!signedIn(claude.cmd)) {
  note("Sign in with your Claude account in the browser window that opens.");
  sh(`${claude.cmd} auth login`);
  if (!signedIn(claude.cmd)) fail("Claude Code isn't signed in yet. Run this again when you're ready to sign in.");
}
note("Signed in with your Claude plan.");

step("Checking your Cloudflare sign-in");
token = cloudflareToken();
if (!token) {
  note("A browser window will open so you can sign in to Cloudflare.");
  if (sh(`${WR} login`).status !== 0) fail("Cloudflare sign-in didn't finish. Run this again when you're ready.");
  token = cloudflareToken();
}
if (!token) fail("Couldn't get your Cloudflare sign-in. Run this again.");
const accounts = await cf("GET", "/accounts?per_page=50");
const list = (accounts.result || []).filter(a => a && a.id);
if (!list.length) fail(`Couldn't read your Cloudflare accounts (${accounts.error}).`);
if (list.length === 1) accountId = list[0].id;
else {
  const preset = opt("--account") || prior.accountId;
  const hit = list.find(a => a.id === preset || a.name === preset);
  if (hit && !tty) accountId = hit.id;
  else {
    list.forEach((a, i) => console.log(`  ${i + 1}. ${a.name}`));
    const pick = await ask(`  Which account should ClaudeConnect use? [${hit ? list.indexOf(hit) + 1 : 1}] `, String(hit ? list.indexOf(hit) + 1 : 1));
    accountId = (list[Number(pick) - 1] || list[0]).id;
  }
}
const me = await cf("GET", "/user");
note(`Signed in${me.result && me.result.email ? " as " + me.result.email : ""}, account ${list.find(a => a.id === accountId).name}.`);

let found = await findExisting(prior);
let mode = "fresh";
let target = null;
if (found.names.length || existsSync(CONFIG) || legacy) {
  const where = found.names.length ? found.names.join(", ") : "this computer";
  target = found.v1 ? null : found.names.includes(prior.name) ? prior.name : found.names.find(n => !n.endsWith("-relay")) || null;
  console.log("\n" + bold(`${known} is already set up`) + ` (${where}).`);
  if (target) console.log(`  ${bold("u")}  Update it. Keeps your chats, brings the site and this computer up to date, and lets you change its name and look.`);
  console.log(`  ${bold("r")}  Reset it. Deletes the site and all its chats, then sets everything up again from the start.`);
  console.log(`  ${bold("n")}  Leave it as it is.`);
  const pick = flag("--reset") ? "r" : flag("--update") && target ? "u" : (await ask(`  Choose [${target ? "u/" : ""}r/N]: `, "n")).toLowerCase();
  if (pick.startsWith("u") && target) mode = "update";
  else if (pick.startsWith("r")) {
    await reset(found);
    prior = {};
    legacy = false;
    found = await findExisting(prior);
  } else {
    console.log(`\nNothing changed.${prior.command ? ` Run ${prior.command} to bring it online on this computer.` : ""}`);
    process.exit(0);
  }
}
const same = mode === "update" && prior.name === target && (!prior.accountId || prior.accountId === accountId);

step(mode === "update" ? "Your site" : "Naming your site");
note("The name shows at the top of the site, and it's also the command you'll type to run it.");
let displayName = null;
let slug = mode === "update" ? target : null;
let preset = opt("--name");
const nameDef = mode === "update" ? prior.displayName || "" : "";
for (;;) {
  const raw = preset || (await ask(`  Name${nameDef ? ` [${nameDef}]` : ""}: `, nameDef));
  preset = null;
  const n = String(raw || "").trim().replace(/\s+/g, " ");
  if (!n) {
    if (!tty) fail("Pick a name with --name.");
    continue;
  }
  if (!NAME_RE.test(n) || !toSlug(n)) {
    console.log("  That name won't work. Use up to 40 letters, numbers, spaces, dots, dashes or underscores, starting with a letter or number.");
    if (!tty) fail("Pick a valid name with --name.");
    continue;
  }
  if (mode === "fresh") {
    const s2 = toSlug(n);
    if (!SLUG_RE.test(s2)) {
      console.log("  That name won't work as a web address. Try a shorter one.");
      if (!tty) fail("Pick a valid name with --name.");
      continue;
    }
    if (found.have.has(s2)) {
      console.log(`  There's already a worker called ${s2} in this Cloudflare account. Pick a different name.`);
      if (!tty) fail(`The name ${n} is taken.`);
      continue;
    }
    slug = s2;
  }
  displayName = n;
  break;
}
const priorBrand = mode === "update" && !legacy ? readBrand() : { logo: null, favicon: null };
if (priorBrand.logo || priorBrand.favicon) note("Type default to go back to the built-in logo or tab icon.");
const logo = await askImage("Logo", "the current one", "the built-in one", "--logo", priorBrand.logo);
let favicon = await askImage("Tab icon", "the current one", logo ? "the logo" : "the built-in one", "--favicon", priorBrand.favicon);
if (favicon && logo && favicon.b64 === logo.b64) favicon = null;
const fableDef = mode === "update" && prior.fable ? "y" : "n";
const fableAns = flag("--fable") ? "y" : flag("--no-fable") ? "n" : await ask(`  Do you have usage credits for Fable 5.1? It only shows in the model picker if you do. [${fableDef === "y" ? "Y/n" : "y/N"}] `, fableDef);
const fable = /^y/i.test(fableAns);
const { prefix: npmPrefix } = shimDirs();
let binDir = npmPrefix ? (IS_WIN ? npmPrefix : join(npmPrefix, "bin")) : "";
let onPath = true;
if (!binDir || !existsSync(binDir) || !writable(binDir)) {
  binDir = join(DIR, "bin");
  onPath = false;
}
const picked = pickCommand(displayName, [binDir]);
const command = picked.cmd;
note(picked.renamed ? `${picked.base} is already a command on this computer, so yours is ${command}.` : `Your command is ${command}.`);

step(mode === "update" ? "Updating the site" : "Creating the site");
let kvId = null;
const kvTitle = `${slug}-signin`;
if (same && prior.kvId && found.kvAll.some(k => k.id === prior.kvId)) kvId = prior.kvId;
else {
  const kvHit = found.kvAll.find(k => k.title === kvTitle);
  if (kvHit) kvId = kvHit.id;
  else {
    const made = await cf("POST", `/accounts/${accountId}/storage/kv/namespaces`, { title: kvTitle });
    if (!made.ok || !made.result) fail(`Couldn't create the site's storage (${made.error}).`);
    kvId = made.result.id;
  }
}
stopLocal();
removeShims([prior.command, "chatgql"], [prior.shim]);
installSite(payload);
writeFileSync(join(SITE, "brand.js"), "export default " + JSON.stringify({ logo, favicon }) + ";\n");
writeFileSync(join(SITE, "wrangler.jsonc"), JSON.stringify(wranglerConfig({ slug, accountId, kvId, displayName, command, fable, version: payload.version, repo: REPO, ref: REF }), null, 2));
if (sh(`${WR} deploy -c wrangler.jsonc`, { cwd: SITE }).status !== 0) fail("Cloudflare didn't accept the site. The messages above say why.");
const secret = same && prior.secret ? prior.secret : crypto.randomBytes(32).toString("base64url");
const claim = crypto.randomBytes(18).toString("base64url");
const tmp = join(DIR, `secrets-${crypto.randomBytes(6).toString("hex")}.json`);
writeFileSync(tmp, JSON.stringify({ CLAIM_CODE: claim, AGENT_SECRET: secret }), { mode: 0o600 });
const sec = sh(`${WR} secret bulk ${q(tmp)} -c wrangler.jsonc`, { cwd: SITE });
try {
  unlinkSync(tmp);
} catch {}
if (sec.status !== 0) fail("Couldn't save the site's secrets.");
const sub = await cf("GET", `/accounts/${accountId}/workers/subdomain`);
let site = sub.result && sub.result.subdomain ? `https://${slug}.${sub.result.subdomain}.workers.dev` : same ? prior.site || "" : "";
if (!site) site = (await ask("  Paste the workers.dev address shown above: ", "")).replace(/\/$/, "");
if (!/^https?:\/\//.test(site)) fail("Couldn't work out your workers.dev address. Run this again.");
note(site);

step("Setting up this computer");
installComputer(payload);
const workspace = prior.workspace && existsSync(prior.workspace) ? prior.workspace : pickWorkspace(displayName);
mkdirSync(workspace, { recursive: true });
mkdirSync(binDir, { recursive: true });
const agentPath = join(DIR, "agent.mjs");
const shim = join(binDir, IS_WIN ? `${command}.cmd` : command);
const cfg = { name: slug, displayName, command, fable, accountId, kvId, site, secret, workspace, permissionMode: prior.permissionMode || "auto", shim, version: payload.version, repo: REPO, ref: REF };
if (same && prior.id) cfg.id = prior.id;
if (same && prior.site === site && prior.token) {
  cfg.token = prior.token;
  cfg.tokenExp = prior.tokenExp;
}
if (claude.path) cfg.claudePath = claude.path;
if (process.env.CLAUDECONNECT_CF_API) cfg.api = API;
writeFileSync(CONFIG, JSON.stringify(cfg, null, 2), { mode: 0o600 });
if (legacy) {
  try {
    rmSync(LEGACY_DIR, { recursive: true, force: true });
  } catch {}
}
if (IS_WIN) writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${agentPath}" %*\r\n`);
else {
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${agentPath}" "$@"\n`);
  chmodSync(shim, 0o755);
}
note(`Added the ${command} command${onPath ? "" : ` in ${binDir} (add that folder to your PATH)`}.`);
note(`Files it makes go in ${workspace}.`);
const auto = flag("--no-autostart") ? "n" : await ask(`  Keep ${displayName} online whenever you're logged in to this computer? [Y/n] `, "y");
if (/^y/i.test(auto)) spawnSync(process.execPath, [agentPath, "autostart", "on"], { stdio: "ignore" });
const logPath = join(DIR, "agent.log");
let logFrom = 0;
try {
  logFrom = statSync(logPath).size;
} catch {}
spawnSync(process.execPath, [agentPath, "background"], { stdio: "ignore" });
note(/^y/i.test(auto) ? `${displayName} is running and will start again when you log in.` : `${displayName} is running in the background.`);

const accessPage = `https://dash.cloudflare.com/${accountId}/workers/services/view/${slug}/production/access`;
const claimLink = `${site}/?claim=${claim}`;
if (mode === "fresh") {
  step("Locking it to your Cloudflare account");
  console.log(`  1. Turn on Cloudflare Access on the page that's opening:`);
  console.log(`     ${teal(accessPage)}`);
  console.log(`  2. Then open your claim link (one time only):`);
  console.log(`     ${teal(claimLink)}`);
  note("Until you open it, the site shows a locked page to everyone, you included.");
  openUrl(accessPage);
  const enter = await ask("\n  Press Enter once Access is on, and the claim link will open. ", "");
  if (tty && enter.toLowerCase() !== "s") openUrl(claimLink);
} else {
  note(`If the site ever says "Finish setup", open this one-time claim link: ${claimLink}`);
}

function connected() {
  try {
    const size = statSync(logPath).size;
    const start = size < logFrom ? 0 : logFrom;
    if (size <= start) return false;
    const fd = openSync(logPath, "r");
    const buf = Buffer.alloc(size - start);
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    return /Connected\./.test(buf.toString("utf8"));
  } catch {
    return false;
  }
}

if (tty) {
  process.stdout.write(`\n  Waiting for ${displayName} to come online`);
  let online = false;
  for (let i = 0; i < 60 && !online; i++) {
    await new Promise(r => setTimeout(r, 2000));
    process.stdout.write(".");
    online = connected();
  }
  console.log(online ? "\n\n" + bold("All set. ") + `Open ${teal(site)} on any device.` : `\n\n  It'll connect on its own once you've opened the claim link. Then open ${teal(site)} on any device.`);
} else {
  console.log(`\n  ${mode === "fresh" ? "Once Access is on and you've opened the claim link, open" : "Open"} ${site} on any device.`);
}
console.log(dim(`\n  ${command} help lists the commands. ${command} update brings it up to date, and ${site} will say when a new version is out.\n`));
