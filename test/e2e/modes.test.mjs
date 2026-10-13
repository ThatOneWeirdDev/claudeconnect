// Every message runs as Claude Code: how freely it acts, and how full the context is.
// The first half is the site with a fake agent; the second half runs the real agent with a fake `claude` and reads the
// command line it was given.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";
import { makeComputer, ROOT } from "../helpers/computer.mjs";
import { startRepo } from "../helpers/github.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}

// ---------------------------------------------------------------- the site

async function ready(t, hello) {
  // this agent never answers the site's questions about Claude Code's own record of a chat, so don't wait long for it
  const s = await startSite({ appVersion: "1.3.1", vars: { ASK_TIMEOUT_MS: "300" } });
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s, hello);
  return { s, agent };
}
async function sendAs(s, body) {
  const res = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hi", model: "claude-opus-5-5", ...body }) });
  return res;
}

test("a message is sent as Claude Code, in auto, unless it says otherwise", async t => {
  const { s, agent } = await ready(t);
  const sent = await sendAs(s, {});
  const run = await agent.next(m => m.type === "run");
  assert.equal(run.mode, "code");
  assert.equal(run.perm, "auto");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
  await sent.text();
});

test("every permission mode is passed on, anything else falls back, and there is no plain Claude any more", async t => {
  const { s, agent } = await ready(t);
  const run = async body => {
    const sent = await sendAs(s, body);
    const r = await agent.next(m => m.type === "run");
    agent.send({ type: "done", runId: r.runId, chatId: r.chatId, text: "ok", started: true, tools: [] });
    await sent.text();
    return r;
  };
  assert.deepEqual(pick(await run({ perm: "plan" })), { mode: "code", perm: "plan" });
  assert.deepEqual(pick(await run({ perm: "acceptEdits" })), { mode: "code", perm: "acceptEdits" });
  assert.deepEqual(pick(await run({ perm: "bypassPermissions" })), { mode: "code", perm: "auto" }, "a permission mode that isn't offered is not passed on");
  assert.deepEqual(pick(await run({ perm: { x: 1 } })), { mode: "code", perm: "auto" });
  // an older page that still asks for plain Claude gets Claude Code, with the permission mode it asked for
  assert.deepEqual(pick(await run({ mode: "claude" })), { mode: "code", perm: "auto" });
  assert.deepEqual(pick(await run({ mode: "claude", perm: "plan" })), { mode: "code", perm: "plan" });
  assert.deepEqual(pick(await run({ mode: ["claude"], perm: "acceptEdits" })), { mode: "code", perm: "acceptEdits" });
  // asking first needs a computer that can put the question on the site; this one can't, so it's auto
  assert.deepEqual(pick(await run({ perm: "default" })), { mode: "code", perm: "auto" });
});
const pick = r => ({ mode: r.mode, perm: r.perm });

test("asking first is passed on when the computer can ask on the site", async t => {
  const { s, agent } = await ready(t, { caps: ["update", "admin", "limits", "modes", "history", "ask"] });
  assert.equal((await s.api("/api/state")).body.agent.ask, true);
  const sent = await sendAs(s, { perm: "default" });
  const r = await agent.next(m => m.type === "run");
  assert.deepEqual(pick(r), { mode: "code", perm: "default" });
  agent.send({ type: "done", runId: r.runId, chatId: r.chatId, text: "ok", started: true, tools: [] });
  await sent.text();
});

test("how a chat's last message was sent is remembered, and shown when the chat is opened", async t => {
  const { s, agent } = await ready(t);
  const sent = await sendAs(s, { perm: "plan" });
  const run = await agent.next(m => m.type === "run");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
  await sent.text();
  let c = (await s.api(`/api/chats/${run.chatId}`)).body;
  assert.equal(c.chat.mode, "code");
  assert.equal(c.chat.perm, "plan");
  assert.equal(c.messages[0].meta.perm, "plan");
  assert.equal(c.messages[1].meta.perm, "plan");
  const again = await sendAs(s, { chatId: run.chatId, perm: "acceptEdits" });
  const run2 = await agent.next(m => m.type === "run");
  assert.equal(run2.resume, true);
  agent.send({ type: "done", runId: run2.runId, chatId: run2.chatId, text: "ok", started: true, tools: [] });
  await again.text();
  c = (await s.api(`/api/chats/${run.chatId}`)).body;
  assert.deepEqual([c.chat.mode, c.chat.perm], ["code", "acceptEdits"]);
});

