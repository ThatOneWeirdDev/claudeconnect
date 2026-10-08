// Turns the stored per-run usage rows and reply timestamps into the daily and weekly series the chart draws.
// Pure functions, no runtime APIs beyond Intl, so the same code runs in the Worker and under node --test.

const DAY = 86400000;

export function validZone(tz) {
  if (typeof tz !== "string" || !tz || tz.length > 64) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return tz;
  } catch {
    return "UTC";
  }
}

function dayFormatter(timeZone) {
  const f = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  return ts => {
    let y = "";
    let m = "";
    let d = "";
    for (const p of f.formatToParts(new Date(ts))) {
      if (p.type === "year") y = p.value;
      else if (p.type === "month") m = p.value;
      else if (p.type === "day") d = p.value;
    }
    return `${y.padStart(4, "0")}-${m}-${d}`;
  };
}

function keyToUtc(key) {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function utcToKey(ms) {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(key, n) {
  return utcToKey(keyToUtc(key) + n * DAY);
}

// The Monday on or before this date.
export function weekStart(key) {
  const dow = new Date(keyToUtc(key)).getUTCDay();
  return addDays(key, -((dow + 6) % 7));
}

const empty = key => ({ key, replies: 0, input: 0, output: 0, cached: 0, tokens: 0, cost: 0 });

function add(b, r) {
  b.input += r.input;
  b.output += r.output;
  b.cached += r.cacheRead;
  b.tokens += r.input + r.output;
  b.cost += r.cost;
}

function sum(list, key) {
  const t = empty(key);
  for (const b of list) {
    t.replies += b.replies;
    t.input += b.input;
    t.output += b.output;
    t.cached += b.cached;
    t.tokens += b.tokens;
    t.cost += b.cost;
  }
  return t;
}

const num = v => (Number.isFinite(v) && v > 0 ? v : 0);

// rows: [{ ts, model, input, output, cache_read, cache_write, cost }]  (input excludes cache writes, as the CLI reports it)
// replyTimes: [ms] one per assistant message
export function buildUsage({ rows, replyTimes, now, timeZone, days = 30, weeks = 12 }) {
  const tz = validZone(timeZone);
  const keyOf = dayFormatter(tz);
  const today = keyOf(now);
  const dayKeys = [];
  for (let i = days - 1; i >= 0; i--) dayKeys.push(addDays(today, -i));
  const thisWeek = weekStart(today);
  const weekKeys = [];
  for (let i = weeks - 1; i >= 0; i--) weekKeys.push(addDays(thisWeek, -7 * i));
  const daily = new Map(dayKeys.map(k => [k, empty(k)]));
  const weekly = new Map(weekKeys.map(k => [k, empty(k)]));
  const first = weekKeys[0];
  const models = new Map();
  let trackedSince = null;

  const bucketsFor = ts => {
    const k = keyOf(ts);
    return { day: daily.get(k), week: k >= first ? weekly.get(weekStart(k)) : null };
  };

  for (const t of replyTimes || []) {
    if (!Number.isFinite(t)) continue;
    const { day, week } = bucketsFor(t);
    if (day) day.replies++;
    if (week) week.replies++;
  }
  for (const raw of rows || []) {
    const r = {
      ts: Number(raw.ts),
      model: String(raw.model || ""),
      input: num(raw.input) + num(raw.cache_write),
      output: num(raw.output),
      cacheRead: num(raw.cache_read),
      cost: num(raw.cost)
    };
    if (!Number.isFinite(r.ts)) continue;
    if (trackedSince === null || r.ts < trackedSince) trackedSince = r.ts;
    const { day, week } = bucketsFor(r.ts);
    if (day) {
      add(day, r);
      const m = models.get(r.model) || { model: r.model, tokens: 0, cost: 0, input: 0, output: 0 };
      m.tokens += r.input + r.output;
      m.input += r.input;
      m.output += r.output;
      m.cost += r.cost;
      models.set(r.model, m);
    }
    if (week) add(week, r);
  }

  const dailyList = dayKeys.map(k => daily.get(k));
  const weeklyList = weekKeys.map(k => weekly.get(k));
  return {
    timeZone: tz,
    today,
    thisWeek,
    trackedSince,
    daily: dailyList,
    weekly: weeklyList,
    totals: { today: daily.get(today), week: weekly.get(thisWeek), month: sum(dailyList, "30d") },
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || b.cost - a.cost).slice(0, 8)
  };
}
