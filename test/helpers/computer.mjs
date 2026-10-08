// A throwaway "computer": a home folder with an existing ClaudeConnect install, a fake `claude`, and a fake `npx`
// standing in for wrangler (so no Cloudflare account is touched). The real agent, loader and installer run on it.
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync, existsSync, chmodSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { AGENT_SECRET } from "./site.mjs";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const FAKE_CLAUDE = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("2.1.300 (Claude Code)"); process.exit(0); }
if (a[0] === "auth") { console.log(JSON.stringify({ authMethod: "claude.ai" })); process.exit(0); }
let prompt = "";
process.stdin.on("data", d => (prompt += d)).on("end", () => {
  const out = o => console.log(JSON.stringify(o));
  out({ type: "system", subtype: "init", model: "claude-opus-5-5" });
  out({ type: "assistant", message: { id: "m1", content: [{ type: "text", text: "You said: " + prompt.trim().slice(0, 30) }] } });
  // the shape of a real event, captured from Claude Code 2.1.293: fractions of each window, resets in epoch seconds
  const now = Math.floor(Date.now() / 1000);
  out({ type: "rate_limit_event", rate_limit_info: { status: "allowed", resetsAt: now + 3 * 3600, rateLimitType: "five_hour", utilization: 0.42, isUsingOverage: false, unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: now + 3 * 3600 }, seven_day: { utilization: 0.17, resetsAt: now + 4 * 86400 } } } });
  out({ type: "result", subtype: "success", is_error: false, result: "ok", total_cost_usd: 0.0123,
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 333, cache_creation_input_tokens: 44 },
    modelUsage: { "claude-opus-5-5": { inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 333, cacheCreationInputTokens: 44, costUSD: 0.0123 } },
    permission_denials: [] });
});
`;

// wrangler@4 auth token --json  -> a token.   wrangler@4 deploy ... -> "deploys" by recording the config, unless told to fail.
const FAKE_NPX = `#!/usr/bin/env node
const { appendFileSync, copyFileSync, existsSync, mkdirSync, readFileSync } = require("node:fs");
const { join } = require("node:path");
const a = process.argv.slice(2).join(" ");
const home = process.env.HOME;
appendFileSync(join(home, "npx.log"), a + " (cwd " + process.cwd() + ")\\n");
if (/auth token/.test(a)) { console.log(JSON.stringify({ token: "fake-cloudflare-token" })); process.exit(0); }
if (/secret bulk/.test(a)) { const f = process.argv[process.argv.indexOf("bulk") + 1]; copyFileSync(f, join(home, "secrets-" + Date.now() + ".json")); process.exit(0); }
if (/ deploy /.test(" " + a + " ")) {
  if (existsSync(join(home, "fail-deploy"))) { console.error("✘ [ERROR] A request to the Cloudflare API failed: authentication error"); process.exit(1); }
  mkdirSync(join(home, "deploys"), { recursive: true });
  const n = require("node:fs").readdirSync(join(home, "deploys")).length + 1;
  copyFileSync(join(process.cwd(), "wrangler.jsonc"), join(home, "deploys", n + ".json"));
  for (const f of ["worker.js", "app.html", "version.js", "names.js", "image.js"]) if (!existsSync(join(process.cwd(), f))) { console.error("missing " + f); process.exit(2); }
  console.log("Deployed (fake)"); process.exit(0);
}
console.error("fake npx: unexpected " + a); process.exit(3);
`;

export function makeFakes(bin) {
  writeFileSync(join(bin, "claude"), FAKE_CLAUDE);
  writeFileSync(join(bin, "npx"), FAKE_NPX);
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "npx"), 0o755);
}

// Every live process (other than this one) that was started with this folder as its home. Linux only, which is
// where the tests run; elsewhere there is nothing to find and the pid-file kill in the callers still applies.
function onThisHome(home) {
  const found = [];
  let entries = [];
  try {
    entries = readdirSync("/proc");
  } catch {
    return found;
  }
  for (const e of entries) {
    if (!/^\d+$/.test(e) || Number(e) === process.pid) continue;
    try {
      if (/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${e}/stat`, "utf8"))) continue;
      const env = readFileSync(`/proc/${e}/environ`, "utf8").split("\0");
      if (env.includes(`HOME=${home}`)) found.push(Number(e));
    } catch {}
  }
  return found;
}

