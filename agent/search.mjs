// Searching the file browser by name, quickly. A folder is read once, many of its folders at a time and the shallow ones
// first, into a compact list of names (each with its folder and depth), kept for a little while: every letter typed after
// the first is answered from memory. Big folders give their first results while the rest is still being read.
//
// Filters: what kind of thing it is (from its name), when it last changed and how big it is (both from the computer, only
// for the names that match). Not looked through: node_modules and version-control folders, macOS packages (an .app or a
// Photos library is one thing, as in Finder), hidden things unless they're shown, and ~/Library or AppData at the top of
// the home folder unless hidden things are shown. Links are listed but not followed, so nothing is visited twice.
import { promises as fsp, realpathSync } from "node:fs";
import { join, extname } from "node:path";
import os from "node:os";
import { insideRoot, kindOf, FilesError } from "./files.mjs";

const SKIP = new Set(["node_modules", ".git", ".svn", ".hg", "__pycache__"]);
const PACKAGE = /\.(app|photoslibrary|photolibrary|musiclibrary|tvlibrary|bundle|framework|plugin|kext|appex|xcodeproj|xcworkspace|rtfd|pages|numbers|key|logicx|band|fcpbundle|imovielibrary|lrlibrary|docset|sparsebundle)$/i;
const DOCS = new Set(["pdf", "doc", "docx", "odt", "rtf", "txt", "md", "markdown", "pages", "xls", "xlsx", "ods", "csv", "tsv", "numbers", "ppt", "pptx", "odp", "key", "epub", "tex", "org", "rst", "adoc"]);
const ARCHIVES = new Set(["zip", "tar", "gz", "tgz", "bz2", "xz", "zst", "7z", "rar", "dmg", "iso", "pkg", "deb", "rpm", "msi", "cab"]);
export const KINDS = ["folder", "image", "video", "audio", "doc", "code", "archive", "other"];
export const MODIFIED = { day: 86400e3, week: 7 * 86400e3, month: 30 * 86400e3, year: 365 * 86400e3 };
export const SIZES = { "1m": 1e6, "10m": 1e7, "100m": 1e8, "1g": 1e9 };

// What kind of thing a name is, for the Kind filter.
export function searchKind(name, dir) {
  if (dir && !PACKAGE.test(name)) return "folder";
  const e = extname(String(name)).slice(1).toLowerCase();
  if (DOCS.has(e)) return "doc";
  if (ARCHIVES.has(e)) return "archive";
  const k = kindOf(name);
  if (k === "image" || k === "video" || k === "audio") return k;
  if (k === "pdf") return "doc";
  if (k === "text") return "code";
  return "other";
}

const KEEP_MS = 45000;
const indexes = new Map();
// what was read goes stale after a change made from the site
export function forget() {
  indexes.clear();
}

function index(dir, hidden, { cap, budgetMs }) {
  const key = dir + "\0" + (hidden ? 1 : 0);
  const now = Date.now();
  let ix = indexes.get(key);
  if (ix && (ix.building || now - ix.at < KEEP_MS)) return ix;
  ix = { at: now, names: [], lower: [], parent: [], depth: [], dir: [], done: false, capped: false, building: null };
  // at the top of the home folder: what Finder and Explorer keep out of sight
  const home = (() => {
    try {
      return realpathSync(os.homedir());
    } catch {
      return os.homedir();
    }
  })();
  const top = new Set(!hidden && dir === home ? (process.platform === "darwin" ? ["Library"] : process.platform === "win32" ? ["AppData"] : []) : []);
  ix.building = walk(ix, dir, hidden, top, cap, budgetMs).finally(() => {
    ix.building = null;
    ix.at = Date.now();
  });
  indexes.set(key, ix);
  for (const [k, v] of indexes) if (v !== ix && !v.building && now - v.at > KEEP_MS) indexes.delete(k);
  return ix;
}

// Many folders read at a time, in the order they were found (shallow first), until all are read, or `cap` names are
// listed, or `budgetMs` has gone by.
function walk(ix, root, hidden, top, cap, budgetMs) {
  const dirs = [root];
  const at = [-1];
  let head = 0;
  let active = 0;
  const t0 = Date.now();
  return new Promise(resolve => {
    const next = () => {
      while (active < 16 && head < dirs.length && ix.names.length < cap && Date.now() - t0 < budgetMs) {
        const d = dirs[head];
        const p = at[head];
        head++;
        active++;
        fsp
          .readdir(d, { withFileTypes: true })
          .then(
            list => {
              for (const e of list) {
                const name = e.name;
                if ((!hidden && name.startsWith(".")) || SKIP.has(name) || (p === -1 && top.has(name))) continue;
                const isDir = e.isDirectory();
                const i = ix.names.length;
                ix.names.push(name);
                ix.lower.push(name.toLowerCase());
                ix.parent.push(p);
                ix.depth.push(p === -1 ? 0 : ix.depth[p] + 1);
                ix.dir.push(isDir);
                if (isDir && !PACKAGE.test(name)) {
                  dirs.push(join(d, name));
                  at.push(i);
                }
              }
            },
            () => {}
          )
          .finally(() => {
            active--;
            next();
          });
      }
      if (!active) {
        ix.done = head >= dirs.length;
        ix.capped = !ix.done;
        resolve();
      }
    };
    next();
  });
}

