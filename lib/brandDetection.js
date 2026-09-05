// Pluggable brand-detection provider for photo/video evidence.
//
// Real brand/logo recognition needs a trained computer-vision model or a paid
// cloud API — this prototype cannot sign up for or call one without real
// credentials. What's built here is the wiring: every uploaded photo/video is
// queued for detection, the UI has a "Detected Brand" column and a manual
// "Run Detection" action, and the provider interface is ready for Azure AI
// Vision — set BRAND_DETECTION_PROVIDER=azure_vision and the Azure env vars in
// .env once you have a Computer Vision resource. See PRODUCTION_READINESS.md
// section B9.
//
// Suggested real implementation (Azure AI Vision "Image Analysis" v4.0):
//   1. POST the image/video frame to
//      {AZURE_VISION_ENDPOINT}/computervision/imageanalysis:analyze?features=tags,objects,read
//      with header Ocp-Apim-Subscription-Key: {AZURE_VISION_KEY}
//   2. Collect returned tags + any text found by the Read (OCR) feature.
//   3. Fuzzy-match tags/OCR text against this study's brands table (name/SKU).
//   4. For real logo detection (not just visible text), train an Azure AI
//      Custom Vision project on your brand logos and call its prediction
//      endpoint instead of generic tagging.
//   5. For video, sample frames (e.g. every 2s via ffmpeg) and run each frame
//      through the same pipeline, keeping the highest-confidence match.

const fs = require("fs");
const store = require("./store");
const { analyzeImageBuffer, extractTextSignals } = require("./azureVisionClient");
const { materializeLocalFile } = require("./mediaStorage");

// Very deliberately simple: case-insensitive substring match of each active
// brand's name against the flattened tag/OCR signals from Azure AI Vision.
// This is an honest, real (not fabricated) signal, but it is NOT logo
// recognition -- it only catches a brand whose name is legible as on-package
// text or matches a generic object tag. See the module doc above for the
// Custom Vision path to real logo-level detection.
function fuzzyMatchBrand(signals, brands) {
  for (const brand of brands) {
    const name = (brand.name || "").toLowerCase().trim();
    if (name.length < 3) continue; // too short to match confidently
    if (signals.some((s) => s.includes(name))) return brand;
  }
  return null;
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
      let signals = [];

      if (media.media_type === "video") {
        const { extractFrames } = require("./ffmpegFrames");
        const { files, cleanup } = await extractFrames(local.path, { everySeconds: 2, maxFrames: 5 });
        try {
          for (const framePath of files) {
            const buf = fs.readFileSync(framePath);
            const result = await analyzeImageBuffer(this.endpoint, this.key, buf, "image/jpeg");
            signals.push(...extractTextSignals(result));
          }
        } finally {
          cleanup();
        }
      } else {
        const buf = fs.readFileSync(local.path);
        const result = await analyzeImageBuffer(this.endpoint, this.key, buf, "application/octet-stream");
        signals = extractTextSignals(result);
      }

      const match = fuzzyMatchBrand(signals, brands);
      await store.update(
        "media",
        { id: media.id },
        {
          detection_status: match ? "done" : "unavailable",
          detected_brand: match ? match.name : null,
          detection_provider: "azure_vision",
          detection_raw_json: JSON.stringify({
            signals: signals.slice(0, 50),
            matchedBrand: match ? match.name : null,
            note: match
              ? "Matched via on-package text/tag recognition (Azure AI Vision), not logo recognition — verify against the photo/video before treating as final."
              : "No configured brand name matched the detected tags/OCR text.",
          }),
        }
      );
      return { status: match ? "done" : "unavailable", detectedBrand: match ? match.name : null };
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

module.exports = { getProvider };
