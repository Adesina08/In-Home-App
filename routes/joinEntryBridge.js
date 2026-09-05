// Public study join codes must enter the same respondent onboarding state
// machine as individual invitation links. A join code identifies the study,
// not a person, so on first open we allocate one respondent shell for this
// browser session and immediately hand it to /invite/:token/presurvey.
//
// This deliberately replaces the legacy /join welcome -> consent -> OTP ->
// tutorial -> browser diary entry point. The respondent-facing product now has
// one onboarding journey:
//   join code / invite QR -> presurvey -> participation method -> account -> app handoff
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const store = require("../lib/store");
const { findStudyByJoinCode, remoteOnboardingOpen } = require("../lib/joinCode");
const { nextRespondentCode } = require("../lib/respondentCode");
const { logAudit } = require("../lib/audit");

const router = express.Router();

function bootstrapSlot(req, studyId) {
  req.session.joinBootstrap = req.session.joinBootstrap || {};
  req.session.joinBootstrap[studyId] = req.session.joinBootstrap[studyId] || {};
  return req.session.joinBootstrap[studyId];
}

router.get("/:code", async (req, res, next) => {
  const study = await findStudyByJoinCode(req.params.code);
  if (!study) return next();

  if (!remoteOnboardingOpen(study)) {
    return res.status(403).render("join/unavailable", {
      reason:
        study.status === "closed"
          ? "This study has now closed and is no longer accepting new participants."
          : "This study isn't accepting sign-ups through this link at the moment.",
      user: null,
    });
  }

  const slot = bootstrapSlot(req, study.id);
  let respondent = null;

  // Refreshing or rescanning the same public join code in the same browser
  // continues the same onboarding record instead of creating duplicates.
  if (slot.respondentId) {
    respondent = await store.findOne("respondents", {
      id: slot.respondentId,
      study_id: study.id,
    });
  }

  if (!respondent) {
    const uniqueToken = uuidv4();
    const { id } = await store.insert("respondents", {
      study_id: study.id,
      respondent_code: await nextRespondentCode(study.id),
      name: null,
      contact: null,
      recruitment_mode: "remote",
      unique_token: uniqueToken,
      is_practice: 0,
      source_join_code: String(req.params.code || "").trim().toUpperCase(),
    });
    respondent = await store.findOne("respondents", { id });
    slot.respondentId = id;
    slot.uniqueToken = uniqueToken;

    logAudit("public-join", "join_code_onboarding_started", "respondents", id, {
      study_id: study.id,
      join_code: String(req.params.code || "").trim().toUpperCase(),
    });
  }

  return res.redirect(`/invite/${encodeURIComponent(respondent.unique_token)}/presurvey`);
});

module.exports = router;
