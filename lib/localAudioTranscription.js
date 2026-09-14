// Transcribes a local audio file and returns the text.
//
// audioTranscription.js does the same call for the separate end-of-diary
// Voice Note feature, but it is built around a saved `media` row: it looks
// the file up through storage and writes transcript_status back to the
// database. This is the version used for standard-mode audio/video
// *questions* (lib/mediaTranscriptAnalysis.js) and video-mode pre-fill, both
// of which run on a raw local file, sometimes before any media row exists --
// so it needs the call without the database half.
//
// Deliberately returns "" rather than throwing when speech is not configured
// or nothing was said. A missing transcript must degrade to what the app
// does without one (vision signals only, for video-mode pre-fill), never
// fail the respondent's submission. AUDIO_TRANSCRIPTION_PROVIDER selects
// azure_speech (default) or gemini_speech, same env var lib/audioTranscription.js
// reads for the separate Voice Note feature.

const fs = require("fs");
const path = require("path");
const { transcribeAudio: transcribeWithGemini } = require("./geminiClient");

const API_VERSION = "2024-11-15";
const AUDIO_EXTENSION_MIME = { wav: "audio/wav", mp3: "audio/mp3", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", webm: "audio/webm", flac: "audio/flac", aiff: "audio/aiff" };
function audioMimeType(audioPath) {
  const ext = String(audioPath).split(".").pop().toLowerCase();
  return AUDIO_EXTENSION_MIME[ext] || "audio/mp4";
}

function azureSpeechConfig() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  const endpoint = process.env.AZURE_SPEECH_ENDPOINT || (region ? `https://${region}.api.cognitive.microsoft.com` : null);
  if (!key || !endpoint) return null;
  return { key, endpoint };
}

function geminiSpeechConfig() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return { apiKey, model: process.env.GEMINI_MODEL || undefined };
}

function providerName() {
  return process.env.AUDIO_TRANSCRIPTION_PROVIDER === "gemini_speech" ? "gemini_speech" : "azure_speech";
}

function activeConfig() {
  return providerName() === "gemini_speech" ? geminiSpeechConfig() : azureSpeechConfig();
}

/** True when the selected provider's credentials are present. */
function isSpeechConfigured() {
  return !!activeConfig();
}

async function transcribeWithAzure(config, audioPath) {
  const audioBuffer = fs.readFileSync(audioPath);
  const url = `${config.endpoint.replace(/\/$/, "")}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;

  const form = new FormData();
  form.append("audio", new Blob([audioBuffer]), path.basename(audioPath));
  form.append("definition", JSON.stringify({
    locales: [process.env.AZURE_SPEECH_LOCALE || "en-US"],
  }));

  const res = await fetch(url, {
    method: "POST",
    headers: { "Ocp-Apim-Subscription-Key": config.key },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`Azure AI Speech request failed (${res.status}): ${errText.slice(0, 300)}`);
  }
  const result = await res.json();
  return (result.combinedPhrases || []).map((p) => p.text).join(" ").trim();
}

/**
 * Transcribe a local audio file. Returns the recognised text, or "" when
 * speech is unconfigured, the call fails, or nothing was said.
 */
async function transcribeLocalAudio(audioPath) {
  const provider = providerName();
  const config = activeConfig();
  if (!config) return "";

  try {
    if (provider === "gemini_speech") {
      const buffer = fs.readFileSync(audioPath);
      return await transcribeWithGemini({ apiKey: config.apiKey, model: config.model, buffer, mimeType: audioMimeType(audioPath) });
    }
    return await transcribeWithAzure(config, audioPath);
  } catch (e) {
    console.warn("Video speech transcription failed:", e.message);
    return "";
  }
}

module.exports = { transcribeLocalAudio, isSpeechConfigured, providerName, audioMimeType };
