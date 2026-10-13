// The site's file browser, on this computer: what's in the working folder (the folder Claude Code works in), a file's
// bytes to show it, and moving something to the Trash. Nothing outside the working folder is ever listed, read or moved:
// every path the site sends is checked against it, links that lead out of it included.
import { readdirSync, lstatSync, statSync, realpathSync, openSync, readSync, closeSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep, extname, basename } from "node:path";
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

// A path from the site ("" is the working folder; "/" between parts) to one on this computer, inside the working folder or
// refused. Links are followed to see where they really lead.
export function insideRoot(root, rel) {
  const r = String(rel || "").replace(/\\/g, "/");
  if (r.includes("\0") || r.split("/").some(p => p === "..")) throw new FilesError("outside", "That isn't in the working folder.");
  const base = resolve(root);
  const full = resolve(base, ...r.split("/").filter(Boolean));
  const within = (b, p) => {
    const d = relative(b, p);
    return d === "" || (!d.startsWith("..") && !isAbsolute(d) && d.split(sep)[0] !== "..");
  };
  if (!within(base, full)) throw new FilesError("outside", "That isn't in the working folder.");
  let real;
  try {
    real = realpathSync(full);
  } catch {
    throw new FilesError("missing", "That isn't there any more.");
  }
  if (!within(realpathSync(base), real)) throw new FilesError("outside", "That leads out of the working folder.");
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

// To the Trash. The working folder itself stays.
export function trash(root, rel, opts) {
  const target = insideRoot(root, rel);
  if (resolve(target) === resolve(root)) throw new FilesError("root", "The working folder itself can't be moved to the Trash.");
  try {
    return toTrash(target, opts);
  } catch (e) {
    throw new FilesError("trash_failed", `It couldn't be moved to the Trash: ${e.message || e}. Nothing was deleted.`);
  }
}
