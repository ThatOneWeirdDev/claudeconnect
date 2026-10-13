// A stand-in for claude.ai, as the Claude app shows it, for the free plan's tests: the same kinds of things on the page the real
// one has (a ProseMirror message box in data-testid="chat-input", a "Send message" button, a model menu with an extended
// thinking switch, replies marked data-is-streaming while they're written, a Stop button) and the same readings behind it
// (/api/organizations, its usage, a conversation's messages). The real app is opened in a real Chromium by the agent, through
// the debugging connection, exactly as it would open claude.ai.
//
// What a message asks for decides what happens: "permission" shows a dialog that waits for Allow or Deny, "out of messages"
// gets the free plan's limit notice instead of a reply, "slowly" writes the reply slowly (to stop it), and "table" writes a
// table (which changes shape as it fills in).
import http from "node:http";
import { randomUUID } from "node:crypto";

export const ORG = "5d6e7f80-1111-4222-8333-444455556666";

const PAGE = String.raw`<!doctype html>
<html><head><meta charset="utf-8"><title>Claude</title>
<style>
body{font:15px system-ui;margin:0;display:flex;flex-direction:column;height:100vh}
#thread{flex:1;overflow:auto;padding:12px}
[data-testid=user-message]{background:#eee;margin:8px 0;padding:6px 10px;border-radius:12px}
fieldset{border:1px solid #ccc;margin:8px;border-radius:16px;padding:8px}
.ProseMirror{min-height:30px;outline:none;white-space:pre-wrap}
[role=menu]{position:fixed;bottom:80px;left:40px;background:#fff;border:1px solid #999;padding:4px;width:260px}
[role=menu] [role^=menuitem]{padding:6px;cursor:pointer}
[role=dialog]{position:fixed;left:30%;top:30%;width:320px;height:160px;background:#fff;border:2px solid #333;padding:12px}
#limit{color:#b00}
</style></head>
<body>
<div id="thread"></div>
<p id="limit" hidden></p>
<fieldset>
  <div data-testid="chat-input"><div class="ProseMirror" contenteditable="true" role="textbox"></div></div>
  <input type="file" multiple hidden data-testid="file-upload">
  <div id="files"></div>
  <button type="button" data-testid="model-selector-dropdown" aria-haspopup="menu">Sonnet 5.5</button>
  <button type="button" aria-label="Send message" disabled>Send</button>
</fieldset>
<script>
const ed = document.querySelector(".ProseMirror");
const send = document.querySelector('[aria-label="Send message"]');
const modelBtn = document.querySelector('[data-testid="model-selector-dropdown"]');
const file = document.querySelector('input[type=file]');
const thread = document.getElementById("thread");
let thinking = false, conv = (location.pathname.match(/\/chat\/([0-9a-f-]{36})/) || [])[1] || "", stopped = false, attached = [];
window.__log = [];
const refresh = () => { send.disabled = !ed.innerText.trim() && !attached.length; };
ed.addEventListener("input", refresh);
file.addEventListener("change", () => { attached = [...file.files].map(f => f.name); document.getElementById("files").textContent = attached.join(", "); refresh(); });
const MODELS = [["Sonnet 5.5", "Smart, efficient model for everyday tasks", false], ["Haiku 5.5", "Fastest model for daily tasks", false], ["Opus 5.5", "Upgrade to Pro to use our most capable model", true]];
modelBtn.onclick = () => {
  if (document.querySelector("[role=menu]")) return document.querySelector("[role=menu]").remove();
  const m = document.createElement("div");
  m.setAttribute("role", "menu");
  for (const [name, desc, locked] of MODELS) {
    const it = document.createElement("div");
    it.setAttribute("role", "menuitem");
    if (locked) it.setAttribute("aria-disabled", "true");
    it.innerHTML = "<div>" + name + "</div><div>" + desc + "</div>";
    it.onclick = () => { if (locked) return; modelBtn.textContent = name; window.__log.push("model:" + name); m.remove(); };
    m.append(it);
  }
  const t = document.createElement("div");
  t.setAttribute("role", "menuitemcheckbox");
  t.setAttribute("aria-checked", String(thinking));
  t.innerHTML = "<div>Extended thinking</div><div>Think longer for complex tasks</div>";
  t.onclick = () => { thinking = !thinking; t.setAttribute("aria-checked", String(thinking)); window.__log.push("thinking:" + thinking); };
  m.append(t);
  document.body.append(m);
};
document.addEventListener("keydown", e => { if (e.key === "Escape") { const m = document.querySelector("[role=menu]"); if (m) m.remove(); } });
ed.addEventListener("keydown", e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send.click(); } });
const sleep = ms => new Promise(r => setTimeout(r, ms));
function render(md) {
  // a little Markdown, the way the real page draws it: paragraphs, a list, a code block with its language above it, a table
  const out = [];
  const blocks = md.split(/\n\n/);
  for (const b of blocks) {
    if (b.startsWith("~~~")) {
      const lang = b.split("\n")[0].slice(3);
      const code = b.split("\n").slice(1).filter(l => l !== "~~~").join("\n");
      out.push('<div class="code"><div class="lang">' + lang + '</div><button>Copy</button><pre><code class="language-' + lang + '"></code></pre></div>');
      out.push({ code });
    } else if (/^- /.test(b)) out.push("<ul>" + b.split("\n").map(l => "<li>" + l.slice(2).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>") + "</li>").join("") + "</ul>");
    else if (/^\| /.test(b)) {
      const rows = b.split("\n").filter(l => !/^\|\s*-/.test(l)).map(l => l.split("|").slice(1, -1).map(c => c.trim()));
      out.push("<table>" + rows.map((r, i) => "<tr>" + r.map(c => (i ? "<td>" : "<th>") + c + (i ? "</td>" : "</th>")).join("") + "</tr>").join("") + "</table>");
    } else out.push("<p>" + b.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/\x60([^\x60]+)\x60/g, "<code>$1</code>") + "</p>");
  }
  return out;
}
function draw(el, md) {
  el.innerHTML = "";
  for (const part of render(md)) {
    if (typeof part === "string") el.insertAdjacentHTML("beforeend", part);
    else el.querySelector("pre:last-of-type code, .code:last-child code").textContent = part.code;
  }
}
async function reply(prompt) {
  const wrap = document.createElement("div");
  wrap.setAttribute("data-is-streaming", "true");
  wrap.setAttribute("data-testid", "assistant-message");
  const body = document.createElement("div");
  body.className = "font-claude-response";
  wrap.append(body);
  thread.append(wrap);
  const stop = document.createElement("button");
  stop.setAttribute("aria-label", "Stop response");
  stop.textContent = "Stop";
  stop.onclick = () => { stopped = true; };
  document.querySelector("fieldset").append(stop);
  const model = modelBtn.textContent;
  let full = "You said: " + prompt + "\n\nModel: " + model + (thinking ? " (thinking)" : "") + (attached.length ? "\n\nFiles: " + attached.join(", ") : "");
  if (/table/.test(prompt)) full += "\n\n| Name | Count |\n| --- | --- |\n| apples | 3 |\n| pears | 5 |";
  else full += "\n\n- one\n- **two**\n\n~~~js\nconst x = 1;\n~~~\n\nUse \x60x\x60 there.";
  const words = full.split(/(?<= )/);
  let shown = "";
  const slow = /slowly/.test(prompt);
  for (let i = 0; i < words.length && !stopped; i++) {
    shown += words[i];
    draw(body, shown);
    if (i === 3 && /permission/.test(prompt)) {
      const d = document.createElement("div");
      d.setAttribute("role", "dialog");
      d.innerHTML = "<h2>Allow Claude to read report.pdf?</h2><p>Claude wants to open a file from your computer.</p>";
      // Escape closes it without allowing anything, as the real one does
      const esc = e => { if (e.key === "Escape") d.dispatchEvent(new Event("dismiss")); };
      const answer = await new Promise(res => {
        for (const label of ["Deny", "Allow once"]) {
          const b = document.createElement("button");
          b.textContent = label;
          b.onclick = () => res(label);
          d.append(b);
        }
        d.addEventListener("dismiss", () => res("Dismissed"));
        document.addEventListener("keydown", esc);
        document.body.append(d);
      });
      document.removeEventListener("keydown", esc);
      d.remove();
      full += "\n\nPermission: " + answer;
      words.push(...("\n\nPermission: " + answer).split(/(?<= )/));
    }
    await sleep(slow ? 250 : 15);
  }
  if (stopped) { shown += " (stopped)"; draw(body, shown); }
  wrap.setAttribute("data-is-streaming", "false");
  stop.remove();
  // what the real claude.ai keeps of it: the same text, plus an artifact the page only shows as a card
  const text = stopped ? shown : full + "\n\n**Plan**\n\n\x60\x60\x60markdown\n# Day 1\n\x60\x60\x60";
  await fetch("/__record", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ conv, model, text, thinking: thinking ? "pondered it" : "" }) });
  stopped = false;
  attached = [];
  document.getElementById("files").textContent = "";
}
send.onclick = async () => {
  const text = ed.innerText.trim();
  if (!text && !attached.length) return;
  window.__log.push("sent:" + text);
  const u = document.createElement("div");
  u.setAttribute("data-testid", "user-message");
  u.textContent = text;
  thread.append(u);
  ed.innerHTML = "";
  refresh();
  if (!conv) { conv = crypto.randomUUID(); history.pushState({}, "", "/chat/" + conv); }
  if (/out of messages/.test(text)) { const l = document.getElementById("limit"); l.hidden = false; l.textContent = "You're out of free messages until 4:00 PM"; return; }
  reply(text);
};
</script></body></html>`;

