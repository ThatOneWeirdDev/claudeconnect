// Claude Code's saved chats on a computer, shared with the site by the real agent: listed, opened, carried on in the folder
// each one began in, and kept in step. The site is the real worker, the agent is the real agent, and `claude` is a fake that
// leaves session files behind and only resumes a conversation from the folder it began in, as the real one does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, appendFileSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { startSite } from "../helpers/site.mjs";
import { makeComputer, ROOT } from "../helpers/computer.mjs";
import { startRepo } from "../helpers/github.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const A = "7c1d0e20-3333-4d4e-9f5a-000000000001";
const B = "7c1d0e20-3333-4d4e-9f5a-000000000002";
const C = "7c1d0e20-3333-4d4e-9f5a-000000000003";
const E = "7c1d0e20-3333-4d4e-9f5a-000000000005";

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await sleep(100);
  }
  throw new Error("timed out waiting for " + what);
}

let n = 0;
const entry = (type, cwd, extra) => ({ type, isSidechain: false, cwd, sessionId: "s", version: "2.1.294", uuid: "e" + ++n, timestamp: new Date(Date.now() - 3600000 + n * 1000).toISOString(), ...extra });
const q = (cwd, text) => entry("user", cwd, { message: { role: "user", content: text } });
const a = (cwd, text, blocks = []) => entry("assistant", cwd, { message: { id: "m" + n, role: "assistant", model: "claude-opus-5-5", content: [...blocks, { type: "text", text }] } });

// A conversation file where Claude Code would have put it: under the folder named after the one it ran in.
function save(pc, cwd, id, entries) {
  const dir = join(pc.home, ".claude", "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  const file = join(dir, id + ".jsonl");
  writeFileSync(file, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return file;
}

async function boot(t, { history, fixtures } = {}) {
  const github = await startRepo(ROOT);
  const site = await startSite({ appVersion: "1.5.0", vars: { SYNC_MIN_MS: "0" } });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: github.url, oldVersion: "1.5.0" });
  const ws = pc.config.workspace;
  const shop = join(pc.home, "shop");
  const gone = join(pc.home, "gone-project"); // never created: a project that has since been deleted
  mkdirSync(shop, { recursive: true });
  if (history) writeFileSync(join(pc.dir, "config.json"), JSON.stringify({ ...pc.config, history }, null, 2));
  const files = fixtures ? fixtures({ pc, ws, shop, gone }) : {};
  const agent = pc.startAgent();
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
    await github.close();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  const list = async () => (await site.api("/api/chats")).body.chats;
  const send = async body => {
    const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ model: "claude-opus-5-5", ...body }) });
    return (await res.text()).trim().split("\n").map(l => JSON.parse(l)).find(l => l.type === "done");
  };
  const open = async id => (await site.api(`/api/chats/${id}`));
  return { site, pc, ws, shop, gone, files, list, send, open };
}

const standard = ({ pc, ws, shop, gone }) => ({
  a: save(pc, ws, A, [q(ws, "Plan the quarterly report"), a(ws, "Here is a plan.", [{ type: "tool_use", id: "t1", name: "Read", input: { file_path: join(ws, "report.md") } }]), q(ws, "Make it shorter"), a(ws, "Shorter plan.")]),
  b: save(pc, shop, B, [q(shop, "Why is checkout slow?"), a(shop, "The cart query has no index.")]),
  c: save(pc, gone, C, [q(gone, "An old project"), a(gone, "Remembered.")]),
  empty: save(pc, ws, E, [entry("mode", ws, { mode: "normal" })])
});

