// Searching the file browser by name (agent/search.mjs), on a temporary folder.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";
import { search, forget, searchKind } from "../../agent/search.mjs";

function tree(files) {
  const root = mkdtempSync(join(os.tmpdir(), "cc-search-"));
  for (const f of files) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    if (!f.endsWith("/")) writeFileSync(join(root, f), "x");
  }
  return root;
}

test("what kind a name is, for the Kind filter", () => {
  assert.deepEqual(
    [["Taxes", true], ["Mail.app", true], ["a.PDF", false], ["b.docx", false], ["c.png", false], ["d.mov", false], ["e.flac", false], ["f.ts", false], ["g.zip", false], ["h.bin", false]].map(([n, d]) => searchKind(n, d)),
    ["folder", "other", "doc", "doc", "image", "video", "audio", "code", "archive", "other"]
  );
});

test("a macOS package is one thing, and links aren't followed", async t => {
  const root = tree(["Notes.app/Contents/notes-inside.txt", "real/notes.txt"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  symlinkSync(join(root, "real"), join(root, "loop"));
  const r = await search(root, "", { q: "notes" });
  assert.deepEqual(r.results.map(x => x.path).sort(), ["Notes.app", "real/notes.txt"]);
  assert.equal(r.results.find(x => x.path === "Notes.app").dir, true);
  forget();
});

test("the names read are kept for the next letters, and forgotten after a change from the site", async t => {
  const root = tree(["a/report-one.txt"]);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal((await search(root, "", { q: "report" })).results.length, 1);
  writeFileSync(join(root, "a", "report-two.txt"), "x");
  assert.equal((await search(root, "", { q: "repor" })).results.length, 1, "answered from what was read");
  forget();
  assert.equal((await search(root, "", { q: "repor" })).results.length, 2);
  forget();
});

test("a folder too big to read in full says so, and gives what it read", async t => {
  const root = tree(Array.from({ length: 30 }, (_, i) => `d${i}/file-${i}.txt`));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const r = await search(root, "", { q: "file", cap: 20 });
  assert.equal(r.capped, true);
  assert.equal(r.done, false);
  assert.ok(r.looked >= 20 && r.looked < 60, String(r.looked));
  forget();
  await assert.rejects(search(root, "d1/file-1.txt", { q: "x" }), { code: "not_folder" });
  await assert.rejects(search(root, "../", { q: "x" }), { code: "outside" });
});
