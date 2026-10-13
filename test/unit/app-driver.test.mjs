// The free plan's pieces that don't need a browser: model ids, how a reply being written is passed on, claude.ai's usage
// reading, free resets, and where the Claude app and a browser are looked for. The page side is tested end to end, in a real
// Chromium, in test/e2e/app.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { modelId, textChange, limitsFromUsage, resetsFrom, refillEvery, claudeAppPath, browserPath, PAGE_LIB } from "../../agent/app.mjs";

test("the Claude app's model names become the same ids Claude Code's models have", () => {
  assert.equal(modelId("Opus 5.5"), "claude-opus-5-5");
  assert.equal(modelId("Claude Sonnet 4.5"), "claude-sonnet-4-5");
  assert.equal(modelId("  Haiku  5.5 "), "claude-haiku-5-5");
  assert.equal(modelId(""), "");
  assert.equal(modelId("<script>"), "claude-script", "only letters, numbers and dashes");
});

test("a reply being written is passed on as what was added, or whole when something earlier changed", () => {
  assert.equal(textChange("Hello", "Hello"), null);
  assert.deepEqual(textChange("Hello", "Hello there"), { type: "delta", text: " there" });
  assert.deepEqual(textChange("", "Hi"), { type: "delta", text: "Hi" });
  // a list or a table changes shape as it fills in
  assert.deepEqual(textChange("a b\n\nc", "| a | b |\n| --- | --- |\n| c |"), { type: "replace", text: "| a | b |\n| --- | --- |\n| c |" });
});

test("claude.ai's own usage reading becomes the plan's windows, and a full one is a limit until it resets", () => {
  const at = new Date(Date.now() + 3600e3).toISOString();
  const week = new Date(Date.now() + 5 * 86400e3).toISOString();
  assert.deepEqual(limitsFromUsage({ five_hour: { utilization: 37, resets_at: at }, seven_day: { utilization: 12.5, resets_at: week } }), { windows: { five_hour: { pct: 37, resetsAt: Math.round(Date.parse(at) / 1000) }, seven_day: { pct: 12.5, resetsAt: Math.round(Date.parse(week) / 1000) } }, status: "allowed" });
  const full = limitsFromUsage({ five_hour: { utilization: 100, resets_at: at }, seven_day: { utilization: 40, resets_at: week } });
  assert.equal(full.status, "rejected");
  assert.equal(full.rateLimitType, "five_hour");
  assert.equal(full.resetsAt, Math.round(Date.parse(at) / 1000));
  assert.equal(full.overageStatus, "rejected", "the free plan has no usage credits to carry on with");
  for (const junk of [null, "x", {}, { five_hour: { utilization: "lots", resets_at: at } }, { five_hour: { utilization: 3, resets_at: "soon" } }]) assert.equal(limitsFromUsage(junk), null, JSON.stringify(junk));
});

test("free resets say how many are left, and how often a new one comes when Claude says", () => {
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

test("the Claude app and a browser are found where they're installed, and a test can say where", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-find-"));
  const app = join(dir, "Claude");
  writeFileSync(app, "");
  assert.equal(claudeAppPath({ CLAUDECONNECT_CLAUDE_APP: app }), app);
  assert.equal(claudeAppPath({ CLAUDECONNECT_CLAUDE_APP: "" }), "", "none, on purpose");
  assert.equal(claudeAppPath({ CLAUDECONNECT_CLAUDE_APP: join(dir, "missing") }), "");
  assert.equal(browserPath({ CLAUDECONNECT_BROWSER: app }), app);
  assert.equal(browserPath({ CLAUDECONNECT_BROWSER: "" }), "");
  if (process.platform === "win32") {
    // the newest app-<version> folder of a Squirrel install comes first, so arguments reach the app itself
    const local = join(dir, "Local");
    for (const v of ["app-0.9.3", "app-0.10.1"]) {
      mkdirSync(join(local, "AnthropicClaude", v), { recursive: true });
      writeFileSync(join(local, "AnthropicClaude", v, "claude.exe"), "");
    }
    assert.equal(claudeAppPath({ LOCALAPPDATA: local }, dir), join(local, "AnthropicClaude", "app-0.10.1", "claude.exe"));
  }
});

test("the page code is one self-contained piece that defines nothing on the page but its own name", () => {
  assert.match(PAGE_LIB, /^var __cc = \(function pageLib\(\) \{/);
  // it never touches the page's own code, storage or cookies beyond reading which organization is signed in
  assert.doesNotMatch(PAGE_LIB, /localStorage|sessionStorage|document\.cookie\s*=|eval\(|new Function/);
  assert.doesNotMatch(PAGE_LIB, /Runtime\.enable/);
  // it parses
  assert.doesNotThrow(() => new Function(PAGE_LIB));
});
