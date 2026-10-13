// The real driver (agent/app-os.mjs) and the real helpers, through the real accessibility features of macOS or Windows,
// against a real Chromium showing a small stand-in for claude.ai (test/platform/page.html). Run by CI on a Mac and a
// Windows machine. On a Mac it needs the Accessibility permission, which a CI machine may not give: then it says so and skips.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAC = process.platform === "darwin";
const WIN = process.platform === "win32";
const sleep = ms => new Promise(r => setTimeout(r, ms));

function browser() {
  if (WIN) {
    const pf = process.env["ProgramFiles"] || "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    for (const [exe, name] of [[join(pf, "Google", "Chrome", "Application", "chrome.exe"), "chrome"], [join(pf86, "Google", "Chrome", "Application", "chrome.exe"), "chrome"], [join(pf86, "Microsoft", "Edge", "Application", "msedge.exe"), "msedge"], [join(pf, "Microsoft", "Edge", "Application", "msedge.exe"), "msedge"]]) if (existsSync(exe)) return { exe, process: name };
  }
  if (MAC) {
    for (const [app, bundle] of [["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "com.google.Chrome"], ["/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge", "com.microsoft.edgemac"], ["/Applications/Chromium.app/Contents/MacOS/Chromium", "org.chromium.Chromium"]]) if (existsSync(app)) return { exe: app, bundle };
  }
  return null;
}
const B = browser();

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn().catch(() => null);
    if (v) return v;
    if (Date.now() > end) throw new Error("timed out waiting for " + what);
    await sleep(300);
  }
}

test("the driver works a Chromium page through the system's accessibility: models, thinking, typing, sending and the reply", { skip: (!MAC && !WIN && "only on macOS and Windows") || (!B && "needs Chrome or Edge"), timeout: 300000 }, async t => {
  if (MAC) {
    process.env.CLAUDECONNECT_APP_BUNDLE = B.bundle;
    const r = spawnSync("/usr/bin/osascript", ["-l", "JavaScript", join(HERE, "..", "..", "agent", "app-mac.js")], { input: '{"id":1,"cmd":"ping"}\n', encoding: "utf8", timeout: 60000 });
    const ping = String(r.stdout || "").split("\n").map(l => { try { return JSON.parse(l); } catch { return null; } }).find(j => j && j.id === 1);
    if (!ping || !ping.trusted) return t.skip("this Mac hasn't given the Accessibility permission to the program running the tests");
  }
  const profile = mkdtempSync(join(tmpdir(), "cc-platform-"));
  const page = pathToFileURL(join(HERE, "page.html")).href;
  const chrome = spawn(B.exe, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--force-renderer-accessibility", "--window-size=1100,800", `--app=${page}`], { stdio: "ignore", detached: !WIN });
  t.after(async () => {
    try {
      if (WIN) spawnSync("taskkill", ["/pid", String(chrome.pid), "/t", "/f"]);
      else process.kill(-chrome.pid);
    } catch {}
    await sleep(1000);
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {}
  });
  await sleep(4000);

  const { osDriver } = await import("../../agent/app-os.mjs");
  const said = [];
  const D = osDriver({ cfg: {}, saveConfig: () => {}, log: (...a) => console.log("[driver]", ...a), NAME: "Test Site", find: () => ({ how: "test", process: B.process || "" }) });
  t.after(() => D.close());
  await until(async () => {
    await D.start(s => said.push(s));
    return true;
  }, "the driver to find the page", 90000);
  const p = await D.open(null);
  assert.ok(p && p.composer, "the message box is found: " + JSON.stringify(p));

  const m = await D.models();
  console.log("models:", JSON.stringify(m));
  assert.deepEqual(m.models.map(x => [x.name, x.locked]), [["Sonnet 5.5", false], ["Haiku 5.5", false], ["Opus 5.5", true]]);
  assert.equal(m.thinking, false);
  assert.equal(m.current, "Sonnet 5.5");
  assert.equal(await D.setModel("Haiku 5.5"), true);
  assert.equal(await until(async () => ((await D.current()) === "Haiku 5.5" ? "yes" : null), "the model to change", 10000), "yes");
  assert.equal(await D.setThinking(true), true);

  const before = (await D.probe()).users;
  assert.equal(await D.type("hello there"), true, "the message is in the box");
  const sent = await D.send(before);
  assert.deepEqual(sent, { ok: true });
  let md = "";
  await until(async () => {
    const r = await D.reply();
    const pr = await D.probe();
    md = r ? r.md : "";
    return !pr.streaming && /apples/.test(md) ? true : null;
  }, "the reply", 60000);
  console.log("reply as read:\n" + md);
  assert.match(md, /You said: \*\*hello there\*\*/);
  assert.match(md, /Model: Haiku 5\.5, thinking on/);
  assert.match(md, /```python\nprint\("hi"\)\n```/);
  assert.match(md, /\| apples \| 3 \|/);
  assert.match(md, /\[this\]\(https:\/\/example\.com\/\)/);
  assert.equal((await D.probe()).users, before + 1);
});
