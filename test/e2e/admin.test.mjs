import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent, AGENT_SECRET } from "../helpers/site.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
// a real 1x1 PNG, and a few things that are not images
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("base64");
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"><rect width="1" height="1"/></svg>').toString("base64");
const progress = (s, body) =>
  s.mf.dispatchFetch(s.origin + "/agent/progress", { method: "POST", headers: { "content-type": "application/json", "cf-access-token": s.jwt, "x-chatgql-key": AGENT_SECRET }, body: JSON.stringify(body) }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));

async function ready(opts = {}) {
  const s = await startSite({ appVersion: "1.3.0", ...opts });
  await s.claim();
  const agent = await connectAgent(s, { agent: "1.3.0" });
  return { s, agent };
}

test("changing settings tells the computer only what changed", async t => {
  const { s, agent } = await ready();
  t.after(() => s.stop());
  const r = await s.post("/api/admin/settings", { displayName: "  My   Site ", aiName: "Buddy", fable: true });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.body.run.kind, "settings");
  assert.deepEqual(r.body.run.plan.map(x => x.key), ["site", "computer", "restart", "online"]);
  const msg = await agent.next(m => m.type === "admin");
  assert.equal(msg.op, "settings");
  assert.equal(msg.id, r.body.run.id);
  assert.deepEqual(msg.payload, { displayName: "My Site", aiName: "Buddy", fable: true });
});

test("settings that are already what the site has are not a change", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  const r = await s.post("/api/admin/settings", { displayName: "Test Site", aiName: "Testy", fable: false });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, "nochange");
  assert.equal((await s.api("/api/update")).body.run, null);
});

