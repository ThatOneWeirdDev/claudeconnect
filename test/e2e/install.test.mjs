// A first-time install and then an in-place update through the real launcher and installer, with Cloudflare's API faked.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import crypto from "node:crypto";
import { startRepo } from "../helpers/github.mjs";
import { ROOT } from "../helpers/computer.mjs";
import { startFakeCloudflare } from "../helpers/cloudflare.mjs";

const RELEASE = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));
const sha = p => crypto.createHash("sha256").update(readFileSync(p)).digest("hex");
// A killed process whose parent has gone can sit as a zombie in a container with no init, and still answers kill(pid, 0).
function running(pid) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
  } catch {
    return true;
  }
}

function runLauncher(home, env, args) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [join(ROOT, "ClaudeConnect.mjs"), ...args], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
    child.on("close", status => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });
}

test("a first install, then an update, through the real launcher and installer", async t => {
  const github = await startRepo(ROOT);
  const home = mkdtempSync(join(tmpdir(), "cc-install-"));
  const cf = await startFakeCloudflare(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  // the same fakes the update test uses: a `claude` that is signed in, and an `npx` that records wrangler calls
  const { makeFakes } = await import("../helpers/computer.mjs");
  makeFakes(bin);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, npm_config_prefix: join(home, "npm"),
    CLAUDECONNECT_RAW: github.url, CLAUDECONNECT_CF_API: cf.url, CLAUDECONNECT_RETRY_MS: "50",
    // there's no real site here for the agent to connect to
    CLAUDECONNECT_CONNECT_MS: "500"
  };
  const dir = join(home, ".claudeconnect");
  t.after(async () => {
    try {
      process.kill(Number(readFileSync(join(dir, "agent.pid"), "utf8")), "SIGKILL");
    } catch {}
    await github.close();
    await cf.close();
    rmSync(home, { recursive: true, force: true });
  });

  // ---- first install
  const first = await runLauncher(home, env, ["--name", "My Site", "--no-autostart", "--no-fable"]);
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, new RegExp(`Downloading ${RELEASE.version}`));
  assert.match(first.out, /claim=/);

  for (const f of ["agent.mjs", "installer.mjs", "ClaudeConnect.mjs", "manifest.json", "package.json", "config.json"]) assert.ok(existsSync(join(dir, f)), f);
  assert.equal(sha(join(dir, "agent.mjs")), RELEASE.files["agent/agent.mjs"]);
  assert.equal(sha(join(dir, "ClaudeConnect.mjs")), RELEASE.files["ClaudeConnect.mjs"]);
  for (const f of ["worker.js", "app.html", "version.js", "names.js", "image.js"]) assert.equal(sha(join(dir, "site", f)), RELEASE.files["site/" + f], f);
  assert.equal(readFileSync(join(dir, "site", "brand.js"), "utf8"), 'export default {"logo":null,"favicon":null};\n');
  assert.ok(!existsSync(join(dir, "stage")), "the download folder is cleaned up");

  const wr = JSON.parse(readFileSync(join(dir, "site", "wrangler.jsonc"), "utf8"));
  assert.equal(wr.name, "my-site");
  assert.equal(wr.account_id, "acct-1");
  assert.equal(wr.kv_namespaces[0].id, "kv-new");
  assert.deepEqual(wr.vars, { SITE_NAME: "My Site", COMMAND: "MySite", SHOW_FABLE: "0", APP_VERSION: RELEASE.version, UPDATE_REPO: "ThatOneWeirdDev/claudeconnect", UPDATE_REF: "main", WORKER_NAME: "my-site" });

  const cfg1 = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(cfg1.site, "https://my-site.testacct.workers.dev");
  assert.equal(cfg1.command, "MySite");
  assert.equal(cfg1.version, RELEASE.version);
  assert.equal(cfg1.repo, "ThatOneWeirdDev/claudeconnect");
  assert.equal(cfg1.ref, "main");
  assert.equal(cfg1.kvId, "kv-new");
  assert.ok(cfg1.secret.length >= 32);
  assert.equal(statSync(join(dir, "config.json")).mode & 0o077, 0, "the config is private to the user");
  assert.ok(existsSync(cfg1.shim));
  assert.match(readFileSync(cfg1.shim, "utf8"), /agent\.mjs/);

  const secrets1 = readdirSync(home).filter(f => /^secrets-.*\.json$/.test(f)).sort().map(f => JSON.parse(readFileSync(join(home, f), "utf8")));
  assert.equal(secrets1.length, 1);
  assert.equal(secrets1[0].AGENT_SECRET, cfg1.secret);
  assert.ok(secrets1[0].CLAIM_CODE);
  assert.equal(readdirSync(join(home, "deploys")).length, 1);

  // the agent was started and logged that it is running
  await new Promise(r => setTimeout(r, 1500));
  assert.match(readFileSync(join(dir, "agent.log"), "utf8"), new RegExp(`My Site ${RELEASE.version} starting`));
  const firstPid = Number(readFileSync(join(dir, "agent.pid"), "utf8"));

  // ---- the site now exists; --update (what `<command> update` runs) updates it in place and asks nothing
  cf.siteExists(true);
  const second = await runLauncher(home, env, ["--update"]);
  assert.equal(second.status, 0, second.out);
  assert.match(second.out, new RegExp(`Updating My Site to ${RELEASE.version.replace(/\./g, "\\.")}`));
  assert.match(second.out, /Updating the site[\s\S]*Updating this computer[\s\S]*Restarting[\s\S]*Coming back online/);
  assert.doesNotMatch(second.out, /already set up|Name|Logo|Fable|Which account/, "none of the setup questions");
  assert.equal(readdirSync(join(home, "deploys")).length, 2);
  const cfg2 = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(cfg2.secret, cfg1.secret, "the agent's key survives an update");
  assert.ok(cfg2.id, "the agent keeps its identity");
  assert.equal(cfg2.kvId, "kv-new");
  assert.equal(cfg2.site, cfg1.site);
  assert.equal(cfg2.version, RELEASE.version);
  assert.equal(cf.created.length, 1, "no second storage namespace was made");
  assert.equal(cf.deleted.length, 0, "nothing was deleted");
  assert.equal(readdirSync(home).filter(f => /^secrets-.*\.json$/.test(f)).length, 1, "the site's secrets are left as they are");
  const wr2 = JSON.parse(readFileSync(join(dir, "site", "wrangler.jsonc"), "utf8"));
  assert.deepEqual(wr2.vars, wr.vars, "same name, command and settings");
  // the agent was restarted: the old process is gone and a new one has taken its place
  let pid = 0;
  for (let i = 0; i < 40 && !pid; i++) {
    await new Promise(r => setTimeout(r, 150));
    try {
      const p = Number(readFileSync(join(dir, "agent.pid"), "utf8"));
      if (running(p) && p !== firstPid) pid = p;
    } catch {}
  }
  assert.ok(pid > 0, "a new agent is running");
  assert.equal(running(firstPid), false, "the old agent is gone");
});

