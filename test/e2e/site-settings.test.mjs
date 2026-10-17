// The site's name and images, changed from Settings: they take effect straight away with no redeploy, the computer is
// told so it keeps its own copy, and a later deploy with different values (from `<command> edit`) wins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";
import { findTemplate } from "../../site/templates.js";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("a new name and logo take effect at once, on the page, the locked page and the images", async t => {
  const s = await startSite({ appVersion: "1.10.0" });
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  const before = (await s.api("/api/state")).body.site;
  assert.deepEqual([before.name, before.logo, before.favicon], ["Test Site", false, false]);
  assert.equal(before.fable, undefined, "Fable 5.1 isn't a setting any more");

  const r = await s.post("/api/site", { displayName: "  My   Place ", logo: { b64: PNG } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.name, r.body.logo], ["My Place", true]);
  assert.notEqual(r.body.v, before.v, "the images get a new address");
  // the page is served with it, with no redeploy
  const page = await (await s.asOwner("/")).text();
  assert.match(page, /<title>My Place<\/title>/);
  assert.match(page, new RegExp(`<img src="/favicon\\?v=${r.body.v}"`), "the page shows the tab icon, never a separate logo");
  assert.doesNotMatch(page, /src="\/logo/);
  assert.match(page, new RegExp(`href="/favicon\\?v=${r.body.v}"`));
  assert.doesNotMatch(page, /"fable"/);
  const logo = await s.asOwner(`/logo?v=${r.body.v}`);
  assert.equal(logo.headers.get("content-type"), "image/png");
  assert.match(logo.headers.get("cache-control"), /immutable/);
  assert.equal((await s.asOwner("/favicon")).headers.get("content-type"), "image/png", "the tab icon falls back to the logo");
  const locked = await (await s.mf.dispatchFetch(s.origin + "/", { headers: { "x-test-anonymous": "1" } })).text();
  assert.match(locked, /<title>My Place<\/title>/);
  // Fable 5.1 isn't a setting: it can be sent to whenever there are usage credits
  const now = Math.floor(Date.now() / 1000);
  agent.send({ type: "limits", limits: { status: "allowed", overageStatus: "allowed", windows: { five_hour: { pct: 10, resetsAt: now + 3600 }, seven_day: { pct: 5, resetsAt: now + 86400 } } } });
  await new Promise(r => setTimeout(r, 150));
  assert.equal((await s.api("/api/state")).body.fable.available, true);
  const send = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hi", model: "claude-fable-5-1" }) });
  const run = await agent.next(m => m.type === "run");
  assert.equal(run.model, "claude-fable-5-1");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
  await (await send).text();
  // and the computer was told, so its own copy matches for the next update and for `edit`
  const told = await agent.next(m => m.type === "site");
  assert.equal(told.displayName, "My Place");
  assert.equal(told.fable, undefined);
  assert.equal(told.brand.logo.b64, PNG);
  assert.equal(told.brand.favicon, null);

  // back to the built-in logo
  assert.equal((await s.post("/api/site", { logo: null })).body.logo, false);
  assert.equal((await s.asOwner("/logo")).status, 404);
  // nonsense is refused and changes nothing
  for (const bad of [{ displayName: "" }, { displayName: "<b>" }, { logo: { b64: "bm90IGFuIGltYWdl" } }]) assert.equal((await s.post("/api/site", bad)).status, 400, JSON.stringify(bad));
  assert.equal((await s.api("/api/state")).body.site.name, "My Place");
});

test("a deploy with a different name (from `<command> edit`) wins over a name set here earlier; the same name doesn't", async t => {
  const s = await startSite({ appVersion: "1.10.0" });
  t.after(() => s.stop());
  await s.claim();
  await s.post("/api/site", { displayName: "From Settings" });
  // what the Durable Object keeps, read the way a later deploy with other values would see it
  const rec = await s.getStorage("site");
  assert.deepEqual(rec.name, { value: "From Settings", over: "Test Site" });
  // a later deploy whose SITE_NAME is something else (an `edit` from the terminal): the change made here no longer applies
  await s.putStorage("site", { ...rec, name: { value: "From Settings", over: "Some Older Name" } });
  assert.equal((await s.api("/api/state")).body.site.name, "Test Site");
  // a deploy that kept the name it had (an update): it still does
  await s.putStorage("site", rec);
  assert.equal((await s.api("/api/state")).body.site.name, "From Settings");
});

test("the ChatGPT template from Settings: its name and tab icon at once, the tab saying the name, and the page knows it's in use", async t => {
  const s = await startSite({ appVersion: "1.10.0" });
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  const T = findTemplate("chatgpt");
  // the page knows the templates, and each one's icon can be shown before it's picked
  const page = await (await s.asOwner("/")).text();
  assert.match(page, /"templates":\[\{"id":"chatgpt","name":"ChatGPT","about":"[^"]+"\}\]/);
  assert.doesNotMatch(page, new RegExp(T.favicon.b64.slice(0, 40).replace(/[+/]/g, "\\$&")), "not the icon itself, which has its own address");
  const icon = await s.mf.dispatchFetch(s.origin + "/templates/chatgpt?v=1", { headers: { "x-test-anonymous": "1" } });
  assert.equal(icon.status, 200);
  assert.equal(icon.headers.get("content-type"), "image/png");
  assert.equal(Buffer.from(await icon.arrayBuffer()).toString("base64"), T.favicon.b64);
  assert.equal((await s.asOwner("/templates/nope")).status, 404);

  await s.post("/api/site", { tab: "My own tab" });
  assert.equal((await s.api("/api/state")).body.site.template, "");
  const r = await s.post("/api/site", { template: "chatgpt" });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual([r.body.name, r.body.tab, r.body.favicon, r.body.template], ["ChatGPT", "", true, "chatgpt"]);
  const fav = await s.asOwner(`/favicon?v=${r.body.v}`);
  assert.equal(Buffer.from(await fav.arrayBuffer()).toString("base64"), T.favicon.b64);
  assert.match(await (await s.asOwner("/")).text(), /<title>ChatGPT<\/title>/);
  // the computer keeps its own copy, for the next update's deploy and the command's new name
  const told = await agent.next(m => m.type === "site" && m.displayName === "ChatGPT");
  assert.equal(told.tab, "");
  assert.equal(told.brand.favicon.b64, T.favicon.b64);

  // another tab icon, and it isn't the template any more; an unknown template changes nothing
  assert.equal((await s.post("/api/site", { favicon: { b64: PNG } })).body.template, "");
  assert.equal((await s.post("/api/site", { template: "nope" })).status, 400);
  const now = (await s.api("/api/state")).body.site;
  assert.deepEqual([now.name, now.template], ["ChatGPT", ""]);
});

test("Settings → Appearance offers the ChatGPT template, asks in the page's own dialog, then shows it's in use", { skip: !CHROME && "needs a Chromium" }, async t => {
  const s = await startSite({ appVersion: "1.10.0" });
  t.after(() => s.stop());
  await s.claim();
  const page = await openPage(s.origin + "/");
  t.after(() => page.close());
  await page.until(`document.getElementById("input")`, "the page");
  await page.evaluate(`document.getElementById("profileBtn").click()`);
  await page.until(`document.querySelector('[data-pm="settings"]')`, "the profile menu");
  await page.evaluate(`document.querySelector('[data-pm="settings"]').click()`);
  await page.until(`document.querySelector('[data-tab-set="appearance"]')`, "Settings");
  await page.evaluate(`document.querySelector('[data-tab-set="appearance"]').click()`);
  await page.until(`document.querySelector('[data-template="chatgpt"]')`, "the template's Use button");
  const row = await page.evaluate(`document.querySelector('[data-template="chatgpt"]').closest(".img-field").innerText`);
  assert.match(row, /ChatGPT[\s\S]*ChatGPT's icon/);
  assert.equal(await page.until(`(() => { const i = document.querySelector('[data-template="chatgpt"]').closest(".img-field").querySelector("img"); return i.complete && i.naturalWidth; })()`, "the template's icon"), 256);
  // asked first, never with the browser's own confirm(); No changes nothing
  await page.evaluate(`document.querySelector('[data-template="chatgpt"]').click()`);
  await page.until(`document.getElementById("askDlg").open`, "the page's dialog");
  assert.match(await page.evaluate(`document.getElementById("askTitle").textContent`), /Use the ChatGPT template\?/);
  await page.evaluate(`document.getElementById("askNo").click()`);
  await page.until(`!document.getElementById("askDlg").open`, "the dialog closed");
  assert.equal((await s.api("/api/state")).body.site.name, "Test Site");
  await page.evaluate(`document.querySelector('[data-template="chatgpt"]').click()`);
  await page.until(`document.getElementById("askDlg").open`, "the page's dialog");
  await page.evaluate(`document.getElementById("askYes").click()`);
  // if it doesn't come, say what the page shows instead
  const inUse = await page.until(`(() => { const o = document.querySelector(".tpl-on"); return o && o.textContent; })()`, "In use").catch(async e => {
    throw new Error(`${e.message}. The page shows: ${await page.evaluate(`JSON.stringify({ dialog: document.getElementById("askDlg").open, pane: (document.getElementById("setPane") || {}).innerText })`)}; the site has: ${JSON.stringify((await s.api("/api/state")).body.site)}`);
  });
  assert.match(inUse, /In use/);
  assert.equal(await page.evaluate(`document.title`), "ChatGPT");
  assert.equal(await page.evaluate(`document.getElementById("brand").innerText.trim()`), "ChatGPT", "the sidebar says the new name without a reload");
  assert.equal((await s.api("/api/state")).body.site.template, "chatgpt");
});
