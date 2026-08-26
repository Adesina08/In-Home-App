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

const db = require("./db");
const { classifyRisk } = require("./qc");

const OPEN_TEXT_SAMPLE_SIZE = 25;

function pct(n, d) {
  return d ? Math.round((n / d) * 100) : 0;
}

/**
 * Everything the narrative may talk about, computed from validated data only:
 * submitted, non-practice diary records inside the selected period.
 */
function collectMetrics(studyId, { from, to, openTextCount } = {}) {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(studyId);
  if (!study) return null;

  // Bound the period. Empty values mean "all data so far", which is recorded
  // as such rather than silently becoming a date range.
  const startClause = from ? " AND date(dr.entry_time) >= date(?)" : "";
  const endClause = to ? " AND date(dr.entry_time) <= date(?)" : "";
  const params = [studyId];
  if (from) params.push(from);
  if (to) params.push(to);

  const submitted = db
    .prepare(
      `SELECT COUNT(*) c FROM diary_records dr
       WHERE dr.study_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0${startClause}${endClause}`
    )
    .get(...params).c;

  const allInPeriod = db
    .prepare(
      `SELECT COUNT(*) c FROM diary_records dr
       WHERE dr.study_id = ? AND dr.is_practice = 0${startClause}${endClause}`
    )
    .get(...params).c;

  const screenedOut = db
    .prepare(
      `SELECT COUNT(*) c FROM diary_records dr
       WHERE dr.study_id = ? AND dr.status = 'screened_out' AND dr.is_practice = 0${startClause}${endClause}`
    )
    .get(...params).c;

  const contributingRespondents = db
    .prepare(
      `SELECT COUNT(DISTINCT dr.respondent_id) c FROM diary_records dr
       WHERE dr.study_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0${startClause}${endClause}`
    )
    .get(...params).c;

  const flaggedRecords = db
    .prepare(
      `SELECT COUNT(DISTINCT qf.record_id) c FROM qc_flags qf
       JOIN diary_records dr ON dr.id = qf.record_id
       WHERE dr.study_id = ? AND qf.status = 'open' AND dr.is_practice = 0${startClause}${endClause}`
    )
    .get(...params).c;

  const totalRespondents = db
    .prepare("SELECT COUNT(*) c FROM respondents WHERE study_id = ? AND is_practice = 0").get(studyId).c;
  const activeRespondents = db
    .prepare(
      "SELECT COUNT(*) c FROM respondents WHERE study_id = ? AND is_practice = 0 AND activation_status IN ('active','activated')"
    )
    .get(studyId).c;

  const risk = { green: 0, amber: 0, red: 0 };
  db.prepare("SELECT id FROM respondents WHERE study_id = ? AND is_practice = 0")
    .all(studyId)
    .forEach((r) => { risk[classifyRisk(r.id)]++; });

  // Answer distributions for the two coded questions the client dashboard
  // already reports on, restricted to the same validated base.
  function distributionFor(code, limit = 5) {
    const q = db.prepare("SELECT * FROM questions WHERE study_id = ? AND code = ?").get(studyId, code);
    if (!q) return [];
    return db
      .prepare(
        `SELECT responses.value AS label, COUNT(*) AS n FROM responses
         JOIN diary_records dr ON dr.id = responses.record_id
         WHERE responses.question_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0${startClause}${endClause}
         GROUP BY responses.value ORDER BY n DESC LIMIT ${Number(limit)}`
      )
      .all(q.id, ...params.slice(1));
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
function collectOpenText(studyId, { from, to } = {}) {
  const startClause = from ? " AND date(dr.entry_time) >= date(?)" : "";
  const endClause = to ? " AND date(dr.entry_time) <= date(?)" : "";
  const params = [studyId];
  if (from) params.push(from);
  if (to) params.push(to);

  return db
    .prepare(
      `SELECT q.text AS question, responses.value AS answer FROM responses
       JOIN diary_records dr ON dr.id = responses.record_id
       JOIN questions q ON q.id = responses.question_id
       WHERE dr.study_id = ? AND dr.status = 'submitted' AND dr.is_practice = 0
         AND q.type = 'text' AND responses.value IS NOT NULL AND trim(responses.value) != ''
         ${startClause}${endClause}
       ORDER BY dr.id DESC LIMIT ${OPEN_TEXT_SAMPLE_SIZE}`
    )
    .all(...params);
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
  const openText = collectOpenText(studyId, { from, to });
  const metrics = collectMetrics(studyId, { from, to, openTextCount: openText.length });
  if (!metrics) throw new Error("Study not found.");

  const provider = getProvider();
  const narrative = await provider.summarize({ metrics, openText });

  const info = db
    .prepare(
      `INSERT INTO ai_summaries
         (study_id, period_start, period_end, base_records, base_respondents,
          metrics_json, open_text_json, narrative, provider, model, used_ai_model, generated_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      studyId,
      from || null,
      to || null,
      metrics.base.submitted_records,
      metrics.base.contributing_respondents,
      JSON.stringify(metrics),
      JSON.stringify(openText),
      narrative,
      provider.name,
      provider.model,
      provider.usesAiModel ? 1 : 0,
      generatedBy || "system"
    );

  return db.prepare("SELECT * FROM ai_summaries WHERE id = ?").get(info.lastInsertRowid);
}

function listSummaries(studyId, limit = 20) {
  return db
    .prepare("SELECT * FROM ai_summaries WHERE study_id = ? ORDER BY datetime(generated_at) DESC LIMIT ?")
    .all(studyId, limit);
}

function latestSummary(studyId) {
  return db
    .prepare("SELECT * FROM ai_summaries WHERE study_id = ? ORDER BY datetime(generated_at) DESC LIMIT 1")
    .get(studyId);
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
