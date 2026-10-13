// Bringing chats over from claude.ai's data export was taken out. Chats brought over that way before are cleared when the
// site starts on the new version; every other chat is kept.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite } from "../helpers/site.mjs";

const T0 = Date.UTC(2025, 2, 1, 9, 0, 0);
const OLD = "1f6c2a3b-4d5e-4f70-8192-a3b4c5d6e7f1";
const MINE = "1f6c2a3b-4d5e-4f70-8192-a3b4c5d6e7f2";

test("there's no import any more, and chats brought over from claude.ai before are cleared on the next start", async t => {
  const s = await startSite({ appVersion: "1.12.0" });
  t.after(() => s.stop());
  await s.claim();
  assert.equal((await s.post("/api/import", { conversations: [] })).status, 404);
  await s.seed({
    chats: [
      { id: OLD, title: "Trip to Lisbon", created: T0, updated: T0 + 2, origin: "claude.ai" },
      { id: MINE, title: "Mine", created: T0, updated: T0 + 1 }
    ],
    messages: [
      { id: "w-1", chat: OLD, role: "user", content: "Plan three days", created: T0 },
      { id: "u-1", chat: MINE, role: "user", content: "keep me", created: T0 }
    ]
  });
  assert.deepEqual((await s.api("/api/chats")).body.chats.map(c => c.id), [OLD, MINE], "as an older version left them");
  // the Object restarts, as it does when a new version is deployed
  const ns = await s.mf.getDurableObjectNamespace("HUB", "site");
  await assert.rejects(ns.get(ns.idFromName("main")).fetch("https://x/api/state", { headers: { "x-app-version": "99.0.0" } }));
  assert.deepEqual((await s.api("/api/chats")).body.chats.map(c => c.id), [MINE]);
  assert.equal((await s.api(`/api/chats/${OLD}`)).status, 404);
  assert.deepEqual((await s.api(`/api/chats/${MINE}`)).body.messages.map(m => m.content), ["keep me"]);
});