export function makeComputer({ site, oldVersion = "1.1.5", githubUrl }) {
  const home = mkdtempSync(join(tmpdir(), "cc-computer-"));
  const dir = join(home, ".claudeconnect");
  const bin = join(home, "bin");
  mkdirSync(dir, { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(home, "ws"), { recursive: true });
  makeFakes(bin);
  // the previous version, as an earlier install would have left it
  copyFileSync(join(ROOT, "agent", "agent.mjs"), join(dir, "agent.mjs"));
  copyFileSync(join(ROOT, "ClaudeConnect.mjs"), join(dir, "ClaudeConnect.mjs"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({ version: oldVersion, files: {} }));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "claudeconnect", private: true, type: "module" }));
  // a complete install: the setup program and the files of the deployed site sit next to the agent
  copyFileSync(join(ROOT, "installer.mjs"), join(dir, "installer.mjs"));
  mkdirSync(join(dir, "site"), { recursive: true });
  for (const f of readdirSync(join(ROOT, "site"))) copyFileSync(join(ROOT, "site", f), join(dir, "site", f));
  writeFileSync(join(dir, "site", "brand.js"), 'export default {"logo":null,"favicon":null};\n');
  // the command the installer made on the user's PATH: a tiny script that runs the agent
  const shim = join(bin, "TestConnect");
  writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "agent.mjs")}" "$@"\n`);
  chmodSync(shim, 0o755);
  const config = {
    name: "test-site", displayName: "Test Site", command: "TestConnect", aiName: "Testy", fable: false,
    accountId: "acct-123", kvId: "kv-123", site: site.origin, secret: AGENT_SECRET, workspace: join(home, "ws"),
    permissionMode: "auto", shim, version: oldVersion, repo: "ThatOneWeirdDev/claudeconnect", ref: "main",
    token: site.jwt, tokenExp: Math.floor(Date.now() / 1000) + 86400 * 30, claudePath: join(bin, "claude"), id: "agent-real"
  };
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}:${process.env.PATH}`, CLAUDECONNECT_RAW: githubUrl, CLAUDECONNECT_RETRY_MS: "50" };
  const read = f => readFileSync(join(dir, f), "utf8");
  const pidFile = join(dir, "agent.pid");
  const pids = () => {
    try {
      return Number(readFileSync(pidFile, "utf8").trim());
    } catch {
      return 0;
    }
  };
  // A killed process whose parent has gone can sit as a zombie in a container with no init, and still answers kill(pid, 0).
  const alive = pid => {
    try {
      process.kill(pid, 0);
    } catch {
      return false;
    }
    try {
      return !/^\d+ \(.*\) Z/.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return true;
    }
  };
  const log = () => (existsSync(join(dir, "agent.log")) ? read("agent.log") : "");
  const updateLog = () => (existsSync(join(dir, "update.log")) ? read("update.log") : "");
  return {
    home, dir, env, config, read, pid: pids, alive, log, updateLog,
    deploys: () => (existsSync(join(home, "deploys")) ? readdirSync(join(home, "deploys")).sort().map(f => JSON.parse(readFileSync(join(home, "deploys", f), "utf8").replace(/^﻿/, ""))) : []),
    npxLog: () => (existsSync(join(home, "npx.log")) ? readFileSync(join(home, "npx.log"), "utf8") : ""),
    failDeploys: on => (on ? writeFileSync(join(home, "fail-deploy"), "1") : rmSync(join(home, "fail-deploy"), { force: true })),
    startAgent() {
      const child = spawn(process.execPath, [join(dir, "agent.mjs"), "run"], { env, stdio: "ignore" });
      return child;
    },
    // Kill everything that was started on this temporary home, however it got there: the agent we started, the one a
    // job started in its place, an installer still running detached. Their pid files can't be trusted for this, since
    // a replacement may not have written its own yet. Several passes, because killing an installer can race with it
    // starting one more agent.
    cleanup() {
      for (let pass = 0; pass < 20; pass++) {
        const found = onThisHome(home);
        if (!found.length) break;
        for (const pid of found) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {}
        }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);
      }
      rmSync(home, { recursive: true, force: true });
    }
  };
}
