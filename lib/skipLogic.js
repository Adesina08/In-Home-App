// Condition matching shared between the respondent diary form's client-side
// JS (views/respondent/diary_form.ejs, for instant show/hide/terminate
// feedback as someone fills in the form) and this server-side re-evaluation.
//
// Show/hide rules stay purely cosmetic -- a hidden question that never got an
// answer just doesn't get a row in `responses`, so there's nothing for the
// server to enforce. A terminate rule is different: it changes what gets
// stored (the diary entry's status, and possibly the respondent's ability to
// keep participating at all), so it can't rely on a client-side script that a
// respondent's browser could be made to skip or lie about. This module is the
// single source of truth the server uses for that decision; the client copy
// in diary_form.ejs exists only to give the respondent immediate UI feedback
// and is never trusted on its own.

function matchesCondition(val, rule) {
  const ruleValues = String(rule.value || "").split("|");
  switch (rule.operator) {
    case "not_equals":
      return val !== rule.value;
    case "in":
      return ruleValues.includes(val);
    case "not_in":
      return !ruleValues.includes(val);
    case "includes": {
      const valValues = String(val || "").split("|").filter(Boolean);
      return ruleValues.some((rv) => valValues.includes(rv));
    }
    case "equals":
    default:
      return val === rule.value;
  }
}

// answers: { [condition_question_id]: "value" } -- multi-select / "is one of"
// values are "|"-joined, matching the convention used everywhere else in the
// skip logic system (see the diary form's getConditionValue()).
// Returns the first matching terminate rule, or null if none apply.
function findTerminateMatch(rules, answers) {
  for (const rule of rules) {
    if (rule.action !== "terminate") continue;
    const val = answers[rule.condition_question_id];
    if (val === undefined) continue; // that question wasn't answered on this submission
    if (matchesCondition(val, rule)) return rule;
  }
  return null;
}

module.exports = { matchesCondition, findTerminateMatch };
