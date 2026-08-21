const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const db = require("../lib/db");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { classifyRisk } = require("../lib/qc");
const { runReminderEngine } = require("../lib/reminders");
const { parseUpload, parseConditionText } = require("../lib/questionnaireParser");
const { getProvider: getBrandDetectionProvider } = require("../lib/brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("../lib/audioTranscription");
const { qrPngToResponse } = require("../lib/qrcode");
const { respondentDiaryUrl } = require("../lib/urls");

const router = express.Router();
router.use(requireRole("admin", "research"));

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

function getStudyOrFirst(req) {
  const studies = db.prepare("SELECT * FROM studies ORDER BY id").all();
  const studyId = parseInt(req.query.study || req.params.id, 10);
  const study = studies.find((s) => s.id === studyId) || studies[0] || null;
  return { study, studies };
}

// ---------- Ops Dashboard ----------
router.get("/", (req, res) => {
  const { study, studies } = getStudyOrFirst(req);
  if (!study) return res.redirect("/admin/studies");

  const funnel = db
    .prepare(
      `SELECT activation_status, COUNT(*) c FROM respondents WHERE study_id = ? AND is_practice = 0 GROUP BY activation_status`
    )
    .all(study.id);
  const funnelMap = Object.fromEntries(funnel.map((f) => [f.activation_status, f.c]));

  const totalRespondents = db.prepare("SELECT COUNT(*) c FROM respondents WHERE study_id = ? AND is_practice = 0").get(study.id).c;
  const expected = db.prepare("SELECT COUNT(*) c FROM diary_records WHERE study_id = ? AND is_practice = 0").get(study.id).c;
  const completed = db.prepare("SELECT COUNT(*) c FROM diary_records WHERE study_id = ? AND status='submitted' AND is_practice = 0").get(study.id).c;
  const missed = db.prepare("SELECT COUNT(*) c FROM diary_records WHERE study_id = ? AND status='draft' AND is_practice = 0").get(study.id).c;

  const openFlags = db
    .prepare(
      `SELECT qc_flags.*, respondents.respondent_code, respondents.name as respondent_name
       FROM qc_flags JOIN respondents ON respondents.id = qc_flags.respondent_id
       WHERE respondents.study_id = ? AND qc_flags.status = 'open'
       ORDER BY datetime(qc_flags.created_time) DESC LIMIT 8`
    )
    .all(study.id);

  const interviewers = db
    .prepare(
      `SELECT u.id, u.name, COUNT(r.id) recruited,
        SUM(CASE WHEN r.activation_status IN ('active','activated','completed') THEN 1 ELSE 0 END) activated
       FROM users u LEFT JOIN respondents r ON r.interviewer_id = u.id AND r.study_id = ?
       WHERE u.role = 'interviewer' GROUP BY u.id`
    )
    .all(study.id);

  const respondentsForRisk = db.prepare("SELECT id FROM respondents WHERE study_id = ? AND is_practice = 0").all(study.id);
  const riskCounts = { green: 0, amber: 0, red: 0 };
  respondentsForRisk.forEach((r) => riskCounts[classifyRisk(r.id)]++);

  res.render("admin/dashboard", {
    study,
    studies,
    funnelMap,
    totalRespondents,
    expected,
    completed,
    missed,
    openFlags,
    interviewers,
    riskCounts,
  });
});

// ---------- Studies ----------
router.get("/studies", (req, res) => {
  const studies = db.prepare("SELECT * FROM studies ORDER BY id DESC").all();
  res.render("admin/studies", { studies });
});

router.post("/studies", (req, res) => {
  const { name, market, category, diary_mode, recruitment_mode } = req.body;
  const info = db
    .prepare(
      `INSERT INTO studies (name, market, category, diary_mode, recruitment_mode) VALUES (?, ?, ?, ?, ?)`
    )
    .run(name, market, category, diary_mode, recruitment_mode);
  // seed default KPI candidates
  const defaults = [
    ["completion_rate", "Diary Completion Rate"],
    ["compliance_rate", "Compliance Rate"],
    ["brand_incidence", "Brand Incidence"],
    ["avg_occasions_per_week", "Avg Occasions / Week"],
    ["qc_flag_rate", "QC Flag Rate"],
    ["active_respondents", "Active Respondents"],
  ];
  const insertKpi = db.prepare("INSERT INTO kpi_config (study_id, kpi_key, label, enabled) VALUES (?, ?, ?, 1)");
  defaults.forEach(([k, l]) => insertKpi.run(info.lastInsertRowid, k, l));
  logAudit(req.session.user.email, "create", "studies", info.lastInsertRowid, req.body);
  res.redirect(`/admin/studies/${info.lastInsertRowid}`);
});

router.get("/studies/:id", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  if (!study) return res.status(404).render("error", { message: "Study not found", user: req.session.user });
  res.render("admin/study_settings", { study, tab: "settings" });
});

