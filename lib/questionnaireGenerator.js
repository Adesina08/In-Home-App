// "Generate with AI" for the questionnaire tab. The model drafts questions in
// the import template's columns, and they go through the same normalisation
// and preview/commit as an uploaded spreadsheet (lib/questionnaireParser.js),
// so nothing reaches the study until someone reviews and commits it. Commit
// appends after existing questions.
const { parseRows } = require("./questionnaireParser");
const { STUDY_TYPES, studyTypeOf, recipeKpis } = require("./studyRecipes");

const TYPES = ["single", "multi", "numeric", "scale", "rank", "text", "date", "time", "photo", "video", "audio"];

// Same provider choice as KPI mapping (lib/kpiMapping.js): QUESTIONNAIRE_AI_PROVIDER,
// else the AI summary provider, else whichever of the two has a key.
function provider() {
  const keys = { openai: !!process.env.OPENAI_API_KEY?.trim(), gemini: !!process.env.GEMINI_API_KEY?.trim() };
  const chosen = String(process.env.QUESTIONNAIRE_AI_PROVIDER || "").trim().toLowerCase();
  const preferred = chosen || (process.env.AI_SUMMARY_PROVIDER === "gemini" ? "gemini" : "openai");
  const name = keys[preferred] ? preferred : !chosen && keys.openai ? "openai" : !chosen && keys.gemini ? "gemini" : null;
  if (!name) return null;
  if (name === "gemini") {
    const gemini = require("./geminiClient");
    return ({ system, prompt }) => gemini.generateText({
      apiKey: process.env.GEMINI_API_KEY, model: process.env.GEMINI_MODEL || gemini.DEFAULT_MODEL,
      systemInstruction: system, prompt, temperature: 0.4, maxOutputTokens: 16000, timeoutMs: 150000,
    });
  }
  const openai = require("./openaiClient");
  return ({ system, prompt }) => openai.generateText({
    model: process.env.OPENAI_QUESTIONNAIRE_MODEL?.trim() || openai.configuredModel(),
    system, prompt, maxTokens: 16000, timeoutMs: 150000, json: true, label: "questionnaire generation",
  });
}

const SYSTEM = [
  "You are a senior market-research questionnaire designer writing a consumer diary questionnaire.",
  "Respondents answer it on their phone each time they log an entry, so questions are short, plain and quick to answer, in the language of the brief.",
  "Rules:",
  `- type is one of: ${TYPES.join(", ")}. Prefer single/multi with clear options; use numeric for counts and money, scale for ratings (set minimum and maximum), text sparingly, photo when evidence helps.`,
  "- single and multi need options. Add \"Other\" with other_specify_options [\"Other\"] when the list can't be complete, and an exclusive \"None of these\" on multi questions where it makes sense. exclusive_options must stay [] on every non-multi question.",
  "- Number codes Q1, Q2, ... in order. condition is \"\" or exactly \"Show if Q<n> equals <option>\" (join several values with \" or \"), and may only refer to an earlier question in this list.",
  "- Group questions into short sections in a natural answering order (screening, the occasion, product and brand, context, evaluation, wrap-up).",
  "- Cover every research input listed under kpi_inputs with a fitting question so the study's KPIs can be calculated; `describe` says what the question must capture.",
  "- When existing_questions is not empty, you are adding to that questionnaire: do not repeat what it already asks.",
  'Respond with ONLY strict JSON: {"questions": [{"code": "Q1", "section": "", "question": "", "type": "single", "options": [], "required": true, "minimum": null, "maximum": null, "condition": "", "other_specify_options": [], "exclusive_options": []}]}',
].join("\n");

function kpiInputs(study) {
  const seen = new Map();
  for (const kpi of recipeKpis(study)) for (const input of kpi.inputs) {
    if (!seen.has(input.role)) seen.set(input.role, { role: input.role, describe: input.describe, accepts: input.accepts });
  }
  return [...seen.values()];
}

function buildPrompt(study, brief, existing) {
  const type = STUDY_TYPES[studyTypeOf(study)];
  return "Write the questionnaire for this brief and answer in JSON.\n" + JSON.stringify({
    study: {
      name: study.name || "",
      type: type ? `${type.label}: ${type.description}` : "Consumer diary study",
      diary_mode: study.diary_mode || "daily",
      market: study.market || "",
      categories: study.category || "",
    },
    brief: {
      description: brief.description,
      ...(brief.brands ? { brands_of_interest: brief.brands } : {}),
      ...(brief.notes ? { include_or_avoid: brief.notes } : {}),
      approximate_question_count: brief.questionCount,
    },
    kpi_inputs: kpiInputs(study),
    existing_questions: existing.slice(0, 200).map((q) => ({ code: q.code || null, text: String(q.text || "").slice(0, 200), type: q.type })),
  });
}

const list = (v) => (Array.isArray(v) ? v : v ? [v] : []).map((s) => String(s).replace(/\|/g, "/").trim()).filter(Boolean);

// The model numbers from Q1; shift its codes (and the conditions that cite
// them) past the study's existing Q-codes so appended questions never clash.
function toTemplateRows(questions, existing) {
  const offset = Math.max(0, ...existing.map((q) => Number((/^Q(\d+)$/i.exec(q.code || "") || [])[1]) || 0));
  const shift = (s) => String(s || "").replace(/\bQ(\d+)\b/gi, (_, n) => `Q${Number(n) + offset}`);
  return questions.filter((q) => q && String(q.question || "").trim()).map((q) => ({
    Code: shift(q.code),
    Section: String(q.section || "").trim(),
    Question: String(q.question).trim(),
    Type: TYPES.includes(q.type) ? q.type : String(q.type || ""),
    Options: list(q.options).join("|"),
    Required: q.required === false ? "No" : "Yes",
    Minimum: q.minimum ?? "",
    Maximum: q.maximum ?? "",
    Condition: /^show if q\d+ /i.test(String(q.condition || "").trim()) ? shift(q.condition.trim()) : "",
    "Other specify options": list(q.other_specify_options).join("|"),
    "Exclusive options": list(q.exclusive_options).join("|"),
  }));
}

async function generateQuestionnaire({ study, brief, existing = [], complete = provider() }) {
  if (!complete) throw new Error("No AI provider is configured. Add OPENAI_API_KEY or GEMINI_API_KEY to the server environment.");
  const raw = await complete({ system: SYSTEM, prompt: buildPrompt(study, brief, existing) });
  let parsed;
  try {
    parsed = JSON.parse(String(raw || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch {
    throw new Error("The AI reply wasn't valid JSON. Please try again.");
  }
  const rows = parseRows(toTemplateRows(Array.isArray(parsed.questions) ? parsed.questions : [], existing));
  if (!rows.length) throw new Error("The AI didn't return any questions. Add more detail to the brief and try again.");
  return rows;
}

module.exports = { generateQuestionnaire, buildPrompt, toTemplateRows, provider };