test("how full the context is arrives with the reply and is kept with it; junk is dropped", async t => {
  const { s, agent } = await ready(t);
  const finish = async context => {
    const sent = await sendAs(s, {});
    const run = await agent.next(m => m.type === "run");
    agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [], context });
    const done = (await sent.text()).trim().split("\n").map(l => JSON.parse(l)).find(l => l.type === "done");
    return done.message.meta.context;
  };
  assert.deepEqual(await finish({ used: 142000, window: 200000 }), { used: 142000, window: 200000 });
  assert.deepEqual(await finish({ used: 1234.6, window: 1e6 }), { used: 1235, window: 1000000 }, "whole tokens");
  for (const junk of [null, 5, "x", [], {}, { used: "a", window: 200000 }, { used: -1, window: 200000 }, { used: 10, window: 0 }, { used: 10, window: 999 }, { used: NaN, window: 200000 }, { used: 10, window: 1e12 }]) {
    assert.equal(await finish(junk), null, JSON.stringify(junk));
  }
  assert.equal((await finish(undefined)), null, "an older computer sends nothing");
  assert.equal((await finish({ used: 9e9, window: 200000 })).used, 800000, "absurd counts are capped");
});

test("the page is told whether the computer can do permission modes", async t => {
  const { s } = await ready(t);
  assert.equal((await s.api("/api/state")).body.agent.modes, true);
  const old = await startSite({ appVersion: "1.3.1" });
  t.after(() => old.stop());
  await old.claim();
  await connectAgent(old, { caps: ["update", "admin", "limits"] });
  assert.equal((await old.api("/api/state")).body.agent.modes, false, "an older program on the computer");
});

test("there is no setting for what the AI calls itself, and an old page that still sends one is ignored", async t => {
  const { s, agent } = await ready(t);
  assert.equal((await s.post("/api/admin/settings", { aiName: "Buddy" })).status, 400, "nothing else changed, so there is nothing to do");
  const r = await s.post("/api/admin/settings", { aiName: "Buddy", displayName: "Other Site" });
  assert.equal(r.status, 200);
  const msg = await agent.next(m => m.type === "admin");
  assert.deepEqual(msg.payload, { displayName: "Other Site" }, "the name isn't passed on");
  const html = await (await s.asOwner("/")).text();
  assert.doesNotMatch(html, /"ai"\s*:/, "the page isn't given an AI name");
});

// ---------------------------------------------------------------- the real agent

async function boot(t, { old = false } = {}) {
  const github = await startRepo(ROOT);
  const site = await startSite({ appVersion: "1.3.1" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: github.url, oldVersion: "1.3.1" });
  if (old) pc.oldClaude();
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
    await github.close();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  const chat = async body => {
    const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hello there", model: "claude-opus-5-5", effort: "high", ...body }) });
    const lines = (await res.text()).trim().split("\n").map(l => JSON.parse(l));
    return lines.find(l => l.type === "done");
  };
  // the arguments the fake claude was given for the run with this message
  const runWith = async text => (await until(() => pc.claudeRuns().find(r => r.prompt.includes(text)), "the run for " + text)).args;
  return { site, pc, chat, runWith };
}
const flag = (args, name) => args[args.indexOf(name) + 1];

