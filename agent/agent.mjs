import { spawn, spawnSync } from "node:child_process";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, existsSync, statSync, unlinkSync, renameSync, openSync, closeSync } from "node:fs";
import { join, basename, dirname, extname, relative, resolve as resolvePath, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import os from "node:os";
import { toolLabel, listSessions, findSession, sessionCwd, readSession, UUID, within } from "./sessions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(HERE, "manifest.json"), "utf8")).version) || "0.0.0";
  } catch {
    return "0.0.0";
  }
})();
const IS_WIN = process.platform === "win32";
const CONFIG_PATH = join(HERE, "config.json");
const LOG_PATH = join(HERE, "agent.log");
const PID_PATH = join(HERE, "agent.pid");
const OLD_SYSTEM_PATH = join(HERE, "system-prompt.txt"); // older versions wrote "You are <name>" here; nothing reads it now
const SETTINGS_PATH = join(HERE, "claude-settings.json");
const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|xml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|kt|c|h|cpp|hpp|cs|php|sh|ps1|bat|sql|ya?ml|toml|ini|cfg|log|tex)$/i;
// "Claude" is plain chat: no tools, no folder, a short chat prompt in place of Claude Code's. "Claude Code" is the real thing,
// with its own default instructions. The permission mode only applies to Claude Code; "auto" means whatever this computer is set to.
const CHAT_PROMPT = [
  "You are Claude, an AI assistant made by Anthropic, talking with the person in a chat window.",
  "Answer directly and conversationally. Use Markdown when it helps, and put code in fenced blocks that name the language.",
  "In this chat you can't browse the web, run code, or read or change files, so don't offer to. If the person wants that, tell them to switch to Claude Code with the switch under the message box."
].join(" ");
const PERMS = new Set(["auto", "acceptEdits", "plan"]);
const ARTIFACT_MAX = 1900000;
const ARTIFACT_TOTAL = 8000000;

if (!existsSync(CONFIG_PATH)) {
  console.error("ClaudeConnect isn't set up on this computer yet. Run the setup script first.");
  process.exit(1);
}
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
if (!cfg.id) {
  cfg.id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch {}
}
const NAME = cfg.displayName || "ClaudeConnect";
const COMMAND = cfg.command || "ClaudeConnect";
const SLUG = String(cfg.name || "claudeconnect").replace(/[^a-z0-9-]/gi, "").toLowerCase() || "claudeconnect";
const WORKSPACE = cfg.workspace || join(os.homedir(), NAME);
const API = cfg.api || "https://api.cloudflare.com/client/v4";
// Which of the chats Claude Code has saved on this computer the site may list and open: "all", "workspace" (only the working folder) or "off".
const HISTORY = ["all", "workspace", "off"].includes(cfg.history) ? cfg.history : "all";

function saveConfig() {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2), { mode: 0o600 });
  } catch {}
}

function stamp() {
  const d = new Date();
  return d.toTimeString().slice(0, 8);
}

function log(...a) {
  const line = `[${stamp()}] ${a.join(" ")}`;
  console.log(line);
  try {
    appendFileSync(LOG_PATH, new Date().toISOString().slice(0, 10) + " " + line + "\n");
  } catch {}
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

function runningPid() {
  try {
    const pid = Number(readFileSync(PID_PATH, "utf8").trim());
    return pid && pid !== process.pid && alive(pid) ? pid : null;
  } catch {
    return null;
  }
}

function openUrl(u) {
  const c = IS_WIN ? spawn("cmd", ["/c", "start", "", u], { detached: true, stdio: "ignore", windowsHide: true }) : spawn(process.platform === "darwin" ? "open" : "xdg-open", [u], { detached: true, stdio: "ignore" });
  c.on("error", () => console.log(`Open ${u} in your browser.`));
  c.unref();
}

function startupPaths() {
  if (IS_WIN) return { file: join(process.env.APPDATA || join(os.homedir(), "AppData", "Roaming"), "Microsoft", "Windows", "Start Menu", "Programs", "Startup", `${NAME}.vbs`), label: "" };
  if (process.platform === "darwin") return { file: join(os.homedir(), "Library", "LaunchAgents", `com.claudeconnect.${SLUG}.plist`), label: `com.claudeconnect.${SLUG}` };
  return { file: join(os.homedir(), ".config", "autostart", `claudeconnect-${SLUG}.desktop`), label: "" };
}

function xml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function autostart(on) {
  const { file, label } = startupPaths();
  const me = fileURLToPath(import.meta.url);
  if (!on) {
    if (process.platform === "darwin") spawnSync("launchctl", ["unload", "-w", file], { stdio: "ignore" });
    try {
      unlinkSync(file);
    } catch {}
    console.log(`${NAME} won't start automatically anymore.`);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  if (IS_WIN) {
    const q = s => '""' + s + '""';
    writeFileSync(file, `CreateObject("WScript.Shell").Run "${q(process.execPath)} ${q(me)} run", 0, False\r\n`);
  } else if (process.platform === "darwin") {
    writeFileSync(file, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(label)}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(me)}</string><string>run</string></array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH || "")}</string></dict>
<key>RunAtLoad</key><true/>
<key>StandardOutPath</key><string>${xml(join(HERE, "launchd.log"))}</string>
<key>StandardErrorPath</key><string>${xml(join(HERE, "launchd.log"))}</string>
</dict></plist>
`);
    spawnSync("launchctl", ["load", "-w", file], { stdio: "ignore" });
  } else {
    writeFileSync(file, `[Desktop Entry]\nType=Application\nName=${NAME}\nExec="${process.execPath}" "${me}" run\nX-GNOME-Autostart-enabled=true\nNoDisplay=true\n`);
  }
  console.log(`${NAME} will now start in the background whenever you log in to this computer.`);
}

function background() {
  const pid = runningPid();
  if (pid) {
    console.log(`${NAME} is already running (process ${pid}).`);
    return;
  }
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "run"], { detached: true, stdio: "ignore", windowsHide: true });
  child.unref();
  console.log(`${NAME} is running in the background (process ${child.pid}). Use "${COMMAND} stop" to stop it and "${COMMAND} logs" to see what it's doing.`);
}

function stopOther() {
  const pid = runningPid();
  if (!pid) {
    console.log(`${NAME} isn't running.`);
    return;
  }
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    else process.kill(pid, "SIGTERM");
  } catch {}
  console.log(`Stopped ${NAME}.`);
}

