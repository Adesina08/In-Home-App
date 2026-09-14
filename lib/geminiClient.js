// Thin client for Google Gemini's multimodal generateContent endpoint.
// Shared by the gemini_vision brand-detection provider (lib/brandDetection.js)
// and the gemini_speech transcription provider (lib/localAudioTranscription.js)
// -- same underlying call for images, audio and video, just different parts.
//
// Mirrors lib/azureVisionClient.js's shape (retry/timeout policy, one call
// per file) so every provider built on this plugs into its detect()/
// transcribe() flow the same way.

const DEFAULT_MODEL = "gemini-3-flash-preview";

async function generateContent(apiKey, model, parts) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0 } }),
        signal: controller.signal,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) return data;

      const error = new Error(`Gemini request failed (${res.status}): ${JSON.stringify(data).slice(0, 500)}`);
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

// Asks Gemini to pick the one brand shown in the image from a fixed
// candidate list (a study's configured brands, per lib/productCandidates.js)
// -- an open-vocabulary read of the packaging text/logo, rather than a
// closed catalogue lookup. Returns null if the model's reply isn't the
// strict JSON it was asked for, or a { brand, confidence, reason } object
// where `brand` is exactly one of `candidateNames` or null.
async function identifyBrand({ apiKey, model, buffer, mimeType, candidateNames }) {
  const prompt =
    `You are checking a market-research diary photo against a fixed list of candidate brands: ${candidateNames.join(", ")}.\n` +
    `Look at the attached photo. Which one brand from that exact list is shown, if any?\n` +
    `Respond with ONLY strict JSON, no markdown fences: {"brand": "<one of the list, or null>", "confidence": <0 to 1>, "reason": "<one short sentence>"}`;

  const data = await generateContent(apiKey, model || DEFAULT_MODEL, [
    { text: prompt },
    { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
  ]);
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  try {
    const parsed = JSON.parse(text.trim().replace(/^```(json)?/i, "").replace(/```$/, "").trim());
    const brand = candidateNames.find((name) => name.toLowerCase() === String(parsed.brand || "").toLowerCase()) || null;
    const confidence = Number(parsed.confidence);
    return { brand, confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null, reason: String(parsed.reason || ""), raw: text };
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

module.exports = { identifyBrand, transcribeAudio, DEFAULT_MODEL };
