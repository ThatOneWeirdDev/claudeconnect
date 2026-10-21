// Remote's screen and input on the computer (agent/screen.mjs), with stand-ins for the programs it runs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync, writeFileSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import os from "node:os";
import { makeScreen, cleanEvents, jpegSize, splitJpegs, splitSized, MAC_STREAM } from "../../agent/screen.mjs";

const PICTURE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "screen.jpg"));
const OTHER = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "screen2.jpg"));
// a picture as the Mac helper sends it: its length, then it
const sized = f => Buffer.concat([Buffer.from([f.length >>> 24, (f.length >>> 16) & 255, (f.length >>> 8) & 255, f.length & 255]), f]);

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

test("on a Mac, screencapture and sips make the picture, and the helper is sent what was done", async t => {
  const { spawn, calls } = fakeSpawn({
    // sips writes the smaller picture where it's told: the stand-in puts the fixture there
    answer: (cmd, args) => {
      if (cmd === "sips") writeFileSync(args[args.indexOf("--out") + 1], PICTURE);
      return "";
    },
    helper: m => (m.t === "ask" ? { view: false, control: true } : { ok: true })
  });
  const dir = mkdtempSync(join(os.tmpdir(), "cc-screen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const s = makeScreen({ platform: "darwin", env: {}, spawn, dir });
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
  // the streaming helper isn't built without Apple's command line tools, and asking for them isn't how it finds out

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

test("the page's mark is looked for in this computer's window titles: xdotool on Linux, the helper on a Mac", async () => {
  const tag = "​‌‍⁠​‌";
  const found = fakeSpawn({ answer: (cmd, args) => (cmd === "xdotool" && args[0] === "search" && args[2] === tag ? "41943047\n" : "") });
  assert.equal(await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: found.spawn }).showing(tag), true);
  assert.deepEqual(found.calls[0].args, ["search", "--name", tag]);
  const none = fakeSpawn({ answer: () => { throw new Error(""); } });
  assert.equal(await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: none.spawn }).showing(tag), false, "xdotool found no window");
  const missing = fakeSpawn({ answer: () => null });
  assert.equal(await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: missing.spawn }).showing(tag), null, "no xdotool: can't tell");
  const mac = fakeSpawn({ helper: m => (m.t === "windows" ? { found: m.tag === tag } : { ok: true }) });
  const s = makeScreen({ platform: "darwin", env: {}, spawn: mac.spawn });
  assert.equal(await s.showing(tag), true);
  s.close();
  // anything that isn't a mark isn't looked for at all
  const asked = fakeSpawn();
  assert.equal(await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: asked.spawn }).showing("Remote · Site"), false);
  assert.equal(asked.calls.length, 0);
});

test("live pictures are cut from what ffmpeg and the Mac helper send, however it's split up", () => {
  const got = [];
  const feed = splitJpegs(f => got.push(f));
  const both = Buffer.concat([Buffer.from("junk"), PICTURE, OTHER]);
  for (let i = 0; i < both.length; i += 1000) feed(both.subarray(i, i + 1000));
  assert.deepEqual(got, [PICTURE, OTHER]);
  const cut = [];
  const feed2 = splitSized(f => cut.push(f));
  const framed = Buffer.concat([sized(PICTURE), sized(OTHER)]);
  feed2(framed.subarray(0, 3));
  feed2(framed.subarray(3, PICTURE.length + 6));
  assert.deepEqual(cut, [PICTURE]);
  feed2(framed.subarray(PICTURE.length + 6));
  assert.deepEqual(cut, [PICTURE, OTHER]);
});

test("live on Linux: ffmpeg streams the screen, the newest picture each time; without it, or once it stops, one picture at a time", async () => {
  const { spawn, calls } = fakeSpawn({ answer: cmd => (cmd === "ffmpeg" ? Buffer.concat([PICTURE, OTHER]) : cmd === "import" ? PICTURE : "") });
  const live = makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn }).stream({ width: 1280, quality: 60 });
  assert.deepEqual(await live.next(), OTHER, "the newest of what came");
  const ff = calls.find(c => c.cmd === "ffmpeg");
  assert.deepEqual(ff.args.slice(ff.args.indexOf("-f"), ff.args.indexOf("-f") + 8), ["-f", "x11grab", "-draw_mouse", "1", "-framerate", "30", "-i", ":0"]);
  assert.ok(ff.args.includes("scale='min(1280,iw)':-2") && ff.args.at(-1) === "-", ff.args.join(" "));
  // ffmpeg ended: the next one is taken by itself
  assert.deepEqual(await live.next(), PICTURE);
  assert.equal(calls.at(-1).cmd, "import");
  live.stop();
  await assert.rejects(live.next(), { code: "stopped" });
  // no ffmpeg at all
  const none = fakeSpawn({ answer: cmd => (cmd === "ffmpeg" ? null : cmd === "import" ? OTHER : "") });
  assert.deepEqual(await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: none.spawn }).stream().next(), OTHER);
  // a screen that can't be taken says why, as one picture would
  const wayland = makeScreen({ platform: "linux", env: { WAYLAND_DISPLAY: "wayland-0" }, spawn }).stream();
  await assert.rejects(wayland.next(), { code: "unsupported" });
});

