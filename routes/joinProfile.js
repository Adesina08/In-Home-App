const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const profiles = require("../lib/respondentProfiles");
const { findStudyByJoinCode } = require("../lib/joinCode");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function slot(req, studyId) {
  return req.session.join && req.session.join[studyId] ? req.session.join[studyId] : null;
}

async function context(req, res) {
  const study = await findStudyByJoinCode(req.params.code);
  if (!study) return null;
  const s = slot(req, study.id);
  if (!s || !s.verified || !s.respondentId) return null;
  const respondent = await store.findOne("respondents", { id: s.respondentId });
  if (!respondent) return null;

  let profile = null;
  if (respondent.account_id) {
    const account = await accounts.getById(respondent.account_id);
    profile = account ? await profiles.linkVerifiedAccount(respondent, account) : await profiles.ensureForRespondent(respondent);
  } else {
    profile = await profiles.ensureForRespondent(respondent);
  }
  return { study, s, respondent, profile };
}

// Intercept the existing tutorial route. The normal join router still owns the
// tutorial page itself; this middleware only inserts the one-time person-level
// profile between OTP verification and study training.
router.get("/:code/tutorial", async (req, res, next) => {
  const ctx = await context(req, res);
  if (!ctx) return next();
  if (!ctx.profile || !ctx.profile.completed_at) return res.redirect(`/join/${req.params.code}/about-you`);
  await profiles.ensureStudySnapshot({ ...ctx.respondent, profile_id: ctx.profile.id });
  next();
});

router.get("/:code/about-you", async (req, res) => {
  const ctx = await context(req, res);
  if (!ctx) return res.redirect(`/join/${req.params.code}`);
  if (ctx.profile && ctx.profile.completed_at) {
    await profiles.ensureStudySnapshot({ ...ctx.respondent, profile_id: ctx.profile.id });
    return res.redirect(`/join/${req.params.code}/tutorial`);
  }

  res.render("join/about_you", {
    study: ctx.study,
    code: req.params.code,
    values: {
      name: ctx.profile && ctx.profile.name ? ctx.profile.name : (ctx.respondent.name || ""),
      location: "",
      age: "",
      gender: "",
      education_level: "",
      occupation: "",
      religion: "",
      marital_status: "",
      recontact_consent: "",
    },
    errors: {},
    user: null,
  });
});

router.post("/:code/about-you", async (req, res) => {
  const ctx = await context(req, res);
  if (!ctx) return res.redirect(`/join/${req.params.code}`);

  const result = await profiles.completeProfile(ctx.profile.id, req.body || {});
  if (!result.ok) {
    return res.status(400).render("join/about_you", {
      study: ctx.study,
      code: req.params.code,
      values: req.body || {},
      errors: result.errors,
      user: null,
    });
  }

  await store.update("respondents", { id: ctx.respondent.id }, {
    profile_id: result.profile.id,
    name: result.profile.name,
    // The "About you" step IS this flow's pre-survey. /invite/:token and
    // /invite/:token/account both gate on presurvey_completed_at, so without
    // this stamp the participation-choice screen bounces them straight back.
    presurvey_completed_at: ctx.respondent.presurvey_completed_at || store.nowSql(),
  });
  await profiles.ensureStudySnapshot({ ...ctx.respondent, profile_id: result.profile.id, name: result.profile.name });
  logAudit(`respondent:${ctx.respondent.id}`, "profile_completed", "respondent_profiles", result.profile.id, {
    channel: "web_onboarding",
    recontact_consent: result.profile.recontact_consent,
  });

  res.redirect(`/join/${req.params.code}/tutorial`);
});

module.exports = router;
