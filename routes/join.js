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
const db = require("../lib/db");
const { logAudit } = require("../lib/audit");
const { findStudyByJoinCode, remoteOnboardingOpen } = require("../lib/joinCode");
const { applyRecruitmentHolds } = require("../lib/qc");
const otp = require("../lib/otp");
const { respondentDiaryUrl } = require("../lib/urls");
const { nextRespondentCode } = require("../lib/respondentCode");

const router = express.Router();

function approvedConsent(studyId) {
  return db
    .prepare("SELECT * FROM consent_versions WHERE study_id = ? AND status='approved' ORDER BY version DESC LIMIT 1")
    .get(studyId);
}

// Per-study slot in the session, so someone can (harmlessly) have two sign-ups
// in flight in the same browser without them overwriting each other.
function slot(req, studyId) {
  req.session.join = req.session.join || {};
  req.session.join[studyId] = req.session.join[studyId] || {};
  return req.session.join[studyId];
}

// Resolves :code -> study for every route below, and refuses politely if the
// study isn't open to remote recruitment (draft, closed, or F2F-only).
router.use("/:code", (req, res, next) => {
  const study = findStudyByJoinCode(req.params.code);
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

// ---- 1. Invite: what this is, what's involved ----
router.get("/:code", (req, res) => {
  const consent = approvedConsent(req.study.id);
  res.render("join/welcome", { study: req.study, code: req.params.code, hasConsent: !!consent, user: null });
});

// ---- 2. Consent ----
router.get("/:code/consent", (req, res) => {
  const consent = approvedConsent(req.study.id);
  if (!consent) {
    return res.status(503).render("join/unavailable", {
      reason: "This study isn't quite ready for sign-ups yet — its consent wording is still being approved. Please try again later.",
      user: null,
    });
  }
  res.render("join/consent", { study: req.study, code: req.params.code, consent, error: null, user: null });
});

router.post("/:code/consent", (req, res) => {
  const consent = approvedConsent(req.study.id);
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

// ---- 2b. Minimum profile ----
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
  if (!contact) return fail("Please enter a phone number or email so we can verify it's you.");

  // Create the respondent now that we have consent + profile. Still 'invited'
  // until the contact is verified and the tutorial is done.
  let respondentId = s.respondentId;
  if (respondentId) {
    db.prepare("UPDATE respondents SET name = ?, contact = ?, preferred_channel = ? WHERE id = ?")
      .run(name, contact, preferredChannel, respondentId);
  } else {
    const info = db
      .prepare(
        `INSERT INTO respondents (study_id, respondent_code, name, contact, recruitment_mode, preferred_channel,
           consent_status, activation_status, unique_token, is_practice)
         VALUES (?, ?, ?, ?, 'remote', ?, 'given', 'invited', ?, 0)`
      )
      .run(req.study.id, nextRespondentCode(req.study.id), name, contact, preferredChannel, uuidv4());
    respondentId = info.lastInsertRowid;
    s.respondentId = respondentId;
    logAudit("remote-onboarding", "remote_signup_started", "respondents", respondentId, {
      study_id: req.study.id,
      consent_version_id: s.consentVersionId,
    });
  }

  s.contact = contact;
  try {
    await otp.sendCode({
      contact,
      respondentId,
      studyName: req.study.name,
    });
  } catch (e) {
    if (e.code !== "COOLDOWN") return fail(e.message || "We couldn't send a verification code just now. Please try again.");
    // Within the cooldown a live code already exists -- go verify that one.
  }
  res.redirect(`/join/${req.params.code}/verify`);
});

// ---- 3. Verify (OTP) ----
router.get("/:code/verify", (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.respondentId || !s.contact) return res.redirect(`/join/${req.params.code}/profile`);
  res.render("join/verify", {
    study: req.study,
    code: req.params.code,
    contact: s.contact,
    error: null,
    notice: req.query.resent ? "A new code is on its way." : null,
    ttlMinutes: otp.TTL_MINUTES,
    user: null,
  });
});

router.post("/:code/verify", (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.respondentId || !s.contact) return res.redirect(`/join/${req.params.code}/profile`);

  const result = otp.verifyCode({ contact: s.contact, code: req.body.code });
  if (!result.ok) {
    return res.status(400).render("join/verify", {
      study: req.study,
      code: req.params.code,
      contact: s.contact,
      error: result.reason,
      notice: null,
      ttlMinutes: otp.TTL_MINUTES,
      user: null,
    });
  }

  db.prepare("UPDATE respondents SET contact_verified_at = datetime('now'), activation_status = 'screened' WHERE id = ?")
    .run(s.respondentId);
  s.verified = true;
  logAudit("remote-onboarding", "contact_verified", "respondents", s.respondentId, {});
  res.redirect(`/join/${req.params.code}/tutorial`);
});

router.post("/:code/verify/resend", async (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.respondentId || !s.contact) return res.redirect(`/join/${req.params.code}/profile`);
  try {
    await otp.sendCode({ contact: s.contact, respondentId: s.respondentId, studyName: req.study.name });
  } catch (e) {
    return res.status(429).render("join/verify", {
      study: req.study,
      code: req.params.code,
      contact: s.contact,
      error: e.message,
      notice: null,
      ttlMinutes: otp.TTL_MINUTES,
      user: null,
    });
  }
  res.redirect(`/join/${req.params.code}/verify?resent=1`);
});

// ---- 4. Train: tutorial + optional practice entry ----
router.get("/:code/tutorial", (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.verified) return res.redirect(`/join/${req.params.code}/verify`);
  const respondent = db.prepare("SELECT * FROM respondents WHERE id = ?").get(s.respondentId);
  if (!respondent) return res.redirect(`/join/${req.params.code}/profile`);
  res.render("join/tutorial", { study: req.study, code: req.params.code, respondent, user: null });
});

// ---- 5. Activate ----
router.post("/:code/finish", (req, res) => {
  const s = slot(req, req.study.id);
  if (!s.verified) return res.redirect(`/join/${req.params.code}/verify`);
  const respondent = db.prepare("SELECT * FROM respondents WHERE id = ?").get(s.respondentId);
  if (!respondent) return res.redirect(`/join/${req.params.code}/profile`);

  db.prepare(
    "UPDATE respondents SET tutorial_completed_at = datetime('now'), activation_status = 'activated' WHERE id = ?"
  ).run(respondent.id);

  // Same recruitment identity QC as the F2F flow. Runs at the end, once the
  // contact is verified and final -- a hold here flips them back out of
  // 'activated', which the respondent gate in routes/respondent.js honours.
  const holds = applyRecruitmentHolds(respondent.id, {
    studyId: req.study.id,
    contact: respondent.contact,
    consentGiven: true, // they cannot reach this step without consenting
  });

  logAudit("remote-onboarding", "remote_signup_completed", "respondents", respondent.id, {
    held: holds.length > 0,
  });

  // Sign-up is finished -- drop the session state so a shared/public device
  // doesn't leave the next person inside someone else's flow.
  if (req.session.join) delete req.session.join[req.study.id];

  res.render("join/done", {
    study: req.study,
    respondent,
    diaryUrl: respondentDiaryUrl(req, respondent.unique_token),
    held: holds.length > 0,
    user: null,
  });
});

module.exports = router;
