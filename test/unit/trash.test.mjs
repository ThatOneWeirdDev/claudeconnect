// Deleting from the file browser moves things to the system's Trash, never deletes them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { toTrash, freeName } from "../../agent/trash.mjs";

test("a free name in the Trash keeps the extension and counts up", () => {
  const taken = new Set(["report.pdf", "report 2.pdf", "notes"]);
  assert.equal(freeName("/x", "report.pdf", n => taken.has(n)), "report 3.pdf");
  assert.equal(freeName("/x", "notes", n => taken.has(n)), "notes 2");
  assert.equal(freeName("/x", ".env", n => n === ".env"), ".env 2");
  assert.equal(freeName("/x", "fresh.txt", n => taken.has(n)), "fresh.txt");
});

test("on Linux a file goes to the freedesktop.org Trash, with what a file manager needs to put it back", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-trash-"));
  const work = join(home, "work");
  mkdirSync(join(work, "pics"), { recursive: true });
  writeFileSync(join(work, "a b.txt"), "one");
  writeFileSync(join(work, "pics", "cat.png"), "meow");
  const when = new Date(2026, 9, 13, 9, 5, 7);
  const r = toTrash(join(work, "a b.txt"), { platform: "linux", home, env: {}, now: when });
  assert.deepEqual(r, { where: "Trash", name: "a b.txt" });
  assert.equal(existsSync(join(work, "a b.txt")), false);
  const trash = join(home, ".local", "share", "Trash");
  assert.equal(readFileSync(join(trash, "files", "a b.txt"), "utf8"), "one");
  assert.equal(readFileSync(join(trash, "info", "a b.txt.trashinfo"), "utf8"), `[Trash Info]\nPath=${join(work, "a b.txt").split("/").map(encodeURIComponent).join("/")}\nDeletionDate=2026-10-13T09:05:07\n`);
  // the same name again, and a whole folder
  writeFileSync(join(work, "a b.txt"), "two");
  assert.equal(toTrash(join(work, "a b.txt"), { platform: "linux", home, env: {} }).name, "a b 2.txt");
  assert.equal(toTrash(join(work, "pics"), { platform: "linux", home, env: {} }).name, "pics");
  assert.deepEqual(readdirSync(join(trash, "files", "pics")), ["cat.png"]);
  assert.throws(() => toTrash(join(work, "nothing-here"), { platform: "linux", home, env: {} }));
});

test("on a Mac it goes to ~/.Trash", () => {
  const home = mkdtempSync(join(tmpdir(), "cc-trash-"));
  writeFileSync(join(home, "song.mp3"), "la");
  assert.deepEqual(toTrash(join(home, "song.mp3"), { platform: "darwin", home }), { where: "Trash", name: "song.mp3" });
  assert.equal(readFileSync(join(home, ".Trash", "song.mp3"), "utf8"), "la");
  assert.equal(existsSync(join(home, "song.mp3")), false);
});
