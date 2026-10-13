// The free plan's helpers on the systems they're for: on macOS, JavaScript for Automation (agent/app-mac.js and the Stop bar,
// agent/app-mac-bar.js); on Windows, Windows PowerShell 5.1 compiling the C# in agent/app-win.ps1 and agent/app-win-bar.ps1.
// Run by CI on a Mac and a Windows machine: each helper starts, says it's ready, and answers over its lines of JSON. There's
// no Claude app on those machines, so the answers are the ones for an app that isn't there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const AGENT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent");
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
const skip = !MAC && !WIN && "only on macOS and Windows";

function start(file, env = {}) {
  const [cmd, args] = WIN ? ["powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", file]] : ["/usr/bin/osascript", ["-l", "JavaScript", file]];
  const p = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env }, windowsHide: true });
  let err = "";
  p.stderr.on("data", d => (err += d));
  const lines = [];
  const waiting = [];
  createInterface({ input: p.stdout }).on("line", l => {
    const w = waiting.shift();
    if (w) w(l);
    else lines.push(l);
  });
  const next = (ms = 120000) =>
    new Promise((resolve, reject) => {
      if (lines.length) return resolve(lines.shift());
      const timer = setTimeout(() => reject(new Error("no answer; stderr: " + err)), ms);
      waiting.push(l => {
        clearTimeout(timer);
        resolve(l);
      });
    });
  const exited = new Promise(r => p.on("exit", code => r(code)));
  return { p, next, exited, err: () => err };
}

test("the helper that works the Claude app starts, and answers in lines of JSON", { skip, timeout: 240000 }, async () => {
  const h = start(join(AGENT, WIN ? "app-win.ps1" : "app-mac.js"));
  const hello = JSON.parse(await h.next());
  assert.equal(hello.id, 0, h.err());
  assert.equal(hello.ready, true);
  const ask = async (req, id) => {
    h.p.stdin.write(JSON.stringify({ id, ...req }) + "\n");
    const r = JSON.parse(await h.next());
    assert.equal(r.id, id);
    return r;
  };
  const ping = await ask({ cmd: "ping" }, 1);
  assert.equal(ping.ok, true, JSON.stringify(ping));
  assert.equal(ping.version, 1);
  // there's no Claude app here
  const app = await ask({ cmd: "app", info: {} }, 2);
  assert.equal(app.ok, true, JSON.stringify(app));
  assert.equal(app.running, false);
  const scan = await ask({ cmd: "scan", queries: { send: { role: "button", name: "^send", last: true } } }, 3);
  assert.equal(scan.ok, false);
  assert.match(scan.error, /^(not-trusted|not-running|no-window|no-page)$/, JSON.stringify(scan));
  const idle = await ask({ cmd: "idle" }, 4);
  assert.equal(idle.ok, true, JSON.stringify(idle));
  assert.equal(typeof idle.seconds, "number");
  // anything else, a word that isn't ASCII, and a request it doesn't know
  const odd = await ask({ cmd: "nope", text: "héllo \u{1f44b}" }, 5);
  assert.equal(odd.ok, false);
  assert.equal(odd.error, "unknown-cmd");
  h.p.stdin.end();
  assert.equal(await h.exited, 0, h.err());
});

// The bar needs a desktop to show on, which a CI machine may not have: CI runs this one on its own and reports it either way.
test("the Stop bar shows, changes what it says, and goes when told to", { skip, timeout: 240000 }, async () => {
  const b = start(join(AGENT, WIN ? "app-win-bar.ps1" : "app-mac-bar.js"), { CLAUDECONNECT_BAR: JSON.stringify({ text: "Test Site is using the Claude app", label: "Stop Test Site", parent: process.pid }) });
  assert.equal(await b.next(), "ready", b.err());
  b.p.stdin.write('text {"text": "Test Site is reading the reply", "label": "Stop"}\n');
  await new Promise(r => setTimeout(r, 500));
  b.p.stdin.write("quit\n");
  assert.equal(await b.exited, 0, b.err());
});