function tailLog(n) {
  try {
    const lines = readFileSync(LOG_PATH, "utf8").trimEnd().split("\n");
    console.log(lines.slice(-n).join("\n"));
  } catch {
    console.log("No log yet.");
  }
}

const cmd = (process.argv[2] || "start").toLowerCase();
if (cmd === "help" || cmd === "--help" || cmd === "-h") {
  const rows = [
    ["", `bring ${NAME} online and keep it running in this window`],
    ["background", "same, but in the background"],
    ["stop", "stop a background copy"],
    ["autostart on", "start in the background every time you log in (off to undo)"],
    ["open", `open ${NAME} in your browser`],
    ["logs", "show recent activity"],
    ["status", "show whether it's running"],
    ["update", "update to the newest version, keeping your chats and settings"],
    ["edit", "change the name, logo, tab icon and other settings"],
    ["claim", "print a fresh link to make the site yours (after turning Cloudflare Access on or off)"],
    ["version", "show the installed version"]
  ];
  const w = Math.max(...rows.map(r => (COMMAND + " " + r[0]).trim().length)) + 2;
  console.log(rows.map(r => (COMMAND + " " + r[0]).trim().padEnd(w) + r[1]).join("\n"));
  process.exit(0);
}
if (cmd === "open") {
  openUrl(cfg.site);
  process.exit(0);
}
if (cmd === "logs") {
  tailLog(40);
  process.exit(0);
}
if (cmd === "stop") {
  stopOther();
  process.exit(0);
}
if (cmd === "claim") {
  // Whoever can run this has this computer's Cloudflare sign-in, which is exactly who should be able to take the site back.
  const t = spawnSync("npx --yes wrangler@4 auth token --json", { shell: true, encoding: "utf8", windowsHide: true, env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: cfg.accountId || "" } });
  let token = null;
  try {
    token = JSON.parse(String(t.stdout).slice(String(t.stdout).indexOf("{"))).token || null;
  } catch {}
  if (!token) {
    console.log("Couldn't get your Cloudflare sign-in. Run: npx wrangler login");
    process.exit(1);
  }
  const code = randomBytes(18).toString("base64url");
  let r;
  try {
    r = await fetch(`${API}/accounts/${cfg.accountId}/workers/scripts/${encodeURIComponent(SLUG)}/secrets`, { method: "PUT", headers: { authorization: "Bearer " + token, "content-type": "application/json" }, body: JSON.stringify({ name: "CLAIM_CODE", text: code, type: "secret_text" }) });
  } catch (e) {
    console.log(`Couldn't reach Cloudflare (${e.message || e}).`);
    process.exit(1);
  }
  if (!r.ok) {
    console.log(`Cloudflare didn't accept the new claim link (${r.status}). Make sure you're signed in to the right account.`);
    process.exit(1);
  }
  const link = `${cfg.site.replace(/\/$/, "")}/?claim=${code}`;
  console.log(`Open this link while signed in with the email you want to own ${NAME}. It works once:\n\n  ${link}\n`);
  openUrl(link);
  process.exit(0);
}
if (cmd === "version" || cmd === "--version" || cmd === "-v") {
  console.log(`${NAME} ${VERSION}`);
  process.exit(0);
}
if (cmd === "update") {
  const loader = join(HERE, "ClaudeConnect.mjs");
  if (!existsSync(loader)) {
    console.log("The updater isn't on this computer. Download ClaudeConnect.mjs again and run it with node.");
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [loader, "--update", ...process.argv.slice(3)], { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
if (cmd === "edit") {
  const installer = join(HERE, "installer.mjs");
  if (!existsSync(installer)) {
    console.log(`The settings program isn't on this computer. Run ${COMMAND} update once, then try again.`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, [installer, "--edit"], { stdio: "inherit" });
  process.exit(r.status === null ? 1 : r.status);
}
if (cmd === "status") {
  const pid = runningPid();
  console.log(pid ? `Running (process ${pid}).` : "Not running.");
  console.log(`Version: ${VERSION}`);
  console.log(`Site: ${cfg.site}`);
  console.log(`Workspace: ${WORKSPACE}`);
  console.log(`Starts at login: ${existsSync(startupPaths().file) ? "yes" : "no"}`);
  process.exit(0);
}
if (cmd === "autostart") {
  autostart((process.argv[3] || "on").toLowerCase() !== "off");
  process.exit(0);
}
if (cmd === "background" || cmd === "bg") {
  background();
  process.exit(0);
}
if (cmd !== "start" && cmd !== "run") {
  console.log(`Unknown command "${cmd}". Run "${COMMAND} help" to see the commands.`);
  process.exit(1);
}

const other = runningPid();
if (other) {
  console.log(`${NAME} is already running in the background (process ${other}). Run "${COMMAND} stop" first if you want it in this window.`);
  process.exit(0);
}
writeFileSync(PID_PATH, String(process.pid));
const cleanup = () => {
  try {
    if (readFileSync(PID_PATH, "utf8").trim() === String(process.pid)) unlinkSync(PID_PATH);
  } catch {}
};
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    for (const p of procs.values()) killTree(p.child);
    process.exit(0);
  });
}

try {
  if (existsSync(LOG_PATH) && statSync(LOG_PATH).size > 2000000) renameSync(LOG_PATH, LOG_PATH + ".old");
} catch {}
mkdirSync(join(WORKSPACE, "uploads"), { recursive: true });
try {
  unlinkSync(OLD_SYSTEM_PATH);
} catch {}
writeFileSync(SETTINGS_PATH, JSON.stringify({ showThinkingSummaries: true }));

let WS = globalThis.WebSocket;
if (!WS) {
  try {
    WS = (await import("ws")).default;
  } catch {
    console.error("This needs Node.js 22 or newer. Update Node, or run the setup script again.");
    process.exit(1);
  }
}

function childEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

function findClaude() {
  if (cfg.claudePath && existsSync(cfg.claudePath)) return cfg.claudePath;
  const r = spawnSync(IS_WIN ? "where" : "which", IS_WIN ? ["claude"] : ["-a", "claude"], { encoding: "utf8", windowsHide: true });
  const found = String(r.stdout || "").split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const extra = IS_WIN
    ? [join(os.homedir(), ".local", "bin", "claude.exe"), join(process.env.APPDATA || "", "npm", "claude.cmd")]
    : [join(os.homedir(), ".local", "bin", "claude"), join(os.homedir(), ".claude", "local", "claude"), "/opt/homebrew/bin/claude", "/usr/local/bin/claude"];
  const all = [...found, ...extra].filter(p => p && existsSync(p));
  if (IS_WIN) return all.find(p => /\.exe$/i.test(p)) || all.find(p => /\.(cmd|bat)$/i.test(p)) || null;
  return all[0] || null;
}

function quoteWin(a) {
  a = String(a);
  if (/^[\w\-.:\\/=@+,]+$/.test(a)) return a;
  return '"' + a.replace(/"/g, '""') + '"';
}

function spawnClaude(args, cwd = WORKSPACE) {
  if (IS_WIN && /\.(cmd|bat)$/i.test(CLAUDE)) {
    return spawn(`"${CLAUDE}" ${args.map(quoteWin).join(" ")}`, { cwd, env: childEnv(), windowsHide: true, shell: true });
  }
  return spawn(CLAUDE, args, { cwd, env: childEnv(), windowsHide: true });
}

function capture(args, input, timeoutMs = 120000) {
  return new Promise(resolve => {
    if (!CLAUDE) return resolve({ code: -1, stdout: "", stderr: "Claude Code isn't installed." });
    let child;
    try {
      child = spawnClaude(args);
    } catch (e) {
      return resolve({ code: -1, stdout: "", stderr: String(e.message || e) });
    }
    let stdout = "";
    let stderr = "";
    const t = setTimeout(() => killTree(child), timeoutMs);
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("error", e => (stderr += String(e.message || e)));
    child.on("close", code => {
      clearTimeout(t);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input || "");
  });
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (IS_WIN) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else child.kill("SIGINT");
  } catch {}
  setTimeout(() => {
    try {
      if (child.exitCode === null) child.kill("SIGKILL");
    } catch {}
  }, 5000);
}

function versionAtLeast(v, want) {
  const a = String(v).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!a) return false;
  const b = want.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (Number(a[i + 1]) !== b[i]) return Number(a[i + 1]) > b[i];
  }
  return true;
}

