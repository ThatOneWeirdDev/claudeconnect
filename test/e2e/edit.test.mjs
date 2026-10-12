// `<command> edit`, answered in a real terminal: every setting with a y/n, a summary, then the same in-place redeploy the
// site's Settings do, the site's own settings kept on the site, and deleting the site. Linux only (it uses `script` for the
// terminal), which is where the tests run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import net from "node:net";
import { join } from "node:path";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";
import { startFakeCloudflare } from "../helpers/cloudflare.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasScript = spawnSync("script", ["--version"]).status === 0;

// Runs a command in a terminal and answers each question when it's asked: [pattern, answer] pairs, in order. `output()` is
// what it has printed so far, and `done` what it ended with.
function run(cmd, env, answers, ms = 60000) {
  const child = spawn("script", ["-qfec", cmd, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let next = 0;
  const onData = d => {
    out += d;
    while (next < answers.length && answers[next][0].test(out.slice(answers[next].from || 0))) {
      const [, answer] = answers[next];
      answers[next + 1] && (answers[next + 1].from = out.length);
      child.stdin.write(answer + "\r");
      next++;
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  const timer = setTimeout(() => child.kill("SIGKILL"), ms);
  const done = new Promise(resolve =>
    child.on("close", status => {
      clearTimeout(timer);
      resolve({ status, out, asked: next });
    })
  );
  return { child, done, output: () => out };
}
const converse = (...a) => run(...a).done;

async function until(fn, what, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return;
    await sleep(150);
  }
  throw new Error(`timed out waiting for ${what}`);
}

// A free port, held until it's needed, so another test running alongside can't take it in the meantime.
const reservePort = () =>
  new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => resolve({ port: srv.address().port, release: () => new Promise(r => srv.close(r)) }));
  });

// Everything up to the address question, left as it is.
const KEEP = () => [[/Change the name\?/, ""], [/logo/, ""], [/tab icon/, ""], [/theme/, ""], [/log in/, ""], [/usage credit balance/, ""], [/the site lists/, ""], [/working folder,/, ""], [/usage credits from the site/, ""]];

