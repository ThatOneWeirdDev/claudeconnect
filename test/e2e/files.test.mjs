// The file browser, end to end: the real agent on a temporary home folder, the real site, and the page in a real Chromium.
// What's in the working folder is listed and read through the site, a piece at a time and by range for songs and videos;
// nothing outside it can be reached, links included; and "deleting" moves to the Trash, where it can be put back.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + what);
}

// a 1×1 PNG
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");

async function boot(t) {
  const site = await startSite({ appVersion: "2.2.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  const ws = join(pc.home, "ws");
  mkdirSync(join(ws, "photos", "trip"), { recursive: true });
  writeFileSync(join(ws, "photos", "dot.png"), PNG);
  writeFileSync(join(ws, "notes.md"), "# Notes\n\nhello from the working folder\n");
  writeFileSync(join(ws, ".hidden"), "secret-ish");
  writeFileSync(join(ws, "empty.txt"), "");
  const big = randomBytes(700000); // three pieces from the computer
  writeFileSync(join(ws, "song.mp3"), big);
  writeFileSync(join(pc.home, "outside.txt"), "not in the working folder");
  symlinkSync(join(pc.home, "outside.txt"), join(ws, "sneaky.txt"));
  symlinkSync(pc.home, join(ws, "way-out"));
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  return { site, pc, ws, big };
}

test("the working folder is listed, read whole and by range, and nothing outside it can be reached", async t => {
  const { site, pc, ws, big } = await boot(t);
  const state = (await site.api("/api/state")).body;
  assert.equal(state.agent.files, true, "the computer says it can");

  const root = (await site.api("/api/files")).body;
  assert.equal(root.path, "");
  assert.equal(root.root, "~/ws");
  assert.deepEqual(root.entries.map(e => [e.name, e.kind, e.dir]), [
    ["photos", "folder", true], ["uploads", "folder", true], ["way-out", "folder", true], [".hidden", "text", false], ["empty.txt", "text", false], ["notes.md", "text", false], ["sneaky.txt", "text", false], ["song.mp3", "audio", false]
  ], "folders first, then files, by name, hidden ones too (the page hides them until asked)");
  assert.equal(root.entries.find(e => e.name === "song.mp3").size, 700000);
  assert.equal(root.entries.find(e => e.name === "sneaky.txt").link, true);

  const photos = (await site.api("/api/files?path=photos")).body;
  assert.deepEqual(photos.entries.map(e => [e.name, e.kind]), [["trip", "folder"], ["dot.png", "image"]]);

  // a picture, as itself, and nothing in it may run
  let r = await site.asOwner("/api/files/raw?path=photos/dot.png");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/png");
  assert.match(r.headers.get("content-security-policy"), /^sandbox;/);
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), PNG);

  // text is plain text, whatever it says it is
  r = await site.asOwner("/api/files/raw?path=notes.md");
  assert.equal(r.headers.get("content-type"), "text/plain; charset=utf-8");
  assert.equal(await r.text(), "# Notes\n\nhello from the working folder\n");

  // a big file comes through whole, from several pieces
  r = await site.asOwner("/api/files/raw?path=song.mp3&download=1");
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "audio/mpeg");
  assert.equal(r.headers.get("accept-ranges"), "bytes");
  assert.match(r.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''song\.mp3$/);
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(big), "every byte, in order");

  // ranges, the way an audio or video element asks
  r = await site.asOwner("/api/files/raw?path=song.mp3", { headers: { range: "bytes=300000-300099" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 300000-300099/700000");
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(big.subarray(300000, 300100)));
  r = await site.asOwner("/api/files/raw?path=song.mp3", { headers: { range: "bytes=-10" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 699990-699999/700000");
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(big.subarray(699990)));
  r = await site.asOwner("/api/files/raw?path=song.mp3", { headers: { range: "bytes=0-" } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get("content-range"), "bytes 0-699999/700000");
  assert.equal((await r.arrayBuffer()).byteLength, 700000);
  r = await site.asOwner("/api/files/raw?path=song.mp3", { headers: { range: "bytes=800000-" } });
  assert.equal(r.status, 416);
  assert.equal(r.headers.get("content-range"), "bytes */700000");
  await r.arrayBuffer();
  r = await site.asOwner("/api/files/raw?path=empty.txt");
  assert.equal(r.status, 200);
  assert.equal(await r.text(), "");

  // outside the working folder: by "..", by a link to a file, or into a linked folder
  for (const [path, code] of [["../outside.txt", "outside"], ["photos/../../outside.txt", "outside"], ["sneaky.txt", "outside"], ["way-out/outside.txt", "outside"], ["nope.txt", "missing"]]) {
    r = await site.asOwner(`/api/files/raw?path=${encodeURIComponent(path)}`);
    const j = await r.json();
    assert.equal(j.code, code, path);
    assert.ok(r.status === 403 || r.status === 404, path);
    assert.doesNotMatch(JSON.stringify(j), /not in the working folder/, "and nothing of it is sent");
  }
  r = await site.api("/api/files?path=way-out");
  assert.equal(r.body.code, "outside");
  r = await site.api("/api/files?path=notes.md");
  assert.equal(r.body.code, "not_folder");

  // to the Trash: gone from the folder, there with the note that puts it back
  r = await site.api("/api/files/trash", { method: "POST", body: JSON.stringify({ path: "notes.md" }) });
  assert.deepEqual(r.body, { ok: true, where: "Trash" });
  assert.equal(existsSync(join(ws, "notes.md")), false);
  const trash = join(pc.home, ".local", "share", "Trash");
  assert.equal(readFileSync(join(trash, "files", "notes.md"), "utf8"), "# Notes\n\nhello from the working folder\n");
  assert.match(readFileSync(join(trash, "info", "notes.md.trashinfo"), "utf8"), new RegExp(`^\\[Trash Info\\]\\nPath=${join(ws, "notes.md").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\nDeletionDate=\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\n$`));
  // a folder goes whole
  r = await site.api("/api/files/trash", { method: "POST", body: JSON.stringify({ path: "photos/trip" }) });
  assert.equal(r.body.ok, true);
  assert.equal(existsSync(join(trash, "files", "trip")), true);
  // never the working folder itself, nothing outside it, and not what a link leads to
  for (const path of ["", "/", "..", "../outside.txt", "sneaky.txt/"]) {
    r = await site.api("/api/files/trash", { method: "POST", body: JSON.stringify({ path }) });
    assert.notEqual(r.body.ok, true, JSON.stringify(path));
  }
  assert.equal(existsSync(join(pc.home, "outside.txt")), true);
  assert.match(pc.log(), /Moved notes\.md to the Trash, from the site's file browser\./);
});

test("an artifact remembers where it is in the working folder", async t => {
  const { site } = await boot(t);
  const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "please write a file", model: "claude-opus-5-5" }) });
  const lines = (await res.text()).trim().split("\n").map(l => JSON.parse(l));
  const done = lines.find(l => l.type === "done");
  assert.ok(done, JSON.stringify(lines.slice(-3)));
  const arts = done.message.meta.artifacts;
  assert.deepEqual(arts.map(a => [a.name, a.path, a.kind]), [["chart.svg", "art/chart.svg", "image"]]);
  // and the file browser has it there
  const art = (await site.api("/api/files?path=art")).body;
  assert.deepEqual(art.entries.map(e => e.name), ["chart.svg"]);
});

