const { test, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const originalFetch = global.fetch;

afterEach(() => {
  global.fetch = originalFetch;
});

const completed = (text) => new Response(JSON.stringify({ status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }));
const withEnv = async (env, fn) => {
  const saved = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  Object.assign(process.env, env);
  try { return await fn(); } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
};

test("retired Azure provider settings now select OpenAI", () => withEnv({ OPENAI_API_KEY: "k", BRAND_DETECTION_PROVIDER: "azure_vision", AUDIO_TRANSCRIPTION_PROVIDER: "azure_speech", VIDEO_FIELD_EXTRACTION_PROVIDER: "azure_vision", TRANSCRIPT_SCORING_PROVIDER: "azure_openai" }, () => {
  assert.equal(require("../lib/brandDetection").getProvider().adapter.name, "openai");
  assert.equal(require("../lib/audioTranscription").getProvider().constructor.name, "OpenAiSpeechProvider");
  assert.equal(require("../lib/videoFieldExtraction").getProvider().constructor.name, "OpenAiVideoFieldExtractionProvider");
  assert.equal(require("../lib/transcriptScoring").providerName(), "openai");
  assert.equal(require("../lib/localAudioTranscription").providerName(), "openai");
}));

test("OpenAI brand detection sends the photo to gpt-5.4-mini and parses the brand", () => withEnv({ OPENAI_API_KEY: "test-key", BRAND_DETECTION_PROVIDER: "openai" }, async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const photo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brand-")), "pack.jpg");
  fs.writeFileSync(photo, Buffer.from("fake-jpeg"));
  let body;
  global.fetch = async (url, options) => {
    assert.equal(url, "https://api.openai.com/v1/responses");
    body = JSON.parse(options.body);
    return completed('{"brand":"Maltina","brand_confidence":0.92,"category":"Malt drinks","category_confidence":0.95,"reason":"Label reads Maltina."}');
  };
  const { identifyBrandInFile } = require("../lib/brandDetection");
  const result = await identifyBrandInFile(photo, "photo", "image/jpeg", [{ name: "Maltina" }], ["Malt drinks"]);
  assert.equal(body.model, "gpt-5.4-mini");
  const image = body.input[0].content.find((part) => part.type === "input_image");
  assert.equal(image.image_url, `data:image/jpeg;base64,${Buffer.from("fake-jpeg").toString("base64")}`);
  assert.deepEqual(result, { status: "done", detectedBrand: "Maltina", detectedCategory: "Malt drinks", categoryConfidence: 0.95, confidence: 0.92, method: "llm_vision" });
}));

test("an unbranded plate still gets a category and its confidence, and no brand is invented", () => withEnv({ OPENAI_API_KEY: "test-key", BRAND_DETECTION_PROVIDER: "openai" }, async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const photo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brand-")), "plate.jpg");
  fs.writeFileSync(photo, "x");
  let prompt;
  global.fetch = async (url, options) => {
    prompt = JSON.parse(options.body).input[0].content.find((part) => part.type === "input_text").text;
    return completed('{"brand":null,"brand_confidence":null,"category":"Rice","category_confidence":0.83,"reason":"A plate of rice and beans, no packaging."}');
  };
  const { identifyBrandInFile } = require("../lib/brandDetection");
  const result = await identifyBrandInFile(photo, "photo", "image/jpeg", [], ["Rice", "Pasta", "Other food"]);
  assert.deepEqual(result, { status: "unavailable", detectedBrand: null, detectedCategory: "Rice", categoryConfidence: 0.83, confidence: null, method: "llm_vision" });
  assert.match(prompt, /rice and beans -> Rice/);
  assert.match(prompt, /use "Other food"/);
}));

test("a category answered with its bracketed AI label, or an old name, lands on the study's spelling", () => withEnv({ OPENAI_API_KEY: "test-key", BRAND_DETECTION_PROVIDER: "openai" }, async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const photo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brand-")), "can.jpg");
  fs.writeFileSync(photo, "x");
  const { identifyBrandInFile } = require("../lib/brandDetection");
  global.fetch = async () => completed('{"brand":"Coca-Cola","brand_confidence":0.97,"category":"CSD (carbonated soft drinks: cola, lemon-lime, orange soda)","category_confidence":0.9,"reason":"Red can."}');
  assert.equal((await identifyBrandInFile(photo, "photo", "image/jpeg", [], ["CSD"])).detectedCategory, "CSD");
  global.fetch = async () => completed('{"brand":"Indomie","brand_confidence":0.9,"category":"Noodles","category_confidence":0.9,"reason":"Pack."}');
  assert.equal((await identifyBrandInFile(photo, "photo", "image/jpeg", [], ["Instant Noodles"])).detectedCategory, "Instant Noodles");
}));

test("studies saved with the old flat category names read as the new ones", () => {
  const { parseCategories, toStoredCategories, categoryGroup } = require("../lib/categories");
  assert.deepEqual(parseCategories("Noodles|Malt Beverage|Toothpaste"), ["Instant Noodles", "Malt drinks", "Toothpaste"]);
  assert.equal(toStoredCategories(["Snacks products", "Rice"]), "Rice|Snacks");
  assert.equal(categoryGroup("Rice"), "Food");
  assert.equal(categoryGroup("Malt Beverage"), "Non Alcoholic");
  assert.equal(categoryGroup("Toothpaste"), "Household & Personal Care");
});

