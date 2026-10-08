// Names and addresses. Shared by the site (to check what the owner typed) and the installer (to act on it).

export const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
export const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

export function toSlug(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 63).replace(/-+$/, "");
}

// The text a person typed, with whitespace tidied. Returns "" when it isn't a usable site name.
export function cleanSiteName(v) {
  if (typeof v !== "string") return "";
  const n = v.trim().replace(/\s+/g, " ");
  return NAME_RE.test(n) && toSlug(n) ? n : "";
}

// The part of a workers.dev address a person can choose. Returns "" when it can't be one.
export function cleanAddress(v) {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  return SLUG_RE.test(s) ? s : "";
}