// A site, a computer using it, and a stand-in for Cloudflare's API, for the address and delete.
async function withCloudflare(t, env = {}) {
  const cf = await startFakeCloudflare(null, { scripts: ["test-site"], kvs: [{ id: "kv-123", title: "test-site-signin" }] });
  const site = await startSite({ appVersion: "1.12.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9", oldVersion: "1.12.0" });
  Object.assign(pc.env, { CLAUDECONNECT_CF_API: cf.url, ...env });
  writeFileSync(join(pc.dir, "config.json"), JSON.stringify({ ...pc.config, api: cf.url }, null, 2));
  const agent = pc.startAgent();
  const extra = [];
  t.after(async () => {
    agent.kill("SIGKILL");
    for (const e of extra) await e().catch(() => {});
    pc.cleanup();
    await site.stop();
    await cf.close();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  return { cf, site, pc, onCleanup: fn => extra.push(fn), cmd: `"${process.execPath}" "${join(pc.dir, "agent.mjs")}" edit` };
}

test("edit asks about every setting the site's Settings has, shows what will change, and saves it in place", { skip: !hasScript && "needs `script`" }, async t => {
  const site = await startSite({ appVersion: "1.12.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9", oldVersion: "1.12.0" });
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  for (let i = 0; i < 100 && !(await site.api("/api/state")).body.agent.online; i++) await sleep(150);
  await site.post("/api/prefs", { theme: "dark" });
  const cmd = `"${process.execPath}" "${join(pc.dir, "agent.mjs")}" edit`;
  const r = await converse(cmd, pc.env, [
    [/Change the name\? Now: Test Site\. \[y\/N\]/, "y"],
    [/New name:/, "Better Site"],
    [/Change the logo\? Now: the built-in one\. \[y\/N\]/, ""],
    [/Change the tab icon\? Now: the logo\. \[y\/N\]/, "n"],
    [/Change the theme\? Now: Dark\. \[y\/N\]/, "y"],
    [/System, light or dark\?/, "purple"],
    [/Type system, light or dark\.[\s\S]*System, light or dark\?/, "light"],
    [/when you log in to this computer\?/, ""],
    [/Stop showing your usage credit balance on the site\? It's shown now/, "y"],
    [/Change which of Claude Code's chats from this computer the site lists\? Now: all of them\. \[y\/N\]/, "y"],
    [/All, folder \(only the working folder's\) or none\?/, "folder"],
    [/Change the working folder, where Claude Code works and files you attach go\? Now: ~\/ws\. \[y\/N\]/, "y"],
    [/New folder \(a full path, like ~\/Projects\):/, "relative/path"],
    [/Use a full path[\s\S]*New folder/, "~/projects"],
    [/Stop using usage credits from the site\? They're used now\./, "y"],
    [/Change the address\? Now: http\S+\. You'd get a new link/, ""],
    [/Delete Test Site\? This removes the site and every chat in it/, ""],
    [/name: Better Site[\s\S]*theme: Light[\s\S]*usage credit balance: not shown[\s\S]*Claude Code chats on the site: only the ones from the working folder[\s\S]*working folder: ~\/projects[\s\S]*usage credits from the site: not used[\s\S]*Save these changes\? \[Y\/n\]/, ""]
  ]);
  assert.equal(r.asked, 18, r.out);
  assert.equal(r.status, 0, r.out);
  assert.doesNotMatch(r.out, /Fable 5\.1 in the model picker/, "Fable 5.1 is always in the model picker, so there's nothing to ask");
  assert.match(r.out, /Restarting[\s\S]*Updating the site[\s\S]*Restarting[\s\S]*Saved\./);
  const deploys = pc.deploys();
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].vars.SITE_NAME, "Better Site");
  assert.equal(deploys[0].vars.SHOW_FABLE, undefined);
  assert.equal(deploys[0].vars.COMMAND, "TestConnect", "the command stays the same");
  const cfg = JSON.parse(readFileSync(join(pc.dir, "config.json"), "utf8"));
  assert.deepEqual([cfg.displayName, cfg.credits, cfg.history, cfg.workspace, cfg.fable], ["Better Site", false, "workspace", join(pc.home, "projects"), undefined]);
  assert.ok(existsSync(join(pc.home, "projects", "uploads")), "the new working folder is made");
  // the theme and usage credits are kept on the site, for every device
  const prefs = (await site.api("/api/state")).body.prefs;
  assert.deepEqual([prefs.theme, prefs.useCredits], ["light", false]);
  for (let i = 0; i < 100 && !(await site.api("/api/state")).body.agent.online; i++) await sleep(150);
  const computer = (await site.api("/api/state")).body.agent.computer;
  assert.deepEqual([computer.credits, computer.history, computer.workspace], [false, "workspace", join(pc.home, "projects")], "the program here runs with them");

  // saying no to everything changes nothing
  const none = await converse(cmd, pc.env, [[/Change the name\?/, ""], [/logo/, ""], [/tab icon/, ""], [/theme/, ""], [/log in/, ""], [/usage credit balance/, ""], [/the site lists/, ""], [/working folder,/, ""], [/usage credits from the site/, ""], [/address/, ""], [/Delete/, ""]]);
  assert.equal(none.status, 0, none.out);
  assert.equal(none.asked, 11, none.out);
  assert.match(none.out, /Nothing changed\./);
  assert.equal(pc.deploys().length, 1);
});

test("edit can move the site to a new address: the old one stays until the new one is claimed", { skip: !hasScript && "needs `script`" }, async t => {
  const held = await reservePort();
  const newOrigin = `http://127.0.0.1:${held.port}`;
  const { cf, site, pc, cmd, onCleanup } = await withCloudflare(t, { CLAUDECONNECT_SITE_ORIGIN: newOrigin });
  const r = run(cmd, pc.env, [...KEEP(), [/Change the address\? Now: http\S+\. You'd get a new link, and the old one stops working\. \[y\/N\]/, "y"], [/New address:/, "Not OK!"], [/Use lowercase letters[\s\S]*New address:/, "test-site"], [/That's the address it already has\.[\s\S]*New address:/, "new-site"], [/Delete Test Site\?/, ""], [/address: new-site \(a new link; the old one stops working\)[\s\S]*Save these changes\? \[Y\/n\]/, ""]], 120000);
  // the terminal says what the site's page would: how to turn on Access, and the claim link
  await until(() => /claim=/.test(r.output()), "the claim link", 60000);
  assert.match(r.output(), /Checking the new address[\s\S]*Setting up the new site[\s\S]*Waiting for you to claim the new site[\s\S]*dash\.cloudflare\.com\/acct-123\/workers\/services\/view\/new-site\/[\s\S]*Enable Cloudflare Access[\s\S]*\?claim=/);
  assert.deepEqual(cf.deleted, [], "the old site is untouched so far");
  const secrets = JSON.parse(readFileSync(join(pc.home, readdirSync(pc.home).find(f => /^secrets-.*\.json$/.test(f))), "utf8"));
  await held.release();
  const fresh = await startSite({ port: held.port, appVersion: "1.12.0", vars: { AGENT_SECRET: secrets.AGENT_SECRET, CLAIM_CODE: secrets.CLAIM_CODE } });
  onCleanup(() => fresh.stop());
  assert.equal((await fresh.claim()).status, 302);
  cf.setKvValue("kv-new", "agent-token", { token: fresh.jwt, exp: Math.floor(Date.now() / 1000) + 86400 });
  const done = await r.done;
  assert.equal(done.status, 0, done.out);
  assert.match(done.out, /Switching this computer over[\s\S]*Deleting the old site[\s\S]*Moved to http:\/\/127\.0\.0\.1:\d+\. The old site is gone\.[\s\S]*Saved\./);
  assert.deepEqual(cf.deleted.sort(), ["/accounts/acct-123/storage/kv/namespaces/kv-123", "/accounts/acct-123/workers/scripts/test-site"]);
  const cfg = JSON.parse(readFileSync(join(pc.dir, "config.json"), "utf8"));
  assert.deepEqual([cfg.name, cfg.site, cfg.kvId], ["new-site", newOrigin, "kv-new"]);
  await until(async () => (await fresh.api("/api/state")).body.agent.online, "the computer on the new site");
  assert.equal((await site.api("/api/state")).body.agent.online, false);
});

test("Ctrl+C while a move waits for the claim puts everything back", { skip: !hasScript && "needs `script`" }, async t => {
  const { cf, site, pc, cmd } = await withCloudflare(t);
  const before = readFileSync(join(pc.dir, "config.json"), "utf8");
  const r = run(cmd, pc.env, [...KEEP(), [/Change the address\?/, "y"], [/New address/, "never-mind"], [/Delete Test Site\?/, ""], [/Save these changes\?/, ""]], 120000);
  await until(() => /claim=/.test(r.output()), "the claim link", 60000);
  r.child.stdin.write("\x03");
  const done = await r.done;
  assert.notEqual(done.status, 0, done.out);
  assert.match(done.out, /Cancelling the move[\s\S]*Cancelled\. The old site is untouched\./);
  assert.deepEqual(cf.deleted.sort(), ["/accounts/acct-123/storage/kv/namespaces/kv-new", "/accounts/acct-123/workers/scripts/never-mind"], "only what the move made");
  assert.equal(readFileSync(join(pc.dir, "config.json"), "utf8"), before);
  assert.equal((await site.api("/api/state")).body.agent.online, true);
});

test("edit can delete the site, only once its name is typed", { skip: !hasScript && "needs `script`" }, async t => {
  const { cf, pc, cmd } = await withCloudflare(t);
  const keep = () => [...KEEP(), [/address/, ""]];
  const wrong = await converse(cmd, pc.env, [...keep(), [/Delete Test Site\? This removes the site and every chat in it, and can't be undone\. \[y\/N\]/, "y"], [/Type Test Site to confirm:/, "test site"]]);
  assert.equal(wrong.status, 0, wrong.out);
  assert.match(wrong.out, /That isn't the name, so it won't be deleted\.[\s\S]*Nothing changed\./);
  assert.deepEqual(cf.deleted, []);

  const r = await converse(cmd, pc.env, [...keep(), [/Delete Test Site\?/, "y"], [/Type Test Site to confirm:/, "Test Site"], [/Delete Test Site and every chat in it\.[\s\S]*Delete it now\? \[y\/N\]/, "y"]]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Deleting the site[\s\S]*Removing it from this computer[\s\S]*Deleted the site and its chats\./);
  assert.deepEqual(cf.deleted.sort(), ["/accounts/acct-123/storage/kv/namespaces/kv-123", "/accounts/acct-123/workers/scripts/test-site"]);
  assert.ok(!existsSync(join(pc.dir, "config.json")), "its setup is removed");
  assert.ok(existsSync(join(pc.home, "ws")), "the working folder is kept");
});
