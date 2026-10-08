// The chats Claude Code has saved on the computer, on the site: listed next to the site's own, copied over when opened,
// kept up to date, and continued from where they left off. Here the site is the real worker (workerd) and the computer is
// a fake agent that answers the questions the site asks it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const S1 = "5b0c9a10-2222-4c3d-8e4f-000000000001";
const S2 = "5b0c9a10-2222-4c3d-8e4f-000000000002";
const S3 = "5b0c9a10-2222-4c3d-8e4f-000000000003";
const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

async function ready(t, vars = {}, hello) {
  const s = await startSite({ appVersion: "1.5.0", vars: { SYNC_MIN_MS: "0", ASK_TIMEOUT_MS: "1500", ...vars } });
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s, hello);
  return { s, agent };
}

const session = (id, title, updated, folder = "") => ({ id, title, folder, updated });
const turn = (sid, i, q, a, extra = {}) => [
  { id: `i-${sid}-${i}-u`, role: "user", content: q, created: T0 + i * 60000, meta: { files: [], model: null, effort: null, mode: "code", perm: "auto", imported: true } },
  { id: `i-${sid}-${i}-a`, role: "assistant", content: a, created: T0 + i * 60000 + 5000, meta: { model: "claude-opus-5-5", effort: null, mode: "code", perm: "auto", context: null, tools: [{ id: "t" + i, name: "Read", label: "Read a.txt", done: true, error: false }], error: null, denials: 0, ms: null, thinking: "hm", thinkingMs: null, artifacts: [], imported: true }, ...extra }
];
const answer = (sid, turns, mtime = T0 + 999, from = 0) => ({ ok: true, turns: from + turns.length, trimmed: 0, mtime, messages: turns.flatMap((x, i) => turn(sid, from + i, x[0], x[1])) });

// Open a chat and answer the question the site asks the computer while it does. Resolves with both sides.
async function open(s, agent, id, reply) {
  const pending = s.api(`/api/chats/${id}`);
  const ask = await agent.next(m => m.type === "transcript");
  agent.send({ type: "transcript", req: ask.req, sessionId: ask.sessionId, ...(await reply(ask)) });
  return { res: await pending, ask };
}
const list = async s => (await s.api("/api/chats")).body.chats;

async function siteChat(s, agent, text = "hello") {
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text, model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "hi back", started: true, tools: [], sync: { turns: 1, mtime: T0 } });
  await sent.text();
  return run;
}

