// Remote's screen and input on the computer (agent/screen.mjs), with stand-ins for the programs it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeScreen, cleanEvents, jpegSize } from "../../agent/screen.mjs";

const PICTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "screen.jpg"));

// A stand-in for child_process.spawn: `answer(cmd, args, input)` says what each program prints, or for a helper that
// stays running, `helper(msg)` answers each line it's sent.
function fakeSpawn({ answer = () => "", helper = null } = {}) {
  const calls = [];
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    const call = { cmd, args, lines: [] };
    calls.push(call);
    c.kill = () => setImmediate(() => c.emit("close", null));
    if (helper && (cmd === "osascript" || cmd === "powershell.exe")) {
      setImmediate(() => c.stdout.emit("data", JSON.stringify({ ready: true }) + "\n"));
      c.stdin = {
        write(s) {
          for (const line of s.split("\n").filter(Boolean)) {
            const m = JSON.parse(line);
            call.lines.push(m);
            setImmediate(() => c.stdout.emit("data", JSON.stringify({ id: m.id, ...helper(m) }) + "\n"));
          }
        },
        end() {}
      };
      return c;
    }
    c.stdin = { write() {}, end() {} };
    setImmediate(() => {
      let out;
      try {
        out = answer(cmd, args);
      } catch (e) {
        c.stderr.emit("data", e.message);
        return c.emit("close", 1);
      }
      if (out === null) return c.emit("error", Object.assign(new Error("not found"), { code: "ENOENT" }));
      c.stdout.emit("data", Buffer.isBuffer(out) ? out : Buffer.from(String(out)));
      c.emit("close", 0);
    });
    return c;
  };
  return { spawn, calls };
}

test("a JPEG's size comes from its header, and anything else isn't a picture", () => {
  assert.deepEqual(jpegSize(PICTURE), { w: 640, h: 400 });
  assert.equal(jpegSize(Buffer.from("not a jpeg")), null);
  assert.equal(jpegSize(PICTURE.subarray(0, 20)), null);
});

test("only what Remote does is let through, inside the picture and within bounds", () => {
  assert.deepEqual(
    cleanEvents([
      { t: "move", x: -1, y: 9 },
      { t: "down", x: 0.5, y: 0.5, b: 7, n: 9 },
      { t: "scroll", x: 0.1, y: 0.1, dy: 900, dx: 0.4 },
      { t: "text", s: "a\r\nb" },
      { t: "key", k: "F12", mods: ["meta", "rm"] },
      { t: "key", k: "Q", mods: [] },
      { t: "key", k: "<script>" },
      { t: "move", x: "1", y: 0 },
      { t: "shell", s: "ls" },
      null
    ]),
    [
      { t: "move", x: 0, y: 1 },
      { t: "down", x: 0.5, y: 0.5, b: 0, n: 3 },
      { t: "scroll", x: 0.1, y: 0.1, dy: 50, dx: 0 },
      { t: "text", s: "a\nb" },
      { t: "key", k: "F12", mods: ["meta"] },
      { t: "key", k: "q", mods: [] }
    ]
  );
});

test("on Linux, the picture comes from ImageMagick (or ffmpeg), and one xdotool does what was done", async () => {
  const { spawn, calls } = fakeSpawn({ answer: (cmd, args) => (cmd === "import" ? PICTURE : cmd === "xdotool" && args[0] === "getdisplaygeometry" ? "1601 901\n" : "") });
  const s = makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn });
  const f = await s.frame({ width: 1024, quality: 55 });
  assert.deepEqual([f.w, f.h], [640, 400]);
  assert.deepEqual(calls[0].args, ["-silent", "-window", "root", "-resize", "1024x>", "-quality", "55", "jpg:-"]);
  await s.input([{ t: "down", x: 0.5, y: 0.25, b: 2 }, { t: "up", x: 0.5, y: 0.25, b: 2 }, { t: "scroll", x: 1, y: 1, dy: -2, dx: 1 }, { t: "text", s: "hi there" }, { t: "key", k: "c", mods: ["ctrl", "shift"] }, { t: "key", k: "/", mods: ["meta"] }]);
  assert.deepEqual(calls.at(-1).args, ["mousemove", "800", "225", "mousedown", "3", "mousemove", "800", "225", "mouseup", "3", "mousemove", "1600", "900", "click", "--repeat", "2", "4", "click", "--repeat", "1", "7", "type", "--delay", "4", "--", "hi there", "key", "--", "ctrl+shift+c", "key", "--", "super+slash"]);
  // without ImageMagick, ffmpeg; without either, it says what's needed
  const noIm = fakeSpawn({ answer: cmd => (cmd === "import" ? null : PICTURE) });
  assert.deepEqual((await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: noIm.spawn }).frame()).w, 640);
  assert.equal(noIm.calls[1].cmd, "ffmpeg");
  const none = fakeSpawn({ answer: () => null });
  await assert.rejects(makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: none.spawn }).frame(), { code: "missing", message: /needs ImageMagick/ });
  await assert.rejects(makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: none.spawn }).input([{ t: "move", x: 0, y: 0 }]), { code: "missing", message: /needs xdotool/ });
  await assert.rejects(makeScreen({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, spawn }).frame(), { code: "unsupported", message: /Wayland/ });
});