function pathOf(ix, i) {
  const parts = [];
  for (let k = i; k !== -1; k = ix.parent[k]) parts.push(ix.names[k]);
  return parts.reverse();
}

// How well a name fits what was typed: the whole of it (with or without its extension), its start, the start of a word in it,
// or anywhere in it.
function score(lower, q, first) {
  if (lower === q || lower.slice(0, lower.length - extname(lower).length) === q) return 0;
  if (lower.startsWith(q)) return 1;
  const at = lower.indexOf(first);
  if (at > 0 && /[\s._\-()[\]]/.test(lower[at - 1])) return 2;
  return 3;
}

// The search itself: names in the folder `rel` of `root` (and every folder in it) that have every word of `q` in them and
// pass the filters. The best `limit` come back, with their path from `root`, size and time.
export async function search(root, rel, { q = "", kind = "", mod = "", size = "", hidden = false, wait = 4000, limit = 200, cap = 400000, budgetMs = 30000, statMax = 5000 } = {}) {
  const base = insideRoot(root, rel);
  let st;
  try {
    st = await fsp.stat(base);
  } catch {
    throw new FilesError("missing", "That folder isn't there any more.");
  }
  if (!st.isDirectory()) throw new FilesError("not_folder", "That's a file, not a folder.");
  const real = realpathSync(base);
  const ix = index(real, hidden, { cap, budgetMs });
  if (ix.building) {
    let t;
    await Promise.race([ix.building, new Promise(r => (t = setTimeout(r, wait)))]);
    clearTimeout(t);
  }
  const query = String(q).toLowerCase().trim().slice(0, 200);
  const terms = query.split(/\s+/).filter(Boolean).slice(0, 8);
  const want = KINDS.includes(kind) ? kind : "";
  const since = MODIFIED[mod] ? Date.now() - MODIFIED[mod] : 0;
  const min = SIZES[size] || 0;
  const n = ix.names.length;
  const hits = [];
  for (let i = 0; i < n; i++) {
    const l = ix.lower[i];
    if (terms.length && !terms.every(t => l.includes(t))) continue;
    if (want && searchKind(ix.names[i], ix.dir[i]) !== want) continue;
    if (min && ix.dir[i]) continue;
    hits.push(i);
  }
  if (terms.length) {
    const s = new Map(hits.map(i => [i, score(ix.lower[i], query, terms[0])]));
    hits.sort((a, b) => s.get(a) - s.get(b) || ix.depth[a] - ix.depth[b] || ix.names[a].length - ix.names[b].length || ix.lower[a].localeCompare(ix.lower[b]));
  }
  // the computer is asked about each match's size and time: best first, a batch at a time, until there are enough
  const prefix = String(rel || "").replace(/\\/g, "/").split("/").filter(Boolean);
  const out = [];
  let looked = 0;
  const t0 = Date.now();
  // with no words to go by, the newest come first: as many are looked at as time allows, then the newest kept
  const all = !terms.length;
  for (let k = 0; k < hits.length && (all || out.length < limit); k += 64) {
    const batch = hits.slice(k, k + 64);
    const stats = await Promise.all(batch.map(i => fsp.stat(join(real, ...pathOf(ix, i))).catch(() => null)));
    looked += batch.length;
    batch.forEach((i, j) => {
      const s = stats[j];
      if ((since || min) && !s) return;
      if (since && s.mtimeMs < since) return;
      if (min && s.size < min) return;
      const isDir = ix.dir[i] || !!(s && s.isDirectory());
      out.push({ path: [...prefix, ...pathOf(ix, i)].join("/"), name: ix.names[i], dir: isDir, kind: isDir && !PACKAGE.test(ix.names[i]) ? "folder" : kindOf(ix.names[i]), size: s && !isDir ? s.size : 0, mtime: s ? Math.round(s.mtimeMs) : 0 });
    });
    if (looked >= statMax || Date.now() - t0 > 4000) break;
  }
  if (all) out.sort((a, b) => b.mtime - a.mtime);
  return {
    results: out.slice(0, limit),
    // the names that matched (before the date and size filters) out of all those read so far; whether everything there is
    // to read has been; and whether only some matches could be checked for their date and size in time
    matches: hits.length,
    looked: n,
    done: ix.done && !ix.building,
    capped: ix.capped && !ix.building,
    partial: looked < hits.length && !!(since || min || all)
  };
}
