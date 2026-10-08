// One-time INICIO person profile for cold invitations.
//
// The /join flow already asks "About you" between OTP and training. Invitations
// used to skip it, so every invited respondent met the profile form for the
// first time inside the mobile app. This router inserts the same step after
// contact verification and before the participation-method choice. The mobile
// profile gate stays as a safety net for older enrolments.
const express = require("express");
const store = require("../lib/store");
const accounts = require("../lib/respondentAccounts");
const profiles = require("../lib/respondentProfiles");
const { logAudit } = require("../lib/audit");

const router = express.Router();
router.use((req, res, next) => { res.locals.onboardingJourney = "invite"; next(); });

async function hasCurrentConsent(respondent, studyId) {
  if (respondent.consent_status !== "given") return false;
  const consent = await store.findOne("consent_versions", { study_id: studyId, status: "approved" }, { sort: { version: -1 } });
  return !!consent && Number(respondent.consent_version) === Number(consent.version);
}

// Only called once the contact is OTP-verified, so reusing the profile of the
// account that owns that contact is safe (see linkVerifiedAccount).
async function profileFor(respondent) {
  if (respondent.account_id) {
    const account = await accounts.getById(respondent.account_id);
    if (account) return profiles.linkVerifiedAccount(respondent, account);
  }
  const account = await accounts.findByContact(respondent.contact);
  const accountProfile = account ? await profiles.getForAccount(account.id) : null;
  if (accountProfile && accountProfile.completed_at) {
    // Returning person: point this enrolment at their existing profile. The
    // account itself is linked when they sign in or create credentials.
    await store.update("respondents", { id: respondent.id }, { profile_id: accountProfile.id });
    return accountProfile;
  }
  return profiles.ensureForRespondent(respondent);
}

// Loads the invitation only when it has reached the profile step: consent
// given, pre-survey done and contact verified. Earlier steps are enforced by
// the downstream routers.
async function eligible(token) {
  const respondent = await store.findOne("respondents", { unique_token: token });
  if (!respondent || respondent.activation_status === "disqualified") return null;
  if (!respondent.presurvey_completed_at || !respondent.contact_verified_at) return null;
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study || !await hasCurrentConsent(respondent, study.id)) return null;
  return { respondent, study };
}

function render(res, { respondent, study, values, errors = {}, status = 200 }) {
  return res.status(status).render("join/about_you", {
    study,
    formAction: `/invite/${respondent.unique_token}/about-you`,
    values,
    errors,
    user: null,
  });
}

// Everything after verification (method choice, account, app handoff) waits
// for the profile.
router.all(["/:token", "/:token/choose", "/:token/account", "/:token/account-app", "/:token/ready"], async (req, res, next) => {
  const loaded = await eligible(req.params.token);
  if (!loaded) return next();
  const profile = await profileFor(loaded.respondent);
  if (!profile || !profile.completed_at) return res.redirect(`/invite/${req.params.token}/about-you`);
  await profiles.ensureStudySnapshot({ ...loaded.respondent, profile_id: profile.id });
  next();
});

router.get("/:token/about-you", async (req, res) => {
  const loaded = await eligible(req.params.token);
  if (!loaded) return res.redirect(`/invite/${req.params.token}`);
  const { respondent, study } = loaded;
  const profile = await profileFor(respondent);
  if (profile && profile.completed_at) return res.redirect(`/invite/${respondent.unique_token}`);

  return render(res, {
    respondent,
    study,
    values: {
      name: (profile && profile.name) || respondent.name || "",
      location: "",
      age: "",
      gender: "",
      education_level: "",
      occupation: "",
      religion: "",
      marital_status: "",
      recontact_consent: "",
    },
  });
});

router.post("/:token/about-you", async (req, res) => {
  const loaded = await eligible(req.params.token);
  if (!loaded) return res.redirect(`/invite/${req.params.token}`);
  const { respondent, study } = loaded;
  const profile = await profileFor(respondent);
  if (profile.completed_at) return res.redirect(`/invite/${respondent.unique_token}`);

  const result = await profiles.completeProfile(profile.id, req.body || {});
  if (!result.ok) {
    return render(res, { respondent, study, values: req.body || {}, errors: result.errors, status: 400 });
  }

  await store.update("respondents", { id: respondent.id }, {
    profile_id: result.profile.id,
    name: result.profile.name,
  });
  await profiles.ensureStudySnapshot({ ...respondent, profile_id: result.profile.id, name: result.profile.name });
  logAudit(`respondent:${respondent.respondent_code}`, "profile_completed", "respondent_profiles", result.profile.id, {
    channel: "invite_onboarding",
    recontact_consent: result.profile.recontact_consent,
  });

  return res.redirect(`/invite/${respondent.unique_token}`);
});

module.exports = router;
