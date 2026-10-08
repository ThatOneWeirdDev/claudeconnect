import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "../helpers/site.mjs";

const DAY = 86400000;

test("chats from before usage tracking still show as replies, and tracked usage lines up by day, week and time zone", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const now = Date.now();
  const at = d => now - d * DAY; // d days ago, at the same time of day, so in UTC it is exactly d calendar days back

  // replies 40, 36, ... 0 days ago: 11 in total, 8 of them inside the 30-day window (28, 24, ... 0 days ago)
  const messages = [];
  for (let d = 40; d >= 0; d -= 4) messages.push({ id: "a-old-" + d, chat: "c1", role: "assistant", content: "old reply", created: at(d) });
  await s.seed({
    chats: [{ id: "c1", title: "Old chat", created: at(40), updated: at(0) }],
    messages,
    usage: [
      { run: "r1", model: "claude-opus-5-5", ts: at(1), input: 100, output: 200, cacheRead: 5000, cost: 0.5 },
      { run: "r2", model: "claude-sonnet-5-5", ts: at(1), input: 10, output: 20, cost: 0.05 },
      { run: "r3", model: "claude-opus-5-5", ts: at(10), input: 1000, output: 2000, cost: 1 }
    ]
  });

  const u = (await s.api("/api/usage?tz=UTC")).body;
  assert.equal(u.totals.month.replies, 8);
  assert.equal(u.weekly.reduce((a, w) => a + w.replies, 0), 11);
  assert.equal(u.totals.month.tokens, 3330);
  assert.equal(u.totals.month.cached, 5000);
  assert.equal(u.weekly.reduce((a, w) => a + w.tokens, 0), 3330);
  assert.equal(u.daily[28].tokens, 330); // yesterday
  assert.equal(u.daily[19].tokens, 3000); // ten days ago
  assert.equal(u.trackedSince, at(10)); // history before this has replies but no token counts
  assert.deepEqual(u.models.map(m => [m.model, m.tokens]), [["claude-opus-5-5", 3300], ["claude-sonnet-5-5", 30]]);

  // the same data for someone 14 hours ahead of UTC still adds up
  const east = (await s.api("/api/usage?tz=Pacific/Kiritimati")).body;
  assert.equal(east.timeZone, "Pacific/Kiritimati");
  assert.equal(east.totals.month.tokens, 3330);
  assert.equal(east.daily.reduce((a, d) => a + d.tokens, 0), 3330);
});
