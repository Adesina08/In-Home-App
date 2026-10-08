// Pluggable transcription provider for the respondent's optional Voice Note
// (audio mode: the respondent fills the diary questions manually, then records
// a short spoken summary at the end).
//
// Real speech-to-text needs a paid cloud API — the prototype ships with this
// always-safe default: MockAudioTranscriptionProvider never guesses, and
// every voice note is simply marked "unavailable" until a real provider is
// configured. Set AUDIO_TRANSCRIPTION_PROVIDER=openai plus OPENAI_API_KEY to
// switch on OpenAiSpeechProvider below, which sends the file to OpenAI's
// audio transcription API (gpt-4o-mini-transcribe unless
// OPENAI_TRANSCRIBE_MODEL says otherwise) and stores the text it returns.
// gemini_speech is the alternative. Azure AI Speech was retired.

const fs = require("fs");
const path = require("path");
const store = require("./store");
const { materializeLocalFile } = require("./mediaStorage");
const { transcribeAudio: transcribeWithGemini } = require("./geminiClient");
const { audioMimeType } = require("./localAudioTranscription");
const openai = require("./openaiClient");

class MockAudioTranscriptionProvider {
  async transcribe(media) {
    // Transcription is queued fire-and-forget from the upload routes, so a
    // failed status write is reported the same way a provider failure is --
    // logged and returned -- never left to become an unhandled rejection.
    try {
      await store.update(
        "media",
        { id: media.id },
        {
          transcript_status: "unavailable",
          transcript_provider: "mock",
          transcript_raw_json: JSON.stringify({
            note: "No speech-to-text model is configured in this prototype. Set AUDIO_TRANSCRIPTION_PROVIDER=openai with OPENAI_API_KEY to enable real transcription.",
          }),
        }
      );
    } catch (e) {
      console.error("Audio transcription status write failed:", e.message);
      return { status: "error", error: e.message };
    }
    return { status: "unavailable" };
  }
}

// OpenAI speech-to-text (gpt-4o-mini-transcribe by default; gpt-5.4-mini has
// no audio input). Same media-row contract as the Gemini provider below.
class OpenAiSpeechProvider {
  constructor() {
    this.apiKey = openai.apiKey();
    this.model = openai.configuredTranscribeModel();
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY missing. Set it in .env or leave AUDIO_TRANSCRIPTION_PROVIDER=mock.");
    }
  }
  async transcribe(media) {
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const text = await openai.transcribeAudio({
        apiKey: this.apiKey,
        model: this.model,
        buffer: fs.readFileSync(local.path),
        filename: path.basename(local.path),
        mimeType: audioMimeType(local.path),
      });
      await store.update("media", { id: media.id }, {
        transcript_status: text ? "done" : "unavailable",
        transcript_text: text || null,
        transcript_provider: "openai",
        transcript_raw_json: JSON.stringify({ text, model: this.model }),
      });
      return { status: text ? "done" : "unavailable", text };
    } catch (e) {
      // transcribe() runs fire-and-forget and must never reject.
      try {
        await store.update("media", { id: media.id }, {
          transcript_status: "error",
          transcript_provider: "openai",
          transcript_raw_json: JSON.stringify({ error: e.message }),
        });
      } catch (writeErr) {
        console.error("Audio transcription status write failed:", writeErr.message);
      }
      return { status: "error", error: e.message };
    } finally {
      if (local) local.cleanup();
    }
  }
}

// Same shape as OpenAiSpeechProvider above,
// but calling Gemini's multimodal generateContent -- an open-vocabulary
// speech-to-text read rather than a dedicated STT model. Shares its provider
// selection (AUDIO_TRANSCRIPTION_PROVIDER=gemini_speech) with the standard
// audio/video *question* path in lib/localAudioTranscription.js, so both
// stay consistent under the one flag.
class GeminiSpeechProvider {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.model = process.env.GEMINI_MODEL || undefined;
    if (!this.apiKey) {
      throw new Error(
        "GEMINI_API_KEY missing. Set a real Gemini API key in .env (get one at aistudio.google.com/apikey) or leave AUDIO_TRANSCRIPTION_PROVIDER=mock."
      );
    }
  }
  async transcribe(media) {
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const buffer = fs.readFileSync(local.path);
      const text = await transcribeWithGemini({ apiKey: this.apiKey, model: this.model, buffer, mimeType: audioMimeType(local.path) });

      await store.update(
        "media",
        { id: media.id },
        {
          transcript_status: text ? "done" : "unavailable",
          transcript_text: text || null,
          transcript_provider: "gemini_speech",
          transcript_raw_json: JSON.stringify({ text }),
        }
      );
      return { status: text ? "done" : "unavailable", text };
    } catch (e) {
      try {
        await store.update(
          "media",
          { id: media.id },
          {
            transcript_status: "error",
            transcript_provider: "gemini_speech",
            transcript_raw_json: JSON.stringify({ error: e.message }),
          }
        );
      } catch (writeErr) {
        console.error("Audio transcription status write failed:", writeErr.message);
      }
      return { status: "error", error: e.message };
    } finally {
      if (local) local.cleanup();
    }
  }
}

function getProvider() {
  const providerName = process.env.AUDIO_TRANSCRIPTION_PROVIDER || "mock";
  // azure_speech is the retired Azure AI Speech setting; it now means OpenAI.
  if (providerName === "openai" || providerName === "azure_speech") return new OpenAiSpeechProvider();
  if (providerName === "gemini_speech") return new GeminiSpeechProvider();
  return new MockAudioTranscriptionProvider();
}

module.exports = { getProvider };
