import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { buildRelease, startGithub, startFakeSite } from "../helpers/github.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LOADER = join(ROOT, "ClaudeConnect.mjs");

// The installer in these releases is a stub that records how it was run, so the loader is tested on its own.
const STUB = `import { writeFileSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const here = dirname(fileURLToPath(import.meta.url));
writeFileSync(process.env.STUB_OUT, JSON.stringify({ argv: process.argv.slice(2), here, repo: process.env.CLAUDECONNECT_REPO, ref: process.env.CLAUDECONNECT_REF, manifest: JSON.parse(readFileSync(join(here, "manifest.json"), "utf8")).version, files: readdirSync(here).sort(), worker: readFileSync(join(here, "site/worker.js"), "utf8") }));
process.exit(Number(process.env.STUB_EXIT || 0));
`;
const FILES = { "installer.mjs": STUB, "agent/agent.mjs": "// agent\n", "site/worker.js": "// worker\n", "site/app.html": "<html></html>\n", "ClaudeConnect.mjs": "// loader\n" };

// Async on purpose: the fake GitHub lives in this process, so a blocking spawn would starve it.
function run(home, github, args = [], env = {}) {
  const out = join(home, "stub.json");
  return new Promise(resolve => {
    const child = spawn(process.execPath, [LOADER, ...args], {
      env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDECONNECT_RAW: github.url, CLAUDECONNECT_RETRY_MS: "20", STUB_OUT: out, CLAUDECONNECT_REPO: "", CLAUDECONNECT_REF: "", ...env }
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("close", status => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr, stub: existsSync(out) ? JSON.parse(readFileSync(out, "utf8")) : null, stage: existsSync(join(home, ".claudeconnect", "stage")) });
    });
  });
}
const tmp = () => mkdtempSync(join(tmpdir(), "cc-home-"));

test("downloads the release, checks it, and runs the setup that came with it", async t => {
  const gh = await startGithub(buildRelease(FILES));
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh, ["--update", "--name", "Mine"]);
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(r.stub.argv, ["--update", "--name", "Mine"]); // everything is passed on
  assert.equal(r.stub.manifest, "1.2.0");
  assert.ok(r.stub.files.includes("manifest.json"));
  assert.equal(r.stub.worker, "// worker\n");
  assert.equal(r.stub.repo, "ThatOneWeirdDev/claudeconnect");
  assert.equal(r.stub.ref, "main");
  assert.equal(r.stage, false, "the download folder is cleaned up");
  assert.match(r.stdout, /Downloading 1\.2\.0/);
  assert.ok(gh.hits.some(h => h.startsWith("/ThatOneWeirdDev/claudeconnect/main/manifest.json")));
});

test("--repo and --ref pick another source, and the setup's exit code is passed back", async t => {
  const gh = await startGithub(buildRelease(FILES));
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh, ["--repo", "someone/fork", "--ref", "v1.2.0"], { STUB_EXIT: "3" });
  assert.equal(r.status, 3);
  assert.equal(r.stub.repo, "someone/fork");
  assert.equal(r.stub.ref, "v1.2.0");
  assert.ok(gh.hits.some(h => h.startsWith("/someone/fork/v1.2.0/manifest.json")));
});

test("an install remembers its source, so updates keep coming from the same place", async t => {
  const gh = await startGithub(buildRelease(FILES));
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".claudeconnect"), { recursive: true });
  writeFileSync(join(home, ".claudeconnect", "config.json"), JSON.stringify({ repo: "me/mine", ref: "stable" }));
  const r = await run(home, gh);
  assert.equal(r.stub.repo, "me/mine");
  assert.equal(r.stub.ref, "stable");
});

test("a file that doesn't match its checksum stops everything before anything runs", async t => {
  const gh = await startGithub(buildRelease(FILES), { corrupt: { "site/worker.js": "// tampered\n" } });
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh);
  assert.equal(r.status, 1);
  assert.equal(r.stub, null, "the setup never ran");
  assert.match(r.stderr, /site\/worker\.js didn't match its checksum/);
  assert.equal(r.stage, false, "nothing is left behind");
});

test("a stale copy from GitHub's cache is retried until it's right", async t => {
  const old = buildRelease(FILES, "1.1.0");
  const gh = await startGithub(buildRelease(FILES, "1.2.0"), { staleManifest: old.manifestText });
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh, ["--expect", "1.2.0"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stub.manifest, "1.2.0");
  assert.ok(gh.hits.some(h => h.includes("manifest.json?cb=")));
});

test("if GitHub never serves the version that was asked for, it says so and changes nothing", async t => {
  const gh = await startGithub(buildRelease(FILES, "1.1.0"));
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh, ["--expect", "1.2.0"]);
  assert.equal(r.status, 1);
  assert.equal(r.stub, null);
  assert.match(r.stderr, /still serving 1\.1\.0, not 1\.2\.0/);
});

test("a manifest can't write outside the install folder or ask for odd files", async t => {
  const home = tmp();
  const hostile = ["../evil.js", "/etc/passwd", "site/../../evil.js", "node_modules/x.js", "site/a b.js", "C:\\evil.js"];
  for (const bad of hostile) {
    const rel = buildRelease({ ...FILES, [bad]: "x" });
    const gh = await startGithub(rel);
    const r = await run(home, gh);
    await gh.close();
    assert.equal(r.status, 1, bad);
    assert.equal(r.stub, null, bad);
    assert.match(r.stderr, /manifest/i, bad);
  }
  rmSync(home, { recursive: true, force: true });
});