const LOGIN = `<!doctype html><html><body><h1>Log in to Claude</h1><input type="email" placeholder="Email"><a href="/login?google">Continue with Google</a></body></html>`;

export async function startFakeClaude(opts = {}) {
  const state = {
    conversations: new Map(),
    usage: opts.usage || { five_hour: { utilization: 37, resets_at: new Date(Date.now() + 3 * 3600e3).toISOString() }, seven_day: { utilization: 12, resets_at: new Date(Date.now() + 5 * 86400e3).toISOString() } },
    resets: [],
    signedIn: opts.signedIn !== false
  };
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const json = (o, code = 200) => {
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(o));
    };
    if (url.pathname === "/__record" && req.method === "POST") {
      let b = "";
      req.on("data", d => (b += d));
      req.on("end", () => {
        const r = JSON.parse(b);
        const c = state.conversations.get(r.conv) || { model: r.model, chat_messages: [] };
        c.chat_messages.push({ sender: "assistant", content: [...(r.thinking ? [{ type: "thinking", thinking: r.thinking }] : []), { type: "text", text: r.text }] });
        state.conversations.set(r.conv, c);
        json({ ok: true });
      });
      return;
    }
    if (url.pathname === "/api/organizations") return state.signedIn ? json([{ uuid: ORG, name: "Personal" }]) : json({ error: "unauthorized" }, 401);
    if (url.pathname === `/api/organizations/${ORG}/usage`) return json(state.usage);
    const cm = url.pathname.match(new RegExp(`^/api/organizations/${ORG}/chat_conversations/([0-9a-f-]{36})$`));
    if (cm) return state.conversations.has(cm[1]) ? json(state.conversations.get(cm[1])) : json({ error: "not found" }, 404);
    if (url.pathname === `/api/organizations/${ORG}/reset_rate_limits` && req.method === "POST") {
      let b = "";
      req.on("data", d => (b += d));
      req.on("end", () => {
        state.resets.push(JSON.parse(b));
        json({ result: "reset", resets_left: 0, cleared: ["five_hour"] });
      });
      return;
    }
    if (url.pathname === "/" || url.pathname === "/new" || /^\/chat\/[0-9a-f-]{36}$/.test(url.pathname)) {
      if (!state.signedIn) {
        res.writeHead(302, { location: "/login" });
        return res.end();
      }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(PAGE);
    }
    if (url.pathname === "/login") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      return res.end(LOGIN);
    }
    res.writeHead(404);
    res.end("not found");
  });
  await new Promise(r => srv.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${srv.address().port}`;
  return { url, state, close: () => new Promise(r => srv.close(r)), id: randomUUID };
}

// A stand-in for the Claude desktop app, for the agent to start the way it starts the real one: a small launcher that runs a
// headless Chromium on the claude.ai stand-in, with whatever the agent passes (its --remote-debugging-port). Its profile is
// <programDir>/browser, so closeBrowser() closes it.
export async function fakeClaudeApp(programDir, url, chrome) {
  const { writeFileSync, chmodSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  const profile = join(programDir, "browser");
  mkdirSync(profile, { recursive: true });
  const app = join(programDir, "Claude");
  const quiet = "--disable-background-networking --disable-component-update --disable-sync --disable-default-apps --no-pings";
  writeFileSync(app, `#!/bin/sh\nexec "${chrome}" "$@" --headless=new --no-sandbox --disable-gpu --user-data-dir="${profile}" --no-first-run --no-default-browser-check ${quiet} "${url}/new"\n`);
  chmodSync(app, 0o755);
  return app;
}

// A port nobody is listening on, for the app's debugging connection in a test.
export async function freePort() {
  const net = await import("node:net");
  return new Promise(resolve => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

// The app the agent opened for a test, closed (it outlives the agent on purpose: it's the person's app).
export async function closeBrowser(programDir) {
  const { spawnSync } = await import("node:child_process");
  const { join } = await import("node:path");
  const pattern = "--user-data-dir=" + join(programDir, "browser");
  spawnSync("pkill", ["-f", "--", pattern]);
  for (let i = 0; i < 50 && spawnSync("pgrep", ["-f", "--", pattern]).status === 0; i++) await new Promise(r => setTimeout(r, 100));
}

// A Chromium to stand in for the Claude app: the one Playwright keeps here, or the one CI has.
export async function findChromium() {
  const { existsSync, readdirSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync("/opt/pw-browsers").filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch {}
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const r = spawnSync("which", [n], { encoding: "utf8" });
    const p = String(r.stdout || "").trim();
    if (r.status === 0 && p) return p;
  }
  return "";
}
