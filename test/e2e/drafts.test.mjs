// What's written in the message box but not sent stays, for each chat, in the browser: going to another chat, reloading or
// closing the page doesn't lose it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const type = text => `(() => { const i = document.getElementById("input"); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event("input", { bubbles: true })); })()`;
const box = `document.getElementById("input").value`;

test("unsent text is kept for each chat, through switching chats and reloading", { skip: !CHROME && "needs a Chromium" }, async t => {
  const site = await startSite({ appVersion: "2.1.0" });
  t.after(() => site.stop());
  await site.claim();
  await connectAgent(site, { agent: "2.1.0", caps: ["update", "admin", "limits", "computer", "plan", "modes", "history", "credits"], computer: { plan: "paid" } });
  const now = Date.now();
  await site.seed({
    chats: [{ id: "chat-aaaa-0001", title: "First chat", created: now - 2000, updated: now - 2000 }, { id: "chat-aaaa-0002", title: "Second chat", created: now - 1000, updated: now - 1000 }],
    messages: [{ id: "m1", chat: "chat-aaaa-0001", role: "user", content: "hi", created: now - 2000 }, { id: "m2", chat: "chat-aaaa-0002", role: "user", content: "hello", created: now - 1000 }]
  });
  const page = await openPage(site.origin + "/");
  t.after(() => page.close());
  await page.until(`document.querySelector('[data-open="chat-aaaa-0001"]')`, "the chat list");

  // a new chat's draft
  await page.evaluate(type("an idea for a new chat"));
  // over to a chat: its own box is empty, then it gets a draft of its own
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0001"]').click()`);
  await page.until(`location.pathname === "/c/chat-aaaa-0001" && document.title.startsWith("First chat")`, "the first chat");
  assert.equal(await page.evaluate(box), "");
  await page.evaluate(type("half a reply to the first chat\nwith two lines"));
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0002"]').click()`);
  await page.until(`location.pathname === "/c/chat-aaaa-0002" && document.title.startsWith("Second chat")`, "the second chat");
  assert.equal(await page.evaluate(box), "", "each chat has its own");

  // back again: each draft is where it was left
  await page.evaluate(`document.querySelector('[data-open="chat-aaaa-0001"]').click()`);
  await page.until(`document.title.startsWith("First chat")`, "the first chat again");
  assert.equal(await page.evaluate(box), "half a reply to the first chat\nwith two lines");
  await page.evaluate(`document.getElementById("newChat").click()`);
  await page.until(`location.pathname === "/"`, "a new chat");
  assert.equal(await page.evaluate(box), "an idea for a new chat");

  // reloading, on a chat and on a new chat
  await page.goto(site.origin + "/c/chat-aaaa-0001");
  await page.until(`document.title.startsWith("First chat")`, "the first chat after a reload");
  await sleep(300);
  assert.equal(await page.evaluate(box), "half a reply to the first chat\nwith two lines");
  await page.goto(site.origin + "/");
  await page.until(`document.getElementById("input")`, "the page");
  await sleep(1500);
  assert.equal(await page.evaluate(box), "an idea for a new chat");

  // emptied, it's gone
  await page.evaluate(type(""));
  await page.goto(site.origin + "/");
  await sleep(1500);
  assert.equal(await page.evaluate(box), "");
});
