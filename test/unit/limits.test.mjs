// Limit resets, as Claude reports them with Claude Code's sign-in, for Plan usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetsFrom, refillEvery } from "../../agent/limits.mjs";

test("limit resets say how many are left, which one is next, and how often a new one comes when Claude says", () => {
  const u = {
    cedar_ember: {
      eligible: true,
      at_limit: false,
      next_grant_id: "weekly",
      grants: [
        { id: "weekly", label: "Weekly reset", resets_left: 1, resets_total: 1, usable_now: false, use_requires_limit: true, clears: ["five_hour"], blocking: ["seven_day"], next_grant_at: "2026-10-19T00:00:00Z" },
        { id: "daily", label: "Reset", resets_left: 0, period_days: 1 },
        { id: "no-count" },
        { label: "no id", resets_left: 1 }
      ]
    },
    other: { grants: [{ id: "x", resets_left: 1 }] }
  };
  const r = resetsFrom(u);
  assert.equal(r.length, 1, "only the reset programs Claude reports");
  assert.deepEqual(r[0].grants.map(g => [g.id, g.every, g.left, g.next, g.nextAt]), [["weekly", "week", 1, true, "2026-10-19T00:00:00Z"], ["daily", "day", 0, false, ""]], "a grant without a count is left out, as Claude Code does");
  assert.deepEqual(r[0].grants[0].blocking, ["seven_day"]);
  assert.equal(r[0].grants[1].needsLimit, true, "one that doesn't say needs a limit reached first, as in Claude Code");
  assert.equal(refillEvery({ period: "monthly" }), "month");
  assert.equal(refillEvery({ cadence: "every 24h" }), "day");
  assert.equal(refillEvery({ label: "Limit reset" }), "", "nothing said, nothing guessed");
  assert.deepEqual(resetsFrom(null), []);
});

test("the weekly session reset shows only for accounts Claude offers it to, with when the next one comes", () => {
  const [w] = resetsFrom({ juniper_tide: { eligible: true, arm: "reset", available: true, resets_per_week: 1, next_available_at: null } });
  assert.equal(w.program, "juniper_tide");
  assert.deepEqual(w.grants.map(g => [g.id, g.left, g.usableNow, g.clears.join(), g.every]), [["session", 1, true, "five_hour", "week"]]);
  const [used] = resetsFrom({ juniper_tide: { eligible: true, arm: "reset", available: false, next_available_at: "2026-10-24T00:00:00Z" } });
  assert.deepEqual([used.grants[0].left, used.grants[0].nextAt], [0, "2026-10-24T00:00:00Z"]);
  assert.deepEqual(resetsFrom({ juniper_tide: { eligible: true, arm: "control", available: true } }), []);
  assert.deepEqual(resetsFrom({ juniper_tide: { eligible: false, ineligible_reason: "not_at_wall" } }), []);
});
