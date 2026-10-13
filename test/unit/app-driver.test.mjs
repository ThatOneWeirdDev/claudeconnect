// The free plan's pieces that don't need a browser: model ids, how a reply being written is passed on, claude.ai's usage
// reading, free resets, and where the Claude app is looked for. The page side is tested end to end, in a real
// Chromium, in test/e2e/app.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as driver from "../../agent/app.mjs";
const { modelId, textChange, limitsFromUsage, resetsFrom, refillEvery, claudeAppPath, PAGE_LIB } = driver;

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

test("the Claude app is found where it's installed, a test can say where, and there's no browser to fall back on", () => {
  const dir = mkdtempSync(join(tmpdir(), "cc-find-"));
  const app = join(dir, "Claude");
  writeFileSync(app, "");
  assert.equal(claudeAppPath({ CLAUDECONNECT_CLAUDE_APP: app }), app);
  assert.equal(claudeAppPath({ CLAUDECONNECT_CLAUDE_APP: "" }), "", "none, on purpose");
  assert.equal(claudeAppPath({ CLAUDECONNECT_CLAUDE_APP: join(dir, "missing") }), "");
  // claude.ai in a browser window never gets past Cloudflare's human check when it's driven, so the app is required
  assert.equal(driver.browserPath, undefined);
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

test("the app's limit notice says when free messages come back, in this computer's time", () => {
  const now = new Date(2026, 9, 13, 14, 30); // a Tuesday, 2:30 PM
  const at = (d, h, m = 0) => Math.round(new Date(2026, 9, d, h, m).getTime() / 1000);
  const { resetFromNotice } = driver;
  assert.equal(resetFromNotice("You're out of free messages until 4:00 PM", now), at(13, 16));
  assert.equal(resetFromNotice("You're out of free messages until 9:00 AM", now), at(14, 9), "a time already gone today is tomorrow");
  assert.equal(resetFromNotice("You are out of free messages until tomorrow at 9 AM", now), at(14, 9));
  assert.equal(resetFromNotice("Out of messages until Thursday 4:00 PM", now), at(15, 16));
  assert.equal(resetFromNotice("Out of messages until Tuesday 1:00 PM", now), at(20, 13), "this weekday, gone already: next week");
  assert.equal(resetFromNotice("Your limit resets at 12:15 AM", now), at(14, 0, 15));
  assert.equal(resetFromNotice("Your limit resets at 17:00", now), at(13, 17));
  for (const junk of ["", "Upgrade to Pro", "until 13:00 PM", "until 25:00"]) assert.equal(resetFromNotice(junk, now), null, junk);
});

// ---- the driver that goes through macOS Accessibility or Windows UI Automation (agent/app-os.mjs): a reply comes back as
// a tree of what the page shows, and is turned back into Markdown
import { markdown, ascii } from "../../agent/app-os.mjs";
const tx = v => ({ r: "text", v });
const g = (...k) => ({ r: "group", k });

test("a reply read through accessibility comes back as the Markdown it was written in", () => {
  const reply = g(
    g(tx("Hello "), { r: "strong", k: [tx("there")] }, tx(", see "), { r: "link", u: "https://example.com/a", k: [tx("this")] }, tx(" and "), { r: "code", k: [tx("x = 1")] }, tx(".")),
    { r: "heading", l: 3, k: [tx("Steps")] },
    { r: "list", k: [g({ r: "marker", v: "1." }, tx("first")), g({ r: "marker", v: "2." }, g(tx("second, with "), { r: "em", k: [tx("feeling")] }), { r: "list", k: [g({ r: "marker", v: "•" }, tx("inner"))] })] },
    g(g(tx("js"), { r: "button" }), g({ r: "code", c: "language-js", k: [tx("const a = 1;\n"), tx("console.log(a);\n")] })),
    { r: "table", k: [{ r: "row", k: [{ r: "cell", k: [tx("A")] }, { r: "cell", k: [tx("B|C")] }] }, { r: "column", k: [{ r: "cell", k: [tx("A")] }] }, { r: "row", k: [{ r: "cell", k: [tx("1")] }, { r: "cell", k: [tx("2")] }] }] },
    { r: "separator" },
    g(tx("Done."))
  );
  assert.equal(
    markdown(reply),
    "Hello **there**, see [this](https://example.com/a) and `x = 1`.\n\n### Steps\n\n1. first\n2. second, with *feeling*\n   - inner\n\n```js\nconst a = 1;\nconsole.log(a);\n```\n\n| A | B\\|C |\n| --- | --- |\n| 1 | 2 |\n\n---\n\nDone."
  );
});

test("a reply's buttons, pictures and empty parts leave nothing behind, and an empty reply is empty", () => {
  assert.equal(markdown(null), "");
  assert.equal(markdown(g()), "");
  assert.equal(markdown(g({ r: "button" }, g({ r: "image" }), g(tx("  ")), g(tx("Only this")))), "Only this");
  // a heading's level defaults when the system doesn't say (Windows), and a bare link stays a bare address
  assert.equal(markdown(g({ r: "heading", k: [tx("Title")] }, g({ r: "link", u: "https://a.example/", k: [tx("https://a.example/")] }))), "## Title\n\nhttps://a.example/");
});

test("lines to the helpers are pure ASCII, so a line never breaks partway through a character", () => {
  const s = ascii(JSON.stringify({ text: "héllo 👋 “quotes”" }));
  assert.match(s, /^[\x20-\x7e]*$/);
  assert.deepEqual(JSON.parse(s), { text: "héllo 👋 “quotes”" });
});
