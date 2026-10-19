// Staying up: the program runs under a small watcher, which starts it again when it's ended without being asked to, and
// takes it down with it when it's stopped.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";

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
// the program the watcher started: its child in the process table
function childOf(pid) {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const stat = readFileSync(`/proc/${d}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      if (ppid === pid && !/\) Z /.test(stat) && readFileSync(`/proc/${d}/cmdline`, "utf8").includes("agent.mjs")) return Number(d);
    } catch {}
  }
  return 0;
}

test("ended without being asked to, the program is started again and comes back online; stopped, it all goes", { skip: process.platform !== "linux" && "reads /proc" }, async t => {
  const site = await startSite();
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  const watcher = pc.startAgent();
  t.after(async () => {
    watcher.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  const online = () => site.api("/api/state").then(r => r.body.agent.online);
  await until(async () => (await online()) && pc.log().includes("Connected. Open"), "the computer online");
  assert.equal(pc.pid(), watcher.pid, "the watcher holds the pid file");
  const first = await until(async () => childOf(watcher.pid), "the program under the watcher");

  // the computer ends it outright (out of memory, say)
  process.kill(first, "SIGKILL");
  await until(async () => /stopped unexpectedly \(ended by the computer, SIGKILL\)\. Starting it again\./.test(pc.log()), "the restart in the log");
  const second = await until(async () => { const c = childOf(watcher.pid); return c && c !== first && c; }, "a new program");
  await until(async () => (await online()) && pc.log().split("Connected. Open").length > 2, "back online");

  // stopped on purpose: the program goes, the watcher goes, and nothing starts again
  process.kill(watcher.pid, "SIGTERM");
  await until(async () => !pc.alive(second) && !pc.alive(watcher.pid), "both to end", 15000);
  assert.ok(!existsSync(join(pc.dir, "agent.pid")), "the pid file is gone");
  assert.doesNotMatch(pc.log().split("Connected. Open").pop(), /stopped unexpectedly/);
});

test("when the watcher itself is ended outright, the program doesn't carry on without it", { skip: process.platform !== "linux" && "reads /proc" }, async t => {
  const site = await startSite();
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  const watcher = pc.startAgent();
  t.after(async () => {
    pc.cleanup();
    await site.stop();
  });
  await until(() => site.api("/api/state").then(r => r.body.agent.online), "the computer online");
  const child = await until(async () => childOf(watcher.pid), "the program under the watcher");
  watcher.kill("SIGKILL");
  await until(async () => !pc.alive(child), "the program to end", 15000);
});