test("a release without the essential files is refused", async t => {
  const { "site/app.html": _, ...partial } = FILES;
  const gh = await startGithub(buildRelease(partial));
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /missing site\/app\.html/);
});

test("an unreachable or empty GitHub gives a plain message", async t => {
  const home = tmp();
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const r = await run(home, { url: "http://127.0.0.1:9" });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /couldn't reach 127\.0\.0\.1/);
  const gh = await startGithub({ manifestText: "", files: {} });
  const r2 = await run(home, gh);
  await gh.close();
  assert.equal(r2.status, 1);
  assert.match(r2.stderr, /manifest/i);
});

test("when the site started the update, each step is reported to it with the agent's key", async t => {
  const gh = await startGithub(buildRelease(FILES));
  const site = await startFakeSite();
  const home = tmp();
  t.after(async () => { await gh.close(); await site.close(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".claudeconnect"), { recursive: true });
  writeFileSync(join(home, ".claudeconnect", "config.json"), JSON.stringify({ site: site.url, secret: "s3cret", token: "jwt-token", id: "agent-7" }));
  const r = await run(home, gh, ["--remote-update", "--update-id", "u-123", "--expect", "1.2.0"]);
  assert.equal(r.status, 0, r.stderr);
  const steps = site.posts.map(p => `${p.body.step}:${p.body.status}`);
  assert.deepEqual(steps, ["download:active", "download:done", "verify:active"]);
  for (const p of site.posts) {
    assert.equal(p.body.id, "u-123");
    assert.equal(p.headers["x-chatgql-key"], "s3cret");
    assert.equal(p.headers["cf-access-token"], "jwt-token");
    assert.equal(p.headers["x-agent-id"], "agent-7");
  }
  assert.deepEqual(r.stub.argv.slice(0, 3), ["--remote-update", "--update-id", "u-123"]);
});

test("a failed download is reported to the site as the download step failing", async t => {
  const gh = await startGithub(buildRelease(FILES), { corrupt: { "site/app.html": "bad" } });
  const site = await startFakeSite();
  const home = tmp();
  t.after(async () => { await gh.close(); await site.close(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".claudeconnect"), { recursive: true });
  writeFileSync(join(home, ".claudeconnect", "config.json"), JSON.stringify({ site: site.url, secret: "s3cret", token: "t", id: "a" }));
  const r = await run(home, gh, ["--remote-update", "--update-id", "u-9"]);
  assert.equal(r.status, 1);
  const last = site.posts[site.posts.length - 1].body;
  assert.equal(last.status, "error");
  assert.equal(last.step, "verify");
  assert.match(last.message, /site\/app\.html/);
});

test("without --remote-update nothing is sent to any site", async t => {
  const gh = await startGithub(buildRelease(FILES));
  const site = await startFakeSite();
  const home = tmp();
  t.after(async () => { await gh.close(); await site.close(); rmSync(home, { recursive: true, force: true }); });
  mkdirSync(join(home, ".claudeconnect"), { recursive: true });
  writeFileSync(join(home, ".claudeconnect", "config.json"), JSON.stringify({ site: site.url, secret: "s3cret" }));
  await run(home, gh, ["--update-id", "u-1"]);
  assert.equal(site.posts.length, 0);
});

test("right after a release, an old cached manifest with the new files doesn't stop an update: every request skips the cache", async t => {
  // what raw.githubusercontent.com does for a few minutes: the branch's manifest is old unless asked for fresh, the files are new
  const old = buildRelease({ ...FILES, "installer.mjs": STUB + "// older\n" }, "1.1.0");
  const gh = await startGithub(buildRelease(FILES, "1.2.0"), { staleManifest: old.manifestText });
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh, ["--update"]);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stub.manifest, "1.2.0");
  assert.ok(gh.hits.filter(h => h.includes("/manifest.json")).every(h => h.includes("?cb=")), "not even the first look uses the cache");
});

test("with GitHub's API, everything comes from the one commit the branch is on, so a cached manifest can't mix in", async t => {
  const sha = "a".repeat(40);
  const old = buildRelease({ ...FILES, "installer.mjs": STUB + "// older\n" }, "1.1.0");
  const gh = await startGithub(buildRelease(FILES, "1.2.0"), { sha, staleBranch: old.manifestText });
  const home = tmp();
  t.after(async () => { await gh.close(); rmSync(home, { recursive: true, force: true }); });
  const r = await run(home, gh, ["--update"], { CLAUDECONNECT_GH_API: gh.url + "/api" });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stub.manifest, "1.2.0");
  assert.equal(r.stub.ref, "main", "the install still follows the branch");
  assert.ok(gh.hits.includes("/api/repos/ThatOneWeirdDev/claudeconnect/commits/main"));
  assert.ok(gh.hits.filter(h => /manifest\.json|installer\.mjs/.test(h)).every(h => h.startsWith(`/ThatOneWeirdDev/claudeconnect/${sha}/`)), gh.hits.join(" "));
  // and if the API can't be reached, it falls back to skipping the cache
  const down = await run(tmp(), gh, ["--update"], { CLAUDECONNECT_GH_API: "http://127.0.0.1:9" });
  assert.equal(down.status, 1, "the branch's manifest is stale even when asked fresh here, so this one can't succeed");
  assert.match(down.stderr, /didn't match its checksum/);
});
