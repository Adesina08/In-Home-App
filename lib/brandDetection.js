// Pluggable brand-detection provider for photo/video evidence and voice notes.
//
// A vision-capable LLM reads whichever brand is actually shown (photo, or a
// few frames sampled from a video) or named aloud (a voice note's
// transcript). It is open-vocabulary: a study's configured brands are only a
// naming hint. BRAND_DETECTION_PROVIDER selects openai (gpt-5.4-mini) or
// gemini_vision; anything uncertain is sent for human review.
//
// Azure AI Vision's closed logo catalogue was retired: it had no concept of
// market-specific brands (it missed a Gala sausage roll entirely and misread
// a Maltina bottle as "Ovaltine"). A leftover azure_vision setting means OpenAI.

const fs = require("fs");
const store = require("./store");
const gemini = require("./geminiClient");
const { aiCategoryLabel, canonicalCategory } = require("./categories");
const { materializeLocalFile } = require("./mediaStorage");
const openai = require("./openaiClient");

function canonicalBrandName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

// Snaps whatever category name a detector returned back onto the study's own
// spelling from study settings (lib/categories.js) -- an LLM read of "toothpaste" should land on the exact
// "Toothpaste" string the study is filtered/reported by, not a near-miss.
// The model sees descriptive labels ("CSD (carbonated soft drinks...)") and
// sometimes answers with the whole thing, so the bracketed gloss is dropped
// before matching.
function configuredCategoryFor(label, categories) {
  const raw = String(label || "");
  for (const candidate of [raw, raw.replace(/\s*\(.*\)\s*$/, "")]) {
    const wanted = canonicalBrandName(canonicalCategory(candidate));
    if (!wanted) continue;
    const hit = (categories || []).find((category) => canonicalBrandName(category) === wanted);
    if (hit) return hit;
  }
  return null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

class MockBrandDetectionProvider {
  async detect(media, brands, categories) {
    // Detection is queued fire-and-forget from the upload routes, so a failed
    // status write is reported the same way a provider failure is -- logged and
    // returned -- never left to become an unhandled rejection.
    try {
      await store.update(
        "media",
        { id: media.id },
        {
          detection_status: "unavailable",
          detection_provider: "mock",
          detection_confidence: null,
          detection_method: null,
          detection_category: null,
          detection_category_confidence: null,
          detection_review_status: null,
          detection_verified_by: null,
          detection_verified_at: null,
          detection_raw_json: JSON.stringify({
            note: "No brand-detection model is configured in this prototype. Set BRAND_DETECTION_PROVIDER=openai with OPENAI_API_KEY to enable real detection.",
            candidateBrands: brands.map((b) => b.name),
            candidateCategories: categoryEntries(categories).map((c) => c.name),
          }),
        }
      );
    } catch (e) {
      console.error("Brand detection status write failed:", e.message);
      return { status: "error", error: e.message };
    }
    return { status: "unavailable" };
  }
}

const IMAGE_EXTENSION_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
// The models reject a generic "application/octet-stream" content type -- they
// need a real image MIME type. Uploads store one in `media.mimetype`; this is the fallback for rows
// that predate that column, inferred from the file extension.
function imageMimeType(media) {
  if (media.mimetype && media.mimetype.startsWith("image/")) return media.mimetype;
  const ext = String(media.file_path || "").split(".").pop().toLowerCase();
  return IMAGE_EXTENSION_MIME[ext] || "image/jpeg";
}

// The prompts both models answer: strict JSON with a brand and a category,
// each carrying its own confidence. The category is asked for even when no
// brand is legible -- an unbranded plate of rice still belongs to Rice --
// but a brand is never guessed from the look of unpackaged food.
function brandHint(candidateNames, verb) {
  return Array.isArray(candidateNames) && candidateNames.length
    ? `This study is tracking these brands in particular, so prefer one of them if it matches what ${verb}: ${candidateNames.join(", ")}.\n`
    : "";
}
// Callers pass plain names or { name, ai } from detectionCategories(study),
// which carries a custom category's description; both end up as { name, ai }.
function categoryEntries(categories) {
  return (categories || []).map((c) => typeof c === "string" ? { name: c, ai: aiCategoryLabel(c) } : { name: c.name, ai: c.ai || c.name });
}
function categoryInstruction(entries, subject) {
  if (!entries.length) return `Category: always null (this study tracks no categories).\n`;
  const fallback = entries.some((c) => c.name === "Other food") ? `use "Other food"` : "use null";
  return `Category: classify ${subject} into exactly one of this study's categories, whether or not there is a brand. Answer with the name only, without the words in brackets:\n` +
    entries.map((c) => `- ${c.ai}`).join("\n") + "\n" +
    `A cooked dish goes under its main packaged ingredient (jollof rice or rice and beans -> Rice, spaghetti -> Pasta, noodles -> Instant Noodles). For food with no listed main ingredient, ${fallback}. Use null if nothing fits.\n`;
}
const BRAND_JSON = `Respond with ONLY strict JSON: {"brand": "<the brand name, or null>", "brand_confidence": <0 to 1, or null when brand is null>, "category": "<one category name exactly as listed, or null>", "category_confidence": <0 to 1, or null when category is null>, "reason": "<one short sentence>"}`;

function imagePrompt(candidateNames, categoryList) {
  return `You are reviewing a market-research diary photo or video frame. It may show a packaged product, its packaging, or food or drink being prepared or consumed.\n` +
    brandHint(candidateNames, "is shown") +
    `Brand: the single, specific product brand shown -- read the name printed on the label, can, bottle or box (e.g. "Malta Guinness", not just "malt drink"). Use null if no brand is legible; never infer a brand from how unpackaged food looks.\n` +
    categoryInstruction(categoryList, "what is shown") + BRAND_JSON;
}
function transcriptPrompt(transcript, candidateNames, categoryList) {
  return `Below is a transcript of a market-research diary voice note, where someone describes something they consumed or used.\n` +
    brandHint(candidateNames, "was said") +
    `Transcript: ${JSON.stringify(String(transcript || ""))}\n` +
    `Brand: a specific product brand they named out loud (not just a category like "malt drink" or "soda"). Use null if none was named.\n` +
    categoryInstruction(categoryList, "what they described") + BRAND_JSON;
}

function parseBrandJson(text) {
  try {
    const parsed = openai.parseJson(text);
    const clean = (value) => { const v = String(value ?? "").trim(); return v && v.toLowerCase() !== "null" ? v : null; };
    const score = (value) => { const n = value === null || value === undefined || value === "" ? NaN : Number(value); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : null; };
    const brand = clean(parsed.brand), category = clean(parsed.category);
    // `confidence` is the single score older replies (and prompts) used for the brand.
    return {
      brand, category,
      confidence: brand ? score(parsed.brand_confidence ?? parsed.confidence) : null,
      categoryConfidence: category ? score(parsed.category_confidence) : null,
      reason: String(parsed.reason || ""), raw: text,
    };
  } catch (e) {
    return null;
  }
}

// gpt-5.4-mini reads photos and video frames directly (image input).
const OPENAI_ADAPTER = {
  name: "openai",
  configure() {
    const apiKey = openai.apiKey();
    if (!apiKey) throw new Error("OPENAI_API_KEY missing. Set it in .env or leave BRAND_DETECTION_PROVIDER=mock.");
    return { apiKey, model: process.env.OPENAI_VISION_MODEL?.trim() || openai.configuredModel() };
  },
  async identifyImage(config, { buffer, mimeType, candidateNames, categoryList }) {
    const prompt = imagePrompt(candidateNames, categoryList);
    return parseBrandJson(await openai.generateText({ ...config, prompt, images: [{ buffer, mimeType }], maxTokens: 1500, timeoutMs: 60000, json: true, label: "brand detection" }));
  },
  async identifyTranscript(config, { transcript, candidateNames, categoryList }) {
    const prompt = transcriptPrompt(transcript, candidateNames, categoryList);
    return parseBrandJson(await openai.generateText({ ...config, prompt, maxTokens: 1200, timeoutMs: 45000, json: true, label: "brand detection" }));
  },
};

const geminiText = (data) => data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
const GEMINI_ADAPTER = {
  name: "gemini_vision",
  configure() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error("GEMINI_API_KEY missing. Set a real Gemini API key in .env (get one at aistudio.google.com/apikey) or leave BRAND_DETECTION_PROVIDER=mock.");
    return { apiKey, model: process.env.GEMINI_MODEL || gemini.DEFAULT_MODEL };
  },
  async identifyImage(config, { buffer, mimeType, candidateNames, categoryList }) {
    const data = await gemini.generateContent(config.apiKey, config.model, [
      { text: imagePrompt(candidateNames, categoryList) },
      { inline_data: { mime_type: mimeType, data: buffer.toString("base64") } },
    ]);
    return parseBrandJson(geminiText(data));
  },
  async identifyTranscript(config, { transcript, candidateNames, categoryList }) {
    const data = await gemini.generateContent(config.apiKey, config.model, [{ text: transcriptPrompt(transcript, candidateNames, categoryList) }]);
    return parseBrandJson(geminiText(data));
  },
};