test("the one-line install script sets everything up, and tells you if Node is too old or missing", async t => {
  const github = await startRepo(ROOT);
  const home = mkdtempSync(join(tmpdir(), "cc-onelinesh-"));
  const cf = await startFakeCloudflare(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  const { makeFakes } = await import("../helpers/computer.mjs");
  makeFakes(bin);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, npm_config_prefix: join(home, "npm"), CLAUDECONNECT_RAW: github.url, CLAUDECONNECT_CF_API: cf.url, CLAUDECONNECT_RETRY_MS: "50" };
  const dir = join(home, ".claudeconnect");
  t.after(async () => {
    try {
      process.kill(Number(readFileSync(join(dir, "agent.pid"), "utf8")), "SIGKILL");
    } catch {}
    await github.close();
    await cf.close();
    rmSync(home, { recursive: true, force: true });
  });
  const sh = (args, e = env) =>
    new Promise(resolve => {
      const child = spawn("/bin/sh", [join(ROOT, "install.sh"), ...args], { env: e, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", d => (out += d));
      child.stderr.on("data", d => (out += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120000);
      child.on("close", status => {
        clearTimeout(timer);
        resolve({ status, out });
      });
    });

  const ok = await sh(["--name", "Script Site", "--no-autostart", "--no-fable"]);
  assert.equal(ok.status, 0, ok.out);
  assert.match(ok.out, new RegExp(`Downloading ${RELEASE.version}`));
  const cfg = JSON.parse(readFileSync(join(dir, "config.json"), "utf8"));
  assert.equal(cfg.displayName, "Script Site");
  assert.equal(sha(join(dir, "agent.mjs")), RELEASE.files["agent/agent.mjs"]);
  assert.ok(existsSync(join(dir, "ClaudeConnect.mjs")), "a copy of the launcher stays for updates");
  // no Node at all
  const noNode = await sh([], { ...env, PATH: join(home, "nonexistent") });
  assert.equal(noNode.status, 1);
  assert.match(noNode.out, /needs Node\.js 22 or newer, and it isn't installed/);
  // a Node that is too old
  const old = join(home, "oldbin");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "node"), '#!/bin/sh\nif [ "$1" = "-p" ]; then echo 20; else echo v20.11.0; fi\n');
  chmodSync(join(old, "node"), 0o755);
  const tooOld = await sh([], { ...env, PATH: `${old}:/usr/bin:/bin` });
  assert.equal(tooOld.status, 1);
  assert.match(tooOld.out, /needs Node\.js 22 or newer, and you have v20\.11\.0/);
  // GitHub unreachable
  const down = await sh([], { ...env, CLAUDECONNECT_RAW: "http://127.0.0.1:9" });
  assert.equal(down.status, 1);
  assert.match(down.out, /Couldn't download http:\/\/127\.0\.0\.1:9/);
});

test("npx works: the package's bin runs the launcher", async t => {
  const home = mkdtempSync(join(tmpdir(), "cc-npx-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const run = (cmd, args, env = {}) =>
    new Promise(resolve => {
      const child = spawn(cmd, args, { cwd: home, env: { ...process.env, HOME: home, ...env } });
      let out = "";
      child.stdout.on("data", d => (out += d));
      child.stderr.on("data", d => (out += d));
      child.on("close", status => resolve({ status, out }));
    });
  const packed = await run("npm", ["pack", ROOT, "--pack-destination", home, "--silent"]);
  assert.equal(packed.status, 0, packed.out);
  const tgz = join(home, packed.out.trim().split("\n").pop());
  const prefix = join(home, "prefix");
  const installed = await run("npm", ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--silent", tgz]);
  assert.equal(installed.status, 0, installed.out);
  const link = join(prefix, "node_modules", ".bin", "claudeconnect");
  assert.ok(existsSync(link), "the claudeconnect command exists");
  // run it with GitHub unreachable: it must start, and fail the way the launcher does, not with a missing-file error
  const ran = await run(link, [], { CLAUDECONNECT_RAW: "http://127.0.0.1:9", CLAUDECONNECT_RETRY_MS: "20" });
  assert.equal(ran.status, 1);
  assert.match(ran.out, /couldn't reach 127\.0\.0\.1/);
});
