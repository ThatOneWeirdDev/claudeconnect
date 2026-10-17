// "/" commands, end to end: the real agent reads Claude Code's commands (the fake answers an SDK's "initialize" as the real
// one does), the site keeps them, and in a real Chromium "/" lists them above the message box, narrowing as you type.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();
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

test("typing / lists Claude Code's commands and the site's own, narrowing as you type; they run where they belong", { skip: !CHROME && "needs a Chromium" }, async t => {
  const site = await startSite({ appVersion: "2.9.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  // the computer passes them on, without the terminal's own and the internal ones
  const cmds = await until(async () => { const c = (await site.api("/api/commands")).body.commands; return c.length && c; }, "the commands from the computer");
  assert.deepEqual(cmds.map(c => c.name), ["compact", "context", "usage", "deploy"]);
  assert.deepEqual(cmds.find(c => c.name === "usage").aliases, ["cost", "stats"]);

  const page = await openPage(site.origin + "/");
  t.after(() => page.close());
  await page.until(`document.getElementById("input")`, "the page");
  await page.until(`(async () => (await (await fetch("/api/state")).json()).agent.online)()`, "the computer online");
  const type = text => page.evaluate(`(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); return true; })()`);
  const key = k => page.evaluate(`document.getElementById("input").dispatchEvent(new KeyboardEvent("keydown", { key: ${JSON.stringify(k)}, bubbles: true, cancelable: true }))`);
  const shown = () => page.evaluate(`document.getElementById("slash").hidden ? null : [...document.querySelectorAll("#slash .sl-item b")].map(b => b.textContent)`);

  await type("/");
  const all = await page.until(`(() => { const b = [...document.querySelectorAll("#slash .sl-item b")].map(b => b.textContent); return b.includes("/deploy") && b; })()`, "the list");
  for (const name of ["/help", "/model", "/effort", "/usage", "/config", "/files", "/context", "/deploy"]) assert.ok(all.includes(name), name);
  // what needs a conversation isn't offered on a new chat
  for (const name of ["/clear", "/compact", "/rename"]) assert.ok(!all.includes(name), name);
  assert.ok(!all.includes("/color") && !all.includes("/__remote-workflow"));
  assert.equal(all.filter(n => n === "/usage").length, 1, "the site's /usage stands in for Claude Code's");
  assert.match(await page.evaluate(`[...document.querySelectorAll("#slash .sl-item")].find(r => r.querySelector("b").textContent === "/deploy").innerText`), /\[environment\][\s\S]*Ship the shop to staging/);
  // narrowing by name, then by what it's for
  await type("/dep");
  assert.deepEqual(await shown(), ["/deploy"]);
  await type("/sett");
  assert.deepEqual(await shown(), ["/config"], "by an alias");
  await type("/zzz");
  assert.match(await page.evaluate(`document.getElementById("slash").innerText`), /No commands match \/zzz/);
  // down, then Tab fills in the second; Esc closes
  await type("/con");
  assert.deepEqual(await shown(), ["/config", "/context"]);
  await key("ArrowDown");
  await key("Tab");
  assert.equal(await page.evaluate(`document.getElementById("input").value`), "/context ");
  assert.equal(await shown(), null);
  await type("/");
  await key("Escape");
  assert.equal(await shown(), null);
  // a click puts it in the message box, to send with what's written after it; nothing is sent yet
  await type("/dep");
  await page.evaluate(`document.querySelector('#slash [data-k="0"]').click()`);
  assert.equal(await page.evaluate(`document.getElementById("input").value`), "/deploy ");
  // and it's highlighted there, while words aren't, nor a / that isn't a command
  const mark = () => page.evaluate(`(document.querySelector("#cHl mark") || {}).textContent || ""`);
  assert.equal(await mark(), "/deploy");
  await type("/deploy to staging please");
  assert.equal(await mark(), "/deploy");
  await type("/nothing-like-it");
  assert.equal(await mark(), "");
  await type("hello /deploy");
  assert.equal(await mark(), "");

  // one of Claude Code's goes to it like a message, and /context comes back drawn as a bar over its table
  await type("/context");
  await key("Enter");
  await page.until(`document.querySelector(".msg.bot .ctx-card .ctx-bar i")`, "the context card");
  assert.match(await page.evaluate(`document.querySelector(".ctx-card").innerText`), /25\.8k of 1m used \(3%\)[\s\S]*System tools 18\.1k/);
  assert.ok(pc.claudeRuns().some(r => r.prompt.trim() === "/context"));
  assert.equal(await page.evaluate(`[...document.querySelectorAll(".msg.user .bubble .cmd")].map(x => x.textContent).join()`), "/context", "the command stands out in the sent message too");
  // now there's a conversation, what needs one is offered
  await type("/");
  const now = await shown();
  for (const name of ["/clear", "/compact", "/rename"]) assert.ok(now.includes(name), name);
  await key("Escape");
  // one of the site's own opens its own controls, and nothing is sent
  const runs = pc.claudeRuns().length;
  await type("/usage");
  await key("Enter");
  await page.until(`document.getElementById("usageDlg").open`, "Plan usage");
  assert.equal(await page.evaluate(`document.getElementById("input").value`), "");
  await sleep(300);
  assert.equal(pc.claudeRuns().length, runs, "nothing went to Claude Code");
});
