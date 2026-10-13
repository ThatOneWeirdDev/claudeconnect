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
  // what the page loads (scripts, styles, images, frames); links someone clicks to go to claude.ai don't count
  const external = [...html.matchAll(/<(?:script|link|img|iframe|source)\b[^>]*?(?:src|href)="(https?:\/\/[^"]+)"/g)].map(m => new URL(m[1]).host);
  // the only outside file is the code highlighter, from cdnjs; there are no web fonts and no other hosts
  assert.deepEqual([...new Set(external)], ["cdnjs.cloudflare.com"]);
  assert.doesNotMatch(html, /fonts\.(googleapis|gstatic)/);
});

test("the usage chart and token counting are gone", () => {
  assert.doesNotMatch(html, /usagePlot|usageTiles|Est\. cost|viz-bar/);
  assert.doesNotMatch(readFileSync(join(ROOT, "site", "worker.js"), "utf8"), /recordUsage|buildUsage|\/api\/usage/);
});

test("the model switcher is at the top, like ChatGPT's: the model and its effort, and every model has every effort", () => {
  // one button in the top bar with the model, then the effort in grey; no effort button or stairs anywhere else
  assert.match(html, /<header class="top">[\s\S]*?<button class="ms" id="modelBtn"[^>]*><span id="modelName">[^<]*<\/span><span class="sub" id="effortName">[\s\S]*?<\/header>/);
  assert.doesNotMatch(html, /id="effortBtn"|id="effortMenu"|class="stairs"|pickerBtn|picker-btn|renderPickerBtn|id="topTitle"/);
  assert.match(script, /put\("modelName", m\.name\)/);
  assert.match(script, /put\("effortName", EFF_LABEL\[e\]\)/);
  // a model with no effort setting has nothing after its name
  assert.match(script, /\$\("effortName"\)\.hidden = !effortsOf\(m\)\.length/);
  // Claude Code gives every model every effort now, Haiku 5.5 included; Ultracode only when the computer's Claude Code knows it
  assert.deepEqual([...script.matchAll(/\{ id: "(claude-[a-z0-9-]+)",[^\n]*efforts: (\w+), def: "(\w+)"/g)].map(m => [m[1], m[2], m[3]]), [["claude-fable-5-1", "EFF", "high"], ["claude-opus-5-5", "EFF", "medium"], ["claude-sonnet-5-5", "EFF", "medium"], ["claude-haiku-5-5", "EFF", "medium"]]);
  assert.match(script, /const EFF = \["low", "medium", "high", "xhigh", "max", "ultracode"\];/);
  assert.match(script, /e !== "ultracode" \|\| !!\(S\.state && S\.state\.agent && S\.state\.agent\.ultracode\)/);
  assert.doesNotMatch(html, /answers without an effort setting/);
});

test("the model switcher's menu has an Effort section with every level, and Ultracode only when the computer has it", () => {
  const models = /const ALL_MODELS = (\[[\s\S]*?\n\]);/.exec(script)[1];
  const eff = /const EFF = (\[[^\]]*\]);/.exec(script)[1];
  const labels = /const EFF_LABEL = (\{[^}]*\});/.exec(script)[1];
  const ctx = { TICK: "", DEFAULT_MODEL: "claude-opus-5-5", S: { efforts: {}, state: { agent: { online: true, ultracode: true } } }, modelNow: () => "claude-opus-5-5" };
  vm.runInNewContext(`const EFF = ${eff}; const EFF_LABEL = ${labels}; const ALL_MODELS = ${models}; const MODELS_BY_ID = Object.fromEntries(ALL_MODELS.map(m => [m.id, m]));` + ["modelOf", "effortsOf", "effortFor", "pmRow", "popEffort"].map(lift).join("") + "this.popEffort = popEffort;", ctx);
  let menu = ctx.popEffort();
  assert.match(menu, /^<hr><div class="mh">Effort<\/div>/, "under the models, after a line");
  assert.deepEqual([...menu.matchAll(/data-effort="(\w+)"/g)].map(m => m[1]), ["low", "medium", "high", "xhigh", "max", "ultracode"]);
  assert.match(menu, /data-effort="medium"[^>]*aria-checked="true"/, "the model's default is ticked");
  assert.match(menu, /<b>Extra high<\/b>/);
  assert.match(menu, /<b>Ultracode<\/b><small>Extra high effort, and big tasks are split across many agents working at once\. Uses much more of your plan\.<\/small>/);
  ctx.S.efforts["claude-opus-5-5"] = "ultracode";
  assert.match(ctx.popEffort(), /data-effort="ultracode"[^>]*aria-checked="true"/);
  ctx.S.state.agent.ultracode = false;
  menu = ctx.popEffort();
  assert.doesNotMatch(menu, /ultracode/i, "a computer whose Claude Code doesn't know it");
  assert.match(menu, /data-effort="medium"[^>]*aria-checked="true"/, "and a stored Ultracode falls back to the default");
  // a pick there changes the effort of the model that's picked, and the switcher shows it
  assert.match(script, /const eff = e\.target\.closest\("\[data-effort\]"\);\n  if \(eff\) return pick\(\(\) => \{ S\.efforts\[modelNow\(\)\] = eff\.dataset\.effort;/);
  assert.match(lift("popModel"), /popEffort\(\) \+ noteHtml\(\)/);
});

test("the message box is one row like ChatGPT's: + on the left, the permission pill, ring and send on the right; no mode switch and no record button", () => {
  const lead = /<div class="c-lead">([\s\S]*?)<\/div>/.exec(html)[1];
  assert.ok(lead.indexOf('id="attachBtn"') >= 0, "+ on the left");
  assert.doesNotMatch(html, /id="thinkBtn"/, "the free plan's Thinking pill went with it");
  const trail = /<div class="c-trail">([\s\S]*?)<\/form>/.exec(html)[1];
  const at = id => trail.indexOf(`id="${id}"`);
  assert.ok(at("permBtn") >= 0 && at("permBtn") < at("ctxBtn") && at("ctxBtn") < at("sendBtn"), "the permission pill, the context ring, then send");
  assert.match(html, /<textarea id="input" rows="1" placeholder="Ask anything"/);
  assert.match(html, /\.composer\{display:grid;grid-template-columns:auto minmax\(0,1fr\) auto;grid-template-areas:"lead main trail";[^}]*min-height:56px;padding:10px;border-radius:28px/);
  assert.match(html, /\.composer\.tall\{grid-template-areas:"chips chips chips" "main main main" "lead \. trail"/);
  assert.match(html, /\.msg \.think\{/);
  // everything runs as Claude Code: there's nothing to switch between
  assert.doesNotMatch(html, /data-mode=|id="modes"|MODE_NAME|modeNow|Plain chat with Claude/);
  assert.doesNotMatch(html, /record|dictat|microphone|id="mic/i);
  // what is sent says which permission mode it is, and no mode
  assert.match(script, /JSON\.stringify\(\{ chatId: S\.chatId, text, model, effort, perm: permNow\(\), files:/);
  // the permission modes are ones Claude Code can run on its own, and "Ask first", which asks on this page
  assert.deepEqual([...script.matchAll(/\{ id: "(auto|default|acceptEdits|plan)", name:/g)].map(m => m[1]), ["auto", "default", "acceptEdits", "plan"]);
  assert.match(script, /\{ id: "default", name: "Ask first",[^\n]*ask: true \}/);
  assert.match(script, /function permsShown\(\) \{ const a = agentNow\(\); return PERM_MODES\.filter\(x => !x\.ask \|\| \(a && a\.ask\)\); \}/, "only when the computer can ask");
  assert.doesNotMatch(script, /bypassPermissions/);
});

test("the message box grows to two rows only when the text wraps or files are attached, and goes back to one row once it's empty", () => {
  const cls = new Set();
  const box = { classList: { contains: c => cls.has(c), toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), add: c => cls.add(c) } };
  const input = { value: "", scrollHeight: 24, style: {} };
  const ctx = { $: () => box, input, S: { files: [] }, window: { innerHeight: 900 } };
  vm.runInNewContext(lift("grow") + "this.grow = grow;", ctx);
  ctx.grow();
  assert.equal(cls.has("tall"), false, "empty");
  input.value = "hi";
  ctx.grow();
  assert.equal(cls.has("tall"), false, "one line");
  input.value = "a line long enough to wrap";
  input.scrollHeight = 48;
  ctx.grow();
  assert.equal(cls.has("tall"), true, "wraps");
  input.scrollHeight = 28;
  ctx.grow();
  assert.equal(cls.has("tall"), true, "stays open while there's text, so it doesn't jump back and forth");
  assert.equal(input.style.height, "28px");
  input.value = "";
  input.scrollHeight = 24;
  ctx.grow();
  assert.equal(cls.has("tall"), false, "cleared");
  ctx.S.files = [{ name: "a.txt" }];
  ctx.grow();
  assert.equal(cls.has("tall"), true, "attached files show above the text");
  ctx.S.files = [];
  input.value = "a\nb";
  ctx.grow();
  assert.equal(cls.has("tall"), true, "a line break");
  // a phone keeps the same one row: nothing moves the controls onto rows of their own
  assert.doesNotMatch(html, /c-modes|c-right|c-row|@media \(max-width:700px\)/);
  assert.match(lift("renderChips"), /grow\(\);/);
});

test("the colours are ChatGPT's, and the two dark blocks (System when the computer is dark, and Dark) are the same", () => {
  const light = /:root\{\n([\s\S]*?)\n\}/.exec(html)[1];
  const system = /@media \(prefers-color-scheme:dark\)\{\n  :root:not\(\[data-theme="light"\]\)\{\n([\s\S]*?)\n  \}\n\}/.exec(html)[1];
  const forced = /:root\[data-theme="dark"\]\{\n([\s\S]*?)\n\}/.exec(html)[1];
  const tidy = b => b.split("\n").map(l => l.trim()).join("\n");
  assert.equal(tidy(system), tidy(forced));
  // a few of the values that make it look like ChatGPT: the page, the sidebar, the text, the user's bubble, send
  for (const v of ["--surface:#ffffff", "--surface-2:#f9f9f9", "--text:#0d0d0d", "--text-2:#5d5d5d", "--user:rgba(233,233,233,.5)", "--solid:#000000", "--solid-off:#d7d7d7"]) assert.ok(light.includes(v), v);
  for (const v of ["--surface:#212121", "--surface-2:#181818", "--text:#ffffff", "--composer:#303030", "--user:rgba(50,50,50,.85)", "--solid:#ffffff", "--solid-off:#676767"]) assert.ok(forced.includes(v), v);
  // every variable used in light is set again for dark
  const names = b => [...b.matchAll(/(--[\w-]+):/g)].map(m => m[1]).sort();
  assert.deepEqual(names(forced), names(light).filter(n => n !== "--mono"));
  // OpenAI's syntax colours, through highlight.js's classes
  assert.match(html, /\.hljs-keyword,[^{]*\{color:var\(--hl-2\)\}/);
  assert.match(html, /\.hljs-string,[^{]*\{color:var\(--hl-3\)\}/);
  assert.match(html, /\.hljs-title,[^{]*\{color:var\(--hl-1\)\}/);
  assert.match(html, /\.hljs-number,[^{]*\{color:var\(--hl-5\)\}/);
});

test("the icons are ChatGPT's filled 24px glyphs, drawn at 20px", () => {
  const icons = /const I = \{\n([\s\S]*?)\n\};/.exec(script)[1];
  const lines = icons.split(",\n");
  assert.ok(lines.length >= 25);
  for (const l of lines) assert.match(l, /^  \w+: '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">/, l.slice(0, 40));
  assert.doesNotMatch(icons, /stroke-width/);
  // and the ones in the page itself: the sidebar, the top bar, the message box
  for (const id of ["hideSide", "newChat", "openSide", "attachBtn", "sendBtn", "jump", "chatMore"]) {
    assert.match(html, new RegExp(`id="${id}"[^>]*>(?:<i></i>)?<svg viewBox="0 0 24 24" fill="currentColor"`), id);
  }
});

test("the page calls its assistant by the site's name, never Claude", () => {
  assert.ok(script.includes('$("legal").textContent = `${CFG.name} can make mistakes. Check important info.`;'));
  const ui = html.split("\n").filter(l => !/^\s*(\/\/|\/\*)/.test(l)).join("\n"); // what shows, not the notes in the code
  assert.doesNotMatch(ui, /Claude can make mistakes|Claude Code is waiting|Claude thinks longer|Claude gives you|Claude says|folder Claude work|Claude Code decides|· Claude app`/);
  // nothing that shows says Claude at all: the desktop app, your plan and your account need no product name, and the
  // links to claude.ai keep saying where to go
  const shown = ui.replace(/claude\.ai|ClaudeConnect|claude-[a-z0-9-]+|claude auth login/g, "");
  assert.deepEqual(shown.split("\n").filter(l => /Claude/.test(l)).map(l => l.trim().slice(0, 80)), []);
});

test("the top bar has the model switcher, the update button and the chat's ⋯; the sidebar has ChatGPT's shortcuts", () => {
  const top = /<header class="top">([\s\S]*?)<\/header>/.exec(html)[1];
  const at = id => top.indexOf(`id="${id}"`);
  assert.ok(at("openSide") < at("modelBtn") && at("modelBtn") < at("updatePill") && at("updatePill") < at("chatMore"));
  // the update button is a plain one in the top bar (ChatGPT's ghost button), and only an icon on a phone
  assert.match(lift("renderPill"), /else if \(updateAvailable\(u\)\) \{ text = "Update"; short = ""; \}/);
  assert.match(html, /\.pill\.solo\{width:40px;padding:0;justify-content:center\}/);
  // the chat's ⋯ is there in a chat, with the same Rename and Delete as its row in the sidebar
  assert.match(lift("renderBar"), /\$\("chatMore"\)\.hidden = !S\.chatId;/);
  assert.match(script, /\$\("chatMore"\)\.onclick = e => \{ e\.stopPropagation\(\); if \(S\.chatId\) chatMenu\(\$\("chatMore"\), S\.chatId, true, e\.detail === 0\); \};/);
  assert.match(script, /chatMenu\(more, more\.dataset\.more, false, e\.detail === 0\);/);
  // Ctrl+Shift+O (⇧⌘O) starts a chat and Ctrl+K (⌘K) searches, shown next to the two in the sidebar
  assert.match(html, /<kbd data-keys="shift\+o" aria-hidden="true">Ctrl Shift O<\/kbd>/);
  assert.match(html, /<kbd data-keys="k" aria-hidden="true">Ctrl K<\/kbd>/);
  assert.match(script, /if \(k === "o" && e\.shiftKey\) \{\n    e\.preventDefault\(\);\n    newChat\(true\);/);
  assert.match(script, /\} else if \(k === "k" && !e\.shiftKey\) \{[\s\S]*?\$\("search"\)\.focus\(\);/);
});

test("a message, a reply and a code block are laid out like ChatGPT's", () => {
  // a bubble that wraps gets more room around its text
  const els = [];
  const bubble = (h, multi, text) => { const c = new Set(multi ? ["multi"] : []); const b = { offsetHeight: h, textContent: text || "x", classList: { contains: k => c.has(k), toggle: (k, on) => (on ? c.add(k) : c.delete(k)) }, c }; els.push(b); return b; };
  const one = bubble(36), two = bubble(72), back = bubble(48, true), hidden = bubble(0);
  const ctx = { $: () => ({ querySelectorAll: () => els }) };
  vm.runInNewContext(lift("fitBubbles") + "fitBubbles();", ctx);
  assert.equal(one.c.has("multi"), false);
  assert.equal(two.c.has("multi"), true);
  assert.equal(back.c.has("multi"), false, "a bubble of one line with the wider padding goes back to the narrow one");
  assert.equal(hidden.c.has("multi"), false, "not measured while it isn't shown");
  assert.match(html, /\.bubble\{max-width:70%;background:var\(--user\);padding:6px 16px;border-radius:18px;[^}]*line-height:24px\}/);
  assert.match(html, /\.bubble\.multi\{padding:12px 16px\}/);
  // the code block's header is the block's own colour and says "Copy code"
  assert.match(script, /<button type="button" data-copy-code>\$\{I\.copy\}<span>Copy code<\/span><\/button>/);
  assert.match(html, /\.code-head\{position:sticky;top:0;[^}]*background:var\(--code\)/);
  // tables have no box around them, just lines between the rows
  assert.match(html, /\.md \.table\{overflow-x:auto;margin:2em 0\}/);
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

test("a finished update has nothing to confirm: the page moves to the new version by itself, with a Reload button if it can't", () => {
  assert.doesNotMatch(script, /Confirm update|Confirm the update/);
  assert.doesNotMatch(script, /Open the updated site|\?updated=/);
  assert.match(script, /data-act="reload">Reload now<\/button>/);
  assert.match(script, /if \(act === "reload"\) return reloadNow\(\)/);
  // after every poll that finds the page behind the site
  assert.match(script, /if \(pageIsStale\(\)\) maybeReload\(/);
  // the update screen can always be closed, and it doesn't open by itself on pages that didn't start it
  assert.match(script, /\$\("setClose"\)\.style\.display = "";/);
  assert.doesNotMatch(script, /What's coming/);
  assert.match(script, /if \(run && run\.state === "running" && UP\.seen !== run\.id\) UP\.seen = run\.id;/);
});

// The functions are lifted out of the page and run against stand-ins for the parts of the page they touch.
function lift(name) {
  const m = new RegExp(`(?:async )?function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}\\n`).exec(script);
  assert.ok(m, name + " is in the page");
  return m[0];
}
function reloader(over = {}) {
  const log = { reloads: 0, timers: [], stored: {} };
  const ctx = {
    UP: { data: { current: "1.6.0" }, gone: null, reloadTimer: null },
    S: { files: [], busy: false, live: null },
    SET: { draft: null },
    run: null,
    isDirty: () => false,
    upRun: () => ctx.run,
    pageIsStale: () => ctx.UP.data.current !== "1.5.0",
    $: () => ({ value: "" }),
    sessionStorage: { getItem: k => log.stored[k] || null, setItem: (k, v) => (log.stored[k] = v) },
    store: { get: (k, d) => (k in log.stored ? log.stored[k] : d), set: (k, v) => (log.stored[k] = v) },
    location: { reload: () => log.reloads++ },
    setTimeout: (f, ms) => (log.timers.push({ f, ms }), log.timers.length),
    clearTimeout: () => {},
    ...over
  };
  vm.runInNewContext(lift("reloadedTo") + lift("reloadNow") + lift("maybeReload") + "this.maybeReload = maybeReload;", ctx);
  // run the timer that was set, as the browser would
  ctx.fire = () => log.timers.pop().f();
  return { ctx, log };
}

test("the page reloads itself into the new version once the update is over, and only when nothing can be lost", () => {
  // up to date: nothing to do
  let r = reloader({ pageIsStale: () => false });
  r.ctx.maybeReload(0);
  assert.equal(r.log.timers.length, 0);

  // behind the site and idle: it reloads, and remembers that it did, in this tab and in this browser
  r = reloader();
  r.ctx.maybeReload(0);
  r.ctx.fire();
  assert.equal(r.log.reloads, 1);
  assert.equal(r.log.stored["gql.reloadedTo"], "1.6.0#1");
  assert.equal(r.log.stored.reloadFor, "1.6.0", "so the notice isn't shown again for this version");
  // if Cloudflare still hands out the old page for a moment, it tries again, further apart, and stops after three
  r.ctx.maybeReload(0);
  assert.equal(r.log.timers[0].ms, 5000);
  r.ctx.fire();
  r.ctx.maybeReload(0);
  assert.equal(r.log.timers[0].ms, 10000);
  r.ctx.fire();
  assert.equal(r.log.reloads, 3);
  r.ctx.maybeReload(0);
  assert.equal(r.log.timers.length, 0, "not a fourth time, so a page that stays old can't loop");

  // nothing is lost: a message being typed, a file attached, a reply on its way, unsaved settings
  for (const [what, over] of [
    ["typed text", { $: () => ({ value: "half a thought" }) }],
    ["an attached file", { S: { files: [{ name: "a.txt" }], busy: false, live: null } }],
    ["a reply being sent", { S: { files: [], busy: true, live: null } }],
    ["a reply streaming", { S: { files: [], busy: false, live: {} } }],
    ["unsaved settings", { SET: { draft: {} }, isDirty: () => true }]
  ]) {
    r = reloader(over);
    r.ctx.maybeReload(0);
    r.ctx.fire();
    assert.equal(r.log.reloads, 0, what + " holds the reload back");
    assert.equal(r.log.timers.length, 1, "and it looks again shortly");
    assert.equal(r.log.timers[0].ms, 2000);
  }

  // while the update is still running, or after it failed, the page stays to show that
  for (const state of ["running", "error"]) {
    r = reloader();
    r.ctx.run = { state };
    r.ctx.maybeReload(0);
    assert.equal(r.log.timers.length, 0, state);
  }
  r = reloader();
  r.ctx.run = { state: "done" };
  r.ctx.maybeReload(0);
  r.ctx.fire();
  assert.equal(r.log.reloads, 1, "a finished one is the cue");
});

test("a deleted or moved site doesn't try to reload itself", () => {
  const r = reloader();
  r.ctx.UP.gone = { kind: "delete" };
  r.ctx.maybeReload(0);
  assert.equal(r.log.timers.length, 0);
});

test("the Updates panel opens once with the patch notes the first time this browser is on a version an update brought", () => {
  const run = (seen, update, extra = {}) => {
    const opened = [];
    const stored = { seenVersion: seen };
    const ctx = {
      CFG: { version: "1.6.0" },
      store: { get: (k, d) => (k in stored && stored[k] !== undefined ? stored[k] : d), set: (k, v) => (stored[k] = v) },
      UP: { data: { whatsNew: update } },
      SET: { justUpdated: false },
      upRun: () => null,
      openSettings: tab => opened.push(tab),
      ...extra
    };
    vm.runInNewContext(lift("announceVersion") + "announceVersion();", ctx);
    return { opened, stored, ctx };
  };
  const brought = { version: "1.6.0", notes: ["A thing"], updated: true };
  let r = run("1.5.0", brought);
  assert.deepEqual(r.opened, ["updates"]);
  assert.equal(r.ctx.SET.justUpdated, true, "the panel says 'Updated to'");
  assert.equal(r.stored.seenVersion, "1.6.0");
  assert.deepEqual(run("1.6.0", brought).opened, [], "once per version");
  assert.deepEqual(run("", brought).opened, ["updates"], "a browser that hasn't recorded a version yet (it was on 1.5) still sees them");
  assert.deepEqual(run("1.5.0", { ...brought, updated: false }).opened, [], "a fresh install has no update to announce");
  assert.deepEqual(run("1.5.0", null).opened, []);
  assert.deepEqual(run("1.5.0", { ...brought, version: "1.7.0" }).opened, [], "notes for some other version");
  assert.deepEqual(run("1.5.0", brought, { upRun: () => ({ state: "running" }) }).opened, [], "not on top of a job");
  assert.equal(run("1.5.0", null).stored.seenVersion, "1.6.0", "recorded either way");
});

test("the Updates panel shows the patch notes of the installed version, the update that is running, and earlier updates", () => {
  assert.match(script, /whatsNewHtml\(u, "What's new"\)/);
  assert.match(script, /whatsNewHtml\(u, "Patch notes"\)/);
  assert.match(script, /<summary>Earlier updates<\/summary>/);
  assert.match(script, /runNotes\(run\)/);
  assert.doesNotMatch(script, /every half hour/);
  // notes are text from the internet: through esc()
  assert.match(script, /function notesList\(notes\) \{\n  return `<ul class="notes">\$\{\(notes \|\| \[\]\)\.map\(n => `<li>\$\{esc\(n\)\}<\/li>`\)/);
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

test("after an update or a settings change, the notice goes once the page has reloaded into it, until the next one", () => {
  const ctx = { UP: { seen: "" }, stale: false };
  ctx.pageIsStale = () => ctx.stale;
  vm.runInNewContext(lift("finishedHere") + "this.finishedHere = finishedHere;", ctx);
  for (const kind of ["update", "settings"]) {
    assert.equal(ctx.finishedHere({ id: "r1", kind, state: "done" }), true, `a finished ${kind} this page loaded after is cleared`);
  }
  ctx.UP.seen = "r1";
  assert.equal(ctx.finishedHere({ id: "r1", kind: "settings", state: "done" }), false, "the page that watched it says Reload until it reloads");
  ctx.UP.seen = "";
  ctx.stale = true;
  assert.equal(ctx.finishedHere({ id: "r1", kind: "update", state: "done" }), false, "a page still on the old version says Updated · Reload");
  ctx.stale = false;
  for (const state of ["running", "error"]) assert.equal(ctx.finishedHere({ id: "r1", kind: "update", state }), false, state + " stays");
  assert.equal(ctx.finishedHere(null), false);
  // and it is cleared on the site too, whether or not Settings is open, so no other device shows it either
  const apply = lift("applyUpdate");
  assert.match(apply, /if \(finishedHere\(run\)\) \{\n    UP\.data = \{ \.\.\.u, run: null \};/);
  assert.match(apply, /api\("\/api\/update\/dismiss"/);
  assert.ok(script.includes('function finishedHere(run) { return !!run && run.state === "done" && !pageIsStale() && UP.seen !== run.id; }'), "settings changes are cleared the same way as updates");
});

test("Plan usage reads the latest as soon as it opens, and has no Refresh button", () => {
  assert.match(lift("openUsage"), /renderUsage\(\);\n  refreshUsage\(\);/);
  assert.doesNotMatch(script, /data-usage="refresh"|data-usage=refresh|I\.retry \+ "Refresh"/);
  // "You've hit a limit" only from the site's own reckoning, which knows about usage credits and resets
  assert.match(script, /if \(l\.limited\) html \+= `<div class="note err">You've hit a limit/);
  assert.doesNotMatch(script, /status === "rejected"/);
});

test("bringing chats over from claude.ai's export is gone, and chats brought over before are cleared", () => {
  assert.doesNotMatch(html, /fImport|importExport|unzipEntry|fromExport|Your chats from claude\.ai|data-act="import"|\["chats", "Chats"|From claude\.ai/);
  const worker = readFileSync(join(ROOT, "site", "worker.js"), "utf8");
  assert.doesNotMatch(worker, /\/api\/import|importChats|importedContext|IMPORT_/);
  assert.match(worker, /this\.sql\.exec\("DELETE FROM chats WHERE origin = 'claude\.ai'"\);/);
});

// The model picker and the bar, lifted out with stand-ins for what they read.
function picker(state, extra = {}) {
  const models = /const ALL_MODELS = (\[[\s\S]*?\n\]);/.exec(script)[1];
  const eff = /const EFF = (\[[^\]]*\]);/.exec(script)[1];
  const labels = /const EFF_LABEL = (\{[^}]*\});/.exec(script)[1];
  const ctx = { TICK: "", I: { info: "", lock: "" }, DEFAULT_MODEL: "claude-opus-5-5", CFG: { name: "Site" }, S: { model: "claude-fable-5-1", efforts: {}, state, ...extra }, esc: v => String(v), noteHtml: () => "", switchNote: () => "" };
  vm.runInNewContext(`const EFF = ${eff}; const EFF_LABEL = ${labels}; const ALL_MODELS = ${models}; const MODELS_BY_ID = Object.fromEntries(ALL_MODELS.map(m => [m.id, m]));` + ["agentNow", "fableOk", "paidModels", "modelNow", "modelOf", "effortsOf", "effortFor", "pmRow", "popEffort", "popModel"].map(lift).join("") + "this.popModel = popModel; this.modelNow = modelNow;", ctx);
  return ctx;
}

test("Fable 5.1 is only in the model picker when there are usage credits to spend, with no setting for it", () => {
  assert.doesNotMatch(html, /CFG\.fable|fFable|SHOW_FABLE|Fable 5\.1 in the model picker/);
  let p = picker({ agent: { online: true }, fable: { available: true } });
  assert.match(p.popModel(), /<b>Fable 5\.1<\/b>[\s\S]*?<span class="tag">Uses usage credits<\/span>/);
  assert.equal(p.modelNow(), "claude-fable-5-1");
  // the models, then the picked model's efforts, as one menu
  assert.match(p.popModel(), /^<div class="mh">Model<\/div>[\s\S]*data-model="claude-haiku-5-5"[\s\S]*<div class="mh">Effort<\/div>[\s\S]*data-effort="max"/);
  for (const why of ["out", "off", "none", "site", "unknown"]) {
    p = picker({ agent: { online: true }, fable: { available: false, why } });
    assert.doesNotMatch(p.popModel(), /Fable/, why);
    assert.equal(p.modelNow(), "claude-opus-5-5", "picked before, it falls back while there are none");
  }
  // a message turned away for it brings the page up to date
  assert.match(script, /j\.code === "no_credits"\) loadState\(\);/);
});

test("the context ring isn't there in an empty message box, only in a chat with a reading", () => {
  const els = {};
  const $ = id => (els[id] = els[id] || { hidden: false, className: "", title: "", attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  const ctx = { $, CIRC: 56.549, popOpen: null, closePop: () => {}, S: { chatId: null, ctx: null } };
  vm.runInNewContext(["ctxPct", "renderCtx"].map(lift).join("") + "this.renderCtx = renderCtx;", ctx);
  ctx.renderCtx();
  assert.equal(els.ctxBtn.hidden, true, "a new chat, before anything is sent");
  ctx.S.chatId = "c1";
  ctx.renderCtx();
  assert.equal(els.ctxBtn.hidden, true, "a chat with no reading yet");
  ctx.S.ctx = { used: 150000, window: 200000 };
  ctx.renderCtx();
  assert.equal(els.ctxBtn.hidden, false);
});

test("there's no setting for the credit balance, which chats are listed or the plan; starting at login and the working folder are there", () => {
  assert.doesNotMatch(script, /Show your usage credit balance|Working folder only|data-pc="history"|data-pc="credits"|SCOPES/);
  const pc = lift("computerHtml");
  assert.doesNotMatch(script, /data-pc="plan"|PLAN_KINDS|Free plan|free plan/);
  assert.match(pc, /data-pc="autostart"/);
  assert.match(pc, /Makes it a startup item on this computer/);
  assert.match(pc, /id="fWs"/);
});

test("everything `<command> edit` asks about can also be changed on the page", () => {
  const installer = readFileSync(join(ROOT, "installer.mjs"), "utf8");
  const edit = /async function editSettings\(\) \{[\s\S]*?\n\}\n/.exec(installer)[0];
  // what edit asks, and where the page has it
  const pairs = [
    [/Change the name\?/, /id="fName"/],
    [/Change the logo\?/, /imgField\("logo"/],
    [/Change the tab icon\?/, /imgField\("favicon"/],
    [/Change the tab title/, /id="fTab"/],
    [/Change the theme\?/, /data-theme-set=/],
    [/when you log in to this computer\?/, /data-pc="autostart"/],
    [/Change the working folder/, /id="fWs"/],
    [/usage credits from the site\?/, /data-usage="credits"/],
    [/Change the address\?/, /data-act="move"/],
    [/Delete \$\{name\}\?/, /data-act="delete"/]
  ];
  for (const [asked, shown] of pairs) {
    assert.match(edit, asked);
    assert.match(script, shown, String(asked));
  }
  // and nothing it no longer asks
  assert.doesNotMatch(edit, /usage credit balance|which of Claude Code.s chats|(Show|Hide) Fable|free plan|paid plan now/);
});

test("something waiting on the computer shows over the page, escaped, and the answer goes back for that reply", () => {
  const els = {};
  const $ = id => (els[id] = els[id] || { hidden: true, innerHTML: "", textContent: "" });
  const ctx = { $, esc: v => String(v).replace(/</g, "&lt;").replace(/"/g, "&quot;"), CFG: { name: "Site" }, R: { q: null, busy: false } };
  vm.runInNewContext(lift("showRemote") + lift("hideRemote") + "this.showRemote = showRemote; this.hideRemote = hideRemote;", ctx);
  ctx.showRemote({ id: "a1", kind: "permission", title: "Run a command", detail: "rm -rf <build>", at: 1 });
  assert.equal(els.remote.hidden, false);
  // the question comes from the site's own assistant, by the site's name
  assert.equal(els.rName.textContent, "Site");
  assert.match(els.rBody.innerHTML, /<p class="rnote">Site is asking, and waits for your answer\./);
  assert.doesNotMatch(els.rBody.innerHTML, /Claude/);
  assert.match(els.rBody.innerHTML, /<pre>rm -rf &lt;build><\/pre>/);
  assert.match(els.rBody.innerHTML, /data-ranswer="deny">Deny<\/button><button class="btn primary" type="button" data-ranswer="allow">Allow<\/button>/);
  ctx.hideRemote("someone-else");
  assert.equal(els.remote.hidden, false, "only its own id closes it");
  ctx.hideRemote("a1");
  assert.equal(els.remote.hidden, true);
  assert.match(lift("answerRemote"), /apiJson\("\/api\/remote", \{ method: "POST"[^\n]*JSON\.stringify\(\{ chatId: S\.chatId, id: R\.q\.id, \.\.\.body \}\)/);
});

test("out of usage, the note under the message box says when it comes back, and offers a free reset", () => {
  const note = lift("renderLimitNote");
  assert.match(note, /reset = usableResets\(\)\.find\(x => x\.can\) \|\| null;/);
  assert.match(note, />\$\{U\.resetting \? "Using a free reset…" : "Use a free reset"\}<\/button>/);
  // Plan usage lists the free resets with how often a new one comes, and each limit says when it resets
  const resets = lift("resetsHtml");
  assert.match(resets, /<b>Free limit resets<\/b>/);
  assert.match(resets, /A new one \$\{EVERY\[x\.every\]\}/);
  assert.match(script, /const EVERY = \{ day: "every day", week: "every week", month: "every month" \};/);
  assert.match(lift("renderUsage"), /Resets \$\{esc\(relTime\(w\.resetsAt\)\)\} \(\$\{esc\(clock\(w\.resetsAt\)\)\}\)/);
});

test("only a newer site makes the page out of date, and once Reload was pressed for a version the notice stays away", () => {
  const ctx = { CFG: { version: "1.7.0" }, UP: { data: { current: "1.7.0" } }, stored: {} };
  ctx.store = { get: (k, d) => (k in ctx.stored ? ctx.stored[k] : d), set: (k, v) => (ctx.stored[k] = v) };
  vm.runInNewContext(lift("pageIsStale") + lift("newerThan") + lift("reloadAsked") + "this.pageIsStale = pageIsStale; this.reloadAsked = reloadAsked;", ctx);
  assert.equal(ctx.pageIsStale(), false);
  ctx.UP.data.current = "1.6.0";
  assert.equal(ctx.pageIsStale(), false, "the page is the new one and the site hasn't caught up yet: nothing to reload");
  ctx.UP.data.current = "1.10.0";
  assert.equal(ctx.pageIsStale(), true);
  assert.equal(ctx.reloadAsked(), false);
  ctx.stored.reloadFor = "1.10.0";
  assert.equal(ctx.reloadAsked(), true, "already reloaded for it: no more 'Updated · Reload'");
  ctx.UP.data.current = "1.11.0";
  assert.equal(ctx.reloadAsked(), false, "the next update is a new notice");
  // the pill hides it, and one click on it reloads
  assert.match(lift("renderPill"), /else if \(pageIsStale\(\) && !reloadAsked\(\)\)/);
  assert.match(script, /if \(run \? run\.state === "done" : pageIsStale\(\)\) return reloadNow\(\);/);
});

test("a reply shows its thinking, text and tools in the order they happened", () => {
  const ctx = { esc: v => String(v), md: t => `[${t}]`, fmtDur: ms => ms + "ms", I: { chev: "" }, MD_ARTS: null };
  vm.runInNewContext(lift("partsOf") + lift("partsHtml") + lift("thinkHtml") + lift("toolsHtml") + "this.partsOf = partsOf; this.partsHtml = partsHtml;", ctx);
  const meta = { thinking: "plan Aplan B", tools: [{ id: "t1", label: "Read a", done: true }, { id: "t2", label: "Edit b", done: true }], parts: [{ t: "think", n: 6, ms: 900 }, { t: "text", n: 9 }, { t: "tool", id: "t1" }, { t: "tool", id: "t2" }, { t: "think", n: 6, ms: 400 }, { t: "text", n: 7 }] };
  const content = "ok test 1ok test2";
  meta.parts[5].n = content.length - 9;
  assert.equal(ctx.partsOf(meta, content + "!"), null, "lengths that don't add up to the text are not trusted");
  const ok = ctx.partsOf(meta, content);
  assert.deepEqual(JSON.parse(JSON.stringify(ok.map(p => p.type))), ["think", "text", "tool", "tool", "think", "text"]);
  const html = ctx.partsHtml(ok, meta.tools, { live: false, open: {} });
  const order = ["plan A", "[ok test 1]", "Used 2 tools", "plan B", "[ok test2]"].map(x => html.indexOf(x));
  assert.ok(order.every((x, i) => x >= 0 && (i === 0 || x > order[i - 1])), html);
  assert.equal(ctx.partsOf({ thinking: "x" }, "y"), null, "an older reply has no pieces");
});

test("right after an update the page doesn't offer it again, and settings have no Save button", () => {
  const ctx = { CFG: { version: "1.10.0" } };
  vm.runInNewContext(lift("updateAvailable") + lift("newerThan") + "this.updateAvailable = updateAvailable;", ctx);
  assert.equal(ctx.updateAvailable({ available: true, latest: "1.10.0", current: "1.9.0" }), false, "the site still answers as 1.9.0 for a moment; this page is already 1.10.0");
  assert.equal(ctx.updateAvailable({ available: true, latest: "1.11.0", current: "1.10.0" }), true);
  assert.equal(ctx.updateAvailable({ available: false, latest: "1.10.0" }), false);
  assert.equal(ctx.updateAvailable(null), false);
  assert.doesNotMatch(script, /Save changes|data-act="save"|data-act="discard"|You have unsaved changes/);
  // changes go to the site as they're made
  assert.match(script, /function setTheme\(t\) \{[\s\S]*?apiJson\("\/api\/prefs", \{ method: "POST", headers: \{ "content-type": "application\/json" \}, body: JSON\.stringify\(\{ theme: t \}\) \}\)/);
  assert.match(script, /r\.onload = \(\) => saveSite\(key, /);
});

test("an update only says it's done once the site answers as the new version, and the bar keeps going until then", () => {
  const ctx = { CFG: { version: "1.10.2" }, UP: { live: null } };
  vm.runInNewContext(lift("liveAt") + "this.liveAt = liveAt;", ctx);
  assert.equal(ctx.liveAt("1.11.0"), false, "the steps are done but nothing has said it's live yet");
  ctx.UP.live = { worker: "1.11.0", hub: "1.10.2" };
  assert.equal(ctx.liveAt("1.11.0"), false, "the front is new but the part that keeps the chats isn't yet");
  ctx.UP.live = { worker: "1.11.0", hub: "1.11.0" };
  assert.equal(ctx.liveAt("1.11.0"), true);
  const job = lift("renderJob");
  assert.match(job, /if \(!liveAt\(to\)\) \{[\s\S]*Making sure the new version is live/);
  assert.match(lift("applyUpdate"), /if \(run && run\.state === "done" && run\.kind !== "settings" && !liveAt\(run\.to\)\) return checkLive\(run\.to\);/);
});
