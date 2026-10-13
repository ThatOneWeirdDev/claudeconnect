// The real agent with a fake `claude`: a reply's thinking and text kept in the order they happened, and the usage credit
// balance read from Claude's account when that's turned on, with Anthropic's API stood in for by a local server.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { startSite } from "../helpers/site.mjs";
import { makeComputer } from "../helpers/computer.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const ORG = "0a1b2c3d-1111-4222-8333-444455556666";

async function until(fn, what, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = await fn().catch(() => null);
    if (v) return v;
    await sleep(150);
  }
  throw new Error("timed out waiting for " + what);
}

async function boot(t, { credits = false, anthropic = null } = {}) {
  const site = await startSite({ appVersion: "1.7.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  // on unless turned off: these tests say which
  const cfg = JSON.parse(pc.read("config.json"));
  cfg.credits = credits;
  writeFileSync(join(pc.dir, "config.json"), JSON.stringify(cfg));
  const env = { ...pc.env, CLAUDECONNECT_ANTHROPIC_API: anthropic || "http://127.0.0.1:9" };
  const { spawn } = await import("node:child_process");
  const agent = spawn(process.execPath, [join(pc.dir, "agent.mjs"), "run"], { env, stdio: "ignore" });
  t.after(async () => {
    agent.kill("SIGKILL");
    pc.cleanup();
    await site.stop();
  });
  await until(async () => (await site.api("/api/state")).body.agent.online, "the agent to connect");
  return { site, pc };
}

test("thinking that comes after text is shown after it, not merged into one block at the top", async t => {
  const { site } = await boot(t);
  const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "interleave please", model: "claude-opus-5-5" }) });
  const lines = (await res.text()).trim().split("\n").map(l => JSON.parse(l));
  // the stream itself comes in order
  const seq = lines.filter(l => l.type === "thinking" || l.type === "delta").map(l => l.type);
  assert.deepEqual(seq.filter((x, i) => x !== seq[i - 1]), ["thinking", "delta", "thinking", "delta"]);
  const done = lines.find(l => l.type === "done").message;
  assert.equal(done.content, "ok time for test 2\n\ndone");
  assert.equal(done.meta.thinking, "first thought\n\nsecond thought");
  assert.deepEqual(done.meta.parts.map(p => [p.t, p.n]), [["think", 13], ["text", 18], ["think", 16], ["text", 6]]);
  // and it's kept that way
  const chat = (await site.api(`/api/chats/${lines.find(l => l.type === "meta").chat.id}`)).body;
  assert.deepEqual(chat.messages[1].meta.parts, done.meta.parts);
});

test("with the balance turned on, the computer reads it from Claude's account with Claude Code's sign-in, and only the numbers reach the site", async t => {
  const seen = [];
  const api = http.createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization, beta: req.headers["anthropic-beta"] });
    res.setHeader("content-type", "application/json");
    // the shape of a live response: the Claude Code cloud-session promo comes as iguana_necktie, in dollars
    if (req.url === "/api/oauth/usage") return res.end(JSON.stringify({ five_hour: { utilization: 40 }, seven_day: { utilization: 10, resets_at: "2026-10-12T00:00:00Z" }, extra_usage: { is_enabled: true, monthly_limit: 5000, used_credits: 1234, utilization: 24.7 }, iguana_necktie: { utilization: 27.6, resets_at: "2026-11-05T07:59:00+00:00", limit_dollars: 100, used_dollars: 27.6, remaining_dollars: 72.4 }, omelette: null }));
    if (req.url === `/api/oauth/organizations/${ORG}/prepaid/credits`) return res.end(JSON.stringify({ amount: 2500, currency: "USD", promo_tranches: [{ remaining_amount_minor_units: 5000, currency: "USD", expires_at: "2026-12-01T00:00:00Z", name: "Welcome credit" }, { remaining_amount_minor_units: 0 }] }));
    res.statusCode = 404;
    res.end("{}");
  });
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  t.after(() => api.close());
  const { site, pc } = await boot(t, { credits: true, anthropic: `http://127.0.0.1:${api.address().port}` });
  // Claude Code's sign-in, where it keeps it on Linux and Windows
  mkdirSync(join(pc.home, ".claude"), { recursive: true });
  writeFileSync(join(pc.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test", refreshToken: "r", expiresAt: Date.now() + 3600e3 } }));
  writeFileSync(join(pc.home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: ORG } }));
  assert.equal((await site.api("/api/state")).body.agent.credits, true);
  assert.equal((await site.post("/api/limits/refresh")).status, 200);
  const c = await until(async () => (await site.api("/api/credits")).body, "the balance");
  assert.deepEqual(c.extra, { enabled: true, limit: 5000, used: 1234 });
  assert.equal(c.balance.amount, 2500);
  assert.deepEqual(c.dollars, [{ key: "iguana_necktie", limit: 10000, used: 2760, remaining: 7240, expires: Date.parse("2026-11-05T07:59:00+00:00") }], "the free cloud-session credit, $72.40 left of $100");
  assert.deepEqual(c.balance.promos, [{ amount: 5000, currency: "USD", expires: Date.parse("2026-12-01T00:00:00Z"), name: "Welcome credit" }]);
  assert.ok(seen.every(s => s.auth === "Bearer sk-ant-oat-test" && s.beta === "oauth-2025-04-20"));
  assert.ok(!JSON.stringify((await site.api("/api/state")).body).includes("sk-ant"), "the sign-in never reaches the site");
  assert.ok(!readFileSync(join(pc.dir, "agent.log"), "utf8").includes("sk-ant"));
});

