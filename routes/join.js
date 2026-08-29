// Remote / digital self-onboarding -- spec Core Flow B.
//
//   1 Invite   unique link / study code   GET  /join/:code
//   2 Consent  consent + minimum profile  GET/POST /join/:code/consent, /profile
//   3 Verify   phone/email OTP            GET/POST /join/:code/verify
//   4 Train    tutorial + practice entry  GET  /join/:code/tutorial
//   5 Activate diary opens                POST /join/:code/finish
//
// This is the only publicly reachable way to create a respondent, so a few
// things are deliberate:
//
//  * No login, but every step is gated on session state -- you cannot jump to
//    /verify or /tutorial by typing the URL without having completed what
//    comes before, and the diary link is only handed over at the very end.
//  * The respondent row isn't written until consent AND profile are captured,
//    so abandoned sign-ups don't litter the sample with empty records.
//  * The same recruitment identity QC checks the F2F flow uses (lib/qc.js)
//    run here too -- a duplicate contact is held for review rather than
//    silently admitted, which matters more here than in F2F since nobody is
//    watching the person sign up.
//  * Consent is recorded against the approved consent version that was on
//    screen, and the study must actually be open to remote recruitment.
const express = require("express");
const { v4: uuidv4 } = require("uuid");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");
const { findStudyByJoinCode, remoteOnboardingOpen } = require("../lib/joinCode");
const { applyRecruitmentHolds } = require("../lib/qc");
const otp = require("../lib/otp");
const { isBypassed: respondentOtpBypassed } = require("../lib/respondentOtpMode");
const { respondentDiaryUrl } = require("../lib/urls");
const { nextRespondentCode } = require("../lib/respondentCode");
const accounts = require("../lib/respondentAccounts");

const router = express.Router();

async function approvedConsent(studyId) {
  return store.findOne(
    "consent_versions",
    { study_id: studyId, status: "approved" },
    { sort: { version: -1 } }
  );
}

function slot(req, studyId) {
  req.session.join = req.session.join || {};
  req.session.join[studyId] = req.session.join[studyId] || {};
  return req.session.join[studyId];
}

router.use("/:code", async (req, res, next) => {
  const study = await findStudyByJoinCode(req.params.code);
  if (!study) {
    return res.status(404).render("join/unavailable", {
      reason: "That link isn't recognised. Please check it with whoever invited you.",
      user: null,
    });
  }
  if (!remoteOnboardingOpen(study)) {
    return res.status(403).render("join/unavailable", {
      reason:
        study.status === "closed"
          ? "This study has now closed and is no longer accepting new participants."
          : "This study isn't accepting sign-ups through this link at the moment.",
      user: null,
    });
  }
  req.study = study;
  next();
});

router.get("/:code", async (req, res) => {
  const consent = await approvedConsent(req.study.id);
  res.render("join/welcome", { study: req.study, code: req.params.code, hasConsent: !!consent, user: null });
});

router.get("/:code/consent", async (req, res) => {
  const consent = await approvedConsent(req.study.id);
  if (!consent) {
    return res.status(503).render("join/unavailable", {
      reason: "This study isn't quite ready for sign-ups yet — its consent wording is still being approved. Please try again later.",
      user: null,
    });
  }
  res.render("join/consent", { study: req.study, code: req.params.code, consent, error: null, user: null });
});

router.post("/:code/consent", async (req, res) => {
  const consent = await approvedConsent(req.study.id);
  if (!consent) return res.redirect(`/join/${req.params.code}/consent`);
  if (!req.body.agree) {
    return res.status(400).render("join/consent", {
      study: req.study,
      code: req.params.code,
      consent,
      error: "You'll need to agree to the consent wording before you can take part.",
      user: null,
    });
  }
  const s = slot(req, req.study.id);
  s.consentGiven = true;
  s.consentVersionId = consent.id;
  res.redirect(`/join/${req.params.code}/profile`);
});

router.get("/:code/profile", (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.consentGiven) return res.redirect(`/join/${req.params.code}/consent`);
  res.render("join/profile", { study: req.study, code: req.params.code, error: null, values: {}, user: null });
});

router.post("/:code/profile", async (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.consentGiven) return res.redirect(`/join/${req.params.code}/consent`);

  const name = (req.body.name || "").trim();
  const contact = (req.body.contact || "").trim();
  const preferredChannel = req.body.preferred_channel === "whatsapp" ? "whatsapp" : "app";
  const values = { name, contact, preferred_channel: preferredChannel };

  const fail = (error) =>
    res.status(400).render("join/profile", { study: req.study, code: req.params.code, error, values, user: null });

  if (!name) return fail("Please enter your name.");
  if (!contact) return fail("Please enter a phone number or email so we can identify your INICIO account.");

  const account = accounts.accountsAllowedFor(req.study)
    ? await accounts.findOrCreate({ contact, name })
    : null;

  let respondentId = s.respondentId;
  if (!respondentId && account) {
    const existing = await accounts.enrolmentFor(account.id, req.study.id);
    if (existing) respondentId = existing.id;
  }

  if (respondentId) {
    const current = await store.findOne("respondents", { id: respondentId });
    await store.update(
      "respondents",
      { id: respondentId },
      {
        name,
        contact,
        preferred_channel: preferredChannel,
        account_id: current && current.account_id != null ? current.account_id : (account ? account.id : null),
      }
    );
  } else {
    const { id } = await store.insert("respondents", {
      study_id: req.study.id,
      respondent_code: await nextRespondentCode(req.study.id),
      name,
      contact,
      recruitment_mode: "remote",
      preferred_channel: preferredChannel,
      consent_status: "given",
      activation_status: "invited",
      unique_token: uuidv4(),
      is_practice: 0,
      account_id: account ? account.id : null,
    });
    respondentId = id;
    logAudit("remote-onboarding", "remote_signup_started", "respondents", respondentId, {
      study_id: req.study.id,
      consent_version_id: s.consentVersionId,
      account_id: account ? account.id : null,
    });
  }
  s.respondentId = respondentId;
  s.accountId = account ? account.id : null;
  s.contact = contact;
  s.simulated = false;

  if (respondentOtpBypassed()) {
    await store.update(
      "respondents",
      { id: respondentId },
      { contact_verified_at: store.nowSql(), activation_status: "screened" }
    );
    if (account) await accounts.markVerified(account.id);
    s.verified = true;
    logAudit("remote-onboarding", "contact_verification_bypassed", "respondents", respondentId, {});
    return res.redirect(`/join/${req.params.code}/tutorial`);
  }

  try {
    const sent = await otp.sendCode({
      contact,
      respondentId,
      studyName: req.study.name,
    });
    s.simulated = !!sent.simulated;
  } catch (e) {
    if (e.code !== "COOLDOWN") return fail(e.message || "We couldn't send a verification code just now. Please try again.");
  }
  res.redirect(`/join/${req.params.code}/verify`);
});

