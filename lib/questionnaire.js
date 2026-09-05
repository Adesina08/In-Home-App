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

// Every cadence a study's diary_mode can be. "hybrid" studies keep the full
// occasion-level questionnaire (real-time key occasions plus a period
// summary), so it is intentionally treated the same as realtime/daily here --
// only weekly/monthly narrow the set.
const CADENCES = ["realtime", "daily", "weekly", "monthly", "hybrid"];

function parseCadences(raw) {
  if (Array.isArray(raw)) return raw.filter((c) => CADENCES.includes(c));
  if (raw === undefined || raw === null || raw === "") return [];
  try {
    const parsed = JSON.parse(String(raw));
    return Array.isArray(parsed) ? parsed.filter((c) => CADENCES.includes(c)) : [];
  } catch (e) {
    return [];
  }
}

/** A question with no cadences set applies to every cadence -- see schema.js. */
function questionAppliesToCadence(question, cadence) {
  const scoped = parseCadences(question.applicable_cadences);
  return scoped.length === 0 || scoped.includes(cadence);
}

async function loadQuestionnaire(studyId) {
  const [questions, rules, study] = await Promise.all([
    store.find("questions", { study_id: studyId, active: 1 }, { sort: { order_index: 1, id: 1 } }),
    store.find("skip_rules", { study_id: studyId }, { sort: { id: 1 } }),
    store.findOne("studies", { id: studyId }),
  ]);
  questions.forEach((q) => {
    q.options = parseOptions(q.options_json !== undefined ? q.options_json : q.options);
    q.applicable_cadences = parseCadences(q.applicable_cadences);
  });

  // The cadence filter is applied here, once, so every caller -- the diary
  // form, the mobile API, the video teleprompter, the invitation pre-survey --
  // sees the same narrowed set automatically. A study with no diary_mode set
  // (should not happen, but the store has no schema enforcement) skips the
  // filter rather than showing an empty questionnaire.
  const cadence = study && study.diary_mode;
  const scoped = cadence
    ? questions.filter((q) => questionAppliesToCadence(q, cadence))
    : questions;

  return { questions: scoped, rules, allQuestions: questions, cadence };
}

module.exports = { loadQuestionnaire, parseOptions, parseCadences, questionAppliesToCadence, CADENCES };
