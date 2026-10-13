// The Claude app on macOS and Windows, used the way a screen reader or an automation tool uses an app: through the
// operating system's accessibility features (macOS Accessibility, Windows UI Automation), with your permission. The app's
// window is read as a tree of buttons, text boxes and text; buttons are pressed; your message is put in the message box.
// The app is never started in a debugging mode and never quit.
//
// The reading and pressing is done by a helper in a language the system already has: app-mac.js (JavaScript for
// Automation, run by osascript) or app-win.ps1 (Windows PowerShell). The Stop bar on the screen is a second helper
// (app-mac-bar.js, app-win-bar.ps1), on its own so it answers whatever the first is busy with. Both talk in lines of JSON.
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === "win32";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// pure ASCII on the pipes, so a line never ends partway through a character
export const ascii = s => String(s).replace(/[\u007f-￿]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));
const norm = s => String(s || "").replace(/\s+/g, " ").trim();

async function waitFor(fn, ms, every = 300) {
  const end = Date.now() + ms;
  for (;;) {
    // Stop pressed ends any wait at once; anything else that goes wrong is another try
    const v = await fn().catch(e => {
      if (e && e.code === "app_stopped") throw e;
      return null;
    });
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(every);
  }
}

// How a helper is started: osascript or PowerShell, or Node for a stand-in (the tests).
function command(file) {
  if (/\.mjs$/.test(file)) return [process.execPath, [file]];
  if (/\.ps1$/i.test(file)) return ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", file]];
  return ["/usr/bin/osascript", ["-l", "JavaScript", file]];
}

// ---------------------------------------------------------------------------------------------------- the helper process
function helperProcess(file, log) {
  let child = null;
  let ready = null;
  let next = 1;
  let calls = 0;
  let tail = "";
  // each process answers only for what was asked of it: one that's ending can't fail a newer one's requests
  let waiting = new Map();
  const failAll = (map, err) => {
    for (const w of map.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    map.clear();
  };
  const lastWords = () => (tail ? " " + tail.trim().split("\n").slice(-3).join(" ") : "");
  function start() {
    if (child) return ready;
    const [cmd, args] = command(file);
    const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    const mine = new Map();
    child = p;
    waiting = mine;
    calls = 0;
    tail = "";
    ready = new Promise((resolve, reject) => {
      // compiling the Windows helper takes a few seconds the first time
      const timer = setTimeout(() => {
        reject(new Error("The helper that works the desktop app didn't start." + lastWords()));
        kill();
      }, IS_WIN ? 90000 : 30000);
      createInterface({ input: p.stdout }).on("line", line => {
        let r;
        try {
          r = JSON.parse(line);
        } catch {
          return;
        }
        if (r && r.id === 0 && r.ready) {
          clearTimeout(timer);
          resolve(r);
          return;
        }
        const w = r && mine.get(r.id);
        if (!w) return;
        mine.delete(r.id);
        clearTimeout(w.timer);
        if (r.ok) w.resolve(r);
        else w.reject(Object.assign(new Error(r.detail || r.error || "failed"), { code: r.error || "failed" }));
      });
      p.on("exit", code => {
        clearTimeout(timer);
        if (child === p) child = null;
        const err = new Error(`The helper that works the desktop app stopped (${code}).` + lastWords());
        reject(err);
        failAll(mine, err);
      });
    });
    ready.catch(() => {});
    p.stderr.on("data", d => {
      tail = (tail + d).slice(-4000);
    });
    p.stdin.on("error", () => {});
    p.on("error", e => log("Couldn't start the helper for the desktop app:", e.message || e));
    return ready;
  }
  async function call(cmd, args = {}, ms = 20000) {
    await start();
    const p = child;
    if (!p) throw new Error("The helper that works the desktop app stopped.");
    const mine = waiting;
    const id = next++;
    calls++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        mine.delete(id);
        // a helper stuck on one request holds up every other: it's started again on the next
        kill();
        reject(Object.assign(new Error(`The desktop app took too long to answer (${cmd}).`), { code: "timeout" }));
      }, ms);
      mine.set(id, { resolve, reject, timer });
      p.stdin.write(ascii(JSON.stringify({ id, cmd, ...args })) + "\n");
    });
  }
  function kill() {
    const p = child;
    child = null;
    if (!p) return;
    try {
      p.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 1500).unref();
  }
  return { start, call, kill, alive: () => !!child, calls: () => calls };
}

