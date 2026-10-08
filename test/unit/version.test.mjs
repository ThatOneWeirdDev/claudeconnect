import { test } from "node:test";
import assert from "node:assert/strict";
import { parseVersion, compareVersions, isNewer, validRepo, validRef, cleanManifest } from "../../site/version.js";

test("versions compare numerically, not as text", () => {
  assert.equal(compareVersions("1.10.0", "1.9.0"), 1);
  assert.equal(compareVersions("1.2.0", "1.2.0"), 0);
  assert.equal(compareVersions("v2.0.0", "1.99.99"), 1);
  assert.equal(compareVersions("1.2.3", "1.2.4"), -1);
});

test("a pre-release sorts below its release, and junk sorts below everything", () => {
  assert.equal(compareVersions("1.3.0-beta.1", "1.3.0"), -1);
  assert.equal(compareVersions("1.3.0", "1.3.0-beta.1"), 1);
  assert.equal(compareVersions("garbage", "0.0.1"), -1);
  assert.equal(compareVersions("", ""), 0);
  assert.equal(parseVersion("1.2"), null);
  assert.equal(parseVersion("1.2.3; rm -rf"), null);
});

test("only a strictly newer real version counts as an update", () => {
  assert.equal(isNewer("1.2.1", "1.2.0"), true);
  assert.equal(isNewer("1.2.0", "1.2.0"), false);
  assert.equal(isNewer("1.1.9", "1.2.0"), false);
  assert.equal(isNewer("nonsense", "1.2.0"), false);
  assert.equal(isNewer("1.0.0", "0.0.0"), true);
});

test("repo and ref values can't smuggle anything into a URL", () => {
  assert.equal(validRepo("ThatOneWeirdDev/claudeconnect"), true);
  for (const bad of ["a/b/c", "a", "../x/y", "a/b?x=1", "a b/c", "", null, "a/.."]) assert.equal(validRepo(bad), false, String(bad));
  for (const ok of ["main", "v1.2.0", "release/1.2", "3f2a9c1"]) assert.equal(validRef(ok), true, ok);
  for (const bad of ["", "../x", "a b", "a?b", "-x", "a#b", null]) assert.equal(validRef(bad), false, String(bad));
});

test("a manifest from the internet is trimmed down to what the site shows", () => {
  const m = cleanManifest({ version: "v1.3.0", released: "2026-11-01", notes: ["  One  ", "", 5, "x".repeat(500)], files: { evil: 1 }, extra: "<script>" });
  assert.deepEqual(Object.keys(m).sort(), ["notes", "released", "version"]);
  assert.equal(m.version, "1.3.0");
  assert.equal(m.notes[0], "One");
  assert.equal(m.notes.length, 2);
  assert.equal(m.notes[1].length, 240);
  assert.equal(cleanManifest({ version: "nope" }), null);
  assert.equal(cleanManifest(null), null);
  assert.equal(cleanManifest([]), null);
});

import { cleanSiteName, cleanAiName, cleanAddress, toSlug } from "../../site/names.js";
import { sniffImage, decodeBase64, checkImage, MAX_IMG } from "../../site/image.js";

test("site names, AI names and addresses are only ever text, and only the allowed text", () => {
  assert.equal(cleanSiteName("  My   Site "), "My Site");
  assert.equal(cleanSiteName("Mine_2.0-final"), "Mine_2.0-final");
  for (const bad of ["", "-x", " ", "x".repeat(41), "a/b", "a<b", "é", 42, null, undefined, {}, ["a"]]) assert.equal(cleanSiteName(bad), "", String(bad));
  assert.equal(cleanAiName("  Buddy\n\r the  bot "), "Buddy the bot");
  assert.equal(cleanAiName("x".repeat(100)).length, 60);
  assert.equal(cleanAiName(42), "");
  assert.equal(cleanAddress("  My-Site "), "my-site");
  for (const bad of ["", "-a", "a-", "a_b", "a b", "a.b", "a".repeat(64), 5, null]) assert.equal(cleanAddress(bad), "", String(bad));
  assert.equal(toSlug("My Site!"), "my-site");
});

test("images are recognised by their bytes, never by what they claim to be", () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  assert.equal(sniffImage(png), "image/png");
  assert.equal(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0])), "image/jpeg");
  assert.equal(sniffImage(Buffer.from("GIF89a....")), "image/gif");
  assert.equal(sniffImage(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffImage(Buffer.from([0, 0, 1, 0, 1, 0])), "image/x-icon");
  assert.equal(sniffImage(Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>')), "image/svg+xml");
  assert.equal(sniffImage(Buffer.from("<html><script>alert(1)</script></html>")), null);
  assert.equal(sniffImage(Buffer.from("MZ\x90\x00 an executable")), null);
  assert.equal(sniffImage(Buffer.from([1, 2])), null);
  assert.equal(decodeBase64("!!"), null);
  assert.equal(decodeBase64(""), null);
  assert.equal(decodeBase64(png.toString("base64url")).length, png.length, "url-safe base64 works too");
  assert.equal(checkImage(png.toString("base64")).type, "image/png");
  assert.match(checkImage(Buffer.from("plain text").toString("base64")).error, /isn't a PNG/);
  assert.match(checkImage(Buffer.alloc(MAX_IMG + 1, 0x89).toString("base64")).error, /512 KB|couldn't be read/);
});
