// A stand-in for raw.githubusercontent.com that serves a release built from a map of files.
import http from "node:http";
import crypto from "node:crypto";

const sha = b => crypto.createHash("sha256").update(b).digest("hex");

export function buildRelease(files, version = "1.2.0", extra = {}) {
  const manifest = { name: "claudeconnect", version, released: "2026-10-08", notes: ["Something new"], files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(Buffer.from(v))])), ...extra };
  return { manifest, files, manifestText: JSON.stringify(manifest, null, 2) + "\n" };
}

// opts.staleManifest: serve this manifest text until a ?cb= cache-buster shows up (GitHub's CDN being a few minutes behind)
// opts.corrupt: { path: bytes } served instead of the real file
export async function startGithub(release, opts = {}) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    hits.push(req.url);
    // GitHub's API: which commit a branch is on (opts.sha)
    const api = /^\/api\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)$/.exec(url.pathname);
    if (api) return opts.sha ? res.writeHead(200).end(opts.sha) : res.writeHead(404).end();
    const m = /^\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!m) return res.writeHead(404).end();
    const path = decodeURIComponent(m[3]);
    if (path === "manifest.json") {
      // opts.staleBranch: the branch's cached manifest, whatever the query string; only a commit's own files are fresh
      if (opts.staleBranch && m[2] !== opts.sha) return res.writeHead(200).end(opts.staleBranch);
      if (opts.staleManifest && !url.searchParams.has("cb")) return res.writeHead(200).end(opts.staleManifest);
      return res.writeHead(200).end(release.manifestText);
    }
    if (opts.corrupt && opts.corrupt[path] !== undefined) return res.writeHead(200).end(opts.corrupt[path]);
    if (path in release.files) return res.writeHead(200).end(release.files[path]);
    res.writeHead(404).end("not found");
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(r => server.close(r)) };
}

// A site that records what the updater tells it.
export async function startFakeSite() {
  const posts = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", d => (body += d));
    req.on("end", () => {
      if (req.url === "/agent/progress" && req.method === "POST") {
        posts.push({ headers: req.headers, body: JSON.parse(body) });
        res.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
      } else res.writeHead(404).end();
    });
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, close: () => new Promise(r => server.close(r)) };
}

// Serves this repository's own files the way GitHub would, so the real loader and installer run against the real release.
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export async function startRepo(root) {
  const hits = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    hits.push(url.pathname);
    const m = /^\/([^/]+\/[^/]+)\/([^/]+)\/(.+)$/.exec(url.pathname);
    const path = m && decodeURIComponent(m[3]);
    if (!path || path.includes("..") || !existsSync(join(root, path))) return res.writeHead(404).end("not found");
    res.writeHead(200).end(readFileSync(join(root, path)));
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise(r => server.close(r)) };
}
