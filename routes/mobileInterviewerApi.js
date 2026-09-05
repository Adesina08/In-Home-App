// Mobile (bearer-token) API for the Interviewer persona in the Expo app.
//
// routes/interviewer.js is the original, session-cookie, server-rendered
// flow for the same job (a field interviewer registering respondents
// face-to-face, or inviting a batch of people at once). This file is a
// parallel JSON surface over the exact same lib/ business logic
// (lib/enrolment, lib/bulkInvite, lib/qc, lib/respondentCode, lib/qrcode) so
// the native app gets identical behaviour without depending on a browser
// session or server-rendered HTML.
const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const { v4: uuidv4 } = require("uuid");
const store = require("../lib/store");
const mobileAuth = require("../lib/mobileAuth");
const { canonical: canonicalContact } = require("../lib/contact");
const { logAudit } = require("../lib/audit");
const { qrDataUrl } = require("../lib/qrcode");
const { respondentDiaryUrl } = require("../lib/urls");
const { applyRecruitmentHolds } = require("../lib/qc");
const { nextRespondentCode } = require("../lib/respondentCode");
const bulk = require("../lib/bulkInvite");
const { enrol, existingContactsFor } = require("../lib/enrolment");
const messaging = require("../lib/whatsapp");

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024 } });

function publicUser(user) {
  return { id: user.id, name: user.name, email: user.email, role: user.role };
}

router.post("/auth/login", async (req, res) => {
  const email = String(req.body.email || "").trim().toLowerCase();
  const password = String(req.body.password || "");
  if (!email || !password) return res.status(400).json({ error: "Enter your email and password." });

  const user = await store.findOne("users", { email });
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: "That email or password is not correct." });
  }
  if (!["interviewer", "admin", "superadmin"].includes(user.role)) {
    return res.status(403).json({ error: "This account does not have field interviewer access." });
  }
  if (user.must_change_password) {
    return res.status(403).json({ error: "Your password must be changed on the web app before using the mobile app." });
  }

  const session = await mobileAuth.issueSession({ userId: user.id });
  logAudit(user.email, "mobile_interviewer_login", "users", user.id, {});
  res.json({ token: session.token, expiresAt: session.expiresAt, user: publicUser(user) });
});

async function requireInterviewer(req, res, next) {
  const principal = await mobileAuth.authenticateRequest(req);
  if (!principal || !principal.user) return res.status(401).json({ error: "Please sign in again." });
  if (!["interviewer", "admin", "superadmin"].includes(principal.user.role)) {
    return res.status(403).json({ error: "This account does not have field interviewer access." });
  }
  req.interviewer = principal.user;
  next();
}

router.post("/auth/logout", requireInterviewer, async (req, res) => {
  const principal = await mobileAuth.authenticateRequest(req);
  await mobileAuth.revokeToken(principal.token);
  res.json({ ok: true });
});

router.get("/dashboard", requireInterviewer, async (req, res) => {
  const studies = await store.find("studies", { status: { $ne: "closed" } }, { sort: { id: 1 } });
  const mineRows = await store.find("respondents", { interviewer_id: req.interviewer.id }, { sort: { id: -1 } });
  const studyById = new Map((await store.find("studies", {})).map((s) => [s.id, s]));
  const mine = mineRows
    .filter((r) => studyById.has(r.study_id))
    .map((r) => ({
      id: r.id,
      respondentCode: r.respondent_code,
      name: r.name,
      contact: r.contact,
      activationStatus: r.activation_status,
      consentStatus: r.consent_status,
      createdAt: r.created_at,
      uniqueToken: r.unique_token,
      studyId: r.study_id,
      studyName: studyById.get(r.study_id).name,
    }));

  const today = store.nowSql().slice(0, 10);
  const isToday = (t) => String(t || "").slice(0, 10) === today;
  const counts = {
    registered: mine.filter((r) => isToday(r.createdAt)).length,
    activated: mine.filter((r) => ["active", "activated"].includes(r.activationStatus)).length,
    pending: mine.filter((r) => !["active", "activated", "disqualified"].includes(r.activationStatus)).length,
  };

  res.json({
    interviewer: publicUser(req.interviewer),
    studies: studies.map((s) => ({ id: s.id, name: s.name, market: s.market, category: s.category })),
    mine,
    counts,
  });
});

