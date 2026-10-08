// What a new version asks when it's installed: shown on the update screen, answered there, kept by the site, and given to
// the new version once it's running on the computer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
const release = (version, questions) => ({ name: "claudeconnect", version, released: "2026-10-09", notes: ["New"], files: {}, questions });

test("an update's questions are the ones added since the computer's version, and junk is dropped", async t => {
  const s = await startSite({
    appVersion: "1.8.1",
    release: release("1.9.0", [
      { key: "credits", label: "Show your usage credit balance?", help: "Uses Claude Code's sign-in on your computer.", default: true, since: "1.9.0" },
      { key: "autostart", label: "Start at login?", since: "1.5.0" },
      { key: "rm -rf", label: "nope", since: "1.9.0" },
      { key: "autostart", label: "", since: "1.9.0" },
      { key: "autostart", label: "Later one", since: "2.0.0" }
    ])
  });
  t.after(() => s.stop());
  await s.claim();
  await connectAgent(s, { agent: "1.8.1", caps: ["update", "admin", "limits", "modes", "history", "computer"] });
  const u = (await s.api("/api/update")).body;
  assert.equal(u.available, true);
  assert.deepEqual(u.questions, [{ key: "credits", label: "Show your usage credit balance?", help: "Uses Claude Code's sign-in on your computer.", default: true, since: "1.9.0" }]);
});

test("the answers wait on the site until the new version connects, then go to it once", async t => {
  const s = await startSite({ appVersion: "1.8.1", release: release("1.9.0", [{ key: "credits", label: "Show your usage credit balance?", default: true, since: "1.9.0" }]) });
  t.after(() => s.stop());
  await s.claim();
  const caps = ["update", "admin", "limits", "modes", "history", "computer"];
  const old = await connectAgent(s, { agent: "1.8.1", caps });
  const r = await s.post("/api/update/start", { to: "1.9.0", answers: { credits: false, autostart: true, junk: "x" } });
  assert.equal(r.status, 200, r.text);
  assert.equal((await old.next(m => m.type === "update")).to, "1.9.0");
  assert.deepEqual(await s.getStorage("answers"), { version: "1.9.0", values: { credits: false } }, "only this update's own questions, only yes or no");
  // the old program reconnecting (before the update gets to it) isn't given them
  const again = await connectAgent(s, { agent: "1.8.1", caps }, "agent-1");
  await assert.rejects(again.next(m => m.type === "computer", 300), /timed out/);
  // the new one is
  const fresh = await connectAgent(s, { agent: "1.9.0", caps }, "agent-1");
  assert.deepEqual((await fresh.next(m => m.type === "computer")).values, { credits: false });
  assert.equal(await s.getStorage("answers"), null);
});