let CLAUDE = findClaude();
let CLAUDE_VERSION = "";
// Newer Claude Code records a chat's system prompt on its first request and reuses it on every resume. Switching between
// Claude and Claude Code in one chat needs the prompt rendered fresh each time, and older versions don't have the switch.
let FRESH_PROMPT = false;
let WARNING = "";
let WARNING_CODE = "";

async function checkClaude() {
  CLAUDE = findClaude();
  if (!CLAUDE) {
    CLAUDE_VERSION = "";
    WARNING = "Claude Code isn't installed. Run the setup again to install it.";
    WARNING_CODE = "not_installed";
    return;
  }
  const v = await capture(["--version"], "", 30000);
  const m = String(v.stdout).match(/\d+\.\d+\.\d+/);
  CLAUDE_VERSION = m ? m[0] : "";
  const help = await capture(["--help"], "", 30000);
  FRESH_PROMPT = /--system-prompt-snapshot/.test(help.stdout);
  const a = await capture(["auth", "status"], "", 30000);
  let method = "";
  try {
    method = JSON.parse(a.stdout).authMethod || "";
  } catch {}
  if (method === "none" || (a.code === 1 && !method)) {
    WARNING = "Claude Code isn't signed in. Run: claude auth login";
    WARNING_CODE = "signed_out";
  } else if (method && method !== "claude.ai" && method !== "oauth_token") {
    WARNING = "Claude Code is signed in with an API key instead of your plan. Run: claude auth login";
    WARNING_CODE = "api_key";
  } else if (CLAUDE_VERSION && !versionAtLeast(CLAUDE_VERSION, "2.1.284")) {
    WARNING = `Claude Code ${CLAUDE_VERSION} is too old for the newest models. Run: claude update`;
    WARNING_CODE = "outdated";
  } else {
    WARNING = "";
    WARNING_CODE = "";
  }
}

let apiToken = null;
let apiTokenAt = 0;

function wranglerToken() {
  return new Promise(resolve => {
    const env = { ...process.env };
    if (cfg.accountId) env.CLOUDFLARE_ACCOUNT_ID = cfg.accountId;
    let out = "";
    let child;
    try {
      child = spawn("npx --yes wrangler@4 auth token --json", { shell: true, env, windowsHide: true, cwd: HERE });
    } catch {
      return resolve(null);
    }
    const t = setTimeout(() => killTree(child), 90000);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", () => {});
    child.on("error", () => {});
    child.on("close", () => {
      clearTimeout(t);
      let token = null;
      try {
        token = JSON.parse(out.slice(out.indexOf("{"))).token || null;
      } catch {
        const lines = out.trim().split(/\r?\n/).filter(Boolean);
        const last = lines[lines.length - 1] || "";
        token = /^[\w.-]{20,}$/.test(last) ? last : null;
      }
      resolve(token);
    });
  });
}

async function cloudflareToken() {
  if (apiToken && Date.now() - apiTokenAt < 1200000) return apiToken;
  const t = await wranglerToken();
  if (t) {
    apiToken = t;
    apiTokenAt = Date.now();
  }
  return t;
}

async function storedSignIn() {
  if (!cfg.accountId || !cfg.kvId) return null;
  const t = await cloudflareToken();
  if (!t) return null;
  try {
    const r = await fetch(`${API}/accounts/${cfg.accountId}/storage/kv/namespaces/${cfg.kvId}/values/agent-token`, { headers: { authorization: "Bearer " + t } });
    if (r.status === 401 || r.status === 403) apiToken = null;
    if (!r.ok) return null;
    const j = JSON.parse(await r.text());
    return j && typeof j.token === "string" && typeof j.exp === "number" ? j : null;
  } catch {
    return null;
  }
}

function saveSignIn(token, exp) {
  if (typeof token !== "string" || typeof exp !== "number") return;
  if (cfg.token === token) return;
  cfg.token = token;
  cfg.tokenExp = exp;
  saveConfig();
}

function siteHeaders() {
  return { "cf-access-token": cfg.token || "", "x-chatgql-key": cfg.secret, "x-agent-id": cfg.id };
}

async function preflight() {
  if (!cfg.token) return "auth";
  try {
    const r = await fetch(cfg.site.replace(/\/$/, "") + "/agent/check", { headers: siteHeaders(), redirect: "manual" });
    if (r.status === 204) return "ok";
    if (r.status >= 500) return "net";
    return "auth";
  } catch {
    return "net";
  }
}

const procs = new Map();
let ws = null;
let backoff = 1000;
let outbox = [];