test("Claude Code runs with Claude Code's own instructions, in auto, with every tool", async t => {
  const { chat, runWith, pc } = await boot(t);
  await chat({ text: "code run", mode: "code" });
  const args = await runWith("code run");
  assert.equal(flag(args, "--permission-mode"), "auto");
  assert.equal(flag(args, "--model"), "claude-opus-5-5");
  assert.equal(flag(args, "--effort"), "high");
  for (const f of ["--system-prompt", "--system-prompt-file", "--append-system-prompt", "--tools", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(!args.includes(f), `${f} is not passed: Claude Code uses its defaults`);
  // a chat an older version started in plain Claude carries on with Claude Code's own prompt, which needs the prompt built
  // fresh each time; this Claude Code can do that
  assert.equal(flag(args, "--system-prompt-snapshot"), "off");
  // older versions of this program left "You are <name>" behind; it is cleaned up and never read
  assert.equal(pc.alive(pc.pid()), true);
});

test("how freely Claude Code acts is passed to it, and nothing outside the offered modes is", async t => {
  const { chat, runWith } = await boot(t);
  await chat({ text: "plan run", mode: "code", perm: "plan" });
  assert.equal(flag(await runWith("plan run"), "--permission-mode"), "plan");
  await chat({ text: "edits run", mode: "code", perm: "acceptEdits" });
  assert.equal(flag(await runWith("edits run"), "--permission-mode"), "acceptEdits");
  await chat({ text: "auto run", mode: "code", perm: "bypassPermissions" });
  assert.equal(flag(await runWith("auto run"), "--permission-mode"), "auto", "bypassPermissions can't be asked for from the page");
});

test("a message from an older page that asks for plain Claude runs as Claude Code, with every tool", async t => {
  const { chat, runWith } = await boot(t);
  await chat({ text: "chat run", mode: "claude", perm: "plan" });
  const args = await runWith("chat run");
  for (const f of ["--system-prompt", "--tools", "--strict-mcp-config", "--disable-slash-commands"]) assert.ok(!args.includes(f), `${f} is not passed`);
  assert.equal(flag(args, "--permission-mode"), "plan");
  assert.equal(flag(args, "--effort"), "high");
});

test("the system prompt is only rebuilt each time when this Claude Code can do that", async t => {
  const { chat, runWith } = await boot(t, { old: true });
  await chat({ text: "old claude", mode: "code" });
  const args = await runWith("old claude");
  assert.ok(!args.includes("--system-prompt-snapshot"), "an older Claude Code doesn't know the flag, and would refuse to run");
  assert.equal(flag(args, "--permission-mode"), "auto");
});

test("an older message that names no mode runs as Claude Code", async t => {
  const { chat, runWith } = await boot(t);
  await chat({ text: "no mode given" });
  const args = await runWith("no mode given");
  assert.equal(flag(args, "--permission-mode"), "auto");
  assert.ok(!args.includes("--tools"));
});

test("attached files are saved on the computer and listed by path, with text files' contents in the message", async t => {
  const { chat, runWith, pc } = await boot(t);
  const files = [{ name: "notes.txt", type: "text/plain", data: Buffer.from("remember the milk").toString("base64") }, { name: "photo.png", type: "image/png", data: Buffer.from([137, 80, 78, 71]).toString("base64") }];
  // an older page may still say plain Claude: the files go to Claude Code all the same
  await chat({ text: "look at these", mode: "claude", files });
  await runWith("look at these");
  const prompt = pc.claudeRuns().find(r => r.prompt.includes("look at these")).prompt;
  assert.match(prompt, /Attached files:\n- uploads\/[^\n]*notes\.txt\n- uploads\/[^\n]*photo\.png/);
  assert.match(prompt, /<file name="uploads\/[^"]*notes\.txt">\nremember the milk\n<\/file>/);
  assert.doesNotMatch(prompt, /can't open them/);
});

test("the reply says how full the context is, from the last request and the model's window", async t => {
  const { chat } = await boot(t);
  const done = await chat({ text: "context run" });
  // the fake claude's last request: 11 in + 44 cache written + 333 cache read + 22 out, in a 200k window
  assert.deepEqual(done.message.meta.context, { used: 410, window: 200000 });
});

test("a real agent says it can do modes", async t => {
  const { site } = await boot(t);
  assert.equal((await site.api("/api/state")).body.agent.modes, true);
});
