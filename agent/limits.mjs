// Limit resets, as Claude reports them to Claude Code, read with Claude Code's sign-in for Plan usage on the site. There are
// two kinds:
// - cedar_ember: resets Claude gives you to use whenever you like, in grants. Only the grant Claude names next can be used,
//   and only while it says it's usable now.
// - juniper_tide: once a week, a reset of the session limit. Claude only reports it while you're at a limit.
export function resetsFrom(u) {
  const out = [];
  const num = v => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const str = v => (typeof v === "string" ? v : "");
  const list = v => (Array.isArray(v) ? v.filter(c => typeof c === "string") : []);
  const r = u && u.cedar_ember;
  if (r && typeof r === "object") {
    const grants = (Array.isArray(r.grants) ? r.grants : []).filter(g => g && typeof g.id === "string" && num(g.resets_left) !== null);
    out.push({
      program: "cedar_ember",
      eligible: r.eligible === true,
      atLimit: r.at_limit === true,
      cooldownUntil: str(r.cooldown_until),
      grants: grants.map(g => ({
        id: g.id,
        label: str(g.label),
        left: g.resets_left,
        total: num(g.resets_total),
        usableNow: g.usable_now === true,
        // Claude Code takes a grant that doesn't say as one that needs a limit reached first
        needsLimit: g.use_requires_limit !== false,
        paused: g.paused === true,
        endsAt: str(g.ends_at),
        clears: list(g.clears),
        // limits it doesn't clear that are used up, so it can't be used until they reset
        blocking: list(g.blocking),
        next: g.id === r.next_grant_id,
        every: refillEvery(g),
        nextAt: str(g.next_grant_at || g.refreshes_at || g.renews_at || g.next_refill_at || g.refills_at)
      }))
    });
  }
  // Claude Code only offers this one to accounts in its "reset" arm
  const w = u && u.juniper_tide;
  if (w && typeof w === "object" && w.eligible === true && w.arm === "reset") {
    out.push({
      program: "juniper_tide",
      eligible: true,
      atLimit: true,
      cooldownUntil: "",
      grants: [{ id: "session", label: "Session limit reset", left: w.available === true ? 1 : 0, total: num(w.resets_per_week), usableNow: w.available === true, needsLimit: true, paused: false, endsAt: "", clears: ["five_hour"], blocking: [], next: true, every: "week", nextAt: str(w.next_available_at) }]
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
