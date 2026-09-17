// Study summaries persist the metric bundle and sampled answers with the
// narrative. Counts cover submitted non-practice entries in the selected
// period. Answer distributions and text additionally exclude open entry-level
// QC flags and unconfirmed AI answers. Model output still needs human review.
// Generation requires a configured Azure OpenAI deployment; previous summaries remain available if a refresh fails.

const store = require("./store");
const crypto = require("crypto");
const { classifyRisk } = require("./qc");
const { loadStudyReport, validatePeriod } = require("./studyReport");
const { generateText: generateTextWithGemini, DEFAULT_MODEL: GEMINI_DEFAULT_MODEL } = require("./geminiClient");

const SUMMARY_SYSTEM_PROMPT =
  "You are a market research analyst writing a short factual summary for a research team. " +
  "You are given precomputed metrics and a sample of open-text responses, which may include transcripts of " +
  "voice notes and video answers (each labelled by the question or media type it came from). " +
  "Rules: use ONLY the figures provided; never calculate, estimate or invent a number; " +
  "never state a trend you cannot see in the data given; if something is absent, say so plainly. " +
  "Describe only what is directly stated in the metrics or quoted in the sample -- do not infer a respondent's " +
  "motivation, sentiment, or reason for a choice unless they said so themselves. Do not generalise from one or " +
  "two quoted responses to \"respondents\" as a whole; say how many said it. " +
  "Write 3-4 short paragraphs of plain British English prose. No headings, no bullet points, no preamble.";

// A second, separate model call from the same open-text sample as the
// narrative. Kept apart from SUMMARY_SYSTEM_PROMPT (and allowed to fail
// without failing generateSummary) because it asks for something the
// narrative prompt explicitly forbids -- reading sentiment into what
// respondents wrote -- and a strict JSON contract is easier to keep honest
// when it isn't sharing a prompt with free-form prose.
const THEMES_SYSTEM_PROMPT =
  "You are a market research analyst identifying themes and sentiment in a sample of respondent open-text " +
  "answers, which may include transcripts of voice notes and video answers. " +
  "Rules: base every theme and count ONLY on the answers given; never invent a theme, a respondent or a count " +
  "that is not directly traceable to the sample provided; a theme's mentions can never exceed the number of " +
  "sampled answers; sentiment means the tone of what was actually written or said, not a guess at motivation. " +
  "If the sample is empty, return empty themes and a null overall_sentiment. " +
  "Respond with ONLY strict JSON, no markdown fences, no commentary, matching exactly this shape: " +
  '{"themes":[{"name":"<short theme label>","mentions":<integer count of sampled answers touching this theme>,' +
  '"sentiment":"positive"|"neutral"|"negative"|"mixed","example":"<one short verbatim quote from the sample>"}],' +
  '"overall_sentiment":{"positive":<integer percent>,"neutral":<integer percent>,"negative":<integer percent>}} ' +
  "List at most 8 themes, ordered by mentions descending. The three overall_sentiment percentages should sum to 100.";

const OPEN_TEXT_SAMPLE_SIZE = 25;

/** Parses and clamps a themes/sentiment reply; returns null for anything that isn't the shape asked for. */
function parseThemesReply(text) {
  const cleaned = String(text || "").trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim();
  let parsed;
  try { parsed = JSON.parse(cleaned); } catch { return null; }
  const themesRaw = Array.isArray(parsed.themes) ? parsed.themes : [];
  const themes = themesRaw.slice(0, 8).map((t) => ({
    name: String(t?.name || "").trim(),
    mentions: Math.max(0, Math.round(Number(t?.mentions)) || 0),
    sentiment: ["positive", "neutral", "negative", "mixed"].includes(t?.sentiment) ? t.sentiment : "neutral",
    example: String(t?.example || "").trim(),
  })).filter((t) => t.name);
  let overallSentiment = null;
  const overall = parsed.overall_sentiment;
  if (overall && typeof overall === "object") {
    const positive = Math.max(0, Math.round(Number(overall.positive)) || 0);
    const neutral = Math.max(0, Math.round(Number(overall.neutral)) || 0);
    const negative = Math.max(0, Math.round(Number(overall.negative)) || 0);
    if (positive || neutral || negative) overallSentiment = { positive, neutral, negative };
  }
  return { themes, overallSentiment };
}

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
 * A sample of eligible open-text answers from the selected submitted base,
 * plus eligible voice-note/video transcripts -- real respondent testimony,
 * same as a typed text answer, but previously invisible to the summary even
 * though the same media sits right next to it on the report page. Capped,
 * because this is the only part of the payload that could carry personal
 * detail into a model prompt -- and because a narrative drawn from 500
 * verbatims is not a summary anyone can check. Typed answers are kept ahead
 * of transcripts in the cap: they're already curated per-question, where a
 * transcript is a raw recording that may run long or drift off-topic.
 */
