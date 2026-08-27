const store = require("./store");

// Shared by the respondent-facing diary form and the admin "Preview" screen so
// both render the exact same active questions + skip rules, with options
// already parsed from options_json into a plain array (what diary_form.ejs
// expects on q.options).
async function loadQuestionnaire(studyId) {
  const questions = await store.find(
    "questions",
    { study_id: studyId, active: 1 },
    { sort: { order_index: 1, id: 1 } }
  );
  const rules = await store.find("skip_rules", { study_id: studyId }, { sort: { id: 1 } });
  questions.forEach((q) => {
    q.options = q.options_json ? JSON.parse(q.options_json) : [];
  });
  return { questions, rules };
}

module.exports = { loadQuestionnaire };
