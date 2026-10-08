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
