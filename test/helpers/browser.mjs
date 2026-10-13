// A headless Chromium for tests that need the page itself running: started with its debugging connection, driven over the
// Chrome DevTools Protocol with Node's own WebSocket, so the tests need nothing installed beyond a Chromium.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { findChromium } from "./fake-claude-app.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function openPage(url, { width = 1280, height = 800, dark = false } = {}) {
  const chrome = await findChromium();
  if (!chrome) return null;
  const profile = mkdtempSync(join(tmpdir(), "cc-browser-"));
  const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-pings", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
  let port = 0;
  for (let i = 0; i < 100 && !port; i++) {
    try {
      port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || 0;
    } catch {}
    if (!port) await sleep(100);
  }
  if (!port) throw new Error("Chromium didn't open its debugging port");
  let target = null;
  for (let i = 0; i < 50 && !target; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    target = list.find(t => t.type === "page");
    if (!target) await sleep(100);
  }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  if (dark) await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
  await send("Page.enable");
  // runs an expression in the page and gives back its value (a promise is waited for)
  const evaluate = async expression => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text);
    return r.result.value;
  };
  const goto = async to => {
    await send("Page.navigate", { url: to });
    for (let i = 0; i < 100; i++) {
      if ((await evaluate("document.readyState").catch(() => "")) === "complete") return;
      await sleep(100);
    }
  };
  // waits until an expression in the page is truthy, and gives back its value
  const until = async (expression, what = expression, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const v = await evaluate(expression).catch(() => null);
      if (v) return v;
      await sleep(100);
    }
    throw new Error("timed out waiting for " + what);
  };
  const close = async () => {
    try {
      ws.close();
    } catch {}
    proc.kill("SIGKILL");
    await sleep(200);
    rmSync(profile, { recursive: true, force: true });
  };
  await goto(url);
  return { send, evaluate, until, goto, close };
}

// Attaches to a page in a Chromium that's already running with its debugging port (the stand-in Claude app, say), as a second
// connection next to the agent's. Gives back the same send and evaluate, and a way to click like a person: at a spot on screen.
export async function attachTo(port, match = () => true) {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
    target = list.find(t => t.type === "page" && match(t));
    if (!target) await sleep(100);
  }
  if (!target) throw new Error("no page on port " + port);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  let id = 0;
  const waiting = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && waiting.has(m.id)) {
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      m.error ? w.reject(new Error(m.error.message)) : w.resolve(m.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const n = ++id;
      waiting.set(n, { resolve, reject });
      ws.send(JSON.stringify({ id: n, method, params }));
    });
  // the on-screen box of the first element (in any shadow root, closed ones too) whose text is `text`
  const boxOf = async text => {
    const { root } = await send("DOM.getDocument", { depth: -1, pierce: true });
    let hit = null;
    const walk = n => {
      if (hit || !n) return;
      if (n.nodeType === 1 && (n.children || []).some(c => c.nodeType === 3 && c.nodeValue.trim() === text)) hit = n;
      for (const c of [...(n.children || []), ...(n.shadowRoots || [])]) walk(c);
    };
    walk(root);
    if (!hit) return null;
    const { model } = await send("DOM.getBoxModel", { nodeId: hit.nodeId });
    const q = model.border;
    return { x: (q[0] + q[4]) / 2, y: (q[1] + q[5]) / 2 };
  };
  const clickAt = async ({ x, y }) => {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  };
  return { send, boxOf, clickAt, close: () => ws.close() };
}
