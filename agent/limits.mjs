// Limit resets, as Claude reports them for a reset program (cedar_ember and the like), with how often a grant comes back when
// Claude says: read with Claude Code's sign-in, for Plan usage on the site.
export function resetsFrom(u) {
  const out = [];
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = v => (typeof v === "string" ? v : "");
  for (const program of ["cedar_ember", "juniper_tide"]) {
    const r = u && u[program];
    if (!r || typeof r !== "object" || !Array.isArray(r.grants)) continue;
    out.push({
      program,
      eligible: r.eligible === true,
      atLimit: r.at_limit === true,
      cooldownUntil: str(r.cooldown_until),
      grants: r.grants.filter(g => g && typeof g.id === "string").map(g => ({
        id: g.id,
        label: str(g.label),
        left: num(g.resets_left),
        total: num(g.resets_total),
        usableNow: g.usable_now === true,
        needsLimit: g.use_requires_limit === true,
        paused: g.paused === true,
        endsAt: str(g.ends_at),
        clears: Array.isArray(g.clears) ? g.clears.filter(c => typeof c === "string") : [],
        every: refillEvery(g),
        nextAt: str(g.next_grant_at || g.refreshes_at || g.renews_at || g.next_refill_at || g.refills_at)
      }))
    });
  }
  return out;
}

// "day", "week" or "month": how often a reset grant fills up again, from whatever Claude calls it, or "".
export function refillEvery(g) {
  const said = [g.period, g.cadence, g.interval, g.refresh_period, g.refill_period, g.refresh_interval, g.frequency].find(v => typeof v === "string" && v);
  const days = [g.period_days, g.interval_days, g.refill_interval_days, g.refresh_interval_days].find(v => typeof v === "number" && v > 0);
  const hint = String(said || "") + " " + String(g.label || "");
  if (/\bdai|\bday|\b24 ?h/i.test(hint) || days === 1) return "day";
  if (/week|7 ?d/i.test(hint) || days === 7) return "week";
  if (/month/i.test(hint) || (days >= 28 && days <= 31)) return "month";
  return "";
}