router.get("/respondents/:id", requireInterviewer, async (req, res) => {
  const respondent = await store.findOne("respondents", { id: Number(req.params.id) });
  const study = respondent ? await store.findOne("studies", { id: respondent.study_id }) : null;
  if (!respondent || !study) return res.status(404).json({ error: "Respondent not found." });
  if (req.interviewer.role === "interviewer" && respondent.interviewer_id !== req.interviewer.id) {
    return res.status(404).json({ error: "Respondent not found." });
  }
  const diaryUrl = respondentDiaryUrl(req, respondent.unique_token);
  let qr = null;
  try { qr = await qrDataUrl(diaryUrl); } catch (e) { console.error("QR generation failed:", e); }
  res.json({
    respondent: {
      id: respondent.id,
      respondentCode: respondent.respondent_code,
      name: respondent.name,
      contact: respondent.contact,
      studyName: study.name,
    },
    diaryUrl,
    qr,
    messagingLive: messaging.isRealMessagingConfigured(),
  });
});

router.post("/respondents/:id/send-link", requireInterviewer, async (req, res) => {
  const respondent = await store.findOne("respondents", { id: Number(req.params.id) });
  if (!respondent) return res.status(404).json({ error: "Respondent not found." });
  if (req.interviewer.role === "interviewer" && respondent.interviewer_id !== req.interviewer.id) {
    return res.status(404).json({ error: "Respondent not found." });
  }
  if (!respondent.contact) {
    return res.status(400).json({ error: "This respondent has no phone number on file. Show them the QR code instead." });
  }
  const study = await store.findOne("studies", { id: respondent.study_id });
  const result = await messaging.getProvider().send({
    respondentId: respondent.id,
    to: respondent.contact,
    template: "diary_link_invite",
    variables: { name: respondent.name, study: study ? study.name : "", link: respondentDiaryUrl(req, respondent.unique_token) },
  });
  logAudit(req.interviewer.email, "send_diary_link", "respondents", respondent.id, { to: respondent.contact, ok: !!result.ok });
  if (!result.ok) return res.status(502).json({ error: result.error || "The message could not be sent." });
  if (result.simulated) {
    return res.status(200).json({
      ok: true,
      simulated: true,
      message: `Messaging isn't connected yet, so nothing was actually sent to ${respondent.contact} — the message was only logged. Show them the QR code instead.`,
    });
  }
  res.json({ ok: true, simulated: false, message: `Diary link sent to ${respondent.contact}.` });
});

// F2F flow: Screen -> Consent -> Register -> Verify -> Activate, captured as
// one submission -- mirrors routes/interviewer.js's POST /register exactly.
router.post("/register", requireInterviewer, async (req, res) => {
  const { study_id, name, contact, eligible, consent_given, preferred_channel, practice } = req.body;
  const studyId = Number(study_id);
  const study = await store.findOne("studies", { id: studyId });
  if (!study) return res.status(404).json({ error: "Study not found." });

  if (!eligible) {
    return res.status(200).json({
      screenedOut: true,
      message: "Respondent screened as not eligible. Recruitment stopped (screen stage).",
    });
  }

  const token = uuidv4();
  const code = await nextRespondentCode(studyId);
  const canonicalisedContact = canonicalContact(contact, { market: study.market });
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
    interviewer_id: req.interviewer.id,
    is_practice: practice ? 1 : 0,
  });
  logAudit(req.interviewer.email, "f2f_onboard", "respondents", id, { name, code });

  const holds = await applyRecruitmentHolds(id, { studyId, contact, consentGiven: !!consent_given });
  if (holds.length) {
    return res.json({ held: true, code, name, respondentId: id, holds });
  }

  const diaryUrl = respondentDiaryUrl(req, token);
  let qr = null;
  try { qr = await qrDataUrl(diaryUrl); } catch (e) { console.error("QR generation failed:", e); }
  res.status(201).json({ activated: true, code, token, respondentId: id, diaryUrl, qr });
});

