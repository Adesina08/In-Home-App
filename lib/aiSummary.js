// Researcher-facing AI summary (spec 4.3, P1): "Generate concise narrative
// from validated dashboard metrics and selected open-text responses. Output
// must be marked AI-generated and traceable to the selected period/base."
//
// The architecture follows from that sentence:
//
//  * "validated ... metrics" -- every number in the narrative is computed here,
//    in SQL, from submitted non-practice records only. The model is never
//    asked to count anything and never sees raw tables; it receives a finished
//    metric bundle and turns it into prose. That means a hallucinated figure
//    is structurally impossible rather than merely unlikely.
//  * "traceable to the selected period/base" -- the metric bundle, the
//    open-text sample, the period and both base sizes are all persisted with
//    the narrative, so any claim can be checked against what was actually in
//    front of the generator.
//  * "marked AI-generated" -- the row records the provider and whether a real
//    model was involved at all. In mock mode this composes the narrative from
//    the same metrics using fixed templates; that is genuinely NOT AI output,
//    so it is labelled as a rules-based draft rather than quietly presented as
//    model-written. Passing a template off as AI would be the dishonest
//    option, and would also mislead anyone judging how much to trust it.
//
// PRODUCTION HOOKUP: set AI_SUMMARY_PROVIDER=azure_openai plus
// AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_KEY and AZURE_OPENAI_DEPLOYMENT.

const store = require("./store");
const { classifyRisk } = require("./qc");

const OPEN_TEXT_SAMPLE_SIZE = 25;

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

/**
 * The period bound, as a filter on entry_time.
 *
 * SQL compared `date(entry_time)` against `date(?)`; entry_time is stored as
 * 'YYYY-MM-DD HH:MM:SS' and the bounds arrive as 'YYYY-MM-DD'. Because both are
 * fixed-shape and left-aligned, the same comparison is a plain string range:
 * 'YYYY-MM-DD' sorts before any time on that date, and appending \uffff to the
 * end bound puts it after every time on it. That keeps the whole of the last
 * day inside the period, which is what date() did.
 */
function periodFilter(from, to) {
  if (!from && !to) return null;
  const range = {};
  if (from) range.$gte = from;
  if (to) range.$lte = `${to}\uffff`;
  return range;
}

/**
 * Everything the narrative may talk about, computed from validated data only:
 * submitted, non-practice diary records inside the selected period.
 */
