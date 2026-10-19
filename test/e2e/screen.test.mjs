// Remote: the computer's screen on the site, live, and its mouse and keyboard from there. The real agent runs with a stand-in
// screen (CLAUDECONNECT_SCREEN=fake:…): its pictures in turn, and what's done over it written to screen-input.jsonl.
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
const OTHER = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "screen2.jpg");
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

async function boot(t, pictures = [PICTURE]) {
  const site = await startSite();
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  pc.env.CLAUDECONNECT_SCREEN = "fake:" + pictures.join(",");
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
// A page looking at Remote, played by the test: the live connection as the page opens it, with its own invisible mark. It
// says it has each picture as it comes, unless told not to.
const mark = () => Array.from({ length: 12 }, () => "\u200b\u200c\u200d\u2060"[Math.floor(Math.random() * 4)]).join("");
async function viewer(t, site, { origin = site.origin, w = 1280, tag = mark(), ack = true } = {}) {
  const res = await site.mf.dispatchFetch(site.origin + "/api/screen/live", { headers: { upgrade: "websocket", origin } });
  if (!res.webSocket) return { status: res.status };
  const ws = res.webSocket;
  ws.accept();
  const v = { status: 101, pictures: [], said: [], ack, send: o => ws.send(JSON.stringify(o)), close: () => ws.close() };
  ws.addEventListener("message", e => {
    if (typeof e.data === "string") return v.said.push(JSON.parse(e.data));
    v.pictures.push(Buffer.from(e.data));
    if (v.ack) ws.send('{"t":"ack"}');
  });
  t.after(() => { try { ws.close(); } catch {} });
  v.send({ t: "hello", w, tag });
  return v;
}

test("the screen is only shown once Remote is turned on, live to the page looking, and what's done over it reaches the computer, cleaned up", async t => {
  const { site, done } = await boot(t);
  const state = (await site.api("/api/state")).body;
  assert.equal(state.agent.screen, true, "this computer can do it");
  assert.equal(state.agent.computer.screen, false, "off until it's turned on");
  // only from the site's own pages
  assert.equal((await viewer(t, site, { origin: "https://evil.example" })).status, 403);
  assert.equal((await site.api("/api/screen/live")).status, 426);
  const v = await viewer(t, site);
  assert.equal(v.status, 101);
  await until(async () => v.said.some(m => m.code === "off"), "Remote is off");
  assert.deepEqual(v.said.find(m => m.code === "off"), { t: "status", code: "off", error: "Remote is off on this computer.", os: process.platform });
  v.send({ t: "input", events: [{ t: "move", x: 0.5, y: 0.5 }] });
  await sleep(300);
  assert.deepEqual(v.pictures, []);
  assert.deepEqual(done(), [], "nothing was done while it was off");

  const on = await site.post("/api/computer", { screen: true });
  assert.equal(on.status, 200, on.text);
  assert.equal(on.body.computer.screen, true);
  await until(async () => v.pictures.length, "the screen");
  assert.deepEqual(v.pictures[0], readFileSync(PICTURE));
  await sleep(300);
  assert.equal(v.pictures.length, 1, "a screen that doesn't change is sent once");
  // someone else starting to look gets the picture there is, though nothing changed
  const second = await viewer(t, site);
  await until(async () => second.pictures.length, "the picture, for a second page");
  assert.deepEqual(second.pictures[0], readFileSync(PICTURE));
  second.close();

  v.send({
    t: "input",
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
  await until(async () => done().length, "what was done");
  assert.deepEqual(done(), [
    { t: "move", x: 0.25, y: 0.5 },
    { t: "down", x: 1, y: 0, b: 0, n: 2 },
    { t: "up", x: 0.5, y: 0.5, b: 2, n: 1 },
    { t: "scroll", x: 0.5, y: 0.5, dy: 3, dx: 0 },
    { t: "text", s: "héllo\nthere" },
    { t: "key", k: "c", mods: ["ctrl"] }
  ]);

  // turned off again, nothing more is shown, and the page is told
  v.said.length = 0;
  assert.equal((await site.post("/api/computer", { screen: false })).body.computer.screen, false);
  await until(async () => v.said.some(m => m.code === "off"), "Remote is off again");
});

test("pictures come one after another as fast as the page takes them, never more than two on their way", async t => {
  const { site } = await boot(t, [PICTURE, OTHER]);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  // a page that keeps up gets a changing screen live: many pictures a second, each one as the computer took it
  const v = await viewer(t, site);
  await until(async () => v.pictures.length, "the first");
  let from = v.pictures.length;
  await sleep(2000);
  const rate = (v.pictures.length - from) / 2;
  assert.ok(rate >= 10, `${rate} pictures a second`);
  for (const p of v.pictures.slice(0, 4)) assert.ok(p.equals(readFileSync(PICTURE)) || p.equals(readFileSync(OTHER)));
  // a slow page looking at the same time: two, then nothing until it says it has them, and the other one doesn't wait for it
  const slow = await viewer(t, site, { ack: false });
  await until(async () => slow.pictures.length >= 2, "the first two");
  from = v.pictures.length;
  await sleep(1000);
  assert.equal(slow.pictures.length, 2);
  assert.ok(v.pictures.length - from >= 10, `the other one had ${v.pictures.length - from}`);
  // once it has them, the newest one comes straight away
  slow.send({ t: "ack" });
  await until(async () => slow.pictures.length === 3, "the newest");
  slow.ack = true;
  slow.send({ t: "ack" });
  v.close();
  await until(async () => slow.pictures.length >= 15, "more, once it took them");
});

test("Remote in the sidebar: turned on from there, the screen shows live, and clicks, keys and the wheel go over", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, pc, done } = await boot(t, [PICTURE, OTHER]);
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
  await page.until(`(() => { const c = document.getElementById("scView"); return !c.hidden && c.width === 640; })()`, "the screen");
  await page.until(`/Live/.test(document.getElementById("scStatus").textContent)`, "Live");
  assert.equal((await site.api("/api/state")).body.agent.computer.screen, true);
  assert.equal(await page.evaluate(`document.getElementById("scHelpBtn")`), null, "no help button");
  // the screen keeps changing (two pictures in turn), and the page keeps drawing it
  const changes = await page.evaluate(`new Promise(done => {
    const c = document.getElementById("scView").getContext("2d");
    let last = "", n = 0;
    const end = Date.now() + 1500;
    (function look() {
      const px = c.getImageData(100, 100, 1, 1).data.join();
      if (px !== last) { n++; last = px; }
      if (Date.now() < end) setTimeout(look, 4);
      else done(n);
    })();
  })`);
  assert.ok(changes >= 10, `the picture changed ${changes} times in 1.5s`);

  // a click in the middle of the picture, where the picture is
  const box = await page.evaluate(`(() => { const r = document.getElementById("scView").getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; })()`);
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
  const other = await viewer(t, site, { tag: "​".repeat(8) });
  await until(async () => other.pictures.length, "the screen, where no window has the mark");
  other.close();
  writeFileSync(join(pc.dir, "screen-windows.txt"), `Remote${tag} · Test Site - Google Chrome\nTerminal\n`);
  const v = await viewer(t, site, { tag });
  v.send({ t: "input", events: [{ t: "move", x: 0.5, y: 0.5 }] });
  await until(async () => v.said.some(m => m.code === "same_computer"), "the refusal");
  assert.match(v.said.find(m => m.code === "same_computer").error, /This is the computer Test Site runs on/);
  await sleep(300);
  assert.deepEqual(v.pictures, [], "nothing was shown");
  assert.deepEqual(done(), [], "nothing was done to this computer");
  v.close();
  // a mark that isn't one is ignored
  const odd = await viewer(t, site, { tag: "<script>" });
  await until(async () => odd.pictures.length, "the screen, for a mark that isn't one");
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
  await page.until(`/This is the computer Test Site runs on/.test(document.getElementById("scMsg").innerText) && document.getElementById("scView").hidden`, "the explanation", 30000);
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
  assert.equal(await page.evaluate(`document.getElementById("scView").hidden`), true, "no screen while it's upright");
  await page.send("Emulation.setDeviceMetricsOverride", { width: 844, height: 390, deviceScaleFactor: 2, mobile: true, screenOrientation: { type: "landscapePrimary", angle: 90 } });
  await page.until(`document.getElementById("screen").classList.contains("phone-full") && !document.getElementById("scView").hidden`, "the screen, sideways");
  const fill = await page.evaluate(`(() => { const s = document.getElementById("screen").getBoundingClientRect(); const i = document.getElementById("scView").getBoundingClientRect(); return { sw: s.width, sh: s.height, iw: i.width, ih: i.height, vw: innerWidth, vh: innerHeight, head: getComputedStyle(document.querySelector(".sc-head")).display }; })()`);
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