test("the balance is always read, even on an install that turned it off before; with the sign-in expired, the site is told why and nothing is sent", async t => {
  const seen = [];
  const api = http.createServer((req, res) => {
    seen.push(req.url);
    res.end("{}");
  });
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  t.after(() => api.close());
  // credits: false is what `edit` or the site saved before there was no setting for it
  const { site, pc } = await boot(t, { credits: false, anthropic: `http://127.0.0.1:${api.address().port}` });
  assert.equal((await site.api("/api/state")).body.agent.credits, true);
  mkdirSync(join(pc.home, ".claude"), { recursive: true });
  writeFileSync(join(pc.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "old", expiresAt: Date.now() - 1000 } }));
  await site.post("/api/limits/refresh");
  const c = await until(async () => {
    const b = (await site.api("/api/credits")).body;
    return b && b.error === "expired" ? b : null;
  }, "a reading");
  assert.equal(c.error, "expired");
  assert.deepEqual(seen, [], "an expired sign-in isn't sent anywhere");
});

test("starting at login and the working folder change from the site, without a restart; the balance and the chat list aren't settings anymore", async t => {
  const { site, pc } = await boot(t, { credits: null });
  // what the computer says about itself comes in its hello, a moment after it connects
  let st = await until(async () => {
    const a = (await site.api("/api/state")).body.agent;
    return a.computer ? a : null;
  }, "the computer's hello");
  assert.equal(st.credits, true);
  // replies only ever come from Claude Code now: there's no plan to pick
  assert.equal(st.plan, undefined);
  assert.deepEqual([st.computer.autostart, st.computer.history, st.computer.plan], [false, "all", undefined]);
  // the old switches do nothing now
  for (const old of [{ credits: false }, { history: "off" }, { nonsense: true }]) assert.equal((await site.post("/api/computer", old)).status, 400, JSON.stringify(old));
  assert.notEqual(JSON.parse(pc.read("config.json")).credits, false, "nothing was turned off on the computer");
  // starting at login (a startup item), from the site
  const auto = await site.post("/api/computer", { autostart: true });
  assert.equal(auto.status, 200, auto.text);
  assert.equal(auto.body.computer.autostart, true);
  assert.ok(readFileSync(join(pc.home, ".config", "autostart", "claudeconnect-test-site.desktop"), "utf8").includes("agent.mjs"));
  assert.equal((await site.post("/api/computer", { autostart: false })).body.computer.autostart, false);
  // the working folder
  const folder = join(pc.home, "Projects", "new");
  const moved = await site.post("/api/computer", { workspace: folder });
  assert.equal(moved.status, 200, moved.text);
  assert.equal(moved.body.computer.workspace, folder);
  assert.equal(JSON.parse(pc.read("config.json")).workspace, folder);
  const bad = await site.post("/api/computer", { workspace: "relative/path" });
  assert.equal(bad.status, 400);
  assert.match(bad.body.error, /full path/);
  assert.equal(bad.body.computer.workspace, folder, "and it's left as it was");
  // a message now runs in the new folder
  const res = await site.asOwner("/api/send", { method: "POST", body: JSON.stringify({ text: "where am I", model: "claude-opus-5-5" }) });
  await res.text();
  assert.equal(pc.claudeRuns().pop().cwd, folder);
});

