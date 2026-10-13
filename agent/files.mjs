// The site's file browser, on this computer: what's in a folder, a file's bytes to show it, saving an edited text file,
// and moving something to the Trash. Every path the site sends is a place (the working folder, your home folder, Downloads,
// a folder Claude Code is allowed into, the whole computer; see places()) and a path inside it, checked against it, links
// that lead out of it included.
import { readdirSync, lstatSync, statSync, realpathSync, openSync, readSync, closeSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep, extname, basename } from "node:path";
import os from "node:os";
import { toTrash } from "./trash.mjs";

const EXT = {
  image: ["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico", "apng", "heic", "heif", "tif", "tiff"],
  audio: ["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba", "aif", "aiff", "mid", "midi"],
  video: ["mp4", "m4v", "webm", "mov", "ogv", "mkv", "avi", "3gp"],
  pdf: ["pdf"],
  text: ["txt", "md", "markdown", "json", "jsonc", "js", "mjs", "cjs", "ts", "tsx", "jsx", "py", "rb", "go", "rs", "java", "kt", "c", "h", "cc", "cpp", "hpp", "cs", "swift", "php", "sh", "bash", "zsh", "fish", "ps1", "bat", "cmd", "sql", "yml", "yaml", "toml", "ini", "cfg", "conf", "env", "xml", "html", "htm", "css", "scss", "less", "vue", "svelte", "csv", "tsv", "log", "tex", "r", "lua", "pl", "dart", "scala", "gradle", "lock", "gitignore", "dockerfile", "makefile", "rst", "adoc", "org", "srt", "vtt", "diff", "patch"]
};
const KIND = Object.fromEntries(Object.entries(EXT).flatMap(([k, list]) => list.map(e => [e, k])));
const NAMED = { dockerfile: "text", makefile: "text", license: "text", readme: "text", ".gitignore": "text", ".env": "text" };

// what a file is, for showing it: image, audio, video, pdf, text or file (anything else)
export function kindOf(name) {
  const n = String(name).toLowerCase();
  const e = extname(n).slice(1);
  return KIND[e] || NAMED[n] || (n.startsWith(".") && !e ? "text" : "file");
}

export class FilesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// A path from the site ("" is the place itself; "/" between parts) to one on this computer, inside the place or refused.
// Links are followed to see where they really lead.
export function insideRoot(root, rel) {
  const r = String(rel || "").replace(/\\/g, "/");
  if (r.includes("\0") || r.split("/").some(p => p === "..")) throw new FilesError("outside", "That isn't in this folder.");
  const base = resolve(root);
  const full = resolve(base, ...r.split("/").filter(Boolean));
  const within = (b, p) => {
    const d = relative(b, p);
    return d === "" || (!d.startsWith("..") && !isAbsolute(d) && d.split(sep)[0] !== "..");
  };
  if (!within(base, full)) throw new FilesError("outside", "That isn't in this folder.");
  let real;
  try {
    real = realpathSync(full);
  } catch {
    throw new FilesError("missing", "That isn't there any more.");
  }
  if (!within(realpathSync(base), real)) throw new FilesError("outside", "That link leads out of this folder. Open where it leads from This computer instead.");
  return full;
}

// What's in a folder: folders first, then files, by name.
export function list(root, rel, max = 5000) {
  const dir = insideRoot(root, rel);
  let st;
  try {
    st = statSync(dir);
  } catch {
    throw new FilesError("missing", "That folder isn't there any more.");
  }
  if (!st.isDirectory()) throw new FilesError("not_folder", "That's a file, not a folder.");
  let names;
  try {
    names = readdirSync(dir);
  } catch (e) {
    throw new FilesError("unreadable", e.code === "EACCES" || e.code === "EPERM" ? "This folder can't be opened: the computer doesn't allow it." : "This folder couldn't be read.");
  }
  const entries = [];
  for (const name of names) {
    let s;
    let link = false;
    try {
      const l = lstatSync(join(dir, name));
      link = l.isSymbolicLink();
      s = link ? statSync(join(dir, name)) : l;
    } catch {
      if (!link) continue; // gone while it was being read
      s = null; // a link to nothing
    }
    const folder = !!(s && s.isDirectory());
    entries.push({ name, dir: folder, size: s && !folder ? s.size : 0, mtime: s ? Math.round(s.mtimeMs) : 0, kind: folder ? "folder" : kindOf(name), ...(link ? { link: true } : {}), ...(s ? {} : { broken: true }) });
  }
  entries.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" })));
  const clean = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean).join("/");
  return { path: clean, total: entries.length, entries: entries.slice(0, max), cut: entries.length > max };
}

