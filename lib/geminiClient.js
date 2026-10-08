// Thin client for Google Gemini's multimodal generateContent endpoint.
// Shared by the gemini_vision brand-detection provider (lib/brandDetection.js)
// and the gemini_speech transcription provider (lib/localAudioTranscription.js)
// -- same underlying call for images, audio and video, just different parts.
//
// Mirrors lib/openaiClient.js's shape (retry/timeout policy, one call
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

async function sendRequest(url, body, { timeoutMs = 20000, attempts = 3 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      lastError = error?.name === "AbortError" ? new Error(`Gemini request timed out after ${timeoutMs / 1000} seconds.`) : error;
      if (lastError?.retryable === false || attempt === attempts) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError;
}

async function generateContent(apiKey, model, parts, { systemInstruction, temperature = 0, maxOutputTokens, thinkingBudget = 0, timeoutMs = 20000, attempts = 3 } = {}) {
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
    return await sendRequest(url, buildBody(true), { timeoutMs, attempts });
  } catch (error) {
    if (error.status === 400) return await sendRequest(url, buildBody(false), { timeoutMs, attempts });
    throw error;
  }
}

// Brand detection builds its own prompts (lib/brandDetection.js) so OpenAI
// and Gemini answer exactly the same question; it calls generateContent.

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
async function generateText({ apiKey, model, systemInstruction, prompt, temperature, maxOutputTokens, timeoutMs, attempts }) {
  const data = await generateContent(apiKey, model || DEFAULT_MODEL, [{ text: prompt }], { systemInstruction, temperature, maxOutputTokens, timeoutMs, attempts });
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  if (!text.trim()) throw new Error("Gemini returned an empty response.");
  return text.trim();
}

module.exports = { generateContent, transcribeAudio, generateText, DEFAULT_MODEL };