test("names, logos and icons are checked before the computer is bothered", async t => {
  const { s, agent } = await ready();
  t.after(() => s.stop());
  for (const bad of ["", "   ", "-starts-with-dash", "x".repeat(41), "has/slash", "<b>", 42]) {
    const r = await s.post("/api/admin/settings", { displayName: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const notImage = await s.post("/api/admin/settings", { logo: { b64: Buffer.from("just some text, not an image").toString("base64") } });
  assert.equal(notImage.status, 400);
  assert.match(notImage.body.error, /The logo: it isn't a PNG/);
  const junk = await s.post("/api/admin/settings", { favicon: { b64: "!!!not base64!!!" } });
  assert.match(junk.body.error, /The tab icon: that image couldn't be read/);
  const huge = await s.post("/api/admin/settings", { logo: { b64: Buffer.alloc(600 * 1024, 0x89).toString("base64") } });
  assert.equal(huge.status, 400);
  assert.equal((await s.post("/api/admin/settings", null)).status, 400);
  await assert.rejects(agent.next(m => m.type === "admin", 300), /timed out/, "the computer heard nothing");
  assert.equal((await s.api("/api/update")).body.run, null);
});

test("a logo and a tab icon go through as images, and null puts the built-in one back", async t => {
  const { s, agent } = await ready();
  t.after(() => s.stop());
  const r = await s.post("/api/admin/settings", { logo: { b64: PNG }, favicon: { b64: SVG } });
  assert.equal(r.status, 200, r.text);
  const msg = await agent.next(m => m.type === "admin");
  assert.deepEqual(msg.payload.logo, { type: "image/png", b64: PNG });
  assert.deepEqual(msg.payload.favicon, { type: "image/svg+xml", b64: SVG });
  assert.ok(!JSON.stringify(r.body).includes(PNG), "the image isn't kept in the page-visible job");
  await progress(s, { id: r.body.run.id, step: "online", status: "done" });
  await s.post("/api/update/dismiss");
  const reset = await s.post("/api/admin/settings", { logo: null, favicon: null });
  assert.equal(reset.status, 200);
  assert.deepEqual((await agent.next(m => m.type === "admin")).payload, { logo: null, favicon: null });
});

test("a settings job finishes on its last step, not when the agent says hello", async t => {
  const { s, agent } = await ready();
  t.after(() => s.stop());
  const { body } = await s.post("/api/admin/settings", { aiName: "Buddy" });
  const id = body.run.id;
  agent.close();
  await sleep(100);
  await connectAgent(s, { agent: "9.9.9" }, "agent-1");
  assert.equal((await s.api("/api/update")).body.run.state, "running", "a newer agent proves nothing here");
  await progress(s, { id, step: "site", status: "done" });
  await progress(s, { id, step: "computer", status: "done" });
  assert.equal((await s.api("/api/update")).body.run.state, "running");
  await progress(s, { id, step: "online", status: "done" });
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "done");
  assert.ok(Object.values(run.steps).every(v => v === "done"));
});

test("changes need a computer that is online, able to do it, and not busy", async t => {
  const s = await startSite({ appVersion: "1.3.0" });
  t.after(() => s.stop());
  await s.claim();
  const offline = await s.post("/api/admin/settings", { aiName: "Buddy" });
  assert.equal(offline.status, 409);
  assert.equal(offline.body.code, "offline");
  assert.equal((await s.api("/api/update")).body.blockedAdmin.code, "offline");

  const old = await connectAgent(s, { agent: "1.2.0", caps: ["update"] });
  const tooOld = await s.post("/api/admin/delete", { confirm: "Test Site" });
  assert.equal(tooOld.status, 409);
  assert.equal(tooOld.body.code, "agent_old");
  assert.match(tooOld.body.error, /TestConnect update/);
  old.close();
  await sleep(100);

  const agent = await connectAgent(s, { agent: "1.3.0" }, "agent-2");
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "busy", model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run");
  const busy = await s.post("/api/admin/settings", { aiName: "Buddy" });
  assert.equal(busy.status, 409);
  assert.equal(busy.body.code, "busy");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
  await sent.text();
});

test("only one thing happens at a time", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  assert.equal((await s.post("/api/admin/settings", { aiName: "One" })).status, 200);
  const second = await s.post("/api/admin/settings", { aiName: "Two" });
  assert.equal(second.status, 409);
  assert.equal(second.body.code, "running");
  assert.equal((await s.post("/api/admin/move", { address: "elsewhere" })).status, 409);
});

test("moving needs a valid address that isn't the current one", async t => {
  const { s, agent } = await ready();
  t.after(() => s.stop());
  for (const bad of ["", "UPPER_case", "has space", "-dash", "dash-", "a".repeat(64), "x.y", null]) {
    const r = await s.post("/api/admin/move", { address: bad });
    assert.equal(r.status, 400, JSON.stringify(bad));
  }
  const same = await s.post("/api/admin/move", { address: "127" }); // this site's own name, from the address it's reached at
  assert.equal(same.body.code, "nochange");
  const ok = await s.post("/api/admin/move", { address: "  My-New-Site " });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.run.plan.map(x => x.key), ["prepare", "create", "access", "switch", "cleanup"]);
  const msg = await agent.next(m => m.type === "admin");
  assert.deepEqual([msg.op, msg.payload], ["move", { address: "my-new-site" }]);
});

test("while a move waits, the page gets the new links, and only real web links", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  const { body } = await s.post("/api/admin/move", { address: "fresh" });
  const id = body.run.id;
  await progress(s, { id, step: "access", status: "active", info: { site: "https://fresh.example.workers.dev", claim: "https://fresh.example.workers.dev/?claim=abc", dash: "https://dash.cloudflare.com/x/y", name: "fresh", evil: "x" } });
  let run = (await s.api("/api/update")).body.run;
  assert.deepEqual(run.info, { site: "https://fresh.example.workers.dev", claim: "https://fresh.example.workers.dev/?claim=abc", dash: "https://dash.cloudflare.com/x/y", name: "fresh" });
  assert.deepEqual([run.steps.prepare, run.steps.create, run.steps.access], ["done", "done", "active"]);
  await progress(s, { id, step: "access", status: "active", info: { site: "javascript:alert(1)", claim: "http://evil.example/", dash: 'https://x"onmouseover=1', name: "Bad Name!" } });
  run = (await s.api("/api/update")).body.run;
  assert.equal(run.info.site, "https://fresh.example.workers.dev", "bad links change nothing");
  const http = await progress(s, { id, step: "access", status: "active", info: { site: "http://127.0.0.1:8787" } });
  assert.equal(http.status, 200);
  assert.equal((await s.api("/api/update")).body.run.info.site, "http://127.0.0.1:8787", "this computer's own address is fine");
});

test("cancelling a move reaches the computer through its next progress report", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  const { body } = await s.post("/api/admin/move", { address: "fresh" });
  const id = body.run.id;
  assert.equal((await progress(s, { id, step: "access", status: "active" })).body.cancel, false);
  const cancelled = await s.post("/api/admin/cancel");
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.run.cancel, true);
  assert.equal((await progress(s, { id, step: "access", status: "active" })).body.cancel, true);
  await progress(s, { id, step: "access", status: "error", message: "Cancelled. The old site is untouched." });
  const run = (await s.api("/api/update")).body.run;
  assert.equal(run.state, "error");
  assert.equal(run.message, "Cancelled. The old site is untouched.");
  assert.equal((await s.post("/api/admin/cancel")).status, 409, "nothing left to cancel");
});