// Facts about one file, before reading it.
export function info(root, rel) {
  const file = insideRoot(root, rel);
  const s = statSync(file);
  if (s.isDirectory()) throw new FilesError("not_file", "That's a folder.");
  return { name: basename(file), size: s.size, mtime: Math.round(s.mtimeMs), kind: kindOf(file) };
}

// Part of a file's bytes: `length` of them from `offset`.
export function readPart(root, rel, offset, length) {
  const file = insideRoot(root, rel);
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.max(0, length));
    const n = readSync(fd, buf, 0, buf.length, offset);
    return buf.subarray(0, n);
  } finally {
    closeSync(fd);
  }
}

// Saving a text file that was edited on the site. Only a file that's there (nothing new is made), and only if it hasn't
// changed on the computer since the site read it (its time then is `mtime`), unless `force`.
export const WRITE_MAX = 2 * 1024 * 1024;
export function write(root, rel, text, { mtime, force } = {}) {
  const file = insideRoot(root, rel);
  const s = statSync(file);
  if (s.isDirectory()) throw new FilesError("not_file", "That's a folder.");
  if (typeof text !== "string") throw new FilesError("bad_text", "There's nothing to save.");
  if (Buffer.byteLength(text) > WRITE_MAX) throw new FilesError("too_big", "That's too big to save from here (2 MB at most).");
  if (!force && Number.isFinite(mtime) && Math.round(s.mtimeMs) !== Math.round(mtime)) throw new FilesError("changed", "This file changed on your computer since you opened it.");
  try {
    writeFileSync(file, text, "utf8");
  } catch (e) {
    throw new FilesError("unwritable", e.code === "EACCES" || e.code === "EPERM" || e.code === "EROFS" ? "This file can't be changed: the computer doesn't allow it." : `It couldn't be saved: ${e.message || e}.`);
  }
  return info(root, rel);
}

// To the Trash. A place itself stays.
export function trash(root, rel, opts) {
  const target = insideRoot(root, rel);
  if (resolve(target) === resolve(root)) throw new FilesError("root", "This place itself can't be moved to the Trash.");
  try {
    return toTrash(target, opts);
  } catch (e) {
    throw new FilesError("trash_failed", `It couldn't be moved to the Trash: ${e.message || e}. Nothing was deleted.`);
  }
}

// Everywhere the file browser can go: the working folder; your home folder, and the Desktop, Documents and Downloads in it;
// folders Claude Code's settings let it into besides (permissions.additionalDirectories); and the whole computer, since
// Claude Code can reach anything you can. `id` is what the site sends back.
export function places({ workspace, home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  const out = [];
  const seen = new Set();
  const add = (id, label, path) => {
    if (!path) return;
    const p = resolve(path);
    if (seen.has(p)) return;
    try {
      if (!statSync(p).isDirectory()) return;
    } catch {
      return;
    }
    seen.add(p);
    out.push({ id, label, path: p });
  };
  add("ws", "Working folder", workspace);
  add("home", "Home", home);
  for (const [id, name] of [["desktop", "Desktop"], ["documents", "Documents"], ["downloads", "Downloads"]]) add(id, name, join(home, name));
  extraFolders({ workspace, home, env }).forEach((p, i) => add("x" + i, basename(p) || p, p));
  if (platform === "win32") {
    for (const d of "CDEFGHIJKLMNOPQRSTUVWXYZ") if (existsSync(d + ":\\")) add("drive-" + d.toLowerCase(), `${d}: drive`, d + ":\\");
  } else add("pc", "This computer", "/");
  return out;
}

// The folders Claude Code's settings allow besides the one it works in: yours (~/.claude/settings.json) and the working
// folder's own (.claude/settings.json and settings.local.json).
function extraFolders({ workspace, home, env }) {
  const files = [join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json")];
  if (workspace) files.push(join(workspace, ".claude", "settings.json"), join(workspace, ".claude", "settings.local.json"));
  const found = [];
  for (const f of files) {
    let j;
    try {
      j = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      continue;
    }
    const list = j && j.permissions && Array.isArray(j.permissions.additionalDirectories) ? j.permissions.additionalDirectories : [];
    for (const d of list.slice(0, 20)) {
      if (typeof d !== "string" || !d.trim()) continue;
      const p = d.startsWith("~") ? join(home, d.slice(1)) : isAbsolute(d) ? d : resolve(workspace || home, d);
      found.push(p);
    }
  }
  return found;
}
