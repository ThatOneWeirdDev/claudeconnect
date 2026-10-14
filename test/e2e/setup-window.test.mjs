// The setup in its window: the real launcher and installer with --gui, and the page they open driven in a real Chromium, the
// way a person clicks through it. Cloudflare's API, wrangler and Claude Code are fakes, as in install.test.mjs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startRepo } from "../helpers/github.mjs";
import { ROOT, makeFakes } from "../helpers/computer.mjs";
import { startFakeCloudflare } from "../helpers/cloudflare.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function setUp(t, extraEnv = {}, args = []) {
  const github = await startRepo(ROOT);
  const home = mkdtempSync(join(tmpdir(), "cc-gui-"));
  const cf = await startFakeCloudflare(home);
  const bin = join(home, "bin");
  mkdirSync(bin, { recursive: true });
  makeFakes(bin);
  const env = {
    ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, npm_config_prefix: join(home, "npm"),
    CLAUDECONNECT_RAW: github.url, CLAUDECONNECT_CF_API: cf.url, CLAUDECONNECT_RETRY_MS: "50",
    CLAUDECONNECT_CONNECT_MS: "1500", CLAUDECONNECT_LIVE_MS: "300", CLAUDECONNECT_GUI_NO_OPEN: "1", CLAUDECONNECT_ACCESS_LATE_MS: "1500",
    ...extraEnv
  };
  // its own process group, so the installer the launcher starts goes too when the test ends
  const child = spawn(process.execPath, [join(ROOT, "ClaudeConnect.mjs"), "--gui", ...args], { env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout.on("data", d => (out += d));
  child.stderr.on("data", d => (out += d));
  const exited = new Promise(r => child.on("close", code => r(code)));
  const dir = join(home, ".claudeconnect");
  let page = null;
  t.after(async () => {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {}
    if (page) await page.close();
    try {
      process.kill(Number(readFileSync(join(dir, "agent.pid"), "utf8")), "SIGKILL");
    } catch {}
    await github.close();
    await cf.close();
    rmSync(home, { recursive: true, force: true });
  });
  // the terminal says where the window is, in case the browser didn't open
  let url = null;
  for (let i = 0; i < 600 && !url; i++) {
    url = (/http:\/\/127\.0\.0\.1:\d+\/\?k=[\w-]+/.exec(out) || [])[0];
    if (!url) await sleep(100);
  }
  assert.ok(url, "the setup prints its window's address\n" + out);
  page = await openPage(url);
  // waits for the card to show a heading, and gives back the card's text
  const card = async (heading, ms = 30000) => page.until(`(() => { const h = document.querySelector("#card h2"); return h && h.textContent.includes(${JSON.stringify(heading)}) && document.getElementById("card").innerText; })()`, `"${heading}"\n${out}`, ms);
  const click = sel => page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) throw new Error("no " + ${JSON.stringify(sel)}); b.click(); return true; })()`);
  const type = text => page.evaluate(`(() => { const t = document.getElementById("text"); t.value = ${JSON.stringify(text)}; t.form.requestSubmit(); return true; })()`);
  return { home, dir, cf, page, card, click, type, exited, out: () => out };
}

test("the setup window asks everything a first install needs, explains Cloudflare Access and its card, and ends with the site's address", { skip: !CHROME && "needs a Chromium" }, async t => {
  const s = await setUp(t);
  // there's no plan to pick (replies always come from Claude Code): it starts with a template, your own name and icon picked
  let text = await s.card("Start from a template?");
  assert.match(text, /Your own[\s\S]*ChatGPT/);
  assert.equal(await s.page.evaluate(`document.querySelector('.choice.on').dataset.pick`), "");
  assert.match(await s.page.evaluate(`document.querySelector('[data-pick="chatgpt"] img').src`), /^data:image\/png;base64,/);
  await s.click("[data-send-pick]");
  // then the name. One the site can't use is said, and asked again
  text = await s.card("Name your site");
  assert.doesNotMatch(text, /paid plan|free plan/i);
  await s.type("!!!");
  text = await s.page.until(`(() => { const a = document.querySelector("#card .alert"); return a && a.textContent; })()`, "the reason the name won't work");
  assert.match(text, /That name won't work/);
  await s.type("My Site");

  // the tab icon is optional
  await s.card("Pick a tab icon");
  await s.click('[data-answer=""]');

  // starting at login
  text = await s.card("Start My Site when you log in?");
  assert.match(text, /startup item/);
  await s.click('[data-answer="n"]');

  // Cloudflare Access: one button straight to the Worker's Access tab, three short things to do there, and why it asks for a
  // card. No claim link yet, and no other dashboard link
  text = await s.card("Turn on Cloudflare Access", 60000);
  assert.match(text, /Zero Trust/);
  assert.match(text, /Free/);
  assert.match(text, /costs \$0/);
  assert.match(text, /real person/);
  assert.match(text, /won't be charged/);
  assert.match(text, /your own email address/);
  assert.deepEqual(JSON.parse(await s.page.evaluate(`JSON.stringify([...document.querySelectorAll("#card a")].map(a => a.href))`)), ["https://dash.cloudflare.com/acct-1/workers/services/view/my-site/production/access"]);
  assert.equal(await s.page.evaluate(`document.querySelector("[data-claim]")`), null, "the claim link only comes once Access is on");
  assert.equal(await s.page.evaluate(`document.documentElement.scrollHeight <= innerHeight`), true, "it fits without scrolling");
  // Access can't be seen from the test, so after a while (CLAUDECONNECT_ACCESS_LATE_MS) there's a way on
  await s.page.until(`document.querySelector('[data-answer="skip"]')`, "the way on");
  await s.click('[data-answer="skip"]');

  // then the claim link, as its own step
  text = await s.card("Claim your site");
  assert.match(text, /Access is on/);
  const claim = await s.page.evaluate(`document.querySelector("[data-claim]").dataset.claim`);
  assert.match(claim, /^https:\/\/my-site\.testacct\.workers\.dev\/\?claim=/);
  await s.click("[data-claim]");

  // nothing connects in the test, so it ends saying it will by itself, with the address to open
  text = await s.card("Nearly done");
  assert.match(text, /https:\/\/my-site\.testacct\.workers\.dev/);
  assert.equal(await s.exited, 0, s.out());

  const cfg = JSON.parse(readFileSync(join(s.dir, "config.json"), "utf8"));
  assert.equal(cfg.displayName, "My Site");
  assert.equal(cfg.plan, undefined, "there's no plan to keep: replies come from Claude Code");
  assert.equal(cfg.command, "MySite", "the command is the site's name");
  // every step is ticked off in the window's list
  assert.equal(await s.page.evaluate(`document.querySelectorAll("#steps li.done").length > 3 && !document.querySelector("#steps li.now")`), true);
});

test("picking the ChatGPT template in the window names the site and picks its icon, so neither is asked", { skip: !CHROME && "needs a Chromium" }, async t => {
  const s = await setUp(t);
  await s.card("Start from a template?");
  await s.click('[data-pick="chatgpt"]');
  await s.click("[data-send-pick]");
  // straight on to the computer: no name and no tab icon to pick
  await s.card("Start ChatGPT when you log in?");
  assert.equal(JSON.parse(readFileSync(join(s.dir, "config.json"), "utf8")).displayName, "ChatGPT");
  assert.match(readFileSync(join(s.dir, "site", "brand.js"), "utf8"), /"favicon":\{"type":"image\/png","b64":"iVBOR/);
});

test("when the setup stops, the window says why", { skip: !CHROME && "needs a Chromium" }, async t => {
  const s = await setUp(t, {}, ["--name", "Broken Site", "--no-autostart", "--paid"]);
  // the deploy fails: Cloudflare turned it down
  writeFileSync(join(s.home, "fail-deploy"), "");
  await s.card("Pick a tab icon", 60000);
  await s.click('[data-answer=""]');
  const text = await s.card("Setup stopped", 90000);
  assert.match(text, /Cloudflare didn't accept the site/);
  assert.equal(await s.exited, 1);
});