// Category for a set of reads: the brand's own category when a brand was
// found, otherwise the most confident category any read gave.
function pickCategory(best, attempts, categories) {
  const read = (a) => a && a.category ? { category: configuredCategoryFor(a.category, categories), confidence: a.categoryConfidence } : null;
  const fromBrand = read(best);
  if (fromBrand && fromBrand.category) return fromBrand;
  return attempts.map(read).filter((r) => r && r.category)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || { category: null, confidence: null };
}

// Open-vocabulary brand reads through a vision-capable LLM. Audio gets the
// same read applied to its transcript, since a voice note has no picture.
class LlmBrandProvider {
  constructor(adapter) {
    this.adapter = adapter;
    this.config = adapter.configure();
  }
  // Core open-vocabulary read for a local image/video file, with no database
  // side effects -- shared by detect() (persists against a submitted media
  // row) and the in-app live preview (nothing durable exists yet while the
  // respondent is still answering).
  async identify(localPath, mediaType, mimeType, brands, categories) {
    const candidateNames = (brands || []).map((b) => b.name);
    const categoryList = categoryEntries(categories);
    const candidateCategories = categoryList.map((c) => c.name);
    const attempts = [];

    if (mediaType === "video") {
      const { extractFrames } = require("./ffmpegFrames");
      const { files, cleanup } = await extractFrames(localPath, { everySeconds: 2, maxFrames: 3 });
      try {
        for (const framePath of files) {
          const buf = fs.readFileSync(framePath);
          attempts.push(await this.adapter.identifyImage(this.config, { buffer: buf, mimeType: "image/jpeg", candidateNames, categoryList }));
        }
      } finally {
        cleanup();
      }
    } else {
      const buf = fs.readFileSync(localPath);
      attempts.push(await this.adapter.identifyImage(this.config, { buffer: buf, mimeType: mimeType || "image/jpeg", candidateNames, categoryList }));
    }

    const hits = attempts.filter((a) => a && a.brand);
    const best = hits.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
    const minConfidence = boundedNumber(process.env.BRAND_LOGO_MIN_CONFIDENCE, 0.7, 0, 1);
    const status = !best ? "unavailable" : best.confidence >= minConfidence ? "done" : "needs_review";
    const picked = pickCategory(best, attempts, candidateCategories);
    return { status, detectedBrand: best ? best.brand : null, detectedCategory: picked.category, categoryConfidence: picked.confidence, confidence: best ? best.confidence : null, method: best || picked.category ? "llm_vision" : null, attempts, candidateNames, candidateCategories, minConfidence };
  }
  async detect(media, brands, categories) {
    if (media.media_type === "audio") return this.detectFromTranscript(media, brands, categories);
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const result = await this.identify(local.path, media.media_type, imageMimeType(media), brands, categories);

      await store.update("media", { id: media.id }, {
        detection_status: result.status,
        detected_brand: result.detectedBrand,
        detection_confidence: result.confidence,
        detection_method: result.method,
        detection_category: result.detectedCategory,
        detection_category_confidence: result.categoryConfidence,
        detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
        detection_provider: this.adapter.name,
        detection_raw_json: JSON.stringify({
          candidateBrands: result.candidateNames,
          candidateCategories: result.candidateCategories,
          detectedCategory: result.detectedCategory,
          attempts: result.attempts.map((a) => a ? { brand: a.brand, confidence: a.confidence, category: a.category, categoryConfidence: a.categoryConfidence, reason: a.reason } : { unparsed: true }),
          thresholds: { minConfidence: result.minConfidence },
          note: result.status === "done" ? "Accepted from the LLM-vision read after the confidence check."
            : result.status === "needs_review" ? "A possible brand was identified, but it requires human confirmation."
            : result.detectedCategory ? "No brand was legible; the category was still classified."
            : "No brand was legible in the photo.",
        }),
      });
      return { status: result.status, detectedBrand: result.detectedBrand, detectedCategory: result.detectedCategory, categoryConfidence: result.categoryConfidence, confidence: result.confidence, method: result.method };
    } catch (e) {
      try {
        await store.update("media", { id: media.id }, {
          detection_status: "error", detection_provider: this.adapter.name,
          detection_confidence: null, detection_method: null, detection_category: null, detection_category_confidence: null,
          detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
          detection_raw_json: JSON.stringify({ error: e.message }),
        });
      } catch (writeErr) {
        console.error("Brand detection status write failed:", writeErr.message);
      }
      return { status: "error", error: e.message };
    } finally {
      if (local) local.cleanup();
    }
  }

  // A voice note has a transcript, not a frame. `media.transcript_text` is
  // passed in directly by callers that already have it fresh off a just-
  // finished transcription (avoids a redundant read of a row they just
  // wrote); anything else re-reads the row, in case transcription finished
  // and was persisted separately.
  async detectFromTranscript(media, brands, categories) {
    try {
      const row = media.transcript_text !== undefined ? media : await store.findOne("media", { id: media.id });
      const transcript = row && row.transcript_text ? String(row.transcript_text).trim() : "";
      if (!transcript) {
        await store.update("media", { id: media.id }, {
          detection_status: "unavailable", detection_provider: this.adapter.name,
          detection_confidence: null, detection_method: null, detection_category: null, detection_category_confidence: null,
          detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
          detection_raw_json: JSON.stringify({ note: "No transcript is available yet to read a brand from." }),
        });
        return { status: "unavailable" };
      }

      const candidateNames = (brands || []).map((b) => b.name);
      const categoryList = categoryEntries(categories);
      const candidateCategories = categoryList.map((c) => c.name);
      const result = await this.adapter.identifyTranscript(this.config, { transcript, candidateNames, categoryList });
      const minConfidence = boundedNumber(process.env.BRAND_LOGO_MIN_CONFIDENCE, 0.7, 0, 1);
      const status = !result || !result.brand ? "unavailable" : result.confidence >= minConfidence ? "done" : "needs_review";
      const detectedCategory = result && result.category ? configuredCategoryFor(result.category, candidateCategories) : null;
      const categoryConfidence = detectedCategory ? result.categoryConfidence : null;

      await store.update("media", { id: media.id }, {
        detection_status: status,
        detected_brand: result ? result.brand : null,
        detection_confidence: result ? result.confidence : null,
        detection_method: result && (result.brand || detectedCategory) ? "llm_transcript" : null,
        detection_category: detectedCategory,
        detection_category_confidence: categoryConfidence,
        detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
        detection_provider: this.adapter.name,
        detection_raw_json: JSON.stringify({
          transcript,
          candidateBrands: candidateNames,
          candidateCategories,
          detectedCategory,
          result,
          thresholds: { minConfidence },
          note: status === "done" ? "Accepted from the transcript read after the confidence check."
            : status === "needs_review" ? "A possible brand was named, but it requires human confirmation."
            : "No brand was named in the transcript.",
        }),
      });
      return { status, detectedBrand: result ? result.brand : null, detectedCategory, categoryConfidence, confidence: result ? result.confidence : null, method: result && (result.brand || detectedCategory) ? "llm_transcript" : null };
    } catch (e) {
      try {
        await store.update("media", { id: media.id }, {
          detection_status: "error", detection_provider: this.adapter.name,
          detection_confidence: null, detection_method: null, detection_category: null, detection_category_confidence: null,
          detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
          detection_raw_json: JSON.stringify({ error: e.message }),
        });
      } catch (writeErr) {
        console.error("Brand detection status write failed:", writeErr.message);
      }
      return { status: "error", error: e.message };
    }
  }
}