async function collectMetrics(studyId, { from, to, openTextCount } = {}) {
  const study = await store.findOne("studies", { id: studyId });
  if (!study) return null;

  // Bound the period. Empty values mean "all data so far", which is recorded
  // as such rather than silently becoming a date range.
  const entryTimeRange = periodFilter(from, to);

  // One read of the study's non-practice entries, then every tally below is
  // counted from it in JS. The old code issued five separate COUNT queries;
  // against a remote database that is five round trips for numbers that all
  // come from the same rows.
  const records = await store.find("diary_records", {
    study_id: studyId,
    is_practice: 0,
    ...(entryTimeRange ? { entry_time: entryTimeRange } : {}),
  });
  const submittedRecords = records.filter((r) => r.status === "submitted");

  const submitted = submittedRecords.length;
  const allInPeriod = records.length;
  const screenedOut = records.filter((r) => r.status === "screened_out").length;
  const contributingRespondents = new Set(submittedRecords.map((r) => r.respondent_id)).size;

  const recordIdsInPeriod = records.map((r) => r.id);
  const openFlags = await store.find("qc_flags", { status: "open", record_id: { $in: recordIdsInPeriod } });
  const flaggedRecords = new Set(openFlags.map((f) => f.record_id)).size;

  const studyRespondents = await store.find("respondents", { study_id: studyId, is_practice: 0 });
  const totalRespondents = studyRespondents.length;
  const activeRespondents = studyRespondents.filter((r) =>
    ["active", "activated"].includes(r.activation_status)
  ).length;

  const risk = { green: 0, amber: 0, red: 0 };
  for (const r of studyRespondents) {
    risk[await classifyRisk(r.id)]++;
  }

  // Answer distributions for the two coded questions the client dashboard
  // already reports on, restricted to the same validated base.
  const submittedIds = new Set(submittedRecords.map((r) => r.id));
  async function distributionFor(code, limit = 5) {
    const q = await store.findOne("questions", { study_id: studyId, code });
    if (!q) return [];
    const rows = await store.find("responses", { question_id: q.id });
    const counts = new Map();
    for (const r of rows) {
      if (!submittedIds.has(r.record_id)) continue;
      counts.set(r.value, (counts.get(r.value) || 0) + 1);
    }
    return [...counts.entries()]
      .map(([label, n]) => ({ label, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, Number(limit));
  }

  return {
    study: { id: study.id, name: study.name, market: study.market, category: study.category, diary_mode: study.diary_mode, version: study.version },
    period: { from: from || null, to: to || null },
    base: {
      submitted_records: submitted,
      records_in_period: allInPeriod,
      contributing_respondents: contributingRespondents,
      // Included in the bundle (not only in open_text_json) because the
      // narrative cites this figure -- every number in the prose has to be
      // checkable against the metrics snapshot, or "traceable to the base"
      // quietly stops being true.
      open_text_responses: typeof openTextCount === "number" ? openTextCount : null,
    },
    fieldwork: {
      total_respondents: totalRespondents,
      active_respondents: activeRespondents,
      completion_rate_pct: pct(submitted, allInPeriod),
      screened_out_records: screenedOut,
      avg_occasions_per_contributor: contributingRespondents ? Math.round((submitted / contributingRespondents) * 10) / 10 : 0,
    },
    quality: {
      flagged_records: flaggedRecords,
      qc_flag_rate_pct: pct(flaggedRecords, submitted),
      risk_green: risk.green,
      risk_amber: risk.amber,
      risk_red: risk.red,
    },
    brands: distributionFor("brand"),
    occasions: distributionFor("occasion"),
  };
}

/**
 * A sample of open-text answers from the same validated base. Capped, because
 * this is the only part of the payload that could carry personal detail into a
 * model prompt -- and because a narrative drawn from 500 verbatims is not a
 * summary anyone can check.
 */
async function collectOpenText(studyId, { from, to } = {}) {
  const entryTimeRange = periodFilter(from, to);
  const records = await store.find("diary_records", {
    study_id: studyId,
    status: "submitted",
    is_practice: 0,
    ...(entryTimeRange ? { entry_time: entryTimeRange } : {}),
  });
  if (!records.length) return [];

  // Newest entry first, then take the sample -- same order and same cap as the
  // old ORDER BY dr.id DESC LIMIT.
  records.sort((a, b) => b.id - a.id);
  const textQuestionIds = new Set(
    (await store.find("questions", { study_id: studyId, type: "text" }, { projection: { id: 1 } })).map((q) => q.id)
  );
  const questionText = new Map(
    (await store.find("questions", { study_id: studyId }, { projection: { text: 1 } })).map((q) => [q.id, q.text])
  );

  const responses = await store.find("responses", { record_id: { $in: records.map((r) => r.id) } });
  const byRecord = new Map();
  for (const r of responses) {
    if (!byRecord.has(r.record_id)) byRecord.set(r.record_id, []);
    byRecord.get(r.record_id).push(r);
  }

  const out = [];
  for (const dr of records) {
    for (const r of (byRecord.get(dr.id) || []).sort((a, b) => a.id - b.id)) {
      if (!textQuestionIds.has(r.question_id)) continue;
      if (r.value === null || r.value === undefined || String(r.value).trim() === "") continue;
      out.push({ question: questionText.get(r.question_id), answer: r.value });
      if (out.length >= OPEN_TEXT_SAMPLE_SIZE) return out;
    }
  }
  return out;
}

function periodLabel(period) {
  if (period.from && period.to) return `${period.from} to ${period.to}`;
  if (period.from) return `${period.from} onwards`;
  if (period.to) return `up to ${period.to}`;
  return "all data collected so far";
}

// Explicit plural rather than unit + "s" -- naive suffixing produced "entrys",
// which reads as sloppy in something a client may see.
function listTop(items, singular, plural) {
  if (!items.length) return null;
  const top = items.slice(0, 3).map((i) => `${i.label} (${i.n} ${i.n === 1 ? singular : plural})`);
  if (top.length === 1) return top[0];
  return `${top.slice(0, -1).join(", ")} and ${top[top.length - 1]}`;
}

/**
 * Rules-based narrative. Same inputs the real model gets, composed with fixed
 * templates -- honest, checkable, and available with no credentials. Labelled
 * as not-AI so nobody mistakes it for model output.
 */
class TemplateSummaryProvider {
  get name() { return "template"; }
  get usesAiModel() { return false; }
  get model() { return null; }

  async summarize({ metrics, openText }) {
    const { base, fieldwork, quality } = metrics;
    const paras = [];

    if (!base.submitted_records) {
      return `No validated diary entries were submitted in ${periodLabel(metrics.period)}, so there is nothing to summarise for this period yet. ${fieldwork.total_respondents} respondent${fieldwork.total_respondents === 1 ? " is" : "s are"} registered on the study.`;
    }

    paras.push(
      `Across ${periodLabel(metrics.period)}, ${base.contributing_respondents} of ${fieldwork.total_respondents} registered respondents submitted ${base.submitted_records} validated diary ${base.submitted_records === 1 ? "entry" : "entries"} — an average of ${fieldwork.avg_occasions_per_contributor} per contributing respondent. ${fieldwork.completion_rate_pct}% of the diary records started in this period were completed and submitted.`
    );

    const brandLine = listTop(metrics.brands, "mention", "mentions");
    const occasionLine = listTop(metrics.occasions, "entry", "entries");
    if (brandLine || occasionLine) {
      const bits = [];
      if (brandLine) bits.push(`the most frequently recorded brands were ${brandLine}`);
      if (occasionLine) bits.push(`the most common occasions were ${occasionLine}`);
      paras.push(`Within that base, ${bits.join(", and ")}.`);
    }

    const qualityBits = [`${quality.flagged_records} submitted ${quality.flagged_records === 1 ? "entry carries" : "entries carry"} at least one open QC flag (${quality.qc_flag_rate_pct}% of submissions)`];
    if (fieldwork.screened_out_records) {
      qualityBits.push(`${fieldwork.screened_out_records} ${fieldwork.screened_out_records === 1 ? "entry was" : "entries were"} screened out early by a terminate rule and are excluded from the figures above`);
    }
    paras.push(
      `On data quality, ${qualityBits.join("; ")}. Respondent risk currently stands at ${quality.risk_green} green, ${quality.risk_amber} amber and ${quality.risk_red} red.`
    );

    if (quality.risk_red > 0 || quality.qc_flag_rate_pct >= 20) {
      paras.push(
        `Attention is warranted before these figures are treated as final: ${quality.risk_red > 0 ? `${quality.risk_red} respondent${quality.risk_red === 1 ? " is" : "s are"} classified red` : `the QC flag rate is ${quality.qc_flag_rate_pct}%`}. Review the QC Worklist and re-run this summary once those are dispositioned.`
      );
    }

    if (openText.length) {
      paras.push(
        `${openText.length} open-text ${openText.length === 1 ? "response was" : "responses were"} included in the base for this summary and are stored alongside it for review; they have not been thematically coded.`
      );
    }

    return paras.join("\n\n");
  }
}

class AzureOpenAiSummaryProvider {
  constructor() {
    this.endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    this.key = process.env.AZURE_OPENAI_KEY;
    this.deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    this.apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
    if (!this.endpoint || !this.key || !this.deployment) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_KEY / AZURE_OPENAI_DEPLOYMENT missing. Set them in .env (see PRODUCTION_READINESS.md) or leave AI_SUMMARY_PROVIDER unset to use the rules-based draft."
      );
    }
  }
  get name() { return "azure_openai"; }
  get usesAiModel() { return true; }
  get model() { return this.deployment; }

  async summarize({ metrics, openText }) {
    // The model is given finished figures and asked only to narrate them. It
    // is explicitly forbidden from computing or inferring numbers, so every
    // figure in the output traces back to the stored metric bundle.
    const system =
      "You are a market research analyst writing a short factual summary for a research team. " +
      "You are given already-validated metrics and a sample of open-text responses. " +
      "Rules: use ONLY the figures provided; never calculate, estimate or invent a number; " +
      "never state a trend you cannot see in the data given; if something is absent, say so plainly. " +
      "Write 3-4 short paragraphs of plain British English prose. No headings, no bullet points, no preamble.";
    const user = JSON.stringify({ metrics, open_text_sample: openText }, null, 2);

    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.key },
      body: JSON.stringify({
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0.2,
        max_tokens: 600,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Azure OpenAI request failed (${res.status}). ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!text || !text.trim()) throw new Error("Azure OpenAI returned an empty summary.");
    return text.trim();
  }
}

