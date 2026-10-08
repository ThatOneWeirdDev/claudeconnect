import { DurableObject } from "cloudflare:workers";
import APP_HTML from "./app.html";
import BRAND from "./brand.js";
import { buildUsage, validZone } from "./usage.js";
import { compareVersions, isNewer, cleanManifest, validRepo, validRef } from "./version.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
const CHUNK = 400000;
const ISS_RE = /^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/;
const ALL_EFFORTS = ["low", "medium", "high", "xhigh", "max"];
const MODELS = {
  "claude-fable-5-1": { name: "Fable 5.1", efforts: ALL_EFFORTS },
  "claude-opus-5-5": { name: "Opus 5.5", efforts: ALL_EFFORTS },
  "claude-sonnet-5-5": { name: "Sonnet 5.5", efforts: ALL_EFFORTS },
  "claude-haiku-5-5": { name: "Haiku 5.5", efforts: [] }
};
const DEFAULT_MODEL = "claude-opus-5-5";
const DEFAULT_REPO = "ThatOneWeirdDev/claudeconnect";
const UPDATE_STEPS = ["download", "verify", "site", "computer", "restart", "online"];
const CHECK_EVERY = 30 * 60000;
const CHECK_RETRY = 5 * 60000;
const ACK_WITHIN = 30000;
const QUIET_LIMIT = 10 * 60000;
const MAX_ARTIFACT = 1900000;
const MIME = { html: "text/html", htm: "text/html", svg: "image/svg+xml", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", ico: "image/x-icon", pdf: "application/pdf", md: "text/markdown", markdown: "text/markdown", txt: "text/plain", csv: "text/csv", json: "application/json", js: "text/javascript", mjs: "text/javascript", ts: "text/plain", tsx: "text/plain", jsx: "text/plain", css: "text/css", py: "text/plain", java: "text/plain", c: "text/plain", cpp: "text/plain", h: "text/plain", cs: "text/plain", go: "text/plain", rs: "text/plain", rb: "text/plain", php: "text/plain", sh: "text/plain", ps1: "text/plain", bat: "text/plain", sql: "text/plain", yml: "text/plain", yaml: "text/plain", toml: "text/plain", xml: "text/xml", ini: "text/plain", log: "text/plain", tex: "text/plain", kt: "text/plain", swift: "text/plain", lua: "text/plain", r: "text/plain", vue: "text/plain", svelte: "text/plain" };
const DEFAULT_MARK = `<svg viewBox="0 0 64 64" aria-hidden="true"><rect width="64" height="64" rx="16" fill="#0E8C86"/><circle cx="29" cy="29" r="12.5" fill="none" stroke="#fff" stroke-width="6.5"/><path d="M41.5 29v22" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/><path d="M36 45h11" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;

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

function appVersion(env) {
  return String(env.APP_VERSION || "0.0.0").slice(0, 32);
}

function aiName(env) {
  return String(env.AI_NAME || siteName(env)).slice(0, 60);
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

const FAVICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="16" fill="#0E8C86"/><circle cx="29" cy="29" r="12.5" fill="none" stroke="#fff" stroke-width="6.5"/><path d="M41.5 29v22" stroke="#fff" stroke-width="6.5" stroke-linecap="round"/><path d="M36 45h11" stroke="#fff" stroke-width="5" stroke-linecap="round"/></svg>`;

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

function lockPage(state, lockName, lockMark) {
  const copy = {
    "no-access": ["Turn on Cloudflare Access", "This site isn't protected yet, so it stays locked. Turn on Cloudflare Access on the Access page the setup opened, then open the claim link the setup printed."],
    "bad-token": ["Sign in again", "Your Cloudflare Access sign-in couldn't be verified. Reload the page to sign in again."],
    "unclaimed": ["Finish setup", "Access is on. Open the claim link the setup printed to make this site yours."],
    "denied": ["Not yours", "This site belongs to a different account. If it's yours and you turned Cloudflare Access off and on again, run the setup again and open the new claim link."]
  }[state] || ["Locked", "This page is locked."];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escHtml(lockName)}</title><link rel="icon" href="/favicon"><style>:root{color-scheme:light dark;--bg:#FBFBFD;--ink:#172036;--ink2:#4A5468;--line:#DDE2EA;--accent:#0E8C86}@media (prefers-color-scheme:dark){:root{--bg:#10161F;--ink:#E4EAF2;--ink2:#A9B4C4;--line:#222C3A;--accent:#39C3B8}}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}main{max-width:460px}.m{display:block;width:44px;height:44px;margin-bottom:20px}.m svg,.m img{width:44px;height:44px;border-radius:10px;object-fit:contain}h1{font-size:22px;margin:0 0 8px;letter-spacing:-.01em}p{margin:0;color:var(--ink2)}</style></head><body><main><span class="m">${lockMark}</span><h1>${copy[0]}</h1><p>${copy[1]}</p></main></body></html>`;
  return new Response(html, { status: state === "denied" ? 403 : 401, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY" } });
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
  const cfg = JSON.stringify({ name, ai: aiName(env), command: commandName(env), fable: env.SHOW_FABLE === "1", version: appVersion(env) }).replace(/</g, "\\u003c");
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
      return lockPage(a.state, siteName(env), lg ? `<img src="/logo" alt="">` : DEFAULT_MARK);
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
    this.sql.exec("CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY, chat_id TEXT, name TEXT, mime TEXT, size INTEGER, data BLOB, created INTEGER)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS usage (run_id TEXT, model TEXT, ts INTEGER, input INTEGER, output INTEGER, cache_read INTEGER, cache_write INTEGER, cost REAL, PRIMARY KEY (run_id, model))");
    this.sql.exec("CREATE INDEX IF NOT EXISTS usage_ts ON usage(ts)");
    this.latest = null;
    this.checking = null;
    this.runs = new Map();
    this.parts = new Map();
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
    const r = this.runs.get(m.runId);
    if (!r) return;
    r.heard = true;
    this.armRun(m.runId, 100000, `Lost the connection before the reply finished. Check that ${commandName(this.env)} is still running.`);
    if (m.type === "delta") {
      r.text += m.text || "";
      this.push(m.runId, { type: "delta", text: m.text || "" });
    } else if (m.type === "tool") {
      r.tools.push({ id: m.id, name: m.name, label: m.label, done: false });
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
      this.push(m.runId, { type: "thinking", text: m.text || "" });
    } else if (m.type === "thinking_done") {
      r.thinkingMs = Number(m.ms) || 0;
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
    ws.serializeAttachment({ id: this.agentInfo(ws).id || "", since: Date.now(), version: String(m.agent || "").slice(0, 32), caps, warning: m.warning ? String(m.warning).slice(0, 40) : "" });
    await this.ctx.storage.delete("lastSeen");
    const run = await this.ctx.storage.get("update");
    // An update that looked stuck or failed is still a success if the new version turns up within the hour.
    if (run && (run.state === "running" || (run.state === "error" && Date.now() - (run.finishedAt || 0) < 3600000)) && compareVersions(m.agent, run.to) >= 0) await this.finishUpdate(run);
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
    if (p === "/api/usage" && method === "GET") return json(this.usage(url));
    if (p === "/api/update" && method === "GET") return json(await this.updateInfo());
    if (p === "/api/update/check" && method === "POST") return json(await this.updateInfo(true));
    if (p === "/api/update/start" && method === "POST") return this.startUpdate(req);
    if (p === "/api/update/dismiss" && method === "POST") {
      const run = await this.ctx.storage.get("update");
      if (run && run.state !== "running") await this.ctx.storage.delete("update");
      return json(await this.updateInfo());
    }
    if (p === "/api/chats" && method === "GET") return json({ chats: this.rows("SELECT id, title, updated, running FROM chats ORDER BY updated DESC LIMIT 400") });
    const cm = p.match(/^\/api\/chats\/([A-Za-z0-9-]{8,64})$/);
    if (cm && method === "GET") return this.getChat(cm[1]);
    if (cm && method === "PATCH") {
      const b = await req.json().catch(() => ({}));
      const title = String(b.title || "").trim().slice(0, 120);
      if (!title) return json({ error: "Give the chat a name." }, 400);
      this.sql.exec("UPDATE chats SET title = ? WHERE id = ?", title, cm[1]);
      return json({ ok: true });
    }
    if (cm && method === "DELETE") {
      const chat = this.one("SELECT running FROM chats WHERE id = ?", cm[1]);
      if (chat && chat.running) this.stopRun(chat.running);
      this.sql.exec("DELETE FROM messages WHERE chat_id = ?", cm[1]);
      this.sql.exec("DELETE FROM artifacts WHERE chat_id = ?", cm[1]);
      this.sql.exec("DELETE FROM chats WHERE id = ?", cm[1]);
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
      agent: info ? { online: true, since: info.since || null, warning: info.warning || "", version: info.version || "" } : { online: false, lastSeen: (await this.ctx.storage.get("lastSeen")) || null },
      update: await this.updateInfo()
    };
  }

  usage(url) {
    const now = Date.now();
    const since = now - 95 * 86400000;
    const rows = this.rows("SELECT ts, model, input, output, cache_read, cache_write, cost FROM usage WHERE ts >= ?", since);
    const replyTimes = this.rows("SELECT created FROM messages WHERE role = 'assistant' AND created >= ?", since).map(r => r.created);
    const out = buildUsage({ rows, replyTimes, now, timeZone: validZone(url.searchParams.get("tz")) });
    const first = this.one("SELECT MIN(ts) AS t FROM usage");
    out.trackedSince = first && first.t ? first.t : null;
    return out;
  }

  recordUsage(runId, ts, usage, fallbackModel) {
    if (!Array.isArray(usage)) return;
    const n = v => (Number.isFinite(v) && v > 0 ? Math.min(Math.round(v), 1e12) : 0);
    for (const u of usage.slice(0, 8)) {
      if (!u || typeof u !== "object") continue;
      const cost = Number.isFinite(u.cost) && u.cost > 0 ? Math.min(u.cost, 1e6) : 0;
      this.sql.exec("INSERT OR IGNORE INTO usage (run_id, model, ts, input, output, cache_read, cache_write, cost) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", runId, String(u.model || fallbackModel || "").slice(0, 80), ts, n(u.input), n(u.output), n(u.cacheRead), n(u.cacheWrite), cost);
    }
  }

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
        const r = await fetch(`${src.raw}/${src.repo}/${src.ref}/manifest.json`, { headers: { "user-agent": "ClaudeConnect-site", accept: "application/json" }, signal: AbortSignal.timeout(6000) });
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
        run = { ...run, state: "error", finishedAt: now, message: unanswered ? `${siteName(this.env)} on your computer didn't pick up the update. Make sure ${commandName(this.env)} is running, then try again.` : `The update stopped reporting progress. Check your computer, or run ${commandName(this.env)} update there.` };
        await this.ctx.storage.put("update", run);
      }
    }
    return run || null;
  }

  updateBlock(run) {
    const ws = this.agent();
    if (run && run.state === "running") return { code: "running", message: "An update is already running." };
    if (!ws) return { code: "offline", message: `${siteName(this.env)} is offline. Start ${commandName(this.env)} on your computer, then update.` };
    if (!(this.agentInfo(ws).caps || []).includes("update")) return { code: "agent_old", message: `The ${commandName(this.env)} program on your computer is too old to update from here. Run ${commandName(this.env)} update there once, and later updates can be done from this page.` };
    if (this.one("SELECT 1 AS x FROM chats WHERE running IS NOT NULL")) return { code: "busy", message: "A reply is still being written. Wait for it to finish, or stop it, then update." };
    return null;
  }

  async updateInfo(force) {
    const src = this.updateSource();
    let c = this.latest || (await this.ctx.storage.get("latest")) || null;
    if (c && c.source !== src.label) c = null;
    const stale = !c || Date.now() - c.at > (c.error ? CHECK_RETRY : CHECK_EVERY);
    if (force || !c) c = await this.checkLatest();
    else if (stale) this.checkLatest().catch(() => {});
    this.latest = c;
    const current = appVersion(this.env);
    const latest = c && c.release ? c.release : null;
    const run = await this.updateRun();
    return {
      current,
      latest: latest ? latest.version : null,
      available: !!latest && isNewer(latest.version, current),
      notes: latest ? latest.notes : [],
      released: latest ? latest.released : "",
      source: src.label,
      checkedAt: c ? c.at : null,
      error: c && c.error ? c.error : "",
      run,
      blocked: this.updateBlock(run)
    };
  }

  async startUpdate(req) {
    const b = await req.json().catch(() => ({}));
    const info = await this.updateInfo();
    if (!info.available) return json({ error: "You're already up to date.", code: "current" }, 409);
    if (String(b.to || "") !== info.latest) return json({ error: "A different version came out. Look at what's new, then update.", code: "changed" }, 409);
    if (info.blocked) return json({ error: info.blocked.message, code: info.blocked.code }, 409);
    const ws = this.agent();
    const now = Date.now();
    const run = { id: crypto.randomUUID(), from: info.current, to: info.latest, state: "running", acked: false, step: "download", steps: {}, message: "", startedAt: now, updatedAt: now, finishedAt: null, by: req.headers.get("x-chatgql-user") || "" };
    await this.ctx.storage.put("update", run);
    try {
      this.sendAgent(ws, { type: "update", id: run.id, to: run.to });
    } catch {
      await this.ctx.storage.delete("update");
      return json({ error: `${siteName(this.env)} on your computer couldn't be reached. Try again in a moment.`, code: "offline" }, 503);
    }
    return json(await this.updateInfo());
  }

  async finishUpdate(run) {
    const steps = {};
    for (const s of UPDATE_STEPS) steps[s] = "done";
    const now = Date.now();
    await this.ctx.storage.put("update", { ...run, state: "done", acked: true, steps, step: "online", message: "", updatedAt: now, finishedAt: now });
  }

  async updateAck(m) {
    const run = await this.ctx.storage.get("update");
    if (!run || run.state !== "running" || run.id !== m.id) return;
    const now = Date.now();
    if (m.ok === false) await this.ctx.storage.put("update", { ...run, state: "error", message: String(m.error || "Your computer couldn't start the update.").slice(0, 300), updatedAt: now, finishedAt: now });
    else await this.ctx.storage.put("update", { ...run, acked: true, updatedAt: now });
  }

  async agentProgress(req) {
    if (req.method !== "POST") return json({ error: "Expected POST" }, 405);
    if (!this.env.AGENT_SECRET || !safeEqual(req.headers.get("x-agent-key") || "", this.env.AGENT_SECRET)) return json({ error: "Forbidden" }, 403);
    let b;
    try {
      b = JSON.parse(await req.text());
    } catch {
      return json({ error: "Bad request" }, 400);
    }
    const run = await this.ctx.storage.get("update");
    if (!run || run.id !== b.id) return json({ error: "No such update" }, 404);
    if (run.state !== "running") return json({ ok: true });
    const now = Date.now();
    const next = { ...run, acked: true, updatedAt: now, steps: { ...run.steps } };
    const at = UPDATE_STEPS.indexOf(b.step);
    if (at >= 0) {
      for (let i = 0; i < at; i++) next.steps[UPDATE_STEPS[i]] = "done";
      next.step = b.step;
      next.steps[b.step] = b.status === "done" ? "done" : b.status === "error" ? "error" : "active";
    }
    if (b.status === "error") {
      next.state = "error";
      next.finishedAt = now;
      next.message = String(b.message || "The update didn't finish.").slice(0, 400);
    } else if (b.step === "online" && b.status === "done") {
      await this.finishUpdate(next);
      return json({ ok: true });
    }
    await this.ctx.storage.put("update", next);
    return json({ ok: true });
  }

  getChat(id) {
    const chat = this.one("SELECT id, title, model, effort, running, created, updated FROM chats WHERE id = ?", id);
    if (!chat) return json({ error: "That chat doesn't exist anymore." }, 404);
    const messages = this.rows("SELECT id, role, content, meta, created FROM messages WHERE chat_id = ? ORDER BY created ASC, rowid ASC", id).map(m => ({ ...m, meta: m.meta ? JSON.parse(m.meta) : {} }));
    let partial = null;
    if (chat.running) {
      const r = this.runs.get(chat.running);
      partial = r ? { text: r.text, thinking: r.thinking, thinkingMs: r.thinkingMs || 0, tools: r.tools, status: r.status || "" } : { text: "", thinking: "", thinkingMs: 0, tools: [], status: "" };
    }
    return json({ chat, messages, partial });
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
    const ws = this.agent();
    if (!ws) return json({ error: `${siteName(this.env)} is offline right now. Run ${commandName(this.env)} to bring it back online, then send again.`, code: "offline" }, 503);
    const now = Date.now();
    if (!chat) {
      chat = { id: crypto.randomUUID(), title: titleFrom(text, files), model, effort, session_id: crypto.randomUUID(), started: 0, running: null, created: now, updated: now };
      this.sql.exec("INSERT INTO chats (id, title, model, effort, session_id, started, created, updated) VALUES (?, ?, ?, ?, ?, 0, ?, ?)", chat.id, chat.title, model, effort, chat.session_id, now, now);
    }
    const runId = crypto.randomUUID();
    const fileMeta = files.map(f => ({ name: f.name.slice(0, 200), size: Math.floor(f.data.length * 0.75), type: String(f.type || "") }));
    const userMsg = { id: "u-" + runId, role: "user", content: text, meta: { files: fileMeta, model, effort }, created: now };
    this.sql.exec("INSERT INTO messages (id, chat_id, role, content, meta, created) VALUES (?, ?, 'user', ?, ?, ?)", userMsg.id, chat.id, text, JSON.stringify(userMsg.meta), now);
    this.sql.exec("UPDATE chats SET running = ?, model = ?, effort = ?, updated = ? WHERE id = ?", runId, model, effort, now, chat.id);
    const ts = new TransformStream();
    this.runs.set(runId, { writer: ts.writable.getWriter(), chatId: chat.id, text: "", thinking: "", thinkingMs: 0, tools: [], model, effort, closed: false, status: "", heard: false, timer: null });
    this.push(runId, { type: "meta", chat: { id: chat.id, title: chat.title }, user: userMsg, runId });
    this.sendAgent(ws, { type: "run", runId, chatId: chat.id, sessionId: chat.session_id, resume: !!chat.started, prompt: text, model, effort, files: files.map(f => ({ name: f.name.slice(0, 200), type: String(f.type || ""), data: f.data })) });
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
    const meta = { model: (r && r.model) || chat.model, effort: r ? r.effort : chat.effort, tools, error: m.error || null, denials: m.denials || 0, ms: m.ms || null, thinking: thinking.slice(0, 300000), thinkingMs: m.thinkingMs || (r && r.thinkingMs) || null, artifacts };
    this.sql.exec("INSERT OR IGNORE INTO messages (id, chat_id, role, content, meta, created) VALUES (?, ?, 'assistant', ?, ?, ?)", "a-" + m.runId, chat.id, text, JSON.stringify(meta), now);
    this.recordUsage(m.runId, now, m.usage, meta.model);
    if (m.started) this.sql.exec("UPDATE chats SET started = 1 WHERE id = ?", chat.id);
    if (chat.running === m.runId) this.sql.exec("UPDATE chats SET running = NULL, updated = ? WHERE id = ?", now, chat.id);
    this.push(m.runId, { type: "done", message: { id: "a-" + m.runId, role: "assistant", content: text, meta, created: now } });
    this.closeRun(m.runId);
  }
}
