// Remote: the computer's screen on the site, live, and its mouse and keyboard from there. The real agent runs with a stand-in
// screen (CLAUDECONNECT_SCREEN=fake:…): its pictures in turn, and what's done over it written to screen-input.jsonl.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { startSite, connectAgent } from "../helpers/site.mjs";
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

async function boot(t, pictures = [PICTURE], env = {}) {
  const site = await startSite();
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  pc.env.CLAUDECONNECT_SCREEN = "fake:" + pictures.join(",");
  Object.assign(pc.env, env);
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
// A page looking at Remote, played by the test: the live connection as the page opens it, with its own invisible mark, the
// pictures a second it wants and whether it plays the sound. It says it has each picture as it comes, unless told not to;
// pieces of sound (they start with "CCAU") are kept apart, with when each came.
const mark = () => Array.from({ length: 12 }, () => "\u200b\u200c\u200d\u2060"[Math.floor(Math.random() * 4)]).join("");
const isSound = b => b.length >= 12 && b.subarray(0, 4).toString() === "CCAU";
async function viewer(t, site, { origin = site.origin, w = 1280, tag = mark(), ack = true, fps, sound } = {}) {
  const res = await site.mf.dispatchFetch(site.origin + "/api/screen/live", { headers: { upgrade: "websocket", origin } });
  if (!res.webSocket) return { status: res.status };
  const ws = res.webSocket;
  ws.accept();
  const v = { status: 101, pictures: [], sound: [], said: [], ack, send: o => ws.send(JSON.stringify(o)), close: () => ws.close() };
  ws.addEventListener("message", e => {
    if (typeof e.data === "string") return v.said.push(JSON.parse(e.data));
    const b = Buffer.from(e.data);
    if (isSound(b)) return v.sound.push(b);
    v.pictures.push(b);
    if (v.ack) ws.send('{"t":"ack"}');
  });
  t.after(() => { try { ws.close(); } catch {} });
  v.send({ t: "hello", w, tag, ...(fps !== undefined ? { fps } : {}), ...(sound !== undefined ? { sound } : {}) });
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

test("the computer's sound comes as it plays, uncompressed, only to pages that want it, and never waits on the pictures", async t => {
  const { site } = await boot(t, [PICTURE, OTHER]);
  const state = (await site.api("/api/state")).body;
  assert.equal(state.agent.screenSound, true, "this computer can send its sound");
  assert.equal(state.agent.screenFps, true, "and take the rate from the page");
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  // a page with its sound on that never says it has a picture: two pictures, then none, but the sound keeps coming
  const ears = await viewer(t, site, { sound: true, ack: false });
  const quiet = await viewer(t, site);
  await until(async () => ears.sound.length >= 3, "the sound");
  const from = ears.sound.length;
  await sleep(1000);
  const pieces = ears.sound.length - from;
  assert.ok(pieces >= 15 && pieces <= 35, `${pieces} pieces of 40 ms in a second`);
  assert.equal(ears.pictures.length, 2, "the pictures wait for it; the sound doesn't");
  for (const p of ears.sound.slice(0, 5)) {
    assert.equal(p.readUInt32LE(4), 48000, "48 kHz");
    assert.equal(p[8], 2, "two channels");
    assert.equal(p[9], 1, "16-bit PCM, not compressed");
    assert.equal(p.length, 12 + 1920 * 4, "40 ms of it");
  }
  assert.ok(quiet.pictures.length > 5, "the other page still gets pictures");
  assert.equal(quiet.sound.length, 0, "and no sound, since it didn't ask");
  // turned off, it stops, for everyone (no one else wanted it), and on again it comes back
  ears.send({ t: "sound", sound: false });
  await sleep(400);
  const stopped = ears.sound.length;
  await sleep(600);
  assert.equal(ears.sound.length, stopped, "no more once it's off");
  quiet.send({ t: "sound", sound: true });
  await until(async () => quiet.sound.length >= 3, "the sound, for the page that asked now");
  assert.equal(ears.sound.length, stopped, "only to the one that wants it");
});

test("a computer that can't send its sound says why, and the pictures carry on", async t => {
  const { site } = await boot(t, [PICTURE, OTHER], { CLAUDECONNECT_SOUND: "none" });
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const v = await viewer(t, site, { sound: true });
  const said = await until(async () => v.said.find(m => m.code === "sound"), "why there's no sound");
  assert.match(said.error, /no sound/);
  const n = v.pictures.length;
  await until(async () => v.pictures.length > n + 5, "more pictures");
  assert.equal(v.sound.length, 0);
});

test("each page gets the pictures a second it picked, and the computer streams at the highest asked for", async t => {
  const { site } = await boot(t, [PICTURE, OTHER]);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const count = async (v, ms = 2000) => {
    const from = v.pictures.length;
    await sleep(ms);
    return ((v.pictures.length - from) * 1000) / ms;
  };
  const slow = await viewer(t, site, { fps: 5 });
  await until(async () => slow.pictures.length, "the first picture");
  let rate = await count(slow);
  assert.ok(rate >= 3 && rate <= 6.5, `${rate} a second, asked for 5`);
  // another page asks for more: it gets it, and the first still gets its 5
  const fast = await viewer(t, site, { fps: 30 });
  await until(async () => fast.pictures.length, "the first picture, for the fast one");
  const [a, b] = await Promise.all([count(slow), count(fast)]);
  assert.ok(a >= 3 && a <= 6.5, `${a} a second for the page that asked for 5`);
  assert.ok(b >= 15, `${b} a second for the page that asked for 30`);
  // changed from the page: the rate follows
  fast.close();
  slow.send({ t: "fps", fps: 15 });
  await sleep(500);
  rate = await count(slow);
  assert.ok(rate >= 10 && rate <= 17, `${rate} a second, asked for 15`);
  // anything that isn't a rate is 30; more than 60 is 60
  slow.send({ t: "fps", fps: "lots" });
  await sleep(500);
  rate = await count(slow);
  assert.ok(rate >= 18, `${rate} a second, for a rate that wasn't one`);
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


test("on the Remote page, the pictures a second are picked from a list, and the sound button turns the sound on and off", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site } = await boot(t, [PICTURE, OTHER]);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const page = await openPage(site.origin + "/", { width: 1280, height: 800 });
  t.after(() => page.close());
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`location.reload()`);
  await page.until(`document.getElementById("screenNav")`, "the sidebar");
  await page.evaluate(`document.getElementById("screenNav").click()`);
  await page.until(`!document.getElementById("scView").hidden`, "the screen");
  assert.equal(await page.evaluate(`!document.getElementById("scFps").hidden && document.getElementById("scFps").value`), "30", "30 a second to start with");
  assert.equal(await page.evaluate(`!document.getElementById("scSound").hidden && document.getElementById("scSound").getAttribute("aria-pressed")`), "true", "sound on to start with");
  // what the page draws, counted: a changing screen at 30, then at 5 once that's picked
  const changes = ms => page.evaluate(`new Promise(done => {
    const c = document.getElementById("scView").getContext("2d");
    let last = "", n = 0;
    const end = Date.now() + ${ms};
    (function look() {
      const px = c.getImageData(100, 100, 1, 1).data.join();
      if (px !== last) { n++; last = px; }
      if (Date.now() < end) setTimeout(look, 4);
      else done(n);
    })();
  })`);
  assert.ok((await changes(1500)) >= 15, "many a second at 30");
  await page.until(`/Live · \\d+ fps/.test(document.getElementById("scStatus").textContent)`, "the rate in the status");
  await page.evaluate(`(() => { const s = document.getElementById("scFps"); s.value = "5"; s.dispatchEvent(new Event("change", { bubbles: true })); })()`);
  await page.until(`localStorage.getItem("gql.remoteFps") === "5"`, "the rate kept in this browser");
  await sleep(700);
  const slow = await changes(2000);
  assert.ok(slow >= 4 && slow <= 14, `${slow} changes in 2s, at 5 a second`);
  // the sound button: off, and on again (a real click, as browsers want before they play sound)
  const box = await page.evaluate(`(() => { const r = document.getElementById("scSound").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  const click = async () => {
    await page.send("Input.dispatchMouseEvent", { type: "mousePressed", x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 1 });
    await page.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: box.x, y: box.y, button: "left", clickCount: 1, buttons: 0 });
  };
  await click();
  await page.until(`document.getElementById("scSound").getAttribute("aria-pressed") === "false"`, "the sound off");
  await click();
  await page.until(`document.getElementById("scSound").getAttribute("aria-pressed") === "true"`, "the sound on again");
  // after a click the browser plays it: the status no longer asks for one
  await page.until(`!/click the screen for sound/.test(document.getElementById("scStatus").textContent)`, "the sound playing", 10000);
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

test("the page can have the computer report its screen permissions and request them again", async t => {
  const { site } = await boot(t);
  assert.equal((await site.post("/api/computer", { screen: true })).status, 200);
  const v = await viewer(t, site);
  await until(async () => v.pictures.length, "the screen");
  // just reading what's allowed
  v.said.length = 0;
  v.send({ t: "perms" });
  const perms = await until(async () => v.said.find(m => m.code === "perms"), "the permissions");
  assert.equal(perms.view, true);
  assert.equal(perms.control, true);
  assert.equal(perms.os, process.platform);
  // asking the computer to request them again: the stand-in allows both, so it says so
  v.said.length = 0;
  v.send({ t: "ask" });
  assert.equal((await until(async () => v.said.find(m => m.code === "perms"), "the permissions again")).view, true);
});

test("on a Mac with a permission off, Remote lists what's missing and offers to ask the Mac again", { skip: !CHROME && "needs a Chromium" }, async t => {
  const site = await startSite();
  await site.claim();
  t.after(() => site.stop());
  // a stand-in computer that can do Remote and has it on, but sends no pictures — so the "permission off" note stays up
  const agent = await connectAgent(site, { caps: ["update", "admin", "modes", "history", "screen", "screenlive", "computer"], computer: { screen: true } });
  t.after(() => agent.close());
  const page = await openPage(site.origin + "/", { width: 1280, height: 800 });
  t.after(() => page.close());
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  await page.evaluate(`location.reload()`);
  await page.until(`document.getElementById("screenNav")`, "the sidebar");
  await page.evaluate(`document.getElementById("screenNav").click()`);
  // the page opens the live connection and the computer is asked to start
  await agent.next(m => m.type === "screen_start", 10000);
  // the computer says Screen Recording isn't allowed yet, as a Mac would before it's turned on
  agent.send({ type: "screen_status", code: "need_perms", view: false, control: true, os: "darwin" });
  await page.until(`/Screen Recording/.test(document.getElementById("scMsg").innerText) && document.querySelector('[data-sc="ask"]')`, "the permission note");
  const txt = await page.evaluate(`document.getElementById("scMsg").innerText`);
  assert.match(txt, /Accessibility/);
  assert.match(txt, /on the Mac itself/);
  // asking the Mac again reaches the computer, and the button acknowledges so the person knows to approve there
  await page.evaluate(`document.querySelector('[data-sc="ask"]').click()`);
  await agent.next(m => m.type === "screen_ask", 10000);
  await page.until(`/approve on your Mac/.test(document.getElementById("scMsg").innerText)`, "the asked state");
});
