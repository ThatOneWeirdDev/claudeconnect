// The file browser's side on the computer: only inside the place asked for, links that lead out of it included; saving an
// edited file; and the places there are.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, symlinkSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { list, info, readPart, trash, insideRoot, kindOf, write, places } from "../../agent/files.mjs";

function tree() {
  const base = mkdtempSync(join(tmpdir(), "cc-files-"));
  const root = join(base, "work");
  mkdirSync(join(root, "src", "deep"), { recursive: true });
  mkdirSync(join(base, "secret"));
  writeFileSync(join(base, "secret", "key.txt"), "nope");
  writeFileSync(join(root, "b.txt"), "hello world");
  writeFileSync(join(root, "a.png"), "png");
  writeFileSync(join(root, "file10.md"), "#");
  writeFileSync(join(root, "file9.md"), "#");
  writeFileSync(join(root, "src", "deep", "x.py"), "print(1)");
  symlinkSync(join(base, "secret"), join(root, "escape"));
  symlinkSync(join(root, "src"), join(root, "inside"));
  symlinkSync(join(root, "gone"), join(root, "dangling"));
  return { base, root };
}

test("a folder lists its folders first, then files in natural order, with what each one is", () => {
  const { root } = tree();
  const r = list(root, "");
  assert.equal(r.path, "");
  assert.deepEqual(r.entries.map(e => [e.name, e.kind]), [["escape", "folder"], ["inside", "folder"], ["src", "folder"], ["a.png", "image"], ["b.txt", "text"], ["dangling", "file"], ["file9.md", "text"], ["file10.md", "text"]]);
  assert.equal(r.entries.find(e => e.name === "b.txt").size, 11);
  assert.equal(r.entries.find(e => e.name === "dangling").broken, true);
  assert.equal(r.entries.find(e => e.name === "inside").link, true);
  assert.deepEqual(list(root, "src/deep").entries.map(e => e.name), ["x.py"]);
  assert.deepEqual(list(root, "inside/deep").entries.map(e => e.name), ["x.py"], "a link that stays inside works");
});

test("nothing outside the working folder can be listed, read or moved", () => {
  const { root } = tree();
  for (const p of ["..", "../secret", "src/../../secret", "escape", "escape/key.txt"]) {
    assert.throws(() => list(root, p), e => e.code === "outside", p);
    assert.throws(() => readPart(root, p, 0, 10), e => e.code === "outside", p);
    assert.throws(() => trash(root, p), e => e.code === "outside", p);
  }
  assert.throws(() => insideRoot(root, "src\0x"), e => e.code === "outside");
  assert.throws(() => list(root, "nope"), e => e.code === "missing");
  assert.throws(() => list(root, "b.txt"), e => e.code === "not_folder");
  assert.throws(() => trash(root, ""), e => e.code === "root");
});

test("a file's facts and any part of its bytes", () => {
  const { root } = tree();
  assert.deepEqual({ ...info(root, "b.txt"), mtime: 0 }, { name: "b.txt", size: 11, mtime: 0, kind: "text" });
  assert.equal(readPart(root, "b.txt", 6, 100).toString(), "world");
  assert.equal(readPart(root, "b.txt", 50, 10).length, 0);
  assert.equal(kindOf("Song.MP3"), "audio");
  assert.equal(kindOf("clip.mov"), "video");
  assert.equal(kindOf("Dockerfile"), "text");
  assert.equal(kindOf("archive.zip"), "file");
});

test("moving to the Trash takes it out of the working folder and into the Trash", () => {
  const { base, root } = tree();
  const home = join(base, "home");
  mkdirSync(home);
  const r = trash(root, "b.txt", { platform: "linux", home, env: {} });
  assert.deepEqual(r, { where: "Trash", name: "b.txt" });
  assert.equal(existsSync(join(root, "b.txt")), false);
  assert.equal(existsSync(join(home, ".local", "share", "Trash", "files", "b.txt")), true);
});

test("an edited text file is saved over itself, unless it changed on the computer since it was read", () => {
  const { root } = tree();
  const before = info(root, "b.txt");
  const after = write(root, "b.txt", "hello there\nsecond line", { mtime: before.mtime });
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "hello there\nsecond line");
  assert.equal(after.size, 23);
  // changed since: refused, and kept as it is, unless it's saved over anyway
  assert.throws(() => write(root, "b.txt", "mine", { mtime: before.mtime - 5000 }), e => e.code === "changed");
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "hello there\nsecond line");
  write(root, "b.txt", "mine", { mtime: before.mtime - 5000, force: true });
  assert.equal(readFileSync(join(root, "b.txt"), "utf8"), "mine");
  // nothing new is made, nothing outside, and not a folder
  assert.throws(() => write(root, "new.txt", "x"), e => e.code === "missing");
  assert.throws(() => write(root, "escape/key.txt", "x"), e => e.code === "outside");
  assert.throws(() => write(root, "src", "x"), e => e.code === "not_file");
  assert.throws(() => write(root, "b.txt", "x".repeat(2 * 1024 * 1024 + 1)), e => e.code === "too_big");
});

test("the places: the working folder, home and its usual folders, folders Claude Code is allowed into, and the whole computer", () => {
  const base = mkdtempSync(join(tmpdir(), "cc-places-"));
  const home = join(base, "home");
  const ws = join(home, "ws");
  for (const d of [ws, join(home, "Downloads"), join(home, "Desktop"), join(base, "data"), join(home, ".claude"), join(ws, ".claude")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [join(base, "data"), "~/Downloads", join(base, "gone")] } }));
  writeFileSync(join(ws, ".claude", "settings.local.json"), JSON.stringify({ permissions: { additionalDirectories: ["../.."] } }));
  const got = places({ workspace: ws, home, platform: "linux", env: {} });
  assert.deepEqual(got.map(p => [p.id, p.label, p.path]), [
    ["ws", "Working folder", ws],
    ["home", "Home", home],
    ["desktop", "Desktop", join(home, "Desktop")],
    ["downloads", "Downloads", join(home, "Downloads")],
    ["x0", "data", join(base, "data")],
    ["x3", base.split("/").pop(), base],
    ["pc", "This computer", "/"]
  ], "no Documents when there's none, each folder once, and none that isn't there");
  assert.ok(statSync(got[0].path).isDirectory());
});
