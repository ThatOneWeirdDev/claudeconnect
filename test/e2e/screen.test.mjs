// Remote: the computer's screen on the site, and its mouse and keyboard from there. The real agent runs with a stand-in
// screen (CLAUDECONNECT_SCREEN=fake:…): a fixed picture, and what's done over it written to screen-input.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();
const PICTURE = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "screen.jpg");
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
  pc.env.CLAUDECONNECT_SCREEN = "fake:" + PICTURE;
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the computer online");
  const done = () => (existsSync(join(pc.dir, "screen-input.jsonl")) ? readFileSync(join(pc.dir, "screen-input.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(l => JSON.parse(l)) : []);
  return { site, pc, done };
}
const frame = site => site.asOwner("/api/screen/frame", { method: "POST", body: JSON.stringify({ w: 1280 }) });

test("the screen is only shown once Remote is turned on, and what's done over it reaches the computer, cleaned up", async t => {
  const { site, done } = await boot(t);
  const state = (await site.api("/api/state")).body;
  assert.equal(state.agent.screen, true, "this computer can do it");
  assert.equal(state.agent.computer.screen, false, "off until it's turned on");
  let r = await frame(site);
  assert.equal(r.status, 409);
  assert.deepEqual(await r.json(), { error: "Remote is off on this computer.", code: "off", os: process.platform });
  assert.equal((await site.post("/api/screen/input", { events: [{ t: "move", x: 0.5, y: 0.5 }] })).status, 409);
  assert.deepEqual(done(), [], "nothing was done while it was off");

  const on = await site.post("/api/computer", { screen: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.computer.screen, true);
  r = await frame(site);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-type"), "image/jpeg");
  assert.equal(r.headers.get("cache-control"), "no-store");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), readFileSync(PICTURE));

  const sent = await site.post("/api/screen/input", {
    events: [
      { t: "move", x: 0.25, y: 0.5 },
      { t: "down", x: 2, y: -1, b: 0, n: 2 },
      { t: "up", x: 0.5, y: 0.5, b: 2 },
      { t: "scroll", x: 0.5, y: 0.5, dy: 3, dx: 0 },
      { t: "text", s: "héllo\r\nthere" },
      { t: "key", k: "C", mods: ["ctrl", "nonsense"] },
      { t: "key", k: "rm -rf /" },
      { t: "exec", s: "anything" },
      { t: "scroll", x: 0.5, y: 0.5, dy: 0, dx: 0 }
    ]
  });
  assert.equal(sent.status, 200, sent.text);
  assert.deepEqual(done(), [
    { t: "move", x: 0.25, y: 0.5 },
    { t: "down", x: 1, y: 0, b: 0, n: 2 },
    { t: "up", x: 0.5, y: 0.5, b: 2, n: 1 },
    { t: "scroll", x: 0.5, y: 0.5, dy: 3, dx: 0 },
    { t: "text", s: "héllo\nthere" },
    { t: "key", k: "c", mods: ["ctrl"] }
  ]);
  assert.equal((await site.post("/api/screen/input", { events: [] })).status, 400);
  // and another site can't drive it through the owner's browser
  assert.equal((await site.asOwner("/api/screen/input", { method: "POST", headers: { origin: "https://evil.example" }, body: JSON.stringify({ events: [{ t: "text", s: "x" }] }) })).status, 403);

  // turned off again, nothing more is shown
  assert.equal((await site.post("/api/computer", { screen: false })).body.computer.screen, false);
  assert.equal((await frame(site)).status, 409);
});

test("Remote in the sidebar: turned on from there, the screen shows, and clicks, keys and the wheel go over", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, pc, done } = await boot(t);
  const page = await openPage(site.origin + "/", { width: 1280, height: 800 });
  t.after(() => page.close());
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`location.reload()`);
  await page.until(`document.getElementById("screenNav")`, "the sidebar");
  await page.evaluate(`document.getElementById("screenNav").click()`);
  await page.until(`!document.getElementById("screen").hidden && document.getElementById("main").classList.contains("screen-open")`, "the Remote view");
  assert.equal(await page.evaluate(`getComputedStyle(document.querySelector(".dock")).display`), "none", "in place of the chat");
  // off: it says what Remote is, and turns on from here
  await page.until(`document.querySelector('#scMsg [data-sc="on"]')`, "the Turn on button");
  assert.match(await page.evaluate(`document.getElementById("scMsg").innerText`), /Use your computer from here[\s\S]*Screen Recording and Accessibility/);
  await page.evaluate(`document.querySelector('#scMsg [data-sc="on"]').click()`);
  await page.until(`(() => { const i = document.getElementById("scImg"); return !i.hidden && i.naturalWidth === 640; })()`, "the screen");
  await page.until(`/Live/.test(document.getElementById("scStatus").textContent)`, "Live");
  assert.equal((await site.api("/api/state")).body.agent.computer.screen, true);

  // a click in the middle of the picture, where the picture is
  const box = await page.evaluate(`(() => { const r = document.getElementById("scImg").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
  const at = (fx, fy) => ({ x: box.x + box.w * fx, y: box.y + box.h * fy });
  const mouse = async (type, p, button = "left", clickCount = 1) => page.send("Input.dispatchMouseEvent", { type, x: p.x, y: p.y, button, clickCount, buttons: type === "mousePressed" ? 1 : 0 });
  rmSync(join(pc.dir, "screen-input.jsonl"), { force: true });
  await mouse("mousePressed", at(0.5, 0.25));
  await mouse("mouseReleased", at(0.5, 0.25));
  await until(async () => done().some(e => e.t === "up"), "the click");
  const click = done().filter(e => e.t === "down" || e.t === "up");
  assert.deepEqual(click.map(e => [e.t, e.b, e.n]), [["down", 0, 1], ["up", 0, 1]]);
  for (const e of click) {
    assert.ok(Math.abs(e.x - 0.5) < 0.01 && Math.abs(e.y - 0.25) < 0.01, JSON.stringify(e));
  }
  // the keys now go to the computer: letters as text, Enter and shortcuts as keys
  assert.equal(await page.evaluate(`document.activeElement.id`), "scType");
  for (const [key, code, text] of [["h", "KeyH", "h"], ["i", "KeyI", "i"]]) {
    await page.send("Input.dispatchKeyEvent", { type: "keyDown", key, code, text });
    await page.send("Input.dispatchKeyEvent", { type: "keyUp", key, code });
  }
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
  await page.send("Input.dispatchKeyEvent", { type: "keyDown", key: "c", code: "KeyC", modifiers: 2, windowsVirtualKeyCode: 67 });
  await until(async () => done().some(e => e.t === "key" && e.k === "c"), "the shortcut");
  const typed = done().filter(e => e.t === "text" || e.t === "key");
  assert.equal(typed.filter(e => e.t === "text").map(e => e.s).join(""), "hi");
  assert.deepEqual(typed.filter(e => e.t === "key"), [{ t: "key", k: "Enter", mods: [] }, { t: "key", k: "c", mods: [process.platform === "darwin" ? "meta" : "ctrl"] }]);
  assert.equal(await page.evaluate(`document.getElementById("main").classList.contains("screen-open")`), true, "Enter didn't send a chat message or leave");
  // the wheel scrolls there
  await page.send("Input.dispatchMouseEvent", { type: "mouseWheel", ...at(0.5, 0.5), deltaX: 0, deltaY: 120 });
  await until(async () => done().some(e => e.t === "scroll" && e.dy === 3), "the scroll");

  // back to the chat, and the switch in Settings turns it off
  await page.evaluate(`document.getElementById("scClose").click()`);
  assert.equal(await page.evaluate(`document.getElementById("screen").hidden && !document.getElementById("main").classList.contains("screen-open")`), true);
});


test("on the computer Remote would show, it says so and shows nothing: the page's invisible mark is in a window title there", async t => {
  const { site, pc, done } = await boot(t);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const tag = "​‌‍⁠​‌‍⁠";
  const ask = extra => site.asOwner("/api/screen/frame", { method: "POST", body: JSON.stringify({ w: 1280, tag, ...extra }) });
  assert.equal((await ask()).status, 200, "no window here has it");
  writeFileSync(join(pc.dir, "screen-windows.txt"), `Remote${tag} · Test Site - Google Chrome\nTerminal\n`);
  // looked for on every picture for the first few seconds of a mark
  const r = await ask();
  assert.equal(r.status, 409);
  const j = await r.json();
  assert.equal(j.code, "same_computer");
  assert.match(j.error, /This is the computer Test Site runs on/);
  assert.equal((await site.post("/api/screen/input", { events: [{ t: "move", x: 0.5, y: 0.5 }], tag })).body.code, "same_computer");
  assert.deepEqual(done(), [], "nothing was done to this computer");
  // a mark that isn't one is ignored, and another device's mark isn't in a title here
  assert.equal((await ask({ tag: "<script>" })).status, 200);
  assert.equal((await ask({ tag: "​".repeat(8) })).status, 200);
});

test("in a browser on the same computer, Remote explains why it won't show the screen", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, pc } = await boot(t);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const page = await openPage(site.origin + "/", { width: 1280, height: 800 });
  t.after(() => page.close());
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`location.reload()`);
  await page.until(`document.getElementById("screenNav")`, "the sidebar");
  await page.evaluate(`document.getElementById("screenNav").click()`);
  const title = await page.until(`/^Remote[\\u200b\\u200c\\u200d\\u2060]{12} · /.test(document.title) && document.title`, "the marked title");
  // this computer's window list now has that title in it, as the browser's window would
  writeFileSync(join(pc.dir, "screen-windows.txt"), `${title} - Chromium\n`);
  await page.until(`/This is the computer Test Site runs on/.test(document.getElementById("scMsg").innerText) && document.getElementById("scImg").hidden`, "the explanation");
  await page.evaluate(`document.getElementById("scClose").click()`);
  assert.doesNotMatch(await page.evaluate(`document.title`), /[​‌‍⁠]/, "the mark goes with Remote");
});

test("on a phone, Remote asks to be turned sideways, then fills the whole screen", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site } = await boot(t);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const page = await openPage(site.origin + "/", { width: 390, height: 844 });
  t.after(() => page.close());
  await page.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`location.reload()`);
  await page.until(`document.getElementById("screenNav") && matchMedia("(pointer: coarse)").matches`, "the page, on a phone");
  await page.evaluate(`document.getElementById("screenNav").click()`);
  await page.until(`!document.getElementById("scTurn").hidden`, "the turn-your-phone prompt");
  assert.match(await page.evaluate(`document.getElementById("scTurn").innerText`), /Turn your phone sideways/);
  assert.equal(await page.evaluate(`document.getElementById("scImg").hidden`), true, "no screen while it's upright");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } });
  await page.until(`document.getElementById("screen").classList.contains("phone-full") && !document.getElementById("scImg").hidden`, "the screen, sideways");
  const fill = await page.evaluate(`(() => { const s = document.getElementById("screen").getBoundingClientRect(); const i = document.getElementById("scImg").getBoundingClientRect(); return { sw: s.width, sh: s.height, iw: i.width, ih: i.height, vw: innerWidth, vh: innerHeight, head: getComputedStyle(document.querySelector(".sc-head")).display }; })()`);
  assert.deepEqual([fill.sw, fill.sh], [fill.vw, fill.vh], "the whole screen");
  assert.ok(Math.abs(fill.ih - fill.vh) <= 1 || Math.abs(fill.iw - fill.vw) <= 1, JSON.stringify(fill));
  assert.equal(fill.head, "none", "no header taking room");
  assert.equal(await page.evaluate(`getComputedStyle(document.getElementById("scFloat")).display`), "flex", "the keyboard and close buttons float on top");
  // turned upright again, it asks again; and the close button goes back to the chat
  await page.send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "portraitPrimary", angle: 0 } });
  await page.until(`!document.getElementById("screen").classList.contains("phone-full") && !document.getElementById("scTurn").hidden`, "the prompt again");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } });
  await page.until(`document.getElementById("screen").classList.contains("phone-full")`, "sideways again");
  await page.evaluate(`document.querySelector('#scFloat [data-scf="close"]').click()`);
  assert.equal(await page.evaluate(`document.getElementById("screen").hidden && !document.getElementById("screen").classList.contains("phone-full")`), true);
});
