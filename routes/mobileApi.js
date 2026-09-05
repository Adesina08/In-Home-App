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

function diaryGate(respondent, res) {
  if (respondent.activation_status === "disqualified") {
    res.status(410).json({ error: "This study is complete for you." });
    return false;
  }
  if (respondent.consent_status !== "given") {
    res.status(428).json({ error: "Please review and accept the study consent before starting a diary." });
    return false;
  }
  if (!["activated", "active"].includes(respondent.activation_status)) {
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
  res.json({ ok: true, simulated: !messaging.isRealMessagingConfigured(), ttlMinutes: otp.TTL_MINUTES });
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
  const records = await store.find("diary_records", { respondent_id: respondent.id }, { sort: { entry_time: -1 }, limit: 30 });
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
  const nextStatus = respondent.activation_status === "registered" ? "registered" : "activated";
  await store.update("respondents", { id: respondent.id }, { consent_status: "given", activation_status: nextStatus });
  logAudit(respondent.respondent_code, "mobile_consent", "respondents", respondent.id, {});
  res.json({ ok: true });
});

router.get("/respondents/:id/questionnaire", requireMobileAuth, async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if (!diaryGate(respondent, res)) return;
  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions, rules } = await loadQuestionnaire(study.id);
  res.json({
    study: { id: study.id, name: study.name, version: study.version || 1 },
    respondent: publicRespondent(respondent),
    questions: questions.map((q) => ({ id: q.id, code: q.code, section: q.section || null, orderIndex: q.order_index, type: q.type, text: q.text, required: !!q.required, options: q.options || [], minValue: q.min_value, maxValue: q.max_value })),
    rules: rules.map((r) => ({ id: r.id, targetQuestionId: r.target_question_id, conditionQuestionId: r.condition_question_id, operator: r.operator, value: r.value, action: r.action, terminateScope: r.terminate_scope || null })),
  });
});

router.post("/respondents/:id/diary", requireMobileAuth, upload.any(), async (req, res) => {
  const respondent = await ownedRespondent(req, req.params.id);
  if (!respondent) return res.status(404).json({ error: "Study enrolment not found." });
  if (!diaryGate(respondent, res)) return;

  const study = await store.findOne("studies", { id: respondent.study_id });
  const { questions, rules } = await loadQuestionnaire(study.id);
  let answers = {};
  try { answers = req.body.answers_json ? JSON.parse(req.body.answers_json) : {}; }
  catch (e) { return res.status(400).json({ error: "Your saved answers could not be read." }); }

  const body = {};
  for (const q of questions) {
    const v = answers[String(q.id)] !== undefined ? answers[String(q.id)] : answers[q.id];
    if (v === undefined || v === null || v === "") continue;
    body[`q_${q.id}`] = q.type === "multi" && !Array.isArray(v) ? String(v).split("|").filter(Boolean) : v;
  }

  const action = req.body.action === "draft" ? "draft" : "submit";
  const isSubmit = action === "submit";
  const isPractice = req.body.practice === "1" ? 1 : 0;
  const entryMode = ["standard", "video", "audio"].includes(req.body.entry_mode) ? req.body.entry_mode : "standard";
  const occurrenceTime = req.body.occurrence_time ? String(req.body.occurrence_time).replace("T", " ").replace(/Z$/, "").slice(0, 19) : store.nowSql();
  const periodLabel = req.body.period_label || occurrenceTime.slice(0, 10);

  const skipAnswers = {};
  questions.forEach((q) => {
    const v = body[`q_${q.id}`];
    if (v !== undefined && v !== "") skipAnswers[q.id] = Array.isArray(v) ? v.join("|") : String(v);
  });
  const terminateMatch = isSubmit ? findTerminateMatch(rules, skipAnswers) : null;
  const isTerminated = !!terminateMatch;

  if (isSubmit && !isTerminated) {
    const problems = validateSubmission({ questions, rules, body });
    if (problems.length) return res.status(400).json({ error: "Please check the highlighted questions.", problems });
  }

  const terminateNote = isTerminated ? `Terminated: question ${terminateMatch.condition_question_id} ${terminateMatch.operator} ${terminateMatch.value}` : null;
  const now = store.nowSql();
  const { id: recordId } = await store.insert("diary_records", {
    respondent_id: respondent.id, study_id: study.id, period_label: periodLabel,
    occurrence_time: occurrenceTime, entry_time: now, submit_time: isSubmit ? now : null,
    channel: "app", status: isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft"),
    is_practice: isPractice, entry_mode: entryMode, terminate_note: terminateNote,
  });

  for (const q of questions) {
    if (["photo", "video", "audio"].includes(q.type)) continue;
    const raw = body[`q_${q.id}`];
    if (raw === undefined || raw === null || raw === "") continue;
    await store.insert("responses", { record_id: recordId, question_id: q.id, value: Array.isArray(raw) ? raw.join("|") : String(raw), study_version: study.version || 1 });
  }

  let brandProvider = null;
  let audioProvider = null;
  try { brandProvider = getBrandDetectionProvider(); } catch (e) { console.error("Mobile brand detection unavailable:", e.message); }
  try { audioProvider = getAudioTranscriptionProvider(); } catch (e) { console.error("Mobile audio transcription unavailable:", e.message); }
  const brands = await store.find("brands", { study_id: study.id, active: 1 }, { sort: { id: 1 } });

  for (const f of req.files || []) {
    const storedPath = await persistUpload(f).catch(() => `/uploads/${f.filename}`);
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
  res.status(201).json({ recordId, status: isTerminated ? "screened_out" : (isSubmit ? "submitted" : "draft") });
});

router.use((err, req, res, next) => {
  console.error("Mobile API error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong. Your last completed save is safe." });
});

module.exports = router;
