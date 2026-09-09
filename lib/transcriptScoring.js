// Scores how well a spoken answer addresses its configured diary question.
// The score is an AI assessment of response quality, not a statement that the
// respondent's answer is factually true. No configured model means no score.

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

function isTranscriptScoringConfigured() {
  return !!config();
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

async function scoreTranscript({ question, transcript }) {
  const settings = config();
  if (!settings) return { status: "unavailable", score: null, rationale: "AI scoring is not configured." };
  if (!String(transcript || "").trim()) return { status: "unavailable", score: null, rationale: "No transcript is available to score." };

  try {
    const response = await fetch(
      `${settings.endpoint}/openai/deployments/${encodeURIComponent(settings.deployment)}/chat/completions?api-version=${encodeURIComponent(settings.apiVersion)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "api-key": settings.key },
        body: JSON.stringify({
          messages: [
            {
              role: "system",
              content:
                "You score a spoken diary response against its question. Return JSON only with score (integer 0-100) and rationale (one short sentence). " +
                "Score relevance, completeness, specificity and clarity. Do not judge whether the account is factually true, infer missing facts, or reward verbosity.",
            },
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
    const content = payload?.choices?.[0]?.message?.content;
    return { status: "done", ...parseScorePayload(content) };
  } catch (error) {
    return { status: "error", score: null, rationale: error.message || "AI scoring failed." };
  }
}

module.exports = { scoreTranscript, isTranscriptScoringConfigured, parseScorePayload };
