const express = require("express");
const { v4: uuidv4 } = require("uuid");
const store = require("../lib/store");
const { canonical: canonicalContact } = require("../lib/contact");
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

router.get("/", async (req, res) => {
  const studies = await store.find("studies", { status: { $ne: "closed" } }, { sort: { id: 1 } });
  // JOIN done in JS: every study is fetched (not just the open ones above,
  // since a closed study must still supply its name) and stitched on. The
  // `study_name` alias is kept because the template reads it. It was an inner
  // join, so a respondent whose study row is missing is still dropped.
  const mineRows = await store.find("respondents", { interviewer_id: req.session.user.id }, { sort: { id: -1 } });
  const studyById = new Map((await store.find("studies", {})).map((s) => [s.id, s]));
  const mine = mineRows
    .filter((r) => studyById.has(r.study_id))
    .map((r) => ({ ...r, study_name: studyById.get(r.study_id).name }));
  res.render("interviewer/dashboard", { studies, mine });
});

router.get("/register", async (req, res) => {
  const studies = await store.find("studies", { status: { $ne: "closed" } }, { sort: { id: 1 } });
  const studyId = req.query.study || (studies[0] && studies[0].id);
  const study = studies.find((s) => s.id == studyId);
  const consent = study
    ? await store.findOne("consent_versions", { study_id: study.id, status: "approved" }, { sort: { version: -1 } })
    : null;
  res.render("interviewer/register", { studies, study, consent });
});

// F2F flow: Screen -> Consent -> Register -> Verify -> Activate, captured as one submission for the pilot demo
router.post("/register", async (req, res) => {
  const { study_id, name, contact, eligible, consent_given, preferred_channel, practice } = req.body;
  // Form fields arrive as strings. SQLite's INTEGER affinity turned "7" into 7
  // on the way into the query and the row; MongoDB stores and matches it as a
  // string, so the id is made a number once, here.
  const studyId = Number(study_id);
  if (!eligible) {
    return res.render("interviewer/register", {
      studies: await store.find("studies", {}, { sort: { id: 1 } }),
      study: await store.findOne("studies", { id: studyId }),
      consent: null,
      error: "Respondent screened as not eligible. Recruitment stopped (screen stage).",
    });
  }
  const token = uuidv4();
  const code = await nextRespondentCode(studyId);
  // Face-to-face registration is the route most likely to receive a number
  // typed as "08012345678" -- an interviewer entering it the way the
  // respondent said it aloud. Canonicalised here against the study's market so
  // it is stored in the one shape Twilio accepts and sign-in searches for.
  const study = await store.findOne("studies", { id: studyId });
  const canonicalisedContact = canonicalContact(contact, { market: study && study.market });
  const { id } = await store.insert("respondents", {
    study_id: studyId,
    respondent_code: code,
    name,
    contact: canonicalisedContact,
    recruitment_mode: "f2f",
    preferred_channel: preferred_channel || "app",
    consent_status: consent_given ? "given" : "declined",
    activation_status: "activated",
    unique_token: token,
    interviewer_id: req.session.user.id,
    is_practice: practice ? 1 : 0,
  });
  logAudit(req.session.user.email, "f2f_onboard", "respondents", id, { name, code });

  // Recruitment/identity QC (spec 4.1): a duplicate contact in this study, or
  // a registration without consent, holds activation for research review
  // instead of letting the respondent straight into the sample.
  const holds = await applyRecruitmentHolds(id, {
    studyId,
    contact,
    consentGiven: !!consent_given,
  });
  if (holds.length) {
    return res.render("interviewer/held", {
      code,
      name,
      holds,
      respondentId: id,
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
  res.render("interviewer/activated", { code, token, respondentId: id, diaryUrl, qr });
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
async function loadOwnRespondent(req, res) {
  // Route params are strings; the id column is an integer, so it is coerced
  // here the way SQLite's affinity used to.
  const respondent = await store.findOne("respondents", { id: Number(req.params.id) });
  // JOIN done in JS for `study_name`. It was an inner join, so a respondent
  // with no matching study row counts as "not found", exactly as before.
  const study = respondent ? await store.findOne("studies", { id: respondent.study_id }) : null;
  if (!respondent || !study) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  respondent.study_name = study.name;
  // An interviewer only ever sees the people they recruited. Admins reach the
  // same screen for support, since they can already see every respondent.
  if (req.session.user.role !== "admin" && respondent.interviewer_id !== req.session.user.id) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  return respondent;
}

router.get("/respondents/:id", async (req, res) => {
  const respondent = await loadOwnRespondent(req, res);
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
  const respondent = await loadOwnRespondent(req, res);
  if (!respondent) return;
  await qrPngToResponse(res, respondentDiaryUrl(req, respondent.unique_token));
});

router.post("/respondents/:id/send-link", async (req, res) => {
  const respondent = await loadOwnRespondent(req, res);
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

// Interviewers recruit, so they get the same bulk invite as an admin --
// mounted under their own path so the Back links land where they came from.
router.use("/studies/:id/bulk-invite", require("./bulkInvite"));

// An interviewer has no study-config screens, so the bulk-invite Back link
// needs somewhere sensible of its own to return to.
router.get("/studies/:id/respondents", (req, res) => res.redirect("/interviewer"));

module.exports = router;
