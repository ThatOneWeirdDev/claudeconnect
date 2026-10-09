import { DurableObject } from "cloudflare:workers";
import APP_HTML from "./app.html";
import BRAND from "./brand.js";
import { parseVersion, compareVersions, isNewer, cleanManifest, validRepo, validRef } from "./version.js";
import { cleanSiteName, cleanAddress } from "./names.js";
import { checkImage } from "./image.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHUNK = 400000;
const ISS_RE = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
// "claude" is plain chat with no tools; "code" is Claude Code working in the folder on the computer. In Claude Code, the
// permission mode says how freely it acts: "auto" is whatever the computer is set to (normally auto), "plan" only plans.
const MODES = ["claude", "code"];
const PERMS = ["auto", "acceptEdits", "plan"];
const MODELS = {
  "claude-fable-5-1": { name: "Fable 5.1", efforts: ALL_EFFORTS },
  "claude-opus-5-5": { name: "Opus 5.5", efforts: ALL_EFFORTS },
  "claude-sonnet-5-5": { name: "Sonnet 5.5", efforts: ALL_EFFORTS },
  "claude-haiku-5-5": { name: "Haiku 5.5", efforts: [] }
};
const DEFAULT_MODEL = "claude-opus-5-5";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_REPO = "ThatOneWeirdDev/claudeconnect";
// What each kind of job does, in order. The page shows these as its checklist, so the labels are what people read.
const PLANS = {
  update: [["download", "Download the new version"], ["verify", "Check that it's intact"], ["site", "Update the site"], ["computer", "Update your computer"], ["restart", "Restart"], ["online", "Come back online"]],
  settings: [["site", "Update the site"], ["computer", "Update your computer"], ["restart", "Restart"], ["online", "Come back online"]],
  move: [["prepare", "Check the new address"], ["create", "Create the new site"], ["access", "Turn on Access for it"], ["switch", "Move your computer over"], ["cleanup", "Delete the old site"]],
  delete: [["site", "Delete the site and its chats"], ["computer", "Clean up your computer"]]
};
const LIMIT_WINDOWS = ["five_hour", "seven_day", "seven_day_overage_included"];
const LIMIT_STATUS = ["allowed", "allowed_warning", "rejected"];
// The settings that live on the computer, which the site can show and change.
const COMPUTER_KEYS = ["autostart", "credits"];