test("only a move can be cancelled", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  await s.post("/api/admin/settings", { aiName: "Buddy" });
  assert.equal((await s.post("/api/admin/cancel")).status, 409);
});

test("deleting needs the site's name typed exactly", async t => {
  const { s, agent } = await ready();
  t.after(() => s.stop());
  for (const wrong of [undefined, "", "test site", "Test Site ", "Testy"]) {
    const r = await s.post("/api/admin/delete", wrong === undefined ? {} : { confirm: wrong });
    assert.equal(r.status, 400, JSON.stringify(wrong));
    assert.equal(r.body.code, "confirm");
  }
  await assert.rejects(agent.next(m => m.type === "admin", 300), /timed out/);
  const ok = await s.post("/api/admin/delete", { confirm: "Test Site" });
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual(ok.body.run.plan.map(x => x.key), ["site", "computer"]);
  const msg = await agent.next(m => m.type === "admin");
  assert.deepEqual([msg.op, msg.payload], ["delete", {}]);
});

test("progress for a step the job doesn't have is ignored, and the plan is the job's own", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  const { body } = await s.post("/api/admin/delete", { confirm: "Test Site" });
  await progress(s, { id: body.run.id, step: "download", status: "done" });
  const run = (await s.api("/api/update")).body.run;
  assert.deepEqual(run.steps, {}, "'download' isn't part of deleting");
  assert.equal(run.step, "site");
});

test("changes can't be started from another origin or by a form post", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  for (const path of ["/api/admin/settings", "/api/admin/move", "/api/admin/delete", "/api/admin/cancel"]) {
    const cross = await s.post(path, { aiName: "x", address: "x", confirm: "Test Site" }, { origin: "https://evil.example" });
    assert.equal(cross.status, 403, path);
    const form = await s.api(path, { method: "POST", body: "aiName=x", headers: { "content-type": "application/x-www-form-urlencoded" } });
    assert.equal(form.status, 415, path);
  }
  assert.equal((await s.api("/api/update")).body.run, null);
});

test("a dismissed or finished job clears, and a running one can't be dismissed", async t => {
  const { s } = await ready();
  t.after(() => s.stop());
  const { body } = await s.post("/api/admin/settings", { aiName: "Buddy" });
  assert.equal((await s.post("/api/update/dismiss")).body.run.state, "running");
  await progress(s, { id: body.run.id, step: "online", status: "done" });
  assert.equal((await s.post("/api/update/dismiss")).body.run, null);
});
