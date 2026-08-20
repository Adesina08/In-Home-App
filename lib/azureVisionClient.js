// Shared thin client for Azure AI Vision "Image Analysis" (v4.0), used by both
// brand detection (lib/brandDetection.js) and the video-mode field pre-fill
// provider (lib/videoFieldExtraction.js), so both call the exact same REST
// endpoint the exact same way instead of duplicating HTTP plumbing.
//
// Docs: https://learn.microsoft.com/en-us/azure/ai-services/computer-vision/how-to/call-analyze-image-40

const API_VERSION = "2024-02-01";

// Sends raw image bytes to Azure AI Vision and returns the parsed JSON
// response. Throws with a readable message on any non-2xx response so
// callers can record a real error instead of a silent failure.
async function analyzeImageBuffer(endpoint, key, buffer, contentType = "application/octet-stream") {
  const base = endpoint.replace(/\/$/, "");
  const url = `${base}/computervision/imageanalysis:analyze?api-version=${API_VERSION}&features=tags,read`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Ocp-Apim-Subscription-Key": key,
      "Content-Type": contentType,
    },
    body: buffer,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Azure AI Vision request failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json();
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

module.exports = { analyzeImageBuffer, extractTextSignals, API_VERSION };
