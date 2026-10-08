import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

test("the real worker runs: locked until claimed, then serves the app and state", async t => {
  const s = await startSite();
  t.after(() => s.stop());

  const anon = await s.mf.dispatchFetch(s.origin + "/api/state", { headers: { "x-test-anonymous": "1" } });
  assert.equal(anon.status, 401);

  const before = await s.api("/api/state");
  assert.equal(before.status, 401);
  assert.equal(before.body.state, "unclaimed");

  const claimed = await s.claim();
  assert.equal(claimed.status, 302);

  const state = await s.api("/api/state");
  assert.equal(state.status, 200);
  assert.equal(state.body.email, "owner@example.com");
  assert.equal(state.body.version, "1.1.0");
  assert.equal(state.body.agent.online, false);

  const page = await s.asOwner("/");
  const html = await page.text();
  assert.match(html, /<title>Test Site<\/title>/);
  assert.match(html, /"version":"1\.1\.0"/);
});

test("an agent can connect and shows up as online with its version", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s, { agent: "1.2.0" });
  const state = await s.api("/api/state");
  assert.equal(state.body.agent.online, true);
  assert.equal(state.body.agent.version, "1.2.0");
  agent.close();
});
