// The Claude app, for people without a paid Claude plan. Claude Code needs one, so instead of running Claude Code this types
// each message into the Claude desktop app on this computer, picks the model, presses send, and reads the reply as it's
// written, the way a person at the keyboard would.
//
// It doesn't move the mouse or read pixels off the screen. The app is Chromium inside (it's an Electron app), so it's started
// with a debugging connection (the Chrome DevTools Protocol) that only programs on this computer can reach. Through it, this finds
// the message box, the send button and the reply by what they are on the page (test ids, labels, roles, text), the way a
// browser's own inspector does. So it works at any window size, behind other windows, and through most changes to the app's
// look. If the app won't open that connection (or isn't installed), a separate Chrome, Edge or Brave window signed in to
// claude.ai is used the same way, with its own profile so the browser you use isn't touched.
//
// The page code runs in an isolated world: the page can't see it, and nothing of the page's can interfere with it. It never
// calls Runtime.enable (the usual tell of an automated browser), and clicks are real input events.
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import os from "node:os";

// claude.ai, or a stand-in for it in the tests
export const APP_BASE = (process.env.CLAUDECONNECT_APP_URL || "https://claude.ai").replace(/\/+$/, "");
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

// ---------------------------------------------------------------------------------------------------------------- the page
// Everything below runs inside the page, in its own isolated world, and only hands back plain data.
function pageLib() {
  const VERSION = 1;
  const SEL = {
    composer: ['[data-testid="chat-input"] [contenteditable="true"]', '[data-testid="chat-input"][contenteditable="true"]', 'div.ProseMirror[contenteditable="true"]', 'fieldset [contenteditable="true"]', '[contenteditable="true"][role="textbox"]', 'div[contenteditable="true"]'],
    send: ['button[data-testid="send-button"]', 'button[aria-label="Send message" i]', 'button[aria-label="Send" i]', 'button[aria-label^="Send" i]:not([aria-label*="feedback" i])', 'button[type="submit"]'],
    stop: ['button[data-testid="stop-button"]', 'button[aria-label="Stop response" i]', 'button[aria-label^="Stop" i]'],
    reply: ['[data-testid="assistant-message"]', ".font-claude-response", ".font-claude-message", "[data-is-streaming]"],
    user: ['[data-testid="user-message"]', ".font-user-message"],
    model: ['[data-testid="model-selector-dropdown"]', 'button[aria-label*="model" i]', 'button[data-testid*="model" i]'],
    menu: ['[role="menu"]', '[role="listbox"]', "[data-radix-menu-content]"],
    item: '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"], [role="option"]',
    dialog: ['[role="alertdialog"]', '[role="dialog"]'],
    login: ['input[type="email"]', 'a[href*="/login"]', 'button[data-testid*="login" i]']
  };
  const MODEL_WORD = /\b(opus|sonnet|haiku|fable|claude)\b/i;
  const LIMIT_TEXT = /out of (free )?messages|message limit|usage limit|reached (?:the|your) (?:usage |message )?limit|limit (?:will )?reset|you(?:'ve| have) hit|upgrade to (?:keep|continue)/i;
  const ALLOW_DENY = /^(allow|always allow|allow once|allow for this chat|allow always|approve|deny|don't allow|do not allow|decline|block)$/i;

  const shown = el => {
    if (!el || !el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const all = (sel, root) => {
    try {
      return [...(root || document).querySelectorAll(sel)];
    } catch {
      return [];
    }
  };
  // the last visible match of the first selector that matches anything visible
  const pick = (sels, root) => {
    for (const s of sels) {
      const hit = all(s, root).filter(shown);
      if (hit.length) return hit[hit.length - 1];
    }
    return null;
  };
  const words = el => String((el && (el.innerText || el.textContent)) || "").replace(/\s+/g, " ").trim();
  const box = el => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  };
  const disabled = el => !!el && (el.disabled || el.getAttribute("aria-disabled") === "true");

  function composer() {
    return pick(SEL.composer);
  }
  // the part of the page around the message box: its form, fieldset, or a few levels up
  function composerArea() {
    const c = composer();
    if (!c) return null;
    let el = c.closest("fieldset, form, [data-testid='chat-input']") || c.parentElement;
    for (let i = 0; i < 3 && el && el.parentElement && el.getBoundingClientRect().height < 80; i++) el = el.parentElement;
    return el;
  }
  function nearComposer(sels) {
    const area = composerArea();
    let hit = area ? pick(sels, area.closest("fieldset, form") || area) : null;
    if (!hit && area) hit = pick(sels, area.parentElement || area);
    return hit || pick(sels);
  }
  function sendButton() {
    return nearComposer(SEL.send);
  }
  function stopButton() {
    return pick(SEL.stop);
  }

  // innermost matches only, in the order they're on the page
  function innermost(sels) {
    const found = new Set();
    for (const s of sels) for (const el of all(s)) found.add(el);
    const list = [...found].filter(el => ![...found].some(o => o !== el && el.contains(o)));
    return list.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
  }
  function lastUser() {
    const u = innermost(SEL.user);
    return u.length ? u[u.length - 1] : null;
  }
  // the newest reply, if it comes after the newest message from the person
  function lastReply() {
    const r = innermost(SEL.reply);
    const el = r.length ? r[r.length - 1] : null;
    const u = lastUser();
    if (!el || (u && !(u.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING))) return null;
    return el;
  }

  // ---- the reply as Markdown, from what the page shows
  const SKIP = new Set(["BUTTON", "svg", "SVG", "STYLE", "SCRIPT", "NOSCRIPT", "TEMPLATE", "INPUT", "SELECT", "TEXTAREA", "IFRAME", "CANVAS"]);
  const BLOCK = new Set(["P", "DIV", "SECTION", "ARTICLE", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "PRE", "BLOCKQUOTE", "TABLE", "HR", "FIGURE", "DETAILS", "HEADER", "FOOTER", "MAIN", "ASIDE", "NAV", "DL", "DT", "DD"]);
  const skipped = el => SKIP.has(el.tagName) || el.getAttribute("aria-hidden") === "true" || el.getAttribute("role") === "button" || el.getAttribute("role") === "toolbar" || el.getClientRects().length === 0;
  function inline(node) {
    if (node.nodeType === 3) return node.nodeValue.replace(/\s+/g, " ");
    if (node.nodeType !== 1 || skipped(node)) return "";
    const kids = () => [...node.childNodes].map(inline).join("");
    const wrap = (mark, s) => (s.trim() ? `${mark}${s.trim()}${mark}` : s);
    switch (node.tagName) {
      case "BR":
        return "\n";
      case "STRONG":
      case "B":
        return wrap("**", kids());
      case "EM":
      case "I":
        return wrap("*", kids());
      case "DEL":
      case "S":
        return wrap("~~", kids());
      case "CODE": {
        const t = node.textContent;
        return t.includes("`") ? "`` " + t + " ``" : "`" + t + "`";
      }
      case "A": {
        const t = kids().trim();
        const h = node.getAttribute("href") || "";
        return /^(https?:|mailto:)/i.test(h) ? `[${t || h}](${h})` : t;
      }
      case "IMG": {
        const s = node.getAttribute("src") || "";
        return /^https?:/i.test(s) ? `![${node.getAttribute("alt") || ""}](${s})` : node.getAttribute("alt") || "";
      }
      default: {
        if (node.classList && node.classList.contains("katex")) {
          const tex = node.querySelector('annotation[encoding="application/x-tex"]');
          return tex ? `$${tex.textContent}$` : kids();
        }
        if (BLOCK.has(node.tagName)) return " " + kids() + " ";
        return kids();
      }
    }
  }
  const flat = el => [...el.childNodes].map(inline).join("").replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
  const isBlock = el => BLOCK.has(el.tagName) || /^(block|flex|grid|list-item|table)$/.test(getComputedStyle(el).display);
  function langOf(pre) {
    const c = pre.querySelector("code[class*='language-']") || (/language-/.test(pre.className) ? pre : null);
    const m = c && String(c.className).match(/language-([\w+#.-]+)/);
    return m ? m[1] : "";
  }
  function blocks(node) {
    const out = [];
    let buf = "";
    const flush = () => {
      const t = buf.replace(/[ \t]*\n[ \t]*/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      if (t) out.push(t);
      buf = "";
    };
    for (const c of node.childNodes) {
      if (c.nodeType === 1 && skipped(c)) continue;
      if (c.nodeType === 1 && isBlock(c)) {
        flush();
        const b = block(c);
        if (b) out.push(b);
      } else buf += inline(c);
    }
    flush();
    // a code block's language label, shown above it, is already on the fence
    return out.filter((b, i) => !(i + 1 < out.length && /^[\w+#.-]{1,24}$/.test(b) && out[i + 1].toLowerCase().startsWith("```" + b.toLowerCase())));
  }
  function list(el, ordered) {
    let n = Number(el.getAttribute("start")) || 1;
    const items = [];
    for (const li of el.children) {
      if (li.tagName !== "LI" || skipped(li)) continue;
      const marker = ordered ? `${n++}.` : "-";
      const pad = " ".repeat(marker.length + 1);
      const parts = blocks(li);
      const body = parts.reduce((acc, p) => (acc ? acc + (/^(\d+\.|-) /.test(p) ? "\n" : "\n\n") + p : p), "");
      items.push(body.split("\n").map((l, i) => (i === 0 ? `${marker} ${l}` : l ? pad + l : l)).join("\n"));
    }
    return items.join("\n");
  }
  function table(t) {
    const rows = [...t.querySelectorAll("tr")].map(tr => [...tr.children].map(td => flat(td).replace(/\n/g, " ").replace(/\|/g, "\\|")));
    if (!rows.length) return "";
    const w = Math.max(...rows.map(r => r.length));
    const pad = r => [...r, ...Array(w - r.length).fill("")];
    return [`| ${pad(rows[0]).join(" | ")} |`, `|${Array(w).fill(" --- ").join("|")}|`, ...rows.slice(1).map(r => `| ${pad(r).join(" | ")} |`)].join("\n");
  }
  function block(el) {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) return "#".repeat(Number(tag[1])) + " " + flat(el);
    if (tag === "P" || tag === "DT" || tag === "DD") return flat(el);
    if (tag === "PRE") {
      const code = el.querySelector("code") || el;
      return "```" + langOf(el) + "\n" + code.textContent.replace(/\n$/, "") + "\n```";
    }
    if (tag === "UL" || tag === "OL") return list(el, tag === "OL");
    if (tag === "BLOCKQUOTE") return blocks(el).join("\n\n").split("\n").map(l => (l ? "> " + l : ">")).join("\n");
    if (tag === "HR") return "---";
    if (tag === "TABLE") return table(el);
    return blocks(el).join("\n\n");
  }
  function markdown(el) {
    return blocks(el).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---- what's on the page now
  function probe() {
    const c = composer();
    const r = lastReply();
    const wrap = r && (r.closest("[data-is-streaming]") || r.querySelector("[data-is-streaming]"));
    const conv = (location.pathname.match(/\/chat\/([0-9a-f-]{36})/i) || [])[1] || "";
    const login = !c && (/\/(login|signup|logout)/.test(location.pathname) || !!pick(SEL.login));
    return {
      v: VERSION,
      url: location.href,
      path: location.pathname,
      conv,
      composer: !!c,
      login,
      users: innermost(SEL.user).length,
      streaming: !!(wrap && wrap.getAttribute("data-is-streaming") === "true") || !!stopButton(),
      limit: limitNotice(),
      visible: document.visibilityState === "visible",
      size: innerWidth * innerHeight
    };
  }
  // The app saying you're out of messages, near the message box. Never the conversation itself, where anyone can write those words.
  function limitNotice() {
    const area = composerArea();
    const c = composer();
    const talk = [...SEL.user, ...SEL.reply].join(",");
    const scope = [];
    for (let el = area, i = 0; el && i < 4; el = el.parentElement, i++) scope.push(el);
    for (const el of [...all('[role="alert"]'), ...scope]) {
      if (!shown(el)) continue;
      for (const x of all("p, span, div", el)) {
        if ((x.children.length && x.tagName !== "P") || !shown(x) || x.closest(talk) || (c && c.contains(x))) continue;
        const t = words(x);
        if (t.length < 400 && LIMIT_TEXT.test(t)) return t;
      }
    }
    return "";
  }
  function composerText() {
    const c = composer();
    return c ? String(c.innerText || c.textContent || "") : null;
  }
  function focusComposer(clear) {
    const c = composer();
    if (!c) return null;
    c.scrollIntoView({ block: "nearest" });
    c.focus();
    const sel = getSelection();
    const range = document.createRange();
    range.selectNodeContents(c);
    if (!clear) range.collapse(false);
    sel.removeAllRanges();
    sel.addRange(range);
    if (clear && words(c)) document.execCommand("delete");
    return box(c);
  }
  // the way a person pasting with the keyboard would put it in, for when typed input doesn't take
  function insertText(text) {
    if (!focusComposer(false)) return null;
    document.execCommand("insertText", false, text);
    return composerText();
  }
  function button(which) {
    const el = which === "send" ? sendButton() : which === "stop" ? stopButton() : which === "model" ? modelButton() : null;
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    return { ...box(el), disabled: disabled(el), label: words(el) || el.getAttribute("aria-label") || "" };
  }
  function reply() {
    const el = lastReply();
    if (!el) return null;
    const wrap = el.closest("[data-is-streaming]") || el.querySelector("[data-is-streaming]");
    return { md: markdown(el), streaming: !!(wrap && wrap.getAttribute("data-is-streaming") === "true") || !!stopButton(), marked: !!wrap };
  }

  // ---- the model menu, and switches in it (extended thinking)
  function modelButton() {
    const near = nearComposer(SEL.model);
    if (near && MODEL_WORD.test(words(near) + " " + (near.getAttribute("aria-label") || ""))) return near;
    const area = composerArea();
    const scope = area ? area.closest("fieldset, form") || area.parentElement || area : document;
    return all("button", scope).filter(shown).find(b => MODEL_WORD.test(words(b)) && /\d/.test(words(b)) && words(b).length < 40) || near || null;
  }
  function menu() {
    const m = pick(SEL.menu);
    if (!m) return null;
    const items = all(SEL.item, m).filter(shown).map((el, i) => {
      el.setAttribute("data-cc-item", String(i));
      const lines = String(el.innerText || "").split("\n").map(s => s.trim()).filter(Boolean);
      const sw = el.querySelector('[role="switch"], input[type="checkbox"]');
      const checked = el.getAttribute("aria-checked") === "true" || (sw && (sw.getAttribute("aria-checked") === "true" || sw.checked === true)) || el.getAttribute("data-state") === "checked";
      return { i, name: lines[0] || "", desc: lines.slice(1).join(" ").slice(0, 160), ...box(el), checked: !!checked, locked: disabled(el) || /\bupgrade\b|\bpro plan\b|\bmax plan\b/i.test(lines.slice(1).join(" ")), toggle: !!sw || el.getAttribute("role") === "menuitemcheckbox", sub: el.getAttribute("aria-haspopup") === "menu" || el.hasAttribute("data-has-submenu") };
    });
    return { ...box(m), items };
  }
  function item(i) {
    const el = document.querySelector(`[data-cc-item="${Number(i)}"]`);
    if (!el) return null;
    el.scrollIntoView({ block: "nearest" });
    return box(el);
  }
  // a switch next to the message box, like an "Extended thinking" button
  function toggle(re) {
    const r = new RegExp(re, "i");
    const area = composerArea();
    const scope = area ? area.closest("fieldset, form") || area.parentElement || area : document;
    const el = all("button[aria-pressed], [role='switch'], button[aria-checked]", scope).filter(shown).find(b => r.test((b.getAttribute("aria-label") || "") + " " + words(b)));
    if (!el) return null;
    return { ...box(el), on: el.getAttribute("aria-pressed") === "true" || el.getAttribute("aria-checked") === "true" };
  }
  // a button next to the message box that opens a menu of tools, where the extended thinking switch can be
  function toolsButton() {
    const area = composerArea();
    const scope = area ? area.closest("fieldset, form") || area.parentElement || area : document;
    const el = all("button[aria-haspopup], button[data-testid*='tool' i], button[aria-label*='tool' i]", scope).filter(shown).find(b => /tool|search|option|settings/i.test((b.getAttribute("aria-label") || "") + " " + (b.getAttribute("data-testid") || "")) && !MODEL_WORD.test(words(b)));
    return el ? box(el) : null;
  }

  // ---- a window on the page that's waiting for an answer: a dialog, or allow / deny buttons in the conversation
  function dialog() {
    let el = pick(SEL.dialog);
    if (el && el.closest(SEL.menu.join(","))) el = null;
    if (!el) {
      const buttons = all("button", document).filter(b => shown(b) && ALLOW_DENY.test(words(b)));
      if (buttons.length >= 2) {
        el = buttons[0].parentElement;
        while (el && !buttons.every(b => el.contains(b))) el = el.parentElement;
        // the card around them, not the whole page
        for (let i = 0; i < 3 && el && el.parentElement && el.getBoundingClientRect().height < 90; i++) el = el.parentElement;
      }
    }
    if (!el || !shown(el)) return null;
    const r = box(el);
    if (r.w < 40 || r.h < 30) return null;
    const heading = el.querySelector("h1, h2, h3, [id$='title' i], [class*='title' i]");
    const btns = all("button, [role='button'], a[href]", el).filter(shown).map(b => ({ label: (words(b) || b.getAttribute("aria-label") || "").slice(0, 60), ...box(b) })).filter(b => b.label).slice(0, 12);
    return { ...r, sx: scrollX, sy: scrollY, title: words(heading || el.querySelector("p") || el).slice(0, 160), text: words(el).slice(0, 600), buttons: btns };
  }

  // ---- claude.ai's own readings, with the sign-in this page already has
  async function org() {
    const c = document.cookie.match(/(?:^|;\s*)lastActiveOrg=([0-9a-f-]{36})/i);
    if (c) return c[1];
    const r = await fetch("/api/organizations", { credentials: "include", headers: { accept: "application/json" } });
    const j = r.ok ? await r.json() : null;
    return Array.isArray(j) && j[0] && typeof j[0].uuid === "string" ? j[0].uuid : "";
  }
  async function usage() {
    const o = await org();
    if (!o) return { error: "signin" };
    const r = await fetch(`/api/organizations/${o}/usage`, { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) return { error: `http_${r.status}` };
    return { usage: await r.json() };
  }
  async function useReset(body) {
    const o = await org();
    if (!o) return { error: "signin" };
    const r = await fetch(`/api/organizations/${o}/reset_rate_limits`, { method: "POST", credentials: "include", headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => null);
    return r.ok && j ? { result: j } : { error: `http_${r.status}` };
  }
  // the conversation as claude.ai keeps it, for the exact text of the reply once it's done
  async function conversation(id) {
    const o = await org();
    if (!o || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    const r = await fetch(`/api/organizations/${o}/chat_conversations/${id}?tree=True&rendering_mode=messages&render_all_tools=true`, { credentials: "include", headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    const msgs = Array.isArray(j && j.chat_messages) ? j.chat_messages : [];
    const last = [...msgs].reverse().find(m => m && m.sender === "assistant");
    if (!last) return null;
    const blocks = Array.isArray(last.content) ? last.content : [];
    let text = blocks.filter(b => b && b.type === "text" && typeof b.text === "string").map(b => b.text).join("\n\n");
    for (const b of blocks) {
      const a = b && b.type === "tool_use" && b.input && typeof b.input === "object" ? b.input : null;
      if (a && typeof a.content === "string" && a.content) text += `${text ? "\n\n" : ""}**${a.title || "Artifact"}**\n\n\`\`\`${String(a.language || "").replace(/[^\w+#.-]/g, "")}\n${a.content}\n\`\`\``;
    }
    if (!text && typeof last.text === "string") text = last.text;
    const thinking = blocks.filter(b => b && b.type === "thinking" && typeof b.thinking === "string").map(b => b.thinking).join("\n\n");
    return { text, thinking, model: typeof j.model === "string" ? j.model : "" };
  }

  return { VERSION, probe, composerText, focusComposer, insertText, button, reply, menu, item, toggle, toolsButton, dialog, usage, useReset, conversation, markdown };
}

export const PAGE_LIB = `var __cc = (${pageLib.toString()})();`;

// ------------------------------------------------------------------------------------------------- the debugging connection
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.waiting = new Map();
    this.closed = false;
    ws.onmessage = ev => {
      let m;
      try {
        m = JSON.parse(typeof ev.data === "string" ? ev.data : Buffer.from(ev.data).toString("utf8"));
      } catch {
        return;
      }
      const w = m.id && this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      clearTimeout(w.timer);
      if (m.error) w.reject(Object.assign(new Error(m.error.message || "CDP error"), { cdp: true }));
      else w.resolve(m.result || {});
    };
    const gone = () => {
      this.closed = true;
      for (const w of this.waiting.values()) {
        clearTimeout(w.timer);
        w.reject(Object.assign(new Error("The connection to the Claude app closed."), { gone: true }));
      }
      this.waiting.clear();
    };
    ws.onclose = gone;
    ws.onerror = gone;
  }
  static open(url, WS) {
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WS(url);
      } catch (e) {
        return reject(e);
      }
      const t = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        reject(new Error("timed out connecting"));
      }, 10000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve(new Cdp(ws));
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error("couldn't connect"));
      };
    });
  }
  send(method, params = {}, ms = 30000) {
    if (this.closed) return Promise.reject(Object.assign(new Error("The connection to the Claude app closed."), { gone: true }));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The Claude app didn't answer (${method}).`));
      }, ms);
      this.waiting.set(id, { resolve, reject, timer });
      try {
        this.ws.send(JSON.stringify({ id, method, params }));
      } catch (e) {
        clearTimeout(timer);
        this.waiting.delete(id);
        reject(e);
      }
    });
  }
  close() {
    this.closed = true;
    try {
      this.ws.close();
    } catch {}
  }
}

async function getJson(url, ms = 2500, method = "GET") {
  try {
    const r = await fetch(url, { method, signal: AbortSignal.timeout(ms) });
    return r.ok ? await r.json() : null;
  } catch {
    return null;
  }
}

function which(names) {
  for (const n of names) {
    const r = spawnSync(IS_WIN ? "where" : "which", [n], { encoding: "utf8", windowsHide: true });
    const p = String(r.stdout || "").split(/\r?\n/).map(s => s.trim()).find(Boolean);
    if (r.status === 0 && p && existsSync(p)) return p;
  }
  return "";
}

const byVersion = (a, b) => {
  const x = String(a).match(/\d+/g) || [];
  const y = String(b).match(/\d+/g) || [];
  for (let i = 0; i < Math.max(x.length, y.length); i++) if (Number(x[i] || 0) !== Number(y[i] || 0)) return Number(y[i] || 0) - Number(x[i] || 0);
  return 0;
};

// Where the Claude desktop app is. On Windows the newest app-<version> folder comes first, so the arguments reach the app
// itself rather than its launcher.
export function claudeAppPath(env = process.env, home = os.homedir()) {
  if (env.CLAUDECONNECT_CLAUDE_APP !== undefined) return env.CLAUDECONNECT_CLAUDE_APP && existsSync(env.CLAUDECONNECT_CLAUDE_APP) ? env.CLAUDECONNECT_CLAUDE_APP : "";
  const list = [];
  if (IS_MAC) list.push("/Applications/Claude.app/Contents/MacOS/Claude", join(home, "Applications", "Claude.app", "Contents", "MacOS", "Claude"));
  else if (IS_WIN) {
    const local = env.LOCALAPPDATA || join(home, "AppData", "Local");
    const squirrel = join(local, "AnthropicClaude");
    try {
      for (const v of readdirSync(squirrel).filter(n => /^app-\d/.test(n)).sort(byVersion)) list.push(join(squirrel, v, "claude.exe"));
    } catch {}
    list.push(join(squirrel, "claude.exe"), join(local, "Programs", "Claude", "Claude.exe"), join(env.ProgramFiles || "C:\\Program Files", "Claude", "Claude.exe"));
  } else list.push("/usr/bin/claude-desktop", "/opt/Claude/claude-desktop", "/usr/lib/claude-desktop/claude-desktop");
  return list.find(p => existsSync(p)) || "";
}

// A Chromium browser to fall back on: Chrome, Edge, Brave, Chromium or Vivaldi.
export function browserPath(env = process.env, home = os.homedir()) {
  if (env.CLAUDECONNECT_BROWSER !== undefined) return env.CLAUDECONNECT_BROWSER && existsSync(env.CLAUDECONNECT_BROWSER) ? env.CLAUDECONNECT_BROWSER : "";
  const list = [];
  if (IS_MAC) {
    for (const base of ["/Applications", join(home, "Applications")]) {
      for (const [app, bin] of [["Google Chrome", "Google Chrome"], ["Microsoft Edge", "Microsoft Edge"], ["Brave Browser", "Brave Browser"], ["Chromium", "Chromium"], ["Vivaldi", "Vivaldi"]]) list.push(join(base, `${app}.app`, "Contents", "MacOS", bin));
    }
  } else if (IS_WIN) {
    const pf = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA].filter(Boolean);
    for (const base of pf) list.push(join(base, "Google", "Chrome", "Application", "chrome.exe"), join(base, "Microsoft", "Edge", "Application", "msedge.exe"), join(base, "BraveSoftware", "Brave-Browser", "Application", "brave.exe"), join(base, "Chromium", "Application", "chrome.exe"), join(base, "Vivaldi", "Application", "vivaldi.exe"));
  } else {
    const p = which(["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser", "vivaldi", "vivaldi-stable"]);
    if (p) list.push(p);
  }
  return list.find(p => existsSync(p)) || "";
}

// --------------------------------------------------------------------------------------------------------------- the driver
export function createApp({ dir, cfg, saveConfig, log, WS = globalThis.WebSocket }) {
  const S = { cdp: null, target: null, kind: "", ctx: 0, busy: null, appRefused: false, models: null, modelsAt: 0, thinking: null, current: "", status: "", remote: null };
  const CHATS = join(dir, "app-chats.json");
  const PROFILE = join(dir, "browser");
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
  if (!Number.isInteger(cfg.appPort) || cfg.appPort < 1024 || cfg.appPort > 65535) {
    cfg.appPort = 30000 + Math.floor(Math.random() * 9000);
    saveConfig();
  }
  // An app that wouldn't open the debugging connection isn't restarted for it again, until it's updated (or moved).
  const appSig = path => {
    try {
      return `${path}|${Math.round(statSync(path).mtimeMs)}`;
    } catch {
      return path;
    }
  };
  const sameSite = u => {
    try {
      return new URL(u).origin === new URL(APP_BASE).origin;
    } catch {
      return false;
    }
  };

  // What's installed, for the hello and for Settings.
  function find() {
    return { app: claudeAppPath(), browser: browserPath() };
  }

  async function endpoint(port) {
    const v = port ? await getJson(`http://127.0.0.1:${port}/json/version`) : null;
    return v ? port : 0;
  }
  function profilePort() {
    try {
      return Number(readFileSync(join(PROFILE, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]) || 0;
    } catch {
      return 0;
    }
  }
  function appDataPort() {
    const home = os.homedir();
    const where = IS_MAC ? join(home, "Library", "Application Support", "Claude") : IS_WIN ? join(process.env.APPDATA || join(home, "AppData", "Roaming"), "Claude") : join(home, ".config", "Claude");
    try {
      return Number(readFileSync(join(where, "DevToolsActivePort"), "utf8").split(/\r?\n/)[0]) || 0;
    } catch {
      return 0;
    }
  }

  async function targets(port) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    return Array.isArray(list) ? list.filter(t => t && t.webSocketDebuggerUrl && sameSite(t.url) && ["page", "webview"].includes(t.type)).sort((a, b) => (a.type === "page" ? 0 : 1) - (b.type === "page" ? 0 : 1)) : [];
  }

  // The app running without the connection (opened by hand): it's restarted with it, which is quick, and the conversation
  // you were in is kept by claude.ai. On Windows its processes are found by the folder it's installed in, so Claude Code (also
  // claude.exe) is never touched.
  const appFolder = path => (/\\app-[^\\]+\\[^\\]+$/i.test(path) ? path.replace(/\\app-[^\\]+\\[^\\]+$/i, "") : path.replace(/\\[^\\]+$/, ""));
  function appPids(path) {
    if (IS_MAC) {
      const r = spawnSync("pgrep", ["-x", basename(path)], { encoding: "utf8" });
      return String(r.stdout || "").split(/\s+/).map(Number).filter(Boolean);
    }
    if (IS_WIN) {
      const folder = appFolder(path);
      const ps = `Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${folder.replace(/'/g, "''")}', 'OrdinalIgnoreCase') } | ForEach-Object { $_.Id }`;
      const r = spawnSync("powershell", ["-NoProfile", "-Command", ps], { encoding: "utf8", windowsHide: true });
      return String(r.stdout || "").split(/\s+/).map(Number).filter(Boolean);
    }
    const r = spawnSync("pgrep", ["-f", path], { encoding: "utf8" });
    return String(r.stdout || "").split(/\s+/).map(Number).filter(n => n && n !== process.pid);
  }
  async function quitApp(path) {
    const pids = appPids(path);
    if (!pids.length) return;
    log("Restarting the Claude app so ClaudeConnect can type into it.");
    if (IS_WIN) {
      const folder = appFolder(path);
      const ps = `$p = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith('${folder.replace(/'/g, "''")}', 'OrdinalIgnoreCase') }; $p | ForEach-Object { [void]$_.CloseMainWindow() }; Start-Sleep -Seconds 3; $p | Where-Object { -not $_.HasExited } | Stop-Process -Force`;
      spawnSync("powershell", ["-NoProfile", "-Command", ps], { stdio: "ignore", windowsHide: true, timeout: 20000 });
    } else {
      for (const pid of pids) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {}
      }
    }
    for (let i = 0; i < 50 && appPids(path).length; i++) await sleep(200);
    if (!IS_WIN) for (const pid of appPids(path)) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {}
    }
    await sleep(500);
  }
  function launch(path, args) {
    const child = spawn(path, args, { detached: true, stdio: "ignore", windowsHide: false });
    child.on("error", e => log("Couldn't start", basename(path) + ":", e.message || e));
    child.unref();
  }

  async function waitFor(fn, ms, every = 250) {
    const end = Date.now() + ms;
    for (;;) {
      const v = await fn();
      if (v) return v;
      if (Date.now() > end) return null;
      await sleep(every);
    }
  }

  // Connected to a claude.ai page in the app (or the browser window), starting it if it has to.
  async function connect(say) {
    if (S.cdp && !S.cdp.closed && S.target) return S;
    S.cdp = null;
    S.ctx = 0;
    // something already open from before: the app, the browser window, or the app's own record of its port
    for (const [port, kind] of [[cfg.appPort, "app"], [profilePort(), "browser"], [appDataPort(), "app"]]) {
      if (port && (await endpoint(port))) {
        const t = (await waitFor(async () => (await targets(port))[0], kind === "browser" ? 1500 : 4000)) || (kind === "browser" ? await newTab(port) : null);
        if (t) return attach(t, port, kind);
      }
    }
    const { app, browser } = find();
    if (app && !S.appRefused && cfg.appRefused !== appSig(app)) {
      say("Opening the Claude app");
      await quitApp(app);
      launch(app, [`--remote-debugging-port=${cfg.appPort}`]);
      const port = await waitFor(() => endpoint(cfg.appPort), 30000, 400);
      if (port) {
        const t = await waitFor(async () => (await targets(port))[0], 45000, 500);
        if (t) return attach(t, port, "app");
        log("The Claude app opened, but not on claude.ai. Using a browser window instead.");
      } else log("The Claude app wouldn't open a debugging connection. Using a browser window instead.");
      S.appRefused = true;
      cfg.appRefused = appSig(app);
      saveConfig();
    }
    if (browser) {
      say("Opening Claude in a browser window");
      mkdirSync(PROFILE, { recursive: true });
      const extra = String(process.env.CLAUDECONNECT_BROWSER_ARGS || "").split(/\s+/).filter(Boolean);
      launch(browser, ["--remote-debugging-port=0", `--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows", ...extra, "--new-window", `${APP_BASE}/new`]);
      const port = await waitFor(async () => endpoint(profilePort()), 30000, 300);
      if (port) {
        const t = (await waitFor(async () => (await targets(port))[0], 15000, 300)) || (await newTab(port));
        if (t) return attach(t, port, "browser");
      }
      throw new Error("The browser window for Claude didn't open. Restart the program on your computer and try again.");
    }
    throw Object.assign(new Error("The Claude app isn't on this computer. Install it from claude.ai/download, sign in, and send again."), { code: "app_missing" });
  }
  async function newTab(port) {
    const t = (await getJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(APP_BASE + "/new")}`, 5000, "PUT")) || (await getJson(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(APP_BASE + "/new")}`, 5000));
    return t && t.webSocketDebuggerUrl ? t : null;
  }
  async function attach(t, port, kind) {
    S.cdp = await Cdp.open(t.webSocketDebuggerUrl, WS);
    S.target = t;
    S.kind = kind;
    S.port = port;
    S.ctx = 0;
    log(kind === "app" ? "Connected to the Claude app." : "Connected to Claude in a browser window.");
    // the page acts as if it has focus, so nothing waits for the window to come forward
    await S.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    return S;
  }

  // ---- running code in the page
  async function world() {
    if (S.ctx) return S.ctx;
    const { frameTree } = await S.cdp.send("Page.getFrameTree");
    const { executionContextId } = await S.cdp.send("Page.createIsolatedWorld", { frameId: frameTree.frame.id, worldName: "claudeconnect", grantUniveralAccess: false });
    const r = await S.cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: PAGE_LIB, returnByValue: true });
    if (r.exceptionDetails) throw new Error("The page code couldn't start: " + ((r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text));
    S.ctx = executionContextId;
    return S.ctx;
  }
  async function call(op, ...args) {
    for (let i = 0; ; i++) {
      try {
        const contextId = await world();
        const r = await S.cdp.send("Runtime.evaluate", { contextId, expression: `__cc.${op}(...${JSON.stringify(args)})`, awaitPromise: true, returnByValue: true }, 45000);
        if (r.exceptionDetails) {
          const msg = (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text || "error";
          if (/__cc is not defined/.test(msg) && i < 3) {
            S.ctx = 0;
            continue;
          }
          throw new Error(msg.split("\n")[0]);
        }
        return r.result ? r.result.value : undefined;
      } catch (e) {
        // the page moved on (a navigation, a reload): its world went with it
        if (e && e.cdp && /context|frame|target/i.test(e.message) && i < 3) {
          S.ctx = 0;
          await sleep(300);
          continue;
        }
        if (e && e.gone) {
          S.cdp = null;
          S.target = null;
        }
        throw e;
      }
    }
  }
  async function click(x, y) {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await S.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
  }
  const center = r => click(r.x + r.w / 2, r.y + r.h / 2);
  async function key(k, code, keyCode) {
    await S.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await S.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }
  const escape = () => key("Escape", "Escape", 27);
  // The page has loaded far enough to work with: the message box is there, or claude.ai is asking you to sign in. A window
  // that has only just opened is still loading, and claude.ai takes a moment to draw.
  async function ready(ms = 45000) {
    return waitFor(async () => {
      const p = await call("probe").catch(() => null);
      return p && (p.composer || p.login) ? p : null;
    }, ms, 300);
  }
  async function navigate(url) {
    S.ctx = 0;
    await S.cdp.send("Page.navigate", { url });
    await sleep(400);
    return ready();
  }
  async function front() {
    await S.cdp.send("Page.bringToFront").catch(() => {});
    // a minimized window doesn't draw; bring it back to normal size
    try {
      const b = await getJson(`http://127.0.0.1:${S.port}/json/version`);
      if (!b || !b.webSocketDebuggerUrl) return;
      const br = await Cdp.open(b.webSocketDebuggerUrl, WS);
      try {
        const w = await br.send("Browser.getWindowForTarget", { targetId: S.target.id }, 3000);
        if (w && w.bounds && w.bounds.windowState === "minimized") await br.send("Browser.setWindowBounds", { windowId: w.windowId, bounds: { windowState: "normal" } }, 3000);
      } finally {
        br.close();
      }
    } catch {}
  }

  // ---- models and extended thinking, from the app's own menu
  async function openModelMenu() {
    const b = await waitFor(() => call("button", "model").catch(() => null), 2500, 250);
    if (!b) return null;
    await center(b);
    return waitFor(() => call("menu"), 3000, 150);
  }
  async function readModels(force) {
    if (!force && S.models && Date.now() - S.modelsAt < 10 * 60000) return S.models;
    const m = await openModelMenu();
    if (!m) return S.models;
    const models = [];
    let thinking = null;
    for (const it of m.items) {
      if (/extended thinking|think/i.test(it.name) && it.toggle) thinking = it.checked;
      else if (/\b(opus|sonnet|haiku|fable|claude)\b/i.test(it.name) && /\d/.test(it.name) && models.length < 12) models.push({ id: modelId(it.name), name: it.name.slice(0, 40), desc: it.desc, locked: !!it.locked });
    }
    await escape();
    const b = await call("button", "model");
    S.current = b ? b.label : "";
    if (models.length) {
      S.models = models;
      S.modelsAt = Date.now();
    }
    if (thinking !== null) S.thinking = thinking;
    return S.models;
  }
  async function setModel(id, say) {
    const models = (await readModels()) || [];
    const want = models.find(x => x.id === id);
    if (!want) return null;
    const b = await call("button", "model");
    if (b && b.label.toLowerCase().includes(want.name.toLowerCase())) return want;
    say(`Switching to ${want.name}`);
    const m = await openModelMenu();
    const it = m && m.items.find(x => x.name.toLowerCase() === want.name.toLowerCase()) || (m && m.items.find(x => x.name.toLowerCase().startsWith(want.name.toLowerCase())));
    if (!it || it.locked) {
      if (m) await escape();
      return null;
    }
    await center(it);
    await sleep(300);
    if (await call("menu")) await escape();
    return want;
  }
  async function setThinking(on, say) {
    // a switch next to the message box, or one in the model or tools menu
    const t = await call("toggle", "extended thinking|think");
    if (t) {
      if (t.on !== on) {
        say(on ? "Turning on extended thinking" : "Turning off extended thinking");
        await center(t);
      }
      S.thinking = on;
      return true;
    }
    for (const open of [openModelMenu, async () => {
      const tb = await call("toolsButton");
      if (!tb) return null;
      await center(tb);
      return waitFor(() => call("menu"), 2500, 150);
    }]) {
      const m = await open();
      if (!m) continue;
      const it = m.items.find(x => /extended thinking|\bthink/i.test(x.name) && x.toggle);
      if (it) {
        if (it.checked !== on) {
          say(on ? "Turning on extended thinking" : "Turning off extended thinking");
          await center(it);
          await sleep(250);
        }
        if (await call("menu")) await escape();
        S.thinking = on;
        return true;
      }
      await escape();
    }
    return false;
  }

  // ---- attachments: the page's own file picker, given the files directly
  async function attachFiles(paths) {
    if (!paths.length) return true;
    try {
      const { root } = await S.cdp.send("DOM.getDocument", { depth: 0 });
      const { nodeIds } = await S.cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type="file"]' });
      if (!nodeIds || !nodeIds.length) return false;
      await S.cdp.send("DOM.setFileInputFiles", { nodeId: nodeIds[nodeIds.length - 1], files: paths });
      return true;
    } catch (e) {
      log("Couldn't attach files in the Claude app:", e.message || e);
      return false;
    }
  }

  // ---- typing the message and pressing send
  const same = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();
  async function type(text) {
    await call("focusComposer", true);
    await S.cdp.send("Input.insertText", { text });
    await sleep(150);
    if (same(await call("composerText"), text)) return true;
    // typed input didn't take: put it in the way a paste from the keyboard would
    await call("focusComposer", true);
    await call("insertText", text);
    await sleep(150);
    return same(await call("composerText"), text);
  }
  // Presses send as soon as it can be pressed, and says whether the message went. A notice from the app that you're out of
  // messages ends the wait early: that's the answer then.
  async function pressSend(beforeUsers) {
    const began = Date.now();
    let limit = "";
    const b = await waitFor(async () => {
      const x = await call("button", "send");
      if (x && !x.disabled) return x;
      const p = await call("probe");
      if (p && p.limit && Date.now() - began > 3000) {
        limit = p.limit;
        return "limit";
      }
      return null;
    }, 90000, 300);
    if (b === "limit") return { limit };
    if (b) await center(b);
    else {
      await call("focusComposer", false);
      await key("Enter", "Enter", 13);
    }
    // it went once the message is on the page, or the box has emptied
    const went = async () => {
      const p = await call("probe");
      const t = await call("composerText");
      return p && (p.users > beforeUsers || (t !== null && !t.trim())) ? p : null;
    };
    if (await waitFor(went, 15000, 250)) return { ok: true };
    await call("focusComposer", false);
    await key("Enter", "Enter", 13);
    return (await waitFor(went, 10000, 250)) ? { ok: true } : { ok: false };
  }

  // ---- a window on the page that needs an answer, shown on the site
  async function screen(d) {
    let image = "";
    try {
      const shot = await S.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80, clip: { x: d.x + (d.sx || 0), y: d.y + (d.sy || 0), width: Math.max(1, d.w), height: Math.max(1, d.h), scale: 1 } });
      image = shot.data || "";
    } catch {}
    return { kind: "screen", title: d.title || "Claude is asking", text: d.text || "", image, w: Math.round(d.w), h: Math.round(d.h), buttons: (d.buttons || []).map(b => ({ label: b.label, x: Math.round(b.x - d.x), y: Math.round(b.y - d.y), w: Math.round(b.w), h: Math.round(b.h) })) };
  }
  async function watchRemote(emit) {
    let d = null;
    try {
      d = await call("dialog");
    } catch {}
    const key = d ? `${Math.round(d.x)},${Math.round(d.y)},${Math.round(d.w)},${Math.round(d.h)}|${d.text}` : "";
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
    emit({ type: "remote", id, ...(await screen(d)) });
  }
  // An answer from the site: a click on the picture of the window, or one of its buttons.
  async function remoteAnswer(m) {
    const r = S.remote;
    if (!r || r.id !== m.id || !S.cdp) return false;
    if (m.click && Number.isFinite(m.click.x) && Number.isFinite(m.click.y)) {
      const fx = Math.min(1, Math.max(0, m.click.x));
      const fy = Math.min(1, Math.max(0, m.click.y));
      await click(r.d.x + fx * r.d.w, r.d.y + fy * r.d.h);
    } else if (Number.isInteger(m.button) && r.d.buttons[m.button]) await center(r.d.buttons[m.button]);
    else return false;
    S.remote = { ...r, key: "", since: Date.now() }; // send a fresh picture, or say it's gone
    return true;
  }

  // ---- one message, start to finish
  async function runOne(m, emit, stopped) {
    const say = text => {
      S.status = text;
      emit({ type: "status", text });
    };
    await connect(say);
    await front();
    const known = m.resume && chats[m.sessionId] && chats[m.sessionId].conv;
    let p = await call("probe");
    const want = known ? `${APP_BASE}/chat/${known}` : `${APP_BASE}/new`;
    if (!p || !p.composer || p.conv !== (known || "") || (!known && !/\/new\/?$/.test(p.path))) p = await navigate(want);
    if (!p) throw new Error("The Claude app's page didn't load. Check that it's open and online on your computer, then send again.");
    if (p.login || !p.composer) throw Object.assign(new Error("Sign in to Claude in the Claude app on your computer, then send again."), { code: "app_signin" });
    const mi = m.model && m.model !== "app-default" ? await setModel(m.model, say).catch(() => null) : null;
    if (typeof m.thinking === "boolean") await setThinking(m.thinking, say).catch(() => false);
    if (stopped()) return { text: "", stopped: true };
    let prompt = String(m.prompt || "");
    if (m.files && m.files.length) {
      say(m.files.length === 1 ? "Attaching the file" : `Attaching ${m.files.length} files`);
      if (!(await attachFiles(m.files.map(f => f.path)))) prompt += m.inline || "";
      await sleep(600);
    }
    say("Typing your message");
    if (!(await type(prompt || "Take a look at the attached files."))) throw new Error("Couldn't type into the Claude app's message box. It may have changed: check that ClaudeConnect is up to date.");
    const before = (await call("probe")).users;
    const sent = await pressSend(before);
    if (sent.limit) throw Object.assign(new Error(sent.limit), { code: "limit" });
    if (!sent.ok) throw new Error("The Claude app didn't send the message. Check the app on your computer, then try again.");
    say("Thinking");
    const t0 = Date.now();
    let text = "";
    let lastChange = Date.now();
    let started = false;
    let conv = "";
    let stopAsked = false;
    let unanswered = false;
    let tick = 0;
    for (;;) {
      await sleep(150);
      tick++;
      // a window in the app that nobody answers doesn't hold it forever: it's closed (which says no), and the reply stopped
      const waited = S.remote && !stopAsked && Date.now() - S.remote.since > REMOTE_WAIT_MS;
      if (waited) {
        unanswered = true;
        await escape().catch(() => {});
      }
      if ((stopped() || waited) && !stopAsked) {
        stopAsked = true;
        const b = await call("button", "stop").catch(() => null);
        if (b) await center(b);
      }
      const pr = await call("probe");
      if (pr.conv && pr.conv !== conv) {
        conv = pr.conv;
        chats[m.sessionId] = { conv, at: Date.now() };
        saveChats();
      }
      const r = await call("reply");
      const streaming = !!(pr.streaming || (r && r.streaming));
      if (r && (r.md || streaming)) started = true;
      if (r) {
        const ch = textChange(text, r.md);
        if (ch) {
          text = r.md;
          lastChange = Date.now();
          emit(ch);
        }
      }
      if (tick % 4 === 0) await watchRemote(emit);
      const quiet = Date.now() - lastChange;
      // done: the app says so (or has stopped showing it's busy), and the text has settled
      if (started && !streaming && !S.remote && quiet > (r && r.marked ? 900 : 2500) && (text || quiet > 8000)) break;
      if (stopAsked && !streaming && quiet > 800) break;
      if (!started && pr.limit && Date.now() - t0 > 8000) throw Object.assign(new Error(pr.limit), { code: "limit" });
      if (!started && Date.now() - t0 > 120000 && !S.remote) throw new Error("The Claude app didn't start answering. Check the app on your computer.");
      if (quiet > 10 * 60000 && !S.remote) throw new Error("The reply in the Claude app stopped moving.");
    }
    if (S.remote) {
      emit({ type: "remote_done", id: S.remote.id });
      S.remote = null;
    }
    // the exact text claude.ai kept, which has what the page only shows as a card (artifacts), when it can be read
    let thinking = "";
    if (conv && !stopAsked) {
      const exact = await call("conversation", conv).catch(() => null);
      // only the reply just written: about as long, and starting with the same words
      const gist = v => String(v).replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 24).toLowerCase();
      if (exact && exact.text && exact.text.length >= text.length * 0.5 && (!text || gist(exact.text) === gist(text))) {
        text = exact.text;
        thinking = exact.thinking || "";
      }
    }
    const b = await call("button", "model").catch(() => null);
    const name = (mi && mi.name) || (b && b.label) || S.current || "";
    if (b && b.label) S.current = b.label;
    if (unanswered) return { text, thinking, started, error: "Nobody answered the Claude app's question in time, so it was closed and the reply stopped. Send again to carry on.", modelName: name.slice(0, 40), model: modelId(name) };
    return { text, thinking, started, stopped: stopAsked, modelName: name.slice(0, 40), model: modelId(name) };
  }

  // One message at a time: there's one app window.
  let queue = Promise.resolve();
  function run(m, emit, stopped) {
    const waiting = S.busy;
    const p = queue.then(async () => {
      S.busy = m.runId;
      try {
        if (stopped()) return { text: "", stopped: true };
        return await runOne(m, emit, stopped);
      } catch (e) {
        return { text: "", error: String((e && e.message) || e), code: (e && e.code) || "" };
      } finally {
        S.busy = null;
        S.status = "";
      }
    });
    if (waiting) emit({ type: "status", text: "Waiting for the Claude app to finish another reply" });
    queue = p.catch(() => {});
    return p;
  }

  // claude.ai's own usage reading, through the page. Doesn't open the app if it's closed: that waits for a message.
  async function usage() {
    if (!S.cdp || S.cdp.closed) {
      const port = (await endpoint(cfg.appPort)) || (await endpoint(profilePort()));
      if (!port) return null;
      const t = (await targets(port))[0];
      if (!t) return null;
      await attach(t, port, port === cfg.appPort ? "app" : "browser");
    }
    if (!(await ready(15000))) return { error: "unavailable" };
    const r = await call("usage");
    if (!r || r.error) return { error: (r && r.error) || "unavailable" };
    return { limits: limitsFromUsage(r.usage), resets: resetsFrom(r.usage) };
  }
  async function useReset(program, grant, requestId) {
    if (!S.cdp || S.cdp.closed) return { error: "closed" };
    return call("useReset", { program, grant_id: grant, request_id: requestId });
  }

  function info() {
    const { app, browser } = find();
    return {
      kind: S.cdp && !S.cdp.closed ? S.kind : "",
      found: app ? "app" : browser ? "browser" : "",
      models: (S.models || []).slice(0, 12),
      thinking: S.thinking,
      model: S.current
    };
  }
  function close() {
    if (S.cdp) S.cdp.close();
    S.cdp = null;
  }

  return { run, remoteAnswer, usage, useReset, readModels: async () => {
    await connect(() => {});
    const p = await ready();
    return p && p.composer ? readModels(true) : S.models;
  }, info, find, close, state: S };
}