router.post("/studies/:id/settings", (req, res) => {
  const b = req.body;
  db.prepare(
    `UPDATE studies SET name=?, market=?, category=?, status=?, diary_mode=?, recruitment_mode=?,
      back_entry_hours=?, recall_window_hours=?, mandatory_photo=?, duplicate_similarity_threshold=?,
      burst_entry_count_threshold=?, burst_entry_window_hours=?, reminder_due_hours=?, reminder_missed_hours=?,
      default_reminder_channel=?
     WHERE id=?`
  ).run(
    b.name, b.market, b.category, b.status, b.diary_mode, b.recruitment_mode,
    parseInt(b.back_entry_hours) || 24, parseInt(b.recall_window_hours) || 48, b.mandatory_photo ? 1 : 0,
    parseFloat(b.duplicate_similarity_threshold) || 0.9, parseInt(b.burst_entry_count_threshold) || 3,
    parseInt(b.burst_entry_window_hours) || 2, b.reminder_due_hours ? parseInt(b.reminder_due_hours) : null,
    b.reminder_missed_hours ? parseInt(b.reminder_missed_hours) : null, b.default_reminder_channel,
    req.params.id
  );
  logAudit(req.session.user.email, "update_settings", "studies", req.params.id, b);
  res.redirect(`/admin/studies/${req.params.id}?saved=1`);
});

// ---------- Questionnaire builder ----------
router.get("/studies/:id/questionnaire", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const questions = db.prepare("SELECT * FROM questions WHERE study_id = ? ORDER BY order_index").all(req.params.id);
  res.render("admin/study_questionnaire", {
    study, questions, tab: "questionnaire",
    imported: req.query.imported,
    rulesCreated: req.query.rulesCreated,
    rulesSkipped: req.query.rulesSkipped,
  });
});