router.get("/:code/verify", (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.respondentId || !s.contact) return res.redirect(`/join/${req.params.code}/profile`);
  if (respondentOtpBypassed() && s.verified) return res.redirect(`/join/${req.params.code}/tutorial`);
  res.render("join/verify", {
    study: req.study,
    code: req.params.code,
    contact: s.contact,
    error: null,
    notice: req.query.resent ? "A new code is on its way." : null,
    simulated: !!s.simulated,
    ttlMinutes: otp.TTL_MINUTES,
    user: null,
  });
});

router.post("/:code/verify", async (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.respondentId || !s.contact) return res.redirect(`/join/${req.params.code}/profile`);

  if (respondentOtpBypassed()) {
    await store.update(
      "respondents",
      { id: s.respondentId },
      { contact_verified_at: store.nowSql(), activation_status: "screened" }
    );
    if (s.accountId) await accounts.markVerified(s.accountId);
    s.verified = true;
    return res.redirect(`/join/${req.params.code}/tutorial`);
  }

  const result = await otp.verifyCode({ contact: s.contact, code: req.body.code });
  if (!result.ok) {
    return res.status(400).render("join/verify", {
      study: req.study,
      code: req.params.code,
      contact: s.contact,
      error: result.reason,
      notice: null,
      simulated: !!s.simulated,
      ttlMinutes: otp.TTL_MINUTES,
      user: null,
    });
  }

  await store.update(
    "respondents",
    { id: s.respondentId },
    { contact_verified_at: store.nowSql(), activation_status: "screened" }
  );
  if (s.accountId) await accounts.markVerified(s.accountId);
  s.verified = true;
  logAudit("remote-onboarding", "contact_verified", "respondents", s.respondentId, {});
  res.redirect(`/join/${req.params.code}/tutorial`);
});

router.post("/:code/verify/resend", async (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.respondentId || !s.contact) return res.redirect(`/join/${req.params.code}/profile`);
  if (respondentOtpBypassed()) return res.redirect(`/join/${req.params.code}/tutorial`);
  try {
    const sent = await otp.sendCode({ contact: s.contact, respondentId: s.respondentId, studyName: req.study.name });
    s.simulated = !!sent.simulated;
  } catch (e) {
    return res.status(e.code === "COOLDOWN" ? 429 : 502).render("join/verify", {
      study: req.study,
      code: req.params.code,
      contact: s.contact,
      error: e.message,
      notice: null,
      simulated: !!s.simulated,
      ttlMinutes: otp.TTL_MINUTES,
      user: null,
    });
  }
  res.redirect(`/join/${req.params.code}/verify?resent=1`);
});

router.get("/:code/tutorial", async (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.verified) return res.redirect(`/join/${req.params.code}/verify`);
  const respondent = await store.findOne("respondents", { id: s.respondentId });
  if (!respondent) return res.redirect(`/join/${req.params.code}/profile`);
  res.render("join/tutorial", { study: req.study, code: req.params.code, respondent, user: null });
});

router.post("/:code/finish", async (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.verified) return res.redirect(`/join/${req.params.code}/verify`);
  const respondent = await store.findOne("respondents", { id: s.respondentId });
  if (!respondent) return res.redirect(`/join/${req.params.code}/profile`);

  await store.update(
    "respondents",
    { id: respondent.id },
    { tutorial_completed_at: store.nowSql(), activation_status: "activated" }
  );

  const holds = await applyRecruitmentHolds(respondent.id, {
    studyId: req.study.id,
    contact: respondent.contact,
    consentGiven: true,
  });

  logAudit("remote-onboarding", "remote_signup_completed", "respondents", respondent.id, {
    held: holds.length > 0,
  });

  if (respondent.account_id) req.session.respondentAccountId = respondent.account_id;
  if (req.session.join) delete req.session.join[req.study.id];

  // Last step of onboarding is choosing how to take part: Mobile App or
  // WhatsApp, with a one-tap decline. That screen is GET /invite/:token, which
  // then continues to account setup and the app handoff.
  //
  // join/done is no longer rendered here. It was the old browser-only ending,
  // and it dead-ended respondents on a diary link instead of the app.
  res.redirect(`/invite/${encodeURIComponent(respondent.unique_token)}`);
});

module.exports = router;
