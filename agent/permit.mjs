// How Claude Code asks you for permission when nobody is at the terminal: to run a command, or to read or change files outside
// the working folder. The program on your computer starts this as an MCP server for each reply and names its tool with
// --permission-prompt-tool. Each question goes to that program, which shows it on the site; this answers Claude Code with what
// you chose there. Nobody answering in time is a no.
import { createInterface } from "node:readline";

const BASE = String(process.env.CLAUDECONNECT_PERMIT || "").replace(/\/+$/, "");
const TOKEN = process.env.CLAUDECONNECT_PERMIT_TOKEN || "";
const RUN = process.env.CLAUDECONNECT_RUN || "";
const WAIT = Number(process.env.CLAUDECONNECT_PERMIT_WAIT_MS) || 10 * 60000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TOOL = {
  name: "approve",
  description: "Asks the person using ClaudeConnect whether Claude Code may use a tool, and returns their answer.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"]
  }
};

function out(o) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\n");
}

async function ask(path, body) {
  const r = await fetch(BASE + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-token": TOKEN }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

async function decide(args) {
  const deny = message => ({ behavior: "deny", message });
  if (!BASE || !TOKEN) return deny("ClaudeConnect couldn't ask for permission, so this wasn't allowed.");
  const input = args.input && typeof args.input === "object" ? args.input : {};
  try {
    const { id } = await ask("/permit", { run: RUN, tool: String(args.tool_name || ""), input, use: String(args.tool_use_id || "") });
    const end = Date.now() + WAIT;
    while (Date.now() < end) {
      const a = await ask(`/permit/${encodeURIComponent(id)}`).catch(() => ({ pending: true }));
      if (!a.pending) return a.allow ? { behavior: "allow", updatedInput: input } : deny(a.message || "The person using ClaudeConnect said no to this.");
      await sleep(500);
    }
    return deny("Nobody answered in time, so this wasn't allowed.");
  } catch {
    return deny("ClaudeConnect couldn't ask for permission, so this wasn't allowed.");
  }
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async line => {
  let m;
  try {
    m = JSON.parse(line);
  } catch {
    return;
  }
  if (!m || typeof m !== "object" || !m.method) return;
  if (m.method === "initialize") return out({ id: m.id, result: { protocolVersion: (m.params && m.params.protocolVersion) || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "claudeconnect", version: "1.0.0" } } });
  if (m.method === "tools/list") return out({ id: m.id, result: { tools: [TOOL] } });
  if (m.method === "tools/call") {
    if (!m.params || m.params.name !== TOOL.name) return out({ id: m.id, error: { code: -32602, message: "No such tool" } });
    const d = await decide(m.params.arguments || {});
    return out({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify(d) }] } });
  }
  if (m.method === "ping") return out({ id: m.id, result: {} });
  // anything else that wants an answer gets told this server doesn't do it; notifications need none
  if (m.id !== undefined && m.id !== null) out({ id: m.id, error: { code: -32601, message: "Method not found" } });
});
rl.on("close", () => process.exit(0));
