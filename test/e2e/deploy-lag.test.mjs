// Right after a deploy, the Worker runs the new code while the Durable Object can still be running the previous version's.
// Pages must not break on that (Cloudflare's "Error 1101 Worker threw exception"), and the Object must catch up by itself.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "../helpers/site.mjs";

test("a page, the locked page and the icons still load while the Object runs older code", async t => {
  const s = await startSite({ appVersion: "1.10.1", vars: { TEST_OLD_HUB: "1" } });
  t.after(() => s.stop());
  await s.claim();
  const page = await s.asOwner("/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /<title>Test Site<\/title>/);
  assert.equal((await s.mf.dispatchFetch(s.origin + "/", { headers: { "x-test-anonymous": "1" } })).status, 401, "the locked page, not an error");
  assert.equal((await s.asOwner("/favicon")).status, 200);
  assert.equal((await s.asOwner("/logo")).status, 404);
});

test("an Object running older code than the Worker restarts itself, and the request goes through on the fresh one", async t => {
  const s = await startSite({ appVersion: "1.10.1" });
  t.after(() => s.stop());
  await s.claim();
  await s.post("/api/site", { displayName: "Kept Name" });
  const ns = await s.mf.getDurableObjectNamespace("HUB", "site");
  const stub = () => ns.get(ns.idFromName("main"));
  // a request from a Worker that's on a newer version than this Object
  await assert.rejects(stub().fetch("https://x/api/state", { headers: { "x-app-version": "99.0.0" } }));
  // the Object came back, with everything it keeps
  const r = await stub().fetch("https://x/api/state", { headers: { "x-app-version": "1.10.1", "x-chatgql-user": "owner@example.com" } });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).site.name, "Kept Name");
  // and through the Worker as usual
  assert.equal((await s.api("/api/state")).body.site.name, "Kept Name");
});

test("the page and the computer can ask which version really answers, front and back", async t => {
  const s = await startSite({ appVersion: "1.11.0" });
  t.after(() => s.stop());
  await s.claim();
  assert.deepEqual((await s.api("/api/version")).body, { worker: "1.11.0", hub: "1.11.0" });
  const agent = await s.mf.dispatchFetch(s.origin + "/agent/version", { headers: { "cf-access-token": s.jwt, "x-chatgql-key": s.agentSecret } });
  assert.deepEqual(await agent.json(), { worker: "1.11.0", hub: "1.11.0" });
  assert.equal((await s.mf.dispatchFetch(s.origin + "/agent/version", { headers: { "cf-access-token": s.jwt } })).status, 403, "not without the computer's key");
});
