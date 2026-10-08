// Reading the chats Claude Code has saved on the computer. The fixtures follow the real files (Claude Code 2.1.x): one JSON
// object per line; "user" entries are either what a person typed or a tool's result; "assistant" entries carry text,
// thinking and tool calls; every entry has the folder it ran in.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listSessions, findSession, sessionCwd, readSession, realPrompt, within, toolLabel, projectsDir, UUID } from "../../agent/sessions.mjs";

const A = "3f8a1c2e-1111-4a2b-9c3d-000000000001";
const B = "3f8a1c2e-1111-4a2b-9c3d-000000000002";
const C = "3f8a1c2e-1111-4a2b-9c3d-000000000003";
const D = "3f8a1c2e-1111-4a2b-9c3d-000000000004";
const WORK = "/home/me/ClaudeConnect";

function home(t) {
  const dir = mkdtempSync(join(tmpdir(), "cc-sessions-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return { root: join(dir, "projects"), dir };
}

let n = 0;
const at = i => new Date(Date.UTC(2026, 9, 8, 10, 0, i)).toISOString();
const base = (cwd, extra = {}) => ({ uuid: "u" + ++n, parentUuid: null, isSidechain: false, userType: "external", cwd, sessionId: "s", version: "2.1.294", timestamp: at(n), ...extra });
const user = (text, cwd = WORK, extra = {}) => ({ type: "user", ...base(cwd, extra), message: { role: "user", content: text } });
const asst = (blocks, cwd = WORK, extra = {}) => ({ type: "assistant", ...base(cwd, extra), message: { id: "m" + n, role: "assistant", model: "claude-opus-5-5", content: blocks, usage: { input_tokens: 5, output_tokens: 7 } } });
const result = (id, text = "ok", isError = false, cwd = WORK) => ({ type: "user", ...base(cwd), message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: text, is_error: isError }] } });
const lines = es => es.map(e => JSON.stringify(e)).join("\n") + "\n";

function put(root, folder, id, entries) {
  mkdirSync(join(root, folder), { recursive: true });
  const f = join(root, folder, id + ".jsonl");
  writeFileSync(f, lines(entries));
  return f;
}

test("what a person typed is told apart from everything else Claude Code writes as a user entry", () => {
  assert.deepEqual(realPrompt(user("fix the bug")), { text: "fix the bug", images: 0 });
  assert.deepEqual(realPrompt({ type: "user", message: { content: [{ type: "text", text: "see this" }, { type: "image", source: {} }] } }), { text: "see this", images: 1 });
  assert.deepEqual(realPrompt({ type: "user", message: { content: [{ type: "image", source: {} }] } }), { text: "", images: 1 });
  assert.equal(realPrompt(result("t1")), null, "a tool's result");
  assert.equal(realPrompt(user("hi", WORK, { isMeta: true })), null);
  assert.equal(realPrompt(user("hi", WORK, { isSidechain: true })), null, "a sub-agent's prompt");
  assert.equal(realPrompt(user("This session is being continued…", WORK, { isCompactSummary: true })), null);
  for (const text of ["<local-command-stdout>done</local-command-stdout>", "<command-name>/clear</command-name>", "<bash-input>ls</bash-input>", "[Request interrupted by user]", "<task-notification>x</task-notification>", "   ", ""]) assert.equal(realPrompt(user(text)), null, text);
  assert.equal(realPrompt(null), null);
  assert.equal(realPrompt({ type: "assistant", message: { content: "x" } }), null);
  assert.equal(realPrompt({ type: "user", message: { content: 5 } }), null);
  // wrappers added around what was typed are dropped, what was typed is kept
  assert.equal(realPrompt(user("<system-reminder>be brief</system-reminder>\nwhat is 2+2?")).text, "what is 2+2?");
  assert.equal(realPrompt({ type: "user", message: { content: [{ type: "text", text: "<ide_opened_file>a.js</ide_opened_file>" }, { type: "text", text: "explain this" }] } }).text, "explain this");
});

