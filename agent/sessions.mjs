// What Claude Code has saved on this computer, read so the site can list it and carry on from it.
//
// Claude Code writes every conversation to <config folder>/projects/<folder>/<session id>.jsonl, one JSON object per line,
// and `claude --resume <id>` picks one up again (it works on whichever folder it is run from, so it is run from the one the
// conversation began in, which is what its first entry records). A chat started on the site is one of
// these too (the chat's session id is the file's name), so reading these files is all the syncing there is to do:
// chats from the terminal, the desktop app and the site are the same chats.
import { readdirSync, statSync, readFileSync, openSync, readSync, closeSync } from "node:fs";
import { join, basename, relative, isAbsolute, resolve } from "node:path";
import os from "node:os";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The most conversations listed. Matches CHAT_LIST_MAX in site/worker.js: a list longer than the site keeps would only be cut there.
export const MAX_SESSIONS = 3000;
const MAX_FILE = 80 * 1024 * 1024; // bigger than this is skipped rather than read into memory
const SCAN = 256 * 1024; // how much of each end of a file is read to find its title and folder
const BIG_LINE = 100000; // tool output is the bulk of a file; a line this long is never a prompt or a title
const TEXT_MAX = 120000;
const THINK_MAX = 20000;
const TOTAL_MAX = 3500000; // the most text sent for one conversation; the oldest turns are left behind first

// "Ran: …", "Read notes.txt": what the site shows for each tool a reply used.
export function toolLabel(name, input) {
  input = input || {};
  const clean = v => String(v || "").replace(/\s+/g, " ").trim();
  const cut = (v, n = 70) => {
    v = clean(v);
    return v.length > n ? v.slice(0, n - 1) + "…" : v;
  };
  const file = p => (p ? basename(String(p)) : "a file");
  switch (name) {
    case "Bash":
    case "PowerShell":
      return input.description ? "Ran: " + cut(input.description) : "Ran " + cut(input.command, 60);
    case "Read":
      return "Read " + file(input.file_path);
    case "Write":
      return "Wrote " + file(input.file_path);
    case "Edit":
    case "MultiEdit":
      return "Edited " + file(input.file_path);
    case "NotebookEdit":
      return "Edited " + file(input.notebook_path);
    case "Glob":
      return "Looked for " + cut(input.pattern, 50);
    case "Grep":
      return "Searched files for " + cut(input.pattern, 50);
    case "WebSearch":
      return "Searched the web for “" + cut(input.query, 60) + "”";
    case "WebFetch":
      try {
        return "Read " + new URL(input.url).hostname;
      } catch {
        return "Read a web page";
      }
    case "Agent":
    case "Task":
      return "Handed off: " + cut(input.description, 60);
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return "Updated its plan";
    case "Skill":
      return "Used the " + cut(input.skill || input.name || "", 40) + " skill";
    default:
      return name && name.startsWith("mcp__") ? "Used " + name.split("__").slice(1).join(" › ") : "Used " + name;
  }
}

export function projectsDir(env = process.env, home = os.homedir()) {
  return join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "projects");
}

// Is `child` the same folder as `parent`, or somewhere inside it?
export function within(child, parent) {
  if (!child || !parent) return false;
  const fold = p => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
  const r = relative(fold(parent), fold(child));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
}

function readSlice(file, start, length) {
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(length);
    const n = readSync(fd, buf, 0, length, start);
    return buf.toString("utf8", 0, n);
  } finally {
    closeSync(fd);
  }
}

const WRAPPERS = /<(system-reminder|ide_[a-z_]+|local-command-caveat)>[\s\S]*?<\/\1>/g;
// Things Claude Code writes as "user" entries that no person typed: command output, hooks, task notices.
const NOT_TYPED = /^\s*<(?:local-command-|command-name>|command-message>|command-args>|bash-input>|bash-stdout>|bash-stderr>|task-notification>|user-prompt-submit-hook>)/;