router.post("/studies/:id/questionnaire", (req, res) => {
  const { code, type, text, required, options, min_value, max_value, section } = req.body;
  const maxOrder = db.prepare("SELECT MAX(order_index) m FROM questions WHERE study_id = ?").get(req.params.id).m || 0;
  const optionsJson = options ? JSON.stringify(options.split(",").map((o) => o.trim()).filter(Boolean)) : null;
  db.prepare(
    `INSERT INTO questions (study_id, order_index, code, type, text, required, options_json, min_value, max_value, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(req.params.id, maxOrder + 1, code, type, text, required ? 1 : 0, optionsJson, min_value || null, max_value || null, (section || "").trim() || null);
  logAudit(req.session.user.email, "add_question", "questions", null, req.body);
  res.redirect(`/admin/studies/${req.params.id}/questionnaire`);
});

router.post("/studies/:id/questionnaire/:qid/delete", (req, res) => {
  db.prepare("UPDATE questions SET active = 0 WHERE id = ?").run(req.params.qid);
  logAudit(req.session.user.email, "deactivate_question", "questions", req.params.qid, {});
  res.redirect(`/admin/studies/${req.params.id}/questionnaire`);
});

// ---------- Questionnaire upload / parse / preview / commit ----------
router.get("/studies/:id/questionnaire/upload", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  res.render("admin/study_questionnaire_upload", { study, tab: "questionnaire", error: null });
});

router.post("/studies/:id/questionnaire/upload", importUpload.single("file"), async (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  if (!req.file) {
    return res.render("admin/study_questionnaire_upload", { study, tab: "questionnaire", error: "Please choose a file to upload." });
  }
  try {
    const result = await parseUpload(req.file.buffer, req.file.originalname);
    if (!result.rows.length) {
      return res.render("admin/study_questionnaire_upload", {
        study,
        tab: "questionnaire",
        error: (result.warnings && result.warnings[0]) || "No questions could be parsed from that file.",
      });
    }
    const info = db
      .prepare(
        `INSERT INTO question_imports (study_id, source_filename, source_type, payload_json, warnings_json)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(study.id, req.file.originalname, result.sourceType, JSON.stringify(result.rows), JSON.stringify(result.warnings || []));
    logAudit(req.session.user.email, "questionnaire_upload", "question_imports", info.lastInsertRowid, {
      filename: req.file.originalname,
      rows: result.rows.length,
    });
    res.redirect(`/admin/studies/${study.id}/questionnaire/preview/${info.lastInsertRowid}`);
  } catch (e) {
    res.render("admin/study_questionnaire_upload", { study, tab: "questionnaire", error: `Could not read that file: ${e.message}` });
  }
});

router.get("/studies/:id/questionnaire/preview/:importId", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const imp = db.prepare("SELECT * FROM question_imports WHERE id = ? AND study_id = ?").get(req.params.importId, req.params.id);
  if (!imp) return res.status(404).render("error", { message: "Import not found or already committed.", user: req.session.user });
  const rows = JSON.parse(imp.payload_json);
  const fileWarnings = JSON.parse(imp.warnings_json || "[]");
  res.render("admin/study_questionnaire_preview", { study, imp, rows, fileWarnings, tab: "questionnaire", VALID_TYPES: require("../lib/questionnaireParser").VALID_TYPES });
});

