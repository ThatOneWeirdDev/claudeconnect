// The whole update, with real processes: the real site (workerd), agent, loader and installer.
// Only the outside world is faked: `claude` answers instantly, `npx wrangler` records deploys, and GitHub is a local server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import crypto from "node:crypto";
import { startSite } from "../helpers/site.mjs";
import { startRepo } from "../helpers/github.mjs";
import { makeComputer, ROOT } from "../helpers/computer.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const sha = p => crypto.createHash("sha256").update(readFileSync(p)).digest("hex");
const RELEASE = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

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

async function boot(t) {
  const github = await startRepo(ROOT);
  const site = await startSite({ appVersion: "1.1.5", release: RELEASE });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: github.url });
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
    await github.close();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  const chat = async text => {
    const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text, model: "claude-opus-5-5" }) });
    const lines = (await res.text()).trim().split("\n").map(l => JSON.parse(l));
    return lines.find(l => l.type === "done");
  };
  return { site, pc, github, agent, chat };
}

test("a real agent reports the plan percentages Claude Code gives it, and the site serves them", async t => {
  const { site, chat } = await boot(t);
  assert.equal((await site.api("/api/state")).body.limits, null, "nothing is shown before there is a real reading");
  const done = await chat("first message");
  assert.match(done.message.content, /You said: first message/);
  const l = await until(async () => (await site.api("/api/state")).body.limits, "the plan usage to arrive");
  assert.equal(l.windows.five_hour.pct, 42);
  assert.equal(l.windows.seven_day.pct, 17);
  assert.equal(l.windows.five_hour.reset, false);
  assert.ok(l.windows.five_hour.resetsAt > Date.now() / 1000);
  assert.equal(l.status, "allowed");
});

test("updating from the site: the site stays up, progress is shown, the computer is updated and restarted", async t => {
  const { site, pc, chat } = await boot(t);
  const state0 = (await site.api("/api/state")).body;
  assert.equal(state0.agent.version, "1.1.5");
  assert.equal(state0.update.available, true);
  assert.equal(state0.update.blocked, null);
  await chat("before the update");
  const oldPid = pc.pid();
  assert.ok(oldPid > 0 && pc.alive(oldPid));

  // click Update
  const started = await site.post("/api/update/start", { to: RELEASE.version });
  assert.equal(started.status, 200, started.text);

  // The page polls /api/update the whole time. The site must answer every poll while the computer updates itself.
  const seen = new Set();
  let polls = 0;
  const run = await until(async () => {
    const r = await site.api("/api/update");
    polls++;
    assert.equal(r.status, 200, "the site went away during the update");
    if (r.body.run.step) seen.add(r.body.run.step);
    return r.body.run.state !== "running" ? r.body.run : null;
  }, "the update to finish", 90000);
  assert.equal(run.state, "done", `update ended as ${run.state}: ${run.message}\n--- update.log ---\n${pc.updateLog()}`);
  assert.deepEqual(Object.values(run.steps), ["done", "done", "done", "done", "done", "done"]);
  assert.ok(polls > 3);

  // the site step: a deploy happened with the new version and the same identity
  const deploys = pc.deploys();
  assert.equal(deploys.length, 1);
  const d = deploys[0];
  assert.equal(d.name, "test-site");
  assert.equal(d.account_id, "acct-123");
  assert.equal(d.kv_namespaces[0].id, "kv-123");
  assert.equal(d.vars.APP_VERSION, RELEASE.version);
  assert.equal(d.vars.UPDATE_REPO, "ThatOneWeirdDev/claudeconnect");
  assert.equal(d.vars.UPDATE_REF, "main");
  assert.equal(d.vars.SITE_NAME, "Test Site");
  assert.equal(d.vars.AI_NAME, undefined, "there is no AI name any more");
  assert.equal(d.vars.COMMAND, "TestConnect");
  assert.equal(d.vars.SHOW_FABLE, "0");
  assert.match(pc.npxLog(), /auth token/);

  // the computer step: new files in place, matching the release
  assert.equal(sha(join(pc.dir, "agent.mjs")), RELEASE.files["agent/agent.mjs"]);
  assert.equal(sha(join(pc.dir, "ClaudeConnect.mjs")), RELEASE.files["ClaudeConnect.mjs"]);
  assert.equal(sha(join(pc.dir, "installer.mjs")), RELEASE.files["installer.mjs"]);
  assert.equal(sha(join(pc.dir, "site", "worker.js")), RELEASE.files["site/worker.js"]);
  assert.equal(sha(join(pc.dir, "site", "names.js")), RELEASE.files["site/names.js"]);
  assert.equal(sha(join(pc.dir, "site", "image.js")), RELEASE.files["site/image.js"]);
  assert.equal(JSON.parse(pc.read("manifest.json")).version, RELEASE.version);
  const cfg = JSON.parse(pc.read("config.json"));
  assert.equal(cfg.version, RELEASE.version);
  assert.equal(cfg.secret, pc.config.secret, "the agent's key is unchanged");
  assert.equal(cfg.site, pc.config.site);
  assert.equal(cfg.token, pc.config.token);
  assert.equal(cfg.command, "TestConnect");
  assert.equal(pc.read("site/brand.js"), 'export default {"logo":null,"favicon":null};\n', "the logo and icon are left alone");

  // the restart: a different process, running the new version, connected to the site
  const newPid = pc.pid();
  assert.notEqual(newPid, oldPid);
  assert.equal(pc.alive(oldPid), false, "the old agent is gone");
  assert.equal(pc.alive(newPid), true, "the new agent is running");
  const state = (await site.api("/api/state")).body;
  assert.equal(state.agent.online, true);
  assert.equal(state.agent.version, RELEASE.version);
  await until(() => pc.log().includes("Connected."), "the new agent to log that it connected", 10000);

  // and it still answers
  const after = await chat("after the update");
  assert.match(after.message.content, /You said: after the update/);
});