function getProvider() {
  const providerName = process.env.BRAND_DETECTION_PROVIDER || "mock";
  // azure_vision is the retired Azure AI Vision setting; it now means OpenAI.
  if (providerName === "openai" || providerName === "azure_vision") return new LlmBrandProvider(OPENAI_ADAPTER);
  if (providerName === "gemini_vision") return new LlmBrandProvider(GEMINI_ADAPTER);
  return new MockBrandDetectionProvider();
}

// Live in-app preview while a respondent is still answering a photo/video
// diary question -- no media row exists yet to persist against (that only
// happens once the entry is submitted), so this calls the same provider
// logic as detect() above but returns the result directly. Never throws: a
// failed preview should not block the respondent from continuing to answer.
async function identifyBrandInFile(filePath, mediaType, mimeType, brands, categories) {
  const nothing = (status) => ({ status, detectedBrand: null, detectedCategory: null, categoryConfidence: null, confidence: null, method: null });
  if (mediaType === "audio") return nothing("unavailable");
  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return nothing("unavailable");
  }
  if (typeof provider.identify !== "function") return nothing("unavailable");
  try {
    const result = await provider.identify(filePath, mediaType, mimeType, brands || [], categories || []);
    return { status: result.status, detectedBrand: result.detectedBrand, detectedCategory: result.detectedCategory, categoryConfidence: result.categoryConfidence, confidence: result.confidence, method: result.method };
  } catch (e) {
    return nothing("error");
  }
}

module.exports = { getProvider, canonicalBrandName, identifyBrandInFile, parseBrandJson };
