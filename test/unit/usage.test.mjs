import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUsage, weekStart, addDays, validZone } from "../../site/usage.js";

const at = iso => Date.parse(iso);
const row = (iso, o = {}) => ({ ts: at(iso), model: "claude-opus-5-5", input: 0, output: 0, cache_read: 0, cache_write: 0, cost: 0, ...o });

test("weeks start on Monday", () => {
  assert.equal(weekStart("2026-10-08"), "2026-10-05"); // a Thursday
  assert.equal(weekStart("2026-10-05"), "2026-10-05"); // the Monday itself
  assert.equal(weekStart("2026-10-11"), "2026-10-05"); // Sunday belongs to the week before it
  assert.equal(weekStart("2026-10-12"), "2026-10-12");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
});

test("builds 30 days and 12 weeks ending today, oldest first", () => {
  const u = buildUsage({ rows: [], replyTimes: [], now: at("2026-10-08T12:00:00Z"), timeZone: "UTC" });
  assert.equal(u.daily.length, 30);
  assert.equal(u.weekly.length, 12);
  assert.equal(u.daily[29].key, "2026-10-08");
  assert.equal(u.daily[0].key, "2026-09-09");
  assert.equal(u.weekly[11].key, "2026-10-05");
  assert.equal(u.weekly[0].key, "2026-07-20");
  assert.equal(u.trackedSince, null);
  assert.equal(u.totals.today.key, "2026-10-08");
});

test("days follow the viewer's time zone, not UTC", () => {
  const now = at("2026-10-08T20:00:00Z"); // 13:00 on Oct 8 in Los Angeles
  const rows = [
    row("2026-10-09T05:30:00Z", { output: 100 }), // 22:30 Oct 8 in LA, but already Oct 9 in UTC
    row("2026-10-08T07:30:00Z", { output: 10 }) // 00:30 Oct 8 in LA
  ];
  const la = buildUsage({ rows, replyTimes: [], now, timeZone: "America/Los_Angeles" });
  assert.equal(la.today, "2026-10-08");
  assert.equal(la.totals.today.output, 110);
  const utc = buildUsage({ rows, replyTimes: [], now: at("2026-10-09T06:00:00Z"), timeZone: "UTC" });
  assert.equal(utc.today, "2026-10-09");
  assert.equal(utc.totals.today.output, 100);
});

test("tokens are input plus output, with cache writes counted as input and cache reads kept apart", () => {
  const rows = [row("2026-10-08T10:00:00Z", { input: 10, output: 20, cache_write: 5, cache_read: 1000, cost: 0.5 }), row("2026-10-08T11:00:00Z", { input: 1, output: 2, cost: 0.25 })];
  const u = buildUsage({ rows, replyTimes: [at("2026-10-08T10:00:00Z"), at("2026-10-08T11:00:00Z")], now: at("2026-10-08T12:00:00Z"), timeZone: "UTC" });
  const d = u.totals.today;
  assert.equal(d.input, 16);
  assert.equal(d.output, 22);
  assert.equal(d.tokens, 38);
  assert.equal(d.cached, 1000);
  assert.equal(d.cost, 0.75);
  assert.equal(d.replies, 2);
});

test("a day lands in both its daily bar and its week, and old data drops out of the range", () => {
  const rows = [row("2026-10-05T00:30:00Z", { output: 7 }), row("2026-10-08T00:30:00Z", { output: 3 }), row("2026-01-01T00:00:00Z", { output: 999 }), row("2026-09-15T00:00:00Z", { output: 50 })];
  const u = buildUsage({ rows, replyTimes: [], now: at("2026-10-08T12:00:00Z"), timeZone: "UTC" });
  assert.equal(u.totals.week.output, 10);
  assert.equal(u.weekly[11].output, 10);
  assert.equal(u.daily.find(d => d.key === "2026-09-15").output, 50);
  assert.equal(u.totals.month.output, 60); // Sep 15 is inside 30 days, Jan 1 is not
  assert.equal(u.weekly.reduce((a, w) => a + w.output, 0), 60);
  assert.equal(u.trackedSince, at("2026-01-01T00:00:00Z"));
});

test("replies are counted from history even before any usage was recorded", () => {
  const u = buildUsage({ rows: [], replyTimes: [at("2026-10-07T10:00:00Z"), at("2026-10-07T11:00:00Z"), at("2026-10-08T09:00:00Z"), NaN], now: at("2026-10-08T12:00:00Z"), timeZone: "UTC" });
  assert.equal(u.daily[28].replies, 2);
  assert.equal(u.totals.today.replies, 1);
  assert.equal(u.totals.week.replies, 3);
  assert.equal(u.totals.month.replies, 3);
});

test("models are ranked by tokens", () => {
  const rows = [row("2026-10-08T10:00:00Z", { model: "claude-haiku-5-5", output: 5 }), row("2026-10-08T10:00:00Z", { model: "claude-opus-5-5", output: 50 }), row("2026-10-08T11:00:00Z", { model: "claude-opus-5-5", output: 50 })];
  const u = buildUsage({ rows, replyTimes: [], now: at("2026-10-08T12:00:00Z"), timeZone: "UTC" });
  assert.deepEqual(u.models.map(m => [m.model, m.tokens]), [["claude-opus-5-5", 100], ["claude-haiku-5-5", 5]]);
});

test("hostile numbers and zones can't break the series", () => {
  assert.equal(validZone("Not/AZone"), "UTC");
  assert.equal(validZone("x".repeat(200)), "UTC");
  assert.equal(validZone(undefined), "UTC");
  assert.equal(validZone("Asia/Kolkata"), "Asia/Kolkata");
  const rows = [row("2026-10-08T10:00:00Z", { input: -5, output: Infinity, cache_read: NaN, cost: "9" }), { ts: "x" }];
  const u = buildUsage({ rows, replyTimes: [], now: at("2026-10-08T12:00:00Z"), timeZone: "Not/AZone" });
  assert.equal(u.timeZone, "UTC");
  assert.equal(u.totals.today.tokens, 0);
  assert.equal(u.totals.today.cost, 0);
});
