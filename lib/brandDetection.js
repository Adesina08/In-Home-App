// Pluggable brand-detection provider for photo/video evidence.
//
// The Azure provider combines the dedicated Image Analysis v3.2 Brands model
// (real logo detection with confidence and bounding boxes) with v4 OCR as a
// conservative fallback. OCR-only and ambiguous matches require review.
//
// The built-in catalogue covers thousands of popular global logos. A study
// whose brands are absent from that catalogue still needs a custom-trained
// detector and a labelled evaluation set; no generic API can infer those.

const fs = require("fs");
const store = require("./store");
const {
  analyzeImageBuffer,
  analyzeBrandLogos,
  extractTextSignals,
  extractLogoSignals,
} = require("./azureVisionClient");
const { identifyBrand: identifyBrandWithGemini, identifyBrandFromTranscript } = require("./geminiClient");
const { materializeLocalFile } = require("./mediaStorage");

function canonicalBrandName(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9]+/g, "");
}

function configuredBrandFor(label, brands) {
  const wanted = canonicalBrandName(label);
  if (!wanted) return null;
  return brands.find((brand) => canonicalBrandName(brand.name) === wanted) || null;
}

function boundedNumber(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

// A logo is accepted automatically only when Azure's dedicated logo model is
// confident and clearly ahead of a competing brand. When the study has a
// configured candidate list, a logo hit is cross-checked against it and can
// be accepted outright; without one there's nothing to cross-check against,
// so Azure's raw logo read is still surfaced (it's real signal from a real
// detector) but always sent to human review rather than written as a
// completed detection. OCR text matching, by contrast, genuinely needs a
// candidate list -- a bare substring match against arbitrary packaging text
// with no target to check against is too likely to be noise.
function selectBrandMatch({ logos, textSignals, brands, minConfidence = 0.7, minMargin = 0.1 }) {
  const hasCandidates = Array.isArray(brands) && brands.length > 0;
  const scores = new Map();
  for (const logo of logos) {
    if (logo.confidence < minConfidence) continue;
    const brand = hasCandidates ? configuredBrandFor(logo.name, brands) : { name: logo.name };
    if (!brand) continue;
    const current = scores.get(brand.name) || { brand, confidence: 0, hits: 0, logos: [] };
    current.confidence = Math.max(current.confidence, logo.confidence);
    current.hits += 1;
    current.logos.push(logo);
    scores.set(brand.name, current);
  }

  const ranked = [...scores.values()]
    .map((item) => ({ ...item, score: Math.min(1, item.confidence + Math.min(0.09, (item.hits - 1) * 0.03)) }))
    .sort((a, b) => b.score - a.score || b.confidence - a.confidence || a.brand.name.localeCompare(b.brand.name));
  if (ranked.length) {
    const top = ranked[0];
    const runnerUp = ranked[1];
    const ambiguous = runnerUp && top.score - runnerUp.score < minMargin;
    return {
      // Without a candidate list there's no configured brand to confirm
      // against, so even a clean, unambiguous logo hit is a suggestion, not
      // a finished detection.
      status: !hasCandidates ? "needs_review" : ambiguous ? "needs_review" : "done",
      brand: top.brand,
      confidence: top.confidence,
      score: top.score,
      method: "azure_logo",
      ambiguousWith: ambiguous ? runnerUp.brand.name : null,
      evidence: top.logos,
    };
  }

  if (!hasCandidates) {
    return { status: "unavailable", brand: null, confidence: null, score: null, method: null, ambiguousWith: null, evidence: [] };
  }
  const textMatches = brands.filter((brand) => {
    const name = canonicalBrandName(brand.name);
    return name.length >= 3 && textSignals.some((signal) => canonicalBrandName(signal).includes(name));
  });
  const unique = [...new Map(textMatches.map((brand) => [brand.name, brand])).values()];
  if (unique.length === 1) {
    return { status: "needs_review", brand: unique[0], confidence: null, score: null, method: "ocr", ambiguousWith: null, evidence: [] };
  }
  return { status: "unavailable", brand: null, confidence: null, score: null, method: null, ambiguousWith: null, evidence: [] };
}

async function analyzeFrame(endpoint, key, buffer, contentType) {
  const [logoResult, textResult] = await Promise.allSettled([
    analyzeBrandLogos(endpoint, key, buffer, contentType),
    analyzeImageBuffer(endpoint, key, buffer, contentType),
  ]);
  if (logoResult.status === "rejected" && textResult.status === "rejected") {
    throw new Error(`Logo and OCR analysis failed: ${logoResult.reason?.message || textResult.reason?.message}`);
  }
  return {
    logos: logoResult.status === "fulfilled" ? extractLogoSignals(logoResult.value) : [],
    textSignals: textResult.status === "fulfilled" ? extractTextSignals(textResult.value) : [],
    warnings: [logoResult, textResult]
      .filter((result) => result.status === "rejected")
      .map((result) => result.reason?.message || "Azure analysis failed"),
  };
}

class MockBrandDetectionProvider {
  async detect(media, brands) {
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
          detection_review_status: null,
          detection_verified_by: null,
          detection_verified_at: null,
          detection_raw_json: JSON.stringify({
            note: "No brand-detection model is configured in this prototype. Configure Azure AI Vision credentials to enable real detection.",
            candidateBrands: brands.map((b) => b.name),
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

class AzureVisionProvider {
  constructor() {
    this.endpoint = process.env.AZURE_VISION_ENDPOINT;
    this.key = process.env.AZURE_VISION_KEY;
    if (!this.endpoint || !this.key) {
      throw new Error(
        "AZURE_VISION_ENDPOINT / AZURE_VISION_KEY missing. Set real Azure AI Vision credentials in .env (see PRODUCTION_READINESS.md B9) or leave BRAND_DETECTION_PROVIDER=mock."
      );
    }
  }
  // Core logo/OCR read plus candidate match for a local image/video file, with
  // no database side effects -- shared by detect() (persists the result
  // against a submitted media row) and the in-app live preview (nothing
  // durable exists yet while the respondent is still answering). `mimeType`
  // is accepted but unused -- kept only so this matches GeminiVisionProvider's
  // identify() signature; Azure's endpoints get a fixed content type per
  // branch below regardless of the source file's real MIME type.
  async identify(localPath, mediaType, mimeType, brands) {
    const logos = [];
    const textSignals = [];
    const warnings = [];

    if (mediaType === "video") {
      const { extractFrames } = require("./ffmpegFrames");
      const { files, cleanup } = await extractFrames(localPath, { everySeconds: 2, maxFrames: 5 });
      try {
        for (let frameIndex = 0; frameIndex < files.length; frameIndex += 1) {
          const framePath = files[frameIndex];
          const buf = fs.readFileSync(framePath);
          const result = await analyzeFrame(this.endpoint, this.key, buf, "image/jpeg");
          logos.push(...result.logos.map((logo) => ({ ...logo, frame: frameIndex + 1 })));
          textSignals.push(...result.textSignals);
          warnings.push(...result.warnings);
        }
      } finally {
        cleanup();
      }
    } else {
      const buf = fs.readFileSync(localPath);
      const result = await analyzeFrame(this.endpoint, this.key, buf, "application/octet-stream");
      logos.push(...result.logos);
      textSignals.push(...result.textSignals);
      warnings.push(...result.warnings);
    }

    const minConfidence = boundedNumber(process.env.BRAND_LOGO_MIN_CONFIDENCE, 0.7, 0, 1);
    const minMargin = boundedNumber(process.env.BRAND_LOGO_MIN_MARGIN, 0.1, 0, 1);
    const match = selectBrandMatch({ logos, textSignals, brands, minConfidence, minMargin });
    return { logos, textSignals, warnings, match, minConfidence, minMargin };
  }
  async detect(media, brands) {
    // Azure AI Vision reads pixels, not speech -- there is no frame to
    // analyse in a voice note. Report plainly rather than feeding audio
    // bytes into an image endpoint and surfacing whatever error that
    // produces.
    if (media.media_type === "audio") {
      try {
        await store.update("media", { id: media.id }, {
          detection_status: "unavailable", detection_provider: "azure_vision",
          detection_confidence: null, detection_method: null,
          detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
          detection_raw_json: JSON.stringify({ note: "Azure AI Vision cannot read a brand from an audio transcript. Set BRAND_DETECTION_PROVIDER=gemini_vision for transcript-based detection." }),
        });
      } catch (writeErr) {
        console.error("Brand detection status write failed:", writeErr.message);
      }
      return { status: "unavailable" };
    }
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const { logos, textSignals, warnings, match, minConfidence, minMargin } = await this.identify(local.path, media.media_type, null, brands);
      await store.update(
        "media",
        { id: media.id },
        {
          detection_status: match.status,
          detected_brand: match.brand ? match.brand.name : null,
          detection_confidence: match.confidence,
          detection_method: match.method,
          detection_review_status: null,
          detection_verified_by: null,
          detection_verified_at: null,
          detection_provider: "azure_vision",
          detection_raw_json: JSON.stringify({
            logos: logos.slice(0, 50),
            textSignals: textSignals.slice(0, 50),
            matchedBrand: match.brand ? match.brand.name : null,
            method: match.method,
            confidence: match.confidence,
            score: match.score,
            ambiguousWith: match.ambiguousWith,
            warnings,
            thresholds: { minConfidence, minMargin },
            note: match.status === "done"
              ? "Accepted from Azure's dedicated logo detector after confidence and ambiguity checks."
              : match.status === "needs_review"
                ? "A possible brand was found, but it requires human confirmation."
                : "No configured brand passed the logo-confidence or OCR review rules.",
          }),
        }
      );
      return {
        status: match.status,
        detectedBrand: match.brand ? match.brand.name : null,
        confidence: match.confidence,
        method: match.method,
      };
    } catch (e) {
      // The error write is itself a store round trip now, so it gets its own
      // guard: detect() runs fire-and-forget and must never reject.
      try {
        await store.update(
          "media",
          { id: media.id },
          {
            detection_status: "error",
            detection_provider: "azure_vision",
            detection_confidence: null,
            detection_method: null,
            detection_review_status: null,
            detection_verified_by: null,
            detection_verified_at: null,
            detection_raw_json: JSON.stringify({ error: e.message }),
          }
        );
      } catch (writeErr) {
        console.error("Brand detection status write failed:", writeErr.message);
      }
      return { status: "error", error: e.message };
    } finally {
      if (local) local.cleanup();
    }
  }
}

const IMAGE_EXTENSION_MIME = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif", heic: "image/heic", heif: "image/heif" };
// Gemini rejects a generic "application/octet-stream" content type (unlike
// Azure's OCR endpoint, which doesn't care) -- it needs a real image MIME
// type. Uploads store one in `media.mimetype`; this is the fallback for rows
// that predate that column, inferred from the file extension.
function imageMimeType(media) {
  if (media.mimetype && media.mimetype.startsWith("image/")) return media.mimetype;
  const ext = String(media.file_path || "").split(".").pop().toLowerCase();
  return IMAGE_EXTENSION_MIME[ext] || "image/jpeg";
}

// Azure's Brands model is a closed catalogue of a few thousand globally
// famous logos -- it has no concept of market-specific brands (tested
// against real Nigerian FMCG packaging: it missed a Gala sausage roll
// entirely and misread a Maltina bottle as "Ovaltine" at ~0.69 confidence).
// This provider instead asks a general vision-capable LLM to read whichever
// brand is actually shown or spoken -- genuinely open-vocabulary, not gated
// on the study having a "brand" question with the right options configured.
// A study's configured candidates (if any) are passed through only as a
// naming hint; detection runs, and works, with or without them. Audio gets
// the same open-vocabulary read applied to its transcript instead of a
// frame, since there's no picture to look at in a voice note.
class GeminiVisionProvider {
  constructor() {
    this.apiKey = process.env.GEMINI_API_KEY;
    this.model = process.env.GEMINI_MODEL || undefined;
    if (!this.apiKey) {
      throw new Error(
        "GEMINI_API_KEY missing. Set a real Gemini API key in .env (get one at aistudio.google.com/apikey) or leave BRAND_DETECTION_PROVIDER=mock."
      );
    }
  }
  // Core open-vocabulary read for a local image/video file, with no database
  // side effects -- shared by detect() (persists against a submitted media
  // row) and the in-app live preview (nothing durable exists yet while the
  // respondent is still answering).
  async identify(localPath, mediaType, mimeType, brands) {
    const candidateNames = (brands || []).map((b) => b.name);
    const attempts = [];

    if (mediaType === "video") {
      const { extractFrames } = require("./ffmpegFrames");
      const { files, cleanup } = await extractFrames(localPath, { everySeconds: 2, maxFrames: 3 });
      try {
        for (const framePath of files) {
          const buf = fs.readFileSync(framePath);
          attempts.push(await identifyBrandWithGemini({ apiKey: this.apiKey, model: this.model, buffer: buf, mimeType: "image/jpeg", candidateNames }));
        }
      } finally {
        cleanup();
      }
    } else {
      const buf = fs.readFileSync(localPath);
      attempts.push(await identifyBrandWithGemini({ apiKey: this.apiKey, model: this.model, buffer: buf, mimeType: mimeType || "image/jpeg", candidateNames }));
    }

    const hits = attempts.filter((a) => a && a.brand);
    const best = hits.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0] || null;
    const minConfidence = boundedNumber(process.env.BRAND_LOGO_MIN_CONFIDENCE, 0.7, 0, 1);
    const status = !best ? "unavailable" : best.confidence >= minConfidence ? "done" : "needs_review";
    return { status, detectedBrand: best ? best.brand : null, confidence: best ? best.confidence : null, method: best ? "llm_vision" : null, attempts, candidateNames, minConfidence };
  }
  async detect(media, brands) {
    if (media.media_type === "audio") return this.detectFromTranscript(media, brands);
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const result = await this.identify(local.path, media.media_type, imageMimeType(media), brands);

      await store.update("media", { id: media.id }, {
        detection_status: result.status,
        detected_brand: result.detectedBrand,
        detection_confidence: result.confidence,
        detection_method: result.method,
        detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
        detection_provider: "gemini_vision",
        detection_raw_json: JSON.stringify({
          candidateBrands: result.candidateNames,
          attempts: result.attempts.map((a) => a ? { brand: a.brand, confidence: a.confidence, reason: a.reason } : { unparsed: true }),
          thresholds: { minConfidence: result.minConfidence },
          note: result.status === "done" ? "Accepted from the LLM-vision read after the confidence check."
            : result.status === "needs_review" ? "A possible brand was identified, but it requires human confirmation."
            : "No brand was legible in the photo.",
        }),
      });
      return { status: result.status, detectedBrand: result.detectedBrand, confidence: result.confidence, method: result.method };
    } catch (e) {
      try {
        await store.update("media", { id: media.id }, {
          detection_status: "error", detection_provider: "gemini_vision",
          detection_confidence: null, detection_method: null,
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
  async detectFromTranscript(media, brands) {
    try {
      const row = media.transcript_text !== undefined ? media : await store.findOne("media", { id: media.id });
      const transcript = row && row.transcript_text ? String(row.transcript_text).trim() : "";
      if (!transcript) {
        await store.update("media", { id: media.id }, {
          detection_status: "unavailable", detection_provider: "gemini_vision",
          detection_confidence: null, detection_method: null,
          detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
          detection_raw_json: JSON.stringify({ note: "No transcript is available yet to read a brand from." }),
        });
        return { status: "unavailable" };
      }

      const candidateNames = (brands || []).map((b) => b.name);
      const result = await identifyBrandFromTranscript({ apiKey: this.apiKey, model: this.model, transcript, candidateNames });
      const minConfidence = boundedNumber(process.env.BRAND_LOGO_MIN_CONFIDENCE, 0.7, 0, 1);
      const status = !result || !result.brand ? "unavailable" : result.confidence >= minConfidence ? "done" : "needs_review";

      await store.update("media", { id: media.id }, {
        detection_status: status,
        detected_brand: result ? result.brand : null,
        detection_confidence: result ? result.confidence : null,
        detection_method: result && result.brand ? "llm_transcript" : null,
        detection_review_status: null, detection_verified_by: null, detection_verified_at: null,
        detection_provider: "gemini_vision",
        detection_raw_json: JSON.stringify({
          transcript,
          candidateBrands: candidateNames,
          result,
          thresholds: { minConfidence },
          note: status === "done" ? "Accepted from the transcript read after the confidence check."
            : status === "needs_review" ? "A possible brand was named, but it requires human confirmation."
            : "No brand was named in the transcript.",
        }),
      });
      return { status, detectedBrand: result ? result.brand : null, confidence: result ? result.confidence : null, method: result && result.brand ? "llm_transcript" : null };
    } catch (e) {
      try {
        await store.update("media", { id: media.id }, {
          detection_status: "error", detection_provider: "gemini_vision",
          detection_confidence: null, detection_method: null,
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
  if (providerName === "azure_vision") return new AzureVisionProvider();
  if (providerName === "gemini_vision") return new GeminiVisionProvider();
  return new MockBrandDetectionProvider();
}

// Live in-app preview while a respondent is still answering a photo/video
// diary question -- no media row exists yet to persist against (that only
// happens once the entry is submitted), so this calls the same provider
// logic as detect() above but returns the result directly. Never throws: a
// failed preview should not block the respondent from continuing to answer.
async function identifyBrandInFile(filePath, mediaType, mimeType, brands) {
  if (mediaType === "audio") return { status: "unavailable", detectedBrand: null, confidence: null, method: null };
  let provider;
  try {
    provider = getProvider();
  } catch (e) {
    return { status: "unavailable", detectedBrand: null, confidence: null, method: null };
  }
  if (typeof provider.identify !== "function") return { status: "unavailable", detectedBrand: null, confidence: null, method: null };
  try {
    const result = await provider.identify(filePath, mediaType, mimeType, brands || []);
    return { status: result.status, detectedBrand: result.detectedBrand, confidence: result.confidence, method: result.method };
  } catch (e) {
    return { status: "error", detectedBrand: null, confidence: null, method: null };
  }
}

module.exports = { getProvider, canonicalBrandName, selectBrandMatch, identifyBrandInFile };
