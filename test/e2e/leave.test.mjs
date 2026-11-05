// Leaving a chat while its reply is still being written: the reply carries on (on the computer and on the site), the sidebar
// marks the chat until it's done, another chat can be used meanwhile, a question the left reply asks still shows and its answer
// goes back to it, and going back to the chat shows the whole reply.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const type = text => `(() => { const i = document.getElementById("input"); i.focus(); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const thread = `document.getElementById("thread").innerText`;
const live = id => `!!document.querySelector('.item[data-id="${id}"] i.live')`;
const toast = `[...document.querySelectorAll(".toast")].map(t => t.textContent).join(" ")`;

async function boot(t) {
  const site = await startSite({ appVersion: "2.18.0" });
  t.after(() => site.stop());
  await site.claim();
  const agent = await connectAgent(site, { agent: "2.18.0", caps: ["update", "admin", "limits", "computer", "remote", "modes", "credits", "ask"], computer: { plan: "paid" } });
  t.after(() => agent.close());
  const now = Date.now();
  await site.seed({
    chats: [{ id: "chat-aaaa-0001", title: "First chat", created: now - 2000, updated: now - 2000 }, { id: "chat-aaaa-0002", title: "Second chat", created: now - 1000, updated: now - 1000 }],
    messages: [{ id: "m1", chat: "chat-aaaa-0001", role: "user", content: "hi", created: now - 2000 }, { id: "m2", chat: "chat-aaaa-0002", role: "user", content: "hello", created: now - 1000 }]
  });
  const page = await openPage(site.origin + "/c/chat-aaaa-0001");
  t.after(() => page.close());
  await page.until(`document.title.startsWith("First chat") && document.querySelector('[data-open="chat-aaaa-0002"]')`, "the first chat");
  return { site, agent, page };
}

test("a chat can be left while it's answering: the reply carries on, the sidebar marks it, and it's all there on coming back", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { agent, page } = await boot(t);
  await page.evaluate(type("write a long story"));
  await page.evaluate(`document.getElementById("sendBtn").click()`);
  const run = await agent.next(m => m.type === "run");
  assert.equal(run.chatId, "chat-aaaa-0001");
  agent.send({ type: "delta", runId: run.runId, chatId: run.chatId, text: "Once upon " });
  await page.until(`/Once upon/.test(${thread})`, "the reply coming in");

  // over to the other chat, mid-reply
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0002"]').click()`);
  await page.until(`location.pathname === "/c/chat-aaaa-0002" && document.title.startsWith("Second chat")`, "the second chat");
  assert.doesNotMatch(await page.evaluate(toast), /Wait for this reply/);
  assert.doesNotMatch(await page.evaluate(thread), /Once upon/, "the first reply isn't drawn here");
  assert.equal(await page.evaluate(live("chat-aaaa-0001")), true, "the first chat is marked as answering");
  // the message box is free here: a second chat answers at the same time
  await page.evaluate(type("and a short one"));
  assert.equal(await page.evaluate(`document.getElementById("sendBtn").disabled`), false);
  await page.evaluate(`document.getElementById("sendBtn").click()`);
  const run2 = await agent.next(m => m.type === "run");
  assert.equal(run2.chatId, "chat-aaaa-0002");

  // the first goes on and finishes while it isn't shown; the second finishes here
  agent.send({ type: "delta", runId: run.runId, chatId: run.chatId, text: "a time." });
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "Once upon a time.", started: true, tools: [] });
  agent.send({ type: "delta", runId: run2.runId, chatId: run2.chatId, text: "Short." });
  agent.send({ type: "done", runId: run2.runId, chatId: run2.chatId, text: "Short.", started: true, tools: [] });
  await page.until(`/Short\\./.test(${thread})`, "the second reply");
  assert.doesNotMatch(await page.evaluate(thread), /Once upon/);
  await page.until(`!${live("chat-aaaa-0001")}`, "the first chat no longer marked");

  // back to the first: the whole reply
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0001"]').click()`);
  await page.until(`document.title.startsWith("First chat") && /Once upon a time\\./.test(${thread})`, "the first reply, whole");
  assert.match(await page.evaluate(thread), /write a long story/);

  // and a reply that's still going when you come back carries on being shown
  await page.evaluate(type("one more"));
  await page.evaluate(`document.getElementById("sendBtn").click()`);
  const run3 = await agent.next(m => m.type === "run");
  agent.send({ type: "delta", runId: run3.runId, chatId: run3.chatId, text: "Still " });
  await page.until(`/Still/.test(${thread})`, "the third reply coming in");
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0002"]').click()`);
  await page.until(`document.title.startsWith("Second chat")`, "away again");
  agent.send({ type: "delta", runId: run3.runId, chatId: run3.chatId, text: "going" });
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0001"]').click()`);
  await page.until(`document.title.startsWith("First chat") && /Still going/.test(${thread})`, "how far it got");
  assert.equal(await page.evaluate(`document.getElementById("sendBtn").dataset.stop`), "1", "with the stop button, while it runs");
  agent.send({ type: "delta", runId: run3.runId, chatId: run3.chatId, text: " on" });
  agent.send({ type: "done", runId: run3.runId, chatId: run3.chatId, text: "Still going on", started: true, tools: [] });
  await page.until(`/Still going on/.test(${thread}) && document.getElementById("sendBtn").dataset.stop !== "1"`, "the end of it");
});

test("a new chat can be left before its reply comes; it shows up in the sidebar, and its question can still be answered", { skip: !CHROME && "needs a Chromium" }, async t => {
  const { agent, page } = await boot(t);
  await page.evaluate(`document.getElementById("newChat").click()`);
  await page.until(`location.pathname === "/"`, "a new chat");
  await page.evaluate(type("plan a trip"));
  await page.evaluate(`document.getElementById("sendBtn").click()`);
  const run = await agent.next(m => m.type === "run");
  // straight on to another chat
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0002"]').click()`);
  await page.until(`document.title.startsWith("Second chat")`, "the second chat");
  await page.until(`${live(run.chatId)}`, "the new chat in the sidebar, answering");
  assert.match(await page.evaluate(`document.querySelector('.item[data-id="${run.chatId}"]').textContent`), /plan a trip/i);

  // it asks for permission while you're elsewhere: the question shows, saying which chat, and the answer goes to it
  agent.send({ type: "remote", runId: run.runId, chatId: run.chatId, id: "q1", kind: "permission", tool: "Bash", title: "Run a command", detail: "ls" });
  await page.until(`!document.getElementById("remote").hidden && /Run a command/.test(document.getElementById("rBody").innerText)`, "the question");
  assert.match(await page.evaluate(`document.getElementById("rBody").innerText`), /In “Plan a trip/i);
  await page.evaluate(`document.querySelector('#rBody [data-ranswer="allow"]').click()`);
  const answer = await agent.next(m => m.type === "remote_answer");
  assert.deepEqual([answer.runId, answer.id, answer.answer], [run.runId, "q1", "allow"]);
  await page.until(`document.getElementById("remote").hidden`, "the question gone");
  assert.equal(await page.evaluate(`location.pathname`), "/c/chat-aaaa-0002", "still where you were");

  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "Here's a plan.", started: true, tools: [] });
  await page.until(`!${live(run.chatId)}`, "done");
  await page.evaluate(`document.querySelector('[data-open="${run.chatId}"]').click()`);
  await page.until(`/Here's a plan\\./.test(${thread})`, "the reply, there");
});