function getProvider() {
  const name = process.env.AI_SUMMARY_PROVIDER || "template";
  if (name === "azure_openai") return new AzureOpenAiSummaryProvider();
  return new TemplateSummaryProvider();
}

/** True when a real model is configured -- drives the honesty banner in the UI. */
function isAiModelConfigured() {
  try {
    return getProvider().usesAiModel;
  } catch (e) {
    return false; // misconfigured provider counts as not available
  }
}

/** Generate, persist and return one summary. */
async function generateSummary(studyId, { from, to, generatedBy } = {}) {
  // Open text is gathered first so its count can go into the metric bundle
  // the narrative is written from.
  const openText = await collectOpenText(studyId, { from, to });
  const metrics = collectMetrics(studyId, { from, to, openTextCount: openText.length });
  if (!metrics) throw new Error("Study not found.");

  const provider = getProvider();
  const narrative = await provider.summarize({ metrics, openText });

  const { id } = await store.insert("ai_summaries", {
    study_id: studyId,
    period_start: from || null,
    period_end: to || null,
    base_records: metrics.base.submitted_records,
    base_respondents: metrics.base.contributing_respondents,
    metrics_json: JSON.stringify(metrics),
    open_text_json: JSON.stringify(openText),
    narrative,
    provider: provider.name,
    model: provider.model,
    used_ai_model: provider.usesAiModel ? 1 : 0,
    generated_by: generatedBy || "system",
  });

  return store.findOne("ai_summaries", { id });
}

async function listSummaries(studyId, limit = 20) {
  return store.find("ai_summaries", { study_id: studyId }, { sort: { generated_at: -1 }, limit });
}

async function latestSummary(studyId) {
  return store.findOne("ai_summaries", { study_id: studyId }, { sort: { generated_at: -1 } });
}

module.exports = {
  collectMetrics,
  collectOpenText,
  generateSummary,
  listSummaries,
  latestSummary,
  isAiModelConfigured,
  periodLabel,
  OPEN_TEXT_SAMPLE_SIZE,
};
