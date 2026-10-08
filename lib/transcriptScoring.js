// Scores how well a spoken answer addresses its configured diary question.
// The score is an AI assessment of response quality, not a statement that the
// respondent's answer is factually true. No configured model means no score.
// TRANSCRIPT_SCORING_PROVIDER selects openai (default, OPENAI_API_KEY with
// gpt-5.4-mini) or gemini (GEMINI_API_KEY / GEMINI_MODEL). Azure OpenAI was
// retired; a leftover azure_openai setting means OpenAI.

const { generateText: generateTextWithGemini } = require("./geminiClient");
const openai = require("./openaiClient");

// Without concrete score-band anchors, an LLM judge tends to hedge toward a
// "safe middle" number (observed clustering around ~40/100) regardless of
// actual answer quality. Anchoring each band to what a response at that
// level actually looks like, and requiring the rationale to name the single
// biggest factor, forces the model to commit to a score it can justify
// instead of defaulting to the same mediocre-sounding number every time.
const SCORING_SYSTEM_PROMPT =
  "You score a spoken diary response against its question. Return JSON only with score (integer 0-100) and rationale (one short sentence). " +
  "Score relevance, completeness, specificity and clarity. Do not judge whether the account is factually true, infer missing facts, or reward verbosity. " +
  "Use the full 0-100 range and commit to a decisive score -- do not default to a safe middle value. Anchor to these bands: " +
  "0-19 blank, silent, or entirely off-topic; " +
  "20-39 on-topic but a bare word or two, missing most of what the question asks; " +
  "40-59 answers the question but stays generic or vague, with little concrete detail; " +
  "60-79 clear and specific, covering the question's main point with a concrete detail or two; " +
  "80-100 thorough, specific and unambiguous, directly and completely answering what was asked. " +
  "The rationale must name the single biggest factor driving the score (e.g. what concrete detail was present or missing).";

function providerName() {
  return process.env.TRANSCRIPT_SCORING_PROVIDER === "gemini" ? "gemini" : "openai";
}

function openaiConfig() {
  const apiKey = openai.apiKey();
  if (!apiKey) return null;
  return { apiKey, model: process.env.OPENAI_SCORING_MODEL?.trim() || openai.configuredModel() };
}

function geminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return { apiKey, model: process.env.GEMINI_MODEL || undefined };
}

function activeConfig() {
  return providerName() === "gemini" ? geminiConfig() : openaiConfig();
}

function isTranscriptScoringConfigured() {
  return !!activeConfig();
}

function parseScorePayload(text) {
  const raw = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const value = JSON.parse(raw);
  const score = Number(value.score);
  if (!Number.isFinite(score) || score < 0 || score > 100) throw new Error("AI returned an invalid transcript score.");
  const rationale = String(value.rationale || "").trim();
  if (!rationale) throw new Error("AI returned a transcript score without an explanation.");
  return { score: Math.round(score), rationale: rationale.slice(0, 500) };
}

async function scoreWithOpenAi(settings, question, transcript) {
  return openai.generateText({
    apiKey: settings.apiKey,
    model: settings.model,
    system: SCORING_SYSTEM_PROMPT,
    prompt: JSON.stringify({ question: String(question || ""), transcript: String(transcript) }),
    maxTokens: 1200,
    timeoutMs: 45000,
    json: true,
    label: "scoring",
  });
}

async function scoreWithGemini(settings, question, transcript) {
  return generateTextWithGemini({
    apiKey: settings.apiKey,
    model: settings.model,
    systemInstruction: SCORING_SYSTEM_PROMPT,
    prompt: JSON.stringify({ question: String(question || ""), transcript: String(transcript) }),
    temperature: 0,
    maxOutputTokens: 200,
  });
}

async function scoreTranscript({ question, transcript }) {
  const provider = providerName();
  const settings = activeConfig();
  if (!settings) return { status: "unavailable", score: null, rationale: "AI scoring is not configured." };
  if (!String(transcript || "").trim()) return { status: "unavailable", score: null, rationale: "No transcript is available to score." };

  try {
    const content = provider === "gemini"
      ? await scoreWithGemini(settings, question, transcript)
      : await scoreWithOpenAi(settings, question, transcript);
    return { status: "done", provider, ...parseScorePayload(content) };
  } catch (error) {
    return { status: "error", provider, score: null, rationale: error.message || "AI scoring failed." };
  }
}

module.exports = { scoreTranscript, isTranscriptScoringConfigured, parseScorePayload, providerName };
