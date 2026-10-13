// The free plan through the operating system's accessibility features (agent/app-os.mjs), end to end: the real site, the
// real agent on the free plan, and the real driver, talking to a stand-in for the macOS/Windows helper that shows a made-up
// Claude app the way Accessibility or UI Automation would (test/helpers/fake-os-helper.mjs), and a stand-in Stop bar.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";

const HELPERS = join(dirname(fileURLToPath(import.meta.url)), "..", "helpers");
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}

async function boot(t, more = {}) {
  const site = await startSite({ appVersion: "2.0.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9", oldVersion: "2.0.0" });
  const cfg = JSON.parse(pc.read("config.json"));
  cfg.plan = "free";
  writeFileSync(join(pc.dir, "config.json"), JSON.stringify(cfg));
  const fake = mkdtempSync(join(tmpdir(), "cc-os-app-"));
  const appFile = join(fake, "Claude.app");
  writeFileSync(appFile, "");
  const env = {
    ...pc.env,
    CLAUDECONNECT_APP_DRIVER: "os",
    CLAUDECONNECT_APP_HELPER: join(HELPERS, "fake-os-helper.mjs"),
    CLAUDECONNECT_APP_BAR: join(HELPERS, "fake-os-bar.mjs"),
    CLAUDECONNECT_FAKE_DIR: fake,
    CLAUDECONNECT_CLAUDE_APP: appFile,
    ...more
  };
  const agent = spawn(process.execPath, [join(pc.dir, "agent.mjs"), "run"], { env, stdio: "ignore" });
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  const app = {
    state: () => JSON.parse(readFileSync(join(fake, "app.json"), "utf8")),
    control: o => writeFileSync(join(fake, "control.json"), JSON.stringify(o)),
    bar: () => (existsSync(join(fake, "bar.json")) ? JSON.parse(readFileSync(join(fake, "bar.json"), "utf8")) : { shown: false }),
    pressStop: () => writeFileSync(join(fake, "bar-press"), ""),
    dir: fake
  };
  return { site, pc, app };
}

async function chat(site, body, onEvent) {
  const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hello", model: "app-default", ...body }) });
  if (res.status !== 200) assert.fail(await res.text());
  const reader = res.body.getReader();
  const td = new TextDecoder();
  let buf = "";
  const events = [];
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += td.decode(value, { stream: true });
    let k;
    while ((k = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, k);
      buf = buf.slice(k + 1);
      if (!line.trim()) continue;
      const ev = JSON.parse(line);
      events.push(ev);
      if (onEvent) await onEvent(ev, events);
    }
  }
  return events;
}

const REST = "## Plan\n\nThis is **bold**, *leaning* and `code`, with [a link](https://example.com/).\n\n- one\n- two\n\n1. first\n2. second\n\n```python\nprint(\"hi\")\n```\n\n| Name | Count |\n| --- | --- |\n| apples | 3 |";

