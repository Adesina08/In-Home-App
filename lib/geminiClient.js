// Thin client for Google Gemini's multimodal generateContent endpoint.
// Shared by the gemini_vision brand-detection provider (lib/brandDetection.js)
// and the gemini_speech transcription provider (lib/localAudioTranscription.js)
// -- same underlying call for images, audio and video, just different parts.
//
// Mirrors lib/azureVisionClient.js's shape (retry/timeout policy, one call
// per file) so every provider built on this plugs into its detect()/
// transcribe() flow the same way.

// gemini-3-flash-preview was the first choice (see git history), but its
// free-tier quota is 20 requests/day -- exhausted almost immediately once
// brand detection, transcription, summaries and scoring were all live at
// once. gemini-3.5-flash-lite's free tier is 500/day (aistudio.google.com/
// rate-limit), verified against the same brand-photo/audio/scoring tasks
// with identical results, and it never engages hidden "thinking" tokens in
// the first place (no truncation risk, no thinkingConfig fallback needed in
// practice -- see generateContent's 400 fallback below for the general case).
const DEFAULT_MODEL = "gemini-3.5-flash-lite";

async function sendRequest(url, body) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;

      const error = new Error(`Gemini request failed (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
      error.status = res.status;
      if (res.status !== 408 && res.status !== 429 && res.status < 500) {
        error.retryable = false;
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error?.name === "AbortError" ? new Error("Gemini request timed out after 20 seconds.") : error;
      if (lastError?.retryable === false || attempt === 3) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError;
}

async function generateContent(apiKey, model, parts, { systemInstruction, temperature = 0, maxOutputTokens, thinkingBudget = 0 } = {}) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  function buildBody(includeThinkingConfig) {
    const body = {
      contents: [{ parts }],
      generationConfig: {
        temperature,
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        // Extended "thinking" (Gemini 3's reasoning tokens) counts against
        // maxOutputTokens and can silently eat the whole budget before any
        // visible text comes out -- observed truncating a summary response
        // with no error, just a cut-off answer. None of this client's tasks
        // (pick a brand from a list, transcribe speech, narrate given
        // figures, score an answer) need extended reasoning, so it's off by
        // default. Not every model accepts this field though (e.g.
        // gemini-3.5-flash-lite 400s on it) -- see the fallback below.
        ...(includeThinkingConfig ? { thinkingConfig: { thinkingBudget } } : {}),
      },
    };
    if (systemInstruction) body.systemInstruction = { parts: [{ text: systemInstruction }] };
    return body;
  }

  try {
    return await sendRequest(url, buildBody(true));
  } catch (error) {
    if (error.status === 400) return await sendRequest(url, buildBody(false));
    throw error;
  }
}

// Asks Gemini which product brand is shown in the image -- a genuinely
// open-vocabulary read of the packaging text/logo, not a lookup against a
// fixed catalogue or a study's configured candidate list. A study's brand
// names (if any are configured) are passed only as a soft hint, since a
// study very often studies exactly the brand actually in the photo; the
// model is never restricted to picking from them, so a real product visible
// in the shot still gets identified even when nobody typed its name into the
// questionnaire beforehand. Returns null if the model's reply isn't the
// strict JSON it was asked for, or a { brand, confidence, reason } object
// where `brand` is whatever name the model read (or null if none is legible).
async function identifyBrand({ apiKey, model, buffer, mimeType, candidateNames, candidateCategories }) {
  const hint = Array.isArray(candidateNames) && candidateNames.length
    ? ` This study is tracking these brands in particular, so prefer one of them if it matches what's shown: ${candidateNames.join(", ")}.`
    : "";
  const categoryHint = Array.isArray(candidateCategories) && candidateCategories.length
    ? ` Also classify the product into exactly one of this study's tracked categories -- ${candidateCategories.join(", ")} -- picking whichever one the product actually belongs to, or null if none of them fit.`
    : "";
  const prompt =
    `You are reviewing a market-research diary photo of a food or drink product, or its packaging.${hint}${categoryHint}\n` +
    `Identify the single, specific product brand shown -- read the name printed on the label, can, bottle or box (e.g. "Malta Guinness", not just "malt drink").\n` +
    `Respond with ONLY strict JSON, no markdown fences: {"brand": "<the brand name exactly as printed, or null if none is legible>", "category": "<one of the tracked categories exactly as listed, or null>", "confidence": <0 to 1>, "reason": "<one short sentence>"}`;

  const data = await generateContent(apiKey, model || DEFAULT_MODEL, [
    { text: prompt },
    { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
  ]);
  return parseBrandReply(data);
}

// Same open-vocabulary brand read, but from what the respondent SAID rather
// than what a camera saw -- for a voice note where a product is named aloud
// but never photographed. Plain text in, no inline_data part.
async function identifyBrandFromTranscript({ apiKey, model, transcript, candidateNames, candidateCategories }) {
  const hint = Array.isArray(candidateNames) && candidateNames.length
    ? ` This study is tracking these brands in particular, so prefer one of them if it matches what was said: ${candidateNames.join(", ")}.`
    : "";
  const categoryHint = Array.isArray(candidateCategories) && candidateCategories.length
    ? ` Also classify what they described into exactly one of this study's tracked categories -- ${candidateCategories.join(", ")} -- or null if none of them fit.`
    : "";
  const prompt =
    `Below is a transcript of a market-research diary voice note, where someone describes a food or drink they consumed.${hint}${categoryHint}\n` +
    `Transcript: "${String(transcript || "").replace(/"/g, '\\"')}"\n` +
    `Did they name a specific product brand out loud (not just a category like "malt drink" or "soda")?\n` +
    `Respond with ONLY strict JSON, no markdown fences: {"brand": "<the brand name they said, or null if none was named>", "category": "<one of the tracked categories exactly as listed, or null>", "confidence": <0 to 1>, "reason": "<one short sentence>"}`;

  const data = await generateContent(apiKey, model || DEFAULT_MODEL, [{ text: prompt }]);
  return parseBrandReply(data);
}

function parseBrandReply(data) {
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim());
    const rawBrand = String(parsed.brand ?? "").trim();
    const brand = rawBrand && rawBrand.toLowerCase() !== "null" ? rawBrand : null;
    const rawCategory = String(parsed.category ?? "").trim();
    const category = rawCategory && rawCategory.toLowerCase() !== "null" ? rawCategory : null;
    const confidence = Number(parsed.confidence);
    return { brand, category, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null, reason: String(parsed.reason || ""), raw: text };
  } catch (e) {
    return null;
  }
}

