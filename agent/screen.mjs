// Remote: this computer's screen on the site, and its mouse and keyboard from there. The page asks for one picture of the
// screen at a time (a JPEG, scaled down), and sends what you do over it: where the mouse goes, its buttons, the wheel, keys
// and typed text, with positions as fractions of the picture (0 to 1) so they fit whatever size it's shown at.
//
// - macOS: `screencapture` takes the picture and `sips` scales it; the mouse is driven with CoreGraphics events and the
//   keyboard through System Events, both from one small JavaScript-for-Automation helper that stays running while Remote is
//   in use. macOS asks once to allow Screen Recording and Accessibility (for node, the program running this). A Mac with its
//   lid closed and no other display has no screen to show.
// - Windows: one PowerShell helper takes the pictures and moves the mouse and types (System.Drawing and user32).
// - Linux: X11 only. ImageMagick's `import` (or ffmpeg) takes the pictures, and xdotool, when it's installed, does the rest.
//
// CLAUDECONNECT_SCREEN=fake:<file.jpg> shows that picture instead, and writes what's done to screen-input.jsonl (for tests).
import { spawn as nodeSpawn } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, mkdirSync, unlinkSync, rmSync, existsSync, renameSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import os from "node:os";

export class ScreenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// The width and height a JPEG says it is, from its frame header.
export function jpegSize(b) {
  if (!b || b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 8 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { w: b.readUInt16BE(i + 7), h: b.readUInt16BE(i + 5) };
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

// What the page sends, checked and cleaned: anything else is dropped.
const KEYS = new Set(["Enter", "Tab", "Backspace", "Escape", "Delete", "Home", "End", "PageUp", "PageDown", "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Space", "Insert", ...Array.from({ length: 12 }, (_, i) => "F" + (i + 1))]);
const MODS = ["ctrl", "alt", "shift", "meta"];
export function cleanEvents(list) {
  const out = [];
  const frac = v => (typeof v === "number" && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : null);
  for (const e of Array.isArray(list) ? list.slice(0, 200) : []) {
    if (!e || typeof e !== "object") continue;
    const mods = Array.isArray(e.mods) ? MODS.filter(m => e.mods.includes(m)) : [];
    if (e.t === "move" || e.t === "down" || e.t === "up") {
      const x = frac(e.x);
      const y = frac(e.y);
      if (x === null || y === null) continue;
      const ev = { t: e.t, x, y };
      if (e.t !== "move") {
        ev.b = e.b === 2 ? 2 : e.b === 1 ? 1 : 0;
        ev.n = Math.min(3, Math.max(1, Math.round(Number(e.n)) || 1));
      }
      out.push(ev);
    } else if (e.t === "scroll") {
      const x = frac(e.x);
      const y = frac(e.y);
      const dy = Math.max(-50, Math.min(50, Math.round(Number(e.dy)) || 0));
      const dx = Math.max(-50, Math.min(50, Math.round(Number(e.dx)) || 0));
      if (x === null || y === null || (!dy && !dx)) continue;
      out.push({ t: "scroll", x, y, dy, dx });
    } else if (e.t === "text" && typeof e.s === "string" && e.s) {
      out.push({ t: "text", s: e.s.replace(/\r\n?/g, "\n").slice(0, 2000) });
    } else if (e.t === "key" && typeof e.k === "string" && (KEYS.has(e.k) || /^[a-z0-9]$/i.test(e.k) || /^[-=[\];',./`\\]$/.test(e.k))) {
      out.push({ t: "key", k: e.k.length === 1 ? e.k.toLowerCase() : e.k, mods });
    }
  }
  return out;
}

// ---- macOS
const MAC_KEYCODES = { Enter: 36, Tab: 48, Space: 49, Backspace: 51, Escape: 53, Delete: 117, Home: 115, End: 119, PageUp: 116, PageDown: 121, ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126, Insert: 114, F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97, F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111 };
// The helper: reads one JSON message a line from its input (ASCII only: the program escapes the rest), and answers each
// with a line of JSON. Mouse positions come in as fractions and are placed on the main display, in points.
const MAC_HELPER = String.raw`
ObjC.import("Cocoa");
ObjC.import("CoreGraphics");
try { ObjC.import("ApplicationServices"); } catch (e) {}
const KEYCODES = __KEYCODES__;
const out = $.NSFileHandle.fileHandleWithStandardOutput;
function say(o) { out.writeData($(JSON.stringify(o) + "\n").dataUsingEncoding($.NSUTF8StringEncoding)); }
// the display with the menu bar, which is the one screencapture -m takes
function size() { const f = $.NSScreen.screens.objectAtIndex(0).frame; return { w: f.size.width, h: f.size.height }; }
function trusted(prompt) {
  try { return prompt ? !!$.AXIsProcessTrustedWithOptions($({ AXTrustedCheckOptionPrompt: true })) : !!$.AXIsProcessTrusted(); } catch (e) { return null; }
}
function canRecord(prompt) {
  try { return prompt ? !!$.CGRequestScreenCaptureAccess() : !!$.CGPreflightScreenCaptureAccess(); } catch (e) { return null; }
}
const held = { 0: false, 1: false, 2: false };
function mouse(type, x, y, button, clicks) {
  const e = $.CGEventCreateMouseEvent(null, type, $.CGPointMake(x, y), button);
  if (clicks) $.CGEventSetIntegerValueField(e, 1, clicks);
  $.CGEventPost(0, e);
}
// Whether a window on this Mac has the tag in its title: from CoreGraphics' window list (titles need Screen Recording, which
// Remote has), or else from System Events (which needs Accessibility). Null when neither can tell.
function showing(tag) {
  try {
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1, 0))) || [];
    if (list.some(w => String(w.kCGWindowName || "").indexOf(tag) >= 0)) return true;
    if (list.some(w => w.kCGWindowName && w.kCGWindowOwnerPID !== $.NSProcessInfo.processInfo.processIdentifier)) return false;
  } catch (e) {}
  try {
    return String(Application("System Events").processes.whose({ backgroundOnly: false }).windows.name()).indexOf(tag) >= 0;
  } catch (e) {
    return null;
  }
}
const DOWN = { 0: 1, 1: 25, 2: 3 }, UP = { 0: 2, 1: 26, 2: 4 }, DRAG = { 0: 6, 1: 27, 2: 7 }, BUTTON = { 0: 0, 1: 2, 2: 1 };
function using(mods) {
  const u = [];
  for (const [m, w] of [["meta", "command down"], ["ctrl", "control down"], ["alt", "option down"], ["shift", "shift down"]]) if (mods.indexOf(m) >= 0) u.push(w);
  return u;
}
function apply(ev, se) {
  const s = size();
  const x = ev.x * s.w, y = ev.y * s.h;
  if (ev.t === "move") {
    const b = held[0] ? 0 : held[2] ? 2 : held[1] ? 1 : -1;
    mouse(b < 0 ? 5 : DRAG[b], x, y, b < 0 ? 0 : BUTTON[b], 0);
  } else if (ev.t === "down") {
    held[ev.b] = true;
    mouse(DOWN[ev.b], x, y, BUTTON[ev.b], ev.n);
  } else if (ev.t === "up") {
    held[ev.b] = false;
    mouse(UP[ev.b], x, y, BUTTON[ev.b], ev.n);
  } else if (ev.t === "scroll") {
    mouse(5, x, y, 0, 0);
    let e;
    if (typeof $.CGEventCreateScrollWheelEvent2 === "function") e = $.CGEventCreateScrollWheelEvent2(null, 1, 2, -ev.dy, -ev.dx, 0);
    else {
      e = $.CGEventCreate(null);
      $.CGEventSetType(e, 22);
      $.CGEventSetIntegerValueField(e, 11, -ev.dy);
      $.CGEventSetIntegerValueField(e, 12, -ev.dx);
    }
    $.CGEventPost(0, e);
  } else if (ev.t === "text") {
    const parts = ev.s.split("\n");
    parts.forEach((p, i) => {
      if (p) se.keystroke(p);
      if (i < parts.length - 1) se.keyCode(36);
    });
  } else if (ev.t === "key") {
    const code = KEYCODES[ev.k];
    const opts = { using: using(ev.mods) };
    if (code !== undefined) se.keyCode(code, opts);
    else se.keystroke(ev.k, opts);
  }
}
function run() {
  const se = Application("System Events");
  say({ ready: true, view: canRecord(false), control: trusted(false) });
  const input = $.NSFileHandle.fileHandleWithStandardInput;
  let buf = "";
  for (;;) {
    const data = input.availableData;
    if (data.length === 0) break;
    buf += $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding).js;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      let m = null;
      try {
        m = JSON.parse(line);
        if (m.t === "ask") say({ id: m.id, view: canRecord(true), control: trusted(true) });
        else if (m.t === "check") say({ id: m.id, view: canRecord(false), control: trusted(false) });
        else if (m.t === "windows") say({ id: m.id, found: showing(m.tag) });
        else {
          for (const ev of m.events) apply(ev, se);
          say({ id: m.id, ok: true });
        }
      } catch (e) {
        say({ id: m && m.id, error: String(e && e.message || e) });
      }
    }
  }
}
`;

// ---- Windows
const WIN_SENDKEYS = { Enter: "{ENTER}", Tab: "{TAB}", Backspace: "{BACKSPACE}", Escape: "{ESC}", Delete: "{DELETE}", Home: "{HOME}", End: "{END}", PageUp: "{PGUP}", PageDown: "{PGDN}", ArrowLeft: "{LEFT}", ArrowRight: "{RIGHT}", ArrowUp: "{UP}", ArrowDown: "{DOWN}", Space: " ", Insert: "{INSERT}", ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => ["F" + (i + 1), `{F${i + 1}}`])) };
const WIN_HELPER = String.raw`
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class CCScreen {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  public static bool Showing(string tag) {
    bool found = false;
    EnumWindows(delegate (IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var t = new System.Text.StringBuilder(1024);
      GetWindowText(h, t, 1024);
      if (t.ToString().Contains(tag)) { found = true; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
"@
[CCScreen]::SetProcessDPIAware() | Out-Null
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
function Say($s) { [Console]::Out.WriteLine($s); [Console]::Out.Flush() }
$downs = @{ 0 = 0x0002; 1 = 0x0020; 2 = 0x0008 }
$ups = @{ 0 = 0x0004; 1 = 0x0040; 2 = 0x0010 }
Say '{"ready":true,"view":true,"control":true}'
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $m = $null
  try {
    $m = $line | ConvertFrom-Json
    $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
    if ($m.t -eq "frame") {
      $shot = New-Object System.Drawing.Bitmap $b.Width, $b.Height
      $g = [System.Drawing.Graphics]::FromImage($shot)
      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $shot.Size)
      try { $p = [System.Windows.Forms.Cursor]::Position; [System.Windows.Forms.Cursors]::Default.Draw($g, (New-Object System.Drawing.Rectangle ($p.X - $b.Left), ($p.Y - $b.Top), 32, 32)) } catch {}
      $w = [Math]::Min([int]$m.w, $b.Width)
      $h = [int][Math]::Round($b.Height * $w / $b.Width)
      $small = New-Object System.Drawing.Bitmap $w, $h
      $g2 = [System.Drawing.Graphics]::FromImage($small)
      $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBilinear
      $g2.DrawImage($shot, 0, 0, $w, $h)
      $ms = New-Object System.IO.MemoryStream
      $ep = New-Object System.Drawing.Imaging.EncoderParameters 1
      $ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), ([long]$m.q)
      $small.Save($ms, $codec, $ep)
      $g.Dispose(); $g2.Dispose(); $shot.Dispose(); $small.Dispose()
      Say ('{"id":' + $m.id + ',"jpeg":"' + [Convert]::ToBase64String($ms.ToArray()) + '"}')
    } elseif ($m.t -eq "windows") {
      Say ('{"id":' + $m.id + ',"found":' + ([CCScreen]::Showing([string]$m.tag)).ToString().ToLower() + '}')
    } else {
      foreach ($e in $m.events) {
        $x = [int]($b.Left + $e.x * ($b.Width - 1)); $y = [int]($b.Top + $e.y * ($b.Height - 1))
        if ($e.t -eq "move") { [CCScreen]::SetCursorPos($x, $y) | Out-Null }
        elseif ($e.t -eq "down") { [CCScreen]::SetCursorPos($x, $y) | Out-Null; [CCScreen]::mouse_event($downs[[int]$e.b], 0, 0, 0, [UIntPtr]::Zero) }
        elseif ($e.t -eq "up") { [CCScreen]::SetCursorPos($x, $y) | Out-Null; [CCScreen]::mouse_event($ups[[int]$e.b], 0, 0, 0, [UIntPtr]::Zero) }
        elseif ($e.t -eq "scroll") {
          [CCScreen]::SetCursorPos($x, $y) | Out-Null
          if ($e.dy) { [CCScreen]::mouse_event(0x0800, 0, 0, -120 * [int]$e.dy, [UIntPtr]::Zero) }
          if ($e.dx) { [CCScreen]::mouse_event(0x1000, 0, 0, 120 * [int]$e.dx, [UIntPtr]::Zero) }
        }
        elseif ($e.t -eq "keys") {
          if ($e.win) { [CCScreen]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero) }
          [System.Windows.Forms.SendKeys]::SendWait($e.s)
          if ($e.win) { [CCScreen]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero) }
        }
      }
      Say ('{"id":' + $m.id + ',"ok":true}')
    }
  } catch {
    $id = if ($m) { $m.id } else { 0 }
    Say ('{"id":' + $id + ',"error":' + (ConvertTo-Json ([string]$_.Exception.Message)) + '}')
  }
}
`;
// SendKeys treats these as instructions, so typed they're put in braces
const sendKeysText = s => s.replace(/[+^%~(){}[\]]/g, c => `{${c}}`).replace(/\n/g, "{ENTER}");
function winKeys(ev) {
  if (ev.t === "text") return { t: "keys", s: sendKeysText(ev.s) };
  const prefix = (ev.mods.includes("ctrl") ? "^" : "") + (ev.mods.includes("alt") ? "%" : "") + (ev.mods.includes("shift") ? "+" : "");
  const key = WIN_SENDKEYS[ev.k] || sendKeysText(ev.k);
  return { t: "keys", s: prefix + (prefix && key.length > 1 && !key.startsWith("{") ? `(${key})` : key), win: ev.mods.includes("meta") };
}

// ---- Linux (X11)
const X_KEYS = { Enter: "Return", Tab: "Tab", Backspace: "BackSpace", Escape: "Escape", Delete: "Delete", Home: "Home", End: "End", PageUp: "Prior", PageDown: "Next", ArrowLeft: "Left", ArrowRight: "Right", ArrowUp: "Up", ArrowDown: "Down", Space: "space", Insert: "Insert", "-": "minus", "=": "equal", "[": "bracketleft", "]": "bracketright", ";": "semicolon", "'": "apostrophe", ",": "comma", ".": "period", "/": "slash", "`": "grave", "\\": "backslash" };
const X_MODS = { ctrl: "ctrl", alt: "alt", shift: "shift", meta: "super" };

// Runs a program and gives back what it printed, or throws with what it said went wrong.
function run(spawn, cmd, args, { timeout = 15000, env, input } = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(cmd, args, { env, windowsHide: true });
    } catch (e) {
      return reject(e);
    }
    const out = [];
    let err = "";
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", d => out.push(d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", code => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out));
      else reject(Object.assign(new Error(err.trim().slice(0, 300) || `${cmd} ended with code ${code}`), { code: "EXIT" }));
    });
    if (input !== undefined) child.stdin.end(input);
  });
}

