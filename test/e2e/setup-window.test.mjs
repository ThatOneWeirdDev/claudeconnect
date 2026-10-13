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
import { openPage } from "../helpers/browser.mjs";
import { findChromium } from "../helpers/fake-claude-app.mjs";

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
    CLAUDECONNECT_CONNECT_MS: "1500", CLAUDECONNECT_LIVE_MS: "300", CLAUDECONNECT_GUI_NO_OPEN: "1",
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
  // the plan: paying for Claude
  let text = await s.card("Do you pay for Claude?");
  assert.match(text, /Claude Code on this computer answers your messages/);
  await s.click('[data-answer="y"]');

  // a name the site can't use is said, and asked again
  await s.card("Name your site");
  await s.type("!!!");
  text = await s.page.until(`(() => { const a = document.querySelector("#card .alert"); return a && a.textContent; })()`, "the reason the name won't work");
  assert.match(text, /That name won't work/);
  await s.type("My Site");

  // the logo and the tab icon are optional
  await s.card("Pick a logo");
  await s.click('[data-answer=""]');
  await s.card("Pick a tab icon");
  await s.click('[data-answer=""]');

  // starting at login
  text = await s.card("Start My Site when you log in?");
  assert.match(text, /startup item/);
  await s.click('[data-answer="n"]');

  // Cloudflare Access, step by step, with what the card is for, and a button that opens the claim link
  text = await s.card("Lock it to your Cloudflare account", 60000);
  assert.match(text, /Enable Cloudflare Access/);
  assert.match(text, /Zero Trust/);
  assert.match(text, /Free/);
  assert.match(text, /it's \$0/);
  assert.match(text, /up to 50 people/);
  assert.match(text, /not the Worker's Access tab/, "the tab that would block the computer's connection is warned against");
  assert.match(text, /real person/);
  assert.match(text, /won't be charged/);
  const claim = await s.page.evaluate(`document.querySelector("[data-claim]").dataset.claim`);
  assert.match(claim, /^https:\/\/my-site\.testacct\.workers\.dev\/\?claim=/);
  // the dashboard link is the site's Settings (Domains & Routes), not its Access tab
  assert.match(await s.page.evaluate(`[...document.querySelectorAll("#card a")].map(a => a.href).join(" ")`), /\/workers\/services\/view\/my-site\/production\/settings/);
  await s.click("[data-claim]");

  // nothing connects in the test, so it ends saying it will by itself, with the address to open
  text = await s.card("Nearly done");
  assert.match(text, /https:\/\/my-site\.testacct\.workers\.dev/);
  assert.equal(await s.exited, 0, s.out());

  const cfg = JSON.parse(readFileSync(join(s.dir, "config.json"), "utf8"));
  assert.equal(cfg.displayName, "My Site");
  assert.equal(cfg.plan, "paid");
  // every step is ticked off in the window's list
  assert.equal(await s.page.evaluate(`document.querySelectorAll("#steps li.done").length > 3 && !document.querySelector("#steps li.now")`), true);
});

test("on the free plan the setup window asks for the Claude app until it's installed", { skip: !CHROME && "needs a Chromium" }, async t => {
  const app = join(mkdtempSync(join(tmpdir(), "cc-gui-app-")), "Claude");
  t.after(() => rmSync(app, { force: true }));
  const s = await setUp(t, { CLAUDECONNECT_CLAUDE_APP: app, CLAUDECONNECT_APP_DRIVER: "cdp" }, ["--name", "Free Site", "--no-autostart"]);
  await s.card("Do you pay for Claude?");
  await s.click('[data-answer="n"]');
  let text = await s.card("Install the Claude app");
  assert.match(text, /Download the Claude app/);
  // checked again without it: still not there
  await s.click('[data-answer=""]');
  await s.card("The Claude app isn't there yet");
  // installed now
  writeFileSync(app, "");
  await s.click('[data-answer=""]');
  // what using the app this way can mean for the Claude account, before anything is done with it
  text = await s.card("Before the Claude app is used for you");
  assert.match(text, /could be limited or closed/);
  assert.match(text, /Stop bar/);
  await s.click('[data-answer="y"]');
  await s.card("Pick a logo", 60000);
  assert.ok(existsSync(app));
  await s.click('[data-answer=""]');
  await s.card("Pick a tab icon");
  await s.click('[data-answer=""]');
  await s.card("Lock it to your Cloudflare account", 60000);
  await s.click("[data-claim]");
  await s.card("Nearly done");
  assert.equal(await s.exited, 0, s.out());
  assert.equal(JSON.parse(readFileSync(join(s.dir, "config.json"), "utf8")).plan, "free");
});

test("when the setup stops, the window says why", { skip: !CHROME && "needs a Chromium" }, async t => {
  const s = await setUp(t, {}, ["--name", "Broken Site", "--no-autostart", "--paid"]);
  // the deploy fails: Cloudflare turned it down
  writeFileSync(join(s.home, "fail-deploy"), "");
  await s.card("Pick a logo", 60000);
  await s.click('[data-answer=""]');
  await s.card("Pick a tab icon");
  await s.click('[data-answer=""]');
  const text = await s.card("Setup stopped", 90000);
  assert.match(text, /Cloudflare didn't accept the site/);
  assert.equal(await s.exited, 1);
});
