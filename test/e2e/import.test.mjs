// Chats from claude.ai, from its data export: the page reads the export and sends the conversations to the site in batches.
// Here the batches are sent the way the page sends them, and the real worker stores and serves them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

const C1 = "1f6c2a3b-4d5e-4f70-8192-a3b4c5d6e7f1";
const C2 = "1f6c2a3b-4d5e-4f70-8192-a3b4c5d6e7f2";
const M = n => `9a8b7c6d-5e4f-4a3b-8c2d-${String(n).padStart(12, "0")}`;
const T0 = Date.UTC(2025, 2, 1, 9, 0, 0);

async function ready(t) {
  const s = await startSite({ appVersion: "1.7.0", vars: { ASK_TIMEOUT_MS: "300" } });
  t.after(() => s.stop());
  await s.claim();
  return s;
}
const conv = (id, title, msgs, extra = {}) => ({ id, title, created: T0, updated: T0 + msgs.length * 1000, messages: msgs.map(([role, content, more = {}], i) => ({ id: M(i + (extra.base || 0)), role, content, created: T0 + i * 1000, ...more })), ...extra });

test("a claude.ai export's conversations become chats, listed by when they were last used, and marked as from claude.ai", async t => {
  const s = await ready(t);
  const r = await s.post("/api/import", {
    conversations: [
      conv(C1, "Trip to Lisbon", [["user", "Plan three days in Lisbon", { files: [{ name: "flights.pdf", size: 1234 }] }], ["assistant", "Day one: Alfama.", { thinking: "they like walking" }]]),
      conv(C2, "", [["user", "What's a monad?"], ["assistant", "A monoid in the category of endofunctors."]])
    ]
  });
  assert.deepEqual(r.body, { ok: true, added: 2, updated: 0, skipped: 0 });
  const chats = (await s.api("/api/chats")).body.chats;
  assert.deepEqual(chats.map(c => [c.id, c.title, c.origin]), [[C1, "Trip to Lisbon", "claude.ai"], [C2, "What's a monad?", "claude.ai"]], "an untitled one is named after its first question");
  assert.equal(chats[0].updated, T0 + 2000);
  const open = (await s.api(`/api/chats/${C1}`)).body;
  assert.equal(open.chat.origin, "claude.ai");
  assert.equal(open.chat.mode, "claude", "it opens as a plain chat, like on claude.ai");
  assert.deepEqual(open.messages.map(m => [m.role, m.content]), [["user", "Plan three days in Lisbon"], ["assistant", "Day one: Alfama."]]);
  assert.deepEqual(open.messages[0].meta.files, [{ name: "flights.pdf", size: 1234, type: "" }]);
  assert.equal(open.messages[1].meta.thinking, "they like walking");
  assert.equal(open.messages[1].meta.origin, "claude.ai");
});

test("importing again adds only what's new, and a chat deleted here stays deleted", async t => {
  const s = await ready(t);
  const first = [["user", "hi"], ["assistant", "hello"]];
  await s.post("/api/import", { conversations: [conv(C1, "Hi", first), conv(C2, "Other", first, { base: 10 })] });
  assert.deepEqual((await s.post("/api/import", { conversations: [conv(C1, "Hi", first)] })).body, { ok: true, added: 0, updated: 0, skipped: 1 });
  const more = [...first, ["user", "and then?"], ["assistant", "and then this."]];
  assert.equal((await s.post("/api/import", { conversations: [conv(C1, "Hi", more)] })).body.updated, 1);
  assert.equal((await s.api(`/api/chats/${C1}`)).body.messages.length, 4);
  assert.equal((await s.api(`/api/chats/${C2}`)).status, 200);
  assert.equal((await s.api(`/api/chats/${C2}`, { method: "DELETE" })).status, 200);
  assert.equal((await s.post("/api/import", { conversations: [conv(C2, "Other", first, { base: 10 })] })).body.skipped, 1);
  assert.ok(!(await s.api("/api/chats")).body.chats.some(c => c.id === C2));
});

test("what an import sends is checked and capped, and a chat that didn't come from claude.ai is never touched", async t => {
  const s = await ready(t);
  await s.seed({ chats: [{ id: C1, title: "mine", created: T0, updated: T0 }], messages: [{ id: "u-1", chat: C1, role: "user", content: "keep me", created: T0 }] });
  const r = await s.post("/api/import", {
    conversations: [
      conv(C1, "takeover", [["user", "overwrite"]]),
      { id: "not-a-uuid", title: "x", messages: [{ role: "user", content: "x" }] },
      conv(C2, "x".repeat(500), [["system", "nope"], ["user", "y".repeat(200000)], ["assistant", 42], ["user", ""]]),
      null,
      "x"
    ]
  });
  assert.deepEqual(r.body, { ok: true, added: 1, updated: 0, skipped: 4 });
  const mine = (await s.api(`/api/chats/${C1}`)).body;
  assert.deepEqual(mine.messages.map(m => m.content), ["keep me"]);
  const c2 = (await s.api(`/api/chats/${C2}`)).body;
  assert.ok(c2.chat.title.length <= 120);
  assert.deepEqual(c2.messages.map(m => [m.role, m.content.length]), [["user", 120000]]);
  for (const bad of [{}, { conversations: "x" }, []]) assert.equal((await s.post("/api/import", bad)).status, 400);
  const huge = await s.asOwner("/api/import", { method: "POST", body: JSON.stringify({ conversations: [], pad: "z".repeat(8100000) }) });
  assert.equal(huge.status, 413);
  const anon = await s.mf.dispatchFetch(s.origin + "/api/import", { method: "POST", headers: { "x-test-anonymous": "1", "content-type": "application/json" }, body: "{}" });
  assert.equal(anon.status, 401, "only the owner can add chats");
});

test("the first reply in an imported chat reads the conversation so far, and the ones after carry on its own session", async t => {
  const s = await ready(t);
  const agent = await connectAgent(s);
  await s.post("/api/import", { conversations: [conv(C1, "Lisbon", [["user", "Plan three days in Lisbon", { files: [{ name: "flights.pdf", size: 1 }] }], ["assistant", "Day one: Alfama."]])] });
  const send = async text => {
    const res = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ chatId: C1, text, model: "claude-sonnet-5-5", mode: "claude" }) });
    const run = await agent.next(m => m.type === "run");
    agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
    await (await res).text();
    return run;
  };
  const first = await send("And day two?");
  assert.equal(first.resume, false, "a new Claude Code session");
  assert.match(first.prompt, /started on claude\.ai/);
  assert.match(first.prompt, /<user>\nPlan three days in Lisbon\n\(attached: flights\.pdf\)\n<\/user>\n<assistant>\nDay one: Alfama\.\n<\/assistant>/);
  assert.ok(first.prompt.endsWith("And day two?"), "the new message comes last");
  assert.ok(!first.prompt.includes("And day two?\n</user>"), "and isn't repeated inside the conversation");
  const msgs = (await s.api(`/api/chats/${C1}`)).body.messages;
  assert.equal(msgs[2].content, "And day two?", "the chat shows what was typed, not the conversation it was sent with");
  const second = await send("Day three?");
  assert.equal(second.resume, true);
  assert.equal(second.sessionId, first.sessionId);
  assert.equal(second.prompt, "Day three?");
});