test("the file browser in the page: opened from Settings, full screen, showing pictures, text and songs, and moving to the Trash", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, ws } = await boot(t);
  const page = await openPage(site.origin + "/");
  t.after(() => page.close());
  await page.until(`window.document.getElementById("input")`, "the page");
  await page.until(`(async () => { const r = await fetch("/api/state"); return (await r.json()).agent.online; })()`, "the computer online");
  await page.evaluate(`document.getElementById("profileBtn").click()`);
  await page.until(`document.querySelector('[data-pm="settings"]')`, "the account menu");
  await page.evaluate(`document.querySelector('[data-pm="settings"]').click()`);
  await page.until(`document.querySelector('[data-tab-set="files"]')`, "Settings");
  await page.evaluate(`document.querySelector('[data-tab-set="files"]').click()`);
  await page.until(`document.querySelector('[data-act="files"]:not([disabled])')`, "the Files section");
  await page.evaluate(`document.querySelector('[data-act="files"]').click()`);
  await page.until(`!document.getElementById("files").hidden && !document.getElementById("setDlg").open`, "the file browser, over the whole page");
  const box = await page.evaluate(`(() => { const r = document.getElementById("files").getBoundingClientRect(); return [r.width, r.height, innerWidth, innerHeight]; })()`);
  assert.deepEqual([box[0], box[1]], [box[2], box[3]], "full screen");
  await page.until(`document.querySelectorAll("#fbList .fb-row").length === 7`, "the list, without the hidden file");
  assert.equal(await page.evaluate(`document.getElementById("app").inert`), true, "what's under it can't be reached");
  assert.equal(await page.evaluate(`document.querySelector(".crumbs").textContent`), "~/ws");
  assert.match(await page.evaluate(`document.getElementById("fbFoot").textContent`), /^7 items, and 1 hidden$/);

  // hidden files, when asked
  await page.evaluate(`document.querySelector('[data-fb="hidden"]').click()`);
  await page.until(`document.querySelectorAll("#fbList .fb-row").length === 8`, "the hidden file too");
  await page.evaluate(`document.querySelector('[data-fb="hidden"]').click()`);

  // a song plays from the computer
  await page.evaluate(`document.querySelector('[data-fb-open="song.mp3"]').click()`);
  await page.until(`document.querySelector("#fbVBody audio")`, "an audio player");
  assert.equal(await page.evaluate(`document.querySelector("#fbVHead b").textContent`), "song.mp3");
  assert.match(await page.evaluate(`document.querySelector("#fbVHead small").textContent`), /^Audio · 684 KB · /);

  // a text file, as text
  await page.evaluate(`document.querySelector('[data-fb-open="notes.md"]').click()`);
  await page.until(`(document.querySelector("#fbVBody pre code") || {}).textContent === "# Notes\\n\\nhello from the working folder\\n"`, "the text");

  // into a folder, and a picture there
  await page.evaluate(`document.querySelector('[data-fb-open="photos"]').click()`);
  await page.until(`document.querySelector('[data-fb-open="dot.png"]')`, "the photos folder");
  assert.equal(await page.evaluate(`[...document.querySelectorAll(".crumbs button")].map(b => b.textContent).join("/")`), "~/ws/photos");
  await page.evaluate(`document.querySelector('[data-fb-open="dot.png"]').click()`);
  await page.until(`(document.querySelector("#fbVBody img") || {}).naturalWidth === 1`, "the picture, loaded");

  // to the Trash, after asking
  await page.evaluate(`window.confirm = m => (window.asked = m, true)`);
  await page.evaluate(`document.querySelector('[data-fb="trash"]').click()`);
  await page.until(`!document.querySelector('[data-fb-open="dot.png"]')`, "the picture gone from the list");
  assert.match(await page.evaluate(`window.asked`), /^Move "dot\.png" to the Trash on your computer\?[\s\S]*you can put it back from the Trash/);
  assert.equal(existsSync(join(ws, "photos", "dot.png")), false);
  assert.match(await page.evaluate(`document.getElementById("toast").textContent`), /Moved "dot\.png" to the Trash\./);

  // back up, then closed: Settings again, where it was opened from
  await page.evaluate(`document.querySelector('.crumbs [data-fb-go=""]').click()`);
  await page.until(`document.querySelector('[data-fb-open="notes.md"]')`, "the working folder again");
  await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
  await page.until(`document.getElementById("files").hidden && document.getElementById("setDlg").open`, "Settings again");
  assert.equal(await page.evaluate(`document.getElementById("app").inert`), false);
});

