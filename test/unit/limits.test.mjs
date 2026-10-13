// Limit resets, as Claude reports them with Claude Code's sign-in, for Plan usage.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resetsFrom, refillEvery } from "../../agent/limits.mjs";

test("limit resets say how many are left, and how often a new one comes when Claude says", () => {
  const u = {
    cedar_ember: {
      eligible: true,
      at_limit: false,
      grants: [
        { id: "weekly", label: "Weekly reset", resets_left: 1, resets_total: 1, usable_now: false, use_requires_limit: true, clears: ["five_hour"], next_grant_at: "2026-10-19T00:00:00Z" },
        { id: "daily", label: "Reset", resets_left: 0, period_days: 1 },
        { label: "no id" }
      ]
    },
    other: { grants: [{ id: "x" }] }
  };
  const r = resetsFrom(u);
  assert.equal(r.length, 1, "only the reset programs Claude reports");
  assert.deepEqual(r[0].grants.map(g => [g.id, g.every, g.left, g.nextAt]), [["weekly", "week", 1, "2026-10-19T00:00:00Z"], ["daily", "day", 0, ""]]);
  assert.equal(refillEvery({ period: "monthly" }), "month");
  assert.equal(refillEvery({ cadence: "every 24h" }), "day");
  assert.equal(refillEvery({ label: "Limit reset" }), "", "nothing said, nothing guessed");
  assert.deepEqual(resetsFrom(null), []);
});