function send(obj) {
  const s = JSON.stringify(obj);
  const chunks = [];
  if (s.length > 400000) {
    const key = Math.random().toString(36).slice(2) + Date.now().toString(36);
    const n = Math.ceil(s.length / 400000);
    for (let i = 0; i < n; i++) chunks.push(JSON.stringify({ type: "part", key, i, n, d: s.slice(i * 400000, (i + 1) * 400000) }));
  } else chunks.push(s);
  for (const c of chunks) {
    if (ws && ws.readyState === 1) {
      try {
        ws.send(c);
        continue;
      } catch {}
    }
    if (obj.type !== "delta" && obj.type !== "beat" && obj.type !== "status" && obj.type !== "sessions" && obj.type !== "transcript") outbox.push(c);
  }
}

function safeName(n) {
  const b = basename(String(n || "file")).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^\.+/, "_").slice(0, 120);
  return b || "file";
}

function saveFiles(files, chatId, base = WORKSPACE) {
  if (!files || !files.length) return [];
  const dir = join(WORKSPACE, "uploads", String(chatId).slice(0, 8));
  mkdirSync(dir, { recursive: true });
  return files.map(f => {
    const name = safeName(f.name);
    let p = join(dir, name);
    let i = 1;
    while (existsSync(p)) {
      const ext = extname(name);
      p = join(dir, `${basename(name, ext)} (${i++})${ext}`);
    }
    const buf = Buffer.from(String(f.data || ""), "base64");
    writeFileSync(p, buf);
    const textLike = TEXT_EXT.test(name) || /^text\//.test(f.type || "") || /json|xml/.test(f.type || "");
    return { name, rel: inside(p, base) ? relative(base, p).split("\\").join("/") : p, size: buf.length, text: textLike && buf.length <= 200000 ? buf.toString("utf8") : null };
  });
}

function composePrompt(prompt, saved, chat) {
  if (!saved.length) return prompt;
  let out = prompt || "Take a look at the attached files.";
  if (chat) {
    // no file tools in plain chat: say which attachments can't be read instead of pointing at paths it can't open
    const unread = saved.filter(f => f.text === null);
    if (unread.length) out += "\n\n(Attached, but this chat can't open them. Switch to Claude Code for that: " + unread.map(f => f.name).join(", ") + ")";
    for (const f of saved) if (f.text !== null) out += `\n\n<file name="${f.name.replace(/"/g, "'")}">\n${f.text}\n</file>`;
    return out;
  }
  out += "\n\nAttached files:\n" + saved.map(f => `- ${f.rel}`).join("\n");
  for (const f of saved) if (f.text !== null) out += `\n\n<file name="${f.rel.replace(/"/g, "'")}">\n${f.text}\n</file>`;
  return out;
}

