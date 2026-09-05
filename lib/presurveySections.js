// Which questionnaire sections belong to the invitation pre-survey rather than
// to the diary itself.
//
// `section` is free text typed into the Questionnaire Builder, and also
// whatever a client-supplied spreadsheet put in that column on import. Matching
// an exact list of five strings meant a study whose screener sat under
// "Screening Questions" or "SCREENER " silently showed an empty pre-survey page
// -- no error, no flag, just a step with nothing on it.
//
// So: normalise away case, punctuation and spacing, then match whole words.
// Whole words rather than substrings, because "Prescription medicines" is a
// plausible diary section and is not a screener. For the same reason bare
// "screen" is not a keyword -- "Screen time habits" is a real consumption
// section -- while "screening" and "screener" are.
const KEYWORDS = [
  "presurvey", "prescreen", "prescreener", "prescreening",
  "screener", "screening", "eligibility", "eligible",
  "qualification", "qualifier", "qualifying",
];

/** "Pre-Survey / Screening!" -> ["pre","survey","screening"] plus "presurvey" */
function tokens(section) {
  const words = String(section || "").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const joined = [];
  for (let i = 0; i < words.length - 1; i++) joined.push(words[i] + words[i + 1]);
  return [...words, ...joined];
}

function isPresurveySection(section) {
  return tokens(section).some((word) => KEYWORDS.includes(word));
}

/**
 * Split a study's questions into the pre-survey set and the rest, so a caller
 * can tell "no screener configured" from "the screener failed to match" --
 * the distinction that was invisible before.
 */
function splitPresurvey(questions) {
  const presurvey = [];
  const diary = [];
  for (const q of questions || []) {
    (isPresurveySection(q.section) ? presurvey : diary).push(q);
  }
  return { presurvey, diary };
}

/** Distinct section names on a study, for diagnostics. */
function sectionNames(questions) {
  return [...new Set((questions || []).map((q) => q.section).filter(Boolean))];
}

module.exports = { isPresurveySection, splitPresurvey, sectionNames, KEYWORDS };