test("the computer's chats are listed with the site's own, newest first, and what it sends is checked", async t => {
  const { s, agent } = await ready(t);
  const run = await siteChat(s, agent);
  const own = (await list(s))[0];
  agent.send({
    type: "sessions",
    sessions: [
      session(S1, "Fix the flaky upload test", T0 + 5000),
      session(S2, "Why is checkout slow?", T0 + 9000, "shop"),
      session(run.sessionId, "the site's own chat, seen from the computer", T0 + 99999999999), // already a chat here: not listed twice
      { id: "not-a-uuid", title: "x", updated: 1 },
      { id: S3, title: "bad time", updated: "soon" },
      { id: S3, title: "negative", updated: -5 },
      { title: "no id", updated: 5 },
      null, 5, "x", [],
      { id: `${S3.slice(0, 35)}'`, title: "quote", updated: 5 },
      session(S3.toUpperCase(), "t".repeat(500) + "\n  spaced   out", T0 + 1000, "f".repeat(200))
    ]
  });
  await sleep(150);
  const chats = await list(s);
  const byId = Object.fromEntries(chats.map(c => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [own.id, S1, S2, S3].sort(), "the junk was dropped, and the site's own chat is there once");
  assert.equal(byId[S2].computer, 1);
  assert.equal(byId[S2].folder, "shop");
  assert.equal(byId[S1].folder, "");
  assert.equal(byId[own.id].computer, undefined, "a chat started here isn't marked as the computer's");
  assert.ok(byId[S3].title.length <= 120 && !/\s{2}|\n/.test(byId[S3].title) && byId[S3].folder.length <= 60, "long titles and folders are cut");
  assert.deepEqual(chats.map(c => c.updated), [...chats.map(c => c.updated)].sort((a, b) => b - a), "newest first");
  // a new report replaces the old one
  agent.send({ type: "sessions", sessions: [session(S1, "Fix the flaky upload test", T0 + 5000)] });
  await sleep(150);
  assert.deepEqual((await list(s)).map(c => c.id).sort(), [own.id, S1].sort());
  agent.send({ type: "sessions", sessions: "nonsense" });
  agent.send({ type: "sessions", sessions: Array.from({ length: 800 }, (_, i) => session(`5b0c9a10-2222-4c3d-8e4f-${String(i).padStart(12, "0")}`, "c" + i, T0 + i)) });
  await sleep(300);
  assert.equal((await list(s)).length, 801, "all 800 of the computer's chats and the site's own are listed; none is dropped");
  agent.send({ type: "sessions", sessions: Array.from({ length: 3300 }, (_, i) => session(`5b0c9a10-3333-4c3d-8e4f-${String(i).padStart(12, "0")}`, "c" + i, T0 + i)) });
  await sleep(600);
  assert.equal((await list(s)).length, 3000, "an absurd number is cut at 3000, newest first");
});

test("opening a chat that is only on the computer copies it over, and it is the same chat from then on", async t => {
  const { s, agent } = await ready(t);
  agent.send({ type: "sessions", sessions: [session(S1, "Fix the flaky upload test", T0 + 90000, "shop")] });
  await sleep(150);
  const { res, ask } = await open(s, agent, S1, () => answer(S1, [["why is it flaky?", "A race in the upload."], ["fix it", "Done."]], T0 + 123));
  assert.equal(ask.sessionId, S1);
  assert.equal(ask.from, 0, "all of it, the first time");
  assert.equal(res.status, 200, res.text);
  const { chat, messages } = res.body;
  assert.equal(chat.id, S1);
  assert.equal(chat.title, "Fix the flaky upload test");
  assert.equal(chat.folder, "shop");
  assert.equal(chat.model, "claude-opus-5-5", "the model it last answered with");
  assert.equal(chat.mode, "code");
  assert.deepEqual(messages.map(m => [m.role, m.content]), [["user", "why is it flaky?"], ["assistant", "A race in the upload."], ["user", "fix it"], ["assistant", "Done."]]);
  assert.deepEqual(messages[1].meta.tools.map(x => x.label), ["Read a.txt"]);
  assert.equal(messages[1].meta.thinking, "hm");
  // it is a chat of this site now, listed once, no longer "the computer's"
  const chats = await list(s);
  assert.deepEqual(chats.filter(c => c.id === S1).map(c => [c.computer, c.folder, c.title]), [[undefined, "shop", "Fix the flaky upload test"]]);
  assert.equal(chats.length, 1);
});

test("a chat that grew on the computer since is caught up, once, and never twice", async t => {
  const { s, agent } = await ready(t);
  agent.send({ type: "sessions", sessions: [session(S1, "A chat", T0)] });
  await sleep(100);
  await open(s, agent, S1, () => answer(S1, [["q0", "a0"], ["q1", "a1"]]));
  // something was asked in the terminal in the meantime
  const next = await open(s, agent, S1, () => answer(S1, [["asked in the terminal", "answered there"]], T0 + 5000, 2));
  assert.equal(next.ask.from, 2, "from where it left off");
  assert.deepEqual(next.res.body.messages.map(m => m.content), ["q0", "a0", "q1", "a1", "asked in the terminal", "answered there"]);
  // the same turns sent again (a repeat or a slow answer) are not added a second time
  const again = await open(s, agent, S1, () => answer(S1, [["asked in the terminal", "answered there"]], T0 + 5000, 2));
  assert.equal(again.ask.from, 3);
  assert.equal(again.res.body.messages.length, 6);
  // nothing new: a short question and a short answer, nothing changes
  const quiet = await open(s, agent, S1, () => ({ ok: true, turns: 3, trimmed: 0, mtime: T0 + 5000, messages: [] }));
  assert.equal(quiet.res.body.messages.length, 6);
  // the chat moved up the list to when it was last used
  assert.equal((await list(s)).find(c => c.id === S1).updated, T0 + 2 * 60000 + 5000);
});

test("a chat from before this existed is taken to be complete as it is, and follows the computer from then on", async t => {
  const { s, agent } = await ready(t);
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "old chat", model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "old answer", started: true, tools: [] }); // an older program: no word on where the session stands
  await sent.text();
  const first = await open(s, agent, run.chatId, () => ({ ok: true, turns: 1, trimmed: 0, mtime: T0, messages: turn(run.sessionId, 0, "must not be added", "nor this").flat() }));
  assert.equal(first.ask.sessionId, run.sessionId, "it asks about the chat's session, not the chat");
  assert.ok(first.ask.from >= 1e6, "just how many questions there are");
  assert.deepEqual(first.res.body.messages.map(m => m.content), ["old chat", "old answer"], "nothing from the computer is added the first time");
  const next = await open(s, agent, run.chatId, () => answer(run.sessionId, [["added in the terminal", "yes"]], T0 + 10, 1));
  assert.equal(next.ask.from, 1);
  assert.deepEqual(next.res.body.messages.map(m => m.content), ["old chat", "old answer", "added in the terminal", "yes"]);
  // the computer's clock said the new turn happened before the site's own messages (they disagree by days here); it still comes after
  const times = next.res.body.messages.map(m => m.created);
  assert.ok(times.every((c, i) => i === 0 || c > times[i - 1]), "in order whatever the clocks say: " + times.join(", "));
});

