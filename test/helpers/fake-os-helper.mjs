// A stand-in for agent/app-mac.js and agent/app-win.ps1: the same requests and answers, over the same lines of JSON, but
// the Claude app it reads is made up here, as the tree of buttons, text boxes and text that macOS Accessibility or Windows UI
// Automation would show for claude.ai. It lets the tests run the real driver (agent/app-os.mjs) end to end on any computer.
//
// Its state is kept in $CLAUDECONNECT_FAKE_DIR/app.json, so it carries over when the driver starts it again; a test changes
// things by writing $CLAUDECONNECT_FAKE_DIR/control.json, read once, ({"signedIn": false}, {"trusted": false}, {"running": false}).
import { readFileSync, writeFileSync, existsSync, unlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { randomUUID } from "node:crypto";

const DIR = process.env.CLAUDECONNECT_FAKE_DIR;
const FILE = join(DIR, "app.json");
const ORIGIN = "https://claude.ai";
const MODELS = [
  { name: "Sonnet 5.5", desc: "Smart, efficient model for everyday use" },
  { name: "Haiku 5.5", desc: "Fastest model for daily tasks" },
  { name: "Opus 5.5", desc: "Upgrade to Pro to use this model", locked: true }
];
const read = (f, d) => {
  try {
    return JSON.parse(readFileSync(f, "utf8"));
  } catch {
    return d;
  }
};
function load() {
  const s = read(FILE, null) || { running: true, signedIn: true, trusted: true, url: ORIGIN + "/new", convs: {}, order: [], current: null, composer: "", took: true, model: "Sonnet 5.5", thinking: false, menu: null, dialog: null, limited: false, launches: 0, log: [] };
  // what a test asks for, once
  const control = read(join(DIR, "control.json"), null);
  if (control) {
    try {
      unlinkSync(join(DIR, "control.json"));
    } catch {}
    Object.assign(s, control);
  }
  return s;
}
let S = load();
// written whole, so a test never reads half of it
const save = () => {
  writeFileSync(FILE + ".tmp", JSON.stringify(S, null, 1));
  renameSync(FILE + ".tmp", FILE);
};
const say = o => process.stdout.write(JSON.stringify(o).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n");
const t = v => ({ role: "text", value: v });

// ---- a reply, as the page shows it
function replyBlocks(m) {
  const blocks = [
    { role: "group", kids: [t("You said: " + m.prompt.replace(/\s+/g, " ").trim())] },
    { role: "group", kids: [t(`Model: ${m.model}${m.thinking ? ", thinking on" : ""}`)] }
  ];
  if (m.answer) blocks.push({ role: "group", kids: [t("Permission: " + m.answer)] });
  if (/slowly/.test(m.prompt)) for (let i = 1; i <= 30; i++) blocks.push({ role: "group", kids: [t(`Line ${i} of a slow reply.`)] });
  blocks.push(
    { role: "heading", level: 2, kids: [t("Plan")] },
    { role: "group", kids: [t("This is "), { role: "strong", kids: [t("bold")] }, t(", "), { role: "em", kids: [t("leaning")] }, t(" and "), { role: "code", kids: [t("code")] }, t(", with "), { role: "link", url: "https://example.com/", kids: [t("a link")] }, t(".")] },
    { role: "list", kids: [{ role: "group", kids: [{ role: "marker", value: "•" }, t("one")] }, { role: "group", kids: [{ role: "marker", value: "•" }, t("two")] }] },
    { role: "list", kids: [{ role: "group", kids: [{ role: "marker", value: "1." }, t("first")] }, { role: "group", kids: [{ role: "marker", value: "2." }, t("second")] }] },
    { role: "group", kids: [{ role: "group", kids: [t("python"), { role: "button", name: "Copy" }] }, { role: "group", kids: [{ role: "code", cls: "language-python", kids: [t('print("hi")\n')] }] }] },
    { role: "table", kids: [{ role: "row", kids: [{ role: "cell", kids: [t("Name")] }, { role: "cell", kids: [t("Count")] }] }, { role: "row", kids: [{ role: "cell", kids: [t("apples")] }, { role: "cell", kids: [t("3")] }] }] }
  );
  return blocks;
}
// how much of a reply shows by now: a block more every step
function progress(m, now = Date.now()) {
  if (m.done) return m.shown;
  const step = /slowly/.test(m.prompt) ? 250 : 120;
  const all = replyBlocks(m).length;
  if (/ask permission/.test(m.prompt) && !m.answer) {
    if (!S.dialog && now - m.at > 2 * step) S.dialog = { title: "Allow Claude to read report.pdf?", text: "Claude wants to read report.pdf from your computer.", buttons: ["Deny", "Allow once"], conv: S.current };
    return Math.min(2, Math.floor((now - m.at) / step));
  }
  const n = Math.min(all, Math.floor((now - (m.resumedAt || m.at)) / step) + (m.base || 0));
  if (n >= all) {
    m.done = true;
    m.shown = all;
  }
  return n;
}
function streaming() {
  const c = S.current && S.convs[S.current];
  const last = c && c.messages[c.messages.length - 1];
  return !!(last && last.role === "assistant" && !last.done && (progress(last), !last.done));
}

// ---- the window, as a tree
function tree() {
  const id = (k, o) => Object.assign(o, { id: k });
  const doc = { role: "document", id: "doc", kids: [] };
  if (!S.signedIn) {
    doc.url = ORIGIN + "/login";
    doc.title = "Claude";
    doc.kids.push(id("email", { role: "textbox", name: "Email", value: "" }), id("cont", { role: "button", name: "Continue with email" }));
    return doc;
  }
  doc.url = S.url;
  doc.title = S.current ? (S.convs[S.current].title || "Claude") + " - Claude" : "Claude";
  const side = { role: "group", id: "side", kids: [id("new", { role: "link", name: "New chat", url: ORIGIN + "/new", kids: [t("New chat")] })] };
  for (const c of S.order) side.kids.push(id("conv:" + c, { role: "link", name: S.convs[c].title, url: `${ORIGIN}/chat/${c}`, kids: [t(S.convs[c].title)] }), id("more:" + c, { role: "button", name: "More options for " + S.convs[c].title }));
  const main = { role: "group", id: "main", kids: [] };
  const c = S.current && S.convs[S.current];
  for (const [i, m] of (c ? c.messages : []).entries()) {
    if (m.role === "user") main.kids.push(id("u" + i, { role: "group", cls: "group relative font-user-message", kids: [t(m.prompt)] }));
    else {
      const blocks = replyBlocks(m).slice(0, progress(m));
      const kids = m.thinking ? [id("think" + i, { role: "button", name: "Thought process" }), ...blocks] : blocks;
      main.kids.push(id("r" + i, { role: "group", cls: "font-claude-response relative leading-[1.65rem]", kids }));
      main.kids.push(id("copy" + i, { role: "button", name: "Copy" }));
    }
  }
  if (S.limited) main.kids.push({ role: "group", kids: [t("You're out of free messages until 4:00 PM")] });
  const live = streaming();
  const box = { role: "group", id: "box", kids: [id("composer", { role: "textbox", name: "Write your prompt to Claude", cls: "ProseMirror break-words", value: S.composer, focused: !!S.focused })] };
  box.kids.push(id("model", { role: "button", name: S.model, kids: [t(S.model)] }));
  if (live) box.kids.push(id("stop", { role: "button", name: "Stop response" }));
  else box.kids.push(id("send", { role: "button", name: "Send message", disabled: !S.composer.trim() || !S.took || S.limited }));
  main.kids.push(box);
  doc.kids.push(side, main);
  if (S.menu) {
    const menu = { role: "menu", id: "menu", kids: [] };
    for (const m of MODELS) menu.kids.push(id("item:" + m.name, { role: "menuitem", name: `${m.name} ${m.desc}`, disabled: !!m.locked, kids: [t(m.name), t(m.desc)] }));
    menu.kids.push(id("item:think", { role: "menuitem", name: "Extended thinking", kids: [t("Extended thinking"), t("Think longer for complex tasks"), id("switch", { role: "switch", name: "", checked: S.thinking })] }));
    doc.kids.push(menu);
  }
  if (S.dialog) {
    doc.kids.push(id("dialog", { role: "dialog", name: S.dialog.title, kids: [{ role: "heading", level: 2, kids: [t(S.dialog.title)] }, { role: "group", kids: [t(S.dialog.text)] }, ...S.dialog.buttons.map(b => id("dlg:" + b, { role: "button", name: b }))] }));
  }
  return doc;
}

// ---- reading it the way the helpers do
const handles = new Map();
let next = 1;
function handle(n) {
  const h = "h" + next++;
  handles.set(h, n.id || "");
  return h;
}
function findId(root, want) {
  const stack = [root];
  while (stack.length) {
    const n = stack.pop();
    if (n.id === want) return n;
    for (const k of n.kids || []) stack.push(k);
  }
  return null;
}
function resolve(h) {
  const want = handles.get(h);
  const n = want && findId(tree(), want);
  if (!n) throw Object.assign(new Error("That part of the app is gone."), { code: "stale-handle" });
  return n;
}
function linesOf(n, max) {
  const out = [];
  (function walk(x, d) {
    if (out.length >= max) return;
    if (x.role === "text") {
      const v = String(x.value || "").replace(/\s+/g, " ").trim();
      if (v) out.push(v);
      return;
    }
    if (x.role === "button" && d > 0) return;
    for (const k of x.kids || []) walk(k, d + 1);
  })(n, 0);
  return out;
}
function compact(n, depth = 0) {
  const o = { r: n.role };
  if (n.role === "text" || n.role === "marker") return { ...o, v: n.value || "" };
  if (["button", "image", "textbox"].includes(n.role)) return depth === 0 ? o : null;
  if (n.role === "link") o.u = n.url || "";
  if (n.role === "heading") o.l = n.level || 1;
  if (/language-/.test(n.cls || "")) o.c = (n.cls.match(/language-\S+/) || [""])[0];
  const k = (n.kids || []).map(x => compact(x, depth + 1)).filter(Boolean);
  if (k.length) o.k = k;
  return o;
}
function scan(a) {
  const doc = tree();
  const root = a.root ? resolve(a.root) : doc;
  const qs = a.queries || {};
  const names = Object.keys(qs);
  const kept = Object.fromEntries(names.map(k => [k, []]));
  const count = Object.fromEntries(names.map(k => [k, 0]));
  const re = (q, k) => (q[k] ? new RegExp(q[k], "i") : null);
  let order = 0;
  const stack = [[root, []]];
  while (stack.length) {
    const [n, inside] = stack.pop();
    order++;
    let skip = false;
    let here = inside;
    const v = { role: n.role, name: n.name || "", value: n.role === "text" ? n.value || "" : n.value || "", cls: n.cls || "", url: n.url || "" };
    for (const k of names) {
      const q = qs[k];
      if (q.within && !inside.includes(q.within)) continue;
      const roles = q.role ? [].concat(q.role) : null;
      if (roles && !roles.includes(v.role)) continue;
      if (re(q, "name") && !re(q, "name").test(v.name)) continue;
      if (re(q, "any") && !re(q, "any").test([v.name, v.value].join(" "))) continue;
      if (re(q, "not") && re(q, "not").test(v.name)) continue;
      if (re(q, "value") && !re(q, "value").test(v.value)) continue;
      if (re(q, "cls") && !re(q, "cls").test(v.cls)) continue;
      if (re(q, "url") && !re(q, "url").test(v.url)) continue;
      count[k]++;
      const hit = { n, i: order };
      if (q.count) {
      } else if (q.last) kept[k] = [hit];
      else if (kept[k].length < (q.limit || 50)) kept[k].push(hit);
      if (q.skip) skip = true;
      if (here === inside) here = [...inside];
      here.push(k);
    }
    if (skip || ["text", "textbox"].includes(n.role)) continue;
    const kids = n.kids || [];
    for (let j = kids.length - 1; j >= 0; j--) stack.push([kids[j], here]);
  }
  const found = {};
  for (const k of names) {
    const q = qs[k];
    found[k] = kept[k].map(({ n, i }) => {
      const o = { h: handle(n), i, role: n.role, name: n.name || "" };
      if (n.value) o.value = n.value;
      if (typeof n.checked === "boolean") o.checked = n.checked;
      if (n.disabled) o.disabled = true;
      if (n.focused) o.focused = true;
      if (n.url) o.url = n.url;
      if (q.lines) o.lines = linesOf(n, q.lines);
      if (q.tree) o.tree = compact(n);
      return o;
    });
  }
  return { found, count, doc: a.root ? null : { url: doc.url, title: doc.title }, nodes: order, cut: "" };
}

// ---- doing things
function sendMessage() {
  if (!S.composer.trim() || !S.took || S.limited) return;
  if (!S.current) {
    const cid = randomUUID();
    S.convs[cid] = { title: S.composer.split("\n")[0].slice(0, 40), messages: [] };
    S.order.unshift(cid);
    S.current = cid;
    S.url = `${ORIGIN}/chat/${cid}`;
  }
  const c = S.convs[S.current];
  c.messages.push({ role: "user", prompt: S.composer });
  c.messages.push({ role: "assistant", prompt: S.composer, model: S.model, thinking: S.thinking, at: Date.now() });
  S.log.push({ sent: S.composer, model: S.model, thinking: S.thinking, conv: S.current });
  S.composer = "";
}
function press(n) {
  S.log.push({ press: n.id });
  if (n.id === "new") Object.assign(S, { current: null, url: ORIGIN + "/new" });
  else if (n.id.startsWith("conv:")) Object.assign(S, { current: n.id.slice(5), url: `${ORIGIN}/chat/${n.id.slice(5)}` });
  else if (n.id === "model") S.menu = S.menu ? null : "model";
  else if (n.id === "item:think" || n.id === "switch") S.thinking = !S.thinking;
  else if (n.id.startsWith("item:")) {
    const m = MODELS.find(x => x.name === n.id.slice(5));
    if (m && !m.locked) Object.assign(S, { model: m.name, menu: null });
  } else if (n.id === "send") sendMessage();
  else if (n.id === "stop") {
    const c = S.convs[S.current];
    const last = c.messages[c.messages.length - 1];
    last.shown = progress(last);
    last.done = true;
  } else if (n.id.startsWith("dlg:")) answer(n.id.slice(4));
}
function answer(b) {
  const c = S.convs[S.dialog.conv];
  const last = c.messages[c.messages.length - 1];
  S.dialog = null;
  if (/deny/i.test(b)) {
    last.answer = "Deny";
    last.shown = 2;
    last.done = true;
    return;
  }
  last.answer = b;
  last.base = 2;
  last.resumedAt = Date.now();
}

const CMD = {
  ping: () => ({ version: 1, trusted: S.trusted !== false }),
  trust: () => ({ trusted: S.trusted !== false }),
  app: () => ({ path: "/Applications/Claude.app", running: !!S.running }),
  launch() {
    S.launches++;
    S.running = true;
    return { already: false };
  },
  openUrl(a) {
    const m = /^claude:\/\/claude\.ai\/chat\/([0-9a-f-]{36})$/.exec(a.url);
    if (m && S.convs[m[1]]) Object.assign(S, { current: m[1], url: `${ORIGIN}/chat/${m[1]}` });
    else if (/\/new$/.test(a.url)) Object.assign(S, { current: null, url: ORIGIN + "/new" });
    return {};
  },
  enable() {
    if (!S.trusted) throw Object.assign(new Error("Accessibility permission is off."), { code: "not-trusted" });
    if (!S.running) throw Object.assign(new Error("The Claude app is not running."), { code: "not-running" });
    return { web: { url: tree().url, title: "Claude" } };
  },
  show: () => ({}),
  scan(a) {
    if (!S.running) throw Object.assign(new Error("The Claude app is not running."), { code: "not-running" });
    return scan(a);
  },
  read(a) {
    const n = resolve(a.h);
    return { value: n.value || "", focused: !!n.focused, disabled: !!n.disabled, checked: n.checked };
  },
  press(a) {
    press(resolve(a.h));
    return {};
  },
  setValue(a) {
    const n = resolve(a.h);
    if (n.id !== "composer") throw Object.assign(new Error("no value"), { code: "no-value" });
    S.composer = a.text;
    // the page shows it, but the editor doesn't take it in: only a paste does
    S.took = !/needs a paste/.test(a.text);
    if (/out of messages/.test(a.text)) S.limited = true;
    S.log.push({ setValue: a.text });
    return { landed: true };
  },
  paste(a) {
    resolve(a.h);
    S.composer = a.text;
    S.took = true;
    S.log.push({ paste: a.text, type: !!a.type });
    return { landed: true };
  },
  key(a) {
    S.log.push({ key: a.key });
    if (a.key === "return") sendMessage();
    if (a.key === "escape") {
      if (S.dialog) answer("Deny");
      S.menu = null;
    }
    return {};
  },
  idle: () => ({ seconds: 30 }),
  forget: () => ({}),
  quit: () => process.exit(0)
};

say({ id: 0, ok: true, ready: true, version: 1, trusted: S.trusted !== false });
createInterface({ input: process.stdin }).on("line", line => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  S = load();
  // {"slow": ms}: an app that takes its time answering
  if (S.slow) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, S.slow);
  let res;
  try {
    const fn = CMD[req.cmd];
    if (!fn) throw Object.assign(new Error(req.cmd), { code: "unknown-cmd" });
    res = { ...(fn(req) || {}), ok: true };
  } catch (e) {
    res = { ok: false, error: e.code || "exception", detail: e.message };
  }
  save();
  say({ ...res, id: req.id });
});
process.stdin.on("end", () => process.exit(0));
if (!existsSync(FILE)) save();
