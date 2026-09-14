// Scores how well a spoken answer addresses its configured diary question.
// The score is an AI assessment of response quality, not a statement that the
// respondent's answer is factually true. No configured model means no score.
// TRANSCRIPT_SCORING_PROVIDER selects azure_openai (default) or gemini
// (reuses GEMINI_API_KEY / GEMINI_MODEL, same as brand detection, speech
// transcription and AI summaries -- no separate resource needed).

const { generateText: generateTextWithGemini } = require("./geminiClient");

const SCORING_SYSTEM_PROMPT =
  "You score a spoken diary response against its question. Return JSON only with score (integer 0-100) and rationale (one short sentence). " +
  "Score relevance, completeness, specificity and clarity. Do not judge whether the account is factually true, infer missing facts, or reward verbosity.";

function providerName() {
  return process.env.TRANSCRIPT_SCORING_PROVIDER === "gemini" ? "gemini" : "azure_openai";
}

function config() {
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const key = process.env.AZURE_OPENAI_KEY;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT;
  if (!endpoint || !key || !deployment) return null;
  return {
    endpoint: endpoint.replace(/\/$/, ""),
    key,
    deployment,
    apiVersion: process.env.AZURE_OPENAI_API_VERSION || "2024-10-21",
  };
}

function geminiConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return { apiKey, model: process.env.GEMINI_MODEL || undefined };
}

function activeConfig() {
  return providerName() === "gemini" ? geminiConfig() : config();
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

async function scoreWithAzure(settings, question, transcript) {
  const response = await fetch(
    `${settings.endpoint}/openai/deployments/${encodeURIComponent(settings.deployment)}/chat/completions?api-version=${encodeURIComponent(settings.apiVersion)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": settings.key },
      body: JSON.stringify({
        messages: [
          { role: "system", content: SCORING_SYSTEM_PROMPT },
          { role: "user", content: JSON.stringify({ question: String(question || ""), transcript: String(transcript) }) },
        ],
        temperature: 0,
        max_tokens: 180,
        response_format: { type: "json_object" },
      }),
    }
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`Azure OpenAI scoring failed (${response.status}): ${detail.slice(0, 250)}`);
  }
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content;
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
      : await scoreWithAzure(settings, question, transcript);
    return { status: "done", provider, ...parseScorePayload(content) };
  } catch (error) {
    return { status: "error", provider, score: null, rationale: error.message || "AI scoring failed." };
  }
}

module.exports = { scoreTranscript, isTranscriptScoringConfigured, parseScorePayload, providerName };