// ---------------------------------------------------------------------------------------------------- the Stop bar
// Stop, once pressed, stays pressed until clear(): the driver does nothing more in the app, and the orchestration hears
// of it even when it was pressed after its last look. show() says whether the bar is on the screen.
function stopBar(file, log) {
  let child = null;
  let shown = "";
  let pressed = false;
  let why = "";
  let up = null;
  function show(text, label) {
    if (pressed) return Promise.resolve(true);
    const want = JSON.stringify({ text, label });
    if (child) {
      if (want !== shown) {
        shown = want;
        try {
          child.stdin.write("text " + ascii(want) + "\n");
        } catch {}
      }
      return up;
    }
    shown = want;
    const [cmd, args] = command(file);
    const p = spawn(cmd, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: { ...process.env, CLAUDECONNECT_BAR: ascii(JSON.stringify({ text, label, parent: process.pid })) }
    });
    child = p;
    let tail = "";
    p.stdin.on("error", () => {});
    p.stderr.on("data", d => {
      tail = (tail + d).slice(-2000);
    });
    // nothing is done in the app before the bar is on the screen
    up = new Promise(resolve => {
      const timer = setTimeout(() => {
        log("The Stop bar didn't show in time.");
        resolve(false);
      }, IS_WIN ? 60000 : 15000);
      createInterface({ input: p.stdout }).on("line", line => {
        const l = line.trim();
        if (l === "ready") {
          clearTimeout(timer);
          resolve(true);
        } else if (l === "stop") {
          pressed = true;
          log("Stop was pressed on the screen.");
        }
      });
      p.on("exit", code => {
        clearTimeout(timer);
        if (child === p) child = null;
        if (!pressed) {
          why = tail.trim().split("\n").slice(-2).join(" ");
          if (code) log("The Stop bar couldn't show (" + code + "):", why || "no reason given");
        }
        resolve(pressed);
      });
    });
    p.on("error", e => log("Couldn't show the Stop bar:", e.message || e));
    return up;
  }
  function hide() {
    const p = child;
    child = null;
    shown = "";
    if (!p) return;
    try {
      p.stdin.write("quit\n");
      p.stdin.end();
    } catch {}
    setTimeout(() => {
      try {
        p.kill();
      } catch {}
    }, 1500).unref();
  }
  return {
    show,
    hide,
    pressed: () => pressed,
    why: () => why,
    clear() {
      pressed = false;
    }
  };
}