test("the site's name and logo set in Settings are kept on the computer for the next update and for edit", async t => {
  const { site, pc } = await boot(t, { credits: null });
  const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  assert.equal((await site.post("/api/site", { displayName: "Renamed", logo: { b64: PNG } })).status, 200);
  await until(async () => JSON.parse(pc.read("config.json")).displayName === "Renamed", "the computer to save the name");
  // the command follows the name, on the computer and on the site
  // (read again until whole: the program here may be writing it)
  const cfg = await until(async () => { const c = JSON.parse(pc.read("config.json")); return c.command === "Renamed" && c; }, "the command to be renamed");
  assert.equal(cfg.shim, join(pc.home, "bin", "Renamed"));
  assert.ok(existsSync(cfg.shim) && !existsSync(join(pc.home, "bin", "TestSite")), "the new command, and not the old one");
  assert.match(pc.log(), /The command is Renamed now, to match the site's name\. TestSite is gone\./);
  await until(async () => (await site.api("/api/state")).body.site.command === "Renamed", "the site to know the new command");
  // the tab title is its own, kept on the computer too; empty, it's the name again
  assert.equal((await site.post("/api/site", { tab: "  My\ttab  " })).body.tab, "My tab");
  await until(async () => JSON.parse(pc.read("config.json")).tabTitle === "My tab", "the computer to save the tab title");
  assert.equal((await site.post("/api/site", { tab: "" })).body.tab, "");
  await until(async () => JSON.parse(pc.read("config.json")).tabTitle === undefined, "the tab title to be dropped");
  // a name another program already answers to leaves the command as it is
  assert.equal((await site.post("/api/site", { displayName: "git" })).status, 200);
  await until(async () => /git is already a command on this computer, so yours stays Renamed\./.test(pc.log()), "the clash to be noted");
  assert.equal((await until(async () => JSON.parse(pc.read("config.json")), "the config")).command, "Renamed");
  const brand = await until(async () => JSON.parse(pc.read("site/brand.js").replace(/^export default /, "").replace(/;\s*$/, "")), "the brand file");
  assert.equal(brand.logo.b64, PNG);
  assert.equal(brand.favicon, null);
});

test("limit resets on the account are listed, and one can be used from the site", async t => {
  const claims = [];
  let left = 1;
  const api = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      if (req.url.startsWith("/api/oauth/usage")) return res.end(JSON.stringify({ five_hour: { utilization: 100 }, extra_usage: { is_enabled: false }, cedar_ember: { eligible: true, at_limit: true, grants: [{ id: "launch_reset", label: "Limit reset", resets_total: 1, resets_left: left, usable_now: left > 0, use_requires_limit: true, paused: false, clears: ["five_hour", "seven_day"] }], next_grant_id: "launch_reset" } }));
      if (req.method === "POST" && req.url === `/api/organizations/${ORG}/reset_rate_limits`) {
        claims.push({ auth: req.headers.authorization, body: JSON.parse(body) });
        left = 0;
        return res.end(JSON.stringify({ result: "reset", resets_left: 0, cleared: ["five_hour", "seven_day"] }));
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  await new Promise(r => api.listen(0, "127.0.0.1", r));
  t.after(() => api.close());
  const { site, pc } = await boot(t, { credits: true, anthropic: `http://127.0.0.1:${api.address().port}` });
  mkdirSync(join(pc.home, ".claude"), { recursive: true });
  writeFileSync(join(pc.home, ".claude", ".credentials.json"), JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat-test", expiresAt: Date.now() + 3600e3 } }));
  writeFileSync(join(pc.home, ".claude.json"), JSON.stringify({ oauthAccount: { organizationUuid: ORG } }));
  await site.post("/api/limits/refresh");
  const c = await until(async () => (await site.api("/api/credits")).body?.resets, "the resets");
  assert.deepEqual(c[0].grants[0], { id: "launch_reset", label: "Limit reset", left: 1, total: 1, usableNow: true, needsLimit: true, paused: false, endsAt: "", every: "", nextAt: "", clears: ["five_hour", "seven_day"] });
  assert.equal(c[0].atLimit, true);
  const used = await site.post("/api/resets/use", { program: "cedar_ember", grant: "launch_reset" });
  assert.equal(used.status, 200, used.text);
  assert.deepEqual(used.body, { result: "reset", reason: "", resetsLeft: 0, cleared: ["five_hour", "seven_day"] });
  assert.equal(claims.length, 1);
  assert.equal(claims[0].auth, "Bearer sk-ant-oat-test");
  assert.equal(claims[0].body.program, "cedar_ember");
  assert.equal(claims[0].body.grant_id, "launch_reset");
  assert.match(claims[0].body.request_id, /^[A-Za-z0-9_-]{1,64}$/);
  // and the list is read again afterwards
  await until(async () => (await site.api("/api/credits")).body?.resets?.[0]?.grants?.[0]?.left === 0, "the resets left to update");
  assert.equal((await site.post("/api/resets/use", { program: "x; rm", grant: "launch_reset" })).status, 400);
});

test("a name changed in Settings while the computer was away reaches it when it's back, and the command follows", async t => {
  const site = await startSite({ appVersion: "2.2.0" });
  await site.claim();
  const pc = makeComputer({ site, githubUrl: "http://127.0.0.1:9" });
  t.after(async () => {
    pc.cleanup();
    await site.stop();
  });
  assert.equal((await site.post("/api/site", { displayName: "Away Name" })).status, 200);
  pc.startAgent();
  await until(async () => JSON.parse(pc.read("config.json")).command === "AwayName", "the command to follow the name");
  assert.equal(JSON.parse(pc.read("config.json")).displayName, "Away Name");
  assert.ok(existsSync(join(pc.home, "bin", "AwayName")) && !existsSync(join(pc.home, "bin", "TestSite")));
  await until(async () => (await site.api("/api/state")).body.site.command === "AwayName", "the site to hear of it");
  // and the page's own copy of it
  const page = await (await site.asOwner("/")).text();
  assert.match(page, /"command":"AwayName"/);
});
