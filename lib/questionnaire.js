const store = require("./store");
const versions = require("./questionnaireVersions");

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

// Legacy questionnaire rows migrated from SQLite can have active missing or
// stored as a boolean. SQLite's old default was active=1, so only an explicit
// false/0 means removed. Keeping this rule in one helper prevents the builder
// saying "10 questions" while Preview finds zero because Mongo matches types
// exactly.
function isQuestionActive(question) {
  if (!question) return false;
  return ![0, false, "0"].includes(question.active);
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

function prepareQuestions(rawQuestions, cadence) {
  const questions = (rawQuestions || []).filter(isQuestionActive).map((raw) => ({ ...raw }));
  questions.forEach((q) => {
    q.options = parseOptions(q.options_json !== undefined ? q.options_json : q.options);
    q.otherSpecifyOptions = parseOptions(q.other_specify_options_json);
    q.applicable_cadences = parseCadences(q.applicable_cadences);
  });
  return cadence
    ? questions.filter((q) => questionAppliesToCadence(q, cadence))
    : questions;
}

/**
 * Load the questionnaire a respondent should see, or the builder's current
 * draft when options.draft=true.
 *
 * Respondent paths read the immutable snapshot matching studies.version. A
 * study that has never been delivered before is snapshotted on first use, so
 * v1 becomes fixed the first time a respondent can actually see it. Admin
 * Preview deliberately bypasses that snapshot and renders the working draft.
 */
async function loadQuestionnaire(studyId, context = {}, options = {}) {
  const study = await store.findOne("studies", { id: studyId });
  if (!study) return { questions: [], rules: [], allQuestions: [], cadence: null, version: null, source: "missing" };

  let payload;
  let source;
  let version = Number(study.version) || 1;

  if (options.draft) {
    payload = await versions.draftPayload(studyId);
    source = "draft";
  } else {
    let snapshot = await versions.getSnapshot(studyId, version);
    if (!snapshot) {
      snapshot = await versions.ensureSnapshot(studyId, version, {
        actor: "system",
        source: "first_delivery",
      });
    }
    if (snapshot) {
      payload = {
        questions: snapshot.questions || [],
        rules: snapshot.rules || [],
        study_config: snapshot.study_config || {},
      };
      source = "published";
    } else {
      // Last-resort compatibility fallback: do not take respondent onboarding
      // down if a snapshot cannot be created. This path is noisy by design.
      console.error(`Questionnaire snapshot missing for study ${studyId} v${version}; using working draft.`);
      payload = await versions.draftPayload(studyId);
      source = "draft_fallback";
    }
  }

  payload = payload || { questions: [], rules: [], study_config: {} };
  const cadence = options.draft
    ? study.diary_mode
    : (payload.study_config && payload.study_config.diary_mode) || study.diary_mode;
  const allQuestions = prepareQuestions(payload.questions || [], null);
  const scoped = cadence
    ? allQuestions.filter((q) => questionAppliesToCadence(q, cadence))
    : allQuestions;

  return {
    questions: require("./advancedQuestionnaire").contextualize(scoped, context),
    rules: (payload.rules || []).map((rule) => ({ ...rule })),
    allQuestions,
    cadence,
    version,
    source,
  };
}

module.exports = {
  loadQuestionnaire,
  parseOptions,
  parseCadences,
  isQuestionActive,
  questionAppliesToCadence,
  CADENCES,
};
