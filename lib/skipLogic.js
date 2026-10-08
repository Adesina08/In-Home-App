// Server side of questionnaire logic: show/hide, skip-to, scoring, variables
// and terminate rules.
//
// Show/hide and skip-to decide which questions were on screen, and the server
// only demands answers to those (lib/answerValidation.js). A terminate rule
// changes what gets stored (the entry's status, and possibly the respondent's
// ability to keep participating at all), so it can't rely on a client-side
// script that a respondent's browser could be made to skip or lie about.
//
// The engine itself lives in public/js/skip-logic.js so the browser and the
// mobile app run the exact same code; this module adapts it to the server's
// answer maps.
const core = require("../public/js/skip-logic.js");

// answers: { [question_id]: "value" } -- multi-select / "is one of" values are
// "|"-joined, as stored.
function lookup(answers) {
  return (qid) => answers[qid];
}

// The first matching terminate rule, or null. A condition on a question that
// wasn't answered on this submission never matches. Pass the questionnaire's
// questions so a rule can read the score or a variable.
function findTerminateMatch(rules, answers, questions) {
  return core.findTerminateMatch(rules, lookup(answers), questions);
}

/**
 * Which questions a respondent is actually being shown, given their answers.
 *
 * The browser evaluates the same engine as they answer -- the two must agree
 * or the server will reject an entry for missing an answer to a question the
 * respondent was never shown, which is indistinguishable from the app being
 * broken. questions must be in questionnaire order (skip-to depends on it).
 */
function visibleQuestionIds(questions, rules, answers) {
  return core.evaluate(questions, rules, lookup(answers)).visibleIds;
}

/** The entry's total score and variables, stored on diary_records. */
function derivedValues(questions, rules, answers) {
  const state = core.evaluate(questions, rules, lookup(answers));
  return {
    score: questions.some((q) => Object.keys(core.optionScores(q)).length) ? state.score : null,
    variables_json: Object.keys(state.variables).length ? JSON.stringify(state.variables) : null,
  };
}

/** Every question id a rule depends on: its conditions, source and jump target. */
function ruleQuestionIds(rule) {
  const ids = core.ruleConditions(rule).filter((c) => c.question_id != null).map((c) => c.question_id);
  if (rule.source_question_id != null) ids.push(Number(rule.source_question_id));
  if (rule.action === "skip_to" && rule.target_question_id != null) ids.push(Number(rule.target_question_id));
  return ids;
}

module.exports = {
  matchesCondition: core.matchesCondition,
  ruleConditions: core.ruleConditions,
  ruleQuestionIds,
  findTerminateMatch,
  visibleQuestionIds,
  derivedValues,
};
