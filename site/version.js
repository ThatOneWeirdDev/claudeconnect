const VERSION_RE = /^v?(\d{1,6})\.(\d{1,6})\.(\d{1,6})(?:-([0-9A-Za-z.-]{1,32}))?$/;

export function parseVersion(v) {
  const m = VERSION_RE.exec(String(v == null ? "" : v).trim());
  return m ? { parts: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] || "" } : null;
}

// -1, 0 or 1. Anything that isn't a version sorts below every real version.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return x ? 1 : y ? -1 : 0;
  for (let i = 0; i < 3; i++) if (x.parts[i] !== y.parts[i]) return x.parts[i] > y.parts[i] ? 1 : -1;
  if (x.pre === y.pre) return 0;
  if (!x.pre) return 1;
  if (!y.pre) return -1;
  return x.pre > y.pre ? 1 : -1;
}

export function isNewer(latest, current) {
  return !!parseVersion(latest) && compareVersions(latest, current) > 0;
}

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const REF_RE = /^[A-Za-z0-9_][A-Za-z0-9_./-]{0,99}$/;

export function validRepo(s) {
  return typeof s === "string" && REPO_RE.test(s) && !s.includes("..");
}

export function validRef(s) {
  return typeof s === "string" && REF_RE.test(s) && !s.includes("..");
}

// A release manifest is data from the internet: keep only what the site shows or compares.
export function cleanManifest(j) {
  if (!j || typeof j !== "object" || !parseVersion(j.version)) return null;
  const notes = (Array.isArray(j.notes) ? j.notes : []).filter(n => typeof n === "string" && n.trim()).slice(0, 12).map(n => n.trim().slice(0, 240));
  return { version: String(j.version).replace(/^v/, ""), released: typeof j.released === "string" ? j.released.slice(0, 32) : "", notes };
}