function cleanComputer(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const k of COMPUTER_KEYS) if (typeof v[k] === "boolean") out[k] = v[k];
  return Object.keys(out).length ? out : null;
}
// A new release is looked for at most this often. GitHub's own cache is skipped (see checkLatest), so a merge to main reaches
// an open page within about a minute and a half; a page opened after a long gap waits for the answer instead of showing the old one.
const CHECK_EVERY = 60000;
const CHECK_RETRY = 120000;
const CHECK_WAIT = 5 * 60000;
const UPDATE_LOG_KEEP = 8;
// The most chats listed in the sidebar (and the most the computer is asked to report). Matches MAX_SESSIONS in agent/sessions.mjs.
const CHAT_LIST_MAX = 3000;
// Chats imported from claude.ai: the most one batch from the page may hold, the most messages kept per chat, and how much of
// the conversation the first reply in one is given to read.
const IMPORT_MAX_BYTES = 8000000;
const IMPORT_MAX_MESSAGES = 2000;
const IMPORT_CONTEXT_CHARS = 150000;
const ACK_WITHIN = 30000;
const QUIET_LIMIT = 10 * 60000;
const MAX_ARTIFACT = 1900000;
const MIME = { html: "text/html", htm: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", pdf: "application/pdf", md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", css: "text/css", py: "text/plain", java: "text/plain", c: "text/plain", cpp: "text/plain", h: "text/plain", cs: "text/plain", go: "text/plain", rs: "text/plain", rb: "text/plain", php: "text/plain", sh: "text/plain", ps1: "text/plain", bat: "text/plain", sql: "text/plain", yml: "text/plain", yaml: "text/plain", toml: "text/plain", xml: "text/xml", ini: "text/plain", log: "text/plain", tex: "text/plain", kt: "text/plain", swift: "text/plain", lua: "text/plain", r: "text/plain", vue: "text/plain", svelte: "text/plain" };
const DEFAULT_MARK = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect class="m-bg" width="64" height="64" rx="16"/><circle class="m-fg" cx="29" cy="29" r="12.5" fill="none" stroke-width="6.5"/><path class="m-fg" d="M41.5 29v22" stroke-width="6.5" stroke-linecap="round"/><path class="m-fg" d="M36 45h11" stroke-width="5" stroke-linecap="round"/></svg>`;

const certCache = new Map();
const keyCache = new Map();
let identityCache = null;
let identityAt = 0;
let notedExp = 0;
const brandBytes = {};

function siteName(env) {
  return String(env.SITE_NAME || "ClaudeConnect").slice(0, 60);
}

function commandName(env) {
  return String(env.COMMAND || "ClaudeConnect").slice(0, 60);
}

// How much of the model's context window the chat fills after a reply. Anything that isn't a plain pair of counts is dropped.
function cleanContext(c) {
  if (!c || typeof c !== "object" || typeof c.used !== "number" || typeof c.window !== "number") return null;
  const used = Math.round(c.used);
  const window = Math.round(c.window);
  if (!Number.isFinite(used) || !Number.isFinite(window) || used < 0 || window < 1000 || window > 1e8) return null;
  return { used: Math.min(used, window * 4), window };
}

// A number from the environment, or the usual one. Only the tests set these, to not wait out real timeouts.
const envNum = (v, d) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);

function appVersion(env) {
  return String(env.APP_VERSION || "0.0.0").slice(0, 32);
}

function escHtml(v) {
  return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function brandAsset(kind) {
  const b = BRAND && BRAND[kind];
  if (!b || !b.b64) return null;
  if (!brandBytes[kind]) brandBytes[kind] = b64urlBytes(b.b64);
  return { type: b.type, bytes: brandBytes[kind] };
}

function kindOf(mime, name) {
  if (mime === "text/html") return "web";
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/markdown") return "doc";
  if (mime.startsWith("text/") || mime === "application/json" || /\.(txt)$/i.test(name)) return "code";
  return "file";
}

function mimeOf(name) {
  const ext = (String(name).match(/\.([A-Za-z0-9]+)$/) || [])[1];
  return (ext && MIME[ext.toLowerCase()]) || "application/octet-stream";
}

function modelsFor(env) {
  const out = {};
  for (const [id, m] of Object.entries(MODELS)) if (id !== "claude-fable-5-1" || env.SHOW_FABLE === "1") out[id] = m;
  return out;
}

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0D0D0D"/><circle cx="29" cy="29" r="12.5" fill="none" stroke="#fff" stroke-width="6.5"/><path d="M41.5 29v22" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/><path d="M36 45h11" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra } });
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = enc.encode(a);
  const y = enc.encode(b);
  if (x.length !== y.length) return false;
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

function b64urlBytes(s) {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function b64urlJson(s) {
  return JSON.parse(dec.decode(b64urlBytes(s)));
}

async function sha256(s) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function accessKeys(iss, force) {
  const hit = certCache.get(iss);
  if (hit && !force && Date.now() - hit.at < 3600000) return hit.keys;
  const r = await fetch(iss + "/cdn-cgi/access/certs");
  if (!r.ok) throw new Error("certs " + r.status);
  const j = await r.json();
  const keys = Array.isArray(j.keys) ? j.keys : [];
  certCache.set(iss, { at: Date.now(), keys });
  return keys;
}

async function verifyAccessJwt(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  let header;
  let payload;
  try {
    header = b64urlJson(parts[0]);
    payload = b64urlJson(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || typeof payload.iss !== "string" || !ISS_RE.test(payload.iss)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp !== "number" || payload.exp < now - 30) return null;
  if (typeof payload.nbf === "number" && payload.nbf > now + 30) return null;
  let keys = await accessKeys(payload.iss, false);
  let jwk = keys.find(k => k.kid === header.kid);
  if (!jwk) {
    keys = await accessKeys(payload.iss, true);
    jwk = keys.find(k => k.kid === header.kid);
  }
  if (!jwk) return null;
  const cacheKey = payload.iss + "#" + jwk.kid + "#" + jwk.n;
  let key = keyCache.get(cacheKey);
  if (!key) {
    key = await crypto.subtle.importKey("jwk", { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true }, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    if (keyCache.size > 20) keyCache.clear();
    keyCache.set(cacheKey, key);
  }
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64urlBytes(parts[2]), enc.encode(parts[0] + "." + parts[1]));
  return ok ? payload : null;
}

function readCookie(req, name) {
  const c = req.headers.get("cookie") || "";
  for (const part of c.split(/;\s*/)) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i) === name) return part.slice(i + 1);
  }
  return null;
}

async function loadIdentity(hub) {
  if (identityCache && Date.now() - identityAt < 30000) return identityCache;
  identityCache = await hub.getIdentity();
  identityAt = Date.now();
  return identityCache;
}

async function authenticate(req, env, hub, url) {
  const token = req.headers.get("cf-access-jwt-assertion") || readCookie(req, "CF_Authorization");
  if (!token) return { ok: false, state: "no-access" };
  let p = null;
  try {
    p = await verifyAccessJwt(token);
  } catch {
    p = null;
  }
  if (!p) return { ok: false, state: "bad-token" };
  const email = String(p.email || "").toLowerCase();
  const aud = [].concat(p.aud || []).map(String);
  let id = await loadIdentity(hub);
  const claim = url.searchParams.get("claim");
  if (claim && email && env.CLAIM_CODE && safeEqual(claim, env.CLAIM_CODE)) {
    const claimHash = await sha256(claim);
    if (!id || id.claimHash !== claimHash) {
      id = { iss: p.iss, aud, email, claimHash, at: Date.now() };
      await hub.setIdentity(id);
      identityCache = id;
      identityAt = Date.now();
      return { ok: true, email, claimed: true, token, exp: p.exp };
    }
  }
  if (!id) return { ok: false, state: "unclaimed" };
  if (p.iss !== id.iss || !aud.some(a => id.aud.includes(a)) || email !== id.email) return { ok: false, state: "denied" };
  return { ok: true, email, claimed: !!claim, token, exp: p.exp };
}

// What a locked site says, and what its owner can do about it. Anyone can read this page, so it names nothing but the site,
// and the steps only say where to click. Nothing here lets anyone in: the site opens only for a verified Cloudflare Access sign-in
// that belongs to whoever claimed it.
// Links the computer reports while a move waits for the owner. They're shown as links, so only web addresses are kept
// (https, or this computer's own address for testing).
function cleanJobInfo(v) {
  if (!v || typeof v !== "object") return null;
  const out = {};
  for (const k of ["site", "claim", "dash"]) if (typeof v[k] === "string" && /^(https:\/\/|http:\/\/(127\.0\.0\.1|localhost)[:/])[^\s"'<>]{1,380}$/.test(v[k])) out[k] = v[k];
  if (typeof v.name === "string" && /^[a-z0-9-]{1,63}$/.test(v.name)) out.name = v.name;
  return Object.keys(out).length ? out : null;
}

function lockPage(state, lockName, lockMark, host, command) {
  const worker = escHtml(String(host || "").split(".")[0] || "your-site");
  const cmd = `<code>${escHtml(command)}</code>`;
  const dash = `https://dash.cloudflare.com/?to=/:account/workers/services/view/${encodeURIComponent(String(host || "").split(".")[0] || "")}/production/settings`;
  const claimStep = `Open your claim link, the address that ends in <code>?claim=…</code>. Lost it? Run ${cmd} <code>claim</code> on your computer for a fresh one.`;
  const copy = {
    "no-access": {
      title: "This site is locked",
      text: "It isn't protected by Cloudflare Access, so nobody can open it, not even its owner. That's on purpose.",
      steps: [
        `Open the <a href="${dash}" rel="noopener noreferrer" target="_blank">Cloudflare dashboard</a> and go to <b>Workers &amp; Pages</b>, then <b>${worker}</b>.`,
        `Open <b>Settings</b> &rarr; <b>Domains &amp; Routes</b>, find the <b>workers.dev</b> row and choose <b>Enable Cloudflare Access</b>.`,
        `Choose <b>Manage Cloudflare Access</b> and make sure the policy allows only <b>your own email address</b>. Anyone who isn't on that list can't get in.`,
        `Reload this page and sign in with that email. ${claimStep}`
      ]
    },
    "bad-token": { title: "Sign in again", text: "Your Cloudflare Access sign-in couldn't be verified. Reload the page to sign in again.", steps: null },
    "unclaimed": { title: "This site has no owner yet", text: "Access is on, but nobody has claimed the site, so it stays closed to everyone.", steps: [claimStep] },
    "denied": {
      title: "You don't have access",
      text: "This site belongs to a different account.",
      steps: [`Turned Access off and on again, or changed who is allowed in? Then the old claim no longer matches. Run ${cmd} <code>claim</code> on your computer, open the new claim link while signed in with the email you want to use, and it's yours again.`]
    }
  }[state] || { title: "Locked", text: "This page is locked.", steps: null };
  const owner = copy.steps ? `<details><summary>I'm the owner</summary><ol>${copy.steps.map(x => `<li>${x}</li>`).join("")}</ol></details>` : "";
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(lockName)}</title><link rel="icon" href="/favicon"><style>:root{color-scheme:light dark;--bg:#fff;--card:#f9f9f9;--ink:#0d0d0d;--ink2:#5d5d5d;--line:rgba(13,13,13,.1);--hover:rgba(13,13,13,.06);--code:#f3f3f3;--link:#0169cc;--solid:#0d0d0d;--solid-ink:#fff}@media (prefers-color-scheme:dark){:root{--bg:#212121;--card:#181818;--ink:#fff;--ink2:#afafaf;--line:rgba(255,255,255,.1);--hover:rgba(255,255,255,.08);--code:#303030;--link:#339cff;--solid:#fff;--solid-ink:#0d0d0d}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.6 ui-sans-serif,-apple-system,system-ui,"Segoe UI","Noto Sans",Helvetica,Arial,sans-serif;padding:24px}main{width:100%;max-width:480px}.m{display:block;width:40px;height:40px;margin-bottom:22px}.m svg,.m img{width:40px;height:40px;border-radius:10px;object-fit:contain}.m-bg{fill:var(--ink)}.m-fg{stroke:var(--bg)}h1{font-size:24px;line-height:1.3;font-weight:600;margin:0 0 8px;letter-spacing:-.01em}p{margin:0;color:var(--ink2)}details{margin-top:24px}summary{display:inline-flex;align-items:center;height:40px;padding:0 18px;border-radius:999px;background:var(--solid);color:var(--solid-ink);font-weight:600;font-size:15px;cursor:pointer;list-style:none;user-select:none}summary::-webkit-details-marker{display:none}summary:hover{opacity:.88}summary:focus-visible{outline:2px solid var(--link);outline-offset:2px}details[open] summary{background:var(--hover);color:var(--ink)}ol{margin:18px 0 0;padding:18px 20px 18px 38px;background:var(--card);border:1px solid var(--line);border-radius:16px;color:var(--ink2);font-size:15px}li{margin:0 0 10px;padding-left:4px}li:last-child{margin:0}b{color:var(--ink);font-weight:600}a{color:var(--link)}code{font:13.5px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:.1em .4em;border-radius:6px;color:var(--ink)}</style></head><body><main><span class="m">${lockMark}</span><h1>${copy.title}</h1><p>${copy.text}</p>${owner}</main></body></html>`;
  return new Response(html, { status: state === "denied" ? 403 : 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "referrer-policy": "no-referrer", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" } });
}

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "x-frame-options": "DENY",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};

function appPage(env) {
  const name = siteName(env);
  const logo = brandAsset("logo");
  const mark = logo ? `<img src="/logo" alt="">` : DEFAULT_MARK;
  const cfg = JSON.stringify({ name, command: commandName(env), fable: env.SHOW_FABLE === "1", version: appVersion(env) }).replace(/</g, "\\u003c");
  const html = APP_HTML.split("__SITE_NAME__").join(escHtml(name)).split("__BRAND_MARK__").join(mark).split("__CFG__").join(cfg);
  return new Response(html, { headers: PAGE_HEADERS });
}

function brandResponse(kind) {
  const a = brandAsset(kind) || (kind === "favicon" ? brandAsset("logo") : null);
  if (!a) {
    if (kind === "logo") return new Response("Not found", { status: 404 });
    return new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=3600" } });
  }
  return new Response(a.bytes, { headers: { "content-type": a.type, "cache-control": "public, max-age=3600", "x-content-type-options": "nosniff", "content-security-policy": "sandbox" } });
}

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (url.pathname === "/favicon.svg" || url.pathname === "/favicon" || url.pathname === "/favicon.ico") return brandResponse("favicon");
    if (url.pathname === "/logo") return brandResponse("logo");
    const hub = env.HUB.get(env.HUB.idFromName("main"));
    const a = await authenticate(req, env, hub, url);
    const isAgent = url.pathname === "/agent" || url.pathname === "/agent/check" || url.pathname === "/agent/progress";
    if (!a.ok) {
      if (url.pathname.startsWith("/api/") || isAgent) return json({ error: "Locked", state: a.state }, 401);
      const lg = brandAsset("logo");
      return lockPage(a.state, siteName(env), lg ? `<img src="/logo" alt="">` : DEFAULT_MARK, url.hostname, commandName(env));
    }
    if (a.exp > notedExp) {
      notedExp = a.exp;
      ctx.waitUntil(hub.noteToken(a.token, a.exp).catch(() => {}));
    }
    if (a.claimed && !isAgent) return new Response(null, { status: 302, headers: { location: url.origin + "/", "cache-control": "no-store" } });
    if (isAgent) {
      if (!env.AGENT_SECRET || !safeEqual(req.headers.get("x-chatgql-key") || "", env.AGENT_SECRET)) return json({ error: "Forbidden" }, 403);
      if (url.pathname === "/agent/check") return new Response(null, { status: 204 });
      const h = new Headers(req.headers);
      h.set("x-agent-key", env.AGENT_SECRET);
      h.delete("x-chatgql-key");
      if (url.pathname === "/agent/progress") {
        if (req.method !== "POST") return json({ error: "Expected POST" }, 405);
        const body = await req.text();
        if (body.length > 20000) return json({ error: "Too large" }, 413);
        return hub.fetch(new Request("https://hub.internal/agent/progress", { method: "POST", headers: h, body }));
      }
      return hub.fetch(new Request("https://hub.internal/agent", { headers: h }));
    }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/a/")) {
      if (req.method !== "GET" && req.method !== "HEAD") {
        const origin = req.headers.get("origin");
        if (origin && origin !== url.origin) return json({ error: "Forbidden" }, 403);
        if ((req.method === "POST" || req.method === "PATCH") && !/application\/json/i.test(req.headers.get("content-type") || "")) return json({ error: "Expected JSON" }, 415);
      }
      const h = new Headers(req.headers);
      h.set("x-chatgql-user", a.email);
      h.set("x-show-fable", env.SHOW_FABLE === "1" ? "1" : "0");
      return hub.fetch(new Request(req, { headers: h }));
    }
    if (url.pathname === "/" || url.pathname.startsWith("/c/")) return appPage(env);
    return new Response("Not found", { status: 404 });
  }
};

function titleFrom(text, files) {
  const line = String(text || "").split("\n").map(s => s.trim()).find(Boolean) || (files[0] && files[0].name) || "New chat";
  return line.length > 60 ? line.slice(0, 57).trimEnd() + "…" : line;
}

