// Just enough of Cloudflare's API for the installer: accounts, existing workers, storage namespaces and their values, the
// workers.dev subdomain, deleting, and setting a secret. It keeps state and records what was asked of it.
import http from "node:http";

export async function startFakeCloudflare(home, opts = {}) {
  const scripts = new Set(opts.scripts || []);
  const kvs = new Map((opts.kvs || []).map(k => [k.id, k.title]));
  const values = new Map();
  const created = [];
  const deleted = [];
  const secrets = [];
  let nextKv = 0;
  let refuse = false;
  const ok = (res, result) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ success: true, errors: [], result }));
  const missing = res => res.writeHead(404, { "content-type": "application/json" }).end(JSON.stringify({ success: false, errors: [{ message: "not found" }] }));
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      const p = url.pathname;
      if (req.headers.authorization !== "Bearer fake-cloudflare-token") return res.writeHead(401).end("{}");
      let m;
      if (p === "/accounts") return ok(res, [{ id: "acct-1", name: "Test Account" }]);
      if (p === "/user") return ok(res, { email: "owner@example.com" });
      if (!(m = /^\/accounts\/[^/]+(\/.*)$/.exec(p))) return missing(res);
      if (refuse && req.method === "DELETE") return res.writeHead(403, { "content-type": "application/json" }).end(JSON.stringify({ success: false, errors: [{ message: "Access denied" }] }));
      const rest = m[1];
      if (rest === "/workers/subdomain") return ok(res, { subdomain: "testacct" });
      if (rest === "/workers/scripts" && req.method === "GET") return ok(res, [...scripts].map(id => ({ id })));
      if (rest === "/workers/durable_objects/namespaces") return ok(res, [...scripts].map(script => ({ class: "ChatgqlHub", script })));
      if (rest === "/storage/kv/namespaces" && req.method === "GET") return ok(res, [...kvs].map(([id, title]) => ({ id, title })));
      if (rest === "/storage/kv/namespaces" && req.method === "POST") {
        const title = JSON.parse(body).title;
        const id = nextKv++ ? `kv-new-${nextKv}` : "kv-new";
        kvs.set(id, title);
        created.push({ id, title });
        return ok(res, { id, title });
      }
      if ((m = /^\/workers\/scripts\/([^/]+)\/secrets$/.exec(rest)) && req.method === "PUT") {
        secrets.push({ script: decodeURIComponent(m[1]), ...JSON.parse(body) });
        return ok(res, { name: JSON.parse(body).name });
      }
      if ((m = /^\/workers\/scripts\/([^/]+)$/.exec(rest)) && req.method === "DELETE") {
        deleted.push(p);
        const had = scripts.delete(decodeURIComponent(m[1]));
        return had ? ok(res, {}) : missing(res);
      }
      if ((m = /^\/storage\/kv\/namespaces\/([^/]+)$/.exec(rest)) && req.method === "DELETE") {
        deleted.push(p);
        return kvs.delete(m[1]) ? ok(res, {}) : missing(res);
      }
      if ((m = /^\/storage\/kv\/namespaces\/([^/]+)\/values\/([^/]+)$/.exec(rest)) && req.method === "GET") {
        const v = values.get(`${m[1]}/${m[2]}`);
        return v === undefined ? res.writeHead(404).end("") : res.writeHead(200, { "content-type": "text/plain" }).end(v);
      }
      res.writeHead(404).end(JSON.stringify({ success: false, errors: [{ message: "unexpected " + req.method + " " + p }] }));
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    created,
    deleted,
    secrets,
    scripts,
    kvs,
    refuseDeletes: v => (refuse = v),
    siteExists: v => (v ? scripts.add("my-site") : scripts.delete("my-site")),
    setKvValue: (kvId, key, value) => values.set(`${kvId}/${key}`, typeof value === "string" ? value : JSON.stringify(value)),
    close: () => new Promise(r => server.close(r))
  };
}