// The prompt a person typed, from a "user" entry, or null when the entry is something else (a tool's result, a hook, a
// notice). Entries from sub-agents are never prompts.
export function realPrompt(e) {
  if (!e || e.type !== "user" || e.isSidechain || e.isMeta || e.isCompactSummary) return null;
  const c = e.message && e.message.content;
  let text = "";
  let images = 0;
  if (typeof c === "string") text = c;
  else if (Array.isArray(c)) {
    if (c.some(b => b && b.type === "tool_result")) return null;
    for (const b of c) {
      if (b && b.type === "text" && typeof b.text === "string") text += (text ? "\n\n" : "") + b.text;
      else if (b && b.type === "image") images++;
    }
  } else return null;
  text = text.replace(WRAPPERS, "").trim();
  if ((!text && !images) || NOT_TYPED.test(text) || /^\[Request interrupted by user/.test(text)) return null;
  return { text, images };
}

const oneLine = (v, n) => {
  const t = String(v || "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1).trimEnd() + "…" : t;
};

// The title and folder of a session, from the two ends of its file. Titles are written by Claude Code (a name you gave it
// with /rename, or one it made up); failing that the first thing you asked is used.
export function summarize(file, size) {
  const chunks = size <= SCAN * 2 ? [readSlice(file, 0, size)] : [readSlice(file, 0, SCAN), readSlice(file, size - SCAN, SCAN)];
  let cwd = "";
  let first = "";
  let custom = "";
  let ai = "";
  let summary = "";
  let real = size > SCAN * 2;
  chunks.forEach((chunk, i) => {
    const lines = chunk.split("\n");
    if (i === 1) lines.shift(); // the end slice starts in the middle of a line
    for (const line of lines) {
      if (line.length < 8 || line.length > BIG_LINE) continue;
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (!e || typeof e !== "object") continue;
      if (!cwd && typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
      if (e.type === "custom-title" && (e.customTitle || e.title)) custom = String(e.customTitle || e.title);
      else if (e.type === "ai-title" && (e.aiTitle || e.title)) ai = String(e.aiTitle || e.title);
      else if (e.type === "summary" && e.summary) summary = String(e.summary);
      else {
        const p = realPrompt(e);
        if (p) {
          real = true;
          if (!first) first = p.text;
        }
      }
    }
  });
  return { cwd, real, title: oneLine(custom || ai || summary || first, 80) };
}

const summaries = new Map(); // file -> { key, info }

// Every conversation Claude Code has saved here, newest first: { id, title, folder, updated, size }. `folder` is only the
// last part of the folder it was started in, and is empty for the working folder itself. scope: "all" | "workspace" | "off".
export function listSessions({ root = projectsDir(), workspace = "", scope = "all", limit = MAX_SESSIONS } = {}) {
  if (scope === "off") return [];
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = new Map();
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    let names;
    try {
      names = readdirSync(join(root, d.name));
    } catch {
      continue;
    }
    for (const n of names) {
      if (!n.endsWith(".jsonl") || !UUID.test(n.slice(0, -6))) continue;
      const id = n.slice(0, -6).toLowerCase();
      const file = join(root, d.name, n);
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      if (!st.isFile() || st.size < 20 || st.size > MAX_FILE) continue;
      const key = `${st.mtimeMs}:${st.size}`;
      let c = summaries.get(file);
      if (!c || c.key !== key) {
        try {
          c = { key, info: summarize(file, st.size) };
        } catch {
          continue;
        }
        summaries.set(file, c);
      }
      const { info } = c;
      if (!info.real) continue;
      if (scope === "workspace" && !within(info.cwd, workspace)) continue;
      const item = { id, title: info.title || "Chat", folder: !info.cwd || within(info.cwd, workspace) ? "" : oneLine(basename(info.cwd), 60), updated: Math.round(st.mtimeMs), size: st.size };
      const had = found.get(id);
      if (!had || had.updated < item.updated) found.set(id, item);
    }
  }
  return [...found.values()].sort((a, b) => b.updated - a.updated).slice(0, limit);
}

// The file for a session id, or null. The id is checked to be a plain UUID so it can never name some other path.
export function findSession(id, root = projectsDir()) {
  if (!UUID.test(String(id || ""))) return null;
  let best = null;
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    const file = join(root, d.name, String(id).toLowerCase() + ".jsonl");
    try {
      const st = statSync(file);
      if (st.isFile() && (!best || st.mtimeMs > best.mtime)) best = { file, mtime: st.mtimeMs };
    } catch {}
  }
  return best && best.file;
}

// The folder a session was started in. Resuming it only works from there.
export function sessionCwd(file) {
  try {
    const st = statSync(file);
    return summarize(file, Math.min(st.size, SCAN * 2)).cwd || "";
  } catch {
    return "";
  }
}

const parsed = new Map(); // file -> { key, value }, the last few parsed files

// A conversation as turns: what was asked, then everything Claude answered and did before the next question.
function parse(file) {
  const st = statSync(file);
  if (st.size > MAX_FILE) throw new Error("too big");
  const key = `${st.mtimeMs}:${st.size}`;
  const hit = parsed.get(file);
  if (hit && hit.key === key) return hit.value;
  const turns = [];
  const tools = new Map();
  let cur = null;
  let cwd = "";
  const stamp = e => {
    const t = Date.parse(e && e.timestamp);
    return Number.isFinite(t) ? t : 0;
  };
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (line.length < 8) continue;
    let e;
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (!e || typeof e !== "object" || e.isSidechain) continue;
    if (typeof e.cwd === "string" && e.cwd) cwd = e.cwd;
    if (e.type === "user") {
      const p = realPrompt(e);
      if (p) {
        cur = { prompt: p.text, images: p.images, at: stamp(e), perm: typeof e.permissionMode === "string" ? e.permissionMode : "", text: [], thinking: [], tools: [], model: "", usage: null, answeredAt: 0 };
        turns.push(cur);
      } else if (cur && Array.isArray(e.message && e.message.content)) {
        for (const b of e.message.content) {
          const t = b && b.type === "tool_result" ? tools.get(b.tool_use_id) : null;
          if (t) t.error = !!b.is_error;
        }
      }
    } else if (e.type === "assistant" && cur) {
      const m = e.message || {};
      if (typeof m.model === "string" && m.model && m.model !== "<synthetic>") cur.model = m.model;
      if (m.usage && typeof m.usage === "object") cur.usage = m.usage;
      cur.answeredAt = stamp(e) || cur.answeredAt;
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (!b) continue;
        if (b.type === "text" && typeof b.text === "string" && b.text.trim()) cur.text.push(b.text);
        else if (b.type === "thinking" && typeof b.thinking === "string" && b.thinking.trim()) cur.thinking.push(b.thinking);
        else if (b.type === "tool_use" && typeof b.id === "string" && cur.tools.length < 80) {
          const t = { id: b.id.slice(0, 80), name: String(b.name || "tool").slice(0, 60), label: toolLabel(b.name, b.input).slice(0, 140), done: true, error: false };
          cur.tools.push(t);
          tools.set(b.id, t);
        }
      }
    }
  }
  const value = { turns, cwd, mtime: Math.round(st.mtimeMs), size: st.size };
  parsed.set(file, { key, value });
  while (parsed.size > 6) parsed.delete(parsed.keys().next().value);
  return value;
}

