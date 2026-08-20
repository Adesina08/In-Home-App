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
// this app. Set VIDEO_FIELD_EXTRACTION_PROVIDER=azure_vision (it reuses the
// same Azure AI Vision resource as brand detection — see
// PRODUCTION_READINESS.md section B9/B10 and the Azure Deployment Runbook)
// to switch on AzureVideoFieldExtractionProvider below, which actually
// samples frames from the video and calls Azure AI Vision for real.
//
// What AzureVideoFieldExtractionProvider does (and its honest limits):
//   1. Samples up to 5 frames from the video (every 2s via ffmpeg).
//   2. Runs each frame through Azure AI Vision Image Analysis (tags + Read/OCR)
//      — the same call brandDetection.js uses.
//   3. Fuzzy-matches the detected tags/OCR text against each single/multi
//      question's OWN configured options (e.g. an "occasion" question with
//      options Breakfast/Lunch/Dinner/Snack matches if the video shows
//      legible text or a tag containing one of those words).
//   4. Only fills a field when exactly one option matches — anything
//      ambiguous or unmatched is left blank for the respondent to answer.
//   5. Numeric/free-text questions (e.g. "how many servings") are NEVER
//      guessed — generic image tagging has no honest signal for a count at
//      that granularity. Real object-count/quantity detection would need a
//      custom-trained model, out of scope for this pilot.

const fs = require("fs");
const { analyzeImageBuffer, extractTextSignals } = require("./azureVisionClient");
const { extractFrames } = require("./ffmpegFrames");

// Deliberately conservative: only single/multi-select questions get a
// pre-fill attempt, and only when exactly one of that question's own
// configured options appears (as a substring) among the tag/OCR signals
// pulled from the sampled frames. Free-text and numeric questions (e.g.
// "how many servings") are never guessed — Azure AI Vision's generic tagging
// has no reliable signal for a count at that granularity, and guessing a
// number would violate this app's "never fabricate data" rule everywhere
// else (WhatsApp, brand detection, transcription).
function matchOptionsToSignals(questions, signals) {
  const prefill = {};
  for (const q of questions) {
    if (q.type !== "single" && q.type !== "multi") continue;
    const options = Array.isArray(q.options) ? q.options : [];
    const hits = options.filter((opt) => {
      const o = String(opt).toLowerCase().trim();
      return o.length >= 3 && signals.some((s) => s.includes(o));
    });
    if (q.type === "single" && hits.length === 1) {
      prefill[q.code || `q_${q.id}`] = hits[0];
    } else if (q.type === "multi" && hits.length >= 1) {
      prefill[q.code || `q_${q.id}`] = hits;
    }
  }
  return prefill;
}

class MockVideoFieldExtractionProvider {
  async analyze(videoFile, questions, brands) {
    return {
      status: "unavailable",
      prefill: {},
      note: "AI video review is running in mock mode — no fields could be auto-filled yet. Configure a real provider to enable automatic pre-fill (see PRODUCTION_READINESS.md section B9/B10). Please answer the questions below; your video is attached as evidence.",
    };
  }
}

class AzureVideoFieldExtractionProvider {
  constructor() {
    this.endpoint = process.env.AZURE_VISION_ENDPOINT;
    this.key = process.env.AZURE_VISION_KEY;
    if (!this.endpoint || !this.key) {
      throw new Error(
        "AZURE_VISION_ENDPOINT / AZURE_VISION_KEY missing. Set real Azure AI Vision credentials in .env (see PRODUCTION_READINESS.md B9) or leave VIDEO_FIELD_EXTRACTION_PROVIDER=mock."
      );
    }
  }
  async analyze(videoFile, questions, brands) {
    // videoFile is the raw multer upload -- .path is a real local temp file at
    // this point (this runs before the file is pushed to permanent storage),
    // so ffmpeg can read it directly with no storage-abstraction lookup needed.
    let cleanupFrames = () => {};
    try {
      const { files, cleanup } = await extractFrames(videoFile.path, { everySeconds: 2, maxFrames: 5 });
      cleanupFrames = cleanup;
      const signals = [];
      for (const framePath of files) {
        const buf = fs.readFileSync(framePath);
        const result = await analyzeImageBuffer(this.endpoint, this.key, buf, "image/jpeg");
        signals.push(...extractTextSignals(result));
      }

      // The brand question is just another single/multi question whose options
      // happen to be brand names in this app's seeded questionnaire, so the
      // same generic option-matching loop covers it -- no brand-specific
      // special case needed. `brands` is accepted for interface parity with
      // brandDetection.js and future use (e.g. a dedicated brand-only question).
      const prefill = matchOptionsToSignals(questions, signals);
      const filledCount = Object.keys(prefill).length;

      return {
        status: filledCount > 0 ? "done" : "unavailable",
        prefill,
        note:
          filledCount > 0
            ? `AI video review pre-filled ${filledCount} field${filledCount === 1 ? "" : "s"} it could confidently identify from on-screen text/labels — please verify each before submitting. Everything else is left for you to answer below.`
            : "AI video review ran, but nothing in the video could be confidently matched to a question's options. Please answer the questions below; your video is attached as evidence.",
      };
    } catch (e) {
      return {
        status: "error",
        prefill: {},
        note: "AI video review failed to run — please answer the questions below; your video is still attached as evidence.",
      };
    } finally {
      cleanupFrames();
    }
  }
}

function getProvider() {
  const providerName = process.env.VIDEO_FIELD_EXTRACTION_PROVIDER || "mock";
  if (providerName === "azure_vision") return new AzureVideoFieldExtractionProvider();
  return new MockVideoFieldExtractionProvider();
}

module.exports = { getProvider };
