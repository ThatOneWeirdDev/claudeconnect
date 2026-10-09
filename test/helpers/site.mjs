// Runs the real site/worker.js (and its Durable Object) locally in workerd through miniflare.
//
// Cloudflare Access is stood in for by a small front worker that does what the Access edge does: it turns the
// `cf-access-token` header the agent sends into the `cf-access-jwt-assertion` header the site verifies. The JWT is signed
// with a throwaway key whose public half is served from the (mocked) Access certs URL, so the site's real verification
// code runs, not a bypass. GitHub is mocked too: the manifest the site checks for updates comes from `site.release`.
import { Miniflare } from "miniflare";
import { mkdtempSync, mkdirSync, copyFileSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import crypto from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const ISS = "https://test.cloudflareaccess.com";
export const AGENT_SECRET = "test-agent-secret-0123456789";
export const CLAIM_CODE = "test-claim-code";

const b64 = v => Buffer.from(v).toString("base64url");

export function makeAccess(email = "owner@example.com") {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
  const sign = (claims = {}) => {
    const now = Math.floor(Date.now() / 1000);
    const head = b64(JSON.stringify({ alg: "RS256", kid: "test-key", typ: "JWT" }));
    const body = b64(JSON.stringify({ iss: ISS, aud: ["test-aud"], email, iat: now, nbf: now - 10, exp: now + 86400, ...claims }));
    return `${head}.${body}.${crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), privateKey).toString("base64url")}`;
  };
  return { jwks: { keys: [jwk] }, sign };
}

const FRONT = `export default {
  async fetch(req, env) {
    const h = new Headers(req.headers);
    const t = h.get("cf-access-token") || (h.get("x-test-anonymous") ? "" : env.JWT);
    h.delete("cf-access-jwt-assertion");
    if (t) h.set("cf-access-jwt-assertion", t);
    return env.SITE.fetch(new Request(req, { headers: h }));
  }
};`;

// The real worker, with one extra door for tests: POST /api/__seed writes chats and messages straight into the Durable
// Object's tables, POST /api/__limits writes a plan-usage reading, because the real ones come from a signed-in Claude plan, and
// /api/__storage reads and writes the Object's key-value storage (the update log, for one).
const MAIN = `import Worker, { ChatgqlHub as Base } from "./worker.js";
export class ChatgqlHub extends Base {
  async fetch(req) {
    if (new URL(req.url).pathname === "/api/__seed") {
      const b = await req.json();
      for (const c of b.chats || []) this.sql.exec("INSERT OR REPLACE INTO chats (id, title, model, effort, session_id, started, running, created, updated) VALUES (?, ?, 'claude-opus-5-5', 'medium', ?, 1, NULL, ?, ?)", c.id, c.title, c.id, c.created, c.updated);
      for (const m of b.messages || []) this.sql.exec("INSERT OR REPLACE INTO messages (id, chat_id, role, content, meta, created) VALUES (?, ?, ?, ?, ?, ?)", m.id, m.chat, m.role, m.content, m.meta ? JSON.stringify(m.meta) : "{}", m.created);
      return Response.json({ ok: true });
    }
    if (new URL(req.url).pathname === "/api/__storage") {
      if (req.method === "POST") {
        const b = await req.json();
        await this.ctx.storage.put(b.key, b.value);
        if (b.key === "site") this.siteRec = b.value; // as the Object reads it when it starts
        return Response.json({ ok: true });
      }
      return Response.json({ value: (await this.ctx.storage.get(new URL(req.url).searchParams.get("key"))) ?? null });
    }
    if (new URL(req.url).pathname === "/api/__limits") {
      await this.setLimits(await req.json());
      return Response.json({ ok: true });
    }
    return super.fetch(req);
  }
}
export default Worker;
`;

export async function startSite(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cc-site-"));
  for (const f of readdirSync(join(ROOT, "site"))) copyFileSync(join(ROOT, "site", f), join(dir, f));
  writeFileSync(join(dir, "brand.js"), "export default " + JSON.stringify({ logo: null, favicon: null }) + ";\n");
  writeFileSync(join(dir, "front.mjs"), FRONT);
  writeFileSync(join(dir, "main.mjs"), MAIN);
  const access = makeAccess();
  const jwt = access.sign();
  // Tests change `release` and `releaseStatus` on the object startSite returns, so this one object is both what they hold and what the mock reads.
  const site = { release: opts.release || null, releaseStatus: 200, fetched: [], dir, access, jwt, agentSecret: (opts.vars && opts.vars.AGENT_SECRET) || AGENT_SECRET, claimCode: (opts.vars && opts.vars.CLAIM_CODE) || CLAIM_CODE };
  const mf = new Miniflare({
    host: "127.0.0.1",
    port: opts.port || 0,
    verbose: false,
    workers: [
      { name: "front", modules: true, scriptPath: join(dir, "front.mjs"), modulesRoot: dir, serviceBindings: { SITE: "site" }, bindings: { JWT: jwt } },
      {
        name: "site",
        modules: true,
        scriptPath: join(dir, "main.mjs"),
        modulesRoot: dir,
        modulesRules: [{ type: "ESModule", include: ["**/*.js", "**/*.mjs"] }, { type: "Text", include: ["**/*.html"] }],
        compatibilityDate: "2025-09-01",
        durableObjects: { HUB: { className: "ChatgqlHub", useSQLite: true } },
        kvNamespaces: ["TOKENS"],
        bindings: {
          SITE_NAME: "Test Site",
          COMMAND: "TestConnect",
          SHOW_FABLE: "0",
          APP_VERSION: opts.appVersion || "1.1.0",
          UPDATE_REPO: "ThatOneWeirdDev/claudeconnect",
          UPDATE_REF: "main",
          UPDATE_RAW: "https://raw.test",
          AGENT_SECRET,
          CLAIM_CODE,
          ...(opts.vars || {})
        },
        outboundService: async request => {
          const url = new URL(request.url);
          if (url.origin === ISS && url.pathname === "/cdn-cgi/access/certs") return Response.json(access.jwks);
          if (url.origin === "https://raw.test" && url.pathname.endsWith("/manifest.json")) {
            site.fetched.push(request.url);
            if (site.releaseStatus !== 200) return new Response("nope", { status: site.releaseStatus });
            return site.release ? Response.json(site.release) : new Response("not found", { status: 404 });
          }
          return new Response("blocked in test: " + request.url, { status: 599 });
        }
      }
    ]
  });
  const origin = (await mf.ready).origin;
  const asOwner = (path, init = {}) => mf.dispatchFetch(origin + path, { ...init, headers: { "content-type": "application/json", ...(init.headers || {}) } });
  const api = async (path, init) => {
    const r = await asOwner(path, init);
    const text = await r.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {}
    return { status: r.status, body, text, headers: r.headers };
  };
  const post = (path, body, headers) => api(path, { method: "POST", body: JSON.stringify(body || {}), headers });
  // First visit with the claim link makes the signed-in account the owner, like opening the link setup prints.
  const claim = () => asOwner(`/?claim=${site.claimCode}`, { redirect: "manual" });
  const seed = data => post("/api/__seed", data);
  const setLimits = data => post("/api/__limits", data);
  const getStorage = async key => (await api("/api/__storage?key=" + encodeURIComponent(key))).body.value;
  const putStorage = (key, value) => post("/api/__storage", { key, value });
  return Object.assign(site, {
    mf,
    origin,
    api,
    post,
    claim,
    seed,
    setLimits,
    getStorage,
    putStorage,
    asOwner,
    async stop() {
      await mf.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

// A stand-in for the agent's side of the WebSocket, driven by the test.
export async function connectAgent(s, hello = {}, id = "agent-1") {
  const res = await s.mf.dispatchFetch(s.origin + "/agent", { headers: { upgrade: "websocket", "cf-access-token": s.jwt, "x-chatgql-key": s.agentSecret, "x-agent-id": id } });
  const ws = res.webSocket;
  if (!ws) throw new Error("agent connection refused: " + res.status);
  ws.accept();
  const inbox = [];
  const waiters = [];
  ws.addEventListener("message", ev => {
    let m;
    try {
      m = JSON.parse(ev.data);
    } catch {
      return;
    }
    const i = waiters.findIndex(w => w.test(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
    else inbox.push(m);
  });
  const agent = {
    ws,
    send: o => ws.send(JSON.stringify(o)),
    next: (test = () => true, ms = 5000) =>
      new Promise((resolve, reject) => {
        const i = inbox.findIndex(test);
        if (i >= 0) return resolve(inbox.splice(i, 1)[0]);
        const w = { test, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) {
            waiters.splice(k, 1);
            reject(new Error("timed out waiting for a message from the site"));
          }
        }, ms);
      }),
    close: () => ws.close(1000, "test over")
  };
  agent.send({ type: "hello", agent: "1.3.0", caps: ["update", "admin", "limits", "modes", "history"], warning: "", tokenExp: 0, active: [], ...hello });
  await new Promise(r => setTimeout(r, 50));
  return agent;
}