router.post("/studies/:id/questionnaire/preview/:importId/commit", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const imp = db.prepare("SELECT * FROM question_imports WHERE id = ? AND study_id = ?").get(req.params.importId, req.params.id);
  if (!imp) return res.status(404).render("error", { message: "Import not found or already committed.", user: req.session.user });

  const editedRows = Array.isArray(req.body.rows) ? req.body.rows : Object.values(req.body.rows || {});
  // The parsed-but-unedited rows carry metadata the edit form doesn't expose as
  // fields (condition_raw, is_section_anchor, the template's own "#" number) --
  // zip them back up by index with the edited text/type/options the user confirmed.
  const originalRows = JSON.parse(imp.payload_json);
  const maxOrder = db.prepare("SELECT MAX(order_index) m FROM questions WHERE study_id = ?").get(study.id).m || 0;
  const insertQ = db.prepare(
    `INSERT INTO questions (study_id, order_index, code, type, text, required, options_json, min_value, max_value, section)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  let inserted = 0;
  const questionIdByTemplateRow = new Map(); // template "#" -> newly inserted question id, included rows only
  editedRows.forEach((r, i) => {
    if (!r || !r.include || !r.text || !r.text.trim()) return;
    const optionsArr = (r.options || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const info = insertQ.run(
      study.id,
      maxOrder + inserted + 1,
      r.code || null,
      r.type || "text",
      r.text.trim(),
      r.required ? 1 : 0,
      optionsArr.length ? JSON.stringify(optionsArr) : null,
      r.min !== undefined && r.min !== "" ? parseFloat(r.min) : null,
      r.max !== undefined && r.max !== "" ? parseFloat(r.max) : null,
      r.section && r.section.trim() ? r.section.trim() : null
    );
    inserted++;
    const orig = originalRows[i];
    if (orig && orig.row !== undefined) questionIdByTemplateRow.set(orig.row, info.lastInsertRowid);
  });

  // Second pass: turn each row's parsed Condition into real skip_rules now that
  // every included row has a question id. A section anchor's own condition
  // becomes ONE section-level rule (covers every question in that section); a
  // plain "Show if" on a non-anchor row, or a "; show if ..." tacked onto a
  // "Same section as" reference, becomes a per-question rule targeting that row.
  const insertRule = db.prepare(
    `INSERT INTO skip_rules (study_id, target_question_id, target_section, condition_question_id, operator, value, action)
     VALUES (?, ?, ?, ?, ?, ?, 'show')`
  );
  const sectionsRuled = new Set();
  let rulesCreated = 0;
  let rulesSkipped = 0;
  originalRows.forEach((orig, i) => {
    const edited = editedRows[i];
    if (!edited || !edited.include || !questionIdByTemplateRow.has(orig.row)) return;
    const parsed = parseConditionText(orig.condition_raw);
    if (parsed.empty) return;

    if (orig.is_section_anchor && parsed.own) {
      const sectionKey = (edited.section || "").trim();
      if (sectionKey && !sectionsRuled.has(sectionKey)) {
        const conditionId = questionIdByTemplateRow.get(parsed.own.conditionRow);
        if (conditionId) {
          insertRule.run(study.id, null, sectionKey, conditionId, parsed.own.operator, parsed.own.values.join("|"));
          sectionsRuled.add(sectionKey);
          rulesCreated++;
        } else {
          rulesSkipped++;
        }
      }
    } else if (parsed.own) {
      const conditionId = questionIdByTemplateRow.get(parsed.own.conditionRow);
      const targetId = questionIdByTemplateRow.get(orig.row);
      if (conditionId && targetId) {
        insertRule.run(study.id, targetId, null, conditionId, parsed.own.operator, parsed.own.values.join("|"));
        rulesCreated++;
      } else {
        rulesSkipped++;
      }
    }
  });

  db.prepare("DELETE FROM question_imports WHERE id = ?").run(imp.id);
  logAudit(req.session.user.email, "questionnaire_commit", "questions", null, { importId: imp.id, inserted, rulesCreated, rulesSkipped });
  res.redirect(`/admin/studies/${study.id}/questionnaire?imported=${inserted}&rulesCreated=${rulesCreated}&rulesSkipped=${rulesSkipped}`);
});

router.post("/studies/:id/questionnaire/preview/:importId/discard", (req, res) => {
  db.prepare("DELETE FROM question_imports WHERE id = ?").run(req.params.importId);
  res.redirect(`/admin/studies/${req.params.id}/questionnaire/upload`);
});

// ---------- Skip logic ----------
router.get("/studies/:id/skip-logic", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const questions = db.prepare("SELECT * FROM questions WHERE study_id = ? AND active = 1 ORDER BY order_index").all(req.params.id);
  const sections = [...new Set(questions.map((q) => q.section).filter(Boolean))];
  const rules = db
    .prepare(
      `SELECT sr.*, tq.text as target_text, cq.text as condition_text FROM skip_rules sr
       LEFT JOIN questions tq ON tq.id = sr.target_question_id
       JOIN questions cq ON cq.id = sr.condition_question_id
       WHERE sr.study_id = ?`
    )
    .all(req.params.id);
  res.render("admin/study_skip_logic", { study, questions, sections, rules, tab: "skip-logic" });
});

router.post("/studies/:id/skip-logic", (req, res) => {
  const { target_type, target_question_id, target_section, condition_question_id, operator, value, action } = req.body;
  const isSection = target_type === "section";
  // "is one of" / "is none of" / "includes" accept a comma-separated value list
  // in the form -- normalize to the same "|" join the auto-created (template
  // import) rules and the respondent form's matching logic both use.
  const storedValue = ["in", "not_in", "includes"].includes(operator)
    ? String(value || "").split(",").map((v) => v.trim()).filter(Boolean).join("|")
    : value;
  db.prepare(
    `INSERT INTO skip_rules (study_id, target_question_id, target_section, condition_question_id, operator, value, action)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.params.id,
    isSection ? null : target_question_id || null,
    isSection ? target_section || null : null,
    condition_question_id,
    operator,
    storedValue,
    action
  );
  logAudit(req.session.user.email, "add_skip_rule", "skip_rules", null, req.body);
  res.redirect(`/admin/studies/${req.params.id}/skip-logic`);
});