test("sessions are listed newest first, with a title and, outside the working folder, the folder's name", t => {
  const { root } = home(t);
  const fa = put(root, "-home-me-ClaudeConnect", A, [user("Plan the quarterly report"), asst([{ type: "text", text: "Sure." }])]);
  const fb = put(root, "-home-me-shop", B, [user("Why is checkout slow?", "/home/me/shop"), asst([{ type: "text", text: "Looking." }], "/home/me/shop")]);
  utimesSync(fa, new Date("2026-10-01T10:00:00Z"), new Date("2026-10-01T10:00:00Z"));
  utimesSync(fb, new Date("2026-10-05T10:00:00Z"), new Date("2026-10-05T10:00:00Z"));
  const list = listSessions({ root, workspace: WORK });
  assert.deepEqual(list.map(s => s.id), [B, A], "newest first");
  assert.equal(list[0].title, "Why is checkout slow?");
  assert.equal(list[0].folder, "shop", "only the last part of the folder, never the whole path");
  assert.equal(list[1].folder, "", "the working folder itself says nothing");
  assert.equal(list[1].updated, new Date("2026-10-01T10:00:00Z").getTime());
  assert.ok(!JSON.stringify(list).includes("/home/me"), "no paths leave the computer in the list");
});

test("a title is the one Claude Code wrote, then the name you gave it, and failing both the first question", t => {
  const { root } = home(t);
  put(root, "p", A, [user("first thing asked"), { type: "ai-title", aiTitle: "Quarterly report plan", sessionId: "s" }, asst([{ type: "text", text: "ok" }])]);
  put(root, "p", B, [user("first thing asked"), { type: "ai-title", aiTitle: "Made-up title" }, { type: "custom-title", customTitle: "My own name" }]);
  put(root, "p", C, [user("   first   thing\n asked, with a very long tail ".repeat(5))]);
  put(root, "p", D, [{ type: "summary", summary: "A summary of it", leafUuid: "x" }, user("hello")]);
  const by = Object.fromEntries(listSessions({ root, workspace: WORK }).map(s => [s.id, s.title]));
  assert.equal(by[A], "Quarterly report plan");
  assert.equal(by[B], "My own name");
  assert.equal(by[D], "A summary of it");
  assert.ok(by[C].length <= 80 && by[C].endsWith("…") && !/\s{2}|\n/.test(by[C]), by[C]);
});

test("only real conversations are listed", t => {
  const { root } = home(t);
  put(root, "p", A, [user("a real one")]);
  put(root, "p", B, [{ type: "mode", mode: "normal" }, { type: "last-prompt", lastPrompt: "x" }]); // nothing was ever asked
  put(root, "p", C, [user("<command-name>/clear</command-name>"), user("[Request interrupted by user]")]);
  put(root, "p", D, [user("a sub-agent's prompt", WORK, { isSidechain: true })]);
  writeFileSync(join(root, "p", "notes.jsonl"), lines([user("not a session id")]));
  writeFileSync(join(root, "p", "not-a-uuid.txt"), "x");
  writeFileSync(join(root, "p", A.replace(/1$/, "9") + ".jsonl"), "");
  mkdirSync(join(root, "p", "subdir"));
  assert.deepEqual(listSessions({ root, workspace: WORK }).map(s => s.id), [A]);
  assert.deepEqual(listSessions({ root: join(root, "missing"), workspace: WORK }), [], "no Claude Code folder at all");
});

test("the setting decides what is shared: everything, the working folder only, or nothing", t => {
  const { root } = home(t);
  put(root, "a", A, [user("in the working folder")]);
  put(root, "b", B, [user("in a project", "/home/me/shop")]);
  put(root, "c", C, [user("in a folder inside it", WORK + "/docs")]);
  put(root, "d", D, [user("in a lookalike", WORK + "-other")]);
  assert.equal(listSessions({ root, workspace: WORK, scope: "all" }).length, 4);
  assert.deepEqual(listSessions({ root, workspace: WORK, scope: "workspace" }).map(s => s.id).sort(), [A, C]);
  assert.deepEqual(listSessions({ root, workspace: WORK, scope: "off" }), []);
  assert.equal(listSessions({ root, workspace: WORK, limit: 2 }).length, 2);
});

test("a session that grows is read again, and one that hasn't changed is not", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [user("question one")]);
  assert.equal(listSessions({ root, workspace: WORK })[0].title, "question one");
  appendFileSync(f, lines([{ type: "custom-title", customTitle: "Renamed in the terminal" }]));
  assert.equal(listSessions({ root, workspace: WORK })[0].title, "Renamed in the terminal");
});

