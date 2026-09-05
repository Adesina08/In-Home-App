// Allocates the next respondent code for a study (R07-0013, ...).
//
// This replaces a COUNT(*) + 1 scheme that was duplicated in the F2F route.
// Counting rows only gives a free number while the sequence has no gaps, so
// it broke in two real ways:
//
//   * any deleted respondent makes COUNT lag the highest code in use, so the
//     next registration re-proposes a code that already exists, and
//     respondent_code's UNIQUE constraint turns that into a 500 for the
//     interviewer standing in front of the respondent;
//   * codes that don't follow this study's own prefix (the seeded pilot data
//     numbers study 7's respondents R01-...) aren't counted the way the
//     generator assumes either.
//
// Taking the highest suffix actually in use and then confirming the candidate
// is free -- respondent_code is globally UNIQUE, not per-study -- fixes both,
// and never reuses a retired code, which matters because codes appear in
// exported datasets that may already be in a client's hands.
const store = require("./store");

async function nextRespondentCode(studyId) {
  const prefix = `R${String(studyId).padStart(2, "0")}-`;

  const rows = await store.find("respondents", { study_id: studyId }, { projection: { respondent_code: 1 } });
  let highest = 0;
  rows.forEach((r) => {
    const match = /-(\d+)$/.exec(r.respondent_code || "");
    if (match) highest = Math.max(highest, parseInt(match[1], 10));
  });

  // Codes are globally unique, so the candidate is confirmed free across every
  // study rather than just this one -- the reason this isn't simply highest+1.
  for (let n = highest + 1; n < highest + 1000; n++) {
    const candidate = `${prefix}${String(n).padStart(4, "0")}`;
    if (!(await store.findOne("respondents", { respondent_code: candidate }))) return candidate;
  }
  throw new Error(`Could not allocate a respondent code for study ${studyId}.`);
}

module.exports = { nextRespondentCode };