// A helper that stays running, answering one JSON line with another, matched by id.
function lineHelper(spawn, cmd, args, { env, onEnd } = {}) {
  const child = spawn(cmd, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const waiting = new Map();
  let ready;
  const readyP = new Promise(r => (ready = r));
  let buf = "";
  let err = "";
  let n = 0;
  child.stdout.on("data", d => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      let m;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      if (m.ready) ready(m);
      const w = waiting.get(m.id);
      if (w) {
        waiting.delete(m.id);
        w(m);
      }
    }
  });
  child.stderr.on("data", d => (err = (err + d).slice(-2000)));
  const end = () => {
    ready(null);
    for (const w of waiting.values()) w({ error: err.trim() || "The helper stopped." });
    waiting.clear();
    if (onEnd) onEnd();
  };
  child.on("error", end);
  child.on("close", end);
  return {
    ready: readyP,
    ask(msg, ms = 20000) {
      const id = ++n;
      return new Promise(resolve => {
        const t = setTimeout(() => {
          waiting.delete(id);
          resolve({ error: "The helper didn't answer in time." });
        }, ms);
        waiting.set(id, m => {
          clearTimeout(t);
          resolve(m);
        });
        // ASCII only, so a character is never split between two reads
        try {
          child.stdin.write(JSON.stringify({ ...msg, id }).replace(/[\u007f-\uffff]/g, c => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n");
        } catch {}
      });
    },
    close() {
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
    }
  };
}

// ---- live pictures

// A Mac's screen as a stream, through ScreenCaptureKit (macOS 12.3 and newer): a small Swift program, built on the Mac the
// first time Remote is used there if Apple's command line tools are installed (they come with git). It writes each new
// picture as 4 bytes of length and the JPEG, only when something on the screen changed, scaled to the width it's given.
export const MAC_STREAM = String.raw`
import Foundation
import ScreenCaptureKit
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import ImageIO

let args = CommandLine.arguments
let maxWidth = args.count > 1 ? (Int(args[1]) ?? 1600) : 1600
let quality = args.count > 2 ? (Double(args[2]) ?? 0.6) : 0.6
let fps = args.count > 3 ? (Int32(args[3]) ?? 20) : 20
let out = FileHandle.standardOutput
let context = CIContext()
let space = CGColorSpace(name: CGColorSpace.sRGB)!
var running: SCStream?

func fail(_ text: String, _ code: Int32) -> Never {
  FileHandle.standardError.write((text + "\n").data(using: .utf8)!)
  exit(code)
}

final class Sink: NSObject, SCStreamOutput, SCStreamDelegate {
  func stream(_ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, let pixels = CMSampleBufferGetImageBuffer(buffer) else { return }
    // only whole new pictures: an idle one repeats the last
    guard let infos = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let info = infos.first, let raw = info[SCStreamFrameInfo.status] as? Int,
          let status = SCFrameStatus(rawValue: raw), status == .complete else { return }
    let image = CIImage(cvPixelBuffer: pixels)
    guard let jpeg = context.jpegRepresentation(of: image, colorSpace: space, options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: quality]) else { return }
    var size = UInt32(jpeg.count).bigEndian
    out.write(Data(bytes: &size, count: 4) + jpeg)
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    fail("stopped: \(error.localizedDescription)", 2)
  }
}

let sink = Sink()
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    guard let display = content.displays.first(where: { $0.displayID == CGMainDisplayID() }) ?? content.displays.first else { fail("no display", 3) }
    let config = SCStreamConfiguration()
    let width = min(maxWidth, display.width * 2)
    config.width = width
    config.height = max(1, width * display.height / max(1, display.width))
    config.minimumFrameInterval = CMTime(value: 1, timescale: fps)
    config.showsCursor = true
    config.queueDepth = 3
    config.pixelFormat = kCVPixelFormatType_32BGRA
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: config, delegate: sink)
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "frames"))
    try await stream.startCapture()
    running = stream
  } catch {
    fail("failed: \(error.localizedDescription)", 4)
  }
}
// it ends with the program that started it, when that end of its input closes
DispatchQueue.global().async {
  _ = FileHandle.standardInput.readDataToEndOfFile()
  exit(0)
}
RunLoop.main.run()
`;

// A stream of JPEGs one after another (ffmpeg's mjpeg), cut into pictures: each runs from its start marker to its end
// marker, which can't occur inside one.
export function splitJpegs(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    for (;;) {
      const s = buf.indexOf(JPEG_START);
      if (s < 0) {
        buf = Buffer.alloc(0);
        return;
      }
      const e = buf.indexOf(JPEG_END, s + 2);
      if (e < 0) {
        if (s > 0) buf = buf.subarray(s);
        return;
      }
      onFrame(Buffer.from(buf.subarray(s, e + 2)));
      buf = buf.subarray(e + 2);
    }
  };
}
const JPEG_START = Buffer.from([0xff, 0xd8]);
const JPEG_END = Buffer.from([0xff, 0xd9]);

