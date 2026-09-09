// Shared thin client for Azure AI Vision "Image Analysis" (v4.0), used by both
// brand detection (lib/brandDetection.js) and the video-mode field pre-fill
// provider (lib/videoFieldExtraction.js), so both call the exact same REST
// endpoint the exact same way instead of duplicating HTTP plumbing.
//
// Docs: https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/how-to/call-analyze-image-40

const API_VERSION = "2024-02-01";
const BRAND_API_VERSION = "3.2";

async function postImage(url, key, buffer, contentType) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Ocp-Apim-Subscription-Key": key,
          "Content-Type": contentType,
        },
        body: buffer,
        signal: controller.signal,
      });
      if (res.ok) return res.json();

      const text = await res.text().catch(() => "");
      const error = new Error(`Azure AI Vision request failed (${res.status}): ${text.slice(0, 500)}`);
      if (res.status !== 408 && res.status !== 429 && res.status < 500) {
        error.retryable = false;
        throw error;
      }
      lastError = error;
    } catch (error) {
      lastError = error?.name === "AbortError"
        ? new Error("Azure AI Vision request timed out after 15 seconds.")
        : error;
      if (lastError?.retryable === false || attempt === 3) throw lastError;
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 250));
  }
  throw lastError;
}

// Sends raw image bytes to Azure AI Vision and returns the parsed JSON
// response. Throws with a readable message on any non-2xx response so
// callers can record a real error instead of a silent failure.
async function analyzeImageBuffer(endpoint, key, buffer, contentType = "application/octet-stream") {
  const base = endpoint.replace(/\/$/, "");
  const url = `${base}/computervision/imageanalysis:analyze?api-version=${API_VERSION}&features=tags,read`;
  return postImage(url, key, buffer, contentType);
}

// Brand/logo recognition is a dedicated Image Analysis v3.2 feature. It is
// not present in the v4 tags/read response above. Azure returns the detected
// logo name, a model confidence and a bounding rectangle for every hit.
async function analyzeBrandLogos(endpoint, key, buffer, contentType = "application/octet-stream") {
  const base = endpoint.replace(/\/$/, "");
  const url = `${base}/vision/v${BRAND_API_VERSION}/analyze?visualFeatures=Brands&language=en`;
  return postImage(url, key, buffer, contentType);
}

function extractLogoSignals(result) {
  return (result?.brands || [])
    .filter((brand) => brand?.name && Number.isFinite(Number(brand.confidence)))
    .map((brand) => ({
      name: String(brand.name),
      confidence: Number(brand.confidence),
      rectangle: brand.rectangle || null,
    }));
}

// Flattens a v4.0 Image Analysis response into a plain array of lowercase
// strings we can fuzzy-match against brand names / question options: every
// detected tag name, plus every line of text the Read (OCR) feature found on
// packaging/labels.
function extractTextSignals(result) {
  const signals = [];
  for (const t of result?.tagsResult?.values || []) {
    if (t?.name) signals.push(String(t.name).toLowerCase());
  }
  for (const block of result?.readResult?.blocks || []) {
    for (const line of block?.lines || []) {
      if (line?.text) signals.push(String(line.text).toLowerCase());
    }
  }
  return signals;
}

module.exports = {
  analyzeImageBuffer,
  analyzeBrandLogos,
  extractTextSignals,
  extractLogoSignals,
  API_VERSION,
  BRAND_API_VERSION,
};
