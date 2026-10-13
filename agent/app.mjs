// The Claude app, for people without a paid Claude plan. Claude Code needs one, so instead of running Claude Code this types
// each message into the Claude desktop app on this computer, picks the model, presses send, and reads the reply as it's
// written, the way a person at the keyboard would, through the operating system's accessibility features (app-os.mjs): the
// same way screen readers and automation tools work, with your permission. While it's using the app, a bar on the screen says
// so, with a Stop button that takes the app back at once.
//
// This file is what happens, step by step, whatever does the clicking. The driver that does it is app-os.mjs on macOS and
// Windows; app-cdp.mjs is a stand-in the tests use, against a stand-in for the app.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

export { PAGE_LIB } from "./app-cdp.mjs";
const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const MAC_APP_ID = "com.anthropic.claudefordesktop";
const sleep = ms => new Promise(r => setTimeout(r, ms));
// How long a window in the app waits for an answer from the site, the same as Claude Code's questions (permit.mjs).
const REMOTE_WAIT_MS = Number(process.env.CLAUDECONNECT_PERMIT_WAIT_MS) || 10 * 60000;

// "Opus 5.5" -> "claude-opus-5-5": the same ids the site uses for Claude Code's models.
export function modelId(name) {
  const slug = String(name || "").toLowerCase().replace(/^claude\s+/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
  return slug ? "claude-" + slug : "";
}

// What changed between two readings of a reply that's being written: the new end, or the whole text when it changed earlier
// on (a list or a table can change shape as it fills in).
export function textChange(before, after) {
  if (after === before) return null;
  if (after.startsWith(before)) return { type: "delta", text: after.slice(before.length) };
  return { type: "replace", text: after };
}

// The plan percentages from claude.ai's own usage reading, in the shape Claude Code's are reported in.
export function limitsFromUsage(u) {
  if (!u || typeof u !== "object") return null;
  const windows = {};
  for (const key of ["five_hour", "seven_day"]) {
    const w = u[key];
    if (!w || typeof w !== "object") continue;
    const pct = Number(w.utilization);
    const at = Date.parse(w.resets_at);
    if (Number.isFinite(pct) && Number.isFinite(at)) windows[key] = { pct, resetsAt: Math.round(at / 1000) };
  }
  if (!Object.keys(windows).length) return null;
  const full = Object.entries(windows).filter(([, w]) => w.pct >= 100).sort((a, b) => b[1].resetsAt - a[1].resetsAt)[0];
  const out = { windows, status: full ? "rejected" : "allowed" };
  if (full) Object.assign(out, { rateLimitType: full[0], resetsAt: full[1].resetsAt, overageStatus: "rejected", overageDisabledReason: "overage_not_provisioned" });
  return out;
}

// Limit resets, as Claude reports them for a reset program (cedar_ember and the like), with how often a grant comes back when
// Claude says. Shared with Claude Code's reading in agent.mjs.
// When the app's limit notice says messages come back ("You're out of free messages until 4:00 PM", "…until tomorrow at 9 AM",
// "…until Tuesday 4:00 PM"), as seconds since 1970 in this computer's time zone. Null when it doesn't say.
const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
export function resetFromNotice(text, now = new Date()) {
  const t = String(text || "").toLowerCase();
  const m = /(?:until|at|resets?(?: at)?)\s+(?:(today|tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\s+(?:at\s+)?)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/.exec(t);
  if (!m) return null;
  let h = Number(m[2]);
  const min = Number(m[3] || 0);
  if (h > 23 || min > 59 || (m[4] && (h < 1 || h > 12))) return null;
  if (m[4] === "pm" && h < 12) h += 12;
  if (m[4] === "am" && h === 12) h = 0;
  const d = new Date(now.getTime());
  d.setHours(h, min, 0, 0);
  const day = m[1];
  if (day === "tomorrow") d.setDate(d.getDate() + 1);
  else if (day && day !== "today") {
    const want = DAYS.indexOf(day);
    let add = (want - d.getDay() + 7) % 7;
    if (add === 0 && d <= now) add = 7;
    d.setDate(d.getDate() + add);
  } else if (d <= now) d.setDate(d.getDate() + 1);
  return Math.round(d.getTime() / 1000);
}

export function resetsFrom(u) {
  const out = [];
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = v => (typeof v === "string" ? v : "");
  for (const program of ["cedar_ember", "juniper_tide"]) {
    const r = u && u[program];
    if (!r || typeof r !== "object" || !Array.isArray(r.grants)) continue;
    out.push({
      program,
      eligible: r.eligible === true,
      atLimit: r.at_limit === true,
      cooldownUntil: str(r.cooldown_until),
      grants: r.grants.filter(g => g && typeof g.id === "string").map(g => ({
        id: g.id,
        label: str(g.label),
        left: num(g.resets_left),
        total: num(g.resets_total),
        usableNow: g.usable_now === true,
        needsLimit: g.use_requires_limit === true,
        paused: g.paused === true,
        endsAt: str(g.ends_at),
        clears: Array.isArray(g.clears) ? g.clears.filter(c => typeof c === "string") : [],
        every: refillEvery(g),
        nextAt: str(g.next_grant_at || g.refreshes_at || g.renews_at || g.next_refill_at || g.refills_at)
      }))
    });
  }
  return out;
}

// "day", "week" or "month": how often a reset grant fills up again, from whatever Claude calls it, or "".
export function refillEvery(g) {
  const said = [g.period, g.cadence, g.interval, g.refresh_period, g.refill_period, g.refresh_interval, g.frequency].find(v => typeof v === "string" && v);
  const days = [g.period_days, g.interval_days, g.refill_interval_days, g.refresh_interval_days].find(v => typeof v === "number" && v > 0);
  const hint = String(said || "") + " " + String(g.label || "");
  if (/\bdai|\bday|\b24 ?h/i.test(hint) || days === 1) return "day";
  if (/week|7 ?d/i.test(hint) || days === 7) return "week";
  if (/month/i.test(hint) || (days >= 28 && days <= 31)) return "month";
  return "";
}

const byVersion = (a, b) => {
  const x = String(a).match(/\d+/g) || [];
  const y = String(b).match(/\d+/g) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (Number(x[i] || 0) !== Number(y[i] || 0)) return Number(y[i] || 0) - Number(x[i] || 0);
  return 0;
};

// Where the Claude desktop app is, and how it's started: the app bundle on macOS; on Windows the Microsoft Store (MSIX)
// package, started by its app id because its folder can't be opened, or an install in your user folder. Looked up at most
// once a minute. There's no Claude app to drive on Linux. A test can say where with CLAUDECONNECT_CLAUDE_APP.
let lastFind = null;
export function findClaudeApp(env = process.env, home = os.homedir(), platform = process.platform) {
  if (env.CLAUDECONNECT_CLAUDE_APP !== undefined) {
    const p = env.CLAUDECONNECT_CLAUDE_APP;
    return { path: p && existsSync(p) ? p : "", how: p && existsSync(p) ? "stand-in" : "" };
  }
  if (lastFind && lastFind.platform === platform && lastFind.home === home && Date.now() - lastFind.at < 60000) return lastFind.v;
  let v = { path: "", how: "" };
  if (platform === "darwin") {
    let p = ["/Applications/Claude.app", join(home, "Applications", "Claude.app")].find(x => existsSync(x));
    if (!p) {
      const r = spawnSync("mdfind", [`kMDItemCFBundleIdentifier == "${MAC_APP_ID}"`], { encoding: "utf8", timeout: 5000 });
      p = String(r.stdout || "").split("\n").map(s => s.trim()).find(s => /\.app$/.test(s) && existsSync(s));
    }
    if (p) v = { path: p, how: "mac", bundle: MAC_APP_ID };
  } else if (platform === "win32") {
    const ps = "$p = Get-AppxPackage -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Claude' -or $_.PackageFamilyName -like 'Claude_*' } | Select-Object -First 1; if ($p) { $id = 'Claude'; try { $a = @((Get-AppxPackageManifest $p).Package.Applications.Application)[0]; if ($a.Id) { $id = $a.Id } } catch {}; [pscustomobject]@{ pfn = $p.PackageFamilyName; dir = $p.InstallLocation; id = $id } | ConvertTo-Json -Compress }";
    const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true, timeout: 20000 });
    try {
      const j = JSON.parse(String(r.stdout || "").trim());
      if (j && j.pfn) v = { path: j.dir || "", how: "msix", aumid: `${j.pfn}!${j.id || "Claude"}`, exe: j.dir ? join(j.dir, "app", "Claude.exe") : "" };
    } catch {}
    if (!v.how) {
      const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
      const squirrel = join(local, "AnthropicClaude");
      const list = [];
      try {
        for (const d of readdirSync(squirrel).filter(n => /^app-\d/.test(n)).sort(byVersion)) list.push(join(squirrel, d, "claude.exe"));
      } catch {}
      list.push(join(squirrel, "claude.exe"), join(local, "Programs", "Claude", "Claude.exe"), join(env.ProgramFiles || "C:\\Program Files", "Claude", "Claude.exe"));
      const p = list.find(x => existsSync(x));
      if (p) v = { path: p, how: "exe" };
    }
  }
  lastFind = { at: Date.now(), platform, home, v };
  return v;
}
// Just the path (or "" when there's none), as older callers want it.
export function claudeAppPath(env = process.env, home = os.homedir()) {
  return findClaudeApp(env, home).path;
}
// Whether the free plan can work on this computer at all.
export const APP_SUPPORTED = IS_MAC || IS_WIN || ["cdp", "os"].includes(process.env.CLAUDECONNECT_APP_DRIVER);