test("live on a Mac: the helper is built once with Apple's tools, if they're there, and a still screen is waited on, not given up on", async t => {
  const dir = mkdtempSync(join(os.tmpdir(), "cc-screen-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const bin = join(dir, `screen-mac-${createHash("sha256").update(MAC_STREAM).digest("hex").slice(0, 12)}`);
  // no command line tools: xcode-select says so, and nothing that would offer to install them is run
  const bare = fakeSpawn({ answer: cmd => { if (cmd === "xcode-select") throw new Error("unable to get active developer directory"); return ""; } });
  assert.equal(await makeScreen({ platform: "darwin", env: {}, spawn: bare.spawn, dir }).buildMacHelper(), false);
  assert.deepEqual(bare.calls.map(c => c.cmd), ["xcode-select"]);
  // with them: swiftc builds it for macOS 12.3 and later, once
  const tools = fakeSpawn({ answer: (cmd, args) => { if (cmd === "xcrun") writeFileSync(args[args.indexOf("-o") + 1], "built"); return ""; } });
  const s = makeScreen({ platform: "darwin", env: {}, spawn: tools.spawn, dir });
  assert.equal(await s.buildMacHelper(), true);
  const xc = tools.calls.find(c => c.cmd === "xcrun");
  assert.deepEqual(xc.args.slice(0, 4), ["swiftc", "-O", "-target", `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.3`]);
  assert.ok(existsSync(bin) && !existsSync(bin + ".swift"));
  await makeScreen({ platform: "darwin", env: {}, spawn: tools.spawn, dir }).buildMacHelper();
  assert.equal(tools.calls.filter(c => c.cmd === "xcrun").length, 1, "already built");

  // the helper: sized pictures, only when the screen changes; it runs until its input closes
  let helper = null;
  const spawn = (cmd, args) => {
    const c = new EventEmitter();
    c.stdout = new EventEmitter();
    c.stderr = new EventEmitter();
    c.kill = () => {};
    if (cmd !== bin) {
      c.stdin = { write() {}, end() {} };
      setImmediate(() => c.emit("close", 0));
      return c;
    }
    helper = { args, ended: false, send: f => c.stdout.emit("data", sized(f)) };
    c.stdin = { write() {}, end: () => (helper.ended = true) };
    setImmediate(() => helper.send(PICTURE));
    return c;
  };
  const live = makeScreen({ platform: "darwin", env: {}, spawn, dir }).stream({ width: 1600, quality: 60, fps: 20 });
  assert.deepEqual(await live.next(), PICTURE);
  assert.deepEqual(helper.args, ["1600", "0.6", "20"]);
  let next = null;
  const waiting = live.next().then(f => (next = f));
  await new Promise(r => setTimeout(r, 200));
  assert.equal(next, null, "nothing changed, nothing sent, still waiting");
  helper.send(OTHER);
  await waiting;
  assert.deepEqual(next, OTHER);
  live.stop();
  assert.equal(helper.ended, true);
});

test("a Mac reports what Remote is allowed, and re-requesting opens the Settings pane only for what isn't on yet", async t => {
  const dir = mkdtempSync(join(os.tmpdir(), "cc-perms-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let state = { view: false, control: false };
  const { spawn, calls } = fakeSpawn({ answer: (cmd, args) => (cmd === "sips" ? (writeFileSync(args[args.indexOf("--out") + 1], PICTURE), "") : ""), helper: m => (m.t === "ask" || m.t === "check" ? state : { ok: true }) });
  const s = makeScreen({ platform: "darwin", env: {}, spawn, dir });
  const opened = () => calls.filter(c => c.cmd === "open").map(c => c.args[0]);
  // reading only: asks the helper to check, opens nothing
  assert.deepEqual(await s.perms(), { view: false, control: false });
  assert.equal(calls.find(c => c.cmd === "osascript").lines.at(-1).t, "check");
  assert.deepEqual(opened(), []);
  // re-request: prompts, and opens the pane for each one still off
  assert.deepEqual(await s.perms({ prompt: true, open: true }), { view: false, control: false });
  assert.equal(calls.find(c => c.cmd === "osascript").lines.at(-1).t, "ask");
  assert.equal(opened().length, 2);
  assert.ok(opened().some(u => /ScreenCapture/.test(u)) && opened().some(u => /Accessibility/.test(u)));
  // once Screen Recording is on, re-requesting opens only Accessibility
  state = { view: true, control: false };
  await s.perms({ open: true });
  assert.equal(opened().filter(u => /ScreenCapture/.test(u)).length, 1, "the Screen Recording pane isn't opened again");
  assert.equal(opened().filter(u => /Accessibility/.test(u)).length, 2);
  s.close();
  // anywhere else, both are always allowed and nothing is opened
  const lin = fakeSpawn();
  assert.deepEqual(await makeScreen({ platform: "linux", env: { DISPLAY: ":0" }, spawn: lin.spawn }).perms({ prompt: true, open: true }), { view: true, control: true });
  assert.equal(lin.calls.length, 0);
});