test("what the computer sends is only ever used as text, in the right chat, within limits", async t => {
  const { s, agent } = await ready(t);
  agent.send({ type: "sessions", sessions: [session(S1, "Hostile", T0)] });
  await sleep(100);
  const good = turn(S1, 0, "ok question", "ok answer");
  const hostile = [
    ...good,
    { id: `i-${S2}-1-u`, role: "user", content: "for another session", created: T0, meta: {} },
    { id: `i-${S1}-2-x`, role: "system", content: "bad role", created: T0, meta: {} },
    { id: "evil", role: "user", content: "bad id", created: T0, meta: {} },
    { id: `i-${S1}-3-u`, role: "user", content: "no time", meta: {} },
    { id: `i-${S1}-4-u`, role: "user", content: { not: "text" }, created: T0 + 4, meta: {} },
    { id: `i-${S1}-5-u`, role: "user", created: T0 + 70000, content: "x".repeat(300000), meta: { model: "claude-ghost-9", perm: "bypassPermissions", effort: "max", mode: "claude", files: Array.from({ length: 30 }, (_, i) => ({ name: "f".repeat(500), size: "big", type: "t".repeat(500) })), extra: "<script>" } },
    { id: `i-${S1}-5-a`, role: "assistant", content: "answer", created: T0 + 70001, meta: { model: "claude-haiku-5-5", tools: Array.from({ length: 200 }, (_, i) => ({ id: "t" + i, name: "n".repeat(200), label: "l".repeat(500), done: false, error: 1 })).concat([null, { id: 5 }, "x"]), thinking: "t".repeat(90000), context: { used: 1, window: 2 }, artifacts: [{ id: "steal" }], error: "boom", denials: 99, ms: 5, mode: "claude" } }
  ];
  const { res } = await open(s, agent, S1, () => ({ ok: true, turns: 3, trimmed: 0, mtime: T0, messages: hostile }));
  assert.equal(res.status, 200, res.text);
  const m = res.body.messages;
  assert.deepEqual(m.map(x => x.id), [`i-${S1}-0-u`, `i-${S1}-0-a`, `i-${S1}-5-u`, `i-${S1}-5-a`], "only well-formed messages for this session");
  const [, , q, a] = m;
  assert.equal(q.content.length, 120000);
  assert.deepEqual([q.meta.model, q.meta.perm, q.meta.effort, q.meta.mode, q.meta.extra], [null, "auto", null, "code", undefined], "unknown values become the plain ones");
  assert.equal(q.meta.files.length, 10);
  assert.ok(q.meta.files.every(f => f.name.length <= 120 && f.size === 0 && f.type.length <= 80));
  assert.equal(a.meta.model, "claude-haiku-5-5");
  assert.equal(a.meta.tools.length, 80);
  assert.ok(a.meta.tools.every(x => x.name.length <= 60 && x.label.length <= 140 && x.done === true && x.error === true));
  assert.equal(a.meta.thinking.length, 20000);
  assert.deepEqual([a.meta.artifacts, a.meta.error, a.meta.denials, a.meta.context, a.meta.mode], [[], null, 0, null, "code"], "nothing that isn't text or a plain count is kept");
  // a flood is cut
  agent.send({ type: "sessions", sessions: [session(S2, "Flood", T0)] });
  await sleep(100);
  const flood = Array.from({ length: 900 }, (_, i) => turn(S2, i, "q", "a")).flat();
  const big = await open(s, agent, S2, () => ({ ok: true, turns: 900, trimmed: 0, mtime: T0, messages: flood }));
  assert.ok(big.res.body.messages.length <= 700);
});

