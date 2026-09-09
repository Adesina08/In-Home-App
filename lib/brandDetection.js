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
// confident and clearly ahead of a competing configured brand. OCR can still
// suggest a candidate, but it is deliberately sent to human review rather than
// being written as a completed visual detection.
function selectBrandMatch({ logos, textSignals, brands, minConfidence = 0.7, minMargin = 0.1 }) {
  const scores = new Map();
  for (const logo of logos) {
    if (logo.confidence < minConfidence) continue;
    const brand = configuredBrandFor(logo.name, brands);
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
      status: ambiguous ? "needs_review" : "done",
      brand: top.brand,
      confidence: top.confidence,
      score: top.score,
      method: "azure_logo",
      ambiguousWith: ambiguous ? runnerUp.brand.name : null,
      evidence: top.logos,
    };
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
  async detect(media, brands) {
    let local;
    try {
      local = await materializeLocalFile(media.file_path);
      const logos = [];
      const textSignals = [];
      const warnings = [];

      if (media.media_type === "video") {
        const { extractFrames } = require("./ffmpegFrames");
        const { files, cleanup } = await extractFrames(local.path, { everySeconds: 2, maxFrames: 5 });
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
        const buf = fs.readFileSync(local.path);
        const result = await analyzeFrame(this.endpoint, this.key, buf, "application/octet-stream");
        logos.push(...result.logos);
        textSignals.push(...result.textSignals);
        warnings.push(...result.warnings);
      }

      const minConfidence = boundedNumber(process.env.BRAND_LOGO_MIN_CONFIDENCE, 0.7, 0, 1);
      const minMargin = boundedNumber(process.env.BRAND_LOGO_MIN_MARGIN, 0.1, 0, 1);
      const match = selectBrandMatch({ logos, textSignals, brands, minConfidence, minMargin });
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

function getProvider() {
  const providerName = process.env.BRAND_DETECTION_PROVIDER || "mock";
  if (providerName === "azure_vision") return new AzureVisionProvider();
  return new MockBrandDetectionProvider();
}

module.exports = { getProvider, canonicalBrandName, selectBrandMatch };
