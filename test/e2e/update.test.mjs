import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent, AGENT_SECRET } from "../helpers/site.mjs";

const RELEASE = { name: "claudeconnect", version: "1.2.0", released: "2026-10-08", notes: ["Usage chart", "Update from the site"], files: {} };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ready(opts = {}) {
  const s = await startSite({ release: RELEASE, appVersion: "1.1.0", ...opts });
  await s.claim();
  return s;
}
// What the updater process does: tell the site how it's going, with the agent's key.
const progress = (s, body, key = AGENT_SECRET) =>
  s.mf.dispatchFetch(s.origin + "/agent/progress", { method: "POST", headers: { "content-type": "application/json", "cf-access-token": s.jwt, "x-chatgql-key": key }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

test("the site notices a newer release and says what's in it", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const u = (await s.api("/api/update")).body;
  assert.equal(u.current, "1.1.0");
  assert.equal(u.latest, "1.2.0");
  assert.equal(u.available, true);
  assert.deepEqual(u.notes, RELEASE.notes);
  assert.equal(u.source, "ThatOneWeirdDev/claudeconnect@main");
  assert.equal(u.run, null);
  assert.equal((await s.api("/api/state")).body.update.available, true);
  assert.match(s.fetched[0], /^https:\/\/raw\.test\/ThatOneWeirdDev\/claudeconnect\/main\/manifest\.json/);
});

test("being on the newest version, or ahead of it, is not an update", async t => {
  const same = await ready({ appVersion: "1.2.0" });
  t.after(() => same.stop());
  assert.equal((await same.api("/api/update")).body.available, false);
  const ahead = await ready({ appVersion: "1.3.0" });
  t.after(() => ahead.stop());
  assert.equal((await ahead.api("/api/update")).body.available, false);
});

test("checks are cached, and Check again goes back to GitHub", async t => {
  const s = await ready();
  t.after(() => s.stop());
  await s.api("/api/update");
  await s.api("/api/update");
  await s.api("/api/state");
  assert.equal(s.fetched.length, 1);
  s.release = { ...RELEASE, version: "1.2.1" };
  assert.equal((await s.api("/api/update")).body.latest, "1.2.0");
  const again = (await s.post("/api/update/check")).body;
  assert.equal(again.latest, "1.2.1");
  assert.equal(s.fetched.length, 2);
});

test("an unpublished or broken release doesn't break the site", async t => {
  const s = await ready({ release: null });
  t.after(() => s.stop());
  let u = (await s.api("/api/update")).body;
  assert.equal(u.available, false);
  assert.match(u.error, /No release has been published/);
  assert.equal((await s.api("/api/state")).status, 200);
  s.release = { version: "totally broken" };
  u = (await s.post("/api/update/check")).body;
  assert.equal(u.available, false);
  assert.match(u.error, /couldn't be read/);
  s.releaseStatus = 503;
  u = (await s.post("/api/update/check")).body;
  assert.match(u.error, /503/);
  s.releaseStatus = 200;
  s.release = RELEASE;
  u = (await s.post("/api/update/check")).body;
  assert.equal(u.available, true);
  assert.equal(u.error, "");
});

test("release notes are plain text from the internet, trimmed and capped", async t => {
  const s = await ready({ release: { ...RELEASE, notes: ["<img src=x onerror=alert(1)>", ...Array.from({ length: 30 }, (_, i) => "n" + i)] } });
  t.after(() => s.stop());
  const u = (await s.api("/api/update")).body;
  assert.equal(u.notes.length, 12);
  assert.equal(u.notes[0], "<img src=x onerror=alert(1)>"); // returned as data; the page escapes it
});

test("updating is blocked with a reason until the computer is online and able", async t => {
  const s = await ready();
  t.after(() => s.stop());
  assert.equal((await s.api("/api/update")).body.blocked.code, "offline");
  const start = await s.post("/api/update/start", { to: "1.2.0" });
  assert.equal(start.status, 409);
  assert.equal(start.body.code, "offline");

  const old = await connectAgent(s, { agent: "1.1.0", caps: undefined });
  assert.equal((await s.api("/api/update")).body.blocked.code, "agent_old");
  assert.match((await s.api("/api/update")).body.blocked.message, /TestConnect update/);
  old.close();
  await sleep(100);

  const agent = await connectAgent(s, { agent: "1.1.9" }, "agent-2");
  assert.equal((await s.api("/api/update")).body.blocked, null);
  agent.close();
});

test("a reply in progress blocks updating until it finishes", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const agent = await connectAgent(s, { agent: "1.1.9" });
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "working on it", model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run");
  assert.equal((await s.api("/api/update")).body.blocked.code, "busy");
  assert.equal((await s.post("/api/update/start", { to: "1.2.0" })).status, 409);
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "done", started: true, tools: [] });
  await sent.text();
  await sleep(100);
  assert.equal((await s.api("/api/update")).body.blocked, null);
});

