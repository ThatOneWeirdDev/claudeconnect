// The free plan, end to end: the real site, the real agent on the free plan, and a real Chromium standing in for the Claude
// app, showing a stand-in for claude.ai (test/helpers/fake-claude-app.mjs). The agent opens it through the debugging
// connection, types each message, picks the model and extended thinking, presses send and reads the reply as it's written.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";
import { startFakeClaude, findChromium, closeBrowser, fakeClaudeApp, freePort } from "../helpers/fake-claude-app.mjs";
import { attachTo } from "../helpers/browser.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME = await findChromium();

async function until(fn, what, ms = 45000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + what);
}

async function boot(t, more = {}) {
  const fake = await startFakeClaude();
  const site = await startSite({ appVersion: "2.0.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9", oldVersion: "2.0.0" });
  const cfg = JSON.parse(pc.read("config.json"));
  cfg.plan = "free";
  cfg.appPort = await freePort();
  writeFileSync(join(pc.dir, "config.json"), JSON.stringify(cfg));
  // the Claude app: a headless Chromium on the claude.ai stand-in, started by the agent with its debugging port
  const app = await fakeClaudeApp(pc.dir, fake.url, CHROME);
  // the stand-in driver: the real one goes through macOS or Windows accessibility, which a test here can't
  const env = { ...pc.env, CLAUDECONNECT_APP_URL: fake.url, CLAUDECONNECT_CLAUDE_APP: app, CLAUDECONNECT_APP_DRIVER: "cdp", ...more };
  const agent = spawn(process.execPath, [join(pc.dir, "agent.mjs"), "run"], { env, stdio: "ignore" });
  t.after(async () => {
    agent.kill("SIGKILL");
    await closeBrowser(pc.dir);
    pc.cleanup();
    await site.stop();
    await fake.close();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  return { site, pc, fake, port: cfg.appPort };
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

test("on the free plan, a message is typed into the Claude app with its model and extended thinking, and the reply streams back", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, fake } = await boot(t);
  let st = (await site.api("/api/state")).body.agent;
  assert.equal(st.plan, "free");
  assert.equal(st.history, false, "no Claude Code chats on the free plan");
  assert.equal(st.modes, false, "no Claude Code permission modes either");

  // asking for the app's models doesn't open the app: they're read after a message, while it's open anyway
  assert.equal((await site.post("/api/app/refresh")).status, 200);
  await sleep(1500);
  assert.equal(fake.state.conversations.size, 0);
  assert.ok(!((await site.api("/api/state")).body.agent.app || { models: [] }).models.length, "nothing read, nothing opened");
  const hi = await chat(site, { text: "hello there" });
  assert.equal(hi.find(e => e.type === "done").message.meta.error, null);
  const app = await until(async () => {
    const a = (await site.api("/api/state")).body.agent.app;
    return a && a.models.length ? a : null;
  }, "the app's models");
  assert.deepEqual(app.models.map(m => [m.id, m.name, m.locked]), [["claude-sonnet-5-5", "Sonnet 5.5", false], ["claude-haiku-5-5", "Haiku 5.5", false], ["claude-opus-5-5", "Opus 5.5", true]]);
  assert.equal(app.thinking, false);
  assert.equal(app.kind, "app", "the Claude app, started with its debugging connection");

  const events = await chat(site, { text: "first question\nwith two lines", model: "claude-haiku-5-5", think: true });
  const statuses = events.filter(e => e.type === "status").map(e => e.text);
  assert.ok(statuses.includes("Switching to Haiku 5.5"), statuses.join(", "));
  assert.ok(statuses.includes("Turning on extended thinking"), statuses.join(", "));
  assert.ok(statuses.includes("Typing your message"));
  assert.ok(events.some(e => e.type === "delta" || e.type === "replace"), "it streams");
  const done = events.find(e => e.type === "done").message;
  assert.match(done.content, /^You said: first question/);
  assert.match(done.content, /Model: Haiku 5\.5 \(thinking\)/);
  assert.match(done.content, /\*\*Plan\*\*\n\n```markdown\n# Day 1\n```/, "the exact text claude.ai kept, with what the page only shows as a card");
  assert.equal(done.meta.modelName, "Haiku 5.5");
  assert.equal(done.meta.thinking, "pondered it");
  assert.equal(done.meta.error, null);
  const chatId = events.find(e => e.type === "meta").chat.id;

  // the next message in the chat carries on in the same conversation in the app
  const again = await chat(site, { chatId, text: "make a table please" });
  assert.match(again.find(e => e.type === "done").message.content, /\| Name \| Count \|\n\| --- \| --- \|\n\| apples \| 3 \|/);
  assert.equal(fake.state.conversations.size, 2, "one for the first chat, one for this one");
  assert.equal([...fake.state.conversations.values()][1].chat_messages.length, 2);

  // a model that needs a paid plan isn't sent
  const locked = await chat(site, { chatId, text: "locked model", model: "claude-opus-5-5" });
  assert.equal(locked.find(e => e.type === "meta").user.meta.model, "app-default");

  // Plan usage, from claude.ai's own reading through the app
  await site.post("/api/limits/refresh");
  const l = await until(async () => (await site.api("/api/limits")).body, "a usage reading");
  assert.equal(l.windows.five_hour.pct, 37);
  assert.equal(l.windows.seven_day.pct, 12);
  assert.equal(l.limited, false);
});

test("a window in the Claude app that waits for an answer shows on the site, and a click there answers it", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site } = await boot(t, { CLAUDECONNECT_PERMIT_WAIT_MS: "4000" });
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
  assert.ok(seen.image.startsWith("/9j/"), "a JPEG of just that window");
  assert.ok(seen.w > 100 && seen.h > 50);
  assert.deepEqual(seen.buttons.map(b => b.label), ["Deny", "Allow once"]);
  assert.ok(events.some(e => e.type === "remote_done"), "it closes once the app has the answer");
  assert.match(events.find(e => e.type === "done").message.content, /Permission: Allow once/);

  // nobody answers: after a while the window is closed, which allows nothing, and the reply is stopped
  const t0 = Date.now();
  const left = await chat(site, { text: "please ask permission for the other file" });
  assert.ok(Date.now() - t0 >= 4000, "it waited for an answer first");
  const q = left.find(e => e.type === "remote");
  assert.ok(q, "the window was shown");
  assert.ok(left.some(e => e.type === "remote_done" && e.id === q.remote.id), "and taken down");
  const done = left.find(e => e.type === "done").message;
  assert.equal(done.meta.error, "Nobody answered the Claude app's question in time, so it was closed and the reply stopped. Send again to carry on.");
  assert.doesNotMatch(done.content, /Allow once/);
});

