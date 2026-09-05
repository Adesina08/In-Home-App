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

/**
 * Which questions a respondent is actually being shown, given their answers.
 *
 * Mirrors evaluateSkipLogic() in views/respondent/diary_form.ejs, deliberately
 * step for step -- the two must agree or the server will reject an entry for
 * missing an answer to a question the respondent was never shown, which is
 * indistinguishable from the app being broken.
 *
 * This became load-bearing the moment required answers were enforced on the
 * server. Before that, show/hide really was cosmetic: an unanswered hidden
 * question simply had no row in `responses` and nobody minded.
 *
 * `answers` is keyed by question id, values as stored ("|"-joined for multi).
 */
function visibleQuestionIds(questions, rules, answers) {
  const answerFor = (qid) => (answers[qid] === undefined ? "" : String(answers[qid]));

  // A question targeted by a "show" rule starts hidden -- that's what makes it
  // a show rule rather than a hide one.
  const defaultHiddenQ = new Set(
    rules.filter((r) => r.action === "show" && r.target_question_id).map((r) => r.target_question_id)
  );
  const defaultHiddenSections = new Set(
    rules.filter((r) => r.action === "show" && r.target_section).map((r) => r.target_section)
  );

  const visible = new Map();
  questions.forEach((q) => {
    const hidden = defaultHiddenQ.has(q.id) || (q.section && defaultHiddenSections.has(q.section));
    visible.set(q.id, !hidden);
  });

  rules.forEach((rule) => {
    if (rule.action === "terminate") return;
    const matches = matchesCondition(answerFor(rule.condition_question_id), rule);
    if (rule.target_section) {
      // A section rule wins over any per-question state set earlier, matching
      // the client's setSectionVisible().
      const show = rule.action === "show" ? matches : !matches;
      questions.forEach((q) => {
        if (q.section === rule.target_section) visible.set(q.id, show);
      });
      return;
    }
    if (!visible.has(rule.target_question_id)) return;
    if (rule.action === "show") visible.set(rule.target_question_id, matches);
    if (rule.action === "hide") visible.set(rule.target_question_id, !matches);
  });

  return new Set([...visible.entries()].filter(([, v]) => v).map(([id]) => id));
}

module.exports = { matchesCondition, findTerminateMatch, visibleQuestionIds };