test("a session id is a plain UUID and can never name some other file", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [user("hello")]);
  assert.equal(findSession(A, root), f);
  assert.equal(findSession(A.toUpperCase(), root), f, "case doesn't matter");
  for (const bad of ["../../etc/passwd", "..", "", null, undefined, 5, A + "/../x", A + ".jsonl", "3f8a1c2e", `${A}\0`]) assert.equal(findSession(bad, root), null, String(bad));
  assert.equal(findSession(B, root), null, "not there");
  assert.ok(UUID.test(A) && !UUID.test("x" + A));
  // the same session in two folders: the most recently written one
  const f2 = put(root, "q", A, [user("hello"), user("again")]);
  utimesSync(f, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
  assert.equal(findSession(A, root), f2);
  assert.equal(listSessions({ root, workspace: WORK }).filter(s => s.id === A).length, 1, "listed once");
});

test("the folder a session started in is read from the session itself", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [{ type: "mode", mode: "normal" }, user("hi", "/home/me/shop")]);
  assert.equal(sessionCwd(f), "/home/me/shop");
  assert.equal(sessionCwd(join(root, "nope.jsonl")), "");
  assert.equal(sessionCwd(put(root, "p", B, [{ type: "mode", mode: "normal" }])), "");
});

test("a conversation becomes turns: each question, then everything answered before the next", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [
    { type: "mode", mode: "normal", sessionId: "s" },
    user("Make me a script", WORK, { permissionMode: "plan" }),
    asst([{ type: "thinking", thinking: "A csv sorter is enough." }]),
    asst([{ type: "text", text: "I'll write it." }, { type: "tool_use", id: "t1", name: "Write", input: { file_path: "/home/me/ClaudeConnect/sort.py" } }]),
    result("t1", "wrote"),
    asst([{ type: "tool_use", id: "t2", name: "Bash", input: { command: "python sort.py", description: "Run it" } }]),
    result("t2", "boom", true),
    asst([{ type: "text", text: "It failed, fixing." }, { type: "text", text: "Done now." }]),
    { type: "attachment", attachment: {}, ...base(WORK) },
    user("Thanks. Now add tests"),
    asst([{ type: "text", text: "Added." }], WORK, {}),
    user("one with no reply yet")
  ]);
  const r = readSession(f);
  assert.equal(r.turns, 3);
  assert.equal(r.trimmed, 0);
  assert.equal(r.cwd, WORK);
  assert.deepEqual(r.messages.map(m => m.id), [`i-${A}-0-u`, `i-${A}-0-a`, `i-${A}-1-u`, `i-${A}-1-a`, `i-${A}-2-u`]);
  const [q1, a1, q2, a2, q3] = r.messages;
  assert.equal(q1.content, "Make me a script");
  assert.equal(q1.meta.perm, "plan");
  assert.equal(q1.meta.mode, "code");
  assert.equal(a1.content, "I'll write it.\n\nIt failed, fixing.\n\nDone now.", "text from every step of the answer, in order");
  assert.equal(a1.meta.thinking, "A csv sorter is enough.");
  assert.deepEqual(a1.meta.tools.map(x => [x.id, x.label, x.done, x.error]), [["t1", "Wrote sort.py", true, false], ["t2", "Ran: Run it", true, true]], "a tool that failed says so");
  assert.equal(a1.meta.model, "claude-opus-5-5");
  assert.equal(a1.meta.imported, true);
  assert.equal(q2.content, "Thanks. Now add tests");
  assert.equal(a2.content, "Added.");
  assert.equal(q3.content, "one with no reply yet");
  assert.ok(r.messages.every(m => Number.isFinite(m.created) && m.created > 0));
  assert.ok(r.messages.map(m => m.created).every((c, i, a) => i === 0 || c >= a[i - 1]), "in order");
  assert.equal(new Set(r.messages.map(m => m.id)).size, r.messages.length);
});

test("sub-agents, hooks and damaged lines don't make turns or break the reading", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [
    user("real question"),
    asst([{ type: "text", text: "answer" }]),
    user("sub-agent asks", WORK, { isSidechain: true }),
    asst([{ type: "text", text: "sub-agent answers" }], WORK, { isSidechain: true }),
    user("<local-command-stdout>output</local-command-stdout>"),
    user("noise", WORK, { isMeta: true })
  ]);
  appendFileSync(f, "{ this is not json\n\n   \n{\"type\":\"user\",\"message\":{\"content\":\"cut off in the mid");
  const r = readSession(f);
  assert.equal(r.turns, 1);
  assert.deepEqual(r.messages.map(m => m.content), ["real question", "answer"]);
});

