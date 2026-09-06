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

const fieldwork=require("../lib/researchOperations");
const router = express.Router();
router.use(requireRole("interviewer", "admin"));

// Code allocation lives in lib/respondentCode.js -- shared with the remote
// self-onboarding flow so both paths allocate the same way.

router.get("/", async (req, res) => {
  const studies = await fieldwork.assignedStudies(req.session.user);
  // JOIN done in JS: every study is fetched (not just the open ones above,
  // since a closed study must still supply its name) and stitched on. The
  // `study_name` alias is kept because the template reads it. It was an inner
  // join, so a respondent whose study row is missing is still dropped.
  const mineRows = await store.find("respondents", { interviewer_id: req.session.user.id }, { sort: { id: -1 } });
  const studyById = new Map((await store.find("studies", {})).map((s) => [s.id, s]));
  const mine = mineRows
    .filter((r) => studyById.has(r.study_id))
    .map((r) => ({ ...r, study_name: studyById.get(r.study_id).name }));
  const recruitmentHolds = await store.find("qc_flags", { respondent_id: { $in: mine.map(r => r.id) }, record_id: null, status: "open", flag_type: { $in: ["duplicate_identity", "consent_missing"] } });
  const heldIds = new Set(recruitmentHolds.map(flag => flag.respondent_id));
  mine.forEach(r => { r.recruitment_hold = heldIds.has(r.id); });
  // Today's counts and the unfinished handovers, which are the two things an
  // interviewer standing in a doorway actually needs. A respondent who was
  // registered but never handed over cannot start, and nothing surfaced that.
  const today = store.nowSql().slice(0, 10);
  const isToday = (t) => String(t || "").slice(0, 10) === today;
  const counts = {
    registered: mine.filter((r) => isToday(r.created_at)).length,
    activated: mine.filter((r) => ["active", "activated"].includes(r.activation_status)).length,
    pending: mine.filter((r) => ["invited", "screened", "registered"].includes(r.activation_status)).length,
  };
  res.render("interviewer/dashboard", { studies, mine, counts,visits:await store.find("fieldwork_visits",{user_id:req.session.user.id,study_id:{$in:studies.map(s=>s.id)}},{sort:{visit_date:1}}) });
});

router.post('/visits/:id',async(req,res)=>{try{await fieldwork.visitOutcome(req.session.user,req.params.id,req.body.status,req.body.notes);res.redirect('/interviewer');}catch(e){res.status(400).render('error',{message:e.message});}});
router.get("/register", async (req, res) => {
  const studies = await fieldwork.assignedStudies(req.session.user);
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
  const studies = await fieldwork.assignedStudies(req.session.user);
  const study = studies.find(s => s.id === studyId);
  const consent = study ? await store.findOne("consent_versions", { study_id: study.id, status: "approved" }, { sort: { version: -1 } }) : null;
  const fail = message => res.status(400).render("interviewer/register", { studies, study, consent, values: req.body, error: message });
  if (!study) return fail("Choose an available study before registering a respondent.");
  const screened=fieldwork.screen(study,req.body.screener||{});
  if(!screened.ok)return fail(screened.error);
  if (!consent) return fail("This study needs approved consent wording before registration can begin.");
  if(consent_given&&Number(req.body.consent_version)!==consent.version)return fail("Review the latest study consent wording before continuing.");
  if (!String(name || '').trim() || !String(contact || '').trim()) return fail("Enter the respondent’s full name and contact details.");
  const token = uuidv4();
  const code = await nextRespondentCode(studyId);
  // Face-to-face registration is the route most likely to receive a number
  // typed as "08012345678" -- an interviewer entering it the way the
  // respondent said it aloud. Canonicalised here against the study's market so
  // it is stored in the one shape Twilio accepts and sign-in searches for.
  const canonicalisedContact = canonicalContact(contact, { market: study && study.market });
  const { id } = await store.insert("respondents", {
    study_id: studyId,
    respondent_code: code,
    name: String(name).trim(),
    contact: canonicalisedContact,
    recruitment_mode: "f2f",
    preferred_channel: preferred_channel || "app",
    consent_status: consent_given ? "given" : "declined",
    activation_status: "training",
    screener_answers:req.body.screener||{},screened_at:store.nowSql(),
    consent_version:consent.version,consent_at:consent_given?store.nowSql():null,consent_recorded_by:req.session.user.id,media_consent:req.body.media_consent==='1',
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
    contact: canonicalisedContact,
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

  return res.redirect(`/interviewer/respondents/${id}`);
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
  if (!["admin", "superadmin"].includes(req.session.user.role) && respondent.interviewer_id !== req.session.user.id) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  respondent.recruitmentHolds = await store.find("qc_flags", {
    respondent_id: respondent.id, record_id: null, status: "open",
    flag_type: { $in: ["duplicate_identity", "consent_missing"] },
  });
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

router.post('/respondents/:id/training',async(req,res)=>{
  const r=await loadOwnRespondent(req,res);if(!r)return;
  if(!req.body.training_complete)return res.redirect(`/interviewer/respondents/${r.id}?sendError=Complete%20the%20training%20checklist.`);
  await fieldwork.audit(req.session.user.email,'training',r.study_id,{respondent_id:r.id});
  await store.update('respondents',{id:r.id},{training_completed_at:store.nowSql(),training_completed_by:req.session.user.id});
  res.redirect(`/interviewer/respondents/${r.id}`);
});
router.post('/respondents/:id/handover',async(req,res)=>{
  const r=await loadOwnRespondent(req,res);if(!r)return;
  try{await fieldwork.handover(r,req.session.user.email);res.redirect(`/interviewer/respondents/${r.id}?sent=Handover%20completed.`);}
  catch(e){res.redirect(`/interviewer/respondents/${r.id}?sendError=${encodeURIComponent(e.message)}`);}
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
