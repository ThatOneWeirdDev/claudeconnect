// `<command> edit`, answered in a real terminal: each setting with a y/n, a summary, then the same in-place redeploy the
// site's Settings do. Linux only (it uses `script` for the terminal), which is where the tests run.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const hasScript = spawnSync("script", ["--version"]).status === 0;

// Runs a command in a terminal and answers each question when it's asked: [pattern, answer] pairs, in order.
function converse(cmd, env, answers, ms = 60000) {
  return new Promise(resolve => {
    const child = spawn("script", ["-qfec", cmd, "/dev/null"], { env, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let next = 0;
    const onData = d => {
      out += d;
      while (next < answers.length && answers[next][0].test(out.slice(answers[next].from || 0))) {
        const [, answer] = answers[next];
        answers[next + 1] && (answers[next + 1].from = out.length);
        child.stdin.write(answer + "\r");
        next++;
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("close", status => {
      clearTimeout(timer);
      resolve({ status, out, asked: next });
    });
  });
}

test("edit asks about each setting, shows what will change, and saves it in place", { skip: !hasScript && "needs `script`" }, async t => {
  const site = await startSite({ appVersion: "1.7.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9", oldVersion: "1.7.0" });
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  for (let i = 0; i < 100 && !(await site.api("/api/state")).body.agent.online; i++) await sleep(150);
  const cmd = `"${process.execPath}" "${join(pc.dir, "agent.mjs")}" edit`;
  const r = await converse(cmd, pc.env, [
    [/Change the name\? Now: Test Site\. \[y\/N\]/, "y"],
    [/New name:/, "Better Site"],
    [/Change the logo\?/, ""],
    [/Change the tab icon\?/, "n"],
    [/Show Fable 5\.1 in the model picker\? It's hidden now\. \[y\/N\]/, "y"],
    [/when you log in to this computer\?/, ""],
    [/usage credit balance/, "y"],
    [/name: Better Site[\s\S]*Fable 5\.1: shown[\s\S]*usage credit balance: shown[\s\S]*Save these changes\? \[Y\/n\]/, ""]
  ]);
  assert.equal(r.asked, 8, r.out);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /Updating the site[\s\S]*Restarting/);
  const deploys = pc.deploys();
  assert.equal(deploys.length, 1);
  assert.equal(deploys[0].vars.SITE_NAME, "Better Site");
  assert.equal(deploys[0].vars.SHOW_FABLE, "1");
  assert.equal(deploys[0].vars.COMMAND, "TestConnect", "the command stays the same");
  const cfg = JSON.parse(readFileSync(join(pc.dir, "config.json"), "utf8"));
  assert.deepEqual([cfg.displayName, cfg.fable, cfg.credits], ["Better Site", true, true]);

  // saying no to everything changes nothing
  const none = await converse(cmd, pc.env, [[/Change the name\?/, ""], [/logo/, ""], [/tab icon/, ""], [/Fable/, ""], [/log in/, ""], [/usage credit balance/, ""]]);
  assert.equal(none.status, 0, none.out);
  assert.match(none.out, /Nothing changed\./);
  assert.equal(pc.deploys().length, 1);
});