export class ChatgqlHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec("CREATE TABLE IF NOT EXISTS chats (id TEXT PRIMARY KEY, title TEXT, model TEXT, effort TEXT, session_id TEXT, started INTEGER DEFAULT 0, running TEXT, created INTEGER, updated INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, chat_id TEXT, role TEXT, content TEXT, meta TEXT, created INTEGER)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS messages_chat ON messages(chat_id, created)");
    // The chats Claude Code has saved on the computer (only a list; a chat is copied here when it is opened), and the ones
    // deleted here, which are not listed again even though Claude Code still has them.
    this.sql.exec("CREATE TABLE IF NOT EXISTS computer_sessions (id TEXT PRIMARY KEY, title TEXT, folder TEXT, updated INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS hidden_sessions (id TEXT PRIMARY KEY)");
    // How many questions of the chat's Claude Code session are already here, and the session file's time when that was true.
    // origin: "claude.ai" for a chat imported from a claude.ai data export, else empty
    for (const col of ["synced_turns INTEGER", "synced_at INTEGER", "folder TEXT", "origin TEXT"]) {
      try {
        this.sql.exec(`ALTER TABLE chats ADD COLUMN ${col}`);
      } catch {}
    }
    this.sql.exec("CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, chat_id TEXT, name TEXT, mime TEXT, size INTEGER, data BLOB, created INTEGER)");
    this.sql.exec("DROP TABLE IF EXISTS usage");
    this.latest = null;
    this.checking = null;
    this.runs = new Map();
    this.parts = new Map();
    this.asks = new Map();
    this.lastSync = new Map();
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async getIdentity() {
    return (await this.ctx.storage.get("identity")) || null;
  }

  async setIdentity(v) {
    await this.ctx.storage.put("identity", v);
    return true;
  }

  async noteToken(token, exp) {
    const cur = await this.ctx.storage.get("token");
    if (cur && cur.exp >= exp) return false;
    const rec = { token, exp };
    await this.ctx.storage.put("token", rec);
    if (this.env.TOKENS) await this.env.TOKENS.put("agent-token", JSON.stringify(rec));
    const ws = this.agent();
    if (ws) {
      try {
        ws.send(JSON.stringify({ type: "token", token, exp }));
      } catch {}
    }
    return true;
  }

  rows(q, ...b) {
    return this.sql.exec(q, ...b).toArray();
  }

  one(q, ...b) {
    return this.rows(q, ...b)[0] || null;
  }

  agent() {
    const list = this.ctx.getWebSockets("agent");
    return list.length ? list[list.length - 1] : null;
  }

  agentInfo(ws) {
    try {
      return ws.deserializeAttachment() || {};
    } catch {
      return {};
    }
  }

  sendAgent(ws, obj) {
    const s = JSON.stringify(obj);
    if (s.length <= CHUNK) {
      ws.send(s);
      return;
    }
    const key = crypto.randomUUID();
    const n = Math.ceil(s.length / CHUNK);
    for (let i = 0; i < n; i++) ws.send(JSON.stringify({ type: "part", key, i, n, d: s.slice(i * CHUNK, (i + 1) * CHUNK) }));
  }

  // The reply in the order it happened: stretches of thinking, text and tool calls, the way Claude Code shows them.
  part(r, type) {
    const last = r.parts[r.parts.length - 1];
    if (last && last.type === type) return last;
    const p = { type, text: "" };
    r.parts.push(p);
    return p;
  }

  // What's kept with a finished reply: each stretch's length, pointing into the reply's text and thinking, so nothing is
  // stored twice. Only when the stretches add up to exactly the text and thinking kept; anything else shows the old way.
  partsMeta(r, text, thinking) {
    if (!r || !r.parts.length) return null;
    const sum = type => r.parts.filter(p => p.type === type).reduce((n, p) => n + p.text.length, 0);
    if (sum("text") !== text.length || sum("think") !== thinking.length) return null;
    return r.parts.slice(0, 400).map(p => (p.type === "tool" ? { t: "tool", id: String(p.id).slice(0, 80) } : { t: p.type, n: p.text.length, ...(p.ms ? { ms: p.ms } : {}) }));
  }

  push(runId, obj) {
    const r = this.runs.get(runId);
    if (!r || r.closed) return;
    r.writer.write(enc.encode(JSON.stringify(obj) + "\n")).catch(() => {
      r.closed = true;
    });
  }

  armRun(runId, ms, message) {
    const r = this.runs.get(runId);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    r.timer = setTimeout(() => this.runTimedOut(runId, message, !r.heard), ms);
  }

  async runTimedOut(runId, message, silent) {
    const r = this.runs.get(runId);
    if (!r) return;
    const ws = this.agent();
    if (ws && silent) {
      try {
        ws.close(4001, "unresponsive");
      } catch {}
    } else if (ws) {
      try {
        this.sendAgent(ws, { type: "stop", runId, chatId: r.chatId });
      } catch {}
    }
    await this.completeRun({ runId, chatId: r.chatId, text: r.text, error: message });
  }

  closeRun(runId) {
    const r = this.runs.get(runId);
    if (!r) return;
    if (r.timer) clearTimeout(r.timer);
    if (!r.closed) {
      r.closed = true;
      r.writer.close().catch(() => {});
    }
    this.runs.delete(runId);
  }

  async fetch(req) {
    const url = new URL(req.url);
    if (url.hostname !== "hub.internal") this.host = url.hostname;
    if (url.pathname === "/agent") return this.acceptAgent(req);
    if (url.pathname === "/agent/progress") return this.agentProgress(req);
    const am = url.pathname.match(/^\/a\/([A-Za-z0-9-]{8,64})$/);
    if (am) return this.serveArtifact(am[1], url.searchParams.has("download"));
    try {
      return await this.api(req, url);
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 500);
    }
  }

  acceptAgent(req) {
    if ((req.headers.get("upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected a WebSocket", { status: 426 });
    if (!this.env.AGENT_SECRET || !safeEqual(req.headers.get("x-agent-key") || "", this.env.AGENT_SECRET)) return new Response("Forbidden", { status: 403 });
    const id = String(req.headers.get("x-agent-id") || "").slice(0, 80);
    const now = Date.now();
    const current = this.ctx.getWebSockets("agent");
    for (const old of current) {
      const info = this.agentInfo(old);
      let last = info.since || 0;
      try {
        const t = this.ctx.getWebSocketAutoResponseTimestamp(old);
        if (t) last = Math.max(last, t.getTime());
      } catch {}
      if (now - last < 70000 && info.id && id && info.id !== id) {
        const busy = new WebSocketPair();
        busy[1].accept();
        busy[1].close(4002, "busy");
        return new Response(null, { status: 101, webSocket: busy[0] });
      }
    }
    for (const old of current) {
      try {
        old.close(4000, "replaced");
      } catch {}
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1], ["agent"]);
    pair[1].serializeAttachment({ since: now, id });
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string") return;
    let m;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    if (m.type === "part") {
      const p = this.parts.get(m.key) || { n: m.n, got: 0, d: [] };
      if (p.d[m.i] === undefined) p.got++;
      p.d[m.i] = m.d;
      this.parts.set(m.key, p);
      if (p.got < p.n) return;
      this.parts.delete(m.key);
      try {
        m = JSON.parse(p.d.join(""));
      } catch {
        return;
      }
    }
    if (m.type === "hello") return this.onHello(ws, m);
    if (m.type === "done") return this.completeRun(m);
    if (m.type === "update_ack") return this.updateAck(m);
    if (m.type === "limits") return this.setLimits(m.limits);
    if (m.type === "credits") return this.setCredits(m.credits);
    if (m.type === "sessions") return this.saveSessions(m.sessions);
    if (m.type === "transcript") return this.gotTranscript(m);
    if (m.type === "computer") {
      ws.serializeAttachment({ ...this.agentInfo(ws), computer: cleanComputer(m.values) });
      return this.gotTranscript(m);
    }
    const r = this.runs.get(m.runId);
    if (!r) return;
    r.heard = true;
    this.armRun(m.runId, 100000, `Lost the connection before the reply finished. Check that ${commandName(this.env)} is still running.`);
    if (m.type === "delta") {
      r.text += m.text || "";
      this.part(r, "text").text += m.text || "";
      this.push(m.runId, { type: "delta", text: m.text || "" });
    } else if (m.type === "tool") {
      r.tools.push({ id: m.id, name: m.name, label: m.label, done: false });
      r.parts.push({ type: "tool", id: m.id });
      this.push(m.runId, { type: "tool", id: m.id, name: m.name, label: m.label });
    } else if (m.type === "tool_done") {
      const t = r.tools.find(x => x.id === m.id);
      if (t) {
        t.done = true;
        t.error = !!m.error;
      }
      this.push(m.runId, { type: "tool_done", id: m.id, error: !!m.error });
    } else if (m.type === "thinking") {
      r.thinking += m.text || "";
      this.part(r, "think").text += m.text || "";
      this.push(m.runId, { type: "thinking", text: m.text || "" });
    } else if (m.type === "thinking_done") {
      // the agent counts thinking time across the whole reply; each stretch of thinking gets its own share
      const ms = Number(m.ms) || 0;
      this.part(r, "think").ms = Math.max(0, ms - (r.thinkingMs || 0));
      r.thinkingMs = ms;
      this.push(m.runId, { type: "thinking_done", ms: r.thinkingMs });
    } else if (m.type === "status") {
      r.status = m.text;
      this.push(m.runId, { type: "status", text: m.text });
    } else if (m.type === "beat") {
      this.push(m.runId, { type: "ping" });
    }
  }

  async onHello(ws, m) {
    const caps = (Array.isArray(m.caps) ? m.caps : []).filter(c => typeof c === "string").slice(0, 10).map(c => c.slice(0, 20));
    ws.serializeAttachment({ id: this.agentInfo(ws).id || "", since: Date.now(), version: String(m.agent || "").slice(0, 32), caps, computer: cleanComputer(m.computer), warning: m.warning ? String(m.warning).slice(0, 40) : "" });
    await this.ctx.storage.delete("lastSeen");
    await this.giveAnswers(ws, m.agent);
    const run = await this.ctx.storage.get("update");
    // An update that looked stuck or failed is still a success if the new version turns up within the hour.
    if (run && (run.kind || "update") === "update" && (run.state === "running" || (run.state === "error" && Date.now() - (run.finishedAt || 0) < 3600000)) && compareVersions(m.agent, run.to) >= 0) await this.finishUpdate(run);
    const tok = await this.ctx.storage.get("token");
    if (tok && tok.exp > (Number(m.tokenExp) || 0)) {
      try {
        ws.send(JSON.stringify({ type: "token", token: tok.token, exp: tok.exp }));
      } catch {}
    }
    const active = new Set(Array.isArray(m.active) ? m.active : []);
    for (const c of this.rows("SELECT id, running FROM chats WHERE running IS NOT NULL")) {
      if (!active.has(c.running)) await this.completeRun({ runId: c.running, chatId: c.id, text: (this.runs.get(c.running) || {}).text || "", error: `${siteName(this.env)} restarted before the reply finished.` });
    }
  }

  async webSocketClose(ws) {
    try {
      ws.close(1000, "bye");
    } catch {}
    await this.agentGone(ws);
  }

  async webSocketError(ws) {
    await this.agentGone(ws);
  }

  async agentGone(ws) {
    if (this.ctx.getWebSockets("agent").some(w => w !== ws)) return;
    await this.ctx.storage.put("lastSeen", Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 90000);
  }

  async alarm() {
    if (this.agent()) return;
    for (const c of this.rows("SELECT id, running FROM chats WHERE running IS NOT NULL")) {
      await this.completeRun({ runId: c.running, chatId: c.id, text: (this.runs.get(c.running) || {}).text || "", error: `${siteName(this.env)} went offline before the reply finished.` });
    }
  }

  async api(req, url) {
    const p = url.pathname;
    const method = req.method;
    if (p === "/api/state" && method === "GET") return json(await this.state(req));
    if (p === "/api/limits" && method === "GET") return json(await this.limitsView());
    if (p === "/api/credits" && method === "GET") return json((await this.ctx.storage.get("credits")) || null);
    if (p === "/api/limits/refresh" && method === "POST") return this.askLimits();
    if (p === "/api/prefs" && method === "POST") return this.setPrefs(req);
    if (p === "/api/computer" && method === "POST") return this.setComputer(req);
    if (p === "/api/import" && method === "POST") return this.importChats(req);
    if (p === "/api/admin/settings" && method === "POST") return this.startSettings(req);
    if (p === "/api/admin/move" && method === "POST") return this.startMove(req);
    if (p === "/api/admin/delete" && method === "POST") return this.startDelete(req);
    if (p === "/api/admin/cancel" && method === "POST") return this.cancelJob();
    if (p === "/api/update" && method === "GET") return json(await this.updateInfo());
    if (p === "/api/update/check" && method === "POST") return json(await this.updateInfo(true));
    if (p === "/api/update/start" && method === "POST") return this.startUpdate(req);
    if (p === "/api/update/dismiss" && method === "POST") {
      const run = await this.ctx.storage.get("update");
      if (run && run.state !== "running") await this.ctx.storage.delete("update");
      return json(await this.updateInfo());
    }
    if (p === "/api/chats" && method === "GET") return json({ chats: this.chatList() });
    const cm = p.match(/^\/api\/chats\/([A-Za-z0-9-]{8,64})$/);
    if (cm && method === "GET") return this.getChat(cm[1]);
    if (cm && method === "PATCH") {
      const b = await req.json().catch(() => ({}));
      const title = String(b.title || "").trim().slice(0, 120);
      if (!title) return json({ error: "Give the chat a name." }, 400);
      if (!this.one("SELECT id FROM chats WHERE id = ?", cm[1])) return json({ error: "Open this chat once, and then you can rename it." }, 409);
      this.sql.exec("UPDATE chats SET title = ? WHERE id = ?", title, cm[1]);
      return json({ ok: true });
    }
    if (cm && method === "DELETE") {
      const chat = this.one("SELECT running, session_id FROM chats WHERE id = ?", cm[1]);
      if (chat && chat.running) this.stopRun(chat.running);
      this.sql.exec("DELETE FROM messages WHERE chat_id = ?", cm[1]);
      this.sql.exec("DELETE FROM artifacts WHERE chat_id = ?", cm[1]);
      this.sql.exec("DELETE FROM chats WHERE id = ?", cm[1]);
      // Claude Code still has the conversation, and would list it again. It is only hidden here; nothing on the computer is deleted.
      for (const id of [cm[1], chat && chat.session_id]) if (typeof id === "string" && SESSION_ID.test(id)) this.sql.exec("INSERT OR IGNORE INTO hidden_sessions (id) VALUES (?)", id.toLowerCase());
      return json({ ok: true });
    }
    if (p === "/api/send" && method === "POST") return this.send(req);
    if (p === "/api/stop" && method === "POST") {
      const b = await req.json().catch(() => ({}));
      const chat = this.one("SELECT running FROM chats WHERE id = ?", String(b.chatId || ""));
      if (chat && chat.running) this.stopRun(chat.running);
      return json({ ok: true });
    }
    return json({ error: "Not found" }, 404);
  }

  async state(req) {
    const ws = this.agent();
    const info = ws ? this.agentInfo(ws) : null;
    return {
      email: req.headers.get("x-chatgql-user") || "",
      version: appVersion(this.env),
      agent: info ? { online: true, since: info.since || null, warning: info.warning || "", version: info.version || "", modes: (info.caps || []).includes("modes"), history: (info.caps || []).includes("history"), credits: info.computer ? info.computer.credits : (info.caps || []).includes("credits"), computer: info.computer || null } : { online: false, lastSeen: (await this.ctx.storage.get("lastSeen")) || null },
      limits: await this.limitsView(),
      prefs: await this.prefs(),
      credits: (await this.ctx.storage.get("credits")) || null,
      update: await this.updateInfo()
    };
  }

  // ---- plan usage: the percentages Claude Code reads from Anthropic's response headers for the signed-in plan

  async setLimits(raw) {
    if (!raw || typeof raw !== "object" || !raw.windows || typeof raw.windows !== "object") return;
    const windows = {};
    for (const key of LIMIT_WINDOWS) {
      const w = raw.windows[key];
      if (!w || !Number.isFinite(w.pct) || !Number.isFinite(w.resetsAt)) continue;
      windows[key] = { pct: Math.max(0, Math.min(999, Math.round(w.pct))), resetsAt: Math.round(w.resetsAt) };
    }
    if (!Object.keys(windows).length) return;
    const status = LIMIT_STATUS.includes(raw.status) ? raw.status : "allowed";
    const rec = { at: Date.now(), windows, status };
    // the window that is limiting right now, and when it resets
    if (Number.isFinite(raw.resetsAt)) rec.resetsAt = Math.round(raw.resetsAt);
    if (typeof raw.rateLimitType === "string" && /^[a-z0-9_]{1,40}$/.test(raw.rateLimitType)) rec.limitType = raw.rateLimitType;
    // Usage credits ("extra usage" on claude.ai), as far as Claude Code reports them. An older program reports none of this.
    const credits = {};
    if (LIMIT_STATUS.includes(raw.overageStatus)) credits.status = raw.overageStatus;
    if (typeof raw.overageDisabledReason === "string" && /^[a-z0-9_]{1,40}$/.test(raw.overageDisabledReason)) credits.reason = raw.overageDisabledReason;
    if (Number.isFinite(raw.overageResetsAt)) credits.resetsAt = Math.round(raw.overageResetsAt);
    if (raw.isUsingOverage === true || raw.overageInUse === true) credits.using = true;
    else if (raw.isUsingOverage === false || raw.overageInUse === false) credits.using = false;
    if (typeof raw.overageEnabled === "boolean") credits.enabled = raw.overageEnabled;
    if (Object.keys(credits).length) rec.credits = credits;
    await this.ctx.storage.put("limits", rec);
  }

  async limitsView() {
    const l = await this.ctx.storage.get("limits");
    if (!l) return null;
    const now = Math.floor(Date.now() / 1000);
    const windows = {};
    // A window that has reset since the reading no longer says how much is used: the page shows it as reset until the next reply.
    for (const [k, w] of Object.entries(l.windows)) windows[k] = { ...w, reset: w.resetsAt <= now };
    const c = l.credits || null;
    // Over a plan limit: Claude said "rejected", and the window that did it hasn't reset since. Without the limiting window's
    // reset time (an older program), one of the windows shown has to be full and not reset.
    const over = l.status === "rejected" && (Number.isFinite(l.resetsAt) ? l.resetsAt > now : Object.values(windows).some(w => !w.reset && w.pct >= 100));
    // Over a limit with usage credits on isn't a stop: replies go on, paid from the credits.
    const onCredits = !!c && (c.using === true || c.status === "allowed" || c.status === "allowed_warning");
    return { at: l.at, status: l.status, windows, over, limited: over && !onCredits, resetsAt: l.resetsAt || null, credits: this.creditsView(c, over, now) };
  }

  // What the page says about usage credits. Null when Claude Code hasn't said anything about them.
  creditsView(c, over, now) {
    if (!c) return null;
    const resetsAt = c.resetsAt && c.resetsAt > now ? c.resetsAt : null;
    let state;
    if (c.reason === "out_of_credits") state = "out";
    else if (c.status === "rejected") state = "off";
    else if (c.using || (over && c.status)) state = c.status === "allowed_warning" ? "near" : "using";
    else if (c.status || c.enabled) state = "on";
    else if (c.enabled === false) state = "off";
    else return null;
    return { state, reason: c.reason || "", resetsAt };
  }

  // The usage credit balance, read on the computer from Claude's account (when that's turned on there). Amounts are in the
  // currency's smallest unit, as Anthropic gives them. A failed reading keeps the last good numbers and says why.
  async setCredits(raw) {
    if (!raw || typeof raw !== "object") return;
    const num = v => (typeof v === "number" && Number.isFinite(v) && v >= 0 && v < 1e13 ? Math.round(v) : null);
    const cur = v => (typeof v === "string" && /^[A-Za-z]{3}$/.test(v) ? v.toUpperCase() : "");
    const out = { at: Date.now() };
    if (raw.extra && typeof raw.extra === "object") out.extra = { enabled: raw.extra.enabled === true, limit: num(raw.extra.limit), used: num(raw.extra.used) };
    if (raw.balance && typeof raw.balance === "object" && num(raw.balance.amount) !== null) {
      const currency = cur(raw.balance.currency) || "USD";
      const promos = (Array.isArray(raw.balance.promos) ? raw.balance.promos.slice(0, 10) : []).filter(x => x && num(x.amount));
      out.balance = { amount: num(raw.balance.amount), currency, promos: promos.map(x => ({ amount: num(x.amount), currency: cur(x.currency) || currency, expires: num(x.expires), name: typeof x.name === "string" ? x.name.replace(/\s+/g, " ").trim().slice(0, 60) : "" })) };
    }
    if (!out.extra && !out.balance) {
      const prev = await this.ctx.storage.get("credits");
      const error = ["expired", "signin", "unavailable"].includes(raw.error) ? raw.error : "unavailable";
      await this.ctx.storage.put("credits", prev && (prev.extra || prev.balance) ? { ...prev, error, errorAt: out.at } : { at: out.at, error });
      return;
    }
    await this.ctx.storage.put("credits", out);
  }

  // This computer's settings: starting at login and reading the credit balance. They live on the computer, so the change is
  // sent there and the page gets back what it is now.
  async setComputer(req) {
    const b = await req.json().catch(() => null);
    const values = {};
    for (const k of COMPUTER_KEYS) if (b && typeof b[k] === "boolean") values[k] = b[k];
    if (!Object.keys(values).length) return json({ error: "Nothing was changed." }, 400);
    const ws = this.agent();
    if (!ws) return json({ error: `${siteName(this.env)} is offline. Start ${commandName(this.env)} on your computer first.`, code: "offline" }, 503);
    if (!(this.agentInfo(ws).caps || []).includes("computer")) return json({ error: `The ${commandName(this.env)} program on your computer is too old for this. Update it first.`, code: "agent_old" }, 409);
    const r = await this.askAgent({ type: "computer", values }, 10000, "computer");
    if (!r) return json({ error: "Your computer didn't answer in time. Try again in a moment.", code: "slow" }, 504);
    return json({ computer: cleanComputer(r.values) });
  }

  // An update's answers to its new questions are kept here until the version that asked them is running on the computer.
  async giveAnswers(ws, version) {
    const a = await this.ctx.storage.get("answers");
    if (!a || !(this.agentInfo(ws).caps || []).includes("computer") || compareVersions(version, a.version) < 0) return;
    await this.ctx.storage.delete("answers");
    try {
      this.sendAgent(ws, { type: "computer", values: a.values });
    } catch {}
  }

  async prefs() {
    return { useCredits: true, ...((await this.ctx.storage.get("prefs")) || {}) };
  }

  async setPrefs(req) {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return json({ error: "That couldn't be read." }, 400);
    const p = await this.prefs();
    if (typeof b.useCredits === "boolean") p.useCredits = b.useCredits;
    await this.ctx.storage.put("prefs", p);
    return json(p);
  }

  // With usage credits turned off here, nothing new is sent that would be paid from them: not while a plan limit is reached,
  // and not to a model that only runs on them. A reply already running can still go past a limit; that's Claude's call.
  async creditsBlock(model) {
    if ((await this.prefs()).useCredits) return null;
    if (model === "claude-fable-5-1") return { code: "credits_off", message: "Fable 5.1 runs on usage credits, and they're turned off for this site. Pick another model, or turn usage credits on in Plan usage." };
    const l = await this.limitsView();
    if (l && l.over) return { code: "credits_off", resetsAt: l.resetsAt, message: "You've reached your plan's limit, and usage credits are turned off for this site, so nothing more is sent until it resets. To keep going, turn usage credits on in Plan usage." };
    return null;
  }

  async askLimits() {
    const ws = this.agent();
    if (!ws) return json({ error: `${siteName(this.env)} is offline, so it can't read your plan usage right now.`, code: "offline" }, 503);
    const last = (await this.ctx.storage.get("limitsAsk")) || 0;
    if (Date.now() - last < 20000) return json({ ok: true, wait: true });
    await this.ctx.storage.put("limitsAsk", Date.now());
    try {
      this.sendAgent(ws, { type: "limits_refresh" });
    } catch {
      return json({ error: "Couldn't reach your computer. Try again in a moment.", code: "offline" }, 503);
    }
    return json({ ok: true });
  }

  // ---- updates and changes to the site itself. They all run on the owner's computer, which holds the Cloudflare sign-in;
  // the site keeps the checklist so the page can follow along from any device and through every restart.

  updateSource() {
    const repo = validRepo(this.env.UPDATE_REPO) ? this.env.UPDATE_REPO : DEFAULT_REPO;
    const ref = validRef(this.env.UPDATE_REF) ? this.env.UPDATE_REF : "main";
    const raw = String(this.env.UPDATE_RAW || "https://raw.githubusercontent.com").replace(/\/+$/, "");
    return { repo, ref, raw, label: `${repo}@${ref}` };
  }

  async checkLatest() {
    if (this.checking) return this.checking;
    this.checking = (async () => {
      const src = this.updateSource();
      const prev = this.latest || (await this.ctx.storage.get("latest")) || null;
      const entry = { at: Date.now(), source: src.label, release: prev && prev.source === src.label ? prev.release : null, error: "" };
      try {
        // raw.githubusercontent.com serves each file from a cache that can be five minutes behind; a new query string gets past it
        const r = await fetch(`${src.raw}/${src.repo}/${src.ref}/manifest.json?cb=${Date.now().toString(36)}`, { headers: { "user-agent": "ClaudeConnect-site", accept: "application/json", "cache-control": "no-cache" }, signal: AbortSignal.timeout(6000) });
        if (!r.ok) throw new Error(r.status === 404 ? "No release has been published at that address yet." : `GitHub answered ${r.status}.`);
        const text = await r.text();
        if (text.length > 100000) throw new Error("The release information was too large.");
        const release = cleanManifest(JSON.parse(text));
        if (!release) throw new Error("The release information couldn't be read.");
        entry.release = release;
      } catch (e) {
        entry.error = String((e && e.message) || e).slice(0, 160);
      }
      this.latest = entry;
      await this.ctx.storage.put("latest", entry);
      return entry;
    })().finally(() => {
      this.checking = null;
    });
    return this.checking;
  }

  async updateRun() {
    let run = await this.ctx.storage.get("update");
    if (run && run.state === "running") {
      const now = Date.now();
      const unanswered = !run.acked && now - run.startedAt > (Number(this.env.UPDATE_ACK_MS) || ACK_WITHIN);
      if (unanswered || now - run.updatedAt > (Number(this.env.UPDATE_QUIET_MS) || QUIET_LIMIT)) {
        run = { ...run, state: "error", finishedAt: now, message: unanswered ? `${siteName(this.env)} on your computer didn't pick up the request. Make sure ${commandName(this.env)} is running, then try again.` : `It stopped reporting progress. Check your computer, or run ${commandName(this.env)} update there.` };
        await this.ctx.storage.put("update", run);
      }
    }
    return run || null;
  }

  // Why a job can't start right now, or null. `need` is what the agent on the computer has to be able to do.
  updateBlock(run, need = "update") {
    const ws = this.agent();
    if (run && run.state === "running") return { code: "running", message: "Something is already in progress." };
    if (!ws) return { code: "offline", message: `${siteName(this.env)} is offline. Start ${commandName(this.env)} on your computer first.` };
    if (!(this.agentInfo(ws).caps || []).includes(need)) return { code: "agent_old", message: `The ${commandName(this.env)} program on your computer is too old for this. Run ${commandName(this.env)} update there once, and it can be done from this page after that.` };
    if (this.one("SELECT 1 AS x FROM chats WHERE running IS NOT NULL")) return { code: "busy", message: "A reply is still being written. Wait for it to finish, or stop it, then try again." };
    return null;
  }

  async updateInfo(force) {
    const src = this.updateSource();
    let c = this.latest || (await this.ctx.storage.get("latest")) || null;
    if (c && c.source !== src.label) c = null;
    const age = c ? Date.now() - c.at : Infinity;
    if (force || !c || age > envNum(this.env.UPDATE_WAIT_MS, CHECK_WAIT)) c = await this.checkLatest();
    else if (age > (c.error ? envNum(this.env.UPDATE_RETRY_MS, CHECK_RETRY) : envNum(this.env.UPDATE_CHECK_MS, CHECK_EVERY))) this.checkLatest().catch(() => {});
    this.latest = c;
    const current = appVersion(this.env);
    const latest = c && c.release ? c.release : null;
    const run = await this.updateRun();
    const log = (await this.ctx.storage.get("updateLog")) || [];
    // The installed version's patch notes: from the log if it was installed by an update, else from the release if that is the one running.
    const logged = log.find(e => e.version === current);
    const mine = logged || (latest && latest.version === current ? latest : null);
    return {
      current,
      latest: latest ? latest.version : null,
      available: !!latest && isNewer(latest.version, current),
      notes: latest ? latest.notes : [],
      // what the new version asks: questions added after the version this computer runs
      questions: latest ? (latest.questions || []).filter(q => compareVersions(q.since, (this.agent() && this.agentInfo(this.agent()).version) || current) > 0 && compareVersions(q.since, latest.version) <= 0) : [],
      released: latest ? latest.released : "",
      whatsNew: mine && mine.notes.length ? { version: mine.version, released: mine.released || "", notes: mine.notes, updated: !!logged } : null,
      history: log.filter(e => compareVersions(e.version, current) < 0).slice(0, UPDATE_LOG_KEEP).map(({ version, released, notes }) => ({ version, released: released || "", notes })),
      source: src.label,
      checkedAt: c ? c.at : null,
      error: c && c.error ? c.error : "",
      address: this.workerName() || null,
      run,
      // `blocked` is about updating; `blockedAdmin` about changing, moving or deleting the site
      blocked: this.updateBlock(run, "update"),
      blockedAdmin: this.updateBlock(run, "admin")
    };
  }

  // Starts a job: records the checklist, then hands the work to the computer.
  async beginJob(kind, req, { to = null, message, need }) {
    const info = await this.updateInfo();
    const block = this.updateBlock(info.run, need);
    if (block) return json({ error: block.message, code: block.code }, 409);
    const ws = this.agent();
    const now = Date.now();
    const plan = PLANS[kind].map(([key, label]) => ({ key, label }));
    const run = { id: crypto.randomUUID(), kind, plan, from: info.current, to, state: "running", acked: false, step: plan[0].key, steps: {}, message: "", info: null, cancel: false, startedAt: now, updatedAt: now, finishedAt: null, by: req.headers.get("x-chatgql-user") || "" };
    // what the update brings, kept with the run so the panel can show it while it runs and after
    if (kind === "update") Object.assign(run, { notes: info.notes, released: info.released });
    await this.ctx.storage.put("update", run);
    try {
      this.sendAgent(ws, { ...message, id: run.id });
    } catch {
      await this.ctx.storage.delete("update");
      return json({ error: `${siteName(this.env)} on your computer couldn't be reached. Try again in a moment.`, code: "offline" }, 503);
    }
    return json(await this.updateInfo());
  }

  async startUpdate(req) {
    const b = await req.json().catch(() => ({}));
    const info = await this.updateInfo();
    if (!info.available) return json({ error: "You're already up to date.", code: "current" }, 409);
    if (String(b.to || "") !== info.latest) return json({ error: "A different version came out. Look at what's new, then update.", code: "changed" }, 409);
    // answers to what this update asks: only its own questions, only true or false
    const values = {};
    for (const q of info.questions) if (b.answers && typeof b.answers[q.key] === "boolean") values[q.key] = b.answers[q.key];
    if (Object.keys(values).length) await this.ctx.storage.put("answers", { version: info.latest, values });
    return this.beginJob("update", req, { to: info.latest, need: "update", message: { type: "update", to: info.latest } });
  }

  // The part of the workers.dev address that is this site's own name.
  workerName() {
    return String(this.env.WORKER_NAME || (this.host || "").split(".")[0] || "");
  }

  // Name, Fable, logo and tab icon. Same site, same chats.
  async startSettings(req) {
    const b = await req.json().catch(() => null);
    if (!b || typeof b !== "object") return json({ error: "That couldn't be read." }, 400);
    const change = {};
    if ("displayName" in b) {
      const n = cleanSiteName(b.displayName);
      if (!n) return json({ error: "Use up to 40 letters, numbers, spaces, dots, dashes or underscores, starting with a letter or number." }, 400);
      if (n !== siteName(this.env)) change.displayName = n;
    }
    if ("fable" in b && typeof b.fable === "boolean" && b.fable !== (this.env.SHOW_FABLE === "1")) change.fable = b.fable;
    for (const [key, label] of [["logo", "The logo"], ["favicon", "The tab icon"]]) {
      if (!(key in b)) continue;
      if (b[key] === null) {
        change[key] = null;
        continue;
      }
      const img = checkImage(b[key] && b[key].b64);
      if (img.error) return json({ error: `${label}: ${img.error}.` }, 400);
      change[key] = { type: img.type, b64: img.b64 };
    }
    if (!Object.keys(change).length) return json({ error: "Nothing was changed.", code: "nochange" }, 400);
    return this.beginJob("settings", req, { need: "admin", message: { type: "admin", op: "settings", payload: change } });
  }

  // A new address is a new Worker: the old site stays up until the new one is ready and claimed, then it is deleted.
  async startMove(req) {
    const b = await req.json().catch(() => null);
    const address = cleanAddress(b && b.address);
    if (!address) return json({ error: "Use 1 to 63 lowercase letters, numbers or dashes, starting and ending with a letter or number." }, 400);
    if (address === this.workerName()) return json({ error: "That's the address it already has.", code: "nochange" }, 400);
    return this.beginJob("move", req, { need: "admin", message: { type: "admin", op: "move", payload: { address } } });
  }

  async startDelete(req) {
    const b = await req.json().catch(() => null);
    if (!b || String(b.confirm || "") !== siteName(this.env)) return json({ error: "Type the site's name to confirm.", code: "confirm" }, 400);
    return this.beginJob("delete", req, { need: "admin", message: { type: "admin", op: "delete", payload: {} } });
  }

  async cancelJob() {
    const run = await this.ctx.storage.get("update");
    if (!run || run.state !== "running" || run.kind !== "move") return json({ error: "There's nothing to cancel." }, 409);
    await this.ctx.storage.put("update", { ...run, cancel: true });
    return json(await this.updateInfo());
  }

  async finishUpdate(run) {
    const keys = (run.plan || PLANS.update.map(([key]) => ({ key }))).map(x => x.key);
    const steps = {};
    for (const k of keys) steps[k] = "done";
    const now = Date.now();
    const last = keys[keys.length - 1];
    await this.ctx.storage.put("update", { ...run, state: "done", acked: true, steps, step: last, message: "", updatedAt: now, finishedAt: now });
    if ((run.kind || "update") === "update") await this.logUpdate(run);
  }

  // Remember what an update brought. The page that watched it is about to move to the new version, and the Updates panel
  // there shows these notes, and the ones from earlier updates.
  async logUpdate(run) {
    if (!parseVersion(run.to)) return;
    const seen = this.latest || (await this.ctx.storage.get("latest")) || null;
    const rel = seen && seen.release && seen.release.version === run.to ? seen.release : null;
    const notes = Array.isArray(run.notes) && run.notes.length ? run.notes : rel ? rel.notes : [];
    const released = run.released || (rel ? rel.released : "");
    const log = ((await this.ctx.storage.get("updateLog")) || []).filter(e => e.version !== run.to);
    log.unshift({ version: String(run.to), released, notes, at: Date.now() });
    await this.ctx.storage.put("updateLog", log.slice(0, UPDATE_LOG_KEEP + 2));
  }

  async updateAck(m) {
    const run = await this.ctx.storage.get("update");
    if (!run || run.state !== "running" || run.id !== m.id) return;
    const now = Date.now();
    if (m.ok === false) await this.ctx.storage.put("update", { ...run, state: "error", message: String(m.error || "Your computer couldn't start that.").slice(0, 300), updatedAt: now, finishedAt: now });
    else await this.ctx.storage.put("update", { ...run, acked: true, updatedAt: now });
  }

  async agentProgress(req) {
    if (req.method !== "POST") return json({ error: "Expected POST" }, 405);
    if (!this.env.AGENT_SECRET || !safeEqual(req.headers.get("x-agent-key") || "", this.env.AGENT_SECRET)) return json({ error: "Forbidden" }, 403);
    let b = null;
    try {
      b = JSON.parse(await req.text());
    } catch {}
    if (!b || typeof b !== "object" || Array.isArray(b)) return json({ error: "Bad request" }, 400);
    const run = await this.ctx.storage.get("update");
    if (!run || run.id !== b.id) return json({ error: "No such update" }, 404);
    if (run.state !== "running") return json({ ok: true, cancel: !!run.cancel });
    const now = Date.now();
    const keys = (run.plan || PLANS.update.map(([key]) => ({ key }))).map(x => x.key);
    const next = { ...run, acked: true, updatedAt: now, steps: { ...run.steps } };
    const at = keys.indexOf(b.step);
    if (at >= 0) {
      for (let i = 0; i < at; i++) next.steps[keys[i]] = "done";
      next.step = b.step;
      next.steps[b.step] = b.status === "done" ? "done" : b.status === "error" ? "error" : "active";
    }
    const info = cleanJobInfo(b.info);
    if (info) next.info = info;
    if (b.status === "error") {
      next.state = "error";
      next.finishedAt = now;
      next.message = String(b.message || "It didn't finish.").slice(0, 400);
    } else if (at === keys.length - 1 && b.status === "done") {
      await this.finishUpdate(next);
      return json({ ok: true });
    }
    await this.ctx.storage.put("update", next);
    return json({ ok: true, cancel: !!next.cancel });
  }

  async getChat(id) {
    const cols = "id, title, model, effort, running, created, updated, folder, origin, started, session_id, synced_turns, synced_at";
    let chat = this.one(`SELECT ${cols} FROM chats WHERE id = ?`, id);
    if (!chat) {
      const known = SESSION_ID.test(id) ? this.one("SELECT id, title, folder, updated FROM computer_sessions WHERE id = ? AND id NOT IN (SELECT id FROM hidden_sessions)", id.toLowerCase()) : null;
      if (!known) return json({ error: "That chat doesn't exist anymore." }, 404);
      const r = await this.importSession(known);
      if (r.error) return json({ error: r.error, code: r.code }, r.status);
      chat = this.one(`SELECT ${cols} FROM chats WHERE id = ?`, id);
    } else if (!chat.running) {
      await this.syncChat(chat);
      chat = this.one(`SELECT ${cols} FROM chats WHERE id = ?`, id);
    }
    delete chat.session_id;
    delete chat.started;
    delete chat.synced_turns;
    delete chat.synced_at;
    const messages = this.rows("SELECT id, role, content, meta, created FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC", id).map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : {} }));
    const lastSent = [...messages].reverse().find(x => x.role === "user");
    chat.mode = (lastSent && lastSent.meta.mode) || "code";
    chat.perm = (lastSent && lastSent.meta.perm) || "auto";
    let partial = null;
    if (chat.running) {
      const r = this.runs.get(chat.running);
      partial = r ? { text: r.text, thinking: r.thinking, thinkingMs: r.thinkingMs || 0, tools: r.tools, parts: r.parts, status: r.status || "" } : { text: "", thinking: "", thinkingMs: 0, tools: [], parts: [], status: "" };
    }
    return json({ chat, messages, partial });
  }

  // ---- Claude Code's own chats on the computer, shown next to the ones started here

  chatList() {
    const own = this.rows("SELECT id, title, updated, running, folder, origin FROM chats ORDER BY updated DESC LIMIT ?", CHAT_LIST_MAX);
    const theirs = this.rows("SELECT id, title, updated, folder FROM computer_sessions WHERE id NOT IN (SELECT session_id FROM chats WHERE session_id IS NOT NULL) AND id NOT IN (SELECT id FROM chats) AND id NOT IN (SELECT id FROM hidden_sessions) ORDER BY updated DESC LIMIT ?", CHAT_LIST_MAX).map(r => ({ ...r, running: null, computer: 1 }));
    return [...own, ...theirs].sort((a, b) => (b.updated || 0) - (a.updated || 0)).slice(0, CHAT_LIST_MAX);
  }

  saveSessions(list) {
    if (!Array.isArray(list)) return;
    const rows = [];
    for (const x of list.slice(0, CHAT_LIST_MAX)) {
      if (!x || typeof x !== "object" || typeof x.id !== "string" || !SESSION_ID.test(x.id)) continue;
      const updated = Math.round(Number(x.updated));
      if (!Number.isFinite(updated) || updated < 0) continue;
      rows.push([x.id.toLowerCase(), String(typeof x.title === "string" ? x.title : "").replace(/\s+/g, " ").trim().slice(0, 120) || "Chat", String(typeof x.folder === "string" ? x.folder : "").replace(/\s+/g, " ").trim().slice(0, 60), updated]);
    }
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM computer_sessions");
      for (const r of rows) this.sql.exec("INSERT OR REPLACE INTO computer_sessions (id, title, folder, updated) VALUES (?, ?, ?, ?)", ...r);
    });
  }

  historyOn() {
    const ws = this.agent();
    return !!ws && (this.agentInfo(ws).caps || []).includes("history");
  }

  // Ask the computer a question and wait for its answer. Null when it can't answer (offline, an older program, too slow).
  askAgent(msg, ms = 12000, need = "history") {
    const w = this.agent();
    if (!w || !(this.agentInfo(w).caps || []).includes(need)) return Promise.resolve(null);
    const ws = this.agent();
    const req = crypto.randomUUID();
    return new Promise(resolve => {
      const timer = setTimeout(() => {
        this.asks.delete(req);
        resolve(null);
      }, envNum(this.env.ASK_TIMEOUT_MS, ms));
      this.asks.set(req, { resolve, timer });
      try {
        this.sendAgent(ws, { ...msg, req });
      } catch {
        clearTimeout(timer);
        this.asks.delete(req);
        resolve(null);
      }
    });
  }

  gotTranscript(m) {
    const a = this.asks.get(String(m.req || ""));
    if (!a) return;
    clearTimeout(a.timer);
    this.asks.delete(m.req);
    a.resolve(m);
  }

  // What the computer sent for a conversation, cleaned up. Nothing from it is trusted: it ends up as chat messages.
  cleanTranscript(sessionId, list) {
    const out = [];
    const str = (v, n) => (typeof v === "string" ? v.slice(0, n) : "");
    const model = v => (typeof v === "string" && MODELS[v] ? v : null);
    for (const x of Array.isArray(list) ? list.slice(0, 700) : []) {
      if (!x || typeof x !== "object" || (x.role !== "user" && x.role !== "assistant") || typeof x.content !== "string") continue;
      if (typeof x.id !== "string" || !new RegExp(`^i-${sessionId}-\\d{1,6}-[ua]$`).test(x.id)) continue;
      const created = Math.round(Number(x.created));
      if (!Number.isFinite(created) || created < 0) continue;
      const mt = x.meta && typeof x.meta === "object" ? x.meta : {};
      const meta = { model: model(mt.model), effort: null, mode: "code", perm: PERMS.includes(mt.perm) ? mt.perm : "auto", imported: true };
      if (x.role === "user") {
        meta.files = (Array.isArray(mt.files) ? mt.files.slice(0, 10) : []).map(f => ({ name: str(f && f.name, 120) || "file", size: Math.max(0, Math.round(Number(f && f.size)) || 0), type: str(f && f.type, 80) }));
      } else {
        Object.assign(meta, {
          context: null,
          tools: (Array.isArray(mt.tools) ? mt.tools.slice(0, 80) : []).filter(t => t && typeof t.id === "string").map(t => ({ id: str(t.id, 80), name: str(t.name, 60), label: str(t.label, 140), done: true, error: !!t.error })),
          error: null,
          denials: 0,
          ms: null,
          thinking: str(mt.thinking, 20000),
          thinkingMs: null,
          artifacts: []
        });
      }
      out.push({ id: x.id, role: x.role, content: str(x.content, 120000), meta, created });
    }
    return out;
  }

  addImported(chatId, messages) {
    for (const m of messages) this.sql.exec("INSERT OR IGNORE INTO messages (id, chat_id, role, content, meta, created) VALUES (?, ?, ?, ?, ?, ?)", m.id, chatId, m.role, m.content, JSON.stringify(m.meta), m.created);
  }

  // ---- chats from claude.ai. claude.ai keeps them on its own servers and has no way for another site to read them, so they
  // come from the data export (Settings → Privacy → Export data on claude.ai): the page reads the export and sends it here in
  // batches. A chat's id is the claude.ai conversation's, so importing the same export again adds only what's new.
  async importChats(req) {
    const raw = await req.text();
    if (raw.length > IMPORT_MAX_BYTES) return json({ error: "That batch is too large." }, 413);
    let b;
    try {
      b = JSON.parse(raw);
    } catch {
      return json({ error: "That couldn't be read." }, 400);
    }
    const list = b && Array.isArray(b.conversations) ? b.conversations.slice(0, 200) : null;
    if (!list) return json({ error: "That couldn't be read." }, 400);
    const str = (v, n) => (typeof v === "string" ? v : "").slice(0, n);
    const time = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Math.round(Number(v)) : d);
    let added = 0;
    let updated = 0;
    let skipped = 0;
    for (const c of list) {
      const id = c && typeof c.id === "string" && SESSION_ID.test(c.id) ? c.id.toLowerCase() : null;
      if (!id || this.one("SELECT id FROM hidden_sessions WHERE id = ?", id)) {
        skipped++;
        continue;
      }
      const have = this.one("SELECT origin, updated FROM chats WHERE id = ?", id);
      // the same id as a chat that didn't come from claude.ai: leave that one alone
      if (have && have.origin !== "claude.ai") {
        skipped++;
        continue;
      }
      const msgs = [];
      let k = 0;
      for (const m of Array.isArray(c.messages) ? c.messages.slice(-IMPORT_MAX_MESSAGES) : []) {
        k++;
        if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
        const files = (Array.isArray(m.files) ? m.files.slice(0, 20) : []).map(f => ({ name: str(f && f.name, 120) || "file", size: Math.max(0, Math.round(Number(f && f.size)) || 0), type: "" }));
        const content = str(m.content, 120000);
        if (!content && !files.length) continue;
        const mid = typeof m.id === "string" && SESSION_ID.test(m.id) ? `w-${m.id.toLowerCase()}` : `w-${id}-${k}`;
        const meta = m.role === "user" ? { files, model: null, effort: null, mode: "claude", perm: "auto", origin: "claude.ai" } : { model: null, effort: null, mode: "claude", perm: "auto", context: null, tools: [], error: null, denials: 0, ms: null, thinking: str(m.thinking, 20000), thinkingMs: null, artifacts: [], origin: "claude.ai" };
        msgs.push({ id: mid, role: m.role, content, meta, created: time(m.created, 0) });
      }
      if (!msgs.length) {
        skipped++;
        continue;
      }
      const first = msgs[0].created || Date.now();
      const last = Math.max(time(c.updated, 0), ...msgs.map(m => m.created));
      for (const m of msgs) if (!m.created) m.created = first;
      const title = str(c.title, 200).replace(/\s+/g, " ").trim().slice(0, 120) || titleFrom(msgs.find(m => m.role === "user")?.content || "", []);
      if (have) {
        const before = this.one("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", id).n;
        this.addImported(id, msgs);
        if (this.one("SELECT COUNT(*) AS n FROM messages WHERE chat_id = ?", id).n > before) {
          this.sql.exec("UPDATE chats SET updated = MAX(updated, ?) WHERE id = ?", last, id);
          updated++;
        } else skipped++;
        continue;
      }
      this.sql.exec("INSERT INTO chats (id, title, model, effort, session_id, started, created, updated, folder, origin) VALUES (?, ?, NULL, NULL, ?, 0, ?, ?, '', 'claude.ai')", id, title, crypto.randomUUID(), time(c.created, first), last);
      this.addImported(id, msgs);
      added++;
    }
    return json({ ok: true, added, updated, skipped });
  }

  // The conversation so far of a chat imported from claude.ai, for the first reply in it to read. The newest part, if it's long.
  importedContext(chatId) {
    const rows = this.rows("SELECT role, content, meta FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC", chatId);
    const parts = [];
    let size = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const r = rows[i];
      let files = [];
      try {
        files = (JSON.parse(r.meta || "{}").files || []).map(f => f.name);
      } catch {}
      const body = (r.content || "") + (files.length ? `\n(attached: ${files.join(", ")})` : "");
      const part = r.role === "user" ? `<user>\n${body}\n</user>` : `<assistant>\n${body}\n</assistant>`;
      if (size + part.length > IMPORT_CONTEXT_CHARS && parts.length) break;
      parts.unshift(part.slice(-IMPORT_CONTEXT_CHARS));
      size += part.length;
    }
    if (!parts.length) return "";
    return `This conversation started on claude.ai and was carried over here. Here it is so far${parts.length < rows.length ? " (the latest part)" : ""}, so you can carry on from it:\n\n<conversation>\n${parts.join("\n")}\n</conversation>\n\nNow the next message:\n\n`;
  }

  // A conversation that so far exists only on the computer becomes a chat here the first time it is opened. Its id is the
  // session's id, so it is the same chat from then on, and sending in it carries on the same session.
  async importSession(s) {
    if (!this.historyOn()) return { error: `${siteName(this.env)} can't reach your computer right now, and this chat is only there. Run ${commandName(this.env)} to bring it back online.`, code: "offline", status: 503 };
    const r = await this.askAgent({ type: "transcript", sessionId: s.id, from: 0 });
    if (!r) return { error: "Your computer didn't answer in time. Try again in a moment.", code: "slow", status: 504 };
    if (!r.ok) return { error: r.error === "missing" ? "That chat isn't on your computer anymore." : "That chat can't be opened from here.", code: "gone", status: 404 };
    const messages = this.cleanTranscript(s.id, r.messages);
    const turns = Math.max(0, Math.round(Number(r.turns)) || 0);
    const last = [...messages].reverse().find(x => x.role === "assistant" && x.meta.model);
    const at = messages.length ? messages[messages.length - 1].created : s.updated;
    this.sql.exec("INSERT OR IGNORE INTO chats (id, title, model, effort, session_id, started, created, updated, synced_turns, synced_at, folder) VALUES (?, ?, ?, NULL, ?, 1, ?, ?, ?, ?, ?)", s.id, s.title || "Chat", last ? last.meta.model : null, s.id, messages.length ? messages[0].created : at, at, turns, Math.round(Number(r.mtime)) || 0, s.folder || "");
    this.addImported(s.id, messages);
    return { ok: true };
  }

  // Bring a chat up to date with Claude Code's record of it: anything added on the computer since (in the terminal, say)
  // is added here. Best effort, and not more than every few seconds per chat.
  async syncChat(chat, ms = 8000) {
    if (!chat.session_id || chat.running || !this.historyOn() || (chat.origin === "claude.ai" && !chat.started)) return;
    if (Date.now() - (this.lastSync.get(chat.id) || 0) < envNum(this.env.SYNC_MIN_MS, 5000)) return;
    this.lastSync.set(chat.id, Date.now());
    // A chat from before this was possible has no record of where it stands; what is here is taken to be all of it so far.
    const first = chat.synced_turns === null || chat.synced_turns === undefined;
    const r = await this.askAgent({ type: "transcript", sessionId: chat.session_id, from: first ? 1e9 : chat.synced_turns }, ms);
    if (!r || !r.ok) return;
    const turns = Math.max(0, Math.round(Number(r.turns)) || 0);
    // Only what isn't here yet: a turn sent again must change nothing, not even when the chat was last used.
    const have = new Set(this.rows("SELECT id FROM messages WHERE chat_id = ?", chat.id).map(x => x.id));
    const messages = first ? [] : this.cleanTranscript(chat.session_id, r.messages).filter(x => !have.has(x.id));
    // The computer's clock and this one needn't agree, so what is added is placed after what is already here, in its own order.
    let after = (this.one("SELECT MAX(created) AS c FROM messages WHERE chat_id = ?", chat.id) || {}).c || 0;
    for (const m of messages) m.created = after = Math.max(m.created, after + 1);
    this.addImported(chat.id, messages);
    const at = messages.length ? Math.max(chat.updated || 0, after) : chat.updated;
    this.sql.exec("UPDATE chats SET synced_turns = ?, synced_at = ?, updated = ? WHERE id = ?", turns, Math.round(Number(r.mtime)) || 0, at, chat.id);
  }

  stopRun(runId) {
    const ws = this.agent();
    const r = this.runs.get(runId);
    const chat = this.one("SELECT id FROM chats WHERE running = ?", runId);
    if (ws && chat) {
      this.sendAgent(ws, { type: "stop", runId, chatId: chat.id });
      return;
    }
    if (chat) this.completeRun({ runId, chatId: chat.id, text: r ? r.text : "", error: "Stopped." });
  }

  async send(req) {
    let b;
    try {
      b = await req.json();
    } catch {
      return json({ error: "That message couldn't be read." }, 400);
    }
    const text = String(b.text || "").trim();
    const files = (Array.isArray(b.files) ? b.files : []).filter(f => f && typeof f.name === "string" && typeof f.data === "string").slice(0, 25);
    if (!text && !files.length) return json({ error: "Type a message first." }, 400);
    let chat = null;
    if (b.chatId) {
      chat = this.one("SELECT * FROM chats WHERE id = ?", String(b.chatId));
      if (!chat) return json({ error: "That chat doesn't exist anymore." }, 404);
      if (chat.running) return json({ error: "Still answering in this chat." }, 409);
    }
    const allowed = req.headers.get("x-show-fable") === "1" ? MODELS : Object.fromEntries(Object.entries(MODELS).filter(([id]) => id !== "claude-fable-5-1"));
    const model = allowed[b.model] ? b.model : DEFAULT_MODEL;
    const effort = MODELS[model].efforts.includes(b.effort) ? b.effort : null;
    const mode = MODES.includes(b.mode) ? b.mode : "code";
    const perm = mode === "code" && PERMS.includes(b.perm) ? b.perm : "auto";
    const ws = this.agent();
    if (!ws) return json({ error: `${siteName(this.env)} is offline right now. Run ${commandName(this.env)} to bring it back online, then send again.`, code: "offline" }, 503);
    const held = await this.creditsBlock(model);
    if (held) return json({ error: held.message, code: held.code, resetsAt: held.resetsAt || null }, 409);
    if (chat) await this.syncChat(chat, 6000);
    // A chat imported from claude.ai has no Claude Code session yet: the first reply gets the conversation so far to read.
    const earlier = chat && chat.origin === "claude.ai" && !chat.started ? this.importedContext(chat.id) : "";
    const now = Date.now();
    if (!chat) {
      chat = { id: crypto.randomUUID(), title: titleFrom(text, files), model, effort, session_id: crypto.randomUUID(), started: 0, running: null, created: now, updated: now };
      this.sql.exec("INSERT INTO chats (id, title, model, effort, session_id, started, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)", chat.id, chat.title, model, effort, chat.session_id, now, now);
    }
    const runId = crypto.randomUUID();
    const fileMeta = files.map(f => ({ name: f.name.slice(0, 200), size: Math.floor(f.data.length * 0.75), type: String(f.type || "") }));
    const userMsg = { id: "u-" + runId, role: "user", content: text, meta: { files: fileMeta, model, effort, mode, perm }, created: now };
    this.sql.exec("INSERT INTO messages (id, chat_id, role, content, meta, created) VALUES (?, ?, 'user', ?, ?, ?)", userMsg.id, chat.id, text, JSON.stringify(userMsg.meta), now);
    this.sql.exec("UPDATE chats SET running = ?, model = ?, effort = ?, updated = ? WHERE id = ?", runId, model, effort, now, chat.id);
    const ts = new TransformStream();
    this.runs.set(runId, { writer: ts.writable.getWriter(), chatId: chat.id, text: "", thinking: "", thinkingMs: 0, tools: [], parts: [], model, effort, mode, perm, closed: false, status: "", heard: false, timer: null });
    this.push(runId, { type: "meta", chat: { id: chat.id, title: chat.title }, user: userMsg, runId });
    this.sendAgent(ws, { type: "run", runId, chatId: chat.id, sessionId: chat.session_id, resume: !!chat.started, prompt: earlier + text, model, effort, mode, perm, files: files.map(f => ({ name: f.name.slice(0, 200), type: String(f.type || ""), data: f.data })) });
    this.armRun(runId, 30000, `${siteName(this.env)} didn't respond. Make sure ${commandName(this.env)} is running, then send again.`);
    return new Response(ts.readable, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
  }

  saveArtifacts(chatId, runId, files, text) {
    const out = [];
    const now = Date.now();
    let n = 0;
    const add = (name, bytes, extra) => {
      if (out.length >= 16) return;
      const mime = mimeOf(name);
      const id = `${runId}-${n++}`;
      if (bytes.length > MAX_ARTIFACT) {
        out.push({ id: null, name, mime, size: bytes.length, kind: kindOf(mime, name), tooBig: true, ...extra });
        return;
      }
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      this.sql.exec("INSERT OR REPLACE INTO artifacts (id, chat_id, name, mime, size, data, created) VALUES (?, ?, ?, ?, ?, ?, ?)", id, chatId, name, mime, bytes.length, buf, now);
      out.push({ id, name, mime, size: bytes.length, kind: kindOf(mime, name), ...extra });
    };
    for (const f of files) {
      if (!f || typeof f.name !== "string") continue;
      if (f.tooBig && out.length < 16) {
        const name = f.name.slice(0, 120);
        const mime = mimeOf(name);
        out.push({ id: null, name, mime, size: Number(f.size) || 0, kind: kindOf(mime, name), tooBig: true });
        continue;
      }
      if (typeof f.data !== "string") continue;
      try {
        add(f.name.slice(0, 120), b64urlBytes(f.data));
      } catch {}
    }
    const re = /```([A-Za-z]*)[^\n]*\n([\s\S]*?)```/g;
    let mm;
    let pages = 0;
    while ((mm = re.exec(text || ""))) {
      const lang = mm[1].toLowerCase();
      const body = mm[2];
      const head = body.trimStart().slice(0, 200).toLowerCase();
      const isPage = (lang === "html" || lang === "htm" || (!lang && head.startsWith("<!doctype html"))) && body.length > 150 && /<(html|body|div|canvas|script|style)/i.test(body);
      const isSvg = (lang === "svg" || lang === "xml") && head.includes("<svg") && body.length > 80;
      if (!isPage && !isSvg) continue;
      pages++;
      const title = (body.match(/<title>([^<]{1,60})<\/title>/i) || [])[1];
      const base = (title || (isSvg ? "Image" : "Web page")).replace(/[\\/:*?"<>|]/g, "").trim() || "Untitled";
      const trimmed = body.trim();
      add(`${base}${pages > 1 && !title ? " " + pages : ""}.${isSvg ? "svg" : "html"}`, enc.encode(body), { inline: trimmed.length + ":" + trimmed.slice(0, 60) });
    }
    return out;
  }

  serveArtifact(id, download) {
    const a = this.one("SELECT name, mime, data FROM artifacts WHERE id = ?", id);
    if (!a) return new Response("Not found", { status: 404 });
    const textual = /^text\/|json|xml|svg/.test(a.mime);
    const type = a.mime === "text/html" || a.mime === "image/svg+xml" || a.mime === "application/pdf" || a.mime.startsWith("image/") ? a.mime : textual ? "text/plain" : "application/octet-stream";
    const headers = {
      "content-type": type + (textual ? "; charset=utf-8" : ""),
      "cache-control": "private, max-age=300",
      "x-content-type-options": "nosniff",
      "content-security-policy": a.mime === "application/pdf" && !download ? "frame-ancestors 'self'" : "sandbox allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads; frame-ancestors 'self'",
      "content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(a.name)}`
    };
    return new Response(a.data, { headers });
  }

  async completeRun(m) {
    const chat = this.one("SELECT * FROM chats WHERE id = ?", String(m.chatId || ""));
    if (!chat) {
      this.closeRun(m.runId);
      return;
    }
    const r = this.runs.get(m.runId);
    const now = Date.now();
    const text = typeof m.text === "string" && m.text ? m.text : (r ? r.text : "");
    const tools = Array.isArray(m.tools) ? m.tools.slice(0, 200) : (r ? r.tools : []);
    const thinking = typeof m.thinking === "string" && m.thinking ? m.thinking : (r ? r.thinking : "");
    const artifacts = this.saveArtifacts(chat.id, m.runId, Array.isArray(m.artifacts) ? m.artifacts : [], text);
    const meta = { model: (r && r.model) || chat.model, effort: r ? r.effort : chat.effort, mode: r ? r.mode : "code", perm: r ? r.perm : "auto", context: cleanContext(m.context), tools, error: m.error || null, denials: m.denials || 0, ms: m.ms || null, thinking: thinking.slice(0, 300000), thinkingMs: m.thinkingMs || (r && r.thinkingMs) || null, artifacts };
    const parts = this.partsMeta(r, text, meta.thinking);
    if (parts) meta.parts = parts;
    this.sql.exec("INSERT OR IGNORE INTO messages (id, chat_id, role, content, meta, created) VALUES (?, ?, 'assistant', ?, ?, ?)", "a-" + m.runId, chat.id, text, JSON.stringify(meta), now);
    if (m.started) this.sql.exec("UPDATE chats SET started = 1 WHERE id = ?", chat.id);
    if (m.sync && Number.isInteger(m.sync.turns) && m.sync.turns >= 0) this.sql.exec("UPDATE chats SET synced_turns = ?, synced_at = ? WHERE id = ?", m.sync.turns, Math.round(Number(m.sync.mtime)) || 0, chat.id);
    if (chat.running === m.runId) this.sql.exec("UPDATE chats SET running = NULL, updated = ? WHERE id = ?", now, chat.id);
    this.push(m.runId, { type: "done", message: { id: "a-" + m.runId, role: "assistant", content: text, meta, created: now } });
    this.closeRun(m.runId);
  }
}
