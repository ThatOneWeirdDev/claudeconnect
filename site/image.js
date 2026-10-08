// Logo and tab-icon checks. No Buffer or Node APIs, so the same code runs in the Worker and in the installer.

export const MAX_IMG = 512 * 1024;

const ascii = (b, from, to) => {
  let s = "";
  for (let i = from; i < Math.min(to, b.length); i++) s += String.fromCharCode(b[i]);
  return s;
};

// The image type from the file's own first bytes, or null. A name or a declared type is never trusted.
export function sniffImage(b) {
  if (!b || b.length < 4) return null;
  if (b[0] === 0x89 && ascii(b, 1, 4) === "PNG") return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (ascii(b, 0, 4) === "GIF8") return "image/gif";
  if (b.length > 12 && ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP") return "image/webp";
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0) return "image/x-icon";
  const head = ascii(b, 0, 1024).replace(/^﻿/, "").trimStart().toLowerCase();
  if (/^(<svg|<\?xml|<!--|<!doctype svg)/.test(head) && ascii(b, 0, b.length).toLowerCase().includes("<svg")) return "image/svg+xml";
  return null;
}

export function decodeBase64(s) {
  if (typeof s !== "string" || !s || s.length > Math.ceil((MAX_IMG * 4) / 3) + 8) return null;
  let t = s.replace(/-/g, "+").replace(/_/g, "/");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(t)) return null;
  while (t.length % 4) t += "=";
  try {
    const bin = atob(t);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

// { type, b64 } for an image that is allowed, or { error } saying why not.
export function checkImage(b64) {
  const bytes = decodeBase64(b64);
  if (!bytes) return { error: "that image couldn't be read" };
  if (bytes.length > MAX_IMG) return { error: "it's bigger than 512 KB" };
  const type = sniffImage(bytes);
  if (!type) return { error: "it isn't a PNG, JPEG, GIF, WebP, ICO or SVG image" };
  return { type, b64: String(b64).replace(/\s+/g, "") };
}