// ------------------------------------------------------------------------------------------------------- what drives the app
async function loadDriver(o) {
  if (process.env.CLAUDECONNECT_APP_DRIVER === "cdp") {
    const { cdpDriver } = await import("./app-cdp.mjs");
    return cdpDriver({ ...o, appPath: findClaudeApp().path });
  }
  if (IS_MAC || IS_WIN || process.env.CLAUDECONNECT_APP_DRIVER === "os") {
    const { osDriver } = await import("./app-os.mjs");
    return osDriver({ ...o, find: findClaudeApp });
  }
  return null;
}

// --------------------------------------------------------------------------------------------------------------- one message
export function createApp({ dir, cfg, saveConfig, log, WS = globalThis.WebSocket, driver = null }) {
  // the site's name, as it is now: a rename on the site changes cfg.displayName
  const siteName = () => cfg.displayName || "ClaudeConnect";
  const S = { busy: null, models: null, modelsAt: 0, thinking: null, current: "", status: "", remote: null, paused: cfg.appPaused === true, partial: "", connected: false };
  const CHATS = join(dir, "app-chats.json");
  let chats = {};
  try {
    chats = JSON.parse(readFileSync(CHATS, "utf8")) || {};
  } catch {}
  const saveChats = () => {
    try {
      const keep = Object.entries(chats).sort((a, b) => (b[1].at || 0) - (a[1].at || 0)).slice(0, 5000);
      writeFileSync(CHATS, JSON.stringify(Object.fromEntries(keep)));
    } catch {}
  };
  let D = driver;
  let loading = null;
  async function drv() {
    if (D) return D;
    loading = loading || loadDriver({ cfg, saveConfig, log, WS, NAME: siteName() });
    D = await loading;
    if (!D) throw Object.assign(new Error(`The free plan works through the desktop app, which runs on macOS and Windows. On this computer, ${siteName()} needs a paid plan (Pro, Max, Team or Enterprise).`), { code: "app_unsupported" });
    return D;
  }

  // ---- the Stop bar, and letting go
  class Escaped extends Error {}
  const PAUSED = () => `You took back the desktop app on your computer, so ${siteName()} stopped using it. It won't touch the app again until you let it, here on the site.`;
  // Shows the bar on the screen (or changes what it says), and lets go of the app if Stop has been pressed on it.
  async function hold(text) {
    const o = await D.bar(true, text, `Stop ${siteName()}`).catch(() => null);
    if (o && o.stop) throw new Escaped(PAUSED());
  }
  async function letGo() {
    if (D) await D.bar(false).catch(() => {});
  }
  // Stop was pressed: nothing more is clicked or typed, and it stays that way until it's allowed again on the site.
  function pause() {
    S.paused = true;
    cfg.appPaused = true;
    saveConfig();
    log("Stopped using the desktop app: Stop was pressed. Messages wait until it's allowed again on the site.");
    if (D) D.close();
  }
  function resume() {
    S.paused = false;
    cfg.appPaused = false;
    saveConfig();
    log("Allowed to use the desktop app again.");
  }

  // ---- models and extended thinking, from the app's own menu
  async function readModels() {
    const r = await D.models().catch(() => null);
    if (!r) return S.models;
    const models = (r.models || []).map(x => ({ id: modelId(x.name), name: x.name, desc: x.desc || "", locked: !!x.locked })).filter(x => x.id);
    if (models.length) {
      S.models = models.slice(0, 12);
      S.modelsAt = Date.now();
    }
    if (typeof r.thinking === "boolean") S.thinking = r.thinking;
    if (r.current) S.current = r.current;
    return S.models;
  }
  async function setModel(id, say) {
    const list = S.models || (await readModels()) || [];
    const want = list.find(x => x.id === id);
    if (!want || want.locked) return null;
    const now = await D.current().catch(() => "");
    if (now && now.toLowerCase().includes(want.name.toLowerCase())) return want;
    say(`Switching to ${want.name}`);
    if (!(await D.setModel(want.name).catch(() => false))) return null;
    S.current = want.name;
    return want;
  }
  async function setThinking(on, say) {
    if (S.thinking === on) return true;
    say(on ? "Turning on extended thinking" : "Turning off extended thinking");
    const ok = await D.setThinking(on).catch(() => false);
    if (ok) S.thinking = on;
    return ok;
  }

  // ---- a window in the app that waits for an answer, shown on the site
  async function watchRemote(emit) {
    let d = null;
    try {
      d = await D.dialog();
    } catch {}
    const key = d ? `${d.title}|${d.text}|${(d.buttons || []).map(b => b.label).join(",")}` : "";
    if (!d) {
      if (S.remote) {
        emit({ type: "remote_done", id: S.remote.id });
        S.remote = null;
      }
      return;
    }
    if (S.remote && S.remote.key === key) return;
    const id = S.remote ? S.remote.id : "s" + Date.now().toString(36);
    S.remote = { id, key, d, since: S.remote ? S.remote.since : Date.now() };
    const shot = await D.shot(d).catch(() => ({ image: "", w: 0, h: 0, buttons: (d.buttons || []).map(b => ({ label: b.label, x: 0, y: 0, w: 0, h: 0 })) }));
    emit({ type: "remote", id, kind: "screen", title: d.title || "The desktop app is asking", text: d.text || "", ...shot });
  }
  // An answer from the site: one of its buttons, or a click on the picture of the window.
  async function remoteAnswer(m) {
    const r = S.remote;
    if (!r || r.id !== m.id || !D) return false;
    if (!(await D.answer(r.d, m).catch(() => false))) return false;
    S.remote = { ...r, key: "", since: Date.now() }; // send a fresh look at it, or say it's gone
    return true;
  }

  // ---- one message, start to finish
  async function runOne(m, emit, stopped) {
    const say = text => {
      S.status = text;
      emit({ type: "status", text });
    };
    await drv();
    await D.start(say);
    S.connected = true;
    // the conversation this chat has in the app, if it has one (a chat whose first message didn't get through has none yet)
    const known = (chats[m.sessionId] && chats[m.sessionId].conv) || "";
    const p = await D.open(known);
    if (!p) throw new Error("The desktop app's page didn't load. Check that it's open and online on your computer, then send again.");
    if (p.challenge) throw Object.assign(new Error("The desktop app is asking you to confirm you're human. Do that in the app on your computer, then send again."), { code: "app_challenge" });
    if (p.login || !p.composer) throw Object.assign(new Error("Sign in to the desktop app on your computer, then send again."), { code: "app_signin" });
    const sending = `${siteName()} is using the desktop app to send your message`;
    await hold(sending);
    const mi = m.model && m.model !== "app-default" ? await setModel(m.model, say).catch(() => null) : null;
    await hold(sending);
    if (typeof m.thinking === "boolean") await setThinking(m.thinking, say);
    await hold(sending);
    if (stopped()) return { text: "", stopped: true };
    let prompt = String(m.prompt || "");
    // a chat that began somewhere else (Claude Code, before a switch to the free plan), or whose conversation in the app
    // couldn't be opened: its earlier messages go first
    if ((!known || p.conv !== known) && m.context) prompt = `(Earlier in this conversation:)\n\n${m.context}\n\n---\n\n${prompt}`;
    if (m.files && m.files.length) {
      say(m.files.length === 1 ? "Attaching the file" : `Attaching ${m.files.length} files`);
      if (!(await D.attach(m.files.map(f => f.path)).catch(() => false))) prompt += m.inline || "";
      await sleep(600);
    }
    await hold(sending);
    say("Typing your message");
    if (!(await D.type(prompt || "Take a look at the attached files."))) throw new Error(`Couldn't type into the desktop app's message box. It may have changed: check that ${siteName()} is up to date.`);
    await hold(sending);
    const before = ((await D.probe()) || {}).users || 0;
    const sent = await D.send(before);
    if (sent.limit) throw Object.assign(new Error(sent.limit), { code: "limit", resetsAt: resetFromNotice(sent.limit) });
    if (!sent.ok) throw new Error("The desktop app didn't send the message. Check it on your computer, then try again.");
    say("Thinking");
    await hold(`${siteName()} is reading the reply in the desktop app`);
    const t0 = Date.now();
    let text = "";
    let lastChange = Date.now();
    let started = false;
    let conv = "";
    let stopAsked = false;
    let unanswered = false;
    let tick = 0;
    for (;;) {
      await sleep(D.pace || 150);
      tick++;
      // a window in the app that nobody answers doesn't hold it forever: it's closed (which says no), and the reply stopped
      const waited = S.remote && !stopAsked && Date.now() - S.remote.since > REMOTE_WAIT_MS;
      if (waited) {
        unanswered = true;
        await D.escape().catch(() => {});
      }
      if ((stopped() || waited) && !stopAsked) {
        stopAsked = true;
        await D.stop().catch(() => {});
      }
      const pr = (await D.probe()) || {};
      if (pr.stop) throw new Escaped(PAUSED());
      if (pr.conv && pr.conv !== conv) {
        conv = pr.conv;
        chats[m.sessionId] = { conv, at: Date.now() };
        saveChats();
      }
      const r = await D.reply();
      const streaming = !!(pr.streaming || (r && r.streaming));
      if (r && (r.md || streaming)) started = true;
      if (r) {
        const ch = textChange(text, r.md);
        if (ch) {
          text = r.md;
          S.partial = text;
          lastChange = Date.now();
          emit(ch);
        }
      }
      if (tick % (D.remoteEvery || 4) === 0) {
        await hold(`${siteName()} is reading the reply in the desktop app`);
        await watchRemote(emit);
      }
      const quiet = Date.now() - lastChange;
      // done: the app says so (or has stopped showing it's busy), and the text has settled. A window still open once the
      // reply has finished (something the app wants to tell you, say) doesn't hold it up.
      if (started && !streaming && quiet > (r && r.marked ? 900 : 2500) && (text || quiet > 8000) && (!S.remote || quiet > 4000)) break;
      if (stopAsked && !streaming && quiet > 800) break;
      if (!started && pr.limit && Date.now() - t0 > 8000) throw Object.assign(new Error(pr.limit), { code: "limit", resetsAt: resetFromNotice(pr.limit) });
      if (!started && Date.now() - t0 > 120000 && !S.remote) throw new Error(`${siteName()} didn't start answering in the desktop app. Check the app on your computer.`);
      if (quiet > 10 * 60000 && !S.remote) throw new Error("The reply in the desktop app stopped moving.");
    }
    if (S.remote) {
      emit({ type: "remote_done", id: S.remote.id });
      S.remote = null;
    }
    // the exact text the app keeps (with what the page only shows as a card), when it can be read
    let thinking = "";
    if (!stopAsked) {
      const exact = await D.exact(conv).catch(() => null);
      // only the reply just written: about as long, and starting with the same words
      const gist = v => String(v).replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 24).toLowerCase();
      if (exact && exact.text && exact.text.length >= text.length * 0.5 && (!text || gist(exact.text) === gist(text))) {
        text = exact.text;
        thinking = exact.thinking || "";
      }
    }
    const label = await D.current().catch(() => "");
    const name = (mi && mi.name) || label || S.current || "";
    if (label) S.current = label;
    if (unanswered) return { text, thinking, started, error: "Nobody answered the desktop app's question in time, so it was closed and the reply stopped. Send again to carry on.", modelName: name.slice(0, 40), model: modelId(name) };
    return { text, thinking, started, stopped: stopAsked, modelName: name.slice(0, 40), model: modelId(name) };
  }

  // One thing at a time: there's one app window. A message, or a look at the model menu.
  let queue = Promise.resolve();
  function enqueue(fn) {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  }
  function run(m, emit, stopped) {
    const waiting = S.busy && S.busy !== "models";
    const p = enqueue(async () => {
      S.busy = m.runId;
      try {
        if (stopped()) return { text: "", stopped: true };
        // Stop was pressed: the app is left alone until it's allowed again
        if (S.paused) return { text: "", error: PAUSED(), code: "app_paused" };
        S.partial = "";
        return await runOne(m, emit, stopped);
      } catch (e) {
        if (e instanceof Escaped) {
          await letGo();
          pause();
          return { text: S.partial || "", error: e.message, code: "app_paused" };
        }
        return { text: S.partial || "", error: String((e && e.message) || e), code: (e && e.code) || "", resetsAt: (e && e.resetsAt) || null };
      } finally {
        if (!S.paused) await letGo();
        S.busy = null;
        S.status = "";
      }
    });
    if (waiting) emit({ type: "status", text: "Waiting for another reply in the desktop app to finish" });
    return p;
  }

  // The app's model menu, read by opening it (which shows in the app, Stop bar and all): when someone asks for it on the site
  // (force), or when what was read is over 10 minutes old. Never while it's been told to stop, never in a reply's middle, and
  // only when the app is already open: a look at the models doesn't start the app.
  function models(force) {
    return enqueue(async () => {
      if (S.paused) return S.models;
      if (!force && S.models && Date.now() - S.modelsAt < 10 * 60000) return S.models;
      await drv();
      if (!(await D.running().catch(() => false))) return S.models;
      S.busy = "models";
      try {
        await D.start(() => {});
        const p = await D.open(null).catch(() => null);
        if (!p || !p.composer) return S.models;
        await hold(`${siteName()} is checking the models in the desktop app`);
        return await readModels();
      } catch (e) {
        if (!(e instanceof Escaped)) throw e;
        await letGo();
        pause();
        return S.models;
      } finally {
        if (!S.paused) await letGo();
        S.busy = null;
      }
    });
  }

  // claude.ai's own usage reading, when the driver can get it (the stand-in can; the real app's isn't reachable from outside it)
  async function usage() {
    if (S.paused) return null;
    await drv().catch(() => null);
    if (!D || !D.usage) return null;
    const r = await D.usage().catch(() => null);
    if (!r) return null;
    if (r.error) return { error: r.error };
    return { limits: limitsFromUsage(r.usage), resets: resetsFrom(r.usage) };
  }
  async function useReset(program, grant, requestId) {
    if (!D || !D.useReset) return { error: "closed" };
    return D.useReset({ program, grant_id: grant, request_id: requestId });
  }

  function info() {
    const f = findClaudeApp();
    return {
      kind: S.connected && D && D.connected() ? "app" : "",
      found: f.how ? "app" : "",
      models: (S.models || []).slice(0, 12),
      thinking: S.thinking,
      model: S.current,
      paused: S.paused,
      supported: APP_SUPPORTED
    };
  }
  // what the computer can do for the free plan right now, for setup and the site: installed, allowed (macOS Accessibility)
  async function check(prompt) {
    await drv().catch(() => null);
    if (!D) return { ok: false, code: "app_unsupported" };
    return D.check ? D.check(prompt) : { ok: !!findClaudeApp().how, code: findClaudeApp().how ? "" : "app_missing" };
  }
  function close() {
    if (D) D.close();
  }

  return { run, remoteAnswer, usage, useReset, readModels: models, resume, check, info, find: () => ({ app: findClaudeApp().path }), close, state: S };
}