test("a low-confidence brand read needs review and an unparseable reply finds nothing", () => withEnv({ OPENAI_API_KEY: "test-key", BRAND_DETECTION_PROVIDER: "openai" }, async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const photo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brand-")), "pack.jpg");
  fs.writeFileSync(photo, "x");
  const { identifyBrandInFile } = require("../lib/brandDetection");
  global.fetch = async () => completed('{"brand":"Ovaltine","category":null,"confidence":0.4,"reason":"Blurry."}');
  assert.equal((await identifyBrandInFile(photo, "photo", "image/jpeg", [], [])).status, "needs_review");
  global.fetch = async () => completed("not json");
  assert.equal((await identifyBrandInFile(photo, "photo", "image/jpeg", [], [])).status, "unavailable");
}));

test("OpenAI speech-to-text uses the transcription model, not gpt-5.4-mini", () => withEnv({ OPENAI_API_KEY: "test-key" }, async () => {
  let request;
  global.fetch = async (url, options) => { request = { url, form: options.body }; return new Response(JSON.stringify({ text: "I drank Maltina at lunch." })); };
  const { transcribeAudio } = require("../lib/openaiClient");
  const text = await transcribeAudio({ buffer: Buffer.from("wav"), filename: "note.wav", mimeType: "audio/wav" });
  assert.equal(text, "I drank Maltina at lunch.");
  assert.equal(request.url, "https://api.openai.com/v1/audio/transcriptions");
  assert.equal(request.form.get("model"), "gpt-4o-mini-transcribe");
  assert.equal(request.form.get("file").name, "note.wav");
}));

test("video pre-fill keeps only answers that are the question's own options", () => {
  const { acceptAnswers } = require("../lib/videoFieldExtraction");
  const questions = [
    { id: 1, code: "BRAND", type: "single", options: ["Maltina", "Amstel Malta"] },
    { id: 2, code: "WHO", type: "multi", options: ["Alone", "Family", "Friends"] },
    { id: 3, code: "SERVINGS", type: "numeric", options: [] },
    { id: 4, code: "OCCASION", type: "single", options: ["Breakfast", "Lunch"] },
  ];
  const prefill = acceptAnswers(questions, { BRAND: "Maltina", WHO: ["Family", "Friends"], SERVINGS: 2, OCCASION: "Brunch" });
  assert.deepEqual(prefill, { BRAND: "Maltina", WHO: ["Family", "Friends"] });
});

test("long videos are sampled across their duration", () => {
  const { samplingInterval } = require("../lib/ffmpegFrames");
  assert.equal(samplingInterval(8, 2, 5), 2);
  assert.ok(samplingInterval(90, 2, 5) > 22);
});

test("custom categories are cleaned, never duplicate a built-in, and are stored with the study's ticks", () => {
  const { normalizeCustomCategories, toStoredCategories, categoryGroup, detectionCategories } = require("../lib/categories");
  const { customs, builtIns } = normalizeCustomCategories(["Zobo", "malt drink", "ZOBO", "Kunu|x", ""], ["Non Alcoholic", "Food", "Food", "Nonsense", "Food"], ["hibiscus drink", "", "", "", ""]);
  assert.deepEqual(customs, [
    { name: "Zobo", group: "Non Alcoholic", description: "hibiscus drink" },
    { name: "Kunu x", group: "Other", description: "" },
  ]);
  assert.deepEqual(builtIns, ["Malt drinks"]);
  const study = { category: toStoredCategories(["Rice", ...builtIns], customs), custom_categories: customs };
  assert.equal(study.category, "Rice|Malt drinks|Zobo|Kunu x");
  assert.equal(categoryGroup("Zobo", study.custom_categories), "Non Alcoholic");
  assert.deepEqual(detectionCategories(study).find((c) => c.name === "Zobo"), { name: "Zobo", ai: "Zobo (hibiscus drink)" });
});

test("detection offers a custom category, with its description, and can return it", () => withEnv({ OPENAI_API_KEY: "test-key", BRAND_DETECTION_PROVIDER: "openai" }, async () => {
  const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
  const photo = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "brand-")), "cup.jpg");
  fs.writeFileSync(photo, "x");
  let prompt;
  global.fetch = async (url, options) => {
    prompt = JSON.parse(options.body).input[0].content.find((part) => part.type === "input_text").text;
    return completed('{"brand":null,"brand_confidence":null,"category":"Zobo","category_confidence":0.77,"reason":"Deep red drink in a cup."}');
  };
  const { detectionCategories } = require("../lib/categories");
  const categories = detectionCategories({ category: "CSD|Zobo", custom_categories: [{ name: "Zobo", group: "Non Alcoholic", description: "hibiscus drink" }] });
  const result = await require("../lib/brandDetection").identifyBrandInFile(photo, "photo", "image/jpeg", [], categories);
  assert.match(prompt, /- Zobo \(hibiscus drink\)/);
  assert.match(prompt, /- CSD \(carbonated soft drinks/);
  assert.equal(result.detectedCategory, "Zobo");
  assert.equal(result.categoryConfidence, 0.77);
}));
