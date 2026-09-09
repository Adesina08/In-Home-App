// Shared, truthful speech analysis for audio and video captured by a standard
// diary question. Speech-to-text runs first; only a real transcript is sent to
// the AI response-quality scorer.

const { extractAudio } = require("./ffmpegAudio");
const { transcribeLocalAudio, isSpeechConfigured } = require("./localAudioTranscription");
const { scoreTranscript } = require("./transcriptScoring");
const { materializeLocalFile } = require("./mediaStorage");
const store = require("./store");

async function analyseLocalMedia({ filePath, mediaType, question }) {
  if (!isSpeechConfigured()) {
    return {
      transcriptStatus: "unavailable",
      transcriptText: null,
      scoreStatus: "unavailable",
      score: null,
      scoreRationale: "Speech transcription is not configured.",
    };
  }

  let audioPath = filePath;
  let cleanupAudio = () => {};
  try {
    if (mediaType === "video") {
      const extracted = await extractAudio(filePath, { maxSeconds: 120 });
      audioPath = extracted.file;
      cleanupAudio = extracted.cleanup;
    }
    const transcriptText = await transcribeLocalAudio(audioPath);
    if (!transcriptText) {
      return {
        transcriptStatus: "unavailable",
        transcriptText: null,
        scoreStatus: "unavailable",
        score: null,
        scoreRationale: "No speech could be recognised in this recording.",
      };
    }
    const scored = await scoreTranscript({ question: question?.text || "Diary response", transcript: transcriptText });
    return {
      transcriptStatus: "done",
      transcriptText,
      scoreStatus: scored.status,
      score: scored.score,
      scoreRationale: scored.rationale,
    };
  } catch (error) {
    return {
      transcriptStatus: "error",
      transcriptText: null,
      scoreStatus: "unavailable",
      score: null,
      scoreRationale: error.message || "The recording could not be analysed.",
    };
  } finally {
    cleanupAudio();
  }
}

async function analyseStoredMedia(media, question) {
  const local = await materializeLocalFile(media.file_path);
  try {
    const result = await analyseLocalMedia({ filePath: local.path, mediaType: media.media_type, question });
    await store.update("media", { id: media.id }, {
      transcript_status: result.transcriptStatus,
      transcript_text: result.transcriptText,
      transcript_provider: result.transcriptStatus === "done" ? "azure_speech" : null,
      transcript_score_status: result.scoreStatus,
      transcript_score: result.score,
      transcript_score_reason: result.scoreRationale,
      transcript_score_provider: result.scoreStatus === "done" ? "azure_openai" : null,
    });
    return { mediaId: media.id, questionId: question?.id || null, ...result };
  } finally {
    local.cleanup();
  }
}

module.exports = { analyseLocalMedia, analyseStoredMedia };
