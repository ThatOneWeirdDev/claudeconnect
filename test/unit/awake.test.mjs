// Staying awake with the lid closed (agent/awake.mjs), with the system's commands faked: what's run on each system, what
// it reads back, and that a refusal changes nothing.
import { test } from "node:test";
import assert from "node:assert/strict";
import { macSleepDisabled, winLidAction, awakeOn, setAwake, holdAwake } from "../../agent/awake.mjs";

// a stand-in for the system's commands: answers from `answer`, and every call kept
function fake(answer) {
  const calls = [];
  const exec = async (cmd, args, opts) => {
    calls.push([cmd, ...args]);
    return { code: 0, out: "", err: "", ...(answer(cmd, args, opts) || {}) };
  };
  return { exec, calls };
}

test("a Mac: sleep is turned off for the whole system with its own password dialog, and read back from pmset", async () => {
  assert.equal(macSleepDisabled("System-wide power settings:\n SleepDisabled\t\t1\nCurrently in use:\n"), true);
  assert.equal(macSleepDisabled(" SleepDisabled\t\t0\n"), false);
  assert.equal(macSleepDisabled("Currently in use:\n standby 1\n"), false);
  let off = true;
  const { exec, calls } = fake((cmd, args) => {
    if (cmd === "osascript") off = !/disablesleep 1/.test(args[1]);
    if (cmd === "pmset") return { out: ` SleepDisabled\t\t${off ? 0 : 1}\n` };
  });
  const cfg = {};
  assert.equal(await awakeOn({ platform: "darwin", exec }), false);
  assert.equal(await setAwake(true, { platform: "darwin", cfg, exec, name: "ChatGPT" }), "");
  assert.equal(cfg.awake, true);
  const ask = calls.find(c => c[0] === "osascript")[2];
  assert.match(ask, /^do shell script "\/usr\/bin\/pmset -a disablesleep 1" with administrator privileges with prompt "ChatGPT needs your password to keep this Mac awake with the lid closed\."$/);
  assert.equal(await awakeOn({ platform: "darwin", exec }), true);
  // cancelled in the dialog: nothing changes
  const no = fake(cmd => (cmd === "osascript" ? { code: 1, err: "execution error: User canceled. (-128)" } : { out: " SleepDisabled\t\t1\n" }));
  assert.match(await setAwake(false, { platform: "darwin", cfg, exec: no.exec }), /password wasn't given/);
  assert.equal(cfg.awake, true);
});

test("Windows: closing the lid does nothing while it's on, and goes back to what it did before when it's off", async () => {
  const query = (ac, dc) => `Power Setting GUID: 5ca83367-6e45-459f-a27b-476b1d01c936  (Lid close action)\n  Possible Setting Index: 000\n  Current AC Power Setting Index: 0x0000000${ac}\n  Current DC Power Setting Index: 0x0000000${dc}\n`;
  assert.deepEqual(winLidAction(query(1, 2)), { ac: 1, dc: 2 });
  assert.equal(winLidAction("nothing here"), null);
  let lid = { ac: 1, dc: 2 };
  const { exec, calls } = fake((cmd, args) => {
    if (args[0] === "/query") return { out: query(lid.ac, lid.dc) };
    if (args[0] === "/setacvalueindex") lid.ac = +args[4];
    if (args[0] === "/setdcvalueindex") lid.dc = +args[4];
  });
  const cfg = {};
  assert.equal(await setAwake(true, { platform: "win32", cfg, exec }), "");
  assert.deepEqual([lid, cfg.awake, cfg.lidBefore], [{ ac: 0, dc: 0 }, true, { ac: 1, dc: 2 }]);
  assert.ok(calls.some(c => c.join(" ") === "powercfg /setactive SCHEME_CURRENT"));
  assert.equal(await awakeOn({ platform: "win32", cfg, exec }), true);
  assert.equal(await setAwake(false, { platform: "win32", cfg, exec }), "");
  assert.deepEqual([lid, cfg.awake, cfg.lidBefore], [{ ac: 1, dc: 2 }, false, undefined]);
});

test("while it runs, Windows is told the system is in use and Linux holds systemd's locks; each helper goes when the program does", () => {
  const spawned = [];
  const spawn = (cmd, args) => (spawned.push([cmd, args]), { on() {}, unref() {}, kill() { spawned.push(["killed"]); } });
  const win = holdAwake({ platform: "win32", pid: 4242, spawn });
  assert.equal(spawned[0][0], "powershell.exe");
  assert.match(spawned[0][1].at(-1), /SetThreadExecutionState\(\[uint32\]2147483649\)[\s\S]*Get-Process -Id 4242/);
  win.release();
  assert.deepEqual(spawned[1], ["killed"]);
  holdAwake({ platform: "linux", pid: 4242, name: "ChatGPT", spawn });
  assert.equal(spawned[2][0], "systemd-inhibit");
  assert.deepEqual(spawned[2][1].slice(0, 4), ["--what=sleep:idle:handle-lid-switch", "--who=ChatGPT", "--why=Answering on your site", "--mode=block"]);
  assert.match(spawned[2][1].at(-1), /kill -0 4242/);
  assert.equal(holdAwake({ platform: "darwin", spawn }), null, "a Mac needs nothing held: sleep is off for the whole system");
});