test("when the computer can't hand a chat over, the page is told why", async t => {
  const { s, agent } = await ready(t, { ASK_TIMEOUT_MS: "400" });
  agent.send({ type: "sessions", sessions: [session(S1, "One", T0), session(S2, "Two", T0 + 1)] });
  await sleep(100);
  const gone = await open(s, agent, S1, () => ({ ok: false, error: "missing" }));
  assert.equal(gone.res.status, 404);
  assert.match(gone.res.body.error, /isn't on your computer anymore/);
  const refused = await open(s, agent, S1, () => ({ ok: false, error: "unavailable" }));
  assert.equal(refused.res.status, 404);
  assert.match(refused.res.body.error, /can't be opened from here/);
  const slow = await s.api(`/api/chats/${S2}`); // the agent never answers
  assert.equal(slow.status, 504);
  assert.equal(slow.body.code, "slow");
  assert.equal((await s.api("/api/chats/5b0c9a10-2222-4c3d-8e4f-0000000000ff")).status, 404, "a chat nobody has heard of");
  assert.equal((await s.api("/api/chats/not-a-chat")).status, 404);
  assert.equal((await list(s)).length, 2, "nothing was copied over by a failed attempt");
  agent.close();
  await sleep(150);
  const offline = await s.api(`/api/chats/${S1}`);
  assert.equal(offline.status, 503);
  assert.equal(offline.body.code, "offline");
  assert.equal((await list(s)).length, 2, "what was listed is still listed while the computer is off");
});

test("a computer program from before this can't hand chats over, and the page is told which it is", async t => {
  const { s } = await ready(t, {}, { caps: ["update", "admin", "limits", "modes"] });
  assert.equal((await s.api("/api/state")).body.agent.history, false);
  const r = await s.api(`/api/chats/${S1}`);
  assert.equal(r.status, 404, "and anyway nothing is listed by it");
  const { s: s2 } = await ready(t);
  assert.equal((await s2.api("/api/state")).body.agent.history, true);
});

test("answers to questions nobody asked, or asked twice, are ignored", async t => {
  const { s, agent } = await ready(t);
  agent.send({ type: "transcript", req: "never-asked", sessionId: S1, ok: true, turns: 1, messages: turn(S1, 0, "x", "y") });
  agent.send({ type: "sessions", sessions: [session(S1, "One", T0)] });
  await sleep(100);
  const pending = s.api(`/api/chats/${S1}`);
  const ask = await agent.next(m => m.type === "transcript");
  agent.send({ type: "transcript", req: ask.req, sessionId: S1, ...answer(S1, [["real", "answer"]]) });
  agent.send({ type: "transcript", req: ask.req, sessionId: S1, ...answer(S1, [["second answer to the same question", "ignored"]]) });
  const res = await pending;
  assert.deepEqual(res.body.messages.map(m => m.content), ["real", "answer"]);
});

test("sending in a chat that came from the computer carries on the same conversation, after catching up with it", async t => {
  const { s, agent } = await ready(t);
  agent.send({ type: "sessions", sessions: [session(S1, "From the terminal", T0, "shop")] });
  await sleep(100);
  await open(s, agent, S1, () => answer(S1, [["q0", "a0"]]));
  const sent = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ chatId: S1, text: "and now this", model: "claude-sonnet-5-5", mode: "code" }) });
  // first it asks what the computer holds, so the new message comes after everything there already
  const ask = await agent.next(m => m.type === "transcript");
  assert.equal(ask.sessionId, S1);
  assert.equal(ask.from, 1);
  agent.send({ type: "transcript", req: ask.req, sessionId: S1, ...answer(S1, [["typed in the terminal meanwhile", "answered there"]], T0 + 50, 1) });
  const run = await agent.next(m => m.type === "run");
  assert.equal(run.sessionId, S1, "the chat's id is the session's id");
  assert.equal(run.resume, true, "it picks the conversation up, it doesn't start a new one");
  assert.equal(run.chatId, S1);
  agent.send({ type: "done", runId: run.runId, chatId: S1, text: "done", started: true, tools: [], sync: { turns: 3, mtime: T0 + 100 } });
  await (await sent).text();
  const after = await open(s, agent, S1, () => ({ ok: true, turns: 3, trimmed: 0, mtime: T0 + 100, messages: [] }));
  assert.equal(after.ask.from, 3, "where the session stands after the reply is where the chat stands");
  assert.deepEqual(after.res.body.messages.filter(m => m.role === "user").map(m => m.content), ["q0", "typed in the terminal meanwhile", "and now this"]);
});

