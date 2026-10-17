// Keeping this computer awake with the lid closed, so the site keeps answering. A computer that's turned off can't answer:
// Claude Code runs on it.
//
// macOS: closing the lid always puts a Mac to sleep unless sleep is turned off for the whole system (`pmset disablesleep`).
// Only an administrator can do that, so the Mac asks for your password in its own dialog, once to turn it on and once to turn
// it off, and it stays that way after a restart. Windows: the power plan's "when I close the lid" becomes "do nothing" (what
// it was is kept, to go back to), and while the program runs it tells Windows the system is in use, so it doesn't sleep when
// idle either. Linux: while the program runs it holds systemd's sleep, idle and lid-switch locks.
import { spawn as nodeSpawn } from "node:child_process";

// a command's exit code and what it printed, without blocking (a password dialog can take minutes)
function run(cmd, args, { timeout = 15000 } = {}) {
  return new Promise(resolve => {
    let out = "";
    let err = "";
    let child;
    try {
      child = nodeSpawn(cmd, args, { windowsHide: true });
    } catch (e) {
      return resolve({ code: -1, out, err: String(e.message || e) });
    }
    const timer = setTimeout(() => child.kill(), timeout);
    child.stdout.on("data", d => (out += d));
    child.stderr.on("data", d => (err += d));
    child.on("error", e => (err += String(e.message || e)));
    child.on("close", code => {
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, out, err });
    });
  });
}

const LID_QUERY = ["/query", "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION"];

// macOS: whether sleep is off for the whole system, from `pmset -g`
export function macSleepDisabled(out) {
  const m = /SleepDisabled\s+(\d)/.exec(String(out));
  return !!m && m[1] === "1";
}

// Windows: what closing the lid does, plugged in and on battery (0 is "do nothing"): the last two "0x…" numbers that
// `powercfg /query … LIDACTION` prints, whatever the language of its labels
export function winLidAction(out) {
  const v = [...String(out).matchAll(/0x([0-9a-f]{8})/gi)].map(m => parseInt(m[1], 16));
  return v.length >= 2 ? { ac: v[v.length - 2], dc: v[v.length - 1] } : null;
}

// Whether it's on now. `cfg` is the program's own settings, where Windows and Linux keep it.
export async function awakeOn({ platform = process.platform, cfg = {}, exec = run } = {}) {
  if (platform === "darwin") return macSleepDisabled((await exec("pmset", ["-g"])).out);
  if (platform === "win32") {
    const lid = winLidAction((await exec("powercfg", LID_QUERY)).out);
    return !!cfg.awake && !!lid && lid.ac === 0 && lid.dc === 0;
  }
  return !!cfg.awake;
}

// Turns it on or off, changing `cfg` (save it after). Gives back "" or what went wrong, in words for a person.
export async function setAwake(on, { platform = process.platform, cfg = {}, exec = run, name = "ClaudeConnect" } = {}) {
  if (platform === "darwin") {
    const why = on ? "keep this Mac awake with the lid closed" : "let this Mac sleep again when its lid is closed";
    const script = `do shell script "/usr/bin/pmset -a disablesleep ${on ? 1 : 0}" with administrator privileges with prompt ${JSON.stringify(`${name} needs your password to ${why}.`)}`;
    const r = await exec("osascript", ["-e", script], { timeout: 180000 });
    if (r.code !== 0) return /-128|cancel/i.test(r.err) ? "The Mac's password wasn't given, so nothing changed." : `The Mac didn't allow it (${(r.err || "no answer").trim().slice(0, 120)}).`;
    if (macSleepDisabled((await exec("pmset", ["-g"])).out) !== on) return "The Mac didn't take the change.";
    cfg.awake = on;
    return "";
  }
  if (platform === "win32") {
    const now = winLidAction((await exec("powercfg", LID_QUERY)).out);
    if (!now) return "Windows didn't say what closing the lid does, so nothing changed.";
    if (on && !(now.ac === 0 && now.dc === 0)) cfg.lidBefore = now;
    const to = on ? { ac: 0, dc: 0 } : cfg.lidBefore || { ac: 1, dc: 1 };
    for (const [set, v] of [["/setacvalueindex", to.ac], ["/setdcvalueindex", to.dc]]) {
      const r = await exec("powercfg", [set, "SCHEME_CURRENT", "SUB_BUTTONS", "LIDACTION", String(v)]);
      if (r.code !== 0) return `Windows didn't let the lid setting change (${(r.err || r.out).trim().slice(0, 120)}).`;
    }
    await exec("powercfg", ["/setactive", "SCHEME_CURRENT"]);
    if (!on) delete cfg.lidBefore;
  }
  cfg.awake = on;
  return "";
}

// While the program runs, and only then: Windows is told the system is in use, Linux holds systemd's locks. The helper looks
// every minute for the program, so it never outlives it. A Mac needs nothing here. Gives back a way to let go, or null.
export function holdAwake({ platform = process.platform, pid = process.pid, name = "ClaudeConnect", spawn = nodeSpawn } = {}) {
  let child = null;
  try {
    if (platform === "win32") {
      // ES_CONTINUOUS | ES_SYSTEM_REQUIRED
      const ps = `Add-Type -Name P -Namespace W -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint f);'; [W.P]::SetThreadExecutionState([uint32]2147483649) | Out-Null; while (Get-Process -Id ${pid} -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 60 }`;
      child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { stdio: "ignore", windowsHide: true });
    } else if (platform !== "darwin") {
      child = spawn("systemd-inhibit", ["--what=sleep:idle:handle-lid-switch", `--who=${name}`, "--why=Answering on your site", "--mode=block", "sh", "-c", `while kill -0 ${pid} 2>/dev/null; do sleep 60; done`], { stdio: "ignore" });
    }
  } catch {
    return null;
  }
  if (!child) return null;
  child.on("error", () => {});
  if (child.unref) child.unref();
  return {
    child,
    release() {
      try {
        child.kill();
      } catch {}
    }
  };
}
