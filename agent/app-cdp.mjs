// A stand-in for driving the Claude app, used by the tests: the same steps the real driver takes (app-os.mjs), done over the
// Chrome DevTools Protocol in a headless Chromium that shows a stand-in for claude.ai (test/helpers/fake-claude-app.mjs).
//
// The real Claude desktop app can't be driven this way: it refuses to start with a debugging port unless Anthropic has
// signed for it, on purpose, so nothing on the computer can read or type into your conversations through one. That's why
// the real driver goes through the operating system's accessibility features instead, with your permission. This file is
// only chosen with CLAUDECONNECT_APP_DRIVER=cdp, which the tests set.
//
// The page code runs in an isolated world: the page can't see it. It never calls Runtime.enable, and clicks are real input
// events.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename } from "node:path";

// claude.ai, or the stand-in for it
export const APP_BASE = (process.env.CLAUDECONNECT_APP_URL || "https://claude.ai").replace(/\/+$/, "");
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
      size: innerWidth * innerHeight,
      stop: stopPressed
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

  // The way out, on the app's own window while something else is using it: a green edge round the window and a bar at the top
  // that says so, with a button to stop. It's drawn in a closed shadow root, so the page's styles can't reach it and the
  // page's own lookups don't find it, and it lets every click but its own through. Pressing the button is only noted here:
  // the program on the computer asks every moment, and lets go of the app as soon as it's been pressed.
  let bar = null;
  let stopPressed = false;
  function overlay(on, text, label) {
    if (!on) {
      if (bar) bar.host.remove();
      bar = null;
      return { stop: stopPressed };
    }
    if (!bar || !bar.host.isConnected) {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none;display:block";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
.edge{position:fixed;inset:0;border:3px solid #10a37f;border-radius:12px;pointer-events:none;box-sizing:border-box}
.bar{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:10px;max-width:calc(100vw - 32px);padding:5px 5px 5px 14px;border-radius:999px;background:#0d0d0d;color:#fff;font:500 13px/18px ui-sans-serif,-apple-system,system-ui,"Segoe UI",sans-serif;box-shadow:0 8px 28px rgba(0,0,0,.28);pointer-events:auto;white-space:nowrap}
.t{overflow:hidden;text-overflow:ellipsis}
.dot{width:8px;height:8px;flex:none;border-radius:50%;background:#10a37f;animation:p 1.4s ease-in-out infinite}
@keyframes p{50%{opacity:.35}}
button{font:inherit;font-weight:600;border:0;border-radius:999px;background:#fff;color:#0d0d0d;padding:6px 14px;cursor:pointer;flex:none}
button:hover{background:#e5e5e5}
:host([data-pass]) .bar{pointer-events:none}
:host([data-hide]){display:none!important}
</style><div class="edge"></div><div class="bar" role="status" aria-live="polite"><span class="dot"></span><span class="t"></span><button type="button"></button></div>`;
      root.querySelector("button").addEventListener("click", () => {
        if (host.hasAttribute("data-pass")) return;
        stopPressed = true;
        root.querySelector("button").textContent = "Stopping…";
      });
      document.documentElement.appendChild(host);
      bar = { host, root };
    }
    const t = bar.root.querySelector(".t");
    if (t.textContent !== text) t.textContent = text;
    const b = bar.root.querySelector("button");
    const want = stopPressed ? "Stopping…" : label;
    if (b.textContent !== want) b.textContent = want;
    return { stop: stopPressed };
  }
  // while a click of ours goes through (it could land where the bar is), or a picture of a window is taken, the bar steps aside
  function overlayPass(how) {
    if (!bar) return false;
    bar.host.toggleAttribute("data-pass", how === "pass");
    bar.host.toggleAttribute("data-hide", how === "hide");
    return true;
  }
  const stopped = () => stopPressed;

  return { VERSION, probe, composerText, focusComposer, insertText, button, reply, menu, item, toggle, toolsButton, dialog, usage, useReset, conversation, markdown, overlay, overlayPass, stopped };
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
        w.reject(Object.assign(new Error("The connection to the desktop app closed."), { gone: true }));
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
    if (this.closed) return Promise.reject(Object.assign(new Error("The connection to the desktop app closed."), { gone: true }));
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error(`The desktop app didn't answer (${method}).`));
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


// The driver: the same calls the real one answers (see app-os.mjs), done through the page.
export function cdpDriver({ cfg, saveConfig, log, WS = globalThis.WebSocket, appPath }) {
  const S = { cdp: null, target: null, ctx: 0, port: 0 };
  if (!Number.isInteger(cfg.appPort) || cfg.appPort < 1024 || cfg.appPort > 65535) {
    cfg.appPort = 30000 + Math.floor(Math.random() * 9000);
    saveConfig();
  }
  const sameSite = u => {
    try {
      return new URL(u).origin === new URL(APP_BASE).origin;
    } catch {
      return false;
    }
  };
  async function endpoint(port) {
    const v = port ? await getJson(`http://127.0.0.1:${port}/json/version`) : null;
    return v ? port : 0;
  }
  async function targets(port) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    return Array.isArray(list) ? list.filter(t => t && t.webSocketDebuggerUrl && sameSite(t.url) && t.type === "page") : [];
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
  async function attach(t, port) {
    S.cdp = await Cdp.open(t.webSocketDebuggerUrl, WS);
    S.target = t;
    S.port = port;
    S.ctx = 0;
    log("Connected to the desktop app.");
    // the page acts as if it has focus, so nothing waits for the window to come forward
    await S.cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
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
    // a click of ours goes past the Stop bar, wherever it lands; only a person's click can press Stop
    await call("overlayPass", "pass").catch(() => {});
    try {
      for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await S.cdp.send("Input.dispatchMouseEvent", { type, x, y, button: type === "mouseMoved" ? "none" : "left", clickCount: 1 });
    } finally {
      await call("overlayPass", "").catch(() => {});
    }
  }
  const center = r => click(r.x + r.w / 2, r.y + r.h / 2);
  async function key(k, code, keyCode) {
    await S.cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
    await S.cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: keyCode, nativeVirtualKeyCode: keyCode });
  }
  const escape = () => key("Escape", "Escape", 27);
  // The page has loaded far enough to work with: the message box is there, or claude.ai is asking you to sign in.
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
  async function openMenu() {
    const b = await waitFor(() => call("button", "model").catch(() => null), 2500, 250);
    if (!b) return null;
    await center(b);
    return waitFor(() => call("menu"), 3000, 150);
  }

  return {
    // the stand-in app: started with its debugging port, like nothing real is
    find() {
      return { installed: !!appPath && existsSync(appPath), path: appPath || "", how: "stand-in" };
    },
    async start(say) {
      if (S.cdp && !S.cdp.closed && S.target) return;
      S.cdp = null;
      S.ctx = 0;
      if (await endpoint(cfg.appPort)) {
        const t = await waitFor(async () => (await targets(cfg.appPort))[0], 4000);
        if (t) return attach(t, cfg.appPort);
      }
      if (!appPath || !existsSync(appPath)) throw Object.assign(new Error("The desktop app isn't on this computer."), { code: "app_missing" });
      say("Opening the desktop app");
      const child = spawn(appPath, [`--remote-debugging-port=${cfg.appPort}`], { detached: true, stdio: "ignore" });
      child.on("error", e => log("Couldn't start", basename(appPath) + ":", e.message || e));
      child.unref();
      const port = await waitFor(() => endpoint(cfg.appPort), 30000, 300);
      const t = port && (await waitFor(async () => (await targets(port))[0], 45000, 300));
      if (!t) throw new Error("The desktop app didn't open.");
      await attach(t, port);
    },
    // where the page is: the conversation, the message box, the sign-in page, the reply being written, a limit notice
    probe: () => call("probe"),
    ready: ms => ready(ms),
    // the stand-in app is open (its debugging port answers)
    running: async () => !!(await endpoint(cfg.appPort)),
    // conv: a conversation, "" for a new one, or null for wherever it is now
    async open(conv) {
      if (conv === null || conv === undefined) return ready(15000);
      const p = await call("probe").catch(() => null);
      if (p && p.composer && p.conv === (conv || "") && (conv || /\/new\/?$/.test(p.path))) return p;
      return navigate(conv ? `${APP_BASE}/chat/${conv}` : `${APP_BASE}/new`);
    },
    // the model menu: its models, the extended thinking switch, and the model picked now
    async models() {
      const m = await openMenu();
      if (!m) return null;
      const models = [];
      let thinking = null;
      for (const it of m.items) {
        if (/extended thinking|think/i.test(it.name) && it.toggle) thinking = it.checked;
        else if (/\b(opus|sonnet|haiku|fable|claude)\b/i.test(it.name) && /\d/.test(it.name) && models.length < 12) models.push({ name: it.name.slice(0, 40), desc: it.desc, locked: !!it.locked });
      }
      await escape();
      const b = await call("button", "model");
      return { models, thinking, current: b ? b.label : "" };
    },
    async current() {
      const b = await call("button", "model").catch(() => null);
      return b ? b.label : "";
    },
    async setModel(name) {
      const m = await openMenu();
      const low = name.toLowerCase();
      const it = (m && m.items.find(x => x.name.toLowerCase() === low)) || (m && m.items.find(x => x.name.toLowerCase().startsWith(low)));
      if (!it || it.locked) {
        if (m) await escape();
        return false;
      }
      await center(it);
      await sleep(300);
      if (await call("menu")) await escape();
      return true;
    },
    // a switch next to the message box, or one in the model or tools menu
    async setThinking(on) {
      const t = await call("toggle", "extended thinking|think");
      if (t) {
        if (t.on !== on) await center(t);
        return true;
      }
      for (const open of [openMenu, async () => {
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
            await center(it);
            await sleep(250);
          }
          if (await call("menu")) await escape();
          return true;
        }
        await escape();
      }
      return false;
    },
    // the page's own file picker, given the files directly
    async attach(paths) {
      try {
        const { root } = await S.cdp.send("DOM.getDocument", { depth: 0 });
        const { nodeIds } = await S.cdp.send("DOM.querySelectorAll", { nodeId: root.nodeId, selector: 'input[type="file"]' });
        if (!nodeIds || !nodeIds.length) return false;
        await S.cdp.send("DOM.setFileInputFiles", { nodeId: nodeIds[nodeIds.length - 1], files: paths });
        return true;
      } catch (e) {
        log("Couldn't attach files in the desktop app:", e.message || e);
        return false;
      }
    },
    async type(text) {
      const same = (a, b) => String(a || "").replace(/\s+/g, " ").trim() === String(b || "").replace(/\s+/g, " ").trim();
      await call("focusComposer", true);
      await S.cdp.send("Input.insertText", { text });
      await sleep(150);
      if (same(await call("composerText"), text)) return true;
      await call("focusComposer", true);
      await call("insertText", text);
      await sleep(150);
      return same(await call("composerText"), text);
    },
    // Presses send as soon as it can be pressed, and says whether the message went. A notice that you're out of messages ends
    // the wait early: that's the answer then.
    async send(beforeUsers) {
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
      const went = async () => {
        const p = await call("probe");
        const t = await call("composerText");
        return p && (p.users > beforeUsers || (t !== null && !t.trim())) ? p : null;
      };
      if (await waitFor(went, 15000, 250)) return { ok: true };
      await call("focusComposer", false);
      await key("Enter", "Enter", 13);
      return (await waitFor(went, 10000, 250)) ? { ok: true } : { ok: false };
    },
    reply: () => call("reply"),
    // the exact text claude.ai kept, which has what the page only shows as a card (artifacts)
    exact: conv => call("conversation", conv),
    async stop() {
      const b = await call("button", "stop").catch(() => null);
      if (b) await center(b);
    },
    escape: () => escape(),
    dialog: () => call("dialog"),
    // a picture of just that window, for the site
    async shot(d) {
      let image = "";
      await call("overlayPass", "hide").catch(() => {});
      try {
        const shot = await S.cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 80, clip: { x: d.x + (d.sx || 0), y: d.y + (d.sy || 0), width: Math.max(1, d.w), height: Math.max(1, d.h), scale: 1 } });
        image = shot.data || "";
      } catch {}
      await call("overlayPass", "").catch(() => {});
      return { image, w: Math.round(d.w), h: Math.round(d.h), buttons: (d.buttons || []).map(b => ({ label: b.label, x: Math.round(b.x - d.x), y: Math.round(b.y - d.y), w: Math.round(b.w), h: Math.round(b.h) })) };
    },
    async answer(d, m) {
      if (m.click && Number.isFinite(m.click.x) && Number.isFinite(m.click.y)) {
        await click(d.x + Math.min(1, Math.max(0, m.click.x)) * d.w, d.y + Math.min(1, Math.max(0, m.click.y)) * d.h);
        return true;
      }
      if (Number.isInteger(m.button) && d.buttons[m.button]) {
        await center(d.buttons[m.button]);
        return true;
      }
      return false;
    },
    // the Stop bar, drawn on the stand-in's page; says whether it was pressed
    async bar(on, text, label) {
      if (!S.cdp) return { stop: false };
      return (await call("overlay", on, text || "", label || "Stop")) || { stop: false };
    },
    async usage() {
      if (!S.cdp || S.cdp.closed) {
        if (!(await endpoint(cfg.appPort))) return null;
        const t = (await targets(cfg.appPort))[0];
        if (!t) return null;
        await attach(t, cfg.appPort);
      }
      if (!(await ready(15000))) return { error: "unavailable" };
      return call("usage");
    },
    async useReset(body) {
      if (!S.cdp || S.cdp.closed) return { error: "closed" };
      return call("useReset", body);
    },
    connected: () => !!(S.cdp && !S.cdp.closed),
    close() {
      if (S.cdp) S.cdp.close();
      S.cdp = null;
      S.target = null;
      S.ctx = 0;
    }
  };
}
