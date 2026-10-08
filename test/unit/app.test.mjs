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

test("the model and effort choosers sit under the message box, show their current choice, and Haiku has no effort chooser", () => {
  // the buttons are in the bar under the text, not in the top bar, and show the model and effort rather than a fixed label
  assert.match(html, /<div class="c-row">[\s\S]*id="modelBtn"[\s\S]*id="effortBtn"[\s\S]*id="ctxBtn"[\s\S]*id="sendBtn"/);
  assert.doesNotMatch(html, /pickerBtn|picker-btn|renderPickerBtn/);
  assert.match(script, /\$\("modelName"\)\.textContent = m\.name/);
  assert.match(script, /\$\("effortName"\)\.textContent = EFF_LABEL\[e\]/);
  // Haiku is the model without efforts, and its chooser is hidden rather than shown empty
  assert.match(script, /id: "claude-haiku-5-5"[^\n]*efforts: \[\]/);
  assert.match(script, /\$\("effortBtn"\)\.hidden = !m\.efforts\.length/);
  assert.doesNotMatch(html, /answers without an effort setting/);
});

test("the bar has add file, the Claude / Claude Code switch and permission mode on the left, and no record button", () => {
  const left = /<div class="c-row">([\s\S]*?)<div class="c-right">/.exec(html)[1];
  assert.ok(left.indexOf('id="attachBtn"') < left.indexOf('id="modes"') && left.indexOf('id="modes"') < left.indexOf('id="permBtn"'));
  assert.match(left, /data-mode="claude"[\s\S]*data-mode="code"/);
  assert.doesNotMatch(html, /record|dictat|microphone|id="mic/i);
  // what is sent says which mode and permission mode it is
  assert.match(script, /mode: modeNow\(\), perm: S\.perm/);
  // the permission modes are only ones Claude Code can run without anyone to ask
  assert.deepEqual([...script.matchAll(/\{ id: "(auto|acceptEdits|plan)", name:/g)].map(m => m[1]), ["auto", "acceptEdits", "plan"]);
  assert.doesNotMatch(script, /bypassPermissions/);
});

test("on a phone the Claude / Claude Code switch and permission mode get a row of their own at the bottom of the box", () => {
  // the mode controls are one group, a sibling of add file and the right-hand controls, so CSS can move just them
  assert.match(html, /<\/button>\s*<input type="file" id="fileInput" multiple hidden>\s*<div class="c-modes">[\s\S]*?id="modes"[\s\S]*?id="permBtn"[\s\S]*?<div class="c-right">/);
  const phone = /@media \(max-width:700px\)\{([\s\S]*?)\n\}/.exec(html)[1];
  assert.match(phone, /\.c-modes\{order:3;flex:1 1 100%/, "after everything else, taking a whole row");
  assert.match(phone, /\.c-right\{order:2\}/);
  assert.match(phone, /\.modes \.pre\{display:inline\}/, "there is room for the full name down there");
});

test("there is no pencil in the top corner", () => {
  assert.doesNotMatch(html, /newChatTop/);
  // New chat is still in the sidebar
  assert.match(html, /id="newChat"/);
});

test("the context ring is drawn from the last reply and warns only when nearly full", () => {
  assert.match(html, /id="ctxBar"[^>]*stroke-dasharray="56\.549"/);
  assert.match(script, /S\.ctx = ctxOf\(m\.meta\)/);
  assert.match(script, /f >= 0\.92 \? " high" : f >= 0\.8 \? " mid" : ""/);
});

test("there is no AI name anywhere in the page", () => {
  assert.doesNotMatch(html, /calls itself|aiName|CFG\.ai\b|fAi\b/);
});

test("the theme buttons in Settings say what is picked each time they are drawn, with no extra line under Theme", () => {
  assert.doesNotMatch(html, /This browser only/);
  assert.match(script, /data-theme-set="\$\{k\}" class="\$\{k === curTheme \? "on" : ""\}" aria-pressed="\$\{k === curTheme\}"/);
});

test("a finished update asks to be confirmed and reloads, with no link and no X", () => {
  assert.match(script, /data-act="reload">Confirm update<\/button>/);
  assert.doesNotMatch(script, /Open the updated site|\?updated=/);
  assert.match(script, /if \(act === "reload"\) return location\.reload\(\)/);
  // the dialog's X is hidden while a job's page is showing
  assert.match(script, /\$\("setClose"\)\.style\.display = run \|\| UP\.gone \? "none" : ""/);
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
