// Settings, moving to a new address, and deleting, with real processes: the real site (workerd), agent and installer.
// Only the outside world is faked: `claude`, `wrangler` and Cloudflare's API.
import { test } from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startSite } from "../helpers/site.mjs";
import { startRepo } from "../helpers/github.mjs";
import { startFakeCloudflare } from "../helpers/cloudflare.mjs";
import { makeComputer, ROOT } from "../helpers/computer.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");

async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  let last;
  while (Date.now() < end) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e;
    }
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}${last instanceof Error ? ": " + last.message : ""}`);
}

const freePort = () =>
  new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });

async function boot(t, { scripts = ["test-site"], kvs = [{ id: "kv-123", title: "test-site-signin" }], env = {} } = {}) {
  const github = await startRepo(ROOT);
  const cf = await startFakeCloudflare(null, { scripts, kvs });
  const site = await startSite({ appVersion: "1.3.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: github.url, oldVersion: "1.3.0" });
  Object.assign(pc.env, { CLAUDECONNECT_CF_API: cf.url, ...env });
  // what the installer saves when it is told to use another Cloudflare API address
  writeFileSync(join(pc.dir, "config.json"), JSON.stringify({ ...pc.config, api: cf.url }, null, 2));
  const agent = pc.startAgent();
  const extra = [];
  t.after(async () => {
    agent.kill("SIGKILL");
    for (const e of extra) await e().catch(() => {});
    pc.cleanup();
    await site.stop();
    await cf.close();
    await github.close();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  const finished = async (what, ms = 90000) =>
    until(async () => {
      const r = (await site.api("/api/update")).body.run;
      return r && r.state !== "running" ? r : null;
    }, what, ms);
  return { github, cf, site, pc, finished, onCleanup: fn => extra.push(fn) };
}

const cfgOf = pc => JSON.parse(pc.read("config.json"));

test("changing settings from the site redeploys in place, restarts the agent and keeps the address", async t => {
  const { site, pc, cf, finished } = await boot(t);
  const oldPid = pc.pid();
  const r = await site.post("/api/admin/settings", { displayName: "Renamed", aiName: "Buddy", fable: true, logo: { b64: PNG } });
  assert.equal(r.status, 200, r.text);
  const run = await finished("the settings change to finish");
  assert.equal(run.state, "done", `${run.state}: ${run.message}\n${pc.updateLog()}`);
  assert.deepEqual(run.plan.map(x => x.key), ["site", "computer", "restart", "online"]);
  assert.ok(Object.values(run.steps).every(v => v === "done"));

  const deploys = pc.deploys();
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].name, "test-site", "same Worker, same address");
  assert.equal(deploys[0].account_id, "acct-123");
  assert.equal(deploys[0].kv_namespaces[0].id, "kv-123");
  assert.deepEqual(deploys[0].vars, { SITE_NAME: "Renamed", AI_NAME: "Buddy", COMMAND: "TestConnect", SHOW_FABLE: "1", APP_VERSION: "1.3.0", UPDATE_REPO: "ThatOneWeirdDev/claudeconnect", UPDATE_REF: "main", WORKER_NAME: "test-site" });
  assert.deepEqual(cf.deleted, [], "nothing was deleted");
  assert.equal(cf.created.length, 0, "no new site");
  assert.match(pc.read("site/brand.js"), new RegExp(PNG.slice(0, 40)));
  assert.match(pc.read("site/brand.js"), /"image\/png"/);

  const cfg = cfgOf(pc);
  assert.deepEqual([cfg.displayName, cfg.aiName, cfg.fable, cfg.command, cfg.name, cfg.site], ["Renamed", "Buddy", true, "TestConnect", "test-site", pc.config.site]);
  assert.notEqual(pc.pid(), oldPid);
  assert.equal(pc.alive(oldPid), false);
  assert.equal((await site.api("/api/state")).body.agent.online, true);
  assert.ok(!existsSync(join(pc.dir, "job-" + run.id + ".json")), "the job file (it can hold a logo) is removed");
  assert.deepEqual(readdirSync(pc.dir).filter(f => f.startsWith("job-")), []);
});

test("putting the built-in logo back keeps the other image", async t => {
  const { site, pc, finished } = await boot(t);
  await site.post("/api/admin/settings", { logo: { b64: PNG }, favicon: { b64: PNG } });
  assert.equal((await finished("the first change")).state, "done");
  await site.post("/api/update/dismiss");
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to come back");
  await site.post("/api/admin/settings", { logo: null });
  assert.equal((await finished("the second change")).state, "done");
  const brand = JSON.parse(pc.read("site/brand.js").replace(/^export default /, "").replace(/;\s*$/, ""));
  assert.equal(brand.logo, null);
  assert.equal(brand.favicon.type, "image/png");
});

test("a deploy that Cloudflare refuses leaves the computer as it was, and says so", async t => {
  const { site, pc, finished } = await boot(t);
  const before = cfgOf(pc);
  const oldPid = pc.pid();
  pc.failDeploys(true);
  await site.post("/api/admin/settings", { aiName: "Buddy" });
  const run = await finished("the change to fail");
  assert.equal(run.state, "error");
  assert.equal(run.step, "site");
  assert.match(run.message, /Cloudflare didn't accept the changes/);
  assert.deepEqual(cfgOf(pc), before, "the saved settings didn't change");
  assert.equal(pc.pid(), oldPid, "the agent was never stopped");
  assert.equal(pc.alive(oldPid), true);
});

test("moving to a new address: the old site stays until the new one is claimed, then it is deleted", async t => {
  const newPort = await freePort();
  const newOrigin = `http://127.0.0.1:${newPort}`;
  const { site, pc, cf, finished, onCleanup } = await boot(t, { env: { CLAUDECONNECT_SITE_ORIGIN: newOrigin } });
  const oldPid = pc.pid();
  const oldConfig = cfgOf(pc);
  assert.equal((await site.post("/api/admin/move", { address: "new-site" })).status, 200);

  // step 1-2: the new site is created, and the page is handed the links it needs while it waits for Access
  const waiting = await until(async () => {
    const r = (await site.api("/api/update")).body.run;
    return r && r.step === "access" && r.info ? r : null;
  }, "the move to reach the Access step");
  assert.equal(waiting.state, "running");
  assert.deepEqual([waiting.steps.prepare, waiting.steps.create], ["done", "done"]);
  assert.equal(waiting.info.site, newOrigin);
  assert.match(waiting.info.claim, new RegExp(`^${newOrigin}/\\?claim=[A-Za-z0-9_-]{20,}$`));
  assert.match(waiting.info.dash, /dash\.cloudflare\.com\/acct-123\/workers\/services\/view\/new-site\//);
  assert.equal(waiting.info.name, "new-site");
  assert.deepEqual(cf.created.map(c => c.title), ["new-site-signin"]);
  const deploys = pc.deploys();
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].name, "new-site");
  assert.equal(deploys[0].kv_namespaces[0].id, "kv-new");
  assert.equal(deploys[0].vars.WORKER_NAME, "new-site");
  assert.equal(deploys[0].vars.SITE_NAME, "Test Site");

  // nothing about the old site has been touched yet, and the computer is still using it
  assert.deepEqual(cf.deleted, []);
  assert.equal(pc.pid(), oldPid);
  assert.equal(cfgOf(pc).site, oldConfig.site);
  assert.equal((await site.api("/api/state")).body.agent.online, true);
  await sleep(1500);
  assert.equal((await site.api("/api/update")).body.run.state, "running", "still waiting, with no new sign-in yet");
  assert.deepEqual(cf.deleted, []);

  // the owner turns Access on for the new address and claims it
  const secrets = JSON.parse(readFileSync(join(pc.home, readdirSync(pc.home).find(f => /^secrets-.*\.json$/.test(f))), "utf8"));
  assert.ok(secrets.AGENT_SECRET && secrets.CLAIM_CODE);
  assert.ok(waiting.info.claim.endsWith(secrets.CLAIM_CODE));
  const fresh = await startSite({ port: newPort, appVersion: "1.3.0", vars: { AGENT_SECRET: secrets.AGENT_SECRET, CLAIM_CODE: secrets.CLAIM_CODE } });
  onCleanup(() => fresh.stop());
  assert.equal((await fresh.claim()).status, 302);
  cf.setKvValue("kv-new", "agent-token", { token: fresh.jwt, exp: Math.floor(Date.now() / 1000) + 86400 });

  // the computer moves over, and only then is the old site deleted
  await until(() => cf.deleted.length >= 2, "the old site to be deleted", 90000);
  assert.deepEqual(cf.deleted.sort(), ["/accounts/acct-123/storage/kv/namespaces/kv-123", "/accounts/acct-123/workers/scripts/test-site"], "the old worker and its storage, and nothing else");
  const cfg = cfgOf(pc);
  assert.deepEqual([cfg.name, cfg.site, cfg.kvId, cfg.secret, cfg.token], ["new-site", newOrigin, "kv-new", secrets.AGENT_SECRET, fresh.jwt]);
  assert.equal(cfg.command, "TestConnect");
  assert.equal(cfg.displayName, "Test Site");
  assert.equal(JSON.parse(pc.read("site/wrangler.jsonc")).name, "new-site");
  assert.ok(!existsSync(join(pc.dir, "site-next")) && !existsSync(join(pc.dir, "site-old")), "no leftovers");

  const newState = await until(async () => {
    const st = (await fresh.api("/api/state")).body;
    return st.agent && st.agent.online ? st : null;
  }, "the computer to appear on the new site");
  assert.equal(newState.agent.version, "1.3.0");
  assert.notEqual(pc.pid(), oldPid);
  assert.equal(pc.alive(oldPid), false);

  const old = (await site.api("/api/update")).body.run;
  assert.deepEqual([old.steps.prepare, old.steps.create, old.steps.access, old.steps.switch], ["done", "done", "done", "done"]);
  assert.equal(old.step, "cleanup");
});