router.post("/studies/:id/skip-logic/:rid/delete", (req, res) => {
  db.prepare("DELETE FROM skip_rules WHERE id = ?").run(req.params.rid);
  res.redirect(`/admin/studies/${req.params.id}/skip-logic`);
});

// ---------- Brands / SKU ----------
router.get("/studies/:id/brands", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const brands = db.prepare("SELECT * FROM brands WHERE study_id = ? ORDER BY name").all(req.params.id);
  res.render("admin/study_brands", { study, brands, tab: "brands" });
});

router.post("/studies/:id/brands", (req, res) => {
  const { name, category, sku } = req.body;
  db.prepare("INSERT INTO brands (study_id, name, category, sku) VALUES (?, ?, ?, ?)").run(req.params.id, name, category, sku);
  logAudit(req.session.user.email, "add_brand", "brands", null, req.body);
  res.redirect(`/admin/studies/${req.params.id}/brands`);
});

router.post("/studies/:id/brands/:bid/delete", (req, res) => {
  db.prepare("UPDATE brands SET active = 0 WHERE id = ?").run(req.params.bid);
  res.redirect(`/admin/studies/${req.params.id}/brands`);
});

// ---------- Consent ----------
router.get("/studies/:id/consent", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const versions = db.prepare("SELECT * FROM consent_versions WHERE study_id = ? ORDER BY version DESC").all(req.params.id);
  res.render("admin/study_consent", { study, versions, tab: "consent" });
});

router.post("/studies/:id/consent", (req, res) => {
  const { body } = req.body;
  const maxV = db.prepare("SELECT MAX(version) m FROM consent_versions WHERE study_id = ?").get(req.params.id).m || 0;
  db.prepare("INSERT INTO consent_versions (study_id, version, body, status) VALUES (?, ?, ?, 'draft')").run(req.params.id, maxV + 1, body);
  logAudit(req.session.user.email, "add_consent_draft", "consent_versions", null, { version: maxV + 1 });
  res.redirect(`/admin/studies/${req.params.id}/consent`);
});

router.post("/studies/:id/consent/:cid/approve", (req, res) => {
  db.prepare("UPDATE consent_versions SET status='approved', approved_by=?, approved_at=datetime('now') WHERE id=?").run(
    req.session.user.name,
    req.params.cid
  );
  logAudit(req.session.user.email, "approve_consent", "consent_versions", req.params.cid, {});
  res.redirect(`/admin/studies/${req.params.id}/consent`);
});

// ---------- KPIs ----------
router.get("/studies/:id/kpis", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const kpis = db.prepare("SELECT * FROM kpi_config WHERE study_id = ?").all(req.params.id);
  res.render("admin/study_kpis", { study, kpis, tab: "kpis" });
});

router.post("/studies/:id/kpis/:kid/toggle", (req, res) => {
  const kpi = db.prepare("SELECT * FROM kpi_config WHERE id = ?").get(req.params.kid);
  db.prepare("UPDATE kpi_config SET enabled = ? WHERE id = ?").run(kpi.enabled ? 0 : 1, req.params.kid);
  res.redirect(`/admin/studies/${req.params.id}/kpis`);
});

router.post("/studies/:id/kpis", (req, res) => {
  const { kpi_key, label } = req.body;
  db.prepare("INSERT INTO kpi_config (study_id, kpi_key, label, enabled) VALUES (?, ?, ?, 1)").run(req.params.id, kpi_key, label);
  res.redirect(`/admin/studies/${req.params.id}/kpis`);
});

