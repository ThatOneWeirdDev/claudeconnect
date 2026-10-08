import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => readFileSync(join(ROOT, f), "utf8");

test("install.sh is valid shell and fails loudly rather than half-installing", () => {
  const r = spawnSync("/bin/sh", ["-n", join(ROOT, "install.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read("install.sh"), /^set -eu$/m);
  assert.match(read("install.sh"), /Node\.js 22 or newer/);
});

test("both install scripts point at this repository and its main branch by default, and can be redirected", () => {
  for (const f of ["install.sh", "install.ps1"]) {
    const s = read(f);
    assert.match(s, /ThatOneWeirdDev\/claudeconnect/, f);
    assert.match(s, /CLAUDECONNECT_REPO/, f);
    assert.match(s, /CLAUDECONNECT_REF/, f);
    assert.match(s, /\bmain\b/, f);
    assert.match(s, /ClaudeConnect\.mjs/, f);
    assert.match(s, /Node\.js 22/, f);
  }
});

test("the README's install commands are the ones that exist", () => {
  const readme = read("README.md");
  assert.match(readme, /raw\.githubusercontent\.com\/ThatOneWeirdDev\/claudeconnect\/main\/install\.sh \| sh/);
  assert.match(readme, /raw\.githubusercontent\.com\/ThatOneWeirdDev\/claudeconnect\/main\/install\.ps1 \| iex/);
  assert.match(readme, /npx github:ThatOneWeirdDev\/claudeconnect/);
  const pkg = JSON.parse(read("package.json"));
  assert.equal(pkg.bin.claudeconnect, "ClaudeConnect.mjs", "the npx command runs the launcher");
  assert.match(pkg.engines.node, />=22/);
});