test("cancelling a move puts everything back: the new site is removed and the old one is untouched", async t => {
  const { site, pc, cf, finished } = await boot(t);
  const oldPid = pc.pid();
  const before = cfgOf(pc);
  const siteFiles = readdirSync(join(pc.dir, "site")).sort();
  await site.post("/api/admin/move", { address: "never-mind" });
  await until(async () => {
    const r = (await site.api("/api/update")).body.run;
    return r && r.step === "access" && r.info;
  }, "the move to wait for Access");
  assert.equal(cf.created.length, 1);
  assert.equal((await site.post("/api/admin/cancel")).status, 200);
  const run = await finished("the cancel to take effect", 30000);
  assert.equal(run.state, "error");
  assert.equal(run.step, "access");
  assert.match(run.message, /Cancelled/);
  // the new worker and its storage are gone again; the old ones were never touched
  assert.deepEqual(cf.deleted.sort(), ["/accounts/acct-123/storage/kv/namespaces/kv-new", "/accounts/acct-123/workers/scripts/never-mind"]);
  assert.ok(cf.scripts.has("test-site") && cf.kvs.has("kv-123"));
  assert.deepEqual(cfgOf(pc), before);
  assert.equal(pc.pid(), oldPid);
  assert.equal(pc.alive(oldPid), true);
  assert.deepEqual(readdirSync(join(pc.dir, "site")).sort(), siteFiles);
  assert.ok(!existsSync(join(pc.dir, "site-next")));
  assert.equal((await site.api("/api/state")).body.agent.online, true);
});