// ---------- Users ----------
router.get("/users", (req, res) => {
  const users = db.prepare("SELECT users.*, studies.name as study_name FROM users LEFT JOIN studies ON studies.id = users.study_id ORDER BY users.id").all();
  const studies = db.prepare("SELECT * FROM studies ORDER BY name").all();
  res.render("admin/users", { users, studies });
});

router.post("/users", (req, res) => {
  const { name, email, password, role, study_id } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  try {
    db.prepare("INSERT INTO users (name, email, password_hash, role, study_id) VALUES (?, ?, ?, ?, ?)").run(
      name, email.toLowerCase(), hash, role, study_id || null
    );
    logAudit(req.session.user.email, "create_user", "users", null, { email, role });
  } catch (e) {
    return res.render("error", { message: "Could not create user (email may already exist).", user: req.session.user });
  }
  res.redirect("/admin/users");
});

// ---------- QC worklist ----------
router.get("/qc", (req, res) => {
  const { study, studies } = getStudyOrFirst(req);
  if (!study) return res.redirect("/admin/studies");
  const statusFilter = req.query.status || "open";
  const flags = db
    .prepare(
      `SELECT qc_flags.*, respondents.respondent_code, respondents.name as respondent_name, respondents.id as rid
       FROM qc_flags JOIN respondents ON respondents.id = qc_flags.respondent_id
       WHERE respondents.study_id = ? AND (? = 'all' OR qc_flags.status = ?)
       ORDER BY datetime(qc_flags.created_time) DESC`
    )
    .all(study.id, statusFilter, statusFilter);
  res.render("admin/qc_worklist", { study, studies, flags, statusFilter });
});

router.post("/qc/:id/action", (req, res) => {
  const { status, action_note } = req.body;
  db.prepare(
    `UPDATE qc_flags SET status=?, reviewer=?, action_note=?, resolved_at=CASE WHEN ?='resolved' THEN datetime('now') ELSE resolved_at END WHERE id=?`
  ).run(status, req.session.user.name, action_note, status, req.params.id);
  logAudit(req.session.user.email, "qc_action", "qc_flags", req.params.id, { status, action_note });
  res.redirect(req.get("Referrer") || "/admin/qc");
});

// ---------- Respondents (recruitment detail) ----------
router.get("/studies/:id/respondents", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const respondents = db.prepare("SELECT * FROM respondents WHERE study_id = ? ORDER BY id DESC").all(req.params.id);
  const withRisk = respondents.map((r) => ({
    ...r,
    risk: classifyRisk(r.id),
    diaryUrl: respondentDiaryUrl(req, r.unique_token),
  }));
  res.render("admin/study_respondents", { study, respondents: withRisk, tab: "respondents" });
});

// On-demand QR PNG for one respondent's diary link -- generated only when a
// staff member actually opens it (rather than up front for every row), so a
// study with hundreds of respondents doesn't pay to render codes no one views.
router.get("/studies/:id/respondents/:respondentId/qr.png", async (req, res) => {
  const respondent = db
    .prepare("SELECT * FROM respondents WHERE id = ? AND study_id = ?")
    .get(req.params.respondentId, req.params.id);
  if (!respondent) return res.status(404).end();
  await qrPngToResponse(res, respondentDiaryUrl(req, respondent.unique_token));
});

// ---------- Reminders / WhatsApp ----------
router.post("/reminders/run", async (req, res) => {
  const result = await runReminderEngine();
  res.redirect(`/admin?ran=${result.created}`);
});

router.get("/whatsapp-outbox", (req, res) => {
  const messages = db
    .prepare(
      `SELECT whatsapp_outbox.*, respondents.respondent_code FROM whatsapp_outbox
       LEFT JOIN respondents ON respondents.id = whatsapp_outbox.respondent_id
       ORDER BY datetime(whatsapp_outbox.created_at) DESC LIMIT 100`
    )
    .all();
  res.render("admin/whatsapp_outbox", { messages });
});