test("starting asks the agent to update, and only for the version that was shown", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const agent = await connectAgent(s, { agent: "1.1.9" });

  const wrong = await s.post("/api/update/start", { to: "9.9.9" });
  assert.equal(wrong.status, 409);
  assert.equal(wrong.body.code, "changed");
  assert.equal((await s.post("/api/update/start", {})).status, 409);

  const started = await s.post("/api/update/start", { to: "1.2.0" });
  assert.equal(started.status, 200, started.text);
  assert.equal(started.body.run.state, "running");
  assert.equal(started.body.run.from, "1.1.0");
  assert.equal(started.body.run.to, "1.2.0");
  assert.equal(started.body.run.by, "owner@example.com");
  const msg = await agent.next(m => m.type === "update");
  assert.equal(msg.id, started.body.run.id);
  assert.equal(msg.to, "1.2.0");
  assert.deepEqual(Object.keys(msg).sort(), ["id", "to", "type"]); // no repo or URL for the agent to be told to trust

  const twice = await s.post("/api/update/start", { to: "1.2.0" });
  assert.equal(twice.status, 409);
  assert.equal(twice.body.code, "running");
});

test("up to date means there's nothing to start", async t => {
  const s = await ready({ appVersion: "1.2.0" });
  t.after(() => s.stop());
  await connectAgent(s);
  const r = await s.post("/api/update/start", { to: "1.2.0" });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, "current");
});

test("progress from the updater drives the steps the page shows, and survives reloads", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const agent = await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  const id = started.run.id;
  agent.send({ type: "update_ack", id, ok: true });
  await sleep(100);
  assert.equal((await s.api("/api/update")).body.run.acked, true);

  assert.equal((await progress(s, { id, step: "download", status: "active" })).status, 200);
  assert.equal((await progress(s, { id, step: "download", status: "done" })).status, 200);
  await progress(s, { id, step: "site", status: "active" });
  let run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "running");
  assert.equal(run.step, "site");
  assert.deepEqual([run.steps.download, run.steps.verify, run.steps.site], ["done", "done", "active"]); // skipped steps are done

  await progress(s, { id, step: "computer", status: "active" });
  await progress(s, { id, step: "restart", status: "active" });
  run = (await s.api("/api/update")).body.run;
  assert.equal(run.steps.site, "done");
  assert.equal(run.steps.computer, "done");
  assert.equal(run.steps.restart, "active");
});

test("the final step completes the update", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const agent = await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  await progress(s, { id: started.run.id, step: "online", status: "done" });
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "done");
  assert.ok(Object.values(run.steps).every(v => v === "done"));
  assert.ok(run.finishedAt >= run.startedAt);
  agent.close();
});

test("the new agent saying hello completes the update by itself", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const old = await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  await progress(s, { id: started.run.id, step: "restart", status: "active" });
  old.close();
  await sleep(100);
  // the old program coming back doesn't count
  const back = await connectAgent(s, { agent: "1.1.9" }, "agent-1");
  assert.equal((await s.api("/api/update")).body.run.state, "running");
  back.close();
  await sleep(100);
  const fresh = await connectAgent(s, { agent: "1.2.0" }, "agent-1");
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "done");
  assert.equal(run.steps.online, "done");
  fresh.close();
});