// ---------------------------------------------------------------------------------------------------- the reply as Markdown
// The tree a helper reads from a reply: {r: role, v: text, u: a link's address, l: a heading's level, c: "language-x" on a
// code block, k: what's inside}. Turned back into the Markdown it was written in, as near as the tree shows it.
const INLINE = new Set(["text", "link", "code", "strong", "em", "marker"]);
const lang = n => {
  const m = /(?:^|\s)language-([\w+#.-]+)/.exec(n.c || "");
  return m ? m[1] : null;
};
function rawText(n) {
  if (!n) return "";
  if (n.r === "text") return n.v || "";
  return (n.k || []).map(rawText).join("");
}
function hasBlock(n) {
  return (n.k || []).some(k => !INLINE.has(k.r) && !(k.r === "group" && !hasBlock(k)));
}
function inline(n) {
  switch (n.r) {
    case "text":
      return n.v || "";
    case "marker":
    case "button":
    case "image":
    case "textbox":
      return "";
    case "code":
      return lang(n) === null ? "`" + rawText(n) + "`" : rawText(n);
    case "strong": {
      const t = inlineKids(n);
      return t.trim() ? `**${t.trim()}**` : t;
    }
    case "em": {
      const t = inlineKids(n);
      return t.trim() ? `*${t.trim()}*` : t;
    }
    case "link": {
      const t = inlineKids(n) || n.u || "";
      return n.u && /^https?:\/\//.test(n.u) && t !== n.u ? `[${t}](${n.u})` : t;
    }
    default:
      return inlineKids(n);
  }
}
function inlineKids(n) {
  return (n.k || []).map(inline).join("");
}
function blocks(n) {
  if (!n) return [];
  if (["button", "image", "textbox", "secret", "column"].includes(n.r)) return [];
  const lg = lang(n);
  if (lg !== null || n.r === "pre") return ["```" + (lg || "") + "\n" + rawText(n).replace(/\n+$/, "") + "\n```"];
  if (n.r === "heading") {
    const t = norm(inlineKids(n));
    return t ? ["#".repeat(Math.min(6, Math.max(1, n.l || 2))) + " " + t] : [];
  }
  if (n.r === "separator") return ["---"];
  if (n.r === "table") return [table(n)].filter(Boolean);
  if (n.r === "list") return [list(n)].filter(Boolean);
  if (n.r === "blockquote") return [blocks({ ...n, r: "group" }).join("\n\n").replace(/^/gm, "> ")];
  if (n.r === "text") return n.v && n.v.trim() ? [n.v] : [];
  // a container: runs of inline content make paragraphs, the rest are blocks of their own
  const kids = n.k || [];
  const mixed = kids.some(k => k.r === "text" && (k.v || "").trim());
  const out = [];
  let line = "";
  const flush = () => {
    if (line.trim()) out.push(line.trim());
    line = "";
  };
  for (const k of kids) {
    const isInline = INLINE.has(k.r) && !(k.r === "code" && lang(k) !== null) ? true : mixed && k.r === "group" && !hasBlock(k);
    if (isInline) line += inline(k);
    else {
      flush();
      out.push(...blocks(k));
    }
  }
  flush();
  return out;
}
function list(n) {
  const items = (n.k || []).filter(k => k.r !== "marker");
  let i = 0;
  const lines = [];
  const markerOf = it => {
    const m = (it.k || []).find(k => k.r === "marker");
    return m ? norm(m.v) : "";
  };
  const ordered = items.some(it => /^\d+[.)]$/.test(markerOf(it)));
  for (const it of items) {
    i++;
    const mark = ordered ? (/^\d+[.)]$/.test(markerOf(it)) ? markerOf(it).replace(")", ".") : `${i}.`) : "-";
    const parts = blocks({ ...it, r: "group", k: (it.k || []).filter(k => k.r !== "marker") });
    if (!parts.length) continue;
    const pad = " ".repeat(mark.length + 1);
    lines.push(`${mark} ${parts[0].replace(/\n/g, "\n" + pad)}`);
    for (const p of parts.slice(1)) lines.push(pad + p.replace(/\n/g, "\n" + pad));
  }
  return lines.join("\n");
}
function table(n) {
  const rows = [];
  (function collect(x) {
    for (const k of x.k || []) {
      if (k.r === "row") rows.push(k);
      else if (k.r !== "cell" && k.r !== "column") collect(k);
    }
  })(n);
  const cells = rows
    .map(r => {
      const cs = [];
      (function each(x) {
        for (const k of x.k || []) {
          if (k.r === "cell") cs.push(norm(blocks({ ...k, r: "group" }).join(" ")).replace(/\|/g, "\\|"));
          else if (k.r !== "row") each(k);
        }
      })(r);
      return cs;
    })
    .filter(c => c.length);
  if (!cells.length) return "";
  const w = Math.max(...cells.map(c => c.length));
  const line = c => "| " + Array.from({ length: w }, (_, i) => c[i] || "").join(" | ") + " |";
  return [line(cells[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...cells.slice(1).map(line)].join("\n");
}
export function markdown(tree) {
  if (!tree) return "";
  const out = blocks({ ...tree, r: tree.r === "text" ? "text" : "group" });
  // a code block's language, written above it by the page, is already on the fence
  for (let i = out.length - 2; i >= 0; i--) {
    const m = /^```([\w+#.-]+)\n/.exec(out[i + 1]);
    if (m && out[i].toLowerCase() === m[1].toLowerCase()) out.splice(i, 1);
  }
  return out.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------------------------------------------- what's on the page
const MODEL_RE = "\\b(opus|sonnet|haiku|fable)\\b[^\\n]*\\d|\\bclaude\\b[^\\n]*\\d";
const LIMIT_RE = "out of (free )?messages|message limit|usage limit|reached (the|your) (usage |message )?limit|limit (will )?reset|you('ve| have) hit|upgrade to (keep|continue)";
const HUMAN_RE = "verify you are human|checking (if the site connection is secure|your browser)|^just a moment";
const ANSWER_RE = "^(allow|always allow|allow once|allow for this chat|allow always|approve|deny|don't allow|do not allow|decline|block|cancel|ok|got it|continue|close)$";
const LOOK = {
  composer: { role: "textbox", cls: "ProseMirror", last: true },
  textbox: { role: "textbox", not: "e-?mail|search|find|password|code|name", last: true },
  send: { role: "button", name: "^send( message)?$", last: true },
  stop: { role: "button", name: "^stop( response| generating)?$", last: true },
  user: { cls: "font-user-message", skip: true, last: true },
  reply: { cls: "font-claude-(response|message)(?![\\w-])", skip: true, last: true, tree: true },
  model: { role: "button", any: MODEL_RE, not: "^(more options|options|rename|delete|star|share)", last: true },
  think: { role: ["switch", "checkbox", "toggle"], name: "extended thinking|^think", last: true },
  limit: { role: "text", value: LIMIT_RE, last: true },
  human: { role: "text", value: HUMAN_RE, limit: 1 },
  email: { role: "textbox", name: "e-?mail", limit: 1 },
  dialog: { role: ["dialog", "alertdialog"], last: true },
  answer: { role: "button", name: ANSWER_RE, within: "dialog", limit: 12 },
  allow: { role: "button", name: "^(allow|always allow|allow once|allow for this chat|deny|don't allow|decline)$", limit: 8 },
  menu: { role: "menu", last: true }
};
const LIGHT = { ...LOOK, reply: { ...LOOK.reply, tree: false } };
const MENU = {
  menu: { role: "menu" },
  items: { role: ["menuitem", "radio"], within: "menu", lines: 4, limit: 40 },
  switches: { role: ["switch", "checkbox", "toggle"], within: "menu", limit: 12 }
};
const modelName = s => {
  const m = /((?:claude\s+)?(?:opus|sonnet|haiku|fable)\s*\d+(?:\.\d+)*(?:\s+(?:mini|max|plus))?)/i.exec(String(s || ""));
  return m ? m[1].replace(/\s+/g, " ").trim() : norm(s).slice(0, 40);
};

export function osDriver({ cfg, log, NAME = "ClaudeConnect", find }) {
  // the site's name, as it is now: a rename on the site changes cfg.displayName
  const siteName = () => (cfg && cfg.displayName) || NAME;
  const H =helperProcess(process.env.CLAUDECONNECT_APP_HELPER || join(HERE, IS_WIN ? "app-win.ps1" : "app-mac.js"), log);
  const B = stopBar(process.env.CLAUDECONNECT_APP_BAR || join(HERE, IS_WIN ? "app-win-bar.ps1" : "app-mac-bar.js"), log);
  const S = { look: null, lookAt: 0, attached: false, say: () => {} };
  const info = () => {
    const f = find();
    // (process: a test's stand-in for the app, another Chromium program)
    return { how: f.how || "", path: f.path || "", aumid: f.aumid || "", exe: f.exe || "", ...(f.process ? { process: f.process } : {}) };
  };
  const permission = () =>
    Object.assign(new Error(`${siteName()} needs your permission to use the desktop app. On your Mac, open System Settings → Privacy & Security → Accessibility and switch on "${process.execPath.split("/").pop()}" (${process.execPath}), then send again.`), { code: "app_permission" });
  // what went wrong in the helper, in words for the site
  function explain(e) {
    if (e && e.code === "not-trusted") return permission();
    if (e && e.code === "not-running") return Object.assign(new Error("The desktop app closed. Open it again on your computer, then send again."), { code: "app_closed" });
    if (e && (e.code === "no-window" || e.code === "no-page")) return new Error("The desktop app's window isn't open. Open the app on your computer, then send again.");
    return e;
  }
  async function call(cmd, args, ms) {
    // after Stop, nothing at all is asked of the app
    if (B.pressed()) throw Object.assign(new Error("Stop was pressed."), { code: "app_stopped" });
    try {
      return await H.call(cmd, args, ms);
    } catch (e) {
      throw explain(e);
    }
  }
  const first = (r, k) => (r && r.found && r.found[k] && r.found[k][0]) || null;

  // One look at the page: the message box, the buttons, the newest messages, a limit notice or a window asking something.
  // (The reply's whole tree is read only when the reply is wanted.)
  async function look(fresh, tree = false) {
    if (!fresh && S.look && Date.now() - S.lookAt < 250 && (S.look.tree || !tree)) return S.look;
    const r = await call("scan", { queries: tree ? LOOK : LIGHT }, 25000);
    const L = { doc: r.doc || {}, count: r.count || {} };
    for (const k of Object.keys(LOOK)) {
      const f = (r.found && r.found[k]) || [];
      L[k] = k === "answer" || k === "allow" ? f : f[f.length - 1] || null;
    }
    // a reply from before your newest message isn't the one being written
    if (L.reply && L.user && L.reply.i < L.user.i) L.reply = null;
    L.tree = tree;
    S.look = L;
    S.lookAt = Date.now();
    return L;
  }
  const forget = () => {
    S.look = null;
  };
  async function press(n) {
    forget();
    await call("press", { h: n.h });
  }
  async function probe() {
    const L = await look(false, true);
    const url = String(L.doc.url || "");
    let path = "";
    try {
      path = new URL(url).pathname;
    } catch {}
    const composer = !!(L.composer || L.textbox);
    return {
      url,
      path,
      conv: (path.match(/\/chat\/([0-9a-f-]{36})/i) || [])[1] || "",
      composer,
      login: !composer && (/\/(login|signup|logout)/.test(path) || !!L.email),
      challenge: !!L.human || /^just a moment/i.test(String(L.doc.title || "")),
      users: L.count.user || 0,
      streaming: !!L.stop,
      limit: L.limit ? norm(L.limit.value || L.limit.name) : "",
      stop: B.pressed()
    };
  }
  const ready = ms => waitFor(async () => {
    const p = await probe();
    return p.composer || p.login || p.challenge ? p : null;
  }, ms, 400);

  // ---- menus: the model menu, the tools menu
  async function readMenu() {
    const r = await call("scan", { queries: MENU });
    const items = (r.found.items || []).map(it => ({ ...it, lines: it.lines && it.lines.length ? it.lines : [it.name] }));
    return r.count.menu ? { items, switches: r.found.switches || [] } : null;
  }
  async function openMenu(trigger) {
    if (!trigger) return null;
    await press(trigger);
    const m = await waitFor(readMenu, 3000, 200);
    return m ? { ...m, trigger } : null;
  }
  async function closeMenu(m) {
    if (!(await readMenu().catch(() => null))) return;
    // pressing what opened it closes it again
    await press(m.trigger).catch(() => {});
    if (await waitFor(async () => !(await readMenu()), 1500, 200)) return;
    const L = await look(true);
    const c = L.composer || L.textbox;
    await call("key", { key: "escape", h: c ? c.h : "", activate: true }).catch(() => {});
  }
  const thinkingIn = m => {
    const sw = m.switches.find(s => /extended thinking|\bthink/i.test(s.name)) || (m.items.some(it => /extended thinking/i.test(it.lines.join(" "))) && m.switches.length === 1 ? m.switches[0] : null);
    if (sw && typeof sw.checked === "boolean") return sw;
    const it = m.items.find(x => /extended thinking/i.test(x.lines.join(" ")) && typeof x.checked === "boolean");
    return it || null;
  };
  async function modelButton() {
    return (await look(true)).model;
  }
  async function newChat() {
    const r = await call("scan", { queries: { href: { role: "link", url: "/new/?$", limit: 1 }, named: { role: ["link", "button"], name: "^new chat$", limit: 1 } } });
    const n = first(r, "href") || first(r, "named");
    const fresh = async () => {
      const p = await probe();
      return p.composer && !p.conv && !p.users ? p : null;
    };
    if (n) {
      await press(n);
      const p = await waitFor(fresh, 10000, 400);
      if (p) return p;
    }
    await call("openUrl", { url: "claude://claude.ai/new" }).catch(() => {});
    return (await waitFor(fresh, 10000, 400)) || (await probe());
  }

  // A window in the app waiting for an answer: its words and its buttons, for the site.
  async function dialog() {
    const L = await look();
    if (L.dialog) {
      const r = await call("scan", { root: L.dialog.h, queries: { heading: { role: "heading", limit: 1, lines: 3 }, buttons: { role: "button", limit: 12 } } }).catch(() => null);
      const text = await call("scan", { root: L.dialog.h, queries: { all: { role: ["dialog", "alertdialog"], lines: 40, limit: 1 } } }).catch(() => null);
      const lines = (first(text, "all") || {}).lines || [];
      const heading = first(r, "heading");
      const buttons = ((r && r.found.buttons) || []).filter(b => norm(b.name)).map(b => ({ label: norm(b.name).slice(0, 60), h: b.h }));
      const title = norm(L.dialog.name) || (heading && (heading.lines || [])[0]) || lines[0] || "The desktop app is asking";
      if (!buttons.length) return null;
      return { title: title.slice(0, 160), text: lines.filter(l => l !== title && !buttons.some(b => b.label === l)).join("\n").slice(0, 600), buttons, x: 0, y: 0, w: 0, h: 0 };
    }
    // buttons that ask (Allow, Deny) with no window around them
    if (L.allow.length >= 2) {
      const buttons = L.allow.map(b => ({ label: norm(b.name).slice(0, 60), h: b.h }));
      return { title: "The desktop app is asking", text: "", buttons, x: 0, y: 0, w: 0, h: 0 };
    }
    return null;
  }

  return {
    pace: IS_WIN ? 450 : 350,
    remoteEvery: 3,
    async start(say) {
      S.say = say;
      // a helper that has run for long is started afresh between messages, so whatever it has kept is let go
      if (H.alive() && H.calls() > 3000) {
        H.kill();
        S.attached = false;
      }
      const hello = await H.start();
      if (hello && hello.trusted === false) throw permission();
      const a = await call("app", { info: info() });
      if (!a.running) {
        if (!a.path) throw Object.assign(new Error("The desktop app isn't on this computer. Install it from claude.ai/download and sign in, then send again."), { code: "app_missing" });
        say("Opening the desktop app");
        await call("launch", { info: info() }, 45000);
      }
      let e = await call("enable", { waitMs: 12000, info: info() }, 25000).catch(err => (err.code === "app_permission" ? Promise.reject(err) : { web: null }));
      if (!e.web) {
        // it runs, but its window is closed: ask it for the window back
        say("Opening the desktop app's window");
        await call("launch", { reopen: true, info: info() }, 45000).catch(() => {});
        e = await call("enable", { waitMs: 20000, info: info() }, 35000).catch(() => ({ web: null }));
      }
      if (!e.web) throw new Error("The desktop app's window didn't show its page. Open the app on your computer, then send again.");
      // a minimized window may stop drawing the reply
      await call("show").catch(() => {});
      S.attached = true;
    },
    probe,
    running: async () => !!(await call("app", { info: info() }).catch(() => ({}))).running,
    // conv: a conversation, "" for a new one, null for wherever it is now. When the conversation can't be opened, a new
    // chat is opened instead, and the answer's conv says so.
    async open(conv) {
      if (conv === null || conv === undefined) return ready(15000);
      const p = await ready(15000);
      if (!p || !p.composer) return p;
      if (conv && p.conv === conv) return p;
      if (!conv && /\/new\/?$/.test(p.path) && !p.users) return p;
      if (conv) {
        const there = async () => {
          const q = await probe();
          return q.composer && q.conv === conv ? q : null;
        };
        const r = await call("scan", { queries: { link: { role: "link", url: `/chat/${conv}/?$`, limit: 1 } } }).catch(() => null);
        const l = first(r, "link");
        if (l) {
          await press(l);
          const q = await waitFor(there, 10000, 400);
          if (q) return q;
        }
        await call("openUrl", { url: `claude://claude.ai/chat/${conv}` }).catch(() => {});
        const q = await waitFor(there, 8000, 400);
        if (q) return q;
        log("Couldn't open that conversation in the desktop app: starting a new one with what came before.");
      }
      return newChat();
    },
    async models() {
      const m = await openMenu(await modelButton());
      if (!m) return null;
      const models = [];
      for (const it of m.items) {
        const head = it.lines[0] || "";
        if (!/\b(opus|sonnet|haiku|fable|claude)\b/i.test(head) || !/\d/.test(head) || models.length >= 12) continue;
        const rest = it.lines.slice(1).join(" ");
        models.push({ name: modelName(head), desc: rest.slice(0, 160), locked: !!it.disabled || /\bupgrade\b|\bpro plan\b|\bmax plan\b/i.test(rest) });
      }
      const t = thinkingIn(m);
      await closeMenu(m);
      const b = await modelButton().catch(() => null);
      return { models, thinking: t ? t.checked : null, current: b ? modelName(b.name || b.value) : "" };
    },
    async current() {
      const b = await modelButton().catch(() => null);
      return b ? modelName(b.name || b.value) : "";
    },
    async setModel(name) {
      const low = name.toLowerCase();
      const pick = m => m.items.find(x => modelName(x.lines[0]).toLowerCase() === low) || m.items.find(x => (x.lines[0] || "").toLowerCase().startsWith(low));
      let m = await openMenu(await modelButton());
      if (!m) return false;
      let it = pick(m);
      // a "More models" item opens a second menu
      const more = !it && m.items.find(x => /more models|other models/i.test(x.lines.join(" ")));
      if (more) {
        await press(more);
        await sleep(400);
        const m2 = await readMenu();
        if (m2) {
          m = { ...m2, trigger: m.trigger };
          it = pick(m);
        }
      }
      if (!it || it.disabled) {
        await closeMenu(m);
        return false;
      }
      await press(it);
      await sleep(300);
      await closeMenu(m);
      return true;
    },
    // a switch next to the message box, or one in the model menu or the tools menu
    async setThinking(on) {
      const L = await look(true);
      if (L.think && typeof L.think.checked === "boolean") {
        if (L.think.checked !== on) await press(L.think);
        return true;
      }
      const tools = async () => {
        const r = await call("scan", { queries: { b: { role: "button", name: "tools|search and tools", last: true } } });
        return first(r, "b");
      };
      for (const trigger of [modelButton, tools]) {
        const m = await openMenu(await trigger().catch(() => null));
        if (!m) continue;
        const t = thinkingIn(m);
        if (t) {
          if (t.checked !== on) {
            await press(t);
            await sleep(250);
          }
          await closeMenu(m);
          return true;
        }
        await closeMenu(m);
      }
      return false;
    },
    // Files can't be handed to the app's file picker from here: what can be read goes into the message instead.
    attach: async () => false,
    async type(text) {
      const L = await look(true);
      const c = L.composer || L.textbox;
      if (!c) return false;
      // compared without spaces and line breaks: the app may write a new line its own way
      const squash = v => String(v || "").replace(/\s+/g, "");
      const want = squash(text);
      const landed = async () => {
        const r = await call("read", { h: c.h });
        if (!r || squash(r.value) !== want) return false;
        // the app took it in, not only the page: its send button works now (or it says you're out of messages)
        const L2 = await look(true);
        return !!((L2.send && !L2.send.disabled) || L2.limit);
      };
      // straight into the box, with the app left where it is
      const r = await call("setValue", { h: c.h, text }).catch(() => null);
      if (r && (await waitFor(landed, 2000, 250))) return true;
      // the way a person would: a paste, with the app brought forward for a moment. Not while you're typing.
      const idle = async () => (await call("idle")).seconds >= 1.5;
      if (!(await idle().catch(() => true))) {
        S.say("Waiting for you to stop typing, to put the message in the desktop app");
        if (!(await waitFor(idle, 60000, 500))) return false;
      }
      for (const how of [{}, { type: true }]) {
        const p = await call("paste", { h: c.h, text, ...how }, 60000).catch(e => {
          if (e.code === "app_stopped") throw e;
          log("Couldn't put the message in the desktop app:", e.message || e);
          return null;
        });
        forget();
        if (p && p.landed && (await waitFor(landed, 2000, 250))) return true;
      }
      return false;
    },
    // Presses send as soon as it can be pressed, and says whether the message went. A notice that you're out of messages
    // ends the wait early: that's the answer then.
    async send(before) {
      S.whole = null;
      const began = Date.now();
      let limit = "";
      const b = await waitFor(async () => {
        const L = await look(true);
        if (L.send && !L.send.disabled) return L.send;
        if (L.limit && Date.now() - began > 3000) {
          limit = norm(L.limit.value || L.limit.name);
          return "limit";
        }
        return null;
      }, 90000, 400);
      if (b === "limit") return { limit };
      const went = async () => {
        const p = await probe();
        return p.users > before || p.streaming ? p : null;
      };
      if (b) await press(b).catch(() => {});
      if (await waitFor(went, 15000, 400)) return { ok: true };
      const L = await look(true);
      const c = L.composer || L.textbox;
      if (c) await call("key", { key: "return", h: c.h, activate: true }).catch(() => {});
      return (await waitFor(went, 10000, 400)) ? { ok: true } : { ok: false };
    },
    async reply() {
      const L = await look(false, true);
      if (!L.reply) return null;
      const streaming = !!L.stop;
      let md = markdown(L.reply.tree);
      // A quick look reads only so much of a long reply: then it's read whole now and then, and once more when it's done.
      if (L.reply.cut) {
        const w = S.whole;
        if (!w || (streaming && Date.now() - w.at > 4000) || (!streaming && !w.final)) {
          const r = await call("scan", { root: L.reply.h, queries: { all: { ...LOOK.reply, skip: true, last: false, limit: 1, treeMax: 40000, treeMs: 20000 } } }, 45000).catch(e => {
            if (e.code === "app_stopped") throw e;
            return null;
          });
          const t = first(r, "all");
          if (t && t.tree) S.whole = { at: Date.now(), md: markdown(t.tree), final: !streaming };
        }
        if (S.whole && S.whole.md.length >= md.length) md = S.whole.md;
      }
      return { md, streaming, marked: false };
    },
    // what the reply streamed is what there is to read
    exact: async () => null,
    async stop() {
      const L = await look(true);
      if (L.stop) await press(L.stop);
    },
    // closes a window in the app that's asking something, with its no
    async escape() {
      const d = await dialog();
      const no = d && d.buttons.find(b => /^(deny|don't allow|do not allow|decline|cancel|close|no|block)$/i.test(b.label));
      if (no) return press(no);
      const L = await look(true);
      if (L.menu) {
        const c = L.composer || L.textbox;
        await call("key", { key: "escape", h: c ? c.h : "", activate: true }).catch(() => {});
      }
    },
    dialog,
    // no picture of it (that would need permission to record the screen): the site shows its words and buttons
    shot: async d => ({ image: "", w: 0, h: 0, buttons: (d.buttons || []).map(b => ({ label: b.label, x: 0, y: 0, w: 0, h: 0 })) }),
    async answer(d, m) {
      if (Number.isInteger(m.button) && d.buttons[m.button]) {
        await press(d.buttons[m.button]);
        return true;
      }
      return false;
    },
    // the Stop bar on the screen; says whether it was pressed
    async bar(on, text, label) {
      if (on) {
        // shown, or tried once more; without it, nothing is done in the app
        const ok = (await B.show(text || "", label || "Stop")) || (await B.show(text || "", label || "Stop"));
        if (!ok && !B.pressed()) return { stop: false, failed: true, why: B.why() };
      } else B.hide();
      return { stop: B.pressed() };
    },
    connected: () => S.attached && H.alive(),
    // what this computer can do for the free plan right now: the app there, and (on a Mac) allowed to be used
    async check(prompt) {
      const f = find();
      if (!f.how) return { ok: false, code: "app_missing" };
      // Windows asks no permission for this, so there's nothing to start the helper for yet
      if (IS_WIN && !process.env.CLAUDECONNECT_APP_HELPER) return { ok: true };
      let hello = null;
      try {
        hello = await H.start();
      } catch (e) {
        return { ok: false, code: "app_helper", message: e.message };
      }
      let trusted = hello.trusted !== false;
      if (!trusted) {
        // the switch may have been turned on since this helper started
        H.kill();
        trusted = (await H.start().catch(() => ({}))).trusted !== false;
      }
      if (!trusted) {
        if (prompt) await call("trust", { prompt: true, open: true }).catch(() => {});
        return { ok: false, code: "app_permission", path: process.execPath };
      }
      return { ok: true };
    },
    // (after Stop: once it's allowed to use the app again, it starts afresh)
    close() {
      H.kill();
      B.hide();
      B.clear();
      S.attached = false;
      forget();
    }
  };
}
