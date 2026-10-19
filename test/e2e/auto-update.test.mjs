// Updating by itself: a new release installs without anyone asking, only when it needs nothing from the person and nothing is
// being written; the updater waits for quiet moments; messages sent while the computer restarts wait for the new program.
// The computer here is a stand-in agent, so every step can be watched.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent, AGENT_SECRET } from "../helpers/site.mjs";
import { openPage, findChromium } from "../helpers/browser.mjs";

const CHROME = await findChromium();

const RELEASE = { name: "claudeconnect", version: "1.2.0", released: "2026-10-08", notes: ["Something new"], files: {}, manual: [] };
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function ready(t, { release = RELEASE, vars = {} } = {}) {
  const s = await startSite({ release, appVersion: "1.1.0", vars: { AUTO_UPDATE: "on", AUTO_LOOK_MS: "0", ...vars } });
  t.after(() => s.stop());
  await s.claim();
  return s;
}
const agentOf = (s, extra = {}) => connectAgent(s, { agent: "1.1.0", caps: ["update", "admin", "limits", "modes", "history"], ...extra });
const progress = (s, body) => s.mf.dispatchFetch(s.origin + "/agent/progress", { method: "POST", headers: { "content-type": "application/json", "cf-access-token": s.jwt, "x-chatgql-key": AGENT_SECRET }, body: JSON.stringify(body) }).then(r => r.json());
const quiet = (agent, ms = 600) => agent.next(m => m.type === "update", ms).then(() => assert.fail("an update started"), e => assert.match(e.message, /timed out/));
// a reply that waits on the computer until the test finishes it
async function startReply(s, agent, text = "hello") {
  const res = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text, model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run", 5000);
  return { run, finish: async () => { agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "hi", started: true, tools: [] }); await (await res).text(); } };
}

test("a release that needs nothing from the person installs by itself once the computer is there, and the page is told", async t => {
  const s = await ready(t);
  const agent = await agentOf(s);
  const m = await agent.next(x => x.type === "update", 5000);
  assert.equal(m.to, "1.2.0");
  const u = (await s.api("/api/update")).body;
  assert.equal(u.run.state, "running");
  assert.equal(u.run.auto, true);
  assert.equal(u.run.by, "");
  assert.equal(u.auto, true);
  assert.deepEqual(u.manual, []);
});

test("not while a reply is being written: it waits, and starts once the reply is done", async t => {
  const s = await ready(t, { release: null });
  const agent = await agentOf(s);
  const reply = await startReply(s, agent);
  // the release turns up while the reply is being written
  s.release = RELEASE;
  agent.send({ type: "release", repo: "ThatOneWeirdDev/claudeconnect", ref: "main", release: RELEASE });
  await quiet(agent);
  await reply.finish();
  assert.equal((await agent.next(x => x.type === "update", 5000)).to, "1.2.0");
});

test("not when the release needs something from the person, says why, or doesn't say; not when it's turned off", async t => {
  const why = "It needs your Mac's password to turn on something new.";
  const gated = await ready(t, { release: { ...RELEASE, manual: [{ since: "1.2.0", why }] } });
  let agent = await agentOf(gated);
  await quiet(agent);
  const u = (await gated.api("/api/update")).body;
  assert.deepEqual(u.manual, [why]);
  assert.equal(u.run, null);
  // a gate from before what's installed doesn't hold anything back
  const old = await ready(t, { release: { ...RELEASE, manual: [{ since: "1.0.5", why }] } });
  agent = await agentOf(old);
  assert.equal((await agent.next(x => x.type === "update", 5000)).to, "1.2.0");
  // a manifest that doesn't say whether it can (an older copy, or passed on by an older program): it waits
  const unknown = await ready(t, { release: { ...RELEASE, manual: undefined } });
  agent = await agentOf(unknown);
  await quiet(agent);
  assert.equal((await unknown.api("/api/update")).body.manual, null);
  // turned off in Settings: it waits; turned on again: it starts
  const off = await ready(t);
  assert.equal((await off.post("/api/prefs", { autoUpdate: false })).body.autoUpdate, false);
  agent = await agentOf(off);
  await quiet(agent);
  assert.equal((await off.api("/api/update")).body.auto, false);
  assert.equal((await off.post("/api/prefs", { autoUpdate: true })).body.autoUpdate, true);
  assert.equal((await agent.next(x => x.type === "update", 5000)).to, "1.2.0");
});

test("one that didn't start isn't tried again for that version for a while; a newer version is", async t => {
  const s = await ready(t, { vars: { AUTO_RETRY_MS: "3600000" } });
  const agent = await agentOf(s);
  const first = await agent.next(x => x.type === "update", 5000);
  agent.send({ type: "update_ack", id: first.id, ok: false, error: "Not now." });
  await sleep(100);
  assert.equal((await s.api("/api/update")).body.run.state, "error");
  agent.send({ type: "release", repo: "ThatOneWeirdDev/claudeconnect", ref: "main", release: RELEASE });
  await quiet(agent);
  const newer = { ...RELEASE, version: "1.2.1" };
  s.release = newer;
  agent.send({ type: "release", repo: "ThatOneWeirdDev/claudeconnect", ref: "main", release: newer });
  assert.equal((await agent.next(x => x.type === "update", 5000)).to, "1.2.1");
});