// ---- Bulk invite: template -> review -> send, mirrors routes/bulkInvite.js ----

router.get("/studies/:id/bulk/template", requireInterviewer, (req, res) => {
  res.set("Content-Type", "text/csv; charset=utf-8");
  res.send(bulk.templateCsv());
});

router.get("/studies/:id/bulk/meta", requireInterviewer, async (req, res) => {
  const study = await store.findOne("studies", { id: Number(req.params.id) });
  if (!study) return res.status(404).json({ error: "Study not found." });
  res.json({
    study: { id: study.id, name: study.name, market: study.market },
    defaultCountryCode: bulk.defaultCountryCodeFor(study.market),
    messagingLive: messaging.isRealMessagingConfigured(),
  });
});

router.post("/studies/:id/bulk/review", requireInterviewer, upload.single("roster"), async (req, res) => {
  const study = await store.findOne("studies", { id: Number(req.params.id) });
  if (!study) return res.status(404).json({ error: "Study not found." });
  if (!req.file) return res.status(400).json({ error: "Choose a filled-in template to upload." });

  const countryCode = (req.body.country_code || "").trim();
  const parsed = bulk.parseRoster(req.file.buffer, req.file.originalname);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  if (!parsed.rows.length) return res.status(400).json({ error: "That file has no rows below the header." });

  const reviewed = bulk.reviewRoster({
    rows: parsed.rows,
    countryCode,
    existingContacts: await existingContactsFor(study.id),
  });

  res.json({
    filename: req.file.originalname,
    countryCode,
    rows: reviewed,
    summary: bulk.summarise(reviewed),
  });
});

router.post("/studies/:id/bulk/send", requireInterviewer, async (req, res) => {
  const study = await store.findOne("studies", { id: Number(req.params.id) });
  if (!study) return res.status(404).json({ error: "Study not found." });

  const rows = Array.isArray(req.body.rows) ? req.body.rows : [];
  const countryCode = String(req.body.country_code || "").trim();
  const normalised = rows
    .map((r, i) => ({ rowNumber: r.rowNumber || i + 2, name: String(r.name || "").trim(), phone: String(r.phone || r.contact || "").trim() }))
    .filter((r) => r.phone);

  const reviewed = bulk.reviewRoster({ rows: normalised, countryCode, existingContacts: await existingContactsFor(study.id) });
  const toInvite = bulk.invitableRows(reviewed);

  const outcome = { invited: 0, failed: 0, skipped: reviewed.length - toInvite.length, errors: [] };
  const provider = messaging.getProvider();

  for (const row of toInvite) {
    let respondent;
    try {
      const result = await enrol({
        studyId: study.id,
        contact: row.contact,
        name: row.name,
        interviewerId: req.interviewer.role === "interviewer" ? req.interviewer.id : null,
      });
      respondent = result.respondent;
      if (!result.created) { outcome.skipped++; continue; }
    } catch (e) {
      outcome.failed++;
      outcome.errors.push(`${row.name || row.contact}: ${e.message}`);
      continue;
    }

    const sendResult = await provider.send({
      respondentId: respondent.id,
      to: row.contact,
      template: "survey_invite",
      variables: { name: row.name, study: study.name, link: `${req.protocol}://${req.get("host")}/invite/${respondent.unique_token}` },
    });

    if (sendResult.ok && !sendResult.simulated) {
      await store.update("respondents", { id: respondent.id }, { invite_sent_at: store.nowSql() });
      outcome.invited++;
    } else if (sendResult.simulated) {
      outcome.failed++;
      outcome.errors.push(`${row.name || row.contact}: messaging isn't connected, so no text was sent.`);
    } else {
      outcome.failed++;
      outcome.errors.push(`${row.name || row.contact}: ${sendResult.error || "could not be texted."}`);
    }
  }

  logAudit(req.interviewer.email, "bulk_invite", "studies", study.id, outcome);
  res.json({ outcome });
});

router.use((err, req, res, next) => {
  console.error("Mobile interviewer API error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong. Your last completed save is safe." });
});

module.exports = router;
