// Public Inicio Diary pre-survey, deliberately isolated from the full diary
// questionnaire loader. The invitation page only needs questions explicitly
// tagged as Pre-survey/Screening; unrelated diary questions and skip rules must
// not be able to break first-time onboarding.
const express = require("express");
const store = require("../lib/store");
const { parseOptions } = require("../lib/questionnaire");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function isPresurveySection(section) {
  return ["presurvey", "pre-survey", "pre survey", "screening", "screener"]
    .includes(String(section || "").trim().toLowerCase());
}

async function loadInvite(req, res) {
  const respondent = await store.findOne("respondents", { unique_token: req.params.token });
  if (!respondent) {
    res.status(404).render("error", {
      message: "This invitation link is not valid. Please check the link in your message.",
      user: null,
    });
    return null;
  }
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) {
    res.status(404).render("error", { message: "This study is no longer available.", user: null });
    return null;
  }
  return { respondent, study };
}

async function presurveyQuestions(studyId) {
  const rows = await store.find(
    "questions",
    { study_id: studyId, active: 1 },
    { sort: { order_index: 1, id: 1 } }
  );
  return rows
    .filter((q) => isPresurveySection(q.section))
    .map((q) => ({
      ...q,
      options: parseOptions(q.options_json !== undefined ? q.options_json : q.options),
    }));
}

function isEmptyAnswer(value) {
  if (Array.isArray(value)) return value.length === 0;
  return value === undefined || value === null || String(value).trim() === "";
}

router.get("/:token/presurvey", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  const questions = await presurveyQuestions(study.id);
  return res.render("invite/presurvey", {
    respondent,
    study,
    questions,
    values: {
      name: respondent.name || "",
      contact: respondent.contact || "",
      answers: respondent.presurvey_answers || {},
    },
    error: null,
    user: null,
  });
});

router.post("/:token/presurvey", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  const questions = await presurveyQuestions(study.id);
  const name = String(req.body.name || "").trim();
  const contact = String(req.body.contact || "").trim();
  const answers = {};

  for (const q of questions) {
    let value = req.body[`pq_${q.id}`];
    if (q.type === "multi" && value !== undefined && !Array.isArray(value)) value = [value];
    if (q.type === "numeric" && !isEmptyAnswer(value)) {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        return res.status(400).render("invite/presurvey", {
          respondent,
          study,
          questions,
          values: { name, contact, answers: { ...answers, [q.id]: value } },
          error: `Please enter a valid number for “${q.text}”.`,
          user: null,
        });
      }
      value = number;
    }
    answers[q.id] = value;
  }

  const renderFail = (error) => res.status(400).render("invite/presurvey", {
    respondent,
    study,
    questions,
    values: { name, contact, answers },
    error,
    user: null,
  });

  if (!name || !contact) {
    return renderFail("Please complete your name and phone number or email before continuing.");
  }
  const missing = questions.find((q) => q.required && isEmptyAnswer(answers[q.id]));
  if (missing) return renderFail(`Please answer “${missing.text}” before continuing.`);

  await store.update("respondents", { id: respondent.id }, {
    name,
    contact,
    presurvey_answers: answers,
    presurvey_completed_at: store.nowSql(),
  });
  logAudit(
    `respondent:${respondent.respondent_code}`,
    "invite_presurvey_completed",
    "respondents",
    respondent.id,
    { configured_question_count: questions.length }
  );

  return res.redirect(`/invite/${respondent.unique_token}`);
});

module.exports = router;
