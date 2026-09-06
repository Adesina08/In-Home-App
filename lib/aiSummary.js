// Study summaries persist the metric bundle and sampled answers with the
// narrative. Counts cover submitted non-practice entries in the selected
// period. Answer distributions and text additionally exclude open entry-level
// QC flags and unconfirmed AI answers. Model output still needs human review.
// Without a configured provider, generation uses an explicitly labelled template.

const store = require("./store");
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
      return `No diary entries were submitted in ${periodLabel(metrics.period)}, so there is nothing to summarise for this period yet. ${fieldwork.total_respondents} respondent${fieldwork.total_respondents === 1 ? " is" : "s are"} registered on the study.`;
    }

    paras.push(
      `Across ${periodLabel(metrics.period)}, ${base.contributing_respondents} of ${fieldwork.total_respondents} registered respondents submitted ${base.submitted_records} submitted diary ${base.submitted_records === 1 ? "entry" : "entries"} — an average of ${fieldwork.avg_occasions_per_contributor} per contributing respondent. ${fieldwork.compliance_rate_pct===null?"Participation compliance is unavailable until the study schedule is configured.":`${fieldwork.completed_participation_periods} of ${fieldwork.expected_participation_periods} expected participation periods were completed (${fieldwork.compliance_rate_pct}%).`}`
    );

    const brandLine = listTop(metrics.brands, "mention", "mentions");
    const occasionLine = listTop(metrics.occasions, "entry", "entries");
    if (brandLine || occasionLine) {
      const bits = [];
      if (brandLine) bits.push(`the most frequently recorded brands were ${brandLine}`);
      if (occasionLine) bits.push(`the most common occasions were ${occasionLine}`);
      paras.push(`Among eligible answers without open entry-level QC flags or unconfirmed AI values, ${bits.join(", and ")}.`);
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
  const metrics = await collectMetrics(studyId, { from, to, openTextCount: openText.length });
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
  isAiModelConfigured,
  periodLabel,
  OPEN_TEXT_SAMPLE_SIZE,
};
