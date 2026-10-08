import { test } from "node:test";
import assert from "node:assert/strict";
import { startSite, CLAIM_CODE } from "../helpers/site.mjs";

const page = async (s, headers = {}, path = "/") => {
  const r = await s.mf.dispatchFetch(s.origin + path, { headers });
  return { status: r.status, html: await r.text(), headers: r.headers };
};

test("a site without Cloudflare Access is closed to everyone, and says how its owner opens it", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const p = await page(s, { "x-test-anonymous": "1" });
  assert.equal(p.status, 401);
  assert.match(p.html, /This site is locked/);
  assert.match(p.html, /<details><summary>I'm the owner<\/summary>/);
  assert.match(p.html, /Enable Cloudflare Access/);
  assert.match(p.html, /Manage Cloudflare Access/);
  assert.match(p.html, /<b>your own email address<\/b>/);
  assert.match(p.html, /TestConnect<\/code> <code>claim/);
  // the steps name this Worker, taken from the address it was reached at
  assert.match(p.html, /<b>127<\/b>/);
  assert.match(p.html, /dash\.cloudflare\.com\/\?to=\/:account\/workers\/services\/view\/127\//);
  // none of the app, and no way in
  assert.doesNotMatch(p.html, /<script/i);
  assert.doesNotMatch(p.html, /What can I help with/);
  assert.doesNotMatch(p.html, new RegExp(CLAIM_CODE));
});

test("the locked page is a static page: no script, no network, no framing", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  const p = await page(s, { "x-test-anonymous": "1" });
  const csp = p.headers.get("content-security-policy");
  assert.match(csp, /default-src 'none'/);
  assert.doesNotMatch(csp, /script-src/);
  assert.equal(p.headers.get("x-frame-options"), "DENY");
  assert.equal(p.headers.get("cache-control"), "no-store");
  assert.match(p.html, /noindex/);
});

test("every route is locked, not just the front page", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  for (const path of ["/", "/c/abc12345", "/anything", "/api/state", "/api/update", "/api/limits", "/api/admin/settings", "/a/abcdef123456"]) {
    const r = await s.mf.dispatchFetch(s.origin + path, { method: path.startsWith("/api/admin") ? "POST" : "GET", headers: { "x-test-anonymous": "1", "content-type": "application/json" }, body: path.startsWith("/api/admin") ? "{}" : undefined });
    assert.equal(r.status, 401, path);
    assert.doesNotMatch(await r.text(), /chats|messages|"email"/i, path);
  }
});

test("a signed-in but unclaimed site tells its owner how to claim it, and lets nobody else do anything", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  const p = await page(s);
  assert.equal(p.status, 401);
  assert.match(p.html, /This site has no owner yet/);
  assert.match(p.html, /I'm the owner/);
  assert.match(p.html, /\?claim=…/);
  assert.equal((await s.api("/api/state")).status, 401);
});

test("someone else's Cloudflare account can sign in to Access and still not get in", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  await s.claim();
  const intruder = s.access.sign({ email: "intruder@example.com" });
  const p = await page(s, { "cf-access-token": intruder });
  assert.equal(p.status, 403);
  assert.match(p.html, /You don't have access/);
  assert.match(p.html, /<details>/);
  const api = await s.mf.dispatchFetch(s.origin + "/api/state", { headers: { "cf-access-token": intruder } });
  assert.equal(api.status, 401);
  // their token can't claim it either: the owner's claim is the one that is stored
  const claim = await s.mf.dispatchFetch(s.origin + `/?claim=${CLAIM_CODE}`, { headers: { "cf-access-token": intruder }, redirect: "manual" });
  assert.equal(claim.status, 403);
  assert.equal((await s.api("/api/state")).status, 200, "the owner is still the owner");
});

test("a sign-in that can't be verified asks to sign in again, without the owner steps", async t => {
  const s = await startSite();
  t.after(() => s.stop());
  const p = await page(s, { "cf-access-token": "not.a.jwt" });
  assert.equal(p.status, 401);
  assert.match(p.html, /Sign in again/);
  assert.doesNotMatch(p.html, /I'm the owner/);
});

test("the site's name in the lock page can't be used to inject markup", async t => {
  const s = await startSite({ vars: { SITE_NAME: '<img src=x onerror=alert(1)>' } });
  t.after(() => s.stop());
  const p = await page(s, { "x-test-anonymous": "1" });
  assert.doesNotMatch(p.html, /<img src=x/);
  assert.match(p.html, /&lt;img src=x/);
});
