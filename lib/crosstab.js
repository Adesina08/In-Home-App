// Question-by-question crosstabs: any questions down the side (side break /
// stub), any questions or respondent variables across the top (top break /
// banner), on an occasion or a respondent base, with counts, column % and
// row %, plus CSV and Excel export.
//
// Reads the same eligible report every dashboard uses (submitted,
// non-practice, QC-cleared entries from the consenting cohort). Loop repeats
// of a question are one variable, as everywhere else in reporting.
//
// Conventions, stated on every export:
//   - A column's base is the units in that column that answered the side
//     question; column % = cell / column base.
//   - Row % = cell / the row's Total count.
//   - Multi-select answers count once per option chosen, so a column's
//     percentages can add up to more than 100%.
//   - On a respondent base, a person counts in every category they gave in
//     any of their entries, and a numeric answer is that person's average.

const { segmentValue } = require("./staffAnalysis");
const { daypartOf } = require("./recipeKpis");
const { parseOptions } = require("./questionnaire");

const CHOICE_TYPES = new Set(["single", "multi", "time"]);
const NUMBER_TYPES = new Set(["numeric", "scale"]);
const CHANNEL_LABELS = { app: "App", web: "Web", whatsapp: "WhatsApp" };

// Respondent / entry variables available beside the questionnaire.
const SEGMENT_VARIABLES = [
  { id: "seg:gender", label: "Gender", of: (ctx, entry, person) => segmentValue(ctx.profiles.get(person.id) || person, "gender") },
  { id: "seg:age_band", label: "Age group", of: (ctx, entry, person) => segmentValue(ctx.profiles.get(person.id) || person, "age_band") },
  { id: "seg:location", label: "Location", of: (ctx, entry, person) => segmentValue(ctx.profiles.get(person.id) || person, "location") },
  { id: "seg:recruitment", label: "Recruitment", of: (ctx, entry, person) => (person.interviewer_id ? "Interviewer-recruited" : "Self-joined") },
  // Entry-level: on a respondent base a person counts under every channel they used.
  { id: "seg:channel", label: "Entry channel", of: (ctx, entry) => CHANNEL_LABELS[entry.channel] || (entry.channel ? entry.channel : "Not recorded") },
];

/** Every variable a crosstab can use: question families plus respondent/entry segments. */
function variables(report) {
  const families = new Map();
  for (const q of [...report.questions].sort((a, b) => (a.order_index || 0) - (b.order_index || 0) || a.id - b.id)) {
    if (!CHOICE_TYPES.has(q.type) && !NUMBER_TYPES.has(q.type)) continue;
    const code = q.source_code || q.code || `#${q.id}`;
    if (!families.has(code)) {
      families.set(code, {
        id: `q:${code}`, code, label: q.code ? `${q.source_code || q.code} · ${String(q.text || "").replace(/ — .*$/, "")}` : String(q.text || ""),
        kind: NUMBER_TYPES.has(q.type) ? "numeric" : "choice", type: q.type, ids: [], options: q.type === "time" ? [] : parseOptions(q.options_json),
        section: q.section || null,
      });
    }
    families.get(code).ids.push(q.id);
  }
  return [
    ...families.values(),
    ...SEGMENT_VARIABLES.map((s) => ({ id: s.id, label: s.label, kind: "choice", segment: true })),
  ];
}

// ---------- Reading values ----------

function entryValues(ctx, variable, entry) {
  if (variable.segment) {
    const person = ctx.people.get(entry.respondentId) || {};
    return [SEGMENT_VARIABLES.find((s) => s.id === variable.id).of(ctx, entry, person)];
  }
  const out = new Set();
  for (const id of variable.ids) {
    const raw = entry.answers[id];
    if (raw === undefined || raw === null) continue;
    for (const part of String(raw).split("|").map((v) => v.trim()).filter(Boolean)) {
      const value = variable.type === "time" ? daypartOf(part) : part;
      if (value) out.add(value);
    }
  }
  return [...out];
}

