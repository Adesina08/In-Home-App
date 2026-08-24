const db = require("./db");

// Shared by the respondent-facing diary form and the admin "Preview" screen so
// both render the exact same active questions + skip rules, with options
// already parsed from options_json into a plain array (what diary_form.ejs
// expects on q.options).
function loadQuestionnaire(studyId) {
  const questions = db.prepare("SELECT * FROM questions WHERE study_id = ? AND active = 1 ORDER BY order_index").all(studyId);
  const rules = db.prepare("SELECT * FROM skip_rules WHERE study_id = ?").all(studyId);
  questions.forEach((q) => {
    q.options = q.options_json ? JSON.parse(q.options_json) : [];
  });
  return { questions, rules };
}

module.exports = { loadQuestionnaire };
