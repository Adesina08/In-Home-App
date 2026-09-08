const store = require("./store");
const { parseOptions } = require("./questionnaire");

async function forStudy(study) {
  if (!study) return [];
  const code = String(study.brand_question_code || "brand").trim().toLowerCase();
  const questions = await store.find("questions", { study_id: study.id, active: 1 });
  const question = questions.find((item) => String(item.code || "").trim().toLowerCase() === code);
  return question ? parseOptions(question.options_json || question.options).map((name) => ({ name, sku: null, source: "questionnaire" })) : [];
}

module.exports = { forStudy };
