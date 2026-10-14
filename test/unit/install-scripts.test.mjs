import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = f => readFileSync(join(ROOT, f), "utf8");

test("install.sh is valid shell and fails loudly rather than half-installing", () => {
  const r = spawnSync("/bin/sh", ["-n", join(ROOT, "install.sh")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  assert.match(read("install.sh"), /^set -eu$/m);
  assert.match(read("install.sh"), /Node\.js 22 or newer/);
});

// Piped from curl, install.sh gives setup the keyboard. Not as /dev/tty: on a Mac nothing can wait for input on it (kqueue says
// EINVAL), and Claude Code's sign-in crashes there. util-linux's `script` makes a terminal to try it in.
test("install.sh hands setup the terminal by its own name, not as /dev/tty", t => {
  const s = read("install.sh");
  assert.doesNotMatch(s, /node [^\n]*<\s*\/dev\/tty/, "node never reads /dev/tty itself when the terminal has a name");
  const fn = s.match(/^terminal\(\) \{[\s\S]*?^\}$/m);
  assert.ok(fn, "install.sh has terminal()");
  if (process.platform !== "linux" || spawnSync("script", ["--version"]).status !== 0 || spawnSync("setsid", ["--version"]).status !== 0) return t.skip("needs util-linux's script and setsid");
  const dir = mkdtempSync(join(tmpdir(), "cc-terminal-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "terminal.sh");
  writeFileSync(file, `set -eu\n${fn[0]}\necho "term=[$(terminal)]"\n`);
  // in a terminal, with the script piped in as from curl
  const inTerm = spawnSync("script", ["-qec", `echo | sh '${file}'; tty`, "/dev/null"], { encoding: "utf8", input: "" });
  const own = (inTerm.stdout.match(/^(\/dev\/pts\/\d+)\s*$/m) || [])[1];
  assert.ok(own, inTerm.stdout + inTerm.stderr);
  assert.match(inTerm.stdout, new RegExp(`term=\\[${own}\\]`));
  // no terminal at all: nothing, and setup runs on what it was given
  const none = spawnSync("setsid", ["sh", file], { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], input: "" });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /term=\[\]/);
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