const cap = (v, n) => (v.length > n ? v.slice(0, n - 1) + "…" : v);

// How many questions have been asked in a session, and the messages for the ones from number `from` on, in the shape the
// site stores. With from = 0 on a very long conversation only the last `maxTurns` are returned, and `trimmed` says how
// many earlier ones were left on this computer.
export function readSession(file, { from = 0, maxTurns = 300 } = {}) {
  const { turns, cwd, mtime, size } = parse(file);
  const id = basename(file, ".jsonl").toLowerCase();
  const total = turns.length;
  let start = Math.max(0, Math.min(Number.isFinite(from) ? Math.floor(from) : total, total));
  let trimmed = 0;
  if (total - start > maxTurns) {
    trimmed = total - start - maxTurns;
    start = total - maxTurns;
  }
  // however many turns, not more text than the site should be asked to store
  const weight = t => Math.min(t.prompt.length, TEXT_MAX) + Math.min(t.text.join("\n\n").length, TEXT_MAX) + Math.min(t.thinking.join("\n\n").length, THINK_MAX);
  let bytes = 0;
  for (let i = start; i < total; i++) bytes += weight(turns[i]);
  while (bytes > TOTAL_MAX && start < total - 1) {
    bytes -= weight(turns[start]);
    start++;
    trimmed++;
  }
  const messages = [];
  for (let i = start; i < total; i++) {
    const t = turns[i];
    const created = t.at || t.answeredAt || mtime;
    messages.push({ id: `i-${id}-${i}-u`, role: "user", content: cap(t.prompt, TEXT_MAX), created, meta: { files: t.images ? [{ name: t.images === 1 ? "image" : `${t.images} images`, size: 0, type: "image" }] : [], model: t.model || null, effort: null, mode: "code", perm: ["acceptEdits", "plan"].includes(t.perm) ? t.perm : "auto", imported: true } });
    const text = t.text.join("\n\n");
    if (text || t.tools.length || t.thinking.length) {
      messages.push({ id: `i-${id}-${i}-a`, role: "assistant", content: cap(text, TEXT_MAX), created: t.answeredAt || created, meta: { model: t.model || null, effort: null, mode: "code", perm: "auto", context: null, tools: t.tools, error: null, denials: 0, ms: null, thinking: cap(t.thinking.join("\n\n"), THINK_MAX), thinkingMs: null, artifacts: [], imported: true } });
    }
  }
  return { turns: total, trimmed, messages, cwd, mtime, size };
}
