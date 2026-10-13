// Moving a file or folder to the system's own Trash (Recycle Bin on Windows), never deleting it: what's deleted from the
// site's file browser can be put back from there.
//
// macOS: into ~/.Trash, as Finder does for a file in your home folder. Windows: the Recycle Bin, through the same call
// File Explorer's Delete uses (Microsoft.VisualBasic's FileSystem, with no dialog). Linux and the like: the freedesktop.org
// Trash in ~/.local/share/Trash, with the .trashinfo file that lets a file manager put it back.
import { renameSync, cpSync, rmSync, mkdirSync, existsSync, writeFileSync, lstatSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, extname, join } from "node:path";
import os from "node:os";

// a name that isn't taken in `dir`: "report.pdf", then "report 2.pdf", "report 3.pdf"…
export function freeName(dir, name, taken = n => existsSync(join(dir, n))) {
  if (!taken(name)) return name;
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  for (let i = 2; i < 100000; i++) {
    const n = `${stem} ${i}${ext}`;
    if (!taken(n)) return n;
  }
  return `${stem} ${Date.now()}${ext}`;
}

// moved, or copied across disks and then removed
function move(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    cpSync(from, to, { recursive: true, errorOnExist: true, force: false, preserveTimestamps: true });
    rmSync(from, { recursive: true, force: true });
  }
}

const pad = n => String(n).padStart(2, "0");
function trashInfo(path, when) {
  const date = `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`;
  // the path is written as a URL path: each byte outside the safe ones percent-encoded
  const encoded = path.split("/").map(p => encodeURIComponent(p)).join("/");
  return `[Trash Info]\nPath=${encoded}\nDeletionDate=${date}\n`;
}

// Moves `path` to the Trash and says where it went. Throws when it couldn't: nothing is deleted then.
export function toTrash(path, { platform = process.platform, home = os.homedir(), env = process.env, now = new Date() } = {}) {
  lstatSync(path); // it's there (or this throws)
  if (platform === "win32") {
    const folder = lstatSync(path).isDirectory();
    const ps = `Add-Type -AssemblyName Microsoft.VisualBasic; [Microsoft.VisualBasic.FileIO.FileSystem]::${folder ? "DeleteDirectory" : "DeleteFile"}($env:CLAUDECONNECT_TRASH, 'OnlyErrorDialogs', 'SendToRecycleBin')`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { env: { ...env, CLAUDECONNECT_TRASH: path }, encoding: "utf8", windowsHide: true, timeout: 60000 });
    if (r.status !== 0 || existsSync(path)) throw new Error(String(r.stderr || "").trim().split("\n").pop() || "The Recycle Bin didn't take it.");
    return { where: "Recycle Bin" };
  }
  if (platform === "darwin") {
    const dir = join(home, ".Trash");
    mkdirSync(dir, { recursive: true });
    const name = freeName(dir, basename(path));
    move(path, join(dir, name));
    return { where: "Trash", name };
  }
  const data = env.XDG_DATA_HOME || join(home, ".local", "share");
  const files = join(data, "Trash", "files");
  const info = join(data, "Trash", "info");
  mkdirSync(files, { recursive: true });
  mkdirSync(info, { recursive: true });
  // a name free in both: the file, and its .trashinfo
  const name = freeName(files, basename(path), n => existsSync(join(files, n)) || existsSync(join(info, n + ".trashinfo")));
  writeFileSync(join(info, name + ".trashinfo"), trashInfo(path, now), { flag: "wx" });
  try {
    move(path, join(files, name));
  } catch (e) {
    rmSync(join(info, name + ".trashinfo"), { force: true });
    throw e;
  }
  return { where: "Trash", name };
}
