import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

async function reply(s, agent, usage, extra = {}) {
  // /api/send streams until the run completes, so read it only after the agent has answered
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hello there", model: "claude-opus-5-5" }) });
  assert.equal(sent.status, 200);
  const run = await agent.next(m => m.type === "run");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "hi back", started: true, tools: [], model: "claude-opus-5-5", ms: 1200, usage, ...extra.done });
  await sent.text();
  await new Promise(r => setTimeout(r, 100));
  return run;
}

test("a finished reply is recorded and shows up in the daily and weekly series", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  await reply(s, agent, [{ model: "claude-opus-5-5", input: 120, output: 380, cacheRead: 40000, cacheWrite: 900, cost: 0.31 }]);
  await reply(s, agent, [{ model: "claude-haiku-5-5", input: 10, output: 40, cacheRead: 0, cacheWrite: 0, cost: 0.01 }]);

  const u = (await s.api("/api/usage?tz=UTC")).body;
  assert.equal(u.timeZone, "UTC");
  assert.equal(u.daily.length, 30);
  assert.equal(u.weekly.length, 12);
  const today = u.totals.today;
  assert.equal(today.replies, 2);
  assert.equal(today.input, 120 + 900 + 10);
  assert.equal(today.output, 420);
  assert.equal(today.tokens, 1450);
  assert.equal(today.cached, 40000);
  assert.ok(Math.abs(today.cost - 0.32) < 1e-9);
  assert.equal(u.daily[29].tokens, 1450);
  assert.equal(u.weekly[11].tokens, 1450);
  assert.equal(u.daily[28].tokens, 0);
  assert.ok(u.trackedSince > 0);
  assert.deepEqual(u.models.map(m => m.model), ["claude-opus-5-5", "claude-haiku-5-5"]);
});

test("a reply with no usage (stopped, or an older agent) still counts as a reply", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  await reply(s, agent, undefined);
  const u = (await s.api("/api/usage?tz=UTC")).body;
  assert.equal(u.totals.today.replies, 1);
  assert.equal(u.totals.today.tokens, 0);
  assert.equal(u.trackedSince, null);
});

test("the same run finishing twice is counted once", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  const run = await reply(s, agent, [{ model: "claude-opus-5-5", input: 5, output: 5, cost: 0.1 }]);
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "again", usage: [{ model: "claude-opus-5-5", input: 5, output: 5, cost: 0.1 }] });
  await new Promise(r => setTimeout(r, 150));
  const u = (await s.api("/api/usage?tz=UTC")).body;
  assert.equal(u.totals.today.tokens, 10);
  assert.equal(u.totals.today.replies, 1);
});

test("garbage usage from the agent is cleaned up rather than stored", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  const many = Array.from({ length: 20 }, (_, i) => ({ model: "m" + i, input: 1, output: 1 }));
  await reply(s, agent, [{ model: "claude-opus-5-5", input: -50, output: "9999", cacheRead: NaN, cacheWrite: Infinity, cost: -3 }, null, "x", ...many]);
  const u = (await s.api("/api/usage?tz=UTC")).body;
  // Only the first 8 entries are read: the junk values in the first three contribute nothing, the next five are kept.
  assert.equal(u.totals.today.input, 5);
  assert.equal(u.totals.today.output, 5);
  assert.equal(u.totals.today.cost, 0);
  assert.ok(u.models.length <= 8);
});

test("the chart's time zone is honoured, and a bad one falls back to UTC", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const a = (await s.api("/api/usage?tz=Pacific/Kiritimati")).body;
  const b = (await s.api("/api/usage?tz=Not/AZone")).body;
  const c = (await s.api("/api/usage")).body;
  assert.equal(a.timeZone, "Pacific/Kiritimati");
  assert.equal(b.timeZone, "UTC");
  assert.equal(c.timeZone, "UTC");
});

test("usage is private to the owner", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const anon = await s.mf.dispatchFetch(s.origin + "/api/usage", { headers: { "x-test-anonymous": "1" } });
  assert.equal(anon.status, 401);
});
