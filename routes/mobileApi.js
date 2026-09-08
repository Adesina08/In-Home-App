const express = require("express");
const multer = require("multer");
const path = require("path");
const store = require("../lib/store");
const otp = require("../lib/otp");
const accounts = require("../lib/respondentAccounts");
const messaging = require("../lib/whatsapp");
const mobileAuth = require("../lib/mobileAuth");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { validateSubmission } = require("../lib/answerValidation");
const { findTerminateMatch } = require("../lib/skipLogic");
const { runQcForRecord, checkCrossChannelDuplicate } = require("../lib/qc");
const { persistUpload } = require("../lib/mediaStorage");
const { getProvider: getBrandDetectionProvider } = require("../lib/brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("../lib/audioTranscription");
const { logAudit } = require("../lib/audit");
const { buildVideoPrompts } = require("../lib/videoPrompts");
const { analyzeSubmittedVideo } = require("../lib/videoEntryAnalysis");

const submission = require("../lib/diarySubmission");
const router = express.Router();
const uploadsRoot = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
const upload = multer({ dest: uploadsRoot, limits: { fileSize: 60 * 1024 * 1024, files: 12 } });

function publicAccount(account) {
  return account ? { id: account.id, name: account.name || null, contact: account.contact } : null;
}

function publicRespondent(r) {
  return {
    id: r.id,
    respondentCode: r.respondent_code,
    name: r.name || null,
    activationStatus: r.activation_status,
    consentStatus: r.consent_status,
    preferredChannel: r.preferred_channel || null,
    studyId: r.study_id,
  };
}

function parseDiaryToken(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  const match = raw.match(/\/r\/([^/?#]+)/i);
  return match ? match[1] : raw;
}

async function requireMobileAuth(req, res, next) {
  const principal = await mobileAuth.authenticateRequest(req);
  if (!principal) return res.status(401).json({ error: "Please sign in again." });
  req.mobilePrincipal = principal;
  next();
}

async function ownedRespondent(req, id) {
  const respondentId = Number(id);
  if (!Number.isInteger(respondentId)) return null;
  const p = req.mobilePrincipal;
  if (p.respondent) return p.respondent.id === respondentId ? p.respondent : null;
  const r = await store.findOne("respondents", { id: respondentId });
  return r && p.account && r.account_id === p.account.id ? r : null;
}

async function diaryGate(respondent, res) {
  const study=await store.findOne("studies",{id:respondent.study_id});
  if(!study||study.status==="closed"){res.status(410).json({error:"The study has closed. Open Participation for final validation."});return false;}
  if (respondent.withdrawn_at || ["pending","completed"].includes(respondent.end_validation_status)) { res.status(410).json({error:"Participation in this study has ended."}); return false; }
  if (respondent.activation_status === "disqualified") {
    res.status(410).json({ error: "This study is complete for you." });
    return false;
  }
  if (respondent.consent_status !== "given") {
    res.status(428).json({ error: "Please review and accept the study consent before starting a diary." });
    return false;
  }
  if (!["activated", "active", "training"].includes(respondent.activation_status)) {
    res.status(423).json({ error: "Your enrolment is waiting for activation." });
    return false;
  }
  return true;
}

async function enrolmentsForPrincipal(principal) {
  if (principal.account) return accounts.enrolmentsFor(principal.account.id);
  const r = principal.respondent;
  if (!r) return [];
  const s = await store.findOne("studies", { id: r.study_id });
  if (!s) return [];
  const submittedCount = await store.count("diary_records", { respondent_id: r.id, status: "submitted", is_practice: 0 });
  return [{ ...r, study_name: s.name, study_status: s.status, diary_mode: s.diary_mode, market: s.market, category: s.category, submitted_count: submittedCount }];
}

router.get("/health", (req, res) => res.json({ ok: true, service: "inicio-mobile-api" }));

router.post("/auth/request-code", async (req, res) => {
  const contact = String(req.body.contact || "").trim();
  if (!contact) return res.status(400).json({ error: "Enter your phone number or email." });
  const account = await accounts.findByContact(contact);
  if (account) {
    try {
      await otp.sendCode({ contact, respondentId: null, purpose: "account_login" });
    } catch (e) {
      if (e.code !== "COOLDOWN") return res.status(502).json({ error: e.message || "We couldn't send a code just now." });
    }
  }
  res.json({ ok: true, simulated: !messaging.isRealMessagingConfigured(contact), ttlMinutes: otp.TTL_MINUTES });
});

router.post("/auth/verify", async (req, res) => {
  const contact = String(req.body.contact || "").trim();
  const code = String(req.body.code || "").trim();
  if (!contact || !code) return res.status(400).json({ error: "Enter the code we sent you." });
  const result = await otp.verifyCode({ contact, code, purpose: "account_login" });
  if (!result.ok) return res.status(400).json({ error: result.reason || "That code isn't right." });
  const account = await accounts.findByContact(contact);
  if (!account) return res.status(400).json({ error: "That code isn't right." });
  await accounts.markVerified(account.id);
  const session = await mobileAuth.issueSession({ accountId: account.id });
  logAudit(`account:${account.contact}`, "mobile_login", "respondent_accounts", account.id, {});
  res.json({ token: session.token, expiresAt: session.expiresAt, account: publicAccount(account) });
});

router.post("/auth/diary-link", async (req, res) => {
  const token = parseDiaryToken(req.body.token || req.body.url);
  if (!token) return res.status(400).json({ error: "Paste your INICIO diary link." });
  const respondent = await store.findOne("respondents", { unique_token: token });
  if (!respondent) return res.status(404).json({ error: "That diary link is not valid." });
  const session = await mobileAuth.issueSession({ respondentId: respondent.id });
  logAudit(respondent.respondent_code, "mobile_link_login", "respondents", respondent.id, {});
  res.json({ token: session.token, expiresAt: session.expiresAt, respondent: publicRespondent(respondent) });
});

router.post("/auth/logout", requireMobileAuth, async (req, res) => {
  await mobileAuth.revokeToken(req.mobilePrincipal.token);
  res.json({ ok: true });
});

router.get("/me", requireMobileAuth, async (req, res) => {
  const enrolments = await enrolmentsForPrincipal(req.mobilePrincipal);
  res.json({
    account: publicAccount(req.mobilePrincipal.account),
    linkOnly: !req.mobilePrincipal.account,
    enrolments: enrolments.map((r) => ({
      respondent: publicRespondent(r),
      study: { id: r.study_id, name: r.study_name, status: r.study_status, diaryMode: r.diary_mode || null, market: r.market || null, category: r.category || null },
      submittedCount: r.submitted_count || 0,
    })),
  });
});

router.get("/respondents/:id/home", requireMobileAuth, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  const study = await store.findOne("studies", { id: respondent.study_id });
  const consent = await store.findOne("consent_versions", { study_id: study.id, status: "approved" }, { sort: { version: -1 } });
  const records = await store.find("diary_records", { respondent_id: respondent.id }, { sort: { entry_time: -1 } });
  res.json({
    respondent: publicRespondent(respondent),
    study: { id: study.id, name: study.name, status: study.status, market: study.market || null, category: study.category || null, diaryMode: study.diary_mode || null, recruitmentMode: study.recruitment_mode || null, inviteBrief: study.invite_brief || null, mandatoryPhoto: !!study.mandatory_photo },
    consent: consent ? { id: consent.id, version: consent.version, body: consent.body } : null,
    records: records.map((r) => ({ id: r.id, periodLabel: r.period_label, occurrenceTime: r.occurrence_time, entryTime: r.entry_time, submitTime: r.submit_time, status: r.status, entryMode: r.entry_mode || "standard", isPractice: !!r.is_practice })),
  });
});

router.post("/respondents/:id/consent", requireMobileAuth, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if(respondent.withdrawn_at||respondent.activation_status==='disqualified')return res.status(410).json({error:"Participation has ended."});
  const consent=await store.findOne("consent_versions",{study_id:respondent.study_id,status:"approved"},{sort:{version:-1}});
  if(!consent||Number(req.body.consent_version)!==consent.version)return res.status(409).json({error:"The consent wording changed. Reopen the study and review the current version."});
  const nextStatus = ["registered","training"].includes(respondent.activation_status) ? respondent.activation_status : "activated";
  await store.update("respondents", { id: respondent.id }, { consent_status: "given", activation_status: nextStatus,consent_version:consent.version,consent_at:store.nowSql(),consent_recorded_by:"respondent" });
  logAudit(respondent.respondent_code, "mobile_consent", "respondents", respondent.id, {});
  res.json({ ok: true });
});

router.get('/respondents/:id/submissions/:key',requireMobileAuth,async(req,res)=>{
 const r=await ownedRespondent(req,req.params.id);if(!r)return res.sendStatus(404);
 const row=await store.findOne('diary_submissions',{id:`${r.id}:${req.params.key}`,state:'done'});
 res.json(row?{recordId:row.record_id,status:row.result_status}:null);
});
router.get('/respondents/:id/participation',requireMobileAuth,async(req,res)=>{
  const r=await ownedRespondent(req,req.params.id);if(!r)return res.sendStatus(404);const study=await store.findOne('studies',{id:r.study_id});
  const due=r.end_validation_status==='pending'||study.status==='closed'||study.end_date&&study.end_date<store.nowSql().slice(0,10);
  res.json({mediaConsent:r.media_consent===true,withdrawn:!!r.withdrawn_at,closeoutDue:!!due,closeoutCompleted:r.end_validation_status==='completed',questions:require('../lib/closeOutQuestionnaire').questionsFor(study),incentives:(await store.find('incentive_ledger',{respondent_id:r.id})).map(i=>({milestone:i.milestone,amount:i.amount,currency:i.currency,status:i.status}))});
});
router.post('/respondents/:id/media-consent',requireMobileAuth,async(req,res)=>{
  const r=await ownedRespondent(req,req.params.id);if(!r)return res.sendStatus(404);if(r.consent_status!=='given'||r.withdrawn_at)return res.sendStatus(403);
  await require('../lib/researchOperations').audit(r.respondent_code,'media_consent',r.study_id,{respondent_id:r.id,given:req.body.given===true});await store.update('respondents',{id:r.id},{media_consent:req.body.given===true,media_consent_at:store.nowSql()});res.json({ok:true});
});
router.post('/respondents/:id/withdraw',requireMobileAuth,async(req,res)=>{
  const r=await ownedRespondent(req,req.params.id);if(!r)return res.sendStatus(404);await require('../lib/researchPrivacy').withdraw(r,r.respondent_code);res.json({ok:true});
});
router.post('/respondents/:id/closeout',requireMobileAuth,async(req,res)=>{
  const r=await ownedRespondent(req,req.params.id);if(!r)return res.sendStatus(404);const study=await store.findOne('studies',{id:r.study_id});
  if(r.consent_status!=='given'||r.withdrawn_at)return res.sendStatus(403);
  if(r.end_validation_status==='completed')return res.json({ok:true});
  if(r.end_validation_status!=='pending'&&study.status!=='closed'&&!(study.end_date&&study.end_date<store.nowSql().slice(0,10)))return res.status(409).json({error:'Final validation is not due yet.'});
  const closeout=require('../lib/closeOutQuestionnaire');const answers={};for(const q of closeout.questionsFor(study))answers[q.code]=String(req.body.answers?.[q.code]||'');
  const errors=closeout.validate(answers,study);if(Object.keys(errors).length)return res.status(400).json({error:'Answer the required final validation questions.',fields:errors});
  await require('../lib/researchOperations').insertOnce('end_validations',`closeout:${r.id}`,{respondent_id:r.id,study_id:study.id,answers,completed_at:store.nowSql()});await store.update('respondents',{id:r.id},{end_validation_status:'completed'});res.json({ok:true});
});

router.get("/respondents/:id/questionnaire", requireMobileAuth, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if (!await diaryGate(respondent, res)) return;
  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions, rules } = await loadQuestionnaire(study.id,{respondentId:respondent.id});
  res.json({
    study: { id: study.id, name: study.name, version: study.version || 1, backEntryHours: study.back_entry_hours ?? 24, diaryMode:study.diary_mode, practiceRequired:respondent.activation_status === "training" },
    respondent: publicRespondent(respondent),
    occasionNumber:(await store.count("diary_records",{respondent_id:respondent.id,status:"submitted",is_practice:0}))+1,
    questions: questions.map((q) => ({ rotateOptions:q.rotate_options,everyNthOccasion:q.every_nth_occasion,fromHourUtc:q.from_hour_utc,toHourUtc:q.to_hour_utc,id: q.id, code: q.code, section: q.section || null, orderIndex: q.order_index, type: q.type, text: q.text, required: !!q.required, options: q.options || [], otherSpecifyOptions:q.otherSpecifyOptions||[], minValue: q.min_value, maxValue: q.max_value })),
    rules: rules.map((r) => ({ id: r.id, targetQuestionId: r.target_question_id, conditionQuestionId: r.condition_question_id, operator: r.operator, value: r.value, action: r.action, terminateScope: r.terminate_scope || null })),
  });
});

