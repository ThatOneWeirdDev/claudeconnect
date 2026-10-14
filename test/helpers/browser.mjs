// A headless Chromium for tests that need the page itself running: started with its debugging connection, driven over the
// Chrome DevTools Protocol with Node's own WebSocket, so the tests need nothing installed beyond a Chromium.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Starts Chromium and waits for its debugging connection. A cold start on a busy CI machine can be slow, so it gets a while
// and a second go; a Chromium that didn't come up is always stopped, since a leftover one would keep the test file running.
async function launch(chrome, width, height) {
  for (let attempt = 1; ; attempt++) {
    const profile = mkdtempSync(join(tmpdir(), "cc-browser-"));
    const proc = spawn(chrome, ["--headless=new", "--no-sandbox", "--disable-gpu", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--disable-component-update", "--disable-sync", "--no-pings", `--window-size=${width},${height}`, "about:blank"], { stdio: "ignore" });
    proc.unref();
    let exited = false;
    proc.on("exit", () => (exited = true));
    let port = 0;
    let target = null;
    for (let i = 0; i < 300 && !port && !exited; i++) {
      try {
        port = Number(readFileSync(join(profile, "DevToolsActivePort"), "utf8").split("\n")[0]) || 0;
      } catch {}
      if (!port) await sleep(100);
    }
    for (let i = 0; port && i < 100 && !target; i++) {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json()).catch(() => []);
      target = list.find(t => t.type === "page");
      if (!target) await sleep(100);
    }
    if (target) return { proc, profile, target };
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    if (attempt >= 2) throw new Error("Chromium didn't open its debugging port");
  }
}

export async function openPage(url, { width = 1280, height = 800, dark = false } = {}) {
  const chrome = await findChromium();
  if (!chrome) return null;
  const { proc, profile, target } = await launch(chrome, width, height);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  try {
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error("couldn't connect to Chromium"));
    });
  } catch (e) {
    proc.kill("SIGKILL");
    rmSync(profile, { recursive: true, force: true });
    throw e;
  }
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

// A Chromium to run, from CHROME_PATH, the one Playwright keeps, or the system's.
export async function findChromium() {
  const { existsSync, readdirSync } = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  try {
    for (const d of readdirSync("/opt/pw-browsers").filter(n => /^chromium-\d+$/.test(n)).sort().reverse()) {
      const p = `/opt/pw-browsers/${d}/chrome-linux/chrome`;
      if (existsSync(p)) return p;
    }
  } catch {}
  for (const n of ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser"]) {
    const r = spawnSync("which", [n], { encoding: "utf8" });
    const p = String(r.stdout || "").trim();
    if (r.status === 0 && p) return p;
  }
  return "";
}
