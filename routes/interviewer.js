const express = require("express");
const { v4: uuidv4 } = require("uuid");
const db = require("../lib/db");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { qrDataUrl, qrPngToResponse } = require("../lib/qrcode");
const { respondentDiaryUrl } = require("../lib/urls");
const { applyRecruitmentHolds } = require("../lib/qc");
const { nextRespondentCode } = require("../lib/respondentCode");
const messaging = require("../lib/whatsapp");

const router = express.Router();
router.use(requireRole("interviewer", "admin"));

// Code allocation lives in lib/respondentCode.js -- shared with the remote
// self-onboarding flow so both paths allocate the same way.

router.get("/", (req, res) => {
  const studies = db.prepare("SELECT * FROM studies WHERE status != 'closed' ORDER BY id").all();
  const mine = db
    .prepare(
      `SELECT respondents.*, studies.name as study_name FROM respondents
       JOIN studies ON studies.id = respondents.study_id
       WHERE respondents.interviewer_id = ? ORDER BY respondents.id DESC`
    )
    .all(req.session.user.id);
  res.render("interviewer/dashboard", { studies, mine });
});

router.get("/register", (req, res) => {
  const studies = db.prepare("SELECT * FROM studies WHERE status != 'closed' ORDER BY id").all();
  const studyId = req.query.study || (studies[0] && studies[0].id);
  const study = studies.find((s) => s.id == studyId);
  const consent = study
    ? db.prepare("SELECT * FROM consent_versions WHERE study_id = ? AND status='approved' ORDER BY version DESC LIMIT 1").get(study.id)
    : null;
  res.render("interviewer/register", { studies, study, consent });
});

// F2F flow: Screen -> Consent -> Register -> Verify -> Activate, captured as one submission for the pilot demo
router.post("/register", async (req, res) => {
  const { study_id, name, contact, eligible, consent_given, preferred_channel, practice } = req.body;
  if (!eligible) {
    return res.render("interviewer/register", {
      studies: db.prepare("SELECT * FROM studies").all(),
      study: db.prepare("SELECT * FROM studies WHERE id=?").get(study_id),
      consent: null,
      error: "Respondent screened as not eligible. Recruitment stopped (screen stage).",
    });
  }
  const token = uuidv4();
  const code = nextRespondentCode(study_id);
  const info = db
    .prepare(
      `INSERT INTO respondents (study_id, respondent_code, name, contact, recruitment_mode, preferred_channel,
        consent_status, activation_status, unique_token, interviewer_id, is_practice)
       VALUES (?, ?, ?, ?, 'f2f', ?, ?, 'activated', ?, ?, ?)`
    )
    .run(
      study_id, code, name, contact, preferred_channel || "app",
      consent_given ? "given" : "declined", token, req.session.user.id, practice ? 1 : 0
    );
  logAudit(req.session.user.email, "f2f_onboard", "respondents", info.lastInsertRowid, { name, code });

  // Recruitment/identity QC (spec 4.1): a duplicate contact in this study, or
  // a registration without consent, holds activation for research review
  // instead of letting the respondent straight into the sample.
  const holds = applyRecruitmentHolds(info.lastInsertRowid, {
    studyId: study_id,
    contact,
    consentGiven: !!consent_given,
  });
  if (holds.length) {
    return res.render("interviewer/held", {
      code,
      name,
      holds,
      respondentId: info.lastInsertRowid,
    });
  }

  const diaryUrl = respondentDiaryUrl(req, token);
  // QR generation is a pure image-render, not a network call -- if it ever
  // did throw, better to still show the activation screen (with a plain
  // link) than lose the fact that the respondent was successfully registered.
  let qr = null;
  try {
    qr = await qrDataUrl(diaryUrl);
  } catch (e) {
    console.error("QR generation failed:", e);
  }
  res.render("interviewer/activated", { code, token, respondentId: info.lastInsertRowid, diaryUrl, qr });
});

// ---- Hand a respondent their link ----
//
// This screen exists because the roster used to link straight to /r/<token>,
// which opened the respondent's diary ON THE INTERVIEWER'S PHONE. That isn't
// just untidy: the diary's first screen registers a device lock (WebAuthn),
// so an interviewer tapping through it would bind their own fingerprint as
// that respondent's lock -- and because the credential is stored against the
// respondent, the respondent's own phone would then be sent to "unlock" with
// no credential it can satisfy. One curious tap in the field could lock a
// respondent out of their own diary for good.
//
// So the interviewer never opens the diary. They hand it over: a QR to scan,
// a link to copy, and a button to text it to the number already on file.
function loadOwnRespondent(req, res) {
  const respondent = db
    .prepare(
      `SELECT respondents.*, studies.name AS study_name FROM respondents
       JOIN studies ON studies.id = respondents.study_id
       WHERE respondents.id = ?`
    )
    .get(req.params.id);
  if (!respondent) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  // An interviewer only ever sees the people they recruited. Admins reach the
  // same screen for support, since they can already see every respondent.
  if (req.session.user.role !== "admin" && respondent.interviewer_id !== req.session.user.id) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  return respondent;
}

router.get("/respondents/:id", (req, res) => {
  const respondent = loadOwnRespondent(req, res);
  if (!respondent) return;
  res.render("interviewer/share", {
    respondent,
    diaryUrl: respondentDiaryUrl(req, respondent.unique_token),
    messagingLive: messaging.isRealMessagingConfigured(),
    sent: req.query.sent || null,
    sendError: req.query.sendError || null,
  });
});

// Generated on demand rather than inlined as a data URI, so the roster page
// stays light no matter how many respondents an interviewer has.
router.get("/respondents/:id/qr.png", async (req, res) => {
  const respondent = loadOwnRespondent(req, res);
  if (!respondent) return;
  await qrPngToResponse(res, respondentDiaryUrl(req, respondent.unique_token));
});

router.post("/respondents/:id/send-link", async (req, res) => {
  const respondent = loadOwnRespondent(req, res);
  if (!respondent) return;
  const back = (key, msg) => res.redirect(`/interviewer/respondents/${respondent.id}?${key}=${encodeURIComponent(msg)}`);

  if (!respondent.contact) {
    return back("sendError", "This respondent has no phone number on file. Show them the QR code instead.");
  }

  const result = await messaging.getProvider().send({
    respondentId: respondent.id,
    to: respondent.contact,
    template: "diary_link_invite",
    variables: {
      name: respondent.name,
      study: respondent.study_name,
      link: respondentDiaryUrl(req, respondent.unique_token),
    },
  });

  logAudit(req.session.user.email, "send_diary_link", "respondents", respondent.id, {
    to: respondent.contact,
    ok: !!result.ok,
  });

  if (!result.ok) return back("sendError", result.error || "The message could not be sent.");
  // A simulated send is reported as simulated. Telling an interviewer standing
  // in someone's front room that a text was sent, when messaging is still in
  // mock mode, is how a respondent gets left waiting for a link that never
  // arrives.
  if (result.simulated) {
    return back(
      "sendError",
      `Messaging isn't connected yet, so nothing was actually sent to ${respondent.contact} — the message was only logged. Show them the QR code instead.`
    );
  }
  back("sent", `Diary link sent to ${respondent.contact}.`);
});

module.exports = router;
