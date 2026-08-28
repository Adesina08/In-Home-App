const express = require("express");
const store = require("../lib/store");
const mobileAuth = require("../lib/mobileAuth");
const profiles = require("../lib/respondentProfiles");

const router = express.Router({ mergeParams: true });

async function ownedRespondent(principal, respondentId) {
  const id = Number(respondentId);
  if (!Number.isInteger(id)) return null;
  if (principal.respondent) return principal.respondent.id === id ? principal.respondent : null;
  if (!principal.account) return null;
  const respondent = await store.findOne("respondents", { id });
  return respondent && respondent.account_id === principal.account.id ? respondent : null;
}

router.use(async (req, res, next) => {
  // Home + consent remain reachable because the app needs to explain the
  // study before the person completes anything. The diary/questionnaire is
  // where the one-time person profile becomes mandatory.
  if (!(req.path === "/questionnaire" || req.path === "/diary")) return next();

  const principal = await mobileAuth.authenticateRequest(req);
  if (!principal) return res.status(401).json({ error: "Please sign in again." });
  const respondent = await ownedRespondent(principal, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });

  const profile = principal.account
    ? await profiles.ensureForAccount(principal.account)
    : await profiles.ensureForRespondent(respondent);
  if (!profile || !profile.completed_at) {
    return res.status(428).json({
      error: "Complete your one-time INICIO profile before starting the diary.",
      profileRequired: true,
    });
  }

  await store.update("respondents", { id: respondent.id }, { profile_id: profile.id });
  await profiles.ensureStudySnapshot({ ...respondent, profile_id: profile.id });
  next();
});

module.exports = router;