async function collectOpenText(studyId, { from, to } = {}) {
  const report = await loadStudyReport(studyId, { from, to });
  const transcripts = report.media
    .filter((m) => m.transcript_status === "done" && m.transcript_text)
    .map((m) => ({ question: `Spoken ${m.media_type} response`, answer: m.transcript_text }));
  return [...report.openText, ...transcripts].slice(0, OPEN_TEXT_SAMPLE_SIZE);
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
    const user = JSON.stringify({ metrics, open_text_sample: openText }, null, 2);

    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.key },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SUMMARY_SYSTEM_PROMPT },
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

  async analyzeThemes({ openText }) {
    const user = JSON.stringify({ open_text_sample: openText }, null, 2);
    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.key },
      body: JSON.stringify({
        messages: [
          { role: "system", content: THEMES_SYSTEM_PROMPT },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: 700,
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Azure OpenAI request failed (${res.status}). ${detail.slice(0, 300)}`);
    }
    const data = await res.json();
    const text = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    return parseThemesReply(text);
  }
}

class GeminiSummaryProvider {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.model = process.env.GEMINI_MODEL || GEMINI_DEFAULT_MODEL;
    if (!this.apiKey) {
      throw new Error(
        "GEMINI_API_KEY missing. Set a real Gemini API key in .env (get one at aistudio.google.com/apikey) or leave AI_SUMMARY_PROVIDER=azure_openai."
      );
    }
  }
  get name() { return "gemini"; }
  get usesAiModel() { return true; }

  async summarize({ metrics, openText }) {
    const prompt = JSON.stringify({ metrics, open_text_sample: openText }, null, 2);
    return generateTextWithGemini({
      apiKey: this.apiKey,
      model: this.model,
      systemInstruction: SUMMARY_SYSTEM_PROMPT,
      prompt,
      temperature: 0.2,
      maxOutputTokens: 800,
    });
  }

  async analyzeThemes({ openText }) {
    const prompt = JSON.stringify({ open_text_sample: openText }, null, 2);
    const text = await generateTextWithGemini({
      apiKey: this.apiKey,
      model: this.model,
      systemInstruction: THEMES_SYSTEM_PROMPT,
      prompt,
      temperature: 0,
      maxOutputTokens: 700,
    });
    return parseThemesReply(text);
  }
}

/** Never throws: a failed or unparseable thematic/sentiment read degrades to null rather than blocking the narrative. */
async function safeAnalyzeThemes(provider, openText) {
  if (!openText.length || typeof provider.analyzeThemes !== "function") return null;
  try { return await provider.analyzeThemes({ openText }); } catch (e) { return null; }
}

function providerName() {
  return process.env.AI_SUMMARY_PROVIDER === "gemini" ? "gemini" : "azure_openai";
}

function getProvider() {
  const name = providerName();
  if (name === "gemini") return new GeminiSummaryProvider();
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
      provider: providerName(),
    }, { sort: { generated_at: -1, id: -1 } });
    if (existing) return existing;
  }

  const provider = getProvider();
  const narrative = await provider.summarize({ metrics, openText });
  // Thematic/sentiment analysis is a bonus read on the same sample, not the
  // headline narrative -- if the model call or its JSON fails, the summary
  // still saves with a plain-text narrative rather than blocking on it.
  const themes = await safeAnalyzeThemes(provider, openText);

  const { id } = await store.insert("ai_summaries", {
    study_id: studyId,
    period_start: from || null,
    period_end: to || null,
    base_records: metrics.base.submitted_records,
    base_respondents: metrics.base.contributing_respondents,
    metrics_json: JSON.stringify(metrics),
    open_text_json: JSON.stringify(openText),
    narrative,
    themes_json: themes ? JSON.stringify(themes.themes) : null,
    sentiment_json: themes ? JSON.stringify(themes.overallSentiment) : null,
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
  providerName,
  OPEN_TEXT_SAMPLE_SIZE,
};