test("moving to an address that is taken fails at the first step and never deletes the other worker", async t => {
  const { site, pc, cf, finished } = await boot(t, { scripts: ["test-site", "taken"] });
  await site.post("/api/admin/move", { address: "taken" });
  const run = await finished("the move to fail", 30000);
  assert.equal(run.state, "error");
  assert.equal(run.step, "prepare");
  assert.match(run.message, /already a worker called taken/);
  assert.deepEqual(cf.deleted, [], "somebody else's worker is not ours to delete");
  assert.deepEqual(cf.created, []);
  assert.equal(pc.deploys().length, 0);
  assert.ok(cf.scripts.has("taken") && cf.scripts.has("test-site"));
});

test("deleting from the site removes the site and its storage, then this computer's setup, but not the workspace", async t => {
  const { site, pc, cf } = await boot(t);
  const oldPid = pc.pid();
  const shim = cfgOf(pc).shim;
  assert.ok(existsSync(shim));
  assert.equal((await site.post("/api/admin/delete", { confirm: "Test Site" })).status, 200);
  await until(() => !existsSync(join(pc.dir, "config.json")), "the setup to be removed from this computer", 90000);
  assert.deepEqual(cf.deleted.sort(), ["/accounts/acct-123/storage/kv/namespaces/kv-123", "/accounts/acct-123/workers/scripts/test-site"]);
  assert.equal(cf.scripts.has("test-site"), false);
  assert.equal(pc.alive(oldPid), false, "the agent stopped");
  assert.ok(!existsSync(shim), "the command is gone");
  assert.ok(existsSync(join(pc.home, "ws")), "the folder Claude works in is kept");
});

test("a delete that Cloudflare refuses changes nothing on this computer, and says why", async t => {
  const { site, pc, cf, finished } = await boot(t);
  const oldPid = pc.pid();
  const shim = cfgOf(pc).shim;
  cf.refuseDeletes(true);
  assert.equal((await site.post("/api/admin/delete", { confirm: "Test Site" })).status, 200);
  const run = await finished("the delete to fail", 30000);
  assert.equal(run.state, "error");
  assert.equal(run.step, "site");
  assert.match(run.message, /Cloudflare wouldn't delete the site/);
  assert.ok(existsSync(join(pc.dir, "config.json")), "this computer is still set up");
  assert.ok(existsSync(shim));
  assert.equal(pc.pid(), oldPid);
  assert.equal(pc.alive(oldPid), true, "the agent is still running");
  assert.ok(cf.scripts.has("test-site") && cf.kvs.has("kv-123"));
});

// Async on purpose: the fake Cloudflare lives in this process, so a blocking spawn would starve it.
const run = (pc, args) =>
  new Promise(resolve => {
    const child = spawn(process.execPath, [join(pc.dir, "agent.mjs"), ...args], { env: pc.env });
    let out = "";
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (out += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", status => {
      clearTimeout(timer);
      resolve({ status, out });
    });
  });

test("claim prints a fresh claim link and sets it on the worker", async t => {
  const { pc, cf } = await boot(t);
  const r = await run(pc, ["claim"]);
  assert.equal(r.status, 0, r.out);
  const m = /(http:\/\/127\.0\.0\.1:\d+)\/\?claim=([A-Za-z0-9_-]+)/.exec(r.out);
  assert.ok(m, r.out);
  assert.equal(m[1], pc.config.site);
  assert.equal(cf.secrets.length, 1);
  assert.deepEqual([cf.secrets[0].script, cf.secrets[0].name, cf.secrets[0].type, cf.secrets[0].text], ["test-site", "CLAIM_CODE", "secret_text", m[2]]);
  const second = await run(pc, ["claim"]);
  assert.notEqual(/claim=([A-Za-z0-9_-]+)/.exec(second.out)[1], m[2], "every link is new");
});
