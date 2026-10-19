// Remote's Windows helper (in agent/screen.mjs), run for real in PowerShell, with only Windows' own screen, mouse and keyboard
// calls swapped for recorders that have the same signatures: the script's parsing, its C#, its message handling and its
// conversions are all checked, on any computer with PowerShell 7 (GitHub's Linux runners have it). Skipped without it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { makeScreen } from "../../agent/screen.mjs";

const PWSH = process.env.CLAUDECONNECT_PWSH || "pwsh";
const HAVE = spawnSync(PWSH, ["-NoProfile", "-Command", "1"], { encoding: "utf8" }).status === 0;
const JPG = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "screen.jpg")).toString("base64");
const SOURCE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "..", "agent", "screen.mjs"), "utf8");

// the recorders: the same parameter types as the real calls, so PowerShell converts the arguments as it would on Windows
const STUB = `class CCStub {
  static [bool] SetCursorPos([int]$x, [int]$y) { [Console]::Error.WriteLine("move $x $y"); return $true }
  static [void] mouse_event([uint32]$f, [int]$dx, [int]$dy, [int]$data, [UIntPtr]$extra) { [Console]::Error.WriteLine("mouse $f $data") }
  static [void] keybd_event([byte]$vk, [byte]$scan, [uint32]$f, [UIntPtr]$extra) { [Console]::Error.WriteLine("kbd $vk $f") }
  static [void] SendWait([string]$s) { [Console]::Error.WriteLine("keys $s") }
  static [bool] Showing([string]$t) { return $t.Length -eq 12 }
}`;
function windowsSpawn(lines) {
  return (cmd, args, opts) => {
    assert.equal(cmd, "powershell.exe");
    const file = args[args.indexOf("-File") + 1];
    let s = readFileSync(file, "utf8");
    for (const [a, b] of [
      [/Add-Type -AssemblyName System\.Windows\.Forms\r?\n/, ""],
      [/Add-Type -AssemblyName System\.Drawing\r?\n/, ""],
      [/\[CCScreen\]::SetProcessDPIAware\(\) \| Out-Null/, STUB],
      [/\$codec = .*\r?\n/, "$codec = $null\n"],
      [/\[System\.Windows\.Forms\.Screen\]::PrimaryScreen\.Bounds/g, "[pscustomobject]@{ Left = 0; Top = 0; Width = 1920; Height = 1080 }"],
      [/(\s*)\$shot = New-Object[\s\S]*?\$g\.Dispose\(\); \$g2\.Dispose\(\); \$shot\.Dispose\(\); \$small\.Dispose\(\)\r?\n/, `$1$ms = New-Object System.IO.MemoryStream (,[Convert]::FromBase64String("${JPG}"))\n`],
      [/\[CCScreen\]::/g, "[CCStub]::"],
      [/\[System\.Windows\.Forms\.SendKeys\]::SendWait/g, "[CCStub]::SendWait"]
    ]) {
      assert.match(s, a, "the helper changed: update this test's swaps");
      s = s.replace(a, b);
    }
    writeFileSync(file, s);
    const c = spawn(PWSH, ["-NoProfile", "-NonInteractive", "-File", file], opts);
    c.stderr.on("data", d => lines.push(...String(d).trim().split(/\r?\n/)));
    return c;
  };
}

test("the Windows helper's script parses and its C# compiles", { skip: !HAVE && "needs PowerShell" }, () => {
  const a = SOURCE.indexOf("const WIN_HELPER = String.raw`") + "const WIN_HELPER = String.raw`".length;
  const dir = mkdtempSync(join(os.tmpdir(), "cc-ps-"));
  try {
    writeFileSync(join(dir, "helper.ps1"), SOURCE.slice(a, SOURCE.indexOf("\n`;", a)));
    const r = spawnSync(PWSH, ["-NoProfile", "-NonInteractive", "-Command", `$t = $null; $e = $null
[void][System.Management.Automation.Language.Parser]::ParseFile("${join(dir, "helper.ps1")}", [ref]$t, [ref]$e)
if ($e.Count) { $e | ForEach-Object { "error: $($_.Extent.StartLineNumber): $($_.Message)" }; exit 1 }
$src = Get-Content -Raw "${join(dir, "helper.ps1")}"
Add-Type -TypeDefinition ([regex]::Match($src, '(?s)@"\r?\n(.*?)\r?\n"@').Groups[1].Value)
([CCScreen].GetMethods() | Where-Object { $_.IsStatic -and $_.DeclaringType.Name -eq "CCScreen" } | ForEach-Object Name | Sort-Object) -join ","`], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.trim(), "EnumWindows,GetWindowText,IsWindowVisible,keybd_event,mouse_event,SetCursorPos,SetProcessDPIAware,Showing");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("the Windows helper answers pictures, does mouse, wheel and keys with the right numbers, and finds the page's mark", { skip: !HAVE && "needs PowerShell" }, async () => {
  const lines = [];
  const s = makeScreen({ platform: "win32", env: process.env, spawn: windowsSpawn(lines) });
  try {
    const f = await s.frame({ width: 800, quality: 50 });
    assert.deepEqual([f.w, f.h], [640, 400]);
    await s.input([
      { t: "move", x: 0.5, y: 0.5 },
      { t: "down", x: 0.25, y: 0.75, b: 0, n: 1 },
      { t: "up", x: 0.25, y: 0.75, b: 0, n: 1 },
      { t: "down", x: 1, y: 1, b: 2, n: 1 },
      { t: "up", x: 1, y: 1, b: 2, n: 1 },
      { t: "scroll", x: 0.5, y: 0.5, dy: 2, dx: -1 },
      { t: "text", s: "héllo (1+1)\n" },
      { t: "key", k: "c", mods: ["ctrl"] },
      { t: "key", k: "r", mods: ["meta"] },
      { t: "key", k: "Tab", mods: ["alt"] }
    ]);
    await new Promise(r => setTimeout(r, 200));
    assert.deepEqual(lines, ["move 960 540", "move 480 809", "mouse 2 0", "move 480 809", "mouse 4 0", "move 1919 1079", "mouse 8 0", "move 1919 1079", "mouse 16 0", "move 960 540", "mouse 2048 -240", "mouse 4096 -120", "keys héllo {(}1{+}1{)}{ENTER}", "keys ^c", "kbd 91 0", "keys r", "kbd 91 2", "keys %{TAB}"]);
    // the page's invisible mark reaches the window-title check whole
    assert.equal(await s.showing("​‌‍⁠".repeat(3)), true);
    assert.equal(await s.showing("not a mark"), false);
  } finally {
    s.close();
  }
});