test("a failure is reported on its step with the reason, and can be dismissed", async t => {
  const s = await ready();
  t.after(() => s.stop());
  await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  const id = started.run.id;
  await progress(s, { id, step: "site", status: "active" });
  await progress(s, { id, step: "site", status: "error", message: "Cloudflare didn't accept the new version." });
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "error");
  assert.equal(run.step, "site");
  assert.equal(run.steps.site, "error");
  assert.equal(run.message, "Cloudflare didn't accept the new version.");
  // later progress for a finished run changes nothing
  await progress(s, { id, step: "online", status: "done" });
  assert.equal((await s.api("/api/update")).body.run.state, "error");
  // and the user can try again after dismissing
  const dismissed = (await s.post("/api/update/dismiss")).body;
  assert.equal(dismissed.run, null);
  assert.equal(dismissed.available, true);
  assert.equal((await s.post("/api/update/start", { to: "1.2.0" })).status, 200);
});

test("a running update can't be dismissed away", async t => {
  const s = await ready();
  t.after(() => s.stop());
  await connectAgent(s, { agent: "1.1.9" });
  await s.post("/api/update/start", { to: "1.2.0" });
  const r = (await s.post("/api/update/dismiss")).body;
  assert.equal(r.run.state, "running");
});

test("the agent can refuse, and the page learns why", async t => {
  const s = await ready();
  t.after(() => s.stop());
  const agent = await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  agent.send({ type: "update_ack", id: started.run.id, ok: false, error: "A reply is still being written on your computer." });
  await sleep(100);
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "error");
  assert.equal(run.message, "A reply is still being written on your computer.");
});

test("an agent that never answers is reported as such rather than leaving the page spinning", async t => {
  const s = await ready({ vars: { UPDATE_ACK_MS: "300" } });
  t.after(() => s.stop());
  await connectAgent(s, { agent: "1.1.9" });
  await s.post("/api/update/start", { to: "1.2.0" });
  await sleep(500);
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "error");
  assert.match(run.message, /didn't pick up the update/);
});

test("an update that goes quiet is reported, and still completes if the new version appears later", async t => {
  const s = await ready({ vars: { UPDATE_QUIET_MS: "300" } });
  t.after(() => s.stop());
  const agent = await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  agent.send({ type: "update_ack", id: started.run.id, ok: true });
  await sleep(500);
  let run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "error");
  assert.match(run.message, /stopped reporting progress/);
  agent.close();
  await sleep(100);
  await connectAgent(s, { agent: "1.2.0" }, "agent-1");
  run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "done");
});

test("only the agent's key can post progress, and only for the current update", async t => {
  const s = await ready();
  t.after(() => s.stop());
  await connectAgent(s, { agent: "1.1.9" });
  const { body: started } = await s.post("/api/update/start", { to: "1.2.0" });
  const id = started.run.id;
  assert.equal((await progress(s, { id, step: "site", status: "done" }, "wrong-key")).status, 403);
  assert.equal((await progress(s, { id: "someone-elses", step: "site", status: "done" })).status, 404);
  const anon = await s.mf.dispatchFetch(s.origin + "/agent/progress", { method: "POST", headers: { "x-test-anonymous": "1", "x-chatgql-key": AGENT_SECRET }, body: "{}" });
  assert.equal(anon.status, 401);
  const get = await s.mf.dispatchFetch(s.origin + "/agent/progress", { headers: { "cf-access-token": s.jwt, "x-chatgql-key": AGENT_SECRET } });
  assert.equal(get.status, 405);
  const big = await s.mf.dispatchFetch(s.origin + "/agent/progress", { method: "POST", headers: { "cf-access-token": s.jwt, "x-chatgql-key": AGENT_SECRET }, body: "x".repeat(30000) });
  assert.equal(big.status, 413);
  assert.equal((await s.api("/api/update")).body.run.steps.site, undefined);
  for (const junk of ["null", "5", "[]", "not json", '"text"']) {
    const r = await s.mf.dispatchFetch(s.origin + "/agent/progress", { method: "POST", headers: { "cf-access-token": s.jwt, "x-chatgql-key": AGENT_SECRET }, body: junk });
    assert.equal(r.status, 400, junk);
  }
});

test("the owner's browser can't start an update from another origin", async t => {
  const s = await ready();
  t.after(() => s.stop());
  await connectAgent(s, { agent: "1.1.9" });
  const r = await s.post("/api/update/start", { to: "1.2.0" }, { origin: "https://evil.example" });
  assert.equal(r.status, 403);
  const t2 = await s.api("/api/update/start", { method: "POST", body: "to=1.2.0", headers: { "content-type": "text/plain" } });
  assert.equal(t2.status, 415);
  assert.equal((await s.api("/api/update")).body.run, null);
});
