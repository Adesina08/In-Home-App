// Deterministic calculations behind the study-recipe KPIs (lib/studyRecipes.js).
//
// Every function reads the same study report the dashboards already use
// (submitted, non-practice, QC-cleared entries from the consenting cohort)
// and returns { value, display, basis, breakdown, base } -- `base` being the
// number of distinct participants the figure rests on, which the client view
// uses to suppress small bases. No AI is involved here: the AI only chose
// which questions feed `inputs`, and a researcher approved that choice.

const { percent } = require("./researchMetrics");
const { segmentValue } = require("./staffAnalysis");

const round = (n, dp = 1) => (Number.isFinite(n) ? Math.round(n * 10 ** dp) / 10 ** dp : null);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const EMPTY = (basis) => ({ value: null, display: "—", basis, breakdown: [], base: 0 });

// A time-of-day answer ("07:45") becomes a daypart, so a study that asked
// "What time?" still reports dayparts.
function daypartOf(value) {
  const match = /^(\d{1,2}):(\d{2})/.exec(String(value || ""));
  if (!match) return null;
  const hour = Number(match[1]);
  if (hour >= 5 && hour < 11) return "Breakfast (5–11am)";
  if (hour >= 11 && hour < 15) return "Lunch (11am–3pm)";
  if (hour >= 15 && hour < 18) return "Afternoon (3–6pm)";
  if (hour >= 18 && hour < 22) return "Dinner (6–10pm)";
  return "Late night (10pm–5am)";
}

/**
 * Context shared by every KPI on a page: the report, the question families
 * (a question plus its loop repeats, matched on source_code) and profiles.
 */
function context(report, profiles) {
  const questions = new Map(report.questions.map((q) => [q.id, q]));
  const familyIds = new Map();
  const familyOf = (questionId) => {
    if (familyIds.has(questionId)) return familyIds.get(questionId);
    const q = questions.get(questionId);
    const code = q && (q.source_code || q.code);
    const ids = q ? report.questions.filter((other) => other.id === q.id || (code && (other.source_code || other.code) === code)).map((other) => other.id) : [];
    familyIds.set(questionId, ids);
    return ids;
  };
  return { report, questions, familyOf, profiles: profiles || new Map(), unit: "participants" };
}

function input(mapping, role) {
  const value = mapping && mapping.inputs && mapping.inputs[role];
  return value && value.question_id ? value : null;
}

function valuesOf(ctx, entry, questionId) {
  const isTime = ctx.questions.get(questionId)?.type === "time";
  const out = new Set();
  for (const id of ctx.familyOf(questionId)) {
    const raw = entry.answers[id];
    if (raw === undefined || raw === null) continue;
    for (const part of String(raw).split("|").map((v) => v.trim()).filter(Boolean)) {
      const value = isTime ? daypartOf(part) : part;
      if (value) out.add(value);
    }
  }
  return [...out];
}

// Loop repeats of a numeric question (e.g. quantity per brand) add up.
function numberOf(ctx, entry, questionId) {
  let total = null;
  for (const id of ctx.familyOf(questionId)) {
    const raw = entry.answers[id];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) total = (total || 0) + n;
  }
  return total;
}

const people = (entries) => new Set(entries.map((e) => e.respondentId));
const isNumeric = (ctx, questionId) => ["numeric", "scale"].includes(ctx.questions.get(questionId)?.type);

/** Entries where an input "counts": chosen options for a choice question, > 0 for a number, answered otherwise. */
function matching(ctx, entries, spec) {
  if (isNumeric(ctx, spec.question_id)) return entries.filter((e) => (numberOf(ctx, e, spec.question_id) || 0) > 0);
  const targets = (spec.options || []).filter(Boolean);
  return entries.filter((e) => {
    const values = valuesOf(ctx, e, spec.question_id);
    return targets.length ? values.some((v) => targets.includes(v)) : values.length > 0;
  });
}