test("the computer's real chats are listed: working folder plain, other projects with their folder's name", async t => {
  const { list } = await boot(t, { fixtures: standard });
  const chats = await until(async () => {
    const l = await list();
    return l.length >= 3 ? l : null;
  }, "the chats to be listed");
  const by = Object.fromEntries(chats.map(c => [c.id, c]));
  assert.deepEqual(Object.keys(by).sort(), [A, B, C].sort(), "and not the file with nothing in it");
  assert.deepEqual([by[A].title, by[A].folder], ["Plan the quarterly report", ""]);
  assert.deepEqual([by[B].title, by[B].folder], ["Why is checkout slow?", "shop"]);
  assert.deepEqual([by[C].title, by[C].folder], ["An old project", "gone-project"]);
  assert.ok(chats.every(c => c.computer === 1));
  assert.ok(!JSON.stringify(chats).includes("/ws") && !JSON.stringify(chats).includes(".claude"), "no paths");
});

test("opening one shows its conversation as it was, tools and all", async t => {
  const { list, open } = await boot(t, { fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
  const r = await open(A);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(r.body.messages.map(m => [m.role, m.content]), [["user", "Plan the quarterly report"], ["assistant", "Here is a plan."], ["user", "Make it shorter"], ["assistant", "Shorter plan."]]);
  assert.deepEqual(r.body.messages[1].meta.tools.map(x => x.label), ["Read report.md"]);
  assert.equal(r.body.chat.title, "Plan the quarterly report");
  assert.equal((await open(B)).body.chat.folder, "shop");
});

test("carrying on a chat from another project runs Claude Code in that project's folder, and it stays one conversation", async t => {
  const { pc, shop, list, open, send, files } = await boot(t, { fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
  await open(B);
  const done = await send({ chatId: B, text: "carry on in the shop", files: [{ name: "notes.txt", type: "text/plain", data: Buffer.from("remember the milk").toString("base64") }] });
  assert.equal(done.message.meta.error, null, JSON.stringify(done.message.meta));
  const runs = pc.claudeRuns().filter(r => r.prompt.includes("carry on in the shop"));
  assert.equal(runs.length, 1, "one run, no starting over");
  const args = runs[0].args;
  assert.equal(args[args.indexOf("--resume") + 1], B, "it resumes the conversation");
  assert.ok(!args.includes("--session-id"));
  assert.equal(realpathSync(runs[0].cwd), realpathSync(shop), "from the folder it began in");
  // files go where Claude Code can read them from that folder: by full path, not a path relative to the working folder
  assert.match(runs[0].prompt, /Attached files:\n- \/[^\n]*\/ws\/uploads\/[^\n]*notes\.txt/);
  assert.match(runs[0].prompt, /<file name="[^"]*notes\.txt">\nremember the milk\n<\/file>/);
  // the conversation grew on the computer (the fake left the question and answer in the file) and the site knows it already has them
  const view = await open(B);
  assert.deepEqual(view.body.messages.map(m => [m.role, m.content]).slice(0, 2), [["user", "Why is checkout slow?"], ["assistant", "The cart query has no index."]]);
  assert.equal(view.body.messages.filter(m => m.role === "user").length, 2, "nothing repeated");
  assert.equal(view.body.messages.filter(m => m.role === "assistant").length, 2);
  const text = readFileSync(files.b, "utf8");
  assert.equal(text.trim().split("\n").length, 4, "the same file, two more entries");
});

test("carrying on a chat from the working folder runs there", async t => {
  const { pc, ws, list, open, send } = await boot(t, { fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
  await open(A);
  const done = await send({ chatId: A, text: "and a third version" });
  assert.equal(done.message.meta.error, null);
  const run = pc.claudeRuns().find(r => r.prompt.includes("and a third version"));
  assert.equal(realpathSync(run.cwd), realpathSync(ws));
  assert.equal(run.args[run.args.indexOf("--resume") + 1], A);
});

test("a chat whose project folder is gone says so instead of starting a different conversation", async t => {
  const { pc, list, open, send } = await boot(t, { fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
  assert.equal((await open(C)).status, 200, "it can still be read");
  const done = await send({ chatId: C, text: "are you still there?" });
  assert.match(done.message.meta.error, /was started in .*gone-project, which isn't on this computer anymore/);
  assert.equal(pc.claudeRuns().filter(r => r.prompt.includes("are you still there?")).length, 0, "Claude Code wasn't run at all");
});

test("what is added in the terminal shows up the next time the chat is opened", async t => {
  const { ws, list, open, files } = await boot(t, { fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
  assert.equal((await open(A)).body.messages.length, 4);
  appendFileSync(files.a, [q(ws, "Now add a budget"), a(ws, "Budget added.", [{ type: "tool_use", id: "t2", name: "Write", input: { file_path: join(ws, "budget.md") } }])].map(e => JSON.stringify(e)).join("\n") + "\n");
  const r = await open(A);
  assert.deepEqual(r.body.messages.slice(4).map(m => [m.role, m.content]), [["user", "Now add a budget"], ["assistant", "Budget added."]]);
  assert.deepEqual(r.body.messages[5].meta.tools.map(x => x.label), ["Wrote budget.md"]);
  assert.equal((await open(A)).body.messages.length, 6, "and not again");
});

test("a chat started on the site is one of Claude Code's own, listed once, and can be opened where it is", async t => {
  const { pc, list, send, open } = await boot(t, { fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
  const done = await send({ text: "started on the site" });
  assert.equal(done.message.meta.error, null);
  const run = pc.claudeRuns().find(r => r.prompt.includes("started on the site"));
  const sid = run.args[run.args.indexOf("--session-id") + 1];
  const chat = (await list()).find(c => c.title === "started on the site");
  assert.ok(chat && chat.id !== sid, "the site's own chat keeps its own id");
  await sleep(1500); // the computer tells the site about the new file
  const after = await list();
  assert.equal(after.filter(c => c.id === sid).length, 0, "not listed a second time as the computer's");
  assert.equal(after.length, 4);
  // continuing it from the site later works from the same folder, and sees what the terminal added
  const file = join(pc.home, ".claude", "projects", pc.config.workspace.replace(/[^A-Za-z0-9]/g, "-"), sid + ".jsonl");
  appendFileSync(file, [q(pc.config.workspace, "typed in the terminal"), a(pc.config.workspace, "heard in the terminal")].map(e => JSON.stringify(e)).join("\n") + "\n");
  const view = await open(chat.id);
  assert.deepEqual(view.body.messages.map(m => m.content), ["started on the site", "You said: started on the site", "typed in the terminal", "heard in the terminal"]);
});

test("the computer can limit sharing to the working folder: other projects aren't listed, opened or continued", async t => {
  const { pc, site, list, open, send } = await boot(t, { history: "workspace", fixtures: standard });
  const chats = await until(async () => {
    const l = await list();
    return l.length ? l : null;
  }, "the list");
  assert.deepEqual(chats.map(c => c.id), [A]);
  assert.equal((await open(B)).status, 404, "not listed, so not there to open");
  // a chat that was already on the site (shared earlier, say, while it was set to share everything) can't be carried on either
  await site.seed({ chats: [{ id: B, title: "Why is checkout slow?", created: Date.now() - 5000, updated: Date.now() - 5000 }] });
  const done = await send({ chatId: B, text: "try to continue" });
  assert.match(done.message.meta.error, /started outside .*, and TestConnect is set to only open chats from there/);
  assert.equal(pc.claudeRuns().filter(r => r.prompt.includes("try to continue")).length, 0);
  assert.equal((await site.api("/api/state")).body.agent.history, true);
});

test("the computer can turn sharing off: nothing is listed, and the site's own chats still work", async t => {
  const { site, list, send } = await boot(t, { history: "off", fixtures: standard });
  await sleep(1500);
  assert.deepEqual(await list(), []);
  assert.equal((await site.api("/api/state")).body.agent.history, false);
  const done = await send({ text: "still works" });
  assert.equal(done.message.meta.error, null);
  assert.equal((await list()).length, 1);
});

test("something that isn't a setting we know is the same as the usual one", async t => {
  const { list } = await boot(t, { history: "everything please", fixtures: standard });
  await until(async () => (await list()).length >= 3, "the list");
});