// Teleprompter script for Video mode, derived from this study's own
// questionnaire (see lib/videoPrompts.js) -- mirrors the web respondent flow.
router.get("/respondents/:id/diary/video-script", requireMobileAuth, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if (!await diaryGate(respondent, res)) return;
  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions } = await loadQuestionnaire(study.id,{respondentId:respondent.id});
  const script = buildVideoPrompts(questions);
  res.json(script);
});

// Video mode: the respondent's part ends here. The video is saved as evidence
// immediately and AI field-extraction (lib/videoEntryAnalysis.js) runs in the
// background, exactly like the web respondent flow's /diary/analyze-video.
router.post("/respondents/:id/diary/analyze-video", requireMobileAuth, upload.single("video"), submission.cleanupUploads, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if (!await diaryGate(respondent, res)) return;
  if (!req.file) return res.status(400).json({ error: "Please record a video before continuing." });

  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions } = await loadQuestionnaire(study.id,{respondentId:respondent.id});
  const brands = await require("../lib/productCandidates").forStudy(study);
  const isPractice = respondent.activation_status === "training" || req.body.practice === "1" ? 1 : 0;

  const now = store.nowSql();
  const recordId = await submission.begin(req,res,respondent, {
    respondent_id: respondent.id,
    study_id: study.id,
    period_label: now.slice(0, 10),
    ...submission.timestamps(req.body,study),
    entry_time: now,
    channel: "app",
    status: "submitted",
    is_practice: isPractice,
    entry_mode: "video",review_status:"pending_ai",
  });
  if(recordId===null)return;
  const storedPath = await persistUpload(req.file);
  await store.insert("media", { record_id: recordId, media_type: "video", file_path: storedPath });

  analyzeSubmittedVideo({
    recordId,
    videoFile: req.file,
    questions,
    brands,
    studyVersion: study.version,
  }).catch((e) => console.warn(`Background video analysis failed for record ${recordId}: ${e.message}`));

  if (!isPractice) {
    await store.update("respondents", { id: respondent.id, activation_status: { $ne: "active" } }, { activation_status: "active" });
  }

  logAudit(respondent.respondent_code, "mobile_diary_video_submit", "diary_records", recordId, { practice: !!isPractice });
  await submission.finish(req,recordId,"submitted");
  res.status(201).json({ recordId, status: "submitted" });
});

