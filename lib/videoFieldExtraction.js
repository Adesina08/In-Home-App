// Pluggable provider for "Video mode": the respondent records ONE video up
// front, and — instead of answering every question by hand — the app tries to
// auto-fill as many diary questions as it can straight from that video
// (which brand/product is shown, how many servings, what the occasion looks
// like, etc). Whatever it cannot confidently extract is left for the
// respondent to answer normally on the form shown right after.
//
// Real video understanding needs a paid cloud API — the prototype ships with
// this always-safe default: MockVideoFieldExtractionProvider never guesses,
// prefill is always empty, and every question is left for the respondent to
// fill in — exactly like the brand-detection and WhatsApp mocks elsewhere in
// this app. Set VIDEO_FIELD_EXTRACTION_PROVIDER=openai (with OPENAI_API_KEY)
// to switch on OpenAiVideoFieldExtractionProvider below.
//
// What OpenAiVideoFieldExtractionProvider does (and its honest limits):
//   1. Samples up to 5 frames from the video (every 2s via ffmpeg) and
//      transcribes the audio track (OpenAI speech-to-text).
//   2. Sends the frames and transcript to gpt-5.4-mini with each single/multi
//      question and its OWN configured options, asking for an answer only
//      where the video clearly shows or says it.
//   3. Keeps an answer only if it is exactly one of that question's options
//      (or, for multi, a set of them) -- anything else is discarded.
//   4. Numeric/free-text questions (e.g. "how many servings") are NEVER
//      guessed; they are not even sent to the model.
// Every pre-filled answer is stored unverified for a researcher to confirm
// (lib/videoEntryAnalysis.js). Azure AI Vision was retired; a leftover
// azure_vision setting means OpenAI.

const fs = require("fs");
const openai = require("./openaiClient");
const { extractFrames } = require("./ffmpegFrames");
const { extractAudio } = require("./ffmpegAudio");
const { transcribeLocalAudio, isSpeechConfigured } = require("./localAudioTranscription");

// Only single/multi-select questions with options can be pre-filled; the
// model may answer only with those options, and anything else it returns is
// dropped. Guessing a number or free text would violate this app's "never
// fabricate data" rule everywhere else (WhatsApp, brand detection, transcription).
function fillableQuestions(questions) {
  return (questions || []).filter((q) => (q.type === "single" || q.type === "multi") && Array.isArray(q.options) && q.options.length);
}

function keyFor(q) {
  return q.code || `q_${q.id}`;
}

// The model's answers, kept only where they are exactly the question's own options.
function acceptAnswers(questions, answers) {
  const prefill = {};
  for (const q of fillableQuestions(questions)) {
    const raw = answers ? answers[keyFor(q)] : undefined;
    if (raw === undefined || raw === null || raw === "") continue;
    const picked = (Array.isArray(raw) ? raw : [raw]).map(String);
    if (!picked.length || picked.some((value) => !q.options.includes(value))) continue;
    if (q.type === "single" && picked.length === 1) prefill[keyFor(q)] = picked[0];
    if (q.type === "multi") prefill[keyFor(q)] = [...new Set(picked)];
  }
  return prefill;
}

const PREFILL_SYSTEM_PROMPT =
  "You pre-fill a market-research diary from a respondent's short video: a few still frames plus a transcript of what they said. " +
  "For each question, answer ONLY if the frames clearly show it or the respondent clearly said it. Use the question's options exactly as written; " +
  "a multi question takes a list of options. Never guess, infer or pick the most likely option -- use null when unsure. " +
  'Return JSON only: {"answers": {"<question key>": "<option>" | ["<option>", ...] | null}}.';

class MockVideoFieldExtractionProvider {
  async analyze(videoFile, questions, brands) {
    return {
      status: "unavailable",
      prefill: {},
      transcript: "",
      note: "AI video review is running in mock mode — no fields could be auto-filled yet. Configure a real provider to enable automatic pre-fill (see PRODUCTION_READINESS.md section B9/B10). Please answer the questions below; your video is attached as evidence.",
    };
  }
}

class OpenAiVideoFieldExtractionProvider {
  constructor() {
    this.apiKey = openai.apiKey();
    this.model = process.env.OPENAI_VISION_MODEL?.trim() || openai.configuredModel();
    if (!this.apiKey) {
      throw new Error("OPENAI_API_KEY missing. Set it in .env or leave VIDEO_FIELD_EXTRACTION_PROVIDER=mock.");
    }
  }
  // Pulls the audio track out and transcribes it. Returns "" for any failure,
  // including a silent video, which is a legitimate submission not an error.
  async transcribeSpeech(videoPath) {
    if (!isSpeechConfigured()) return "";
    let cleanupAudio = () => {};
    try {
      const { file, cleanup } = await extractAudio(videoPath);
      cleanupAudio = cleanup;
      return await transcribeLocalAudio(file);
    } catch (e) {
      return "";
    } finally {
      cleanupAudio();
    }
  }

  async analyze(videoFile, questions, brands) {
    // videoFile.path is a real local file (the caller materialises it), so
    // ffmpeg can read it directly.
    let cleanupFrames = () => {};
    let transcript = "";
    try {
      const fillable = fillableQuestions(questions);
      if (!fillable.length) {
        return { status: "unavailable", prefill: {}, transcript, note: "This questionnaire has no multiple-choice questions the video could answer. Please answer the questions below; your video is attached as evidence." };
      }
      const { files, cleanup } = await extractFrames(videoFile.path, { everySeconds: 2, maxFrames: 5 });
      cleanupFrames = cleanup;
      const images = files.map((framePath) => ({ buffer: fs.readFileSync(framePath), mimeType: "image/jpeg" }));

      // What the respondent SAYS is the other half of the signal, and for a
      // front-camera video it is most of it. Failure is soft: no transcript
      // just means the model works from the frames alone.
      transcript = await this.transcribeSpeech(videoFile.path);

      const prompt = JSON.stringify({
        transcript: transcript || null,
        tracked_brands: (brands || []).map((b) => b.name),
        questions: fillable.map((q) => ({ key: keyFor(q), question: q.text, type: q.type, options: q.options })),
      });
      const reply = await openai.generateText({ apiKey: this.apiKey, model: this.model, system: PREFILL_SYSTEM_PROMPT, prompt, images, maxTokens: 3000, timeoutMs: 90000, json: true, label: "video review" });
      const prefill = acceptAnswers(questions, openai.parseJson(reply).answers);
      const filledCount = Object.keys(prefill).length;

      const sources = transcript ? "what you showed and what you said" : "what you showed";
      return {
        status: filledCount > 0 ? "done" : "unavailable",
        prefill,
        transcript,
        note:
          filledCount > 0
            ? `AI video review pre-filled ${filledCount} field${filledCount === 1 ? "" : "s"} from ${sources} — please verify each before submitting. Everything else is left for you to answer below.`
            : "AI video review ran, but nothing in the video clearly answered a question. Please answer the questions below; your video is attached as evidence.",
      };
    } catch (e) {
      return {
        status: "error",
        prefill: {},
        transcript,
        note: "AI video review failed to run — please answer the questions below; your video is still attached as evidence.",
      };
    } finally {
      cleanupFrames();
    }
  }
}

function getProvider() {
  const providerName = process.env.VIDEO_FIELD_EXTRACTION_PROVIDER || "mock";
  // azure_vision is the retired Azure AI Vision setting; it now means OpenAI.
  if (providerName === "openai" || providerName === "azure_vision") return new OpenAiVideoFieldExtractionProvider();
  return new MockVideoFieldExtractionProvider();
}

module.exports = { getProvider, acceptAnswers };
