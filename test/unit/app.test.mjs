import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(join(ROOT, "site", "app.html"), "utf8");
const script = /<script>\n\(\(\) => \{([\s\S]*)\}\)\(\);\n<\/script>/.exec(html)[1];

test("the page's script parses", () => {
  assert.doesNotThrow(() => new vm.Script("(() => {" + script.replace("__CFG__", "{}") + "})();"));
});

test("every element the script looks up is in the page", () => {
  const ids = new Set([...html.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
  // ids built at run time inside the dialogs' templates
  for (const m of script.matchAll(/\bid="([A-Za-z0-9_-]+)"/g)) ids.add(m[1]);
  const wanted = [...new Set([...script.matchAll(/\$\("([A-Za-z0-9_-]+)"\)/g)].map(m => m[1]))];
  const missing = wanted.filter(id => !ids.has(id));
  assert.deepEqual(missing, []);
});

test("the page loads nothing from anywhere the site's content security policy doesn't allow", () => {
  const external = [...html.matchAll(/(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => new URL(m[1]).host);
  // the only outside file is the code highlighter, from cdnjs; there are no web fonts and no other hosts
  assert.deepEqual([...new Set(external)], ["cdnjs.cloudflare.com"]);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)/);
});

test("the usage chart and token counting are gone", () => {
  assert.doesNotMatch(html, /usagePlot|usageTiles|Est\. cost|viz-bar/);
  assert.doesNotMatch(readFileSync(join(ROOT, "site", "worker.js"), "utf8"), /recordUsage|buildUsage|\/api\/usage/);
});

test("the model button says Choose model, and only models with an effort setting get an effort chooser", () => {
  assert.match(html, /<button class="picker-btn" id="pickerBtn"[^>]*><span>Choose model<\/span>/);
  // the button no longer shows the model or its effort, so nothing in the script writes to those parts
  assert.doesNotMatch(html, /pbName|pbEffort|pbMeter/);
  // the effort chooser is built only when the picked model has efforts; a model without them gets no chooser and no note
  assert.match(script, /\(m\.efforts\.length\s*\? `<div class="effort">[\s\S]*?\s*: ""\)/);
  assert.doesNotMatch(html, /answers without an effort setting/);
  // Haiku is the model without efforts
  assert.match(script, /id: "claude-haiku-5-5"[^\n]*efforts: \[\]/);
});

test("everything the owner can change is behind a confirmation or a typed name", () => {
  assert.match(script, /confirm\(`Delete \$\{CFG\.name\}/);
  assert.match(script, /confirm\(`Set up \$\{SET\.address\}/);
  assert.match(script, /SET\.confirm !== CFG\.name/);
});

test("user-controlled text reaches the page escaped", () => {
  // names, messages, notes and error text go through esc(); tooltips and titles use textContent
  assert.match(script, /function esc\(s\)/);
  for (const needle of ["esc(CFG.name)", "esc(u.source)", "esc(run.message", "esc(n)"]) assert.ok(script.includes(needle), needle);
});
