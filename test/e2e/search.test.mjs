// Searching the file browser, end to end: the real agent reads a temporary working folder, the real site passes the search
// on, and the page in a real Chromium shows what matches, with filters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, utimesSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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

async function boot(t) {
  const site = await startSite();
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  const ws = join(pc.home, "ws");
  const old = new Date("2020-01-01T00:00:00Z");
  for (const [p, body] of [
    ["Invoices/2024/invoice-march.pdf", "x".repeat(2_000_000)],
    ["Invoices/2024/invoice april.pdf", "x"],
    ["Invoices/old/invoice-2019.pdf", "x"],
    ["Photos/beach invoice.jpg", "x"],
    ["Code/app/invoice.js", "x"],
    ["Code/node_modules/lib/invoice.js", "x"],
    [".private/invoice-secret.pdf", "x"],
    ["notes.md", "x"]
  ]) {
    mkdirSync(join(ws, p, ".."), { recursive: true });
    writeFileSync(join(ws, p), body);
  }
  mkdirSync(join(ws, "Invoices", "Invoice templates"), { recursive: true });
  utimesSync(join(ws, "Invoices/old/invoice-2019.pdf"), old, old);
  writeFileSync(join(pc.home, "outside-invoice.pdf"), "x");
  symlinkSync(pc.home, join(ws, "link-to-home"));
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the computer online");
  return { site, pc, ws };
}
const find = async (site, params) => (await site.api("/api/files/search?" + new URLSearchParams({ root: "ws", path: "", ...params }))).body;

test("search finds names in the folder and every folder in it, best first, with kind, date and size filters", async t => {
  const { site } = await boot(t);
  let r = await find(site, { q: "invoice" });
  assert.equal(r.done, true);
  const paths = r.results.map(x => x.path);
  assert.deepEqual(paths.slice(0, 1), ["Code/app/invoice.js"], "the whole name first");
  for (const p of ["Invoices/2024/invoice-march.pdf", "Invoices/2024/invoice april.pdf", "Invoices/old/invoice-2019.pdf", "Photos/beach invoice.jpg", "Invoices", "Invoices/Invoice templates"]) assert.ok(paths.includes(p), p);
  assert.ok(!paths.some(p => p.includes("node_modules") || p.includes(".private") || p.includes("outside") || p.startsWith("link-to-home/")), "not node_modules, hidden things, or through a link: " + paths.join(", "));
  assert.equal(r.results.find(x => x.path === "Invoices").dir, true);
  assert.equal(r.results.find(x => x.path === "Invoices/2024/invoice-march.pdf").size, 2_000_000);
  // every word has to be in the name
  assert.deepEqual((await find(site, { q: "invoice 2024" })).results.map(x => x.path), []);
  assert.deepEqual((await find(site, { q: "INVOICE april" })).results.map(x => x.path), ["Invoices/2024/invoice april.pdf"]);
  // filters
  assert.deepEqual((await find(site, { q: "invoice", kind: "folder" })).results.map(x => x.path).sort(), ["Invoices", "Invoices/Invoice templates"]);
  assert.deepEqual((await find(site, { q: "invoice", kind: "image" })).results.map(x => x.path), ["Photos/beach invoice.jpg"]);
  assert.deepEqual((await find(site, { q: "invoice", size: "1m" })).results.map(x => x.path), ["Invoices/2024/invoice-march.pdf"]);
  const recent = (await find(site, { q: "invoice", kind: "doc", mod: "year" })).results.map(x => x.path);
  assert.ok(!recent.includes("Invoices/old/invoice-2019.pdf") && recent.includes("Invoices/2024/invoice april.pdf"), recent.join(", "));
  // no words, only a filter: the newest first
  r = await find(site, { kind: "doc" });
  assert.equal(r.results.at(-1).path, "Invoices/old/invoice-2019.pdf");
  // hidden things when they're shown; from a folder further in; never outside the place
  assert.ok((await find(site, { q: "secret", hidden: "1" })).results.some(x => x.path === ".private/invoice-secret.pdf"));
  assert.deepEqual((await find(site, { q: "invoice", path: "Invoices/2024" })).results.map(x => x.path).sort(), ["Invoices/2024/invoice april.pdf", "Invoices/2024/invoice-march.pdf"]);
  assert.equal((await site.api("/api/files/search?root=ws&path=../&q=invoice")).status, 403);
  assert.equal((await site.api("/api/files/search?root=ws&path=link-to-home&q=invoice")).body.code, "outside");
});

test("in the page: the search box shows results as you type, a filter narrows them, and a result opens or shows its folder", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site } = await boot(t);
  const page = await openPage(site.origin + "/", { width: 1280, height: 800 });
  t.after(() => page.close());
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`location.reload()`);
  await page.until(`document.querySelector('.top [data-view="files"]')`, "the page");
  await page.evaluate(`document.querySelector('.top [data-view="files"]').click()`);
  await page.until(`document.querySelector('[data-fb-open="Invoices"]')`, "the working folder");
  // Ctrl+F opens the search, which says where it looks
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", modifiers: process.platform === "darwin" ? 4 : 2, windowsVirtualKeyCode: 70 });
  await page.until(`!document.getElementById("fbFind").hidden && document.activeElement.id === "fbQ"`, "the search box");
  assert.match(await page.evaluate(`document.getElementById("fbQ").placeholder`), /^Search in /);
  await page.send("Input.insertText", { text: "invoice" });
  await page.until(`document.querySelectorAll("[data-fb-hit]").length >= 6`, "the results");
  assert.match(await page.evaluate(`document.querySelector('[data-fb-hit="Invoices/2024/invoice april.pdf"]').innerHTML`), /<mark>invoice<\/mark> april\.pdf[\s\S]*in Invoices\/2024/);
  assert.match(await page.evaluate(`document.getElementById("fbFoot").textContent`), /results · searched \d+ items/);
  // a filter narrows them
  await page.evaluate(`(() => { const s = document.getElementById("fbKind"); s.value = "image"; s.dispatchEvent(new Event("change")); })()`);
  await page.until(`document.querySelectorAll("[data-fb-hit]").length === 1 && document.querySelector('[data-fb-hit="Photos/beach invoice.jpg"]')`, "only the picture");
  assert.equal(await page.evaluate(`document.getElementById("fbKind").classList.contains("on")`), true);
  // a result opens in the preview, and its folder button goes to where it is
  await page.evaluate(`document.querySelector('[data-fb-hit="Photos/beach invoice.jpg"]').click()`);
  await page.until(`/beach invoice\\.jpg/.test(document.getElementById("fbVHead").textContent)`, "the preview");
  await page.evaluate(`document.querySelector('[data-fb-reveal="Photos/beach invoice.jpg"]').click()`);
  await page.until(`document.getElementById("fbFind").hidden && document.querySelector('[data-fb-open="beach invoice.jpg"]')`, "its folder");
  // Escape in the box ends the search
  await page.evaluate(`document.querySelector('[data-fb="find"]').click()`);
  await page.until(`document.activeElement.id === "fbQ"`, "the box again");
  await page.send("Input.insertText", { text: "zzz-nothing" });
  await page.until(`/Nothing in Photos matches/.test(document.getElementById("fbList").textContent)`, "no matches");
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
  await page.until(`document.getElementById("fbFind").hidden && document.querySelector('[data-fb-open="beach invoice.jpg"]')`, "the folder back");
  assert.equal(await page.evaluate(`!document.getElementById("files").hidden`), true, "Escape there didn't close the file browser");
});
