// Study summaries persist the metric bundle and sampled answers with the
// narrative. Counts cover submitted non-practice entries in the selected
// period. Answer distributions and text additionally exclude open entry-level
// QC flags and unconfirmed AI answers. Model output still needs human review.
// Generation requires a configured Azure OpenAI deployment; previous summaries remain available if a refresh fails.

const store = require("./store");
const crypto = require("crypto");
const { classifyRisk } = require("./qc");
const { loadStudyReport, validatePeriod } = require("./studyReport");

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
 * Metric inputs for the narrative:
 * submitted, non-practice diary records inside the selected period.
 */
async function collectMetrics(studyId, { from, to, openTextCount } = {}) {
  validatePeriod({ from, to });
  const study = await store.findOne("studies", { id: studyId });
  if (!study) return null;

  const report=await loadStudyReport(studyId,{from,to});
  const people=new Set(report.respondents.map(r=>r.id));
  const allRecords=(await store.find('diary_records',{study_id:studyId,is_practice:0})).filter(r=>people.has(r.respondent_id)&&r.status!=='ingesting'&&(!from||String(r.occurrence_time||r.entry_time).slice(0,10)>=from)&&(!to||String(r.occurrence_time||r.entry_time).slice(0,10)<=to));
  const submitted=report.submitted,allInPeriod=allRecords.length,screenedOut=allRecords.filter(r=>r.status==='screened_out').length,contributingRespondents=report.contributors,flaggedRecords=report.flagged;
  const studyRespondents=report.respondents,totalRespondents=studyRespondents.length,activeRespondents=studyRespondents.length;
  const risk={green:0,amber:0,red:0};for(const r of studyRespondents)risk[await classifyRisk(r.id)]++;
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
      completion_rate_pct: report.analytics.compliance.rate,
      compliance_rate_pct:report.analytics.compliance.rate,
      completed_participation_periods:report.analytics.compliance.completed,expected_participation_periods:report.analytics.compliance.expected,
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
    analytics: {...report.analytics,compliance:{...report.analytics.compliance,missing:[]}},
    brands: report.brands.slice(0, 5),
    occasions: report.occasions.slice(0, 5),
  };
}

/**
 * A sample of eligible open-text answers from the selected submitted base. Capped, because
 * this is the only part of the payload that could carry personal detail into a
 * model prompt -- and because a narrative drawn from 500 verbatims is not a
 * summary anyone can check.
 */
async function collectOpenText(studyId, { from, to } = {}) {
  const report = await loadStudyReport(studyId, { from, to });
  return report.openText.slice(0, OPEN_TEXT_SAMPLE_SIZE);
}

class AzureOpenAiSummaryProvider {
  constructor() {
    this.endpoint = process.env.AZURE_OPENAI_ENDPOINT;
    this.key = process.env.AZURE_OPENAI_KEY;
    this.deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
    this.apiVersion = process.env.AZURE_OPENAI_API_VERSION || "2024-10-21";
    if (!this.endpoint || !this.key || !this.deployment) {
      throw new Error(
        "AZURE_OPENAI_ENDPOINT / AZURE_OPENAI_KEY / AZURE_OPENAI_DEPLOYMENT missing. Set them in .env before generating summaries."
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
      "You are given precomputed metrics and a sample of open-text responses. " +
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
  const name = process.env.AI_SUMMARY_PROVIDER || "azure_openai";
  if (name !== "azure_openai") throw new Error("AI summaries require AI_SUMMARY_PROVIDER=azure_openai.");
  return new AzureOpenAiSummaryProvider();
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
async function sourceBundle(studyId, { from, to } = {}) {
  // Open text is gathered first so its count can go into the metric bundle
  // the narrative is written from.
  const openText = await collectOpenText(studyId, { from, to });
  const metrics = await collectMetrics(studyId, { from, to, openTextCount: openText.length });
  if (!metrics) throw new Error("Study not found.");
  const sourceSignature = crypto.createHash("sha256").update(JSON.stringify({ metrics, openText })).digest("hex");
  return { metrics, openText, sourceSignature };
}

async function currentSignature(studyId, period = {}) {
  return (await sourceBundle(studyId, period)).sourceSignature;
}

async function generateSummary(studyId, { from, to, generatedBy, force = false } = {}) {
  const { metrics, openText, sourceSignature } = await sourceBundle(studyId, { from, to });
  if (!force) {
    const existing = await store.findOne("ai_summaries", {
      study_id: studyId,
      period_start: from || null,
      period_end: to || null,
      source_signature: sourceSignature,
      provider: "azure_openai",
    }, { sort: { generated_at: -1, id: -1 } });
    if (existing) return existing;
  }

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
    source_signature: sourceSignature,
    used_ai_model: provider.usesAiModel ? 1 : 0,
    generated_by: generatedBy || "system",
    review_status:"draft",
  });

  return store.findOne("ai_summaries", { id });
}

async function listSummaries(studyId, limit = 20) {
  return store.find("ai_summaries", { study_id: studyId }, { sort: { generated_at: -1, id: -1 }, limit });
}

async function latestSummary(studyId) {
  return store.findOne("ai_summaries", { study_id: studyId }, { sort: { generated_at: -1, id: -1 } });
}

module.exports = {
  collectMetrics,
  collectOpenText,
  generateSummary,
  listSummaries,
  latestSummary,
  currentSignature,
  isAiModelConfigured,
  OPEN_TEXT_SAMPLE_SIZE,
};
