// The update screen in a real browser, while an update runs: the page asks how it's going every second and a half, and
// redrawing the screen each time used to rebuild it, so "All steps" closed again, the spinners restarted and it flashed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, connectAgent } from "../helpers/site.mjs";
import { openPage } from "../helpers/browser.mjs";
import { findChromium } from "../helpers/fake-claude-app.mjs";

const CHROME = await findChromium();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PLAN = [["download", "Download the new version"], ["verify", "Check that it's intact"], ["site", "Update the site"], ["computer", "Update your computer"], ["restart", "Restart"], ["online", "Come back online"]].map(([key, label]) => ({ key, label }));
const running = (step, steps) => ({ id: "run-1", kind: "update", plan: PLAN, from: "2.0.0", to: "9.9.0", state: "running", acked: true, step, steps, message: "", info: null, cancel: false, startedAt: Date.now(), updatedAt: Date.now(), finishedAt: null, by: "" });

test("while an update runs, the update screen only changes what changed: what you opened stays open and nothing flashes", { skip: !CHROME && "needs a Chromium" }, async t => {
  const site = await startSite({ appVersion: "2.0.0", release: { name: "claudeconnect", version: "9.9.0", released: "2026-10-13", notes: ["New"], files: {}, questions: [] } });
  t.after(() => site.stop());
  await site.claim();
  await connectAgent(site, { agent: "2.0.0", caps: ["update", "admin", "limits", "computer", "plan", "modes", "history", "credits"], computer: { plan: "paid" } });
  await site.putStorage("update", running("site", { download: "done", verify: "done" }));
  const page = await openPage(site.origin + "/");
  t.after(() => page.close());

  // the pill in the top bar opens the update screen, and "All steps" opens the whole checklist
  await page.until(`(() => { const p = document.getElementById("updatePill"); return p && !p.hidden; })()`, "the update pill");
  await page.evaluate(`document.getElementById("updatePill").click()`);
  await page.until(`document.querySelector("#setBody details.earlier summary")`, "the checklist");
  await page.evaluate(`document.querySelector("#setBody details.earlier summary").click()`);
  await page.evaluate(`(() => {
    window.__changes = 0;
    new MutationObserver(rs => (window.__changes += rs.length)).observe(document.getElementById("setBody"), { subtree: true, childList: true, attributes: true, characterData: true });
    window.__spinner = document.querySelector("#setBody .prog .spin");
  })()`);

  // several rounds of asking: nothing has changed, so nothing on the screen changes
  await sleep(5000);
  assert.equal(await page.evaluate(`document.querySelector("#setBody details.earlier").open`), true, "All steps stays open");
  assert.equal(await page.evaluate("window.__changes"), 0, "the screen isn't rebuilt each time it asks");
  assert.equal(await page.evaluate(`window.__spinner === document.querySelector("#setBody .prog .spin")`), true, "the spinner keeps turning");

  // a step finishes: that shows, and the rest stays as it was
  await site.putStorage("update", running("computer", { download: "done", verify: "done", site: "done" }));
  await page.until(`document.querySelector("#setBody .prog-step").textContent.includes("Update your computer")`, "the next step");
  assert.equal(await page.evaluate(`document.querySelector("#setBody details.earlier").open`), true);
  assert.equal(await page.evaluate(`window.__spinner === document.querySelector("#setBody .prog .spin")`), true);
  assert.equal(await page.evaluate(`document.querySelectorAll("#setBody .steps li.done").length`), 3);
});