function breakdownOf(counts, total) {
  return [...counts].map(([label, n]) => ({ label, n, pct: percent(n, total) }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
}

function topDisplay(breakdown) {
  return breakdown.length ? `${breakdown[0].label} · ${breakdown[0].pct}%` : "—";
}

const CALCS = {
  penetration(ctx, kpi, mapping) {
    const cohort = ctx.report.respondents.length;
    if (!cohort) return EMPTY(`no ${ctx.unit} yet`);
    const spec = input(mapping, "category");
    const consumed = people(spec ? matching(ctx, ctx.report.entries, spec) : ctx.report.entries);
    const pct = percent(consumed.size, cohort);
    return { value: pct, display: `${pct}%`, basis: `${consumed.size} of ${cohort} ${ctx.unit}${spec ? "" : " logged an occasion"}`, breakdown: [], base: cohort };
  },

  occasions_per_week(ctx) {
    const value = ctx.report.analytics.avg_occasions_per_week;
    if (value === null || value === undefined) return EMPTY("no participation days yet");
    const entries = ctx.report.entries;
    return { value, display: `${value} per week`, basis: `${plural(entries.length, "occasion")} from ${plural(people(entries).size, ctx.unit.replace(/s$/, ""), ctx.unit)}`, breakdown: [], base: people(entries).size };
  },

  trend(ctx) {
    const weeks = new Map();
    for (const e of ctx.report.entries) {
      const day = new Date(`${String(e.occurredAt || "").slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(day.getTime())) continue;
      day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); // Monday
      const key = day.toISOString().slice(0, 10);
      if (!weeks.has(key)) weeks.set(key, []);
      weeks.get(key).push(e);
    }
    const ordered = [...weeks].sort(([a], [b]) => a.localeCompare(b));
    if (ordered.length < 2) return { ...EMPTY("needs entries in two different weeks"), base: people(ctx.report.entries).size };
    const [[prevWeek, prev], [lastWeek, last]] = ordered.slice(-2);
    const change = round(((last.length - prev.length) / prev.length) * 100, 0);
    return {
      value: change, display: `${change > 0 ? "+" : ""}${change}%`,
      basis: `week of ${lastWeek}: ${plural(last.length, "occasion")} vs ${prev.length} in week of ${prevWeek}`,
      breakdown: ordered.map(([week, list]) => ({ label: `Week of ${week}`, n: list.length, pct: null })),
      base: Math.min(people(prev).size, people(last).size),
    };
  },

  distribution(ctx, kpi, mapping) {
    const spec = input(mapping, kpi.inputs[0].role);
    const counts = new Map();
    const answered = [];
    for (const e of ctx.report.entries) {
      const values = valuesOf(ctx, e, spec.question_id);
      if (!values.length) continue;
      answered.push(e);
      for (const v of values) counts.set(v, (counts.get(v) || 0) + 1);
    }
    if (!answered.length) return EMPTY("nobody has answered this yet");
    const breakdown = breakdownOf(counts, answered.length);
    return { value: breakdown[0].pct, display: topDisplay(breakdown), basis: `${plural(answered.length, "answered occasion")}`, breakdown, base: people(answered).size };
  },

  brand_penetration(ctx, kpi, mapping) {
    const spec = input(mapping, "brand");
    const cohort = ctx.report.respondents.length;
    if (!cohort) return EMPTY(`no ${ctx.unit} yet`);
    const byBrand = new Map();
    for (const e of ctx.report.entries) for (const brand of valuesOf(ctx, e, spec.question_id)) {
      if (!byBrand.has(brand)) byBrand.set(brand, new Set());
      byBrand.get(brand).add(e.respondentId);
    }
    if (!byBrand.size) return EMPTY("no brand answers yet");
    const breakdown = [...byBrand].map(([label, set]) => ({ label, n: set.size, pct: percent(set.size, cohort) }))
      .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
    return { value: breakdown[0].pct, display: topDisplay(breakdown), basis: `of ${cohort} ${ctx.unit}`, breakdown, base: cohort };
  },

  share_of_occasions(ctx, kpi, mapping) {
    return CALCS.distribution(ctx, kpi, mapping);
  },

  repertoire(ctx, kpi, mapping) {
    const spec = input(mapping, kpi.inputs[0].role);
    const byPerson = new Map();
    for (const e of ctx.report.entries) {
      const values = valuesOf(ctx, e, spec.question_id);
      if (!values.length) continue;
      if (!byPerson.has(e.respondentId)) byPerson.set(e.respondentId, new Set());
      values.forEach((v) => byPerson.get(e.respondentId).add(v));
    }
    if (!byPerson.size) return EMPTY("nobody has answered this yet");
    const avg = round([...byPerson.values()].reduce((sum, set) => sum + set.size, 0) / byPerson.size);
    return { value: avg, display: `${avg} ${kpi.unit || "options"}`, basis: `across ${plural(byPerson.size, ctx.unit.replace(/s$/, ""), ctx.unit)}`, breakdown: [], base: byPerson.size };
  },

  switching(ctx, kpi, mapping) {
    const spec = input(mapping, "brand");
    const sequences = new Map();
    const sorted = [...ctx.report.entries].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || a.recordId - b.recordId);
    for (const e of sorted) {
      const values = valuesOf(ctx, e, spec.question_id);
      if (values.length !== 1) continue;
      if (!sequences.has(e.respondentId)) sequences.set(e.respondentId, []);
      sequences.get(e.respondentId).push(values[0]);
    }
    let transitions = 0, switches = 0;
    const contributors = new Set();
    for (const [person, list] of sequences) for (let i = 1; i < list.length; i++) {
      transitions++; contributors.add(person);
      if (list[i] !== list[i - 1]) switches++;
    }
    if (!transitions) return EMPTY("needs two single-brand occasions from the same participant");
    const pct = percent(switches, transitions);
    return { value: pct, display: `${pct}%`, basis: `${switches} of ${plural(transitions, "consecutive occasion")} changed brand`, breakdown: [], base: contributors.size };
  },

  main_brand(ctx, kpi, mapping) {
    const spec = input(mapping, "brand");
    const counts = new Map();
    for (const e of ctx.report.entries) for (const brand of valuesOf(ctx, e, spec.question_id)) {
      if (!counts.has(e.respondentId)) counts.set(e.respondentId, new Map());
      const mine = counts.get(e.respondentId);
      mine.set(brand, (mine.get(brand) || 0) + 1);
    }
    if (!counts.size) return EMPTY("no brand answers yet");
    const main = new Map();
    for (const mine of counts.values()) {
      const [brand] = [...mine].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
      main.set(brand, (main.get(brand) || 0) + 1);
    }
    const breakdown = breakdownOf(main, counts.size);
    return { value: breakdown[0].pct, display: topDisplay(breakdown), basis: `main brand of ${plural(counts.size, ctx.unit.replace(/s$/, ""), ctx.unit)}`, breakdown, base: counts.size };
  },

  average(ctx, kpi, mapping) {
    const spec = input(mapping, kpi.inputs[0].role);
    const rows = ctx.report.entries.map((e) => [e, numberOf(ctx, e, spec.question_id)]).filter(([, n]) => n !== null);
    if (!rows.length) return EMPTY("no numbers recorded yet");
    const mean = round(rows.reduce((sum, [, n]) => sum + n, 0) / rows.length);
    return { value: mean, display: String(mean), basis: `across ${plural(rows.length, "answered occasion")}`, breakdown: [], base: people(rows.map(([e]) => e)).size };
  },

  total(ctx, kpi, mapping) {
    const spec = input(mapping, kpi.inputs[0].role);
    const rows = ctx.report.entries.map((e) => [e, numberOf(ctx, e, spec.question_id)]).filter(([, n]) => n !== null);
    if (!rows.length) return EMPTY("no numbers recorded yet");
    const sum = round(rows.reduce((acc, [, n]) => acc + n, 0));
    return { value: sum, display: String(sum), basis: `summed over ${plural(rows.length, "answered occasion")}`, breakdown: [], base: people(rows.map(([e]) => e)).size };
  },

  per_respondent_total(ctx, kpi, mapping) {
    const spec = input(mapping, kpi.inputs[0].role);
    const byPerson = new Map();
    for (const e of ctx.report.entries) {
      const n = numberOf(ctx, e, spec.question_id);
      if (n !== null) byPerson.set(e.respondentId, (byPerson.get(e.respondentId) || 0) + n);
    }
    if (!byPerson.size) return EMPTY("no numbers recorded yet");
    const avg = round([...byPerson.values()].reduce((a, b) => a + b, 0) / byPerson.size);
    return { value: avg, display: String(avg), basis: `per ${ctx.unit.replace(/s$/, "")}, across ${byPerson.size} ${ctx.unit}`, breakdown: [], base: byPerson.size };
  },

  ratio(ctx, kpi, mapping) {
    const top = input(mapping, kpi.inputs[0].role), bottom = input(mapping, kpi.inputs[1].role);
    let a = 0, b = 0;
    const used = [];
    for (const e of ctx.report.entries) {
      const x = numberOf(ctx, e, top.question_id), y = numberOf(ctx, e, bottom.question_id);
      if (x === null || y === null || y <= 0) continue;
      a += x; b += y; used.push(e);
    }
    if (!used.length || !b) return EMPTY("needs occasions that answered both questions");
    const value = round(a / b, 2);
    return { value, display: String(value), basis: `${round(a, 2)} / ${round(b, 2)} over ${plural(used.length, "occasion")}`, breakdown: [], base: people(used).size };
  },

  per_capita(ctx, kpi, mapping) {
    const volumeSpec = input(mapping, "quantity"), sizeSpec = input(mapping, "household_size");
    const volume = new Map(), size = new Map();
    const sorted = [...ctx.report.entries].sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)));
    for (const e of sorted) {
      const v = numberOf(ctx, e, volumeSpec.question_id), s = numberOf(ctx, e, sizeSpec.question_id);
      if (v !== null) volume.set(e.respondentId, (volume.get(e.respondentId) || 0) + v);
      if (s !== null && s > 0) size.set(e.respondentId, s); // latest answer wins
    }
    const households = [...volume.keys()].filter((id) => size.has(id));
    if (!households.length) return EMPTY("needs households that answered both questions");
    const avg = round(households.reduce((sum, id) => sum + volume.get(id) / size.get(id), 0) / households.length, 2);
    return { value: avg, display: String(avg), basis: `per household member, across ${plural(households.length, "household")}`, breakdown: [], base: households.length };
  },

  measure(ctx, kpi, mapping) {
    const spec = input(mapping, kpi.inputs[0].role);
    if (isNumeric(ctx, spec.question_id)) return CALCS.average(ctx, kpi, mapping);
    if (!(spec.options || []).length) return CALCS.distribution(ctx, kpi, mapping);
    const answered = ctx.report.entries.filter((e) => valuesOf(ctx, e, spec.question_id).length);
    if (!answered.length) return EMPTY("nobody has answered this yet");
    const hits = matching(ctx, answered, spec);
    const pct = percent(hits.length, answered.length);
    return { value: pct, display: `${pct}%`, basis: `${hits.length} of ${plural(answered.length, "answered occasion")}`, breakdown: [], base: people(answered).size };
  },

  purchase_rate(ctx, kpi, mapping) {
    const cohort = ctx.report.respondents.length;
    if (!cohort) return EMPTY(`no ${ctx.unit} yet`);
    const purchases = matching(ctx, ctx.report.entries, input(mapping, "purchase"));
    const avg = round(purchases.length / cohort, 2);
    return { value: avg, display: `${avg} per ${ctx.unit.replace(/s$/, "")}`, basis: `${plural(purchases.length, "purchase occasion")} across ${cohort} ${ctx.unit}`, breakdown: [], base: cohort };
  },

  repurchase_cycle(ctx, kpi, mapping) {
    const purchases = matching(ctx, ctx.report.entries, input(mapping, "purchase"));
    const days = new Map();
    for (const e of purchases) {
      const day = String(e.occurredAt || "").slice(0, 10);
      if (!day) continue;
      if (!days.has(e.respondentId)) days.set(e.respondentId, new Set());
      days.get(e.respondentId).add(day);
    }
    const gaps = [];
    const contributors = new Set();
    for (const [person, set] of days) {
      const ordered = [...set].sort();
      for (let i = 1; i < ordered.length; i++) {
        gaps.push((Date.parse(ordered[i]) - Date.parse(ordered[i - 1])) / 86400000);
        contributors.add(person);
      }
    }
    if (!gaps.length) return EMPTY("needs two purchase days from the same household");
    const avg = round(gaps.reduce((a, b) => a + b, 0) / gaps.length);
    return { value: avg, display: `${avg} days`, basis: `${plural(gaps.length, "gap")} across ${plural(contributors.size, "household")}`, breakdown: [], base: contributors.size };
  },

  profile_split(ctx, kpi) {
    const consumers = people(ctx.report.entries);
    if (!consumers.size) return EMPTY(`no ${ctx.unit} have logged an occasion yet`);
    const byId = new Map(ctx.report.respondents.map((r) => [r.id, r]));
    const counts = new Map();
    for (const id of consumers) {
      const label = segmentValue(ctx.profiles.get(id) || byId.get(id) || {}, kpi.segment);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    const breakdown = breakdownOf(counts, consumers.size);
    return { value: breakdown[0].pct, display: topDisplay(breakdown), basis: `of ${plural(consumers.size, "consuming " + ctx.unit.replace(/s$/, ""), "consuming " + ctx.unit)}`, breakdown, base: consumers.size };
  },

  usage_tiers(ctx) {
    const counts = new Map();
    for (const e of ctx.report.entries) counts.set(e.respondentId, (counts.get(e.respondentId) || 0) + 1);
    if (counts.size < 3) return { ...EMPTY("needs at least three households with occasions"), base: counts.size };
    const ordered = [...counts.values()].sort((a, b) => b - a);
    const total = ordered.reduce((a, b) => a + b, 0);
    // Balanced thirds: 4 households split 2 / 1 / 1, never 2 / 2 / 0.
    const heavy = Math.ceil(ordered.length / 3), light = Math.floor(ordered.length / 3);
    const tiers = [["Heavy", ordered.slice(0, heavy)], ["Medium", ordered.slice(heavy, ordered.length - light)], ["Light", ordered.slice(ordered.length - light)]];
    const breakdown = tiers.map(([label, list]) => ({ label: `${label} (${list.length})`, n: list.reduce((a, b) => a + b, 0), pct: percent(list.reduce((a, b) => a + b, 0), total) }));
    return { value: breakdown[0].pct, display: `Heavy third · ${breakdown[0].pct}% of occasions`, basis: `${plural(total, "occasion")} from ${counts.size} households`, breakdown, base: counts.size };
  },
};

/**
 * The state of one recipe KPI given its stored mapping:
 *   auto          -- needs no questions (or only optional ones left unmapped)
 *   approved      -- mapped and approved by a researcher
 *   awaiting      -- the AI proposed a mapping that nobody has reviewed yet
 *   not_measured  -- a required input has no question (or was rejected)
 */
function kpiState(kpi, mapping) {
  const required = kpi.inputs.filter((i) => !i.optional);
  if (!kpi.inputs.length) return "auto";
  const status = mapping && mapping.status;
  const mapped = (role) => !!input(mapping, role);
  if (status === "approved" && required.every((i) => mapped(i.role))) return "approved";
  if (status === "proposed" && kpi.inputs.some((i) => mapped(i.role))) return "awaiting";
  return required.length ? "not_measured" : "auto";
}

/** Compute one KPI, or null when its state means it has nothing to show. */
function computeRecipeKpi(kpi, mapping, ctx) {
  const state = kpiState(kpi, mapping);
  if (state === "not_measured") return null;
  // An unreviewed proposal is computed for the researcher's preview; an
  // auto KPI with optional inputs computes without them.
  const effective = state === "auto" ? null : mapping;
  return CALCS[kpi.calc](ctx, kpi, effective);
}

// ---------- Splits (cross-tabs and mode effects) ----------

const CHANNEL_LABELS = { app: "App", web: "Web", whatsapp: "WhatsApp" };

// `level` says what a segment divides: people (each keeps all their
// entries) or entries (a person who used two channels appears in both).
const SEGMENTS = {
  gender: { label: "Gender", level: "person", of: (ctx, person) => segmentValue(ctx.profiles.get(person.id) || person, "gender") },
  age_band: { label: "Age", level: "person", of: (ctx, person) => segmentValue(ctx.profiles.get(person.id) || person, "age_band") },
  location: { label: "Location", level: "person", of: (ctx, person) => segmentValue(ctx.profiles.get(person.id) || person, "location") },
  recruitment: { label: "Recruitment", level: "person", of: (ctx, person) => (person.interviewer_id ? "Interviewer-recruited" : "Self-joined") },
  channel: { label: "Entry channel", level: "entry", of: (ctx, entry) => CHANNEL_LABELS[entry.channel] || (entry.channel ? entry.channel[0].toUpperCase() + entry.channel.slice(1) : "Not recorded") },
};

// Calculations whose value means the same thing inside a group. Totals grow
// with group size and the profile/tier/frequency measures describe the whole
// sample, so they are not split. Penetration-style measures need a cohort,
// which an entry-level split (channel) does not have.
const SPLITTABLE = {
  person: new Set(["penetration", "distribution", "brand_penetration", "share_of_occasions", "repertoire", "switching", "main_brand", "average", "per_respondent_total", "ratio", "per_capita", "measure", "purchase_rate", "repurchase_cycle"]),
  entry: new Set(["distribution", "share_of_occasions", "average", "ratio", "measure"]),
};

/**
 * One KPI computed separately for each group of a segment. For a breakdown
 * KPI (a distribution), each group reports the share of the OVERALL top
 * answer, so the groups are compared on the same thing.
 */
function splitKpi(kpi, mapping, ctx, segmentKey, overall) {
  const segment = SEGMENTS[segmentKey];
  const state = kpiState(kpi, mapping);
  if (!segment || state === "not_measured" || !SPLITTABLE[segment.level].has(kpi.calc)) return null;
  const effective = state === "auto" ? null : mapping;
  const groups = new Map();
  if (segment.level === "person") {
    for (const person of ctx.report.respondents) {
      const label = segment.of(ctx, person);
      if (!groups.has(label)) groups.set(label, { respondents: [], entries: [] });
      groups.get(label).respondents.push(person);
    }
    const groupOf = new Map();
    for (const [label, g] of groups) g.respondents.forEach((p) => groupOf.set(p.id, label));
    for (const e of ctx.report.entries) { const label = groupOf.get(e.respondentId); if (label) groups.get(label).entries.push(e); }
  } else {
    const people = new Map(ctx.report.respondents.map((p) => [p.id, p]));
    for (const e of ctx.report.entries) {
      const label = segment.of(ctx, e);
      if (!groups.has(label)) groups.set(label, { respondents: new Map(), entries: [] });
      const g = groups.get(label);
      g.entries.push(e);
      if (people.has(e.respondentId)) g.respondents.set(e.respondentId, people.get(e.respondentId));
    }
    for (const g of groups.values()) g.respondents = [...g.respondents.values()];
  }
  const anchor = overall && overall.breakdown && overall.breakdown.length > 1 && ["distribution", "share_of_occasions", "brand_penetration", "main_brand"].includes(kpi.calc) ? overall.breakdown[0].label : null;
  const rows = [...groups].map(([label, g]) => {
    const sub = { ...ctx, report: { ...ctx.report, respondents: g.respondents, entries: g.entries } };
    const result = CALCS[kpi.calc](sub, kpi, effective);
    if (anchor && result.value !== null) {
      const hit = result.breakdown.find((b) => b.label === anchor);
      const pct = hit ? hit.pct : 0;
      return { label, value: pct, display: `${pct}%`, base: result.base };
    }
    return { label, value: result.value, display: result.display, base: result.base };
  }).sort((a, b) => (a.label === "Not recorded") - (b.label === "Not recorded") || a.label.localeCompare(b.label));
  return { segment: segmentKey, label: segment.label, compares: anchor ? `share of “${anchor}”` : null, groups: rows };
}

/**
 * Mode-effect flags (framework section 16): a measure whose value differs
 * materially between channels or between self-joined and interviewer-recruited
 * participants. Only groups at or above the minimum base are compared. A
 * percentage differs materially at 10 points or more; any other figure at
 * 20% of the larger value. This is a screen for "look before pooling", not a
 * significance test.
 */
function modeDifference(split, minimum, percentLike) {
  const usable = split.groups.filter((g) => g.value !== null && g.base >= minimum);
  if (usable.length < 2) return null;
  const sorted = [...usable].sort((a, b) => b.value - a.value);
  const high = sorted[0], low = sorted[sorted.length - 1];
  const gap = high.value - low.value;
  const material = percentLike ? gap >= 10 : Math.abs(high.value) > 0 && gap / Math.abs(high.value) >= 0.2;
  return { high, low, gap: Math.round(gap * 100) / 100, material, unit: percentLike ? "points" : "" };
}

module.exports = { CALCS, context, computeRecipeKpi, kpiState, daypartOf, SEGMENTS, splitKpi, modeDifference };
