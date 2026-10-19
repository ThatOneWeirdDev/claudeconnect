// The watcher that keeps the program running (agent/keepalive.mjs), with stand-in programs.
import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { keepRunning, CANT_RUN } from "../../agent/keepalive.mjs";

const sleep = ms => new Promise(r => setTimeout(r, ms));
function program() {
  const c = new EventEmitter();
  c.signals = [];
  c.kill = sig => {
    c.signals.push(sig);
    setImmediate(() => c.emit("exit", null, sig));
  };
  return c;
}
const watching = [];
afterEach(() => watching.splice(0).forEach(w => w.stop()));
function watch(opts = {}) {
  const started = [];
  const lines = [];
  let ended = null;
  const w = keepRunning({ name: "Site", log: l => lines.push(l), end: code => (ended = code), start: () => started.at(started.push(program()) - 1), tickMs: 10, hangMs: 80, maxDelay: 40, ...opts });
  watching.push(w);
  return { w, started, lines, ended: () => ended };
}

test("a crash is started again, sooner after a good run, and growing while it keeps crashing", async () => {
  const { started, lines } = watch({ hangMs: 1e6, maxDelay: 3000 });
  started[0].emit("exit", 1, null);
  await sleep(1100);
  assert.equal(started.length, 2, "started again after a second");
  assert.match(lines[0], /^Site stopped unexpectedly \(exit code 1\)\. Starting it again\.$/);
  started[1].emit("exit", null, "SIGKILL");
  assert.match(lines[1], /\(ended by the computer, SIGKILL\)\. Starting it again in 2 seconds\./, "the pause grew");
  await sleep(2100);
  assert.equal(started.length, 3);
});

test("asked to stop, or unable to run here, it ends and nothing starts again", async () => {
  let r = watch();
  r.started[0].emit("exit", 0, null);
  assert.equal(r.ended(), 0);
  r = watch();
  r.started[0].emit("exit", CANT_RUN, null);
  assert.equal(r.ended(), CANT_RUN);
  r = watch();
  r.w.stop();
  await sleep(20);
  assert.deepEqual(r.started[0].signals, ["SIGTERM"]);
  assert.equal(r.ended(), 0);
  await sleep(50);
  assert.equal(r.started.length, 1);
});

test("a program that stops saying it's alive is ended and started again; a long reply that keeps saying so isn't", async () => {
  const { started, lines } = watch();
  const talk = setInterval(() => started[0].emit("message", "alive"), 10);
  await sleep(200);
  assert.deepEqual(started[0].signals, [], "still alive");
  clearInterval(talk);
  await sleep(200);
  assert.deepEqual(started[0].signals, ["SIGKILL"]);
  assert.ok(lines.some(l => /^Site stopped answering for \d+ minutes\. Starting it again\.$/.test(l)), lines.join("\n"));
  await sleep(1100);
  assert.ok(started.length >= 2);
});