test("through accessibility: the message goes in the app's box, the model and thinking are picked from its menu, and the reply comes back as Markdown", async t => {
  const { site, app } = await boot(t);
  let barSeen = null;
  const hi = await chat(site, { text: "hello there" }, async ev => {
    if (!barSeen && (ev.type === "delta" || ev.type === "replace")) barSeen = app.bar();
  });
  const done = hi.find(e => e.type === "done").message;
  assert.equal(done.meta.error, null);
  assert.equal(done.content, "You said: hello there\n\nModel: Sonnet 5.5\n\n" + REST);
  assert.ok(hi.some(e => e.type === "delta" || e.type === "replace"), "it streams");
  assert.ok(barSeen && barSeen.shown, "the Stop bar is on the screen while it uses the app");
  assert.equal(barSeen.text, "Test Site is reading the reply in the desktop app");
  assert.equal(barSeen.label, "Stop Test Site");
  await until(async () => !app.bar().shown, "the bar to go once it's done");

  // the app's models, read from its menu after the reply
  const st = await until(async () => {
    const a = (await site.api("/api/state")).body.agent.app;
    return a && a.models.length ? a : null;
  }, "the app's models");
  assert.deepEqual(st.models.map(m => [m.id, m.name, m.locked]), [["claude-sonnet-5-5", "Sonnet 5.5", false], ["claude-haiku-5-5", "Haiku 5.5", false], ["claude-opus-5-5", "Opus 5.5", true]]);
  assert.equal(st.thinking, false);
  assert.equal(st.model, "Sonnet 5.5");
  assert.equal(app.state().menu, null, "the menu is closed again");

  const events = await chat(site, { text: "first question\nwith two lines", model: "claude-haiku-5-5", think: true });
  const statuses = events.filter(e => e.type === "status").map(e => e.text);
  assert.ok(statuses.includes("Switching to Haiku 5.5"), statuses.join(", "));
  assert.ok(statuses.includes("Turning on extended thinking"), statuses.join(", "));
  const second = events.find(e => e.type === "done").message;
  assert.equal(second.content, "You said: first question with two lines\n\nModel: Haiku 5.5, thinking on\n\n" + REST);
  assert.equal(second.meta.modelName, "Haiku 5.5");
  let s = app.state();
  const sent = s.log.filter(x => x.sent);
  assert.deepEqual(sent.map(x => [x.sent, x.model, x.thinking]), [["hello there", "Sonnet 5.5", false], ["first question\nwith two lines", "Haiku 5.5", true]]);
  assert.notEqual(sent[0].conv, sent[1].conv, "a new chat on the site is a new conversation in the app");
  assert.ok(!s.log.some(x => x.paste), "put straight into the box, without the clipboard");
  const chatId = events.find(e => e.type === "meta").chat.id;

  // the person opened another conversation in the app meanwhile: the chat's own is found again in the app's list
  app.control({ current: null, url: "https://claude.ai/new" });
  const again = await chat(site, { chatId, text: "and another thing" });
  assert.equal(again.find(e => e.type === "done").message.meta.error, null);
  s = app.state();
  const third = s.log.filter(x => x.sent)[2];
  assert.equal(third.conv, sent[1].conv, "the same conversation in the app");
  assert.equal(third.sent, "and another thing", "with nothing added before it");

  // when the box doesn't take the text in directly, it's pasted
  const pasted = await chat(site, { chatId, text: "this one needs a paste" });
  assert.equal(pasted.find(e => e.type === "done").message.meta.error, null);
  s = app.state();
  assert.ok(s.log.some(x => x.paste === "this one needs a paste"), "pasted");
  assert.equal(s.log.filter(x => x.sent).pop().sent, "this one needs a paste");
});

test("through accessibility: a window in the app that asks something shows on the site with its words and buttons, and is answered from there", async t => {
  const { site, app } = await boot(t);
  let seen = null;
  const events = await chat(site, { text: "please ask permission for the file" }, async (ev, all) => {
    if (ev.type !== "remote") return;
    seen = ev.remote;
    const chatId = all.find(e => e.type === "meta").chat.id;
    const i = ev.remote.buttons.findIndex(b => /allow/i.test(b.label));
    const r = await site.post("/api/remote", { chatId, id: ev.remote.id, button: i });
    assert.equal(r.status, 200, r.text);
  });
  assert.equal(seen.kind, "screen");
  assert.equal(seen.title, "Allow Claude to read report.pdf?");
  assert.equal(seen.text, "Claude wants to read report.pdf from your computer.");
  assert.equal(seen.image, "", "no picture: that would need permission to record the screen");
  assert.deepEqual(seen.buttons.map(b => b.label), ["Deny", "Allow once"]);
  assert.ok(events.some(e => e.type === "remote_done"), "it goes once the app has the answer");
  assert.match(events.find(e => e.type === "done").message.content, /Permission: Allow once/);
  assert.equal(app.state().dialog, null);
});