test("asking from a turn onward gives only the newer ones, and from beyond the end gives just the count", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [user("q0"), asst([{ type: "text", text: "a0" }]), user("q1"), asst([{ type: "text", text: "a1" }]), user("q2"), asst([{ type: "text", text: "a2" }])]);
  assert.deepEqual(readSession(f, { from: 1 }).messages.map(m => m.content), ["q1", "a1", "q2", "a2"]);
  assert.deepEqual(readSession(f, { from: 3 }).messages, []);
  assert.equal(readSession(f, { from: 3 }).turns, 3);
  const count = readSession(f, { from: Infinity });
  assert.deepEqual([count.turns, count.messages.length], [3, 0]);
  assert.deepEqual(readSession(f, { from: 1e9 }).messages, []);
  assert.equal(readSession(f, { from: -4 }).messages.length, 6);
  assert.equal(readSession(f, { from: NaN }).messages.length, 0, "an unreadable number means 'just the count'");
  // the ids line up with the turn numbers, so asking again never duplicates a message
  assert.equal(readSession(f, { from: 2 }).messages[0].id, `i-${A}-2-u`);
});

test("a very long conversation is cut to the latest turns, and says how many were left behind", t => {
  const { root } = home(t);
  const es = [];
  for (let i = 0; i < 25; i++) es.push(user("q" + i), asst([{ type: "text", text: "a" + i }]));
  const f = put(root, "p", A, es);
  const r = readSession(f, { from: 0, maxTurns: 10 });
  assert.equal(r.turns, 25);
  assert.equal(r.trimmed, 15);
  assert.equal(r.messages[0].content, "q15");
  assert.equal(r.messages[0].id, `i-${A}-15-u`, "ids keep their real turn number");
  assert.equal(r.messages.length, 20);
  const later = readSession(f, { from: 20, maxTurns: 10 });
  assert.equal(later.trimmed, 0);
  assert.equal(later.messages.length, 10);
});

test("one enormous message can't fill the site's storage", t => {
  const { root } = home(t);
  const f = put(root, "p", A, [user("x".repeat(500000)), asst([{ type: "text", text: "y".repeat(500000) }, { type: "thinking", thinking: "z".repeat(200000) }])]);
  const [q, a] = readSession(f).messages;
  assert.ok(q.content.length <= 120000 && a.content.length <= 120000 && a.meta.thinking.length <= 20000);
});

test("a long conversation of huge messages is cut to the latest turns that fit in a fixed amount of text", t => {
  const { root } = home(t);
  const es = [];
  for (let i = 0; i < 20; i++) es.push(user(`q${i} ` + "x".repeat(110000)), asst([{ type: "text", text: "y".repeat(110000) }]));
  const f = put(root, "p", A, es);
  const r = readSession(f, { from: 0, maxTurns: 300 });
  assert.equal(r.turns, 20, "the count is of the whole conversation");
  const size = r.messages.reduce((n, m) => n + m.content.length, 0);
  assert.ok(size <= 3500000, String(size));
  assert.ok(r.trimmed >= 4 && r.messages.length === (20 - r.trimmed) * 2, `${r.trimmed} left behind`);
  assert.match(r.messages[0].content, new RegExp(`^q${r.trimmed} `), "the oldest turns are the ones left behind");
  assert.match(r.messages[r.messages.length - 2].content, /^q19 /, "the latest is always kept");
  assert.equal(r.messages[0].id, `i-${A}-${r.trimmed}-u`);
});

test("tools get labels a person can read, and files and folders in them are only ever names", () => {
  assert.equal(toolLabel("Read", { file_path: "/home/me/secrets/notes.txt" }), "Read notes.txt");
  assert.equal(toolLabel("Bash", { command: "ls -la" }), "Ran ls -la");
  assert.equal(toolLabel("mcp__github__list_issues", {}), "Used github › list_issues");
  assert.equal(toolLabel("WebFetch", { url: "https://example.com/a/b" }), "Read example.com");
  assert.equal(toolLabel("Mystery"), "Used Mystery");
});

test("a folder is inside another only when it really is", () => {
  assert.equal(within("/a/b", "/a"), true);
  assert.equal(within("/a", "/a"), true);
  assert.equal(within("/a-b", "/a"), false);
  assert.equal(within("/a/../b", "/a"), false);
  assert.equal(within("", "/a"), false);
  assert.equal(within("/a", ""), false);
});

test("Claude Code's folder is found from its own setting, or the usual place", () => {
  assert.equal(projectsDir({}, "/home/me"), join("/home/me", ".claude", "projects"));
  assert.equal(projectsDir({ CLAUDE_CONFIG_DIR: "/elsewhere" }, "/home/me"), join("/elsewhere", "projects"));
});
