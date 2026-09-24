// Public Inicio Diary pre-survey, deliberately isolated from the full diary
// questionnaire loader. The invitation page only needs questions explicitly
// tagged as Pre-survey/Screening; unrelated diary questions and skip rules must
// not be able to break first-time onboarding.
const express = require("express");
const store = require("../lib/store");
const { parseOptions, isQuestionActive } = require("../lib/questionnaire");
const { logAudit } = require("../lib/audit");
const { splitPresurvey, sectionNames } = require("../lib/presurveySections");
const { canonical: canonicalContact, isEmail } = require("../lib/contact");
const otp = require("../lib/otp");

const router = express.Router();
router.use((req, res, next) => { res.locals.onboardingJourney = "invite"; next(); });

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

async function consentComplete(respondent, study) {
  if (respondent.consent_status !== "given") return false;
  const consent = await store.findOne("consent_versions", { study_id: study.id, status: "approved" }, { sort: { version: -1 } });
  return !!consent && Number(respondent.consent_version) === Number(consent.version);
}

async function presurveyQuestions(studyId) {
  const rows = await store.find(
    "questions",
    { study_id: studyId },
    { sort: { order_index: 1, id: 1 } }
  );
  const { presurvey } = splitPresurvey(rows.filter(isQuestionActive));

  // Sections present but none matching is almost always a naming mismatch, and
  // is otherwise invisible: the page renders fine, just empty.
  if (!presurvey.length) {
    const names = sectionNames(rows);
    if (names.length) {
      console.warn(
        `Study ${studyId}: no questions matched a pre-survey section. ` +
        `Sections present: ${names.join(", ")}. ` +
        `Name a section e.g. "Screening" for its questions to appear on the invitation.`
      );
    }
  }

  return presurvey.map((q) => ({
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
  if (!await consentComplete(respondent, study)) return res.redirect(`/invite/${respondent.unique_token}/consent`);
  const editingContact = req.query.edit === "1";
  if (respondent.presurvey_completed_at && !editingContact) {
    return res.redirect(`/invite/${respondent.unique_token}/${respondent.contact_verified_at ? "choose" : "verify"}`);
  }
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
    editingContact,
    error: null,
    user: null,
  });
});

router.post("/:token/presurvey", async (req, res) => {
  const loaded = await loadInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  if (!await consentComplete(respondent, study)) return res.redirect(`/invite/${respondent.unique_token}/consent`);
  const editingContact = req.body.edit_contact === "1";
  if (respondent.presurvey_completed_at && respondent.contact_verified_at && !editingContact) {
    return res.redirect(`/invite/${respondent.unique_token}/choose`);
  }
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
          editingContact,
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
    editingContact,
    error,
    user: null,
  });

  if (!name || !contact) {
    return renderFail("Please complete your name and phone number or email before continuing.");
  }
  const storedContact = canonicalContact(contact, { market: study.market });
  if (!(isEmail(storedContact)
    ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(storedContact)
    : /^\+[1-9]\d{6,14}$/.test(storedContact))) {
    return renderFail("Please enter a valid email address or phone number with country code.");
  }
  const missing = questions.find((q) => q.required && isEmptyAnswer(answers[q.id]));
  if (missing) return renderFail(`Please answer “${missing.text}” before continuing.`);

  await store.update("respondents", { id: respondent.id }, {
    name,
    contact: storedContact,
    contact_verified_at: null,
    presurvey_answers: answers,
    presurvey_completed_at: store.nowSql(),
    // Invitations created under the old flow may already have a channel set.
    // Ask them to choose after the pre-survey in the new sequence.
    chosen_mode: null,
    preferred_channel: null,
  });
  logAudit(
    `respondent:${respondent.respondent_code}`,
    "invite_presurvey_completed",
    "respondents",
    respondent.id,
    { configured_question_count: questions.length }
  );

  return res.redirect(`/invite/${respondent.unique_token}/verify`);
});

async function verificationInvite(req, res) {
  const loaded = await loadInvite(req, res);
  if (!loaded) return null;
  const { respondent, study } = loaded;
  if (!await consentComplete(respondent, study)) {
    res.redirect(`/invite/${respondent.unique_token}/consent`);
    return null;
  }
  if (!respondent.presurvey_completed_at || !respondent.contact) {
    res.redirect(`/invite/${respondent.unique_token}/presurvey`);
    return null;
  }
  if (respondent.contact_verified_at) {
    res.redirect(`/invite/${respondent.unique_token}/choose`);
    return null;
  }
  return loaded;
}

function renderVerification(res, respondent, study, { error = null, sent = false, status = 200 } = {}) {
  return res.status(status).render("invite/verify", {
    respondent, study, error, sent, ttlMinutes: otp.TTL_MINUTES, user: null,
  });
}

router.get("/:token/verify", async (req, res) => {
  const loaded = await verificationInvite(req, res);
  if (!loaded) return;
  return renderVerification(res, loaded.respondent, loaded.study, { sent: req.query.sent === "1" });
});

router.post("/:token/verify/send", async (req, res) => {
  const loaded = await verificationInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  try {
    await otp.sendCode({
      contact: respondent.contact, respondentId: respondent.id,
      purpose: "contact_verification", studyName: study.name, requireDelivery: true,
    });
  } catch (error) {
    return renderVerification(res, respondent, study, {
      error: error.message || "The code could not be sent. Please try again.",
      status: error.code === "COOLDOWN" ? 429 : 502,
    });
  }
  return res.redirect(`/invite/${respondent.unique_token}/verify?sent=1`);
});

router.post("/:token/verify", async (req, res) => {
  const loaded = await verificationInvite(req, res);
  if (!loaded) return;
  const { respondent, study } = loaded;
  const result = await otp.verifyCode({
    contact: respondent.contact, code: req.body.code, purpose: "contact_verification",
  });
  if (!result.ok) return renderVerification(res, respondent, study, { error: result.reason, sent: true, status: 400 });
  await store.update("respondents", { id: respondent.id }, { contact_verified_at: store.nowSql() });
  logAudit(`respondent:${respondent.respondent_code}`, "invite_contact_verified", "respondents", respondent.id, {});
  return res.redirect(`/invite/${respondent.unique_token}/choose`);
});

module.exports = router;