test("an artifact's Show in file browser opens the browser with it picked", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site } = await boot(t);
  const page = await openPage(site.origin + "/");
  t.after(() => page.close());
  await page.until(`document.getElementById("input")`, "the page");
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`(() => { const i = document.getElementById("input"); i.value = "please write a file"; i.dispatchEvent(new Event("input", { bubbles: true })); document.getElementById("sendBtn").click(); })()`);
  await page.until(`document.querySelector(".art[data-art]")`, "the artifact card", 30000);
  await page.evaluate(`document.querySelector(".art[data-art]").click()`);
  await page.until(`!document.getElementById("panel").hidden && !document.getElementById("pReveal").hidden`, "the preview, with Show in file browser");
  assert.equal(await page.evaluate(`document.getElementById("pReveal").getAttribute("aria-label")`), "Show in file browser");
  await page.evaluate(`document.getElementById("pReveal").click()`);
  await page.until(`!document.getElementById("files").hidden && (document.querySelector("#fbVHead b") || {}).textContent === "chart.svg"`, "the file browser with it picked");
  assert.equal(await page.evaluate(`[...document.querySelectorAll(".crumbs button")].map(b => b.textContent).join("/")`), "~/ws/art");
  assert.equal(await page.evaluate(`document.querySelector(".fb-row.on b").textContent`), "chart.svg");
  await page.until(`(document.querySelector("#fbVBody img") || {}).naturalWidth === 40`, "the picture, loaded");
  // closed, the chat is back as it was, with the preview still open
  await page.evaluate(`document.querySelector('[data-fb="close"]').click()`);
  await page.until(`document.getElementById("files").hidden && !document.getElementById("panel").hidden`, "the chat and its preview");
});
