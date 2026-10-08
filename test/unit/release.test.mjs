import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FILES, hashes, problems } from "../../scripts/release.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = p => JSON.parse(readFileSync(join(ROOT, p), "utf8"));

test("the committed manifest matches the files and package.json", () => {
  assert.deepEqual(problems(read("manifest.json"), read("package.json")), []);
});

test("a changed file, a wrong version or a missing note is caught", () => {
  const m = read("manifest.json");
  const p = read("package.json");
  const stale = { ...m, files: { ...m.files, "site/worker.js": "0".repeat(64) } };
  assert.match(problems(stale, p).join("\n"), /site\/worker\.js changed/);
  assert.match(problems(m, { ...p, version: "9.9.9" }).join("\n"), /package\.json says 9\.9\.9/);
  assert.match(problems({ ...m, notes: [] }, p).join("\n"), /notes/);
  assert.match(problems({ ...m, version: "banana" }, { ...p, version: "banana" }).join("\n"), /isn't x\.y\.z/);
  assert.match(problems({ ...m, files: { ...m.files, "extra.js": "0".repeat(64) } }, p).join("\n"), /extra\.js/);
});

test("every release file exists and hashes", () => {
  const h = hashes();
  assert.equal(Object.keys(h).length, FILES.length);
  for (const v of Object.values(h)) assert.match(v, /^[0-9a-f]{64}$/);
});

test("the agent reads its version from the manifest, so no hard-coded version is left behind", () => {
  const agent = readFileSync(join(ROOT, "agent/agent.mjs"), "utf8");
  assert.doesNotMatch(agent, /const VERSION = "\d/);
});
