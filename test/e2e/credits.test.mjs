// Plan limits and usage credits ("extra usage"): what the site says about them, and the switch that keeps this site from
// using credits. The readings come from a stand-in agent, shaped like Claude Code's rate_limit_event.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const nowS = () => Math.floor(Date.now() / 1000);

async function ready(t) {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  return { s, agent };
}
async function reading(s, agent, limits) {
  agent.send({ type: "limits", limits });
  await sleep(150);
  return (await s.api("/api/limits")).body;
}
const windows = (five, week, at = nowS() + 3600) => ({ five_hour: { pct: five, resetsAt: at }, seven_day: { pct: week, resetsAt: nowS() + 4 * 86400 } });

test("past a plan limit with usage credits on isn't 'hit a limit': replies carry on, on credits", async t => {
  const { s, agent } = await ready(t);
  const l = await reading(s, agent, { status: "rejected", rateLimitType: "five_hour", resetsAt: nowS() + 3600, isUsingOverage: true, overageStatus: "allowed", windows: windows(100, 40) });
  assert.equal(l.over, true);
  assert.equal(l.limited, false, "the false alarm from before");
  assert.equal(l.credits.state, "using");
  assert.ok(Math.abs(l.resetsAt - (nowS() + 3600)) <= 2);
  // close to the spending limit set for them
  assert.equal((await reading(s, agent, { status: "rejected", resetsAt: nowS() + 3600, isUsingOverage: true, overageStatus: "allowed_warning", windows: windows(100, 40) })).credits.state, "near");
});

test("a real limit is one: rejected, credits off or used up, and the window hasn't reset", async t => {
  const { s, agent } = await ready(t);
  let l = await reading(s, agent, { status: "rejected", resetsAt: nowS() + 3600, isUsingOverage: false, overageStatus: "rejected", overageDisabledReason: "out_of_credits", windows: windows(100, 40) });
  assert.equal(l.limited, true);
  assert.equal(l.credits.state, "out");
  l = await reading(s, agent, { status: "rejected", resetsAt: nowS() + 3600, overageStatus: "rejected", overageDisabledReason: "org_level_disabled", windows: windows(100, 40) });
  assert.equal(l.limited, true);
  assert.deepEqual([l.credits.state, l.credits.reason], ["off", "org_level_disabled"]);
  // once the limiting window's reset time has passed, the old "rejected" says nothing anymore
  l = await reading(s, agent, { status: "rejected", resetsAt: nowS() - 5, overageStatus: "rejected", windows: windows(100, 40, nowS() - 5) });
  assert.equal(l.limited, false);
  assert.equal(l.windows.five_hour.reset, true);
});

test("an older program that only says 'rejected' needs a full window to count as a limit", async t => {
  const { s, agent } = await ready(t);
  let l = await reading(s, agent, { status: "rejected", windows: windows(60, 40) });
  assert.equal(l.limited, false, "nothing is full: not a limit");
  assert.equal(l.credits, null, "and nothing is known about credits");
  l = await reading(s, agent, { status: "rejected", windows: windows(100, 40) });
  assert.equal(l.limited, true);
});

test("under the limits, credits are just on or off, and junk about them is dropped", async t => {
  const { s, agent } = await ready(t);
  let l = await reading(s, agent, { status: "allowed", overageStatus: "allowed", isUsingOverage: false, windows: windows(20, 10) });
  assert.deepEqual([l.over, l.limited, l.credits.state], [false, false, "on"]);
  l = await reading(s, agent, { status: "allowed", overageStatus: "rejected", overageDisabledReason: "overage_not_provisioned", windows: windows(20, 10) });
  assert.equal(l.credits.state, "off");
  l = await reading(s, agent, { status: "allowed", overageStatus: "maybe", overageDisabledReason: "<b>x</b>", isUsingOverage: "yes", overageResetsAt: "soon", windows: windows(20, 10) });
  assert.equal(l.credits, null);
});

test("with usage credits turned off here, nothing is sent at a plan limit, nor to Fable, from any device", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s);
  assert.equal((await s.api("/api/state")).body.prefs.useCredits, true, "on unless turned off");
  const at = nowS() + 3600;
  await reading(s, agent, { status: "rejected", resetsAt: at, isUsingOverage: true, overageStatus: "allowed", windows: windows(100, 40) });

  // on: the message goes to the computer
  const sent = await s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "hello", model: "claude-opus-5-5" }) });
  const run = await agent.next(m => m.type === "run");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "hi", started: true, tools: [] });
  await sent.text();

  assert.equal((await s.post("/api/prefs", { useCredits: false })).body.useCredits, false);
  assert.equal((await s.api("/api/state")).body.prefs.useCredits, false, "kept on the site, so every device sees it");
  const held = await s.post("/api/send", { text: "again", model: "claude-opus-5-5" });
  assert.equal(held.status, 409);
  assert.equal(held.body.code, "credits_off");
  assert.equal(held.body.resetsAt, at);
  await assert.rejects(agent.next(m => m.type === "run", 300), /timed out/, "nothing reached the computer");

  // after the window resets, messages go again
  await reading(s, agent, { status: "allowed", windows: windows(3, 40) });
  const fable = await s.post("/api/send", { text: "big job", model: "claude-fable-5-1" });
  assert.equal(fable.status, 409, "Fable only runs on credits");
  const ok = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "after the reset", model: "claude-opus-5-5" }) });
  const run2 = await agent.next(m => m.type === "run");
  assert.equal(run2.prompt, "after the reset");
  agent.send({ type: "done", runId: run2.runId, chatId: run2.chatId, text: "hi", started: true, tools: [] });
  await (await ok).text();

  assert.equal((await s.post("/api/prefs", { useCredits: "no" })).body.useCredits, false, "only a true or false changes it");
});