// ---------- Media review / brand detection ----------
router.get("/studies/:id/media", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  const items = db
    .prepare(
      `SELECT media.*, respondents.respondent_code, diary_records.period_label
       FROM media
       JOIN diary_records ON diary_records.id = media.record_id
       JOIN respondents ON respondents.id = diary_records.respondent_id
       WHERE diary_records.study_id = ?
       ORDER BY datetime(media.upload_time) DESC`
    )
    .all(req.params.id);
  res.render("admin/study_media", { study, items, tab: "media" });
});

router.post("/media/:id/detect", async (req, res) => {
  const media = db.prepare("SELECT * FROM media WHERE id = ?").get(req.params.id);
  if (!media) return res.status(404).render("error", { message: "Media item not found.", user: req.session.user });
  const record = db.prepare("SELECT * FROM diary_records WHERE id = ?").get(media.record_id);
  const brands = db.prepare("SELECT * FROM brands WHERE study_id = ? AND active = 1").all(record.study_id);
  try {
    const provider = getBrandDetectionProvider();
    await provider.detect(media, brands);
    logAudit(req.session.user.email, "brand_detection_run", "media", media.id, {});
  } catch (e) {
    db.prepare("UPDATE media SET detection_status = 'error', detection_raw_json = ? WHERE id = ?").run(
      JSON.stringify({ error: e.message }),
      media.id
    );
  }
  res.redirect(req.get("Referrer") || `/admin/studies/${record.study_id}/media`);
});

router.post("/media/:id/transcribe", async (req, res) => {
  const media = db.prepare("SELECT * FROM media WHERE id = ?").get(req.params.id);
  if (!media) return res.status(404).render("error", { message: "Media item not found.", user: req.session.user });
  const record = db.prepare("SELECT * FROM diary_records WHERE id = ?").get(media.record_id);
  try {
    const provider = getAudioTranscriptionProvider();
    await provider.transcribe(media);
    logAudit(req.session.user.email, "audio_transcription_run", "media", media.id, {});
  } catch (e) {
    db.prepare("UPDATE media SET transcript_status = 'error', transcript_raw_json = ? WHERE id = ?").run(
      JSON.stringify({ error: e.message }),
      media.id
    );
  }
  res.redirect(req.get("Referrer") || `/admin/studies/${record.study_id}/media`);
});

// ---------- Export ----------
function toCsv(rows) {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]);
  const esc = (v) => `"${String(v === null || v === undefined ? "" : v).replace(/"/g, '""')}"`;
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join("\n");
}

router.get("/export/respondents.csv", (req, res) => {
  const { study } = getStudyOrFirst(req);
  const rows = db.prepare("SELECT * FROM respondents WHERE study_id = ?").all(study.id);
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=respondents.csv");
  res.send(toCsv(rows));
});

router.get("/export/diary.csv", (req, res) => {
  const { study } = getStudyOrFirst(req);
  const rows = db
    .prepare(
      `SELECT dr.id, dr.respondent_id, r.respondent_code, dr.period_label, dr.occurrence_time, dr.entry_time,
              dr.submit_time, dr.channel, dr.status, dr.is_practice
       FROM diary_records dr JOIN respondents r ON r.id = dr.respondent_id WHERE dr.study_id = ?`
    )
    .all(study.id);
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=diary_records.csv");
  res.send(toCsv(rows));
});

router.get("/export/qc.csv", (req, res) => {
  const { study } = getStudyOrFirst(req);
  const rows = db
    .prepare(
      `SELECT qf.* FROM qc_flags qf JOIN respondents r ON r.id = qf.respondent_id WHERE r.study_id = ?`
    )
    .all(study.id);
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=qc_flags.csv");
  res.send(toCsv(rows));
});

module.exports = router;