function entryNumber(variable, entry) {
  let total = null;
  for (const id of variable.ids) {
    const raw = entry.answers[id];
    if (raw === undefined || raw === null || String(raw).trim() === "") continue;
    const n = Number(raw);
    if (Number.isFinite(n)) total = (total || 0) + n;
  }
  return total;
}

/** The analysis units: one per entry, or one per respondent with their entries merged. */
function units(ctx, base) {
  if (base === "entries") return ctx.report.entries.map((e) => ({ key: `e${e.recordId}`, entries: [e] }));
  const byPerson = new Map();
  for (const e of ctx.report.entries) {
    if (!byPerson.has(e.respondentId)) byPerson.set(e.respondentId, { key: `r${e.respondentId}`, entries: [] });
    byPerson.get(e.respondentId).entries.push(e);
  }
  return [...byPerson.values()];
}

function unitCategories(ctx, variable, unit) {
  return [...new Set(unit.entries.flatMap((e) => entryValues(ctx, variable, e)))];
}

function unitNumber(variable, unit) {
  const nums = unit.entries.map((e) => entryNumber(variable, e)).filter((n) => n !== null);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

/** Categories in questionnaire order, then any others found in the data. */
function categoriesOf(ctx, variable, allUnits) {
  const seen = new Set(variable.options || []);
  const found = [];
  for (const u of allUnits) for (const v of unitCategories(ctx, variable, u)) if (!seen.has(v)) { seen.add(v); found.push(v); }
  const order = [...(variable.options || []), ...found.sort((a, b) => (a === "Not recorded") - (b === "Not recorded") || a.localeCompare(b))];
  // Daypart buckets read best in the order of the day.
  if (variable.type === "time") order.sort((a, b) => ["Breakfast", "Lunch", "Afternoon", "Dinner", "Late night"].findIndex((p) => a.startsWith(p)) - ["Breakfast", "Lunch", "Afternoon", "Dinner", "Late night"].findIndex((p) => b.startsWith(p)));
  return order;
}

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round = (n, dp = 2) => (n === null || n === undefined ? null : Math.round(n * 10 ** dp) / 10 ** dp);
function median(list) {
  if (!list.length) return null;
  const s = [...list].sort((a, b) => a - b), mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------- Building ----------

/**
 * Build the crosstab. `side` and `top` are variable ids (from variables());
 * `base` is "entries" (occasions) or "respondents".
 */
function buildCrosstab(report, { side = [], top = [], base = "entries", profiles = new Map(), minimum = 5 } = {}) {
  const catalogue = variables(report);
  const byId = new Map(catalogue.map((v) => [v.id, v]));
  const sideVars = [...new Set(side)].map((id) => byId.get(id)).filter(Boolean);
  const topVars = [...new Set(top)].map((id) => byId.get(id)).filter((v) => v && v.kind === "choice");
  if (!sideVars.length) throw Object.assign(new Error("Choose at least one question for the side break."), { status: 400 });
  const ctx = { report, profiles, people: new Map(report.respondents.map((p) => [p.id, p])) };
  const all = units(ctx, base === "respondents" ? "respondents" : "entries");

  // Columns: Total, then each top variable's categories.
  const columns = [{ group: "Total", label: "Total", member: () => true }];
  for (const t of topVars) {
    for (const category of categoriesOf(ctx, t, all)) {
      columns.push({ group: t.label, label: category, member: (u) => unitCategories(ctx, t, u).includes(category) });
    }
  }
  const membership = columns.map((c) => all.filter((u) => c.member(u)));

  const tables = sideVars.map((s) => {
    if (s.kind === "numeric") {
      const stats = membership.map((members) => {
        const nums = members.map((u) => unitNumber(s, u)).filter((n) => n !== null);
        return { base: nums.length, mean: nums.length ? round(nums.reduce((a, b) => a + b, 0) / nums.length) : null, median: round(median(nums)), min: nums.length ? round(Math.min(...nums)) : null, max: nums.length ? round(Math.max(...nums)) : null };
      });
      return { variable: { id: s.id, label: s.label }, kind: "numeric", bases: stats.map((x) => x.base), stats };
    }
    const categories = categoriesOf(ctx, s, all);
    const answered = membership.map((members) => members.filter((u) => unitCategories(ctx, s, u).length));
    const bases = answered.map((list) => list.length);
    const rows = categories.map((category) => {
      const counts = answered.map((list) => list.filter((u) => unitCategories(ctx, s, u).includes(category)).length);
      return { label: category, cells: counts.map((n, i) => ({ n, colPct: pct(n, bases[i]), rowPct: pct(n, counts[0]) })) };
    });
    const multi = s.type === "multi" || (s.id === "seg:channel" && base === "respondents");
    return { variable: { id: s.id, label: s.label }, kind: "choice", multi, bases, rows };
  });

  return {
    base: base === "respondents" ? "respondents" : "entries",
    unitLabel: base === "respondents" ? "respondents" : "occasions",
    minimum,
    columns: columns.map(({ group, label }, i) => ({ group, label, lowBase: membership[i].length > 0 && membership[i].length < minimum, size: membership[i].length })),
    tables,
    sideIds: sideVars.map((v) => v.id),
    topIds: topVars.map((v) => v.id),
  };
}

// ---------- Export ----------

const METRIC_LABELS = { n: "Count", colPct: "Column %", rowPct: "Row %" };

/** The crosstab as a grid of rows (shared by CSV and Excel). */
function exportRows(result, { study, from, to, metrics = ["n", "colPct"] }) {
  const rows = [
    ["Study", study.name], ["Period", `${from || "Start of study"} to ${to || "latest data"}`],
    ["Base", result.base === "respondents" ? "Respondents (a person counts in every category they gave)" : "Occasions (diary entries)"],
    ["Column %", "Cell / units in the column that answered the side question. Multi-select answers can add up to more than 100%."],
    ["Row %", "Cell / the row's Total count."],
    ["Minimum base", `Columns with fewer than ${result.minimum} ${result.unitLabel} are marked LOW BASE.`],
    [],
  ];
  const groupRow = ["", "", ...result.columns.map((c) => c.group)];
  const labelRow = ["", "", ...result.columns.map((c) => c.label + (c.lowBase ? " (LOW BASE)" : ""))];
  for (const table of result.tables) {
    rows.push([table.variable.label], groupRow, labelRow);
    rows.push([`Base: ${result.unitLabel} answering`, "", ...table.bases]);
    if (table.kind === "numeric") {
      for (const [key, label] of [["mean", "Mean"], ["median", "Median"], ["min", "Minimum"], ["max", "Maximum"]]) rows.push([label, "", ...table.stats.map((s) => s[key] ?? "")]);
    } else {
      for (const row of table.rows) metrics.forEach((m, i) => rows.push([i === 0 ? row.label : "", METRIC_LABELS[m], ...row.cells.map((c) => c[m] ?? "")]));
    }
    rows.push([]);
  }
  return rows;
}

// A leading = + - @ would run as a formula in a spreadsheet.
function csvCell(value) {
  return '"' + String(value ?? "").replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"';
}

function toCsv(result, options) {
  return "﻿" + exportRows(result, options).map((row) => row.map((v) => (typeof v === "number" ? String(v) : csvCell(v))).join(",")).join("\r\n");
}

function toXlsx(result, options) {
  const XLSX = require("xlsx");
  const rows = exportRows(result, options).map((row) => row.map((v) => (typeof v === "string" && /^[=+@\-]/.test(v) ? `'${v}` : v)));
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet["!cols"] = [{ wch: 42 }, { wch: 11 }, ...result.columns.map(() => ({ wch: 14 }))];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Crosstab");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" });
}

module.exports = { variables, buildCrosstab, toCsv, toXlsx, exportRows, METRIC_LABELS };