// The Mac helper's pictures: 4 bytes of length, then that many bytes.
export function splitSized(onFrame) {
  let buf = Buffer.alloc(0);
  return chunk => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const n = buf.readUInt32BE(0);
      if (buf.length < 4 + n) return;
      onFrame(Buffer.from(buf.subarray(4, 4 + n)));
      buf = buf.subarray(4 + n);
    }
  };
}

// A program that keeps sending pictures: the newest one waits to be taken, older ones are dropped. `first` settles with the
// first picture, or with why there won't be one.
function pushSource(spawn, cmd, args, { env, split, name }) {
  let latest = null;
  let seq = 0;
  let given = 0;
  let error = null;
  let waiters = [];
  let firstOk;
  let firstNo;
  const first = new Promise((ok, no) => {
    firstOk = ok;
    firstNo = no;
  });
  first.catch(() => {});
  const wake = () => waiters.splice(0).forEach(w => w());
  let child;
  let err = "";
  try {
    child = spawn(cmd, args, { env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  } catch (e) {
    error = e;
    firstNo(e);
    return { first, next: () => Promise.reject(e), stop() {} };
  }
  const feed = split(f => {
    latest = f;
    seq++;
    firstOk(true);
    wake();
  });
  child.stdout.on("data", feed);
  child.stderr.on("data", d => (err = (err + d).slice(-2000)));
  const end = e => {
    error = error || e;
    firstNo(error);
    wake();
  };
  child.on("error", e => end(e));
  child.on("close", code => end(Object.assign(new Error(`${name} stopped${err.trim() ? ": " + err.trim().split("\n").pop() : ` (${code})`}`), { code: "EXIT" })));
  return {
    first,
    // waits for a picture newer than the last one taken: a screen that doesn't change sends none (the Mac helper), and
    // that's no reason to stop waiting
    async next() {
      while (seq === given && !error) await new Promise(r => waiters.push(r));
      if (seq !== given) {
        given = seq;
        return latest;
      }
      throw error;
    },
    stop() {
      error = error || new Error("stopped");
      wake();
      try {
        child.stdin.end();
      } catch {}
      try {
        child.kill();
      } catch {}
    }
  };
}

// One picture at a time, the next one already being taken while the last is on its way (a picture taken more than a moment
// ago is thrown away rather than shown late).
function pullSource(take) {
  let ahead = null;
  let at = 0;
  return {
    first: Promise.resolve(true),
    next() {
      const p = ahead && Date.now() - at < 500 ? ahead : take();
      ahead = take();
      at = Date.now();
      ahead.catch(() => {});
      return p;
    },
    stop() {
      ahead = null;
    }
  };
}

export function makeScreen({ platform = process.platform, env = process.env, spawn = nodeSpawn, dir = os.tmpdir(), log = () => {} } = {}) {
  const fake = /^fake:(.+)$/.exec(env.CLAUDECONNECT_SCREEN || "");
  const tmp = join(os.tmpdir(), `claudeconnect-screen-${process.pid}`);
  let helper = null;
  let helperInfo = null;
  let idle = null;
  let awakeAt = 0;
  let xSize = null;
  let shots = 0;
  let building = null;

  // the helper starts when Remote is used, and stops after a minute without it
  function touch() {
    clearTimeout(idle);
    idle = setTimeout(close, 60000);
    idle.unref?.();
  }
  async function getHelper() {
    touch();
    if (helper) return helper;
    mkdirSync(tmp, { recursive: true });
    const ended = () => {
      if (helper === h) helper = null;
    };
    let h;
    if (platform === "darwin") {
      const file = join(tmp, "helper.js");
      writeFileSync(file, MAC_HELPER.replace("__KEYCODES__", JSON.stringify(MAC_KEYCODES)));
      h = lineHelper(spawn, "osascript", ["-l", "JavaScript", file], { env, onEnd: ended });
    } else if (platform === "win32") {
      const file = join(tmp, "helper.ps1");
      writeFileSync(file, WIN_HELPER);
      h = lineHelper(spawn, "powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], { env, onEnd: ended });
    } else return null;
    helper = h;
    let slow;
    helperInfo = await Promise.race([h.ready, new Promise(r => (slow = setTimeout(() => r(null), 20000)))]);
    clearTimeout(slow);
    if (!helperInfo) {
      h.close();
      if (helper === h) helper = null;
      throw new ScreenError("helper", platform === "darwin" ? "This Mac didn't start the Remote helper (osascript)." : "Windows didn't start the Remote helper (PowerShell).");
    }
    return h;
  }
  function close() {
    clearTimeout(idle);
    if (helper) helper.close();
    helper = null;
    helperInfo = null;
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  }

  // the display of a Mac is woken, and kept on while Remote is being looked at
  function keepDisplayOn() {
    if (platform !== "darwin" || Date.now() - awakeAt < 20000) return;
    awakeAt = Date.now();
    try {
      const c = spawn("caffeinate", ["-u", "-d", "-t", "30"], { stdio: "ignore" });
      c.on("error", () => {});
      c.unref?.();
    } catch {}
  }

  async function frame({ width = 1280, quality = 60 } = {}) {
    width = Math.max(320, Math.min(2560, Math.round(width) || 1280));
    quality = Math.max(20, Math.min(90, Math.round(quality) || 60));
    let jpeg;
    if (fake) jpeg = readFileSync(fake[1].split(",")[0]);
    else if (platform === "darwin") {
      keepDisplayOn();
      mkdirSync(tmp, { recursive: true });
      const shot = join(tmp, `shot-${Date.now()}-${++shots}.jpg`);
      const small = shot.replace(/\.jpg$/, "-s.jpg");
      try {
        try {
          await run(spawn, "screencapture", ["-x", "-m", "-C", "-t", "jpg", shot], { env });
        } catch (e) {
          throw new ScreenError("no_display", /could not create image|no displays?/i.test(e.message) ? "This Mac's screen is off. With the lid closed, Remote needs another display connected; or open the lid." : `macOS didn't take a picture of the screen (${e.message}).`);
        }
        await run(spawn, "sips", ["-s", "format", "jpeg", "-s", "formatOptions", String(quality), "-Z", String(width), shot, "--out", small], { env });
        jpeg = readFileSync(small);
      } finally {
        for (const f of [shot, small]) {
          try {
            unlinkSync(f);
          } catch {}
        }
      }
    } else if (platform === "win32") {
      const h = await getHelper();
      const r = await h.ask({ t: "frame", w: width, q: quality });
      if (r.error) throw new ScreenError("capture", `Windows didn't take a picture of the screen (${String(r.error).slice(0, 200)}). A locked screen or an administrator prompt can't be shown.`);
      jpeg = Buffer.from(String(r.jpeg || ""), "base64");
    } else {
      if (!env.DISPLAY) throw new ScreenError("unsupported", env.WAYLAND_DISPLAY ? "Remote works with X11 on Linux, and this desktop uses Wayland." : "There's no desktop to show on this computer (no DISPLAY).");
      try {
        jpeg = await run(spawn, "import", ["-silent", "-window", "root", "-resize", `${width}x>`, "-quality", String(quality), "jpg:-"], { env });
      } catch (e) {
        if (e.code !== "ENOENT") throw new ScreenError("capture", `The picture of the screen failed (${e.message}).`);
        try {
          jpeg = await run(spawn, "ffmpeg", ["-loglevel", "error", "-f", "x11grab", "-i", env.DISPLAY, "-frames:v", "1", "-vf", `scale='min(${width},iw)':-2`, "-q:v", String(Math.round(2 + ((100 - quality) / 100) * 20)), "-f", "mjpeg", "-"], { env });
        } catch (e2) {
          throw new ScreenError("missing", e2.code === "ENOENT" ? "Remote needs ImageMagick (or ffmpeg) on this computer to show the screen." : `The picture of the screen failed (${e2.message}).`);
        }
      }
    }
    const size = jpegSize(jpeg);
    if (!size) throw new ScreenError("capture", "The picture of the screen came out unreadable.");
    return { jpeg, ...size };
  }

  async function input(events) {
    const evs = cleanEvents(events);
    if (!evs.length) return;
    if (fake) {
      appendFileSync(join(dir, "screen-input.jsonl"), evs.map(e => JSON.stringify(e)).join("\n") + "\n");
      return;
    }
    if (platform === "darwin" || platform === "win32") {
      const h = await getHelper();
      const r = await h.ask({ t: "input", events: platform === "win32" ? evs.map(e => (e.t === "text" || e.t === "key" ? winKeys(e) : e)) : evs });
      if (r.error) {
        const msg = String(r.error);
        if (platform === "darwin" && /not allowed|assistive|1002|1743|-25211|accessibility/i.test(msg)) throw new ScreenError("control_denied", "This Mac doesn't let node control it yet. On the Mac: System Settings → Privacy & Security → Accessibility, and turn on node.");
        throw new ScreenError("input", `That didn't reach the computer (${msg.slice(0, 200)}).`);
      }
      return;
    }
    // Linux: one xdotool for the lot
    if (!env.DISPLAY) throw new ScreenError("unsupported", "There's no desktop to control on this computer.");
    try {
      if (!xSize) {
        const [w, h] = String(await run(spawn, "xdotool", ["getdisplaygeometry"], { env })).trim().split(/\s+/).map(Number);
        xSize = { w, h };
      }
    } catch (e) {
      throw new ScreenError("missing", e.code === "ENOENT" ? "Remote can show this screen, but needs xdotool on this computer to use its mouse and keyboard." : `xdotool failed (${e.message}).`);
    }
    const args = [];
    const at = e => ["mousemove", String(Math.round(e.x * (xSize.w - 1))), String(Math.round(e.y * (xSize.h - 1)))];
    const BTN = { 0: "1", 1: "2", 2: "3" };
    for (const e of evs) {
      if (e.t === "move") args.push(...at(e));
      else if (e.t === "down") args.push(...at(e), "mousedown", BTN[e.b]);
      else if (e.t === "up") args.push(...at(e), "mouseup", BTN[e.b]);
      else if (e.t === "scroll") {
        args.push(...at(e));
        if (e.dy) args.push("click", "--repeat", String(Math.abs(e.dy)), e.dy > 0 ? "5" : "4");
        if (e.dx) args.push("click", "--repeat", String(Math.abs(e.dx)), e.dx > 0 ? "7" : "6");
      } else if (e.t === "text") args.push("type", "--delay", "4", "--", e.s);
      else if (e.t === "key") args.push("key", "--", [...e.mods.map(m => X_MODS[m]), X_KEYS[e.k] || e.k].join("+"));
    }
    try {
      // typed text is read as UTF-8 whatever this computer's language settings say
      await run(spawn, "xdotool", args, { env: { ...env, LC_ALL: "C.UTF-8" } });
    } catch (e) {
      throw new ScreenError("input", `xdotool failed (${e.message}).`);
    }
  }

  // ---- Live: pictures one after another for as long as Remote is open, the newest each time it's asked (`next()`), until
  // `stop()`. Where the screen can be streamed it is: ScreenCaptureKit through the Mac helper (built here once), or ffmpeg
  // grabbing the screen (Linux, or a Mac that has it). Anything that doesn't start, or stops, gives way to taking one picture
  // at a time, the next already being taken while the last is on its way.
  const macHelperBin = join(dir, `screen-mac-${createHash("sha256").update(MAC_STREAM).digest("hex").slice(0, 12)}`);
  // Builds the Mac helper with Apple's command line tools, if they're there (never asking to install them), once; meanwhile
  // pictures are taken the slower way. A failed build isn't tried again for this version of it.
  function buildMacHelper() {
    if (platform !== "darwin" || fake || building || existsSync(macHelperBin) || existsSync(macHelperBin + ".failed")) return building;
    building = (async () => {
      try {
        await run(spawn, "xcode-select", ["-p"], { env, timeout: 5000 });
      } catch {
        return false;
      }
      const src = macHelperBin + ".swift";
      try {
        writeFileSync(src, MAC_STREAM);
        // ScreenCaptureKit is macOS 12.3 and later; on an older Mac the helper doesn't start and the slower way is used
        const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos12.3`;
        await run(spawn, "xcrun", ["swiftc", "-O", "-target", target, "-o", macHelperBin + ".tmp", src], { env, timeout: 300000 });
        renameSync(macHelperBin + ".tmp", macHelperBin);
        log("Remote: built the helper that streams this Mac's screen.");
        return true;
      } catch (e) {
        try {
          writeFileSync(macHelperBin + ".failed", String((e && e.message) || e).slice(0, 2000));
        } catch {}
        log("Remote: couldn't build the screen streaming helper, so pictures are taken one at a time:", String((e && e.message) || e).slice(0, 300));
        return false;
      } finally {
        try {
          unlinkSync(src);
        } catch {}
      }
    })();
    return building;
  }

  function stream({ width = 1600, quality = 60, fps = 30 } = {}) {
    width = Math.max(320, Math.min(2560, Math.round(width) || 1600));
    quality = Math.max(20, Math.min(90, Math.round(quality) || 60));
    const qv = String(Math.round(2 + ((100 - quality) / 100) * 20));
    const pull = () => pullSource(() => frame({ width, quality }).then(f => f.jpeg));
    if (fake) {
      // the stand-in: its pictures in turn, a few dozen a second
      const files = fake[1].split(",");
      let i = 0;
      return { first: Promise.resolve(true), next: () => new Promise(r => setTimeout(() => r(readFileSync(files[i++ % files.length])), 15)), stop() {} };
    }
    const tries = [];
    if (platform === "darwin") {
      buildMacHelper();
      if (existsSync(macHelperBin)) tries.push(() => pushSource(spawn, macHelperBin, [String(width), String(quality / 100), String(fps)], { env, split: splitSized, name: "The screen helper" }));
      tries.push(() => pushSource(spawn, "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-capture_cursor", "1", "-framerate", String(fps), "-i", "Capture screen 0", "-vf", `scale='min(${width},iw)':-2`, "-q:v", qv, "-f", "mjpeg", "-"], { env, split: splitJpegs, name: "ffmpeg" }));
    } else if (platform !== "win32" && env.DISPLAY) {
      tries.push(() => pushSource(spawn, "ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "x11grab", "-draw_mouse", "1", "-framerate", String(fps), "-i", env.DISPLAY, "-vf", `scale='min(${width},iw)':-2`, "-q:v", qv, "-f", "mjpeg", "-"], { env, split: splitJpegs, name: "ffmpeg" }));
    }
    let src = null;
    let stopped = false;
    // the first way that gives a picture within a few seconds, else one at a time
    const picking = (async () => {
      for (const make of tries) {
        const s = make();
        let t;
        const ok = await Promise.race([s.first.then(() => true, () => false), new Promise(r => (t = setTimeout(() => r(false), 6000)))]);
        clearTimeout(t);
        if (ok && !stopped) return s;
        s.stop();
      }
      return Object.assign(pull(), { pulling: true });
    })();
    return {
      async next() {
        if (stopped) throw new ScreenError("stopped", "Stopped.");
        if (!src) src = await picking;
        keepDisplayOn();
        try {
          return await src.next();
        } catch (e) {
          // a stream that stopped: one at a time from here on
          if (stopped || e instanceof ScreenError || src.pulling) throw e;
          src.stop();
          src = Object.assign(pull(), { pulling: true });
          return src.next();
        }
      },
      stop() {
        stopped = true;
        picking.then(s => s.stop(), () => {});
        if (src) src.stop();
      }
    };
  }

  // Whether a window on this computer has `tag` (the page's invisible mark) in its title: the site open here, showing Remote.
  // Null when it can't be told.
  async function showing(tag) {
    if (!/^[\u200b\u200c\u200d\u2060]{6,32}$/.test(String(tag || ""))) return false;
    if (fake) {
      try {
        return readFileSync(join(dir, "screen-windows.txt"), "utf8").includes(tag);
      } catch {
        return false;
      }
    }
    if (platform === "darwin" || platform === "win32") {
      const r = await (await getHelper()).ask({ t: "windows", tag }, 10000);
      return typeof r.found === "boolean" ? r.found : null;
    }
    if (!env.DISPLAY) return null;
    try {
      return String(await run(spawn, "xdotool", ["search", "--name", tag], { env: { ...env, LC_ALL: "C.UTF-8" } })).trim().length > 0;
    } catch (e) {
      return e.code === "EXIT" ? false : null;
    }
  }

  // Turning Remote on: a Mac asks, on its own screen, to allow Screen Recording and Accessibility, and starts building its
  // streaming helper. Gives back what's allowed.
  async function ask() {
    if (fake || platform !== "darwin") return { view: true, control: true };
    buildMacHelper();
    const h = await getHelper();
    const r = await h.ask({ t: "ask" }, 30000);
    return { view: r.view !== false, control: r.control !== false };
  }

  return { frame, stream, input, ask, showing, close, buildMacHelper, get platform() { return fake ? "fake" : platform; } };
}