function runClaude(m, prompt, sessionArgs, pre, where = WORKSPACE) {
  return new Promise(resolve => {
    const st = pre || { text: "", thinking: "", thinkingMs: 0, tools: [], writes: [], started: false, model: "", seen: new Set(), streamed: new Set(), buffer: "", tbuffer: "", timer: null };
    const blocks = new Map();
    const flush = () => {
      if (st.timer) clearTimeout(st.timer);
      st.timer = null;
      if (st.tbuffer) {
        send({ type: "thinking", runId: m.runId, chatId: m.chatId, text: st.tbuffer });
        st.tbuffer = "";
      }
      if (st.buffer) {
        send({ type: "delta", runId: m.runId, chatId: m.chatId, text: st.buffer });
        st.buffer = "";
      }
    };
    // Text and thinking are each sent in small batches, and always in the order they came: what was buffered of the other
    // goes first, so the page can show thoughts and text interleaved the way they happened.
    const addText = t => {
      if (!t) return;
      if (st.tbuffer) flush();
      st.text += t;
      st.buffer += t;
      if (!st.timer) st.timer = setTimeout(flush, 70);
    };
    const addThinking = t => {
      if (!t) return;
      if (st.buffer) flush();
      st.thinking += t;
      st.tbuffer += t;
      if (!st.timer) st.timer = setTimeout(flush, 70);
    };
    const newThought = () => {
      if (st.thinking && !st.thinking.endsWith("\n\n")) addThinking(st.thinking.endsWith("\n") ? "\n" : "\n\n");
    };
    const newBlock = () => {
      if (!st.text) return;
      if (st.text.endsWith("\n\n")) return;
      addText(st.text.endsWith("\n") ? "\n" : "\n\n");
    };
    const chat = m.mode === "claude";
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages", "--model", m.model, "--settings", SETTINGS_PATH];
    if (chat) args.push("--tools", "", "--strict-mcp-config", "--disable-slash-commands", "--system-prompt", CHAT_PROMPT);
    else {
      args.push("--permission-mode", PERMS.has(m.perm) && m.perm !== "auto" ? m.perm : cfg.permissionMode || "auto");
      if (versionAtLeast(CLAUDE_VERSION, "2.1.259")) args.push("--permission-prompts", "none");
    }
    if (FRESH_PROMPT) args.push("--system-prompt-snapshot", "off");
    if (m.effort) args.push("--effort", m.effort);
    args.push(...sessionArgs);
    let child;
    try {
      child = spawnClaude(args, where);
    } catch (e) {
      return resolve({ st, final: null, stderr: String(e.message || e), code: -1 });
    }
    const rec = procs.get(m.runId) || { stopped: false };
    rec.child = child;
    procs.set(m.runId, rec);
    let final = null;
    let stderr = "";
    let currentMsg = null;
    child.stderr.on("data", d => {
      stderr += d;
      if (stderr.length > 20000) stderr = stderr.slice(-20000);
    });
    child.on("error", e => (stderr += String(e.message || e)));
    const rl = createInterface({ input: child.stdout });
    rl.on("line", line => {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (o.type === "system" && o.subtype === "init") {
        st.started = true;
        st.model = o.model || st.model;
      } else if (o.type === "system" && o.subtype === "api_retry") {
        send({ type: "status", runId: m.runId, chatId: m.chatId, text: `Retrying (attempt ${o.attempt})` });
      } else if (o.type === "stream_event" && !o.parent_tool_use_id) {
        const ev = o.event || {};
        if (ev.type === "message_start") {
          currentMsg = ev.message && ev.message.id;
          if (currentMsg) st.streamed.add(currentMsg);
        } else if (ev.type === "content_block_start" && ev.content_block) {
          blocks.set(ev.index, { type: ev.content_block.type, at: Date.now() });
          if (ev.content_block.type === "text") newBlock();
          else if (ev.content_block.type === "thinking" || ev.content_block.type === "redacted_thinking") {
            newThought();
            if (ev.content_block.thinking) addThinking(ev.content_block.thinking);
            send({ type: "status", runId: m.runId, chatId: m.chatId, text: "Thinking" });
          }
        } else if (ev.type === "content_block_delta" && ev.delta) {
          if (ev.delta.type === "text_delta") addText(ev.delta.text);
          else if (ev.delta.type === "thinking_delta") addThinking(ev.delta.thinking);
        } else if (ev.type === "content_block_stop") {
          const b = blocks.get(ev.index);
          if (b && (b.type === "thinking" || b.type === "redacted_thinking")) {
            st.thinkingMs += Date.now() - b.at;
            flush();
            send({ type: "thinking_done", runId: m.runId, chatId: m.chatId, ms: st.thinkingMs });
          }
          blocks.delete(ev.index);
        }
      } else if (o.type === "assistant" && !o.parent_tool_use_id && o.message) {
        if (o.message.usage) st.usage = o.message.usage;
        const streamed = o.message.id && st.streamed.has(o.message.id);
        for (const b of o.message.content || []) {
          if (b.type === "thinking" && !streamed && b.thinking) {
            newThought();
            addThinking(b.thinking);
          } else if (b.type === "text" && !streamed && b.text) {
            newBlock();
            addText(b.text);
          } else if (b.type === "tool_use" && !st.seen.has(b.id)) {
            st.seen.add(b.id);
            flush();
            const t = { id: b.id, name: b.name, label: toolLabel(b.name, b.input), done: false };
            st.tools.push(t);
            const target = b.input && (b.input.file_path || b.input.notebook_path);
            if (target && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(b.name)) st.writes.push({ id: b.id, tool: b.name, path: String(target), ok: false });
            send({ type: "tool", runId: m.runId, chatId: m.chatId, id: t.id, name: t.name, label: t.label });
          }
        }
      } else if (o.type === "user" && !o.parent_tool_use_id && o.message && Array.isArray(o.message.content)) {
        for (const b of o.message.content) {
          if (b.type !== "tool_result") continue;
          const t = st.tools.find(x => x.id === b.tool_use_id);
          if (t) {
            t.done = true;
            t.error = !!b.is_error;
          }
          const w = st.writes.find(x => x.id === b.tool_use_id);
          if (w && !b.is_error) w.ok = true;
          send({ type: "tool_done", runId: m.runId, chatId: m.chatId, id: b.tool_use_id, error: !!b.is_error });
        }
      } else if (o.type === "rate_limit_event") {
        noteLimits(o.rate_limit_info);
      } else if (o.type === "result") {
        final = o;
      }
    });
    child.on("close", code => {
      flush();
      resolve({ st, final, stderr, code });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(prompt);
  });
}

// Tokens in the context after the last request, against the model's window. The last request holds the whole chat so far.
function contextOf(final, st, model) {
  const u = (st && st.usage) || (final && final.usage && Array.isArray(final.usage.iterations) && final.usage.iterations[final.usage.iterations.length - 1]) || null;
  if (!u) return null;
  const used = ["input_tokens", "cache_creation_input_tokens", "cache_read_input_tokens", "output_tokens"].reduce((n, k) => n + (Number(u[k]) || 0), 0);
  const per = final && final.modelUsage && typeof final.modelUsage === "object" ? final.modelUsage : {};
  const mu = per[(st && st.model) || model] || per[model] || Object.values(per)[0] || null;
  const window = mu && Number(mu.contextWindow) > 0 ? Number(mu.contextWindow) : 0;
  return used > 0 && window > 0 ? { used, window } : null;
}

// The plan percentages. Claude Code reads them from Anthropic's response headers and reports them on every reply in a
// rate_limit_event, as fractions of each window (5 hours, 7 days). API-key sessions don't get them, so they're simply absent.
const LIMIT_KEYS = ["five_hour", "seven_day", "seven_day_overage_included"];
let LIMITS = null;
let limitsTimer = null;

function limitsFrom(info) {
  if (!info || typeof info !== "object") return null;
  const windows = {};
  const w = info.unifiedWindows && typeof info.unifiedWindows === "object" ? info.unifiedWindows : {};
  for (const key of LIMIT_KEYS) {
    const x = w[key];
    if (x && Number.isFinite(x.utilization) && Number.isFinite(x.resetsAt)) windows[key] = { pct: x.utilization * 100, resetsAt: x.resetsAt };
  }
  // Older builds only name the window that is limiting right now.
  if (!Object.keys(windows).length && Number.isFinite(info.utilization) && Number.isFinite(info.resetsAt) && (info.rateLimitType === "five_hour" || info.rateLimitType === "seven_day")) windows[info.rateLimitType] = { pct: info.utilization * 100, resetsAt: info.resetsAt };
  if (!Object.keys(windows).length) return null;
  // Which window is limiting, and the usage credits ("extra usage"): whether they're on, in use, or used up. A plan limit
  // that has been reached while credits are on isn't a stop: replies carry on, paid from the credits.
  const out = { windows, status: info.status };
  for (const k of ["rateLimitType", "overageStatus", "overageDisabledReason"]) if (typeof info[k] === "string") out[k] = info[k];
  for (const k of ["resetsAt", "overageResetsAt"]) if (Number.isFinite(info[k])) out[k] = info[k];
  for (const k of ["isUsingOverage", "overageInUse", "overageEnabled"]) if (typeof info[k] === "boolean") out[k] = info[k];
  return out;
}

function noteLimits(info) {
  const got = limitsFrom(info);
  if (!got) return;
  // every event describes the whole current state, apart from windows it didn't see this time
  LIMITS = { ...got, windows: { ...((LIMITS && LIMITS.windows) || {}), ...got.windows } };
  clearTimeout(limitsTimer);
  limitsTimer = setTimeout(() => LIMITS && send({ type: "limits", limits: LIMITS }), 400);
}

let probing = false;

// A one-token message to the cheapest model, only to read the current percentages. Nothing is saved and no tools are offered.
async function probeLimits() {
  if (probing || procs.size || !CLAUDE) return;
  probing = true;
  try {
    const args = ["-p", "--output-format", "stream-json", "--verbose", "--model", "claude-haiku-5-5", "--no-session-persistence", "--tools", "", "--system-prompt", "Reply with: ok"];
    const r = await capture(args, "ok", 90000);
    for (const line of String(r.stdout).split("\n")) {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        continue;
      }
      if (o && o.type === "rate_limit_event") noteLimits(o.rate_limit_info);
    }
  } finally {
    probing = false;
  }
}

// ---- Usage credit balance, only when it's been turned on with `<command> edit` (config.json "credits": true). Claude Code's
// own sign-in on this computer is used to ask Anthropic, the way Claude Code's /usage does: the extra usage spent this month and
// its limit, the prepaid balance, and promotional credits. The sign-in is read here and sent only to Anthropic; the site gets
// the numbers. If the sign-in has expired, the tiny message that reads the plan percentages has Claude Code renew it.
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(os.homedir(), ".claude");
const ANTHROPIC_API = (process.env.CLAUDECONNECT_ANTHROPIC_API || "https://api.anthropic.com").replace(/\/+$/, "");

function claudeSignIn() {
  let raw = "";
  if (process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR) {
    const r = spawnSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0) raw = String(r.stdout || "").trim();
  }
  if (!raw) {
    try {
      raw = readFileSync(join(CLAUDE_DIR, ".credentials.json"), "utf8");
    } catch {}
  }
  let o = null;
  try {
    o = JSON.parse(raw).claudeAiOauth;
  } catch {}
  if (!o || typeof o.accessToken !== "string" || !o.accessToken) return null;
  if (Number(o.expiresAt) && Number(o.expiresAt) < Date.now() + 30000) return { expired: true };
  let org = "";
  try {
    const g = JSON.parse(readFileSync(process.env.CLAUDE_CONFIG_DIR ? join(CLAUDE_DIR, ".claude.json") : join(os.homedir(), ".claude.json"), "utf8"));
    org = (g.oauthAccount && g.oauthAccount.organizationUuid) || "";
  } catch {}
  return { token: o.accessToken, org: UUID.test(String(org)) ? org : "" };
}

