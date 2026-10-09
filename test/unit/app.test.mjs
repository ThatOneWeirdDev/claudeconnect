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

test("Fable 5.1 is always in the model picker, marked as using usage credits, and says when there are none", () => {
  assert.doesNotMatch(html, /CFG\.fable|fFable|SHOW_FABLE|Fable 5\.1 in the model picker/);
  const models = /const ALL_MODELS = (\[[\s\S]*?\n\]);/.exec(script)[1];
  const ctx = { EFF: [], TICK: "", S: { model: "claude-opus-5-5", state: { prefs: {}, noCredits: null } } };
  vm.runInNewContext(`const ALL_MODELS = ${models}; function noteHtml() { return ""; }` + /function useCredits\(\) \{.*\}\n/.exec(script)[0] + /function noCredits\(\) \{.*\}\n/.exec(script)[0] + lift("popModel") + "this.popModel = popModel;", ctx);
  assert.match(ctx.popModel(), /<b>Fable 5\.1<\/b>[\s\S]*?<span class="tag">Uses usage credits<\/span>/);
  ctx.S.state.noCredits = { why: "none", message: "You have no usage credits!" };
  assert.match(ctx.popModel(), /<span class="tag">Uses usage credits\. You have none!<\/span>/);
  ctx.S.state.prefs.useCredits = false;
  assert.match(ctx.popModel(), /<span class="tag">Uses usage credits, which are off here<\/span>/);
  // picking it with none says so, and a message turned away for it brings the page up to date
  assert.match(script, /if \(modelOf\(S\.model\)\.credits && useCredits\(\) && noCredits\(\)\) toast\(noCredits\(\)\.message, 8000\);/);
  assert.match(script, /j\.code === "no_credits"\) loadState\(\);/);
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
