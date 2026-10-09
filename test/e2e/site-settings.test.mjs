// The site's name, Fable and images, changed from Settings: they take effect straight away with no redeploy, the computer is
// told so it keeps its own copy, and a later deploy with different values (from `<command> edit`) wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a new name, Fable and logo take effect at once, on the page, the locked page and the images", async t => {
  const s = await startSite({ appVersion: "1.10.0" });
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  const before = (await s.api("/api/state")).body.site;
  assert.deepEqual([before.name, before.fable, before.logo, before.favicon], ["Test Site", false, false, false]);

  const r = await s.post("/api/site", { displayName: "  My   Place ", fable: true, logo: { b64: PNG } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.name, r.body.fable, r.body.logo], ["My Place", true, true]);
  assert.notEqual(r.body.v, before.v, "the images get a new address");
  // the page is served with it, with no redeploy
  const page = await (await s.asOwner("/")).text();
  assert.match(page, /<title>My Place<\/title>/);
  assert.match(page, new RegExp(`<img src="/logo\\?v=${r.body.v}"`));
  assert.match(page, new RegExp(`href="/favicon\\?v=${r.body.v}"`));
  assert.match(page, /"fable":true/);
  const logo = await s.asOwner(`/logo?v=${r.body.v}`);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.match(logo.headers.get("cache-control"), /immutable/);
  assert.equal((await s.asOwner("/favicon")).headers.get("content-type"), "image/png", "the tab icon falls back to the logo");
  const locked = await (await s.mf.dispatchFetch(s.origin + "/", { headers: { "x-test-anonymous": "1" } })).text();
  assert.match(locked, /<title>My Place<\/title>/);
  // Fable can be sent to now
  const send = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hi", model: "claude-fable-5-1" }) });
  const run = await agent.next(m => m.type === "run");
  assert.equal(run.model, "claude-fable-5-1");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
  await (await send).text();
  // and the computer was told, so its own copy matches for the next update and for `edit`
  const told = await agent.next(m => m.type === "site");
  assert.equal(told.displayName, "My Place");
  assert.equal(told.fable, true);
  assert.equal(told.brand.logo.b64, PNG);
  assert.equal(told.brand.favicon, null);

  // back to the built-in logo
  assert.equal((await s.post("/api/site", { logo: null })).body.logo, false);
  assert.equal((await s.asOwner("/logo")).status, 404);
  // nonsense is refused and changes nothing
  for (const bad of [{ displayName: "" }, { displayName: "<b>" }, { logo: { b64: "bm90IGFuIGltYWdl" } }]) assert.equal((await s.post("/api/site", bad)).status, 400, JSON.stringify(bad));
  assert.equal((await s.api("/api/state")).body.site.name, "My Place");
});

test("a deploy with a different name (from `<command> edit`) wins over a name set here earlier; the same name doesn't", async t => {
  const s = await startSite({ appVersion: "1.10.0" });
  t.after(() => s.stop());
  await s.claim();
  await s.post("/api/site", { displayName: "From Settings" });
  // what the Durable Object keeps, read the way a later deploy with other values would see it
  const rec = await s.getStorage("site");
  assert.deepEqual(rec.name, { value: "From Settings", over: "Test Site" });
  // a later deploy whose SITE_NAME is something else (an `edit` from the terminal): the change made here no longer applies
  await s.putStorage("site", { ...rec, name: { value: "From Settings", over: "Some Older Name" } });
  assert.equal((await s.api("/api/state")).body.site.name, "Test Site");
  // a deploy that kept the name it had (an update): it still does
  await s.putStorage("site", rec);
  assert.equal((await s.api("/api/state")).body.site.name, "From Settings");
});
