// Study KPIs, computed from the study's own questionnaire.
//
// Before this, "Add Custom KPI" took a key and a label and stored them --
// and that was all. The client dashboard held a hardcoded map of six values,
// so every KPI an admin added rendered as an em-dash, permanently. The form
// offered something the app could never deliver.
//
// A KPI is now a question, a measure, and an optional filter:
//
//     "% choosing Brand A"                     -> percent_choosing
//     "Average units per occasion"             -> average
//     "% of entries at home"                   -> percent_entries
//     "Occasions logged"                       -> count_entries
//     "% of people who ever chose Brand A"     -> percent_respondents
//
// ...each optionally narrowed by conditions on OTHER questions, which is what
// makes cross-tabs like "% choosing Brand A, among entries logged at home"
// expressible without writing SQL.
//
// The original six keys still work: a row with no `metric` is one of those,
// computed from study-level counts by the caller.
//
// EVERYTHING here counts submitted, non-practice entries only. Drafts are
// half-finished by definition, practice entries are training, and screened-out
// entries were ended by a skip rule before the respondent reached most
// questions -- including any of them would quietly understate every
// percentage, and nobody looking at a dashboard tile would know.

const db = require("./db");

const METRICS = {
  percent_choosing: {
    label: "% choosing an option",
    needsQuestion: true,
    needsOption: true,
    questionTypes: ["single", "multi"],
    help: "Of the entries that answered this question, the share that picked the option(s) you choose.",
  },
  average: {
    label: "Average of a number",
    needsQuestion: true,
    needsOption: false,
    questionTypes: ["numeric"],
    help: "The mean of the numbers given to this question.",
  },
  percent_entries: {
    label: "% of entries matching",
    needsQuestion: false,
    needsOption: false,
    questionTypes: [],
    help: "The share of all submitted entries that match the conditions below.",
  },
  count_entries: {
    label: "Count of entries matching",
    needsQuestion: false,
    needsOption: false,
    questionTypes: [],
    help: "How many submitted entries match the conditions below.",
  },
  percent_respondents: {
    label: "% of people who ever matched",
    needsQuestion: false,
    needsOption: false,
    questionTypes: [],
    help: "The share of respondents with at least one entry matching the conditions — penetration, rather than share of occasions.",
  },
};

const OPERATORS = {
  equals: "is",
  not_equals: "is not",
  in: "is any of",
  includes: "includes",
  gt: "is more than",
  lt: "is less than",
};

/** Does one stored answer satisfy one condition? */
function answerMatches(value, operator, target) {
  const v = value === undefined || value === null ? "" : String(value);
  const targets = String(target === undefined || target === null ? "" : target).split("|").filter(Boolean);
  switch (operator) {
    case "not_equals":
      return v !== String(target);
    case "in":
      return targets.includes(v);
    case "includes":
      // Multi-select answers are stored pipe-joined, so "includes" asks
      // whether any chosen option is among the targets.
      return v.split("|").filter(Boolean).some((x) => targets.includes(x));
    case "gt": {
      const n = Number(v);
      return Number.isFinite(n) && n > Number(target);
    }
    case "lt": {
      const n = Number(v);
      return Number.isFinite(n) && n < Number(target);
    }
    case "equals":
    default:
      return v === String(target);
  }
}

function parseConditions(json) {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((c) => c && c.question_id) : [];
  } catch (e) {
    return [];
  }
}

/**
 * One pass over the study's submitted answers, shaped as
 * { recordId, respondentId, answers: { questionId: value } }.
 *
 * Deliberately loaded once and reused for every KPI on the page rather than
 * queried per KPI: a dashboard with ten KPIs would otherwise run ten scans of
 * the same rows, and the filtering logic (pipe-joined multi-values, numeric
 * comparisons) is clearer in JS than in generated SQL.
 */
function loadEntries(studyId) {
  const records = db
    .prepare(
      `SELECT id, respondent_id FROM diary_records
       WHERE study_id = ? AND status = 'submitted' AND is_practice = 0`
    )
    .all(studyId);
  if (!records.length) return [];

  const byId = new Map(records.map((r) => [r.id, { recordId: r.id, respondentId: r.respondent_id, answers: {} }]));
  const rows = db
    .prepare(
      `SELECT r.record_id, r.question_id, r.value FROM responses r
       JOIN diary_records dr ON dr.id = r.record_id
       WHERE dr.study_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0`
    )
    .all(studyId);
  rows.forEach((row) => {
    const entry = byId.get(row.record_id);
    if (entry) entry.answers[row.question_id] = row.value;
  });
  return [...byId.values()];
}

function matchesConditions(entry, conditions) {
  return conditions.every((c) => answerMatches(entry.answers[c.question_id], c.operator, c.value));
}

