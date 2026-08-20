// Pluggable transcription provider for the respondent's optional Voice Note
// (audio mode: the respondent fills the diary questions manually, then records
// a short spoken summary at the end).
//
// Real speech-to-text needs a paid cloud API — the prototype ships with this
// always-safe default: MockAudioTranscriptionProvider never guesses, and
// every voice note is simply marked "unavailable" until a real provider is
// configured. Set AUDIO_TRANSCRIPTION_PROVIDER=azure_speech plus
// AZURE_SPEECH_KEY and AZURE_SPEECH_ENDPOINT (or AZURE_SPEECH_REGION) in
// .env to switch on AzureSpeechProvider below, which calls Azure AI Speech's
// synchronous "Fast Transcription" REST API (send an audio file, get text
// straight back — no polling, ideal for a short voice note):
//   POST {endpoint}/speechtotext/transcriptions:transcribe?api-version=2025-10-15
//   header: Ocp-Apim-Subscription-Key: {AZURE_SPEECH_KEY}
//   multipart/form-data: `audio` file part + `definition` JSON part (locales)
// The returned `combinedPhrases[].text` values are joined into transcript_text.
// See PRODUCTION_READINESS.md section B10 and the Azure Deployment Runbook.

const fs = require("fs");
const path = require("path");
const db = require("./db");
const { materializeLocalFile } = require("./mediaStorage");

const API_VERSION = "2025-10-15";

class MockAudioTranscriptionProvider {
  async transcribe(media) {
    db.prepare(
      `UPDATE media SET transcript_status = 'unavailable', transcript_provider = 'mock', transcript_raw_json = ?
       WHERE id = ?`
    ).run(
      JSON.stringify({
        note: "No speech-to-text model is configured in this prototype. Configure Azure AI Speech credentials to enable real transcription.",
      }),
      media.id
    );
    return { status: "unavailable" };
  }
}

class AzureSpeechProvider {
  constructor() {
    this.key = process.env.AZURE_SPEECH_KEY;
    this.region = process.env.AZURE_SPEECH_REGION;
    // Prefer an explicit endpoint (copy the exact value shown on the
    // resource's "Keys and Endpoint" page in the Azure Portal — most
    // reliable) and fall back to the standard regional multi-service host
    // built from AZURE_SPEECH_REGION if only that was set.
    this.endpoint = process.env.AZURE_SPEECH_ENDPOINT || (this.region ? `https://${this.region}.api.cognitive.microsoft.com` : null);
    if (!this.key || !this.endpoint) {
      throw new Error(
        "AZURE_SPEECH_KEY plus AZURE_SPEECH_ENDPOINT (or AZURE_SPEECH_REGION) missing. Set real Azure AI Speech credentials in .env (see PRODUCTION_READINESS.md B10) or leave AUDIO_TRANSCRIPTION_PROVIDER=mock."
      );
    }
  }
  async transcribe(media) {
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const audioBuffer = fs.readFileSync(local.path);

      const url = `${this.endpoint.replace(/\/$/, "")}/speechtotext/transcriptions:transcribe?api-version=${API_VERSION}`;
      const form = new FormData();
      form.append("audio", new Blob([audioBuffer]), path.basename(local.path));
      form.append("definition", JSON.stringify({ locales: [process.env.AZURE_SPEECH_LOCALE || "en-US"] }));

      const res = await fetch(url, {
        method: "POST",
        headers: { "Ocp-Apim-Subscription-Key": this.key },
        body: form,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => "");
        throw new Error(`Azure AI Speech request failed (${res.status}): ${errText.slice(0, 500)}`);
      }
      const result = await res.json();
      const text = (result.combinedPhrases || []).map((p) => p.text).join(" ").trim();

      db.prepare(
        `UPDATE media SET transcript_status = ?, transcript_text = ?, transcript_provider = 'azure_speech', transcript_raw_json = ?
         WHERE id = ?`
      ).run(text ? "done" : "unavailable", text || null, JSON.stringify(result), media.id);
      return { status: text ? "done" : "unavailable", text };
    } catch (e) {
      db.prepare(
        `UPDATE media SET transcript_status = 'error', transcript_provider = 'azure_speech', transcript_raw_json = ?
         WHERE id = ?`
      ).run(JSON.stringify({ error: e.message }), media.id);
      return { status: "error", error: e.message };
    } finally {
      if (local) local.cleanup();
    }
  }
}

function getProvider() {
  const providerName = process.env.AUDIO_TRANSCRIPTION_PROVIDER || "mock";
  if (providerName === "azure_speech") return new AzureSpeechProvider();
  return new MockAudioTranscriptionProvider();
}

module.exports = { getProvider };
