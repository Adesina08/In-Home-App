const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

test("dedicated Azure logo call uses Image Analysis v3.2 Brands and parses confidence", async () => {
  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      json: async () => ({
        brands: [{ name: "Coca-Cola", confidence: 0.94, rectangle: { x: 1, y: 2, w: 3, h: 4 } }],
      }),
    };
  };

  const { analyzeBrandLogos, extractLogoSignals } = require("../lib/azureVisionClient");
  const response = await analyzeBrandLogos("https://vision.example/", "secret", Buffer.from("image"), "image/jpeg");
  assert.equal(request.url, "https://vision.example/vision/v3.2/analyze?visualFeatures=Brands&language=en");
  assert.equal(request.options.headers["Ocp-Apim-Subscription-Key"], "secret");
  assert.deepEqual(extractLogoSignals(response), [
    { name: "Coca-Cola", confidence: 0.94, rectangle: { x: 1, y: 2, w: 3, h: 4 } },
  ]);
});

test("high-confidence dedicated logo is accepted despite punctuation differences", () => {
  const { selectBrandMatch } = require("../lib/brandDetection");
  const result = selectBrandMatch({
    logos: [{ name: "Coca-Cola", confidence: 0.91, rectangle: { x: 1, y: 2, w: 3, h: 4 } }],
    textSignals: [],
    brands: [{ name: "Coca Cola" }, { name: "Pepsi" }],
  });
  assert.equal(result.status, "done");
  assert.equal(result.brand.name, "Coca Cola");
  assert.equal(result.method, "azure_logo");
  assert.equal(result.confidence, 0.91);
});

test("low-confidence logo is not accepted and OCR-only evidence requires review", () => {
  const { selectBrandMatch } = require("../lib/brandDetection");
  const result = selectBrandMatch({
    logos: [{ name: "Pepsi", confidence: 0.4 }],
    textSignals: ["pepsi max"],
    brands: [{ name: "Pepsi" }],
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.brand.name, "Pepsi");
  assert.equal(result.method, "ocr");
  assert.equal(result.confidence, null);
});

test("close competing logo scores are flagged as ambiguous", () => {
  const { selectBrandMatch } = require("../lib/brandDetection");
  const result = selectBrandMatch({
    logos: [
      { name: "Pepsi", confidence: 0.88 },
      { name: "Coca-Cola", confidence: 0.84 },
    ],
    textSignals: [],
    brands: [{ name: "Pepsi" }, { name: "Coca Cola" }],
    minMargin: 0.1,
  });
  assert.equal(result.status, "needs_review");
  assert.equal(result.brand.name, "Pepsi");
  assert.equal(result.ambiguousWith, "Coca Cola");
});

test("unconfigured Azure logos are not mapped to a study brand", () => {
  const { selectBrandMatch } = require("../lib/brandDetection");
  const result = selectBrandMatch({
    logos: [{ name: "Microsoft", confidence: 0.99 }],
    textSignals: [],
    brands: [{ name: "Pepsi" }],
  });
  assert.equal(result.status, "unavailable");
  assert.equal(result.brand, null);
});

test("long videos are sampled across their duration", () => {
  const { samplingInterval } = require("../lib/ffmpegFrames");
  assert.equal(samplingInterval(8, 2, 5), 2);
  assert.ok(samplingInterval(90, 2, 5) > 22);
});
