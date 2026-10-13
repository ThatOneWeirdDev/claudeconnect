// permit.mjs, the MCP server Claude Code asks for permission through: the MCP handshake, and each question passed on to a
// stand-in for the program on the computer, which answers yes or no (or nothing at all).
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PERMIT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "permit.mjs");

function server(decide) {
  const asked = [];
  const answers = new Map();
  const srv = http.createServer((req, res) => {
    const reply = o => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(o));
    };
    if (req.headers["x-token"] !== "tok") {
      res.statusCode = 403;
      return reply({});
    }
    if (req.method === "POST") {
      let b = "";
      req.on("data", d => (b += d));
      req.on("end", () => {
        const q = JSON.parse(b);
        const id = "0123456789abcdef".slice(0, 16 - String(asked.length).length) + asked.length;
        asked.push(q);
        // answered after a poll or two, as a person would
        setTimeout(() => answers.set(id, decide(q)), 600);
        reply({ id });
      });
      return;
    }
    const id = req.url.split("/").pop();
    reply(answers.has(id) ? answers.get(id) : { pending: true });
  });
  return new Promise(r => srv.listen(0, "127.0.0.1", () => r({ srv, asked, url: `http://127.0.0.1:${srv.address().port}` })));
}

function mcp(env) {
  const child = spawn(process.execPath, [PERMIT], { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "inherit"] });
  const waiting = new Map();
  createInterface({ input: child.stdout }).on("line", line => {
    const m = JSON.parse(line);
    if (waiting.has(m.id)) waiting.get(m.id)(m);
  });
  let id = 0;
  const call = (method, params) => new Promise(r => {
    const n = ++id;
    waiting.set(n, r);
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
  });
  return { call, notify: method => child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method }) + "\n"), close: () => child.stdin.end() };
}

test("Claude Code's questions go to the computer, and the answer comes back the way --permission-prompt-tool wants it", async t => {
  const s = await server(q => (q.tool === "Bash" ? { allow: true } : { allow: false, message: "Not that one." }));
  t.after(() => s.srv.close());
  const c = mcp({ CLAUDECONNECT_PERMIT: s.url, CLAUDECONNECT_PERMIT_TOKEN: "tok", CLAUDECONNECT_RUN: "run-1" });
  t.after(() => c.close());
  const init = await c.call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-code", version: "2" } });
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.deepEqual(init.result.capabilities, { tools: {} });
  c.notify("notifications/initialized");
  const tools = await c.call("tools/list", {});
  assert.deepEqual(tools.result.tools.map(x => x.name), ["approve"]);
  const yes = await c.call("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: { command: "npm test" }, tool_use_id: "tu1" } });
  assert.deepEqual(JSON.parse(yes.result.content[0].text), { behavior: "allow", updatedInput: { command: "npm test" } });
  const no = await c.call("tools/call", { name: "approve", arguments: { tool_name: "Write", input: { file_path: "/etc/hosts" } } });
  assert.deepEqual(JSON.parse(no.result.content[0].text), { behavior: "deny", message: "Not that one." });
  assert.deepEqual(s.asked.map(q => [q.run, q.tool]), [["run-1", "Bash"], ["run-1", "Write"]]);
  assert.equal((await c.call("tools/call", { name: "other", arguments: {} })).error.code, -32602);
  assert.equal((await c.call("resources/list", {})).error.code, -32601);
  assert.deepEqual((await c.call("ping", {})).result, {});
});

test("nobody to ask, or nobody answering in time, is a no", async t => {
  const lost = mcp({ CLAUDECONNECT_PERMIT: "", CLAUDECONNECT_PERMIT_TOKEN: "" });
  t.after(() => lost.close());
  await lost.call("initialize", {});
  const r = await lost.call("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: {} } });
  assert.equal(JSON.parse(r.result.content[0].text).behavior, "deny");

  const s = await server(() => ({ pending: true }));
  t.after(() => s.srv.close());
  const slow = mcp({ CLAUDECONNECT_PERMIT: s.url, CLAUDECONNECT_PERMIT_TOKEN: "tok", CLAUDECONNECT_PERMIT_WAIT_MS: "1500" });
  t.after(() => slow.close());
  await slow.call("initialize", {});
  const late = await slow.call("tools/call", { name: "approve", arguments: { tool_name: "Bash", input: {} } });
  assert.deepEqual(JSON.parse(late.result.content[0].text), { behavior: "deny", message: "Nobody answered in time, so this wasn't allowed." });
});