test("out of free messages, stopping, and a signed-out app each say so", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, fake } = await boot(t);
  const out = await chat(site, { text: "you are out of messages" });
  assert.equal(out.find(e => e.type === "done").message.meta.error, "You're out of free messages until 4:00 PM");
  // nothing more is typed into the app until then: the site says so straight away
  const held = await until(async () => {
    const r = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "one more?", model: "app-default" }) });
    return r.status === 409 ? r.json() : (await r.text(), null);
  }, "the next message to be held");
  assert.equal(held.code, "limit");
  assert.ok(held.resetsAt > Date.now() / 1000, "with when it resets");
  // the limit's over (the app would say so by taking a message)
  await site.setLimits({ status: "allowed", windows: {} });

  const stopped = await chat(site, { text: "write slowly please" }, async (ev, all) => {
    if (ev.type === "delta" || ev.type === "replace") {
      const chatId = all.find(e => e.type === "meta").chat.id;
      if (!all.stopSent) {
        all.stopSent = true;
        await site.post("/api/stop", { chatId });
      }
    }
  });
  const msg = stopped.find(e => e.type === "done").message;
  assert.equal(msg.meta.error, "Stopped.");
  assert.match(msg.content, /\(stopped\)$/);

  fake.state.signedIn = false;
  const signedOut = await chat(site, { text: "anyone there?" });
  assert.equal(signedOut.find(e => e.type === "done").message.meta.error, "Sign in to the Claude app on your computer, then send again.");
});

test("a Stop button on the Claude app's own window takes it back at once, and it's left alone until the site lets it use it again", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { site, fake, port } = await boot(t);
  let app = null;
  t.after(() => app && app.close());
  let sawBar = false;
  const events = await chat(site, { text: "write slowly please" }, async ev => {
    if ((ev.type !== "delta" && ev.type !== "replace") || app) return;
    // the person at the computer sees the bar on the app's window, and clicks its Stop button
    app = await attachTo(port);
    sawBar = !!(await app.boxOf("Test Site is reading the reply in the Claude app"));
    const stop = await app.boxOf("Stop Test Site");
    assert.ok(stop, "the bar has a Stop button");
    await app.clickAt(stop);
  });
  assert.ok(sawBar, "while it uses the app, the app's window says so");
  const done = events.find(e => e.type === "done").message;
  assert.match(done.meta.error, /You took back the Claude app on your computer, so Test Site stopped using it/);
  assert.match(done.content, /^You/, "what had arrived of the reply is kept");
  // it let go: the bar is gone, and nothing was clicked after Stop (the reply in the app carries on by itself)
  await until(async () => !(await app.boxOf("Stop Test Site")) && !(await app.boxOf("Stopping…")), "the bar to go");
  const st = await until(async () => {
    const a = (await site.api("/api/state")).body.agent.app;
    return a && a.paused ? a : null;
  }, "the site to know it was stopped");
  assert.equal(st.paused, true);

  // while it's stopped, a message isn't typed into the app: it says why straight away
  const sent = fake.state.conversations.size;
  const waits = await chat(site, { text: "are you there?" });
  assert.match(waits.find(e => e.type === "done").message.meta.error, /won't touch the app again until you let it/);
  assert.equal(fake.state.conversations.size, sent, "nothing new in the app");

  // the site lets it use the app again, and the next message goes through
  assert.equal((await site.post("/api/app/resume")).status, 200);
  await until(async () => (await site.api("/api/state")).body.agent.app.paused === false, "the computer to be allowed again");
  const again = await chat(site, { text: "hello again" });
  const ok = again.find(e => e.type === "done").message;
  assert.equal(ok.meta.error, null);
  assert.match(ok.content, /You said: hello again/);
  // once it's done with the app (the reply, then a look at the app's model menu, which it hadn't read yet), the bar goes
  await until(async () => !(await app.boxOf("Stop Test Site")), "the bar to go once it's done");
});
