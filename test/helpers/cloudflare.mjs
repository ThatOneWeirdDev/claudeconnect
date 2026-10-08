// Just enough of Cloudflare's API for the installer's questions: accounts, existing workers, storage namespaces, subdomain.
import http from "node:http";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export async function startFakeCloudflare(home) {
  const created = [];
  const deleted = [];
  let exists = false;
  const ok = (res, result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, errors: [], result }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      const p = url.pathname;
      if (req.headers.authorization !== "Bearer fake-cloudflare-token") return res.writeHead(401).end("{}");
      if (req.method === "DELETE") {
        deleted.push(p);
        return ok(res, {});
      }
      if (p === "/accounts") return ok(res, [{ id: "acct-1", name: "Test Account" }]);
      if (p === "/user") return ok(res, { email: "owner@example.com" });
      if (p === "/accounts/acct-1/workers/scripts") return ok(res, exists ? [{ id: "my-site" }] : []);
      if (p === "/accounts/acct-1/workers/durable_objects/namespaces") return ok(res, exists ? [{ class: "ChatgqlHub", script: "my-site" }] : []);
      if (p === "/accounts/acct-1/storage/kv/namespaces" && req.method === "GET") return ok(res, created.map(c => ({ id: c.id, title: c.title })));
      if (p === "/accounts/acct-1/storage/kv/namespaces" && req.method === "POST") {
        const c = { id: "kv-new", title: JSON.parse(body).title };
        created.push(c);
        return ok(res, c);
      }
      if (p === "/accounts/acct-1/workers/subdomain") return ok(res, { subdomain: "testacct" });
      res.writeHead(404).end(JSON.stringify({ success: false, errors: [{ message: "unexpected " + p }] }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, created, deleted, siteExists: v => (exists = v), close: () => new Promise(r => server.close(r)) };
}