router.post("/respondents/:id/diary", requireMobileAuth, upload.any(), submission.cleanupUploads, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if (!await diaryGate(respondent, res)) return;

  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions, rules } = await loadQuestionnaire(study.id,{respondentId:respondent.id});
  let answers = {};
  try { answers = req.body.answers_json ? JSON.parse(req.body.answers_json) : {}; }
  catch (e) { return res.status(400).json({ error: "Your saved answers could not be read." }); }
  let otherText = {};
  try { otherText = req.body.other_text_json ? JSON.parse(req.body.other_text_json) : {}; }
  catch (e) { return res.status(400).json({ error: "Your other answer text could not be read." }); }

  const body = {occurrence_time:req.body.occurrence_time,occasion_number:req.body.occasion_number};
  for (const q of questions) {
    if(!require("../lib/advancedQuestionnaire").scheduled(q,{occurrenceTime:req.body.occurrence_time,occasionNumber:Number(req.body.occasion_number)||1}))continue;
    const v = answers[String(q.id)] !== undefined ? answers[String(q.id)] : answers[q.id];
    if (v === undefined || v === null || v === "") continue;
    body[`q_${q.id}`] = q.type === "multi" && !Array.isArray(v) ? String(v).split("|").filter(Boolean) : v;
  }

  if(questions.some(q=>q.every_nth_occasion)&&req.body.submission_id&&!await store.findOne('diary_submissions',{id:`${respondent.id}:${req.body.submission_id}`})){
    const expected=(await store.count('diary_records',{respondent_id:respondent.id,status:'submitted',is_practice:0}))+1;
    if(Number(req.body.occasion_number)!==expected)return res.status(409).json({error:'The questionnaire sequence changed on another device. Review this saved entry using the current questionnaire.'});
  }
  const action = req.body.action === "draft" ? "draft" : "submit";
  const isSubmit = action === "submit";
  const isPractice = respondent.activation_status === "training" || req.body.practice === "1" ? 1 : 0;
  const entryMode = ["standard", "video", "audio"].includes(req.body.entry_mode) ? req.body.entry_mode : "standard";
  const times = submission.timestamps(req.body, study);
  const occurrenceTime = times.occurrence_time;
  const periodLabel = req.body.period_label || occurrenceTime.slice(0, 10);

  const skipAnswers = {};
  questions.forEach((q) => {
    const v = body[`q_${q.id}`];
    if (v !== undefined && v !== "") skipAnswers[q.id] = Array.isArray(v) ? v.join("|") : String(v);
  });
  const terminateMatch = isSubmit ? findTerminateMatch(rules, skipAnswers) : null;
  const isTerminated = !!terminateMatch;

  if (isSubmit && !isTerminated) {
    body.other_text_json = otherText;
    const problems = validateSubmission({ questions, rules, body });
    if (problems.length) return res.status(400).json({ error: "Please check the highlighted questions.", problems });
  }

  const terminateNote = isTerminated ? `Terminated: question ${terminateMatch.condition_question_id} ${terminateMatch.operator} ${terminateMatch.value}` : null;
  const now = store.nowSql();
  const recordId = await submission.begin(req,res,respondent, {
    respondent_id: respondent.id, study_id: study.id, period_label: periodLabel,
    ...times, entry_time: now, submit_time: isSubmit ? times.submit_time : null,
    participation_kind:req.body.participation_kind === "period_summary" ? "period_summary" : "occasion",
    channel: "app", status: isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft"),
    is_practice: isPractice, entry_mode: entryMode, terminate_note: terminateNote,
  });

  if(recordId===null)return;
  for (const q of questions) {
    if (["photo", "video", "audio"].includes(q.type)) continue;
    const raw = body[`q_${q.id}`];
    if (raw === undefined || raw === null || raw === "") continue;
    await store.insert("responses", { record_id: recordId, question_id: q.id, value: Array.isArray(raw) ? raw.join("|") : String(raw), other_text_json: otherText[String(q.id)] ? JSON.stringify(otherText[String(q.id)]) : null, study_version: study.version || 1 });
  }

  let brandProvider = null;
  let audioProvider = null;
  try { brandProvider = getBrandDetectionProvider(); } catch (e) { console.error("Mobile brand detection unavailable:", e.message); }
  try { audioProvider = getAudioTranscriptionProvider(); } catch (e) { console.error("Mobile audio transcription unavailable:", e.message); }
  const brands = await require("../lib/productCandidates").forStudy(study);

  for (const f of req.files || []) {
    const storedPath = await persistUpload(f);
    const mime = String(f.mimetype || "");
    const mediaType = mime.startsWith("audio/") ? "audio" : mime.startsWith("video/") ? "video" : "photo";
    const { id: mediaId } = await store.insert("media", { record_id: recordId, media_type: mediaType, file_path: storedPath });
    const mediaRow = { id: mediaId, record_id: recordId, media_type: mediaType, file_path: storedPath };
    if (mediaType === "audio" && audioProvider) audioProvider.transcribe(mediaRow).catch(() => {});
    if (mediaType !== "audio" && brandProvider) brandProvider.detect(mediaRow, brands).catch(() => {});
  }

  if (isSubmit && !isPractice) {
    await store.update("respondents", { id: respondent.id, activation_status: { $ne: "active" } }, { activation_status: "active" });
    if (!isTerminated) {
      await runQcForRecord(recordId);
      await checkCrossChannelDuplicate(respondent.id, periodLabel);
    }
  }

  if (isTerminated && terminateMatch.terminate_scope === "study" && !isPractice) {
    await store.update("respondents", { id: respondent.id }, { activation_status: "disqualified", disqualified_at: store.nowSql(), disqualify_reason: terminateNote });
  }

  logAudit(respondent.respondent_code, isTerminated ? "mobile_diary_terminated" : (isSubmit ? "mobile_diary_submit" : "mobile_diary_draft"), "diary_records", recordId, { practice: !!isPractice });
  await submission.finish(req,recordId,isTerminated?"screened_out":isSubmit?"submitted":"draft");
  res.status(201).json({ recordId, status: isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft") });
});

router.use(async (err, req, res, next) => {
  await submission.release(req,err);
  if(!err.status||err.status>=500)console.error("Mobile API error:", err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.status ? err.message : "Sync could not finish. Your saved entry can be retried." });
});

module.exports = router;