test("the updater waits while a reply is being written, and a message sent while the computer restarts waits for the new program", async t => {
  const s = await ready(t);
  let agent = await agentOf(s);
  const { id } = await agent.next(x => x.type === "update", 5000);
  // a reply started after the update did: the site and the computer wait for it
  const reply = await startReply(s, agent, "still talking");
  assert.equal((await progress(s, { id, step: "site", status: "active" })).busy, true);
  assert.equal((await s.api("/api/update")).body.run.waiting, true);
  await reply.finish();
  assert.equal((await progress(s, { id, step: "site", status: "active" })).busy, false);
  await progress(s, { id, step: "site", status: "done" });
  // quiet: the computer's program restarts, and from now on messages wait for the new one
  assert.equal((await progress(s, { id, step: "computer", status: "active" })).busy, false);
  assert.equal((await s.api("/api/update")).body.run.restarting, true);
  // the old program is still connected for a moment: a message now doesn't go to it
  const sent = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "during the restart", model: "claude-opus-5-5" }) });
  await assert.rejects(agent.next(m => m.type === "run", 700), /timed out/);
  agent.close();
  await sleep(200);
  // the new version connects: the update is done, and the message goes to it
  agent = await agentOf(s, { agent: "1.2.0" });
  const run = await agent.next(m => m.type === "run", 5000);
  assert.equal(run.prompt, "during the restart");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "answered by the new version", started: true, tools: [] });
  const lines = (await (await sent).text()).trim().split("\n").map(l => JSON.parse(l));
  assert.equal(lines.at(-1).message.content, "answered by the new version");
  const u = (await s.api("/api/update")).body;
  assert.equal(u.run.state, "done");
  assert.equal(u.run.auto, true);
});

test("in the page, one that starts by itself says an update is coming and doesn't pause messages; the switch is in Updates", { skip: !CHROME && "needs a Chromium" }, async t => {
  const s = await ready(t);
  const agent = await agentOf(s);
  await agent.next(x => x.type === "update", 5000);
  const page = await openPage(s.origin + "/", { width: 1280, height: 800 });
  t.after(() => page.close());
  await page.until(`!document.getElementById("updatePill").hidden && document.getElementById("pillText").textContent`, "the pill");
  assert.equal(await page.evaluate(`document.getElementById("pillText").textContent`), "Update coming");
  assert.match(await page.evaluate(`document.querySelector(".toast") ? document.querySelector(".toast").textContent : ""`), /installing in the background[\s\S]*reload once it's done/);
  // nothing paused: no notice over the message box, and a message can be sent
  assert.doesNotMatch(await page.evaluate(`document.getElementById("heroSub").textContent`), /paused/);
  await page.evaluate(`(() => { const i = document.getElementById("input"); i.focus(); i.value = "still here"; i.dispatchEvent(new Event("input", { bubbles: true })); })()`);
  assert.equal(await page.evaluate(`document.getElementById("sendBtn").disabled`), false);
  await page.evaluate(`document.getElementById("sendBtn").click()`);
  const run = await agent.next(m => m.type === "run", 5000);
  assert.equal(run.prompt, "still here");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "still answering", started: true, tools: [] });
  await page.until(`/still answering/.test(document.getElementById("thread").textContent)`, "the reply");
  // the switch, in Settings → Updates
  const toggle = `document.querySelector("#setBody [data-auto-up]")`;
  await page.evaluate(`document.getElementById("profileBtn").click()`);
  await page.until(`[...document.querySelectorAll("#pmenu button")].find(b => /Settings/.test(b.textContent))`, "the menu");
  await page.evaluate(`[...document.querySelectorAll("#pmenu button")].find(b => /Settings/.test(b.textContent)).click()`);
  await page.until(`document.querySelector('#setDlg [data-tab-set="updates"]')`, "Settings");
  await page.evaluate(`document.querySelector('#setDlg [data-tab-set="updates"]').click()`);
  await page.until(`${toggle}`, "the switch");
  assert.match(await page.evaluate(`document.getElementById("setPane").innerText`), /Installing v1\.2\.0 by itself[\s\S]*Keep chatting/, "the update shows in Updates, not over Settings");
  assert.equal(await page.evaluate(`${toggle}.getAttribute("aria-checked")`), "true");
  await page.evaluate(`${toggle}.click()`);
  await page.until(`${toggle} && ${toggle}.getAttribute("aria-checked") === "false"`, "the switch off");
  assert.equal((await s.api("/api/state")).body.prefs.autoUpdate, false);
});