test("through accessibility: out of messages, stopping from the site, signed out, the app closed, and no permission each say so", async t => {
  const { site, app } = await boot(t);
  const out = await chat(site, { text: "you are out of messages" });
  const o = out.find(e => e.type === "done").message;
  assert.equal(o.meta.error, "You're out of free messages until 4:00 PM");
  await site.setLimits({ status: "allowed", windows: {} });
  app.control({ limited: false, composer: "" });

  const stopped = await chat(site, { text: "write slowly please" }, async (ev, all) => {
    if ((ev.type === "delta" || ev.type === "replace") && !all.stopSent) {
      all.stopSent = true;
      await site.post("/api/stop", { chatId: all.find(e => e.type === "meta").chat.id });
    }
  });
  const msg = stopped.find(e => e.type === "done").message;
  assert.equal(msg.meta.error, "Stopped.");
  assert.ok(app.state().log.some(x => x.press === "stop"), "the app's own stop button was pressed");

  // the app wasn't running: it's started, behind your other windows (once the look at its model menu after the last reply is done)
  await until(async () => (((await site.api("/api/state")).body.agent.app || {}).models || []).length, "the models to be read");
  await until(async () => !app.bar().shown, "the bar to go");
  app.control({ running: false });
  await sleep(200);
  const opened = await chat(site, { text: "are you up?" });
  assert.ok(opened.some(e => e.type === "status" && e.text === "Opening the desktop app"));
  assert.equal(opened.find(e => e.type === "done").message.meta.error, null);
  assert.equal(app.state().launches, 1);

  app.control({ signedIn: false });
  await sleep(200);
  const signedOut = await chat(site, { text: "anyone there?" });
  assert.equal(signedOut.find(e => e.type === "done").message.meta.error, "Sign in to the desktop app on your computer, then send again.");
  app.control({ signedIn: true, trusted: false });
  await sleep(200);
  const denied = await chat(site, { text: "hello?" });
  assert.match(denied.find(e => e.type === "done").message.meta.error, /needs your permission to use the desktop app\. On your Mac, open System Settings → Privacy & Security → Accessibility/);
});

test("through accessibility: Stop on the bar takes the app back at once, and it's left alone until the site allows it again", async t => {
  const { site, app } = await boot(t);
  // the person at the computer presses Stop on the bar while the reply is coming in
  let pressed = false;
  const events = await chat(site, { text: "write slowly please" }, async ev => {
    if ((ev.type === "delta" || ev.type === "replace") && !pressed) {
      pressed = true;
      app.pressStop();
    }
  });
  const done = events.find(e => e.type === "done").message;
  assert.match(done.meta.error, /You took back the desktop app on your computer, so Test Site stopped using it/);
  assert.match(done.content, /^You said: write slowly please/, "what had arrived of the reply is kept");
  assert.equal(app.bar().shown, false, "the bar is gone");
  const pressesAfter = app.state().log.length;
  await until(async () => (await site.api("/api/state")).body.agent.app.paused === true, "the site to know it was stopped");

  const waits = await chat(site, { text: "are you there?" });
  assert.match(waits.find(e => e.type === "done").message.meta.error, /won't touch the app again until you let it/);
  assert.equal(app.state().log.length, pressesAfter, "nothing touched in the app");

  assert.equal((await site.post("/api/app/resume")).status, 200);
  await until(async () => (await site.api("/api/state")).body.agent.app.paused === false, "the computer to be allowed again");
  const again = await chat(site, { text: "hello again" });
  const ok = again.find(e => e.type === "done").message;
  assert.equal(ok.meta.error, null);
  assert.match(ok.content, /^You said: hello again/);

  // Stop pressed after the reply is in, while it takes a last look at the app's menu: that counts too
  await until(async () => !app.bar().shown, "the bar to go");
  app.control({ slow: 400 });
  await site.post("/api/app/refresh");
  await until(async () => app.bar().shown, "the bar for the look at the models");
  app.pressStop();
  await until(async () => (await site.api("/api/state")).body.agent.app.paused === true, "the late Stop to count");
  app.control({ slow: 0 });
  assert.equal((await site.post("/api/app/resume")).status, 200);
  await until(async () => (await site.api("/api/state")).body.agent.app.paused === false, "allowed again");

  // no bar on the screen, no using the app
  writeFileSync(join(app.dir, "bar-fail"), "");
  const before = app.state().log.length;
  const nobar = await chat(site, { text: "and now?" });
  assert.match(nobar.find(e => e.type === "done").message.meta.error, /^The Stop bar couldn't be shown on your computer, so Test Site didn't use the desktop app\./);
  assert.equal(app.state().log.length, before, "nothing done in the app");
});