/**
 * Compute one KPI. Returns { value, display, basis } where `basis` says what
 * the number was computed over -- shown under the tile, because "18%" means
 * very different things over 4 entries and over 400, and a dashboard that
 * hides its denominator invites bad decisions.
 *
 * Returns null for a KPI that can't be computed (no metric, missing question),
 * so the caller can fall back to the built-in six.
 */
function computeKpi(kpi, entries) {
  if (!kpi.metric || !METRICS[kpi.metric]) return null;
  const conditions = parseConditions(kpi.conditions_json);
  const spec = METRICS[kpi.metric];

  if (spec.needsQuestion && !kpi.question_id) return null;

  const matching = entries.filter((e) => matchesConditions(e, conditions));

  if (kpi.metric === "count_entries") {
    return {
      value: matching.length,
      display: `${matching.length}${kpi.unit ? ` ${kpi.unit}` : ""}`,
      basis: `of ${entries.length} ${entries.length === 1 ? "entry" : "entries"}`,
    };
  }

  if (kpi.metric === "percent_entries") {
    if (!entries.length) return { value: null, display: "—", basis: "no entries yet" };
    const pct = Math.round((matching.length / entries.length) * 100);
    return {
      value: pct,
      display: `${pct}%`,
      basis: `${matching.length} of ${entries.length} entries`,
    };
  }

  if (kpi.metric === "percent_respondents") {
    const allPeople = new Set(entries.map((e) => e.respondentId));
    if (!allPeople.size) return { value: null, display: "—", basis: "no entries yet" };
    const matched = new Set(matching.map((e) => e.respondentId));
    const pct = Math.round((matched.size / allPeople.size) * 100);
    return {
      value: pct,
      display: `${pct}%`,
      basis: `${matched.size} of ${allPeople.size} people`,
    };
  }

  if (kpi.metric === "percent_choosing") {
    // Denominator is entries that ANSWERED the question, not all entries.
    // A question only some respondents were shown (skip logic) would
    // otherwise report a share of a population that was never asked.
    const answered = matching.filter((e) => {
      const v = e.answers[kpi.question_id];
      return v !== undefined && v !== null && String(v) !== "";
    });
    if (!answered.length) return { value: null, display: "—", basis: "nobody has answered this yet" };
    const targets = String(kpi.option_value || "").split("|").filter(Boolean);
    const chose = answered.filter((e) =>
      String(e.answers[kpi.question_id]).split("|").filter(Boolean).some((v) => targets.includes(v))
    );
    const pct = Math.round((chose.length / answered.length) * 100);
    return {
      value: pct,
      display: `${pct}%`,
      basis: `${chose.length} of ${answered.length} who answered`,
    };
  }

  if (kpi.metric === "average") {
    const nums = matching
      .map((e) => Number(e.answers[kpi.question_id]))
      .filter((n) => Number.isFinite(n));
    if (!nums.length) return { value: null, display: "—", basis: "no numbers recorded yet" };
    const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
    const rounded = Math.round(mean * 10) / 10;
    return {
      value: rounded,
      display: `${rounded}${kpi.unit ? ` ${kpi.unit}` : ""}`,
      basis: `across ${nums.length} ${nums.length === 1 ? "answer" : "answers"}`,
    };
  }

  return null;
}

/** A human-readable sentence describing what a KPI measures. */
function describeKpi(kpi, questionsById) {
  if (!kpi.metric || !METRICS[kpi.metric]) return "Built-in study metric";
  const qText = (id) => {
    const q = questionsById[id];
    if (!q) return "a deleted question";
    return q.text.length > 60 ? `${q.text.slice(0, 57)}…` : q.text;
  };

  let base;
  switch (kpi.metric) {
    case "percent_choosing":
      base = `% choosing ${String(kpi.option_value || "").split("|").filter(Boolean).join(" or ") || "(no option set)"} in “${qText(kpi.question_id)}”`;
      break;
    case "average":
      base = `Average of “${qText(kpi.question_id)}”`;
      break;
    case "percent_entries":
      base = "% of entries";
      break;
    case "count_entries":
      base = "Count of entries";
      break;
    case "percent_respondents":
      base = "% of people with at least one entry";
      break;
    default:
      base = kpi.metric;
  }

  const conditions = parseConditions(kpi.conditions_json);
  if (!conditions.length) return base;
  const clauses = conditions.map(
    (c) => `“${qText(c.question_id)}” ${OPERATORS[c.operator] || c.operator} ${String(c.value || "").split("|").join(" or ")}`
  );
  return `${base}, where ${clauses.join(" and ")}`;
}

/** Compute every KPI for a study in one pass. */
function computeAll(studyId, kpis) {
  const entries = loadEntries(studyId);
  const out = new Map();
  kpis.forEach((k) => out.set(k.id, computeKpi(k, entries)));
  return { results: out, entryCount: entries.length };
}

module.exports = { METRICS, OPERATORS, computeKpi, computeAll, describeKpi, parseConditions, answerMatches, loadEntries };