async function readCredits() {
  if (!cfg.credits) return;
  const s = claudeSignIn();
  if (!s || s.expired) return send({ type: "credits", credits: { error: s ? "expired" : "signin" } });
  const headers = { authorization: "Bearer " + s.token, "anthropic-beta": "oauth-2025-04-20", accept: "application/json", "user-agent": `ClaudeConnect/${VERSION}` };
  const get = async path => {
    try {
      const r = await fetch(ANTHROPIC_API + path, { headers, signal: AbortSignal.timeout(8000) });
      return r.ok ? await r.json() : null;
    } catch {
      return null;
    }
  };
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const out = {};
  const u = await get("/api/oauth/usage");
  const e = u && u.extra_usage && typeof u.extra_usage === "object" ? u.extra_usage : null;
  if (e) out.extra = { enabled: e.is_enabled === true, limit: num(e.monthly_limit), used: num(e.used_credits) };
  const p = s.org ? await get(`/api/oauth/organizations/${s.org}/prepaid/credits`) : null;
  if (p && num(p.amount) !== null) {
    const promos = (Array.isArray(p.promo_tranches) ? p.promo_tranches : []).filter(t => t && num(t.remaining_amount_minor_units) > 0);
    out.balance = { amount: p.amount, currency: typeof p.currency === "string" ? p.currency : "", promos: promos.slice(0, 10).map(t => ({ amount: t.remaining_amount_minor_units, currency: typeof t.currency === "string" ? t.currency : "", expires: Date.parse(t.expires_at) || null, name: typeof t.name === "string" ? t.name : "" })) };
  }
  if (!out.extra && !out.balance) out.error = "unavailable";
  send({ type: "credits", credits: out });
}

async function handleRun(m) {
  const t0 = Date.now();
  procs.set(m.runId, { stopped: false, child: null });
  const beat = setInterval(() => send({ type: "beat", runId: m.runId, chatId: m.chatId }), 15000);
  const label = { "claude-fable-5-1": "Fable 5.1", "claude-opus-5-5": "Opus 5.5", "claude-sonnet-5-5": "Sonnet 5.5", "claude-haiku-5-5": "Haiku 5.5" }[m.model] || m.model;
  log(`Message received, running ${label}${m.effort ? " at " + m.effort + " effort" : ""}`);
  let result;
  // A chat that began in a project carries on in that project's folder. (This Claude Code finds a session from any folder, but
  // then carries on in the folder it was started from, so the wrong one would quietly mean working on the wrong project; older
  // versions only find it from its own folder.) The site never names a folder: it names a session, and the folder is read
  // from that session's own file here.
  let where = WORKSPACE;
  let refused = "";
  if (m.resume) {
    const file = findSession(m.sessionId);
    const dir = file ? sessionCwd(file) : "";
    if (dir) {
      if (!isDirectory(dir)) refused = `This chat was started in ${dir}, which isn't on this computer anymore, so it can't be continued from here.`;
      else if (HISTORY !== "all" && !within(dir, WORKSPACE)) refused = `This chat was started outside ${WORKSPACE}, and ${COMMAND} is set to only open chats from there.`;
      else where = dir;
    }
  }
  try {
    if (!CLAUDE) await checkClaude();
    if (refused) {
      result = { st: { text: "", thinking: "", thinkingMs: 0, tools: [], writes: [], started: false, model: "" }, final: null, stderr: "", code: -1, error: refused };
    } else if (!CLAUDE) {
      result = { st: { text: "", thinking: "", thinkingMs: 0, tools: [], writes: [], started: false, model: "" }, final: null, stderr: "", code: -1, error: `${NAME} is missing a piece it needs to answer. Run the setup again to fix it, then restart ${COMMAND}.` };
    } else {
      const saved = saveFiles(m.files, m.chatId, where);
      const prompt = composePrompt(m.prompt, saved, m.mode === "claude");
      const primary = m.resume ? ["--resume", m.sessionId] : ["--session-id", m.sessionId];
      const alternate = m.resume ? ["--session-id", m.sessionId] : ["--resume", m.sessionId];
      result = await runClaude(m, prompt, primary, undefined, where);
      const msg = String((result.final && result.final.result) || "") + " " + result.stderr;
      const retry = !procs.get(m.runId).stopped && !result.st.text && ((m.resume && /no conversation found|not found/i.test(msg)) || (!m.resume && /already in use|already exists/i.test(msg)));
      if (retry) {
        result.st.started = false;
        result = await runClaude(m, prompt, alternate, result.st, where);
      }
    }
  } catch (e) {
    result = { st: { text: "", thinking: "", thinkingMs: 0, tools: [], writes: [], started: false, model: "" }, final: null, stderr: String(e.message || e), code: -1 };
  }
  clearInterval(beat);
  const rec = procs.get(m.runId) || {};
  procs.delete(m.runId);
  const f = result.final;
  let error = result.error || null;
  if (rec.stopped) error = "Stopped.";
  else if (!error && (!f || f.is_error || (f.subtype && f.subtype !== "success"))) {
    const tail = String(result.stderr || "").trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ");
    error = (f && (f.result || (Array.isArray(f.errors) && f.errors.join("; ")) || f.subtype)) || tail || `It stopped unexpectedly (exit code ${result.code}).`;
  }
  const text = result.st.text || (!error && f && typeof f.result === "string" ? f.result : "");
  const artifacts = collectArtifacts(result.st.writes || [], where);
  send({ type: "done", runId: m.runId, chatId: m.chatId, text, thinking: result.st.thinking || "", thinkingMs: result.st.thinkingMs || 0, artifacts, error, started: result.st.started, tools: result.st.tools, sync: syncState(m.sessionId), context: contextOf(f, result.st, m.model), cost: f && typeof f.total_cost_usd === "number" ? f.total_cost_usd : null, denials: f && Array.isArray(f.permission_denials) ? f.permission_denials.length : 0, model: result.st.model || m.model, ms: Date.now() - t0 });
  setTimeout(() => reportSessions(false), 300); // a new or longer chat shows up in the site's list straight away
  log(error ? `Finished with a problem: ${String(error).slice(0, 160)}` : `Answered in ${((Date.now() - t0) / 1000).toFixed(1)}s${artifacts.length ? `, with ${artifacts.length} file${artifacts.length === 1 ? "" : "s"}` : ""}`);
}

function isDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

// Where Claude Code's own record of a session stands: how many questions it holds and when its file last changed. The site
// keeps this next to the chat so it knows what it already has.
function syncState(sessionId) {
  try {
    const file = findSession(sessionId);
    if (!file) return null;
    const r = readSession(file, { from: Infinity });
    return { turns: r.turns, mtime: r.mtime };
  } catch {
    return null;
  }
}

function inside(child, parent) {
  const r = relative(parent, child);
  return !!r && !r.startsWith("..") && !isAbsolute(r);
}

function collectArtifacts(writes, base = WORKSPACE) {
  const uploads = join(WORKSPACE, "uploads");
  const seen = new Map();
  for (const w of writes) {
    if (!w.ok) continue;
    const p = isAbsolute(w.path) ? w.path : resolvePath(base, w.path);
    if (inside(p, uploads)) continue;
    if (w.tool !== "Write" && !inside(p, WORKSPACE) && !inside(p, base)) continue;
    seen.delete(p);
    seen.set(p, w);
  }
  const out = [];
  let total = 0;
  for (const p of [...seen.keys()].slice(-12)) {
    try {
      const s = statSync(p);
      if (!s.isFile()) continue;
      if (s.size > ARTIFACT_MAX || total + s.size > ARTIFACT_TOTAL) {
        out.push({ name: basename(p), size: s.size, tooBig: true });
        continue;
      }
      const data = readFileSync(p);
      total += data.length;
      out.push({ name: basename(p), data: data.toString("base64") });
    } catch {}
  }
  return out;
}

function stopRun(m) {
  const rec = procs.get(m.runId);
  if (!rec) {
    send({ type: "done", runId: m.runId, chatId: m.chatId, text: "", error: "Stopped.", started: false, tools: [] });
    return;
  }
  rec.stopped = true;
  killTree(rec.child);
}

let updating = false;

// Updates and changes to the site run in their own detached process: they replace this program's files, restart it, or delete
// it, so they can't live inside it. The process tells the site how it's going, so the page can follow along.
async function runJob(m, script, args, what) {
  const refuse = error => send({ type: "update_ack", id: m.id, ok: false, error });
  // A failed job tells the site before it exits, so a quick retry can arrive while it is still winding down.
  for (let i = 0; i < 30 && updating; i++) await new Promise(r => setTimeout(r, 100));
  if (updating) return refuse("Something is already running on your computer.");
  if (procs.size) return refuse("A reply is still being written on your computer. Wait for it to finish, then try again.");
  if (!existsSync(script)) return refuse(`The program that does this isn't on your computer. Run ClaudeConnect.mjs there once with node, then it can be done from here.`);
  let out = "ignore";
  try {
    out = openSync(join(HERE, "update.log"), "a");
  } catch {}
  try {
    const child = spawn(process.execPath, [script, ...args], { detached: true, stdio: ["ignore", out, out], windowsHide: true, cwd: HERE });
    child.on("error", e => {
      updating = false;
      log("Couldn't start:", e.message || e);
      refuse(`That couldn't start (${String((e && e.message) || e).slice(0, 120)}).`);
    });
    // A clean exit means it either finished or reported its own failure; anything else died before it could say so.
    child.on("exit", code => {
      updating = false;
      if (code) refuse(`It stopped unexpectedly (exit code ${code}). ${COMMAND} logs on your computer shows why.`);
    });
    child.unref();
  } catch (e) {
    return refuse(`That couldn't start (${String((e && e.message) || e).slice(0, 120)}).`);
  } finally {
    if (typeof out === "number") closeSync(out);
  }
  updating = true;
  setTimeout(() => (updating = false), 90 * 60000).unref();
  log(what);
  send({ type: "update_ack", id: m.id, ok: true });
}

async function startUpdate(m) {
  await runJob(m, join(HERE, "ClaudeConnect.mjs"), ["--remote-update", "--update-id", String(m.id), "--expect", String(m.to || "")], `Updating to ${m.to || "the newest version"}. This will restart ${NAME}.`);
}

const ADMIN_OPS = { settings: "Changing this site's settings", move: "Moving this site to a new address", delete: "Deleting this site" };

// The details go in a file only this user can read: they can include a logo, and a command line is visible to other programs.
async function startAdmin(m) {
  const what = ADMIN_OPS[m.op];
  if (!what) return send({ type: "update_ack", id: m.id, ok: false, error: "This version doesn't know how to do that." });
  const file = join(HERE, `job-${String(m.id).replace(/[^A-Za-z0-9-]/g, "")}.json`);
  try {
    writeFileSync(file, JSON.stringify(m.payload || {}), { mode: 0o600 });
  } catch (e) {
    return send({ type: "update_ack", id: m.id, ok: false, error: `Couldn't save the details on your computer (${String((e && e.message) || e).slice(0, 100)}).` });
  }
  await runJob(m, join(HERE, "installer.mjs"), ["--remote-op", m.op, "--update-id", String(m.id), "--job-file", file], `${what}.`);
}

