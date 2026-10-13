// Claude Code asking for permission while nobody is at the terminal: the real agent, a fake `claude` that asks through
// --permission-prompt-tool like the real one, and the real permit.mjs in between. The question shows on the site over the
// chat, the answer given there goes back, and Claude Code carries on with it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";

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

async function boot(t) {
  const site = await startSite({ appVersion: "2.0.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9", oldVersion: "2.0.0" });
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  return { site, pc };
}

// Sends a message and reads the reply as it streams, answering the question that comes up with `answer`.
async function ask(site, text, answer) {
  const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text, model: "claude-opus-5-5", perm: "default" }) });
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
      if (ev.type === "remote" && answer) {
        // a page opening the chat now sees the same question
        const chatId = events.find(e => e.type === "meta").chat.id;
        const open = (await site.api(`/api/chats/${chatId}`)).body;
        assert.equal(open.partial.remote.id, ev.remote.id);
        const r = await site.post("/api/remote", { chatId, id: ev.remote.id, answer });
        assert.equal(r.status, 200, r.text);
      }
    }
  }
  return events;
}

test("Claude Code asks on the site before running a command, and goes by the answer", async t => {
  const { site, pc } = await boot(t);
  assert.equal((await site.api("/api/state")).body.agent.ask, true, "this Claude Code can ask");

  const events = await ask(site, "this needs permission please", "allow");
  const q = events.find(e => e.type === "remote").remote;
  assert.equal(q.kind, "permission");
  assert.equal(q.title, "Run a command: Clean the build folder");
  assert.equal(q.detail, "rm -rf build");
  assert.ok(events.some(e => e.type === "remote_done" && e.id === q.id), "the window closes once it's answered");
  const done = events.find(e => e.type === "done").message;
  assert.equal(done.content, "Permission: allow");
  // Claude Code was started asking through ClaudeConnect, and with the permission mode the page asked for
  const run = pc.claudeRuns().find(r => r.prompt.includes("needs permission"));
  const flag = name => run.args[run.args.indexOf(name) + 1];
  assert.equal(flag("--permission-prompt-tool"), "mcp__claudeconnect__approve");
  assert.equal(flag("--permission-mode"), "default");
  assert.ok(!run.args.includes("--permission-prompts"), "nothing is skipped when someone can be asked");

  const no = await ask(site, "this needs permission too", "deny");
  assert.equal(no.find(e => e.type === "done").message.content, "Permission: deny: The person using ClaudeConnect said no to this.");
});

test("an answer for a question that's gone, or nonsense, changes nothing", async t => {
  const { site } = await boot(t);
  const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "plain one", model: "claude-opus-5-5" }) });
  const lines = (await res.text()).trim().split("\n").map(l => JSON.parse(l));
  const chatId = lines.find(l => l.type === "meta").chat.id;
  assert.equal((await site.post("/api/remote", { chatId, id: "nope", answer: "allow" })).status, 409, "nothing is waiting");
  assert.equal((await site.post("/api/remote", { chatId: "x", id: "nope", answer: "allow" })).status, 409);
});
