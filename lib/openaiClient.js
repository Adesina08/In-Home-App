// Direct OpenAI API transport -- the platform's single AI vendor for text,
// images and speech (Gemini remains an optional alternative):
//
//   generateText()     Responses API, gpt-5.4-mini by default. Text in, text
//                      out; pass `images` to add pictures (photos, video
//                      frames) to the same request. Summaries, themes,
//                      answer scoring, brand detection, video pre-fill.
//   transcribeAudio()  Audio transcription API. gpt-5.4-mini takes text and
//                      images only, so speech-to-text uses OpenAI's dedicated
//                      transcription model (gpt-4o-mini-transcribe by default).
//
// Do not fall back to another provider or return partial output.
const DEFAULT_MODEL = 'gpt-5.4-mini';
const DEFAULT_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';
const ENDPOINT = 'https://api.openai.com/v1/responses';
const TRANSCRIBE_ENDPOINT = 'https://api.openai.com/v1/audio/transcriptions';

/** The model for text and image work: OPENAI_MODEL, else gpt-5.4-mini. */
function configuredModel() {
  return process.env.OPENAI_MODEL?.trim() || DEFAULT_MODEL;
}

function configuredTranscribeModel() {
  return process.env.OPENAI_TRANSCRIBE_MODEL?.trim() || DEFAULT_TRANSCRIBE_MODEL;
}

function apiKey() {
  return process.env.OPENAI_API_KEY?.trim() || '';
}

function outputText(data, label = 'summary') {
  if (data?.status !== 'completed') throw new Error(`OpenAI did not complete the ${label}. Retry generation.`);
  const messages = (Array.isArray(data.output) ? data.output : []).filter(item => item.type === 'message' && item.role === 'assistant');
  const parts = messages.flatMap(item => Array.isArray(item.content) ? item.content : []);
  if (parts.some(part => part.type === 'refusal')) throw new Error(`OpenAI could not produce this ${label}. Review the source evidence before retrying.`);
  const text = parts.filter(part => part.type === 'output_text' && typeof part.text === 'string').map(part => part.text).join('\n').trim();
  if (!text) throw new Error(`OpenAI returned an empty ${label}. Retry generation.`);
  return text;
}

// One request with the shared retry policy: network failures and 408/409/429/5xx
// are retried with backoff (honouring Retry-After); quota and auth errors are not.
async function send(url, init, { label, timeoutMs, parse }) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let response;
    try {
      response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (cause) {
      if (attempt < 2) { await new Promise(resolve => setTimeout(resolve, 500 * 2 ** attempt)); continue; }
      throw new Error(['TimeoutError', 'AbortError'].includes(cause?.name) ? `OpenAI ${label} request timed out. Retry generation.` : 'OpenAI could not be reached. Retry generation.');
    }
    let data;
    try { data = await response.json(); } catch (_) { data = null; }
    if (response.ok) {
      if (!data) throw new Error('OpenAI returned an unreadable response. Retry generation.');
      return parse(data);
    }
    const quota = data?.error?.code === 'insufficient_quota';
    const error = new Error(quota ? 'OpenAI API quota is unavailable. Check the API project billing and usage limit.'
      : response.status === 401 ? 'OpenAI authentication failed. Check OPENAI_API_KEY.'
      : response.status === 403 ? 'The OpenAI API project does not have access to this request.'
      : response.status === 404 ? `The configured OpenAI ${label} model is unavailable to this API project.`
      : `OpenAI ${label} request failed (HTTP ${response.status}). Retry generation.`);
    error.status = response.status;
    if (quota) error.code = 'insufficient_quota';
    if (quota || attempt === 2 || ![408, 409, 429, 500, 502, 503, 504].includes(response.status)) throw error;
    const retry = Number(response.headers?.get('retry-after'));
    const delay = Number.isFinite(retry) && retry > 0 ? Math.min(retry * 1000, 10000) : 500 * 2 ** attempt;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
}

/**
 * Text (and optionally images) in, text out. `images` is a list of
 * { buffer, mimeType } sent as data URLs alongside the prompt. gpt-5.4-mini is
 * a reasoning model: max_output_tokens covers its reasoning as well as the
 * answer, so keep budgets generous even for a short JSON reply.
 */
async function generateText({ apiKey: key = apiKey(), model = DEFAULT_MODEL, system, prompt, images = [], maxTokens = 800, timeoutMs = 90000, json = false, label = 'summary' }) {
  if (!key?.trim()) throw new Error(`OPENAI_API_KEY is missing. Add it to the server environment before using OpenAI.`);
  const input = images.length
    ? [{
        role: 'user',
        content: [
          { type: 'input_text', text: String(prompt) },
          ...images.map(image => ({ type: 'input_image', image_url: `data:${image.mimeType || 'image/jpeg'};base64,${image.buffer.toString('base64')}` })),
        ],
      }]
    : prompt;
  const body = {
    model, instructions: system, input,
    max_output_tokens: maxTokens,
    store: false,
    ...(json ? { text: { format: { type: 'json_object' } } } : {}),
  };
  return send(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }, { label, timeoutMs, parse: data => outputText(data, label) });
}

/**
 * Speech-to-text for a local audio buffer. Returns the transcript, or "" when
 * nothing was said -- only a genuine request failure throws.
 */
async function transcribeAudio({ apiKey: key = apiKey(), model = configuredTranscribeModel(), buffer, filename = 'audio.wav', mimeType, language = process.env.OPENAI_TRANSCRIBE_LANGUAGE?.trim(), timeoutMs = 120000 }) {
  if (!key?.trim()) throw new Error('OPENAI_API_KEY is missing. Add it to the server environment before transcribing.');
  const form = new FormData();
  form.append('file', new Blob([buffer], mimeType ? { type: mimeType } : {}), filename);
  form.append('model', model);
  form.append('response_format', 'json');
  if (language) form.append('language', language);
  const text = await send(TRANSCRIBE_ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}` },
    body: form,
  }, { label: 'transcription', timeoutMs, parse: data => String(data.text || '').trim() });
  return text;
}

/** Parse a model's JSON reply, tolerating stray markdown fences. */
function parseJson(text) {
  return JSON.parse(String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
}

module.exports = {
  generateText, transcribeAudio, outputText, parseJson,
  configuredModel, configuredTranscribeModel, apiKey,
  DEFAULT_MODEL, DEFAULT_TRANSCRIBE_MODEL,
};
