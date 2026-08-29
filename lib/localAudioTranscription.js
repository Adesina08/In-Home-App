// Transcribes a local audio file and returns the text.
//
// audioTranscription.js does the same Azure AI Speech call, but it is built
// around a saved `media` row: it looks the file up through storage and writes
// transcript_status back to the database. Video-mode pre-fill runs *before*
// any media row exists -- it works on the raw upload while it is still a temp
// file -- so it needs the call without the database half.
//
// Deliberately returns "" rather than throwing when speech is not configured.
// A missing transcript must degrade video mode to what it does today (vision
// signals only), never fail the respondent's submission.

const fs = require("fs");
const path = require("path");

const API_VERSION = "2024-11-15";

function speechConfig() {
  const key = process.env.AZURE_SPEECH_KEY;
  const region = process.env.AZURE_SPEECH_REGION;
  const endpoint = process.env.AZURE_SPEECH_ENDPOINT || (region ? `https://${region}.api.cognitive.microsoft.com` : null);
  if (!key || !endpoint) return null;
  return { key, endpoint };
}

/** True when Azure AI Speech credentials are present. */
function isSpeechConfigured() {
  return !!speechConfig();
}

/**
 * Transcribe a local audio file. Returns the recognised text, or "" when
 * speech is unconfigured, the call fails, or nothing was said.
 */
async function transcribeLocalAudio(audioPath) {
  const config = speechConfig();
  if (!config) return "";

  try {
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
      console.warn(`Video speech transcription failed (${res.status}): ${errText.slice(0, 300)}`);
      return "";
    }
    const result = await res.json();
    return (result.combinedPhrases || []).map((p) => p.text).join(" ").trim();
  } catch (e) {
    console.warn("Video speech transcription failed:", e.message);
    return "";
  }
}

module.exports = { transcribeLocalAudio, isSpeechConfigured };