test("on a Mac, screencapture and sips make the picture, and the helper is sent what was done", async () => {
  const { spawn, calls } = fakeSpawn({
    // sips writes the smaller picture where it's told: the stand-in puts the fixture there
    answer: (cmd, args) => {
      if (cmd === "sips") writeFileSync(args[args.indexOf("--out") + 1], PICTURE);
      return "";
    },
    helper: m => (m.t === "ask" ? { view: false, control: true } : { ok: true })
  });
  const s = makeScreen({ platform: "darwin", env: {}, spawn });
  assert.deepEqual((await s.frame({ width: 1440, quality: 70 })).w, 640);
  const shot = calls.find(c => c.cmd === "screencapture");
  assert.deepEqual(shot.args.slice(0, 5), ["-x", "-m", "-C", "-t", "jpg"]);
  assert.deepEqual(calls.find(c => c.cmd === "sips").args.slice(0, 6), ["-s", "format", "jpeg", "-s", "formatOptions", "70"]);
  assert.ok(calls.some(c => c.cmd === "caffeinate" && c.args.join(" ") === "-u -d -t 30"), "the display is woken");
  await s.input([{ t: "key", k: "Enter", mods: [] }, { t: "move", x: 0.5, y: 0.5 }]);
  const helper = calls.find(c => c.cmd === "osascript");
  assert.equal(helper.args[0], "-l");
  assert.deepEqual(helper.lines.at(-1).events, [{ t: "key", k: "Enter", mods: [] }, { t: "move", x: 0.5, y: 0.5 }]);
  assert.deepEqual(await s.ask(), { view: false, control: true });
  s.close();
  // a screen that can't be taken, with the lid closed
  const off = fakeSpawn({ answer: cmd => { if (cmd === "screencapture") throw new Error("could not create image from display"); return ""; } });
  await assert.rejects(makeScreen({ platform: "darwin", env: {}, spawn: off.spawn }).frame(), { code: "no_display", message: /lid closed/ });
  // control that isn't allowed yet says where to allow it
  const denied = fakeSpawn({ helper: () => ({ error: "osascript is not allowed assistive access. (-25211)" }) });
  await assert.rejects(makeScreen({ platform: "darwin", env: {}, spawn: denied.spawn }).input([{ t: "move", x: 0, y: 0 }]), { code: "control_denied", message: /Accessibility/ });
});

test("on Windows, one PowerShell helper takes the pictures and types, with SendKeys' own characters escaped", async () => {
  const { spawn, calls } = fakeSpawn({ helper: m => (m.t === "frame" ? { jpeg: PICTURE.toString("base64") } : { ok: true }) });
  const s = makeScreen({ platform: "win32", env: {}, spawn });
  const f = await s.frame({ width: 800, quality: 50 });
  assert.equal(f.w, 640);
  await s.input([{ t: "text", s: "a+b (c) {d}\n" }, { t: "key", k: "c", mods: ["ctrl"] }, { t: "key", k: "Enter", mods: ["shift"] }, { t: "key", k: "r", mods: ["meta"] }, { t: "down", x: 0.5, y: 0.5, b: 0, n: 1 }]);
  const ps = calls.find(c => c.cmd === "powershell.exe");
  assert.ok(ps.args.includes("-File"));
  assert.deepEqual(ps.lines[0], { t: "frame", w: 800, q: 50, id: 1 });
  assert.deepEqual(ps.lines[1].events, [
    { t: "keys", s: "a{+}b {(}c{)} {{}d{}}{ENTER}" },
    { t: "keys", s: "^c", win: false },
    { t: "keys", s: "+{ENTER}", win: false },
    { t: "keys", s: "r", win: true },
    { t: "down", x: 0.5, y: 0.5, b: 0, n: 1 }
  ]);
  s.close();
});

test("the stand-in screen shows the picture it's given and writes down what was done", async () => {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures");
  const s = makeScreen({ env: { CLAUDECONNECT_SCREEN: "fake:" + join(dir, "screen.jpg") }, dir: "/nonexistent-dir-for-test" });
  assert.equal((await s.frame()).h, 400);
  assert.equal(s.platform, "fake");
  await assert.rejects(s.input([{ t: "move", x: 0, y: 0 }]), /ENOENT/);
});
