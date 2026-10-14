// The setup's window. The installer asks its questions and shows its steps here instead of in the terminal: a page served
// by Node's own HTTP server on this computer only (127.0.0.1, a one-time key in its address), opened in your browser. Nothing
// is installed for it, and the terminal setup is still there (`--cli`, or wherever no browser can be opened).
//
// The installer stays in charge, line by line, exactly as in the terminal: `ask` waits for an answer from the page, and
// everything it prints arrives on the page as it happens. The page asks for what happened after the last thing it saw, so
// reloading it, or opening the address in another browser, picks up where it was.
import http from "node:http";
import crypto from "node:crypto";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAX_UPLOAD = 2 * 1024 * 1024;
const strip = s => String(s).replace(/\x1b\[[0-9;]*m/g, "");

export async function startGui({ title, version, logo = null }) {
  const key = crypto.randomBytes(18).toString("base64url");
  const page = readFileSync(join(HERE, "setup.html"), "utf8");
  const events = [];
  let waiters = [];
  let lastSeen = 0;
  const questions = new Map();
  let uploads = null;

  const push = ev => {
    events.push({ n: events.length + 1, at: Date.now(), ...ev });
    const w = waiters;
    waiters = [];
    for (const f of w) f();
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const port = server.address().port;
    const send = (code, body, type = "application/json; charset=utf-8") => {
      res.writeHead(code, { "content-type": type, "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" });
      res.end(typeof body === "string" ? body : JSON.stringify(body));
    };
    // only this computer, only with the key, and only under its own address (so no other site can reach it through DNS)
    if (![`127.0.0.1:${port}`, `localhost:${port}`].includes(String(req.headers.host || ""))) return send(403, { error: "forbidden" });
    if (url.searchParams.get("k") !== key && req.headers["x-setup-key"] !== key) return send(403, { error: "forbidden" });
    if (req.method === "GET" && url.pathname === "/") {
      const cfg = JSON.stringify({ key, title, version, logo }).replace(/</g, "\\u003c");
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'", "referrer-policy": "no-referrer" });
      return res.end(page.replace("__SETUP__", cfg));
    }
    if (req.method === "GET" && url.pathname === "/events") {
      const after = Math.max(0, Number(url.searchParams.get("after")) || 0);
      const reply = () => {
        lastSeen = Math.max(lastSeen, events.length);
        send(200, { events: events.slice(after) });
      };
      if (events.length > after) return reply();
      // nothing new yet: answer as soon as there is, or after a while so the page knows this is still here
      const timer = setTimeout(() => {
        waiters = waiters.filter(f => f !== go);
        reply();
      }, 20000);
      const go = () => {
        clearTimeout(timer);
        reply();
      };
      waiters.push(go);
      req.on("close", () => {
        clearTimeout(timer);
        waiters = waiters.filter(f => f !== go);
      });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      let size = 0;
      req.on("data", d => {
        size += d.length;
        if (size > MAX_UPLOAD * 1.5) req.destroy();
        else body += d;
      });
      await new Promise(r => req.on("end", r));
      let b = {};
      try {
        b = JSON.parse(body || "{}");
      } catch {
        return send(400, { error: "bad request" });
      }
      if (url.pathname === "/answer") {
        const q = questions.get(String(b.id || ""));
        if (!q) return send(409, { error: "That question was already answered." });
        questions.delete(q.id);
        const value = typeof b.value === "string" ? b.value.slice(0, 2000) : "";
        push({ type: "answered", id: q.id, value: q.secret ? "" : value });
        q.resolve(value);
        return send(200, { ok: true });
      }
      if (url.pathname === "/upload") {
        // a picture picked on the page: kept in a folder of its own, and its path is the answer, as if it had been typed
        const buf = Buffer.from(String(b.data || ""), "base64");
        if (!buf.length || buf.length > MAX_UPLOAD) return send(400, { error: "That file is too big." });
        uploads = uploads || mkdtempSync(join(tmpdir(), "claudeconnect-setup-"));
        const name = String(b.name || "image").replace(/[^A-Za-z0-9._-]/g, "_").slice(-80) || "image";
        const p = join(uploads, `${crypto.randomBytes(4).toString("hex")}-${name}`);
        writeFileSync(p, buf);
        return send(200, { path: p });
      }
      if (url.pathname === "/cancel") {
        send(200, { ok: true });
        push({ type: "cancelled" });
        setTimeout(() => process.exit(130), 300);
        return;
      }
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve, reject) => {
    server.on("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const url = `http://127.0.0.1:${server.address().port}/?k=${key}`;

  let n = 0;
  const gui = {
    url,
    step: text => push({ type: "step", text: strip(text) }),
    note: text => push({ type: "note", text: strip(text).trim() }),
    log: text => {
      const t = strip(text);
      if (t.trim()) push({ type: "log", text: t.replace(/^\n+/, "").replace(/\s+$/, "") });
    },
    // A question, as the page shows it: { kind: "yesno" | "text" | "choice" | "image" | "continue", title, help, ... }.
    // Answers come back as the terminal would have them: "y"/"n", the text typed, the choice's value, a file path.
    ask(spec) {
      const id = `q${++n}`;
      return new Promise(resolve => {
        questions.set(id, { id, resolve, secret: !!spec.secret });
        push({ type: "ask", id, ...spec });
      });
    },
    // answers the open question for the page, when what it was waiting for has happened by itself (Access turned on, say)
    settle(value = "") {
      for (const q of [...questions.values()]) {
        questions.delete(q.id);
        push({ type: "answered", id: q.id, value: q.secret ? "" : value });
        q.resolve(value);
      }
    },
    // something the page shows as its own card, like the end of the setup
    show: (type, data) => push({ type, ...data }),
    // waits until the page has seen everything so far (or a few seconds, if nobody is looking), so nothing is lost on exit
    async flush(ms = 4000) {
      const end = Date.now() + ms;
      while (lastSeen < events.length && Date.now() < end) await new Promise(r => setTimeout(r, 100));
    },
    close() {
      server.close();
      server.closeAllConnections && server.closeAllConnections();
    }
  };
  return gui;
}