// The chats Claude Code has saved on this computer, so the site can list them next to its own.
let lastSessions = "";
function reportSessions(force) {
  if (HISTORY === "off" || !ws || ws.readyState !== 1) return;
  let list;
  try {
    list = listSessions({ workspace: WORKSPACE, scope: HISTORY });
  } catch {
    return;
  }
  const sig = JSON.stringify(list.map(x => [x.id, x.updated, x.title]));
  if (!force && sig === lastSessions) return;
  lastSessions = sig;
  send({ type: "sessions", sessions: list });
}
setInterval(() => reportSessions(false), 15000).unref();

function handleTranscript(m) {
  const reply = o => send({ type: "transcript", req: m.req, sessionId: m.sessionId, ...o });
  if (HISTORY === "off" || !UUID.test(String(m.sessionId))) return reply({ ok: false, error: "unavailable" });
  try {
    const file = findSession(m.sessionId);
    if (!file) return reply({ ok: false, error: "missing" });
    if (HISTORY === "workspace" && !within(sessionCwd(file), WORKSPACE)) return reply({ ok: false, error: "unavailable" });
    const r = readSession(file, { from: Number(m.from) || 0, maxTurns: 300 });
    reply({ ok: true, turns: r.turns, trimmed: r.trimmed, messages: r.messages, mtime: r.mtime });
  } catch {
    reply({ ok: false, error: "unreadable" });
  }
}

const parts = new Map();

function onMessage(raw) {
  const s = typeof raw === "string" ? raw : Buffer.from(raw).toString("utf8");
  if (s === "pong") return;
  let m;
  try {
    m = JSON.parse(s);
  } catch {
    return;
  }
  if (m.type === "part") {
    const p = parts.get(m.key) || { n: m.n, got: 0, d: [] };
    if (p.d[m.i] === undefined) p.got++;
    p.d[m.i] = m.d;
    parts.set(m.key, p);
    if (p.got < p.n) return;
    parts.delete(m.key);
    try {
      m = JSON.parse(p.d.join(""));
    } catch {
      return;
    }
  }
  if (m.type === "run") {
    send({ type: "ack", runId: m.runId, chatId: m.chatId });
    handleRun(m).catch(e => log("Run failed:", e.message || e));
  } else if (m.type === "stop") stopRun(m);
  else if (m.type === "token") saveSignIn(m.token, m.exp);
  else if (m.type === "update") startUpdate(m).catch(e => log("Update failed to start:", e.message || e));
  else if (m.type === "admin") startAdmin(m).catch(e => log("Couldn't start that:", e.message || e));
  else if (m.type === "limits_refresh") probeLimits().catch(() => {}).finally(() => readCredits().catch(() => {}));
  else if (m.type === "transcript") handleTranscript(m);
}

let pingTimer = null;
let lastPong = 0;
let quiet = false;
let waiting = false;
let announced = false;

async function connect() {
  await checkClaude();
  const now = Date.now() / 1000;
  if (!cfg.token || (cfg.tokenExp || 0) < now + 300) {
    const k = await storedSignIn();
    if (k && k.exp > (cfg.tokenExp || 0)) saveSignIn(k.token, k.exp);
  }
  let pf = await preflight();
  if (pf === "auth") {
    const k = await storedSignIn();
    if (k && k.token !== cfg.token) {
      saveSignIn(k.token, k.exp);
      pf = await preflight();
    }
  }
  if (pf === "auth") {
    if (!waiting) log("Waiting for you to sign in. Open the site in your browser (or the claim link from setup) and this connects on its own.");
    waiting = true;
    setTimeout(() => connect().catch(() => retry()), 15000);
    return;
  }
  if (pf === "net") {
    if (!quiet) log(`Couldn't reach ${NAME}. It'll keep trying in the background.`);
    quiet = true;
    return retry();
  }
  waiting = false;
  const url = cfg.site.replace(/^http/, "ws").replace(/\/$/, "") + "/agent";
  let sock;
  try {
    sock = new WS(url, { headers: siteHeaders() });
  } catch (e) {
    log("Couldn't connect:", e.message || e);
    return retry();
  }
  ws = sock;
  let opened = false;
  let finished = false;
  const lost = ev => {
    if (finished) return;
    finished = true;
    clearInterval(pingTimer);
    if (ws === sock) ws = null;
    try {
      sock.close();
    } catch {}
    if (ev && ev.code === 4000) {
      log(`Another copy of ${COMMAND} connected, so this one stepped aside. Retrying in a minute.`);
      backoff = 60000;
    } else if (ev && ev.code === 4002) {
      if (!quiet) log(`Another computer is connected to ${NAME} right now. This one will take over when it goes offline.`);
      quiet = true;
      backoff = 60000;
    } else if (!opened) {
      if (!quiet) log(`Couldn't reach ${NAME}. It'll keep trying in the background.`);
      quiet = true;
    }
    else log("Connection dropped. Reconnecting.");
    retry();
  };
  sock.onopen = () => {
    opened = true;
    quiet = false;
    backoff = 1000;
    lastPong = Date.now();
    sock.send(JSON.stringify({ type: "hello", agent: VERSION, caps: ["update", "admin", "limits", "modes", ...(HISTORY === "off" ? [] : ["history"]), ...(cfg.credits ? ["credits"] : [])], warning: WARNING_CODE, tokenExp: cfg.tokenExp || 0, active: [...procs.keys()] }));
    const pending = outbox;
    outbox = [];
    for (const c of pending) sock.send(c);
    if (LIMITS) send({ type: "limits", limits: LIMITS });
    lastSessions = "";
    setTimeout(() => reportSessions(true), 400);
    setTimeout(() => {
      if (finished) return;
      if (!announced) {
        log(`Connected. Open ${cfg.site} on any device to chat.`);
        announced = true;
      } else log("Reconnected.");
      if (WARNING) log("Heads up:", WARNING);
    }, 1500);
    clearInterval(pingTimer);
    pingTimer = setInterval(() => {
      if (Date.now() - lastPong > 80000) return lost({ code: 1006 });
      try {
        sock.send("ping");
      } catch {}
    }, 25000);
  };
  sock.onmessage = ev => {
    lastPong = Date.now();
    onMessage(ev.data);
  };
  sock.onerror = () => lost({ code: 1006 });
  sock.onclose = ev => lost(ev);
}

function retry() {
  const wait = backoff;
  backoff = Math.min(backoff * 2, 60000);
  setTimeout(() => connect().catch(e => {
    log("Connection problem:", e.message || e);
    retry();
  }), wait);
}

log(`${NAME} ${VERSION} starting on ${os.hostname()}. Working folder: ${WORKSPACE}`);
connect().catch(e => {
  log("Connection problem:", e.message || e);
  retry();
});