// Transcribes speech from a local audio (or video) buffer. Gemini accepts
// audio/video directly as inline_data, same mechanism as an image -- no
// separate speech-specific endpoint. Returns the plain transcript text, or
// "" when nothing intelligible was said (never throws for "no speech",
// matching lib/localAudioTranscription.js's existing "degrade, don't fail"
// contract -- only a genuine request failure throws).
async function transcribeAudio({ apiKey, model, buffer, mimeType }) {
  const prompt =
    "Transcribe the speech in this recording exactly as spoken, in the language it was spoken in. " +
    "Respond with ONLY the transcript text, nothing else -- no preamble, no quotes, no speaker labels. " +
    "If there is no intelligible speech, respond with exactly: (no speech)";

  const data = await generateContent(apiKey, model || DEFAULT_MODEL, [
    { text: prompt },
    { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
  ]);
  const text = (data?.candidates?.[0]?.content?.parts?.[0]?.text || "").trim();
  return text === "(no speech)" ? "" : text;
}

// Plain text-in, text-out generation with a system instruction -- used by
// the gemini AI-summary provider (lib/aiSummary.js). No inline_data part,
// just the shared retry/timeout HTTP plumbing.
async function generateText({ apiKey, model, systemInstruction, prompt, temperature, maxOutputTokens }) {
  const data = await generateContent(apiKey, model || DEFAULT_MODEL, [{ text: prompt }], { systemInstruction, temperature, maxOutputTokens });
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text.trim()) throw new Error("Gemini returned an empty response.");
  return text.trim();
}

module.exports = { identifyBrand, identifyBrandFromTranscript, transcribeAudio, generateText, DEFAULT_MODEL };