test("if the site can't be deployed, nothing on the computer is touched and the page says why", async t => {
  const { site, pc, chat } = await boot(t);
  const before = sha(join(pc.dir, "agent.mjs"));
  const oldPid = pc.pid();
  pc.failDeploys(true);

  assert.equal((await site.post("/api/update/start", { to: RELEASE.version })).status, 200);
  const run = await until(async () => {
    const r = (await site.api("/api/update")).body.run;
    return r.state !== "running" ? r : null;
  }, "the update to fail", 90000);
  assert.equal(run.state, "error");
  assert.equal(run.step, "site");
  assert.equal(run.steps.site, "error");
  assert.match(run.message, /Cloudflare didn't accept the new version/);
  assert.match(run.message, /TestConnect update/);

  // the running agent was never stopped, its files and version are as they were
  assert.equal(pc.pid(), oldPid);
  assert.equal(pc.alive(oldPid), true);
  assert.equal(sha(join(pc.dir, "agent.mjs")), before);
  assert.equal(JSON.parse(pc.read("manifest.json")).version, "1.1.5");
  assert.equal(JSON.parse(pc.read("config.json")).version, "1.1.5");
  const state = (await site.api("/api/state")).body;
  assert.equal(state.agent.online, true);
  assert.equal(state.agent.version, "1.1.5");
  assert.match((await chat("still works")).message.content, /You said/);

  // fix the problem, try again from the page
  pc.failDeploys(false);
  await site.post("/api/update/dismiss");
  assert.equal((await site.post("/api/update/start", { to: RELEASE.version })).status, 200);
  const retry = await until(async () => {
    const r = (await site.api("/api/update")).body.run;
    return r.state !== "running" ? r : null;
  }, "the retry to finish", 90000);
  assert.equal(retry.state, "done", retry.message + pc.updateLog());
  assert.equal((await site.api("/api/state")).body.agent.version, RELEASE.version);
});

test("the agent refuses to start an update while it is answering", async t => {
  const { site, pc } = await boot(t);
  // Hold a run open by pointing the agent at a claude that never finishes.
  const { writeFileSync, chmodSync } = await import("node:fs");
  writeFileSync(join(pc.home, "bin", "claude"), `#!/usr/bin/env node\nconst a = process.argv.slice(2);\nif (a[0] === "--version") { console.log("2.1.300"); process.exit(0); }\nif (a[0] === "auth") { console.log('{"authMethod":"claude.ai"}'); process.exit(0); }\nsetTimeout(() => {}, 60000);\n`);
  chmodSync(join(pc.home, "bin", "claude"), 0o755);
  site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "slow one", model: "claude-opus-5-5" }) }).catch(() => {});
  await until(async () => (await site.api("/api/update")).body.blocked?.code === "busy", "the site to see the run");
  assert.equal((await site.post("/api/update/start", { to: RELEASE.version })).status, 409);
  assert.equal(pc.deploys().length, 0);
});