test("Fable 5.1 is always there, and with no usage credits on the account it says so instead of sending", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const agent = await connectAgent(s, { caps: ["update", "admin", "limits", "modes", "credits", "computer"], computer: { autostart: false, credits: true, history: "all", workspace: "/w" } });
  const fable = text => s.post("/api/send", { text, model: "claude-fable-5-1" });
  const goes = async (text, model = "claude-fable-5-1") => {
    const sent = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text, model }) });
    const run = await agent.next(m => m.type === "run");
    assert.deepEqual([run.prompt, run.model], [text, model]);
    agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "ok", started: true, tools: [] });
    await (await sent).text();
  };
  const noCredits = async () => (await s.api("/api/state")).body.noCredits;

  // nothing said about credits yet: it's sent, with no setting needed
  assert.equal(await noCredits(), null);
  await goes("first");

  // Claude Code says they're used up
  await reading(s, agent, { status: "allowed", overageStatus: "rejected", overageDisabledReason: "out_of_credits", windows: windows(20, 10) });
  assert.equal((await noCredits()).why, "out");
  const held = await fable("big job");
  assert.equal(held.status, 409);
  assert.equal(held.body.code, "no_credits");
  assert.match(held.body.error, /^You have no usage credits left! Fable 5\.1 only runs on usage credits\./);
  await agent.next(m => m.type === "limits_refresh", 2000); // the computer reads the plan and the balance again
  await assert.rejects(agent.next(m => m.type === "run", 300), /timed out/, "nothing reached the computer");
  await goes("other models still go", "claude-opus-5-5");

  // not turned on for the account
  await reading(s, agent, { status: "allowed", overageStatus: "rejected", overageDisabledReason: "overage_not_provisioned", windows: windows(20, 10) });
  assert.match((await fable("again")).body.error, /^You have no usage credits! They aren't turned on for your Claude account/);

  // topped up: it goes again
  await reading(s, agent, { status: "allowed", overageStatus: "allowed", windows: windows(20, 10) });
  assert.equal(await noCredits(), null);
  await goes("after topping up");

  // the balance the computer read: nothing left, or usage credits off on the account
  agent.send({ type: "credits", credits: { extra: { enabled: true, limit: null, used: 0 }, balance: { amount: 0, currency: "USD", promos: [] } } });
  await sleep(150);
  assert.equal((await noCredits()).why, "none");
  assert.equal((await fable("broke")).body.code, "no_credits");
  agent.send({ type: "credits", credits: { extra: { enabled: false, limit: null, used: 0 }, balance: { amount: 500, currency: "USD", promos: [] } } });
  await sleep(150);
  assert.equal((await noCredits()).why, "off");
  agent.send({ type: "credits", credits: { extra: { enabled: true, limit: null, used: 0 }, balance: { amount: 0, currency: "USD", promos: [{ amount: 300, currency: "USD", expires: null, name: "Gift" }] } } });
  await sleep(150);
  assert.equal(await noCredits(), null, "promotional credit counts");
  await goes("on the gift");

  // a reply Claude turns away for want of credits says so plainly
  const sent = s.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "once more", model: "claude-fable-5-1" }) });
  const run = await agent.next(m => m.type === "run");
  agent.send({ type: "done", runId: run.runId, chatId: run.chatId, text: "", error: "API Error: 400 Your credit balance is too low to access this model.", started: false, tools: [] });
  await (await sent).text();
  const msgs = (await s.api(`/api/chats/${run.chatId}`)).body.messages;
  assert.match(msgs.at(-1).meta.error, /^You have no usage credits! Fable 5\.1 only runs on usage credits\./);
});

test("the computer passes on what Claude Code says about credits", async () => {
  // the agent's own reading of a rate_limit_event, lifted out and run on its own
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("../../agent/agent.mjs", import.meta.url), "utf8");
  const body = /function limitsFrom\(info\) \{[\s\S]*?\n\}\n/.exec(src)[0];
  const limitsFrom = new Function("LIMIT_KEYS", body + "return limitsFrom;")(["five_hour", "seven_day", "seven_day_overage_included"]);
  const r = limitsFrom({ status: "rejected", resetsAt: 1900000000, rateLimitType: "five_hour", utilization: 1, isUsingOverage: true, overageStatus: "allowed", overageResetsAt: 1901000000, overageDisabledReason: undefined, unifiedWindows: { five_hour: { utilization: 1.02, resetsAt: 1900000000 } } });
  assert.deepEqual(r, { windows: { five_hour: { pct: 102, resetsAt: 1900000000 } }, status: "rejected", rateLimitType: "five_hour", overageStatus: "allowed", resetsAt: 1900000000, overageResetsAt: 1901000000, isUsingOverage: true });
  assert.equal(limitsFrom({ status: "allowed" }), null, "no windows, nothing to report");
});