test("a slow or silent computer doesn't hold a message back for long", async t => {
  const { s, agent } = await ready(t, { ASK_TIMEOUT_MS: "300" });
  agent.send({ type: "sessions", sessions: [session(S1, "One", T0)] });
  await sleep(100);
  await open(s, agent, S1, () => answer(S1, [["q0", "a0"]]));
  const t0 = Date.now();
  const sent = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ chatId: S1, text: "go", model: "claude-opus-5-5" }) });
  await agent.next(m => m.type === "transcript"); // never answered
  const run = await agent.next(m => m.type === "run");
  assert.ok(Date.now() - t0 < 3000);
  agent.send({ type: "done", runId: run.runId, chatId: S1, text: "ok", started: true, tools: [] });
  await (await sent).text();
});

test("a chat that is answering isn't synced under its feet", async t => {
  const { s, agent } = await ready(t);
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "long one", model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run");
  const view = await s.api(`/api/chats/${run.chatId}`);
  assert.equal(view.status, 200);
  await sleep(150);
  await assert.rejects(() => agent.next(m => m.type === "transcript", 300), /timed out/, "no question was asked while it was running");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
  await sent.text();
});

test("deleting a chat hides it for good, even though Claude Code still has it, and nothing is deleted on the computer", async t => {
  const { s, agent } = await ready(t);
  const run = await siteChat(s, agent, "from the site");
  agent.send({ type: "sessions", sessions: [session(run.sessionId, "from the site", T0), session(S1, "Computer only", T0 + 1), session(S2, "Opened first", T0 + 2)] });
  await sleep(100);
  await open(s, agent, S2, () => answer(S2, [["q", "a"]]));
  assert.equal((await list(s)).length, 3);
  for (const id of [run.chatId, S1, S2]) assert.equal((await s.api(`/api/chats/${id}`, { method: "DELETE" })).body.ok, true, id);
  assert.deepEqual(await list(s), []);
  // the computer reports them all again, as it would: they're still there
  agent.send({ type: "sessions", sessions: [session(run.sessionId, "from the site", T0), session(S1, "Computer only", T0 + 1), session(S2, "Opened first", T0 + 2), session(S3, "A new one", T0 + 3)] });
  await sleep(100);
  assert.deepEqual((await list(s)).map(c => c.id), [S3], "only what wasn't deleted");
  assert.equal((await s.api(`/api/chats/${S1}`)).status, 404, "and a deleted one can't be opened");
  // nothing was asked of, or sent to, the computer except what was already there
  await assert.rejects(() => agent.next(m => m.type === "transcript", 200), /timed out/);
});

test("a chat that is only on the computer can be opened and deleted but not renamed until it's opened", async t => {
  const { s, agent } = await ready(t);
  agent.send({ type: "sessions", sessions: [session(S1, "Computer only", T0)] });
  await sleep(100);
  const early = await s.api(`/api/chats/${S1}`, { method: "PATCH", body: JSON.stringify({ title: "New name" }) });
  assert.equal(early.status, 409);
  assert.match(early.body.error, /Open this chat once/);
  await open(s, agent, S1, () => answer(S1, [["q", "a"]]));
  assert.equal((await s.api(`/api/chats/${S1}`, { method: "PATCH", body: JSON.stringify({ title: "New name" }) })).status, 200);
  assert.equal((await list(s))[0].title, "New name");
});

test("older chats keep working: the new columns are added to a site that already has chats", async t => {
  const { s, agent } = await ready(t);
  const run = await siteChat(s, agent, "a chat");
  const c = (await s.api(`/api/chats/${run.chatId}`)).body;
  assert.equal(c.chat.id, run.chatId);
  assert.equal(c.chat.session_id, undefined, "nothing about the session leaks to the page");
  assert.equal(c.chat.synced_turns, undefined);
  assert.equal(c.chat.synced_at, undefined);
  assert.equal(c.messages.length, 2);
});
