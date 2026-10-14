import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

test("there is nothing to show until Claude Code has reported real percentages", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  assert.equal((await s.api("/api/state")).body.limits, null);
  assert.equal((await s.api("/api/limits")).body, null);
});

test("percentages from the agent are stored, rounded, and kept across reads", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  agent.send({ type: "limits", limits: { status: "allowed_warning", windows: { five_hour: { pct: 99.4, resetsAt: nowS() + 7200 }, seven_day: { pct: 58.6, resetsAt: nowS() + 3 * 86400 } } } });
  await sleep(150);
  const l = (await s.api("/api/state")).body.limits;
  assert.equal(l.status, "allowed_warning");
  assert.equal(l.windows.five_hour.pct, 99);
  assert.equal(l.windows.seven_day.pct, 59);
  assert.equal(l.windows.five_hour.reset, false);
  assert.ok(l.at > 0);
  assert.deepEqual((await s.api("/api/limits")).body.windows, l.windows);
});

test("a window that has reset since the reading says so, instead of a stale number", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  agent.send({ type: "limits", limits: { windows: { five_hour: { pct: 80, resetsAt: nowS() - 60 }, seven_day: { pct: 10, resetsAt: nowS() + 86400 } } } });
  await sleep(150);
  const l = (await s.api("/api/limits")).body;
  assert.equal(l.windows.five_hour.reset, true);
  assert.equal(l.windows.seven_day.reset, false);
});

test("a newer reading replaces the old one, and junk from the agent is ignored", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  agent.send({ type: "limits", limits: { windows: { five_hour: { pct: 10, resetsAt: nowS() + 100 } } } });
  await sleep(100);
  for (const junk of [null, 5, "x", [], {}, { windows: null }, { windows: { five_hour: { pct: "high", resetsAt: 5 } } }, { windows: { bogus: { pct: 5, resetsAt: 5 } } }, { windows: { five_hour: { pct: NaN, resetsAt: 5 } } }]) {
    agent.send({ type: "limits", limits: junk });
  }
  await sleep(150);
  assert.equal((await s.api("/api/limits")).body.windows.five_hour.pct, 10, "junk didn't touch the stored reading");
  agent.send({ type: "limits", limits: { windows: { five_hour: { pct: 1e9, resetsAt: nowS() + 100 }, seven_day: { pct: -4, resetsAt: nowS() + 100 }, bogus: { pct: 1, resetsAt: 1 } } } });
  await sleep(150);
  const l = (await s.api("/api/limits")).body;
  assert.equal(l.windows.five_hour.pct, 999, "absurd values are capped");
  assert.equal(l.windows.seven_day.pct, 0);
  assert.deepEqual(Object.keys(l.windows).sort(), ["five_hour", "seven_day"]);
});

test("Refresh asks the computer to read the percentages, and not more than every few seconds", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  assert.equal((await s.post("/api/limits/refresh")).status, 503, "offline");
  const agent = await connectAgent(s);
  const first = await s.post("/api/limits/refresh");
  assert.equal(first.status, 200);
  assert.equal((await agent.next(m => m.type === "limits_refresh")).type, "limits_refresh");
  const second = await s.post("/api/limits/refresh");
  assert.equal(second.body.wait, true);
  await assert.rejects(agent.next(m => m.type === "limits_refresh", 400), /timed out/);
});

test("plan usage is private to the owner", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const anon = await s.mf.dispatchFetch(s.origin + "/api/limits", { headers: { "x-test-anonymous": "1" } });
  assert.equal(anon.status, 401);
});

test("what the computer left before it could connect, its chats and plan usage, is on the site from the first visit, and only until it connects", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const kv = await s.mf.getKVNamespace("TOKENS", "site");
  const id = "0b0e1c2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d";
  const preload = at => JSON.stringify({ at, sessions: [{ id, title: "Fix the login page", folder: "shop", updated: Date.now() - 60000 }], limits: { status: "allowed", windows: { five_hour: { pct: 42, resetsAt: nowS() + 3600 }, seven_day: { pct: 17, resetsAt: nowS() + 86400 } } } });
  await kv.put("preload", preload(Date.now()));
  const st = (await s.api("/api/state")).body;
  assert.equal(st.agent.online, false);
  assert.deepEqual([st.limits.windows.five_hour.pct, st.limits.windows.seven_day.pct], [42, 17]);
  assert.ok((await s.api("/api/chats")).body.chats.some(c => c.id === id && c.title === "Fix the login page"));
  // once the computer has connected, what it says is newer: what it left before isn't taken again
  const agent = await connectAgent(s);
  agent.send({ type: "sessions", sessions: [] });
  agent.send({ type: "limits", limits: { status: "allowed", windows: { five_hour: { pct: 50, resetsAt: nowS() + 3600 } } } });
  await sleep(150);
  agent.close();
  await sleep(150);
  await kv.put("preload", preload(Date.now() - 600000));
  await sleep(1100);
  assert.equal((await s.api("/api/state")).body.limits.windows.five_hour.pct, 50);
  assert.ok(!(await s.api("/api/chats")).body.chats.some(c => c.id === id));
});
