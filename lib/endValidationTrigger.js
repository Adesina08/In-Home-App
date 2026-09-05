// Auto-triggers the end-of-diary close-out (see lib/closeOutQuestionnaire.js)
// for respondents whose study has passed its end_date.
//
// Deliberately conservative about who it touches: only respondents who are
// actively participating (active/activated) and have not already been sent
// or completed one. A disqualified, held or already-closed-out respondent is
// left alone -- this is meant to catch the ordinary "the study just ended"
// case, not to reach into every corner of respondent state.

const store = require("./store");

async function triggerDueEndValidations() {
  const today = store.nowSql().slice(0, 10);
  // end_date is a date string; comparing as strings works because both sides
  // are YYYY-MM-DD, the same trick store.nowSql() timestamps rely on.
  const endedStudies = (await store.find("studies", {})).filter(
    (s) => s.end_date && String(s.end_date).slice(0, 10) <= today
  );
  if (!endedStudies.length) return { triggered: 0 };

  let triggered = 0;
  for (const study of endedStudies) {
    const due = await store.find("respondents", {
      study_id: study.id,
      activation_status: { $in: ["active", "activated"] },
      end_validation_status: null,
    });
    for (const r of due) {
      await store.update("respondents", { id: r.id }, { end_validation_status: "pending" });
      triggered++;
    }
  }
  return { triggered };
}

module.exports = { triggerDueEndValidations };
