const store = require("./store");

// Shared by the respondent-facing diary form, invitation pre-survey and the
// admin Preview screen. Older study data can contain options_json in more than
// one shape (JSON string, already-parsed array, or blank/null), especially after
// migration between the local store and MongoDB. A malformed option payload
// must never take down public onboarding with a generic 500.
function parseOptions(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw === undefined || raw === null || raw === "") return [];
  if (typeof raw === "object") return Array.isArray(raw.options) ? raw.options : [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed : [];
  } catch (e) {
    console.error("Invalid questionnaire options_json; rendering question without options:", e.message);
    return [];
  }
}

async function loadQuestionnaire(studyId) {
  const questions = await store.find(
    "questions",
    { study_id: studyId, active: 1 },
    { sort: { order_index: 1, id: 1 } }
  );
  const rules = await store.find("skip_rules", { study_id: studyId }, { sort: { id: 1 } });
  questions.forEach((q) => {
    q.options = parseOptions(q.options_json !== undefined ? q.options_json : q.options);
  });
  return { questions, rules };
}

module.exports = { loadQuestionnaire, parseOptions };
