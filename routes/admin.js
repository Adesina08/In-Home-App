const express = require("express");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const path = require("path");
const db = require("../lib/db");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { classifyRisk, unresolvedBlockingFlags } = require("../lib/qc");
const { runReminderEngine } = require("../lib/reminders");
const { parseUpload, parseConditionText } = require("../lib/questionnaireParser");
const { getProvider: getBrandDetectionProvider } = require("../lib/brandDetection");
const { getProvider: getAudioTranscriptionProvider } = require("../lib/audioTranscription");
const { qrPngToResponse } = require("../lib/qrcode");
const { respondentDiaryUrl, appBaseUrl } = require("../lib/urls");
const { getOrCreateJoinCode, remoteOnboardingOpen } = require("../lib/joinCode");
const aiSummary = require("../lib/aiSummary");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { markQuestionnaireDirty, publishVersion } = require("../lib/studyVersion");

const router = express.Router();
router.use(requireRole("admin", "research"));

// Any successful write to the questionnaire (questions, sections, skip logic)
// marks the study as having unpublished changes, so the Questionnaire tab can
// show "vN + unpublished changes" and offer a Publish action. Done as one
// middleware rather than a call inside each of the ~10 mutating handlers so a
// route added later can't silently forget to flag it -- the failure mode there
// is invisible (a stale version number), which is exactly the kind of thing
// nobody notices until the data is being analysed.
//
// Staging an import or discarding a staged preview are excluded: neither
// changes a single live question. Committing an import is NOT excluded --
// that one does.
const QUESTIONNAIRE_WRITE_RE = /^\/studies\/(\d+)\/(questions|questionnaire|sections|skip-logic)(\/|$)/;
router.use((req, res, next) => {
  if (req.method === "GET") return next();
  const match = QUESTIONNAIRE_WRITE_RE.exec(req.path);
  if (!match) return next();
  // Publishing lives under the same path prefix but is the one write that
  // CLEARS the dirty flag -- letting it match here would re-dirty the study
  // the instant it was published, so the badge never cleared.
  const isNotAnEdit =
    /\/questionnaire\/publish$/.test(req.path) ||
    /\/questionnaire\/upload$/.test(req.path) ||
    /\/preview\/\d+\/discard$/.test(req.path);
  if (isNotAnEdit) return next();
  // Flag only once the response actually succeeded -- a handler that 4xx'd or
  // threw changed nothing, and shouldn't leave the study looking edited.
  res.on("finish", () => {
    if (res.statusCode < 400) markQuestionnaireDirty(match[1]);
  });
  next();
});

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
  const screenedOut = db.prepare("SELECT COUNT(*) c FROM diary_records WHERE study_id = ? AND status='screened_out' AND is_practice = 0").get(study.id).c;

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
    screenedOut,
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

  // End validation (spec 4.1): a study can't be closed while critical/high QC
  // exceptions are still unreviewed -- closing is what freezes the dataset for
  // delivery, so anything still in dispute has to be dispositioned first.
  // Every other settings change on this form saves normally; only the
  // transition *into* 'closed' is gated.
  const current = db.prepare("SELECT status FROM studies WHERE id = ?").get(req.params.id);
  if (b.status === "closed" && current && current.status !== "closed") {
    const blocking = unresolvedBlockingFlags({ studyId: req.params.id });
    if (blocking.length) {
      const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
      return res.status(400).render("admin/study_settings", {
        study,
        tab: "settings",
        closeBlocked: blocking,
      });
    }
  }

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
  // This page also carries the Skip Logic and Brand/SKU sections (previously
  // separate tabs, merged onto one scrollable page) -- so it loads their data
  // too. Skip Logic's dropdowns/section list only ever consider active
  // (non-removed) questions, same filter the old standalone route used.
  const activeQuestions = questions.filter((q) => q.active);
  const sections = [...new Set(activeQuestions.map((q) => q.section).filter(Boolean))];
  const rules = db
    .prepare(
      `SELECT sr.*, tq.text as target_text, cq.text as condition_text FROM skip_rules sr
       LEFT JOIN questions tq ON tq.id = sr.target_question_id
       JOIN questions cq ON cq.id = sr.condition_question_id
       WHERE sr.study_id = ?`
    )
    .all(req.params.id);
  const brands = db.prepare("SELECT * FROM brands WHERE study_id = ? ORDER BY name").all(req.params.id);
  res.render("admin/study_questionnaire", {
    study, questions, activeQuestions, sections, rules, brands, tab: "questionnaire",
    imported: req.query.imported,
    rulesCreated: req.query.rulesCreated,
    rulesSkipped: req.query.rulesSkipped,
    published: req.query.published,
  });
});

// Publish the next questionnaire version. Every response saved from here on
// is stamped with the new number (see routes/respondent.js), so entries
// answered against the old wording stay attributed to the old version.
router.post("/studies/:id/questionnaire/publish", (req, res) => {
  const version = publishVersion(req.params.id, req.session.user.email);
  const suffix = version ? `published=${version}` : "published=none";
  res.redirect(`/admin/studies/${req.params.id}/questionnaire?${suffix}`);
});

// Read-only, respondent-view preview of the questionnaire as it stands right
// now -- reuses the exact same active-question + skip-rule query the live
// respondent diary form uses (lib/questionnaire.js), so what an admin sees
// here (including which questions the skip logic shows/hides as they click
// around) matches production exactly. Nothing here is ever saved.
router.get("/studies/:id/questionnaire/live-preview", (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  if (!study) return res.status(404).render("error", { message: "Study not found.", user: req.session.user });
  const { questions, rules } = loadQuestionnaire(study.id);
  // Stand-in respondent so {respondent_name}-style pipe tokens render as a
  // realistic example here instead of the bare "…" fallback -- an admin
  // checking their wording needs to see the shape of the finished sentence.
  const previewRespondent = { name: "Sample Respondent", respondent_code: "R00-0000" };
  res.render("admin/study_questionnaire_live_preview", {
    study, questions, rules, previewRespondent, tab: "questionnaire",
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
  if (req.xhr) return res.json({ ok: true });
  res.redirect(`/admin/studies/${req.params.id}/questionnaire`);
});

// ---------- Questionnaire builder: inline editor JSON API ----------
// The Questionnaire section of the combined page (study_questionnaire.ejs)
// edits questions directly as cards -- these endpoints back that live
// editing (fetch calls with header X-Requested-With: XMLHttpRequest, so
// req.xhr is true). They return JSON instead of redirecting.

// Create a new blank question, appended at the end of the questionnaire (or
// of a given section). The client focuses its text field immediately after
// creation; reordering it into a specific spot is done afterwards by drag.
router.post("/studies/:id/questions", (req, res) => {
  const section = (req.body.section || "").trim() || null;
  const maxOrder = db.prepare("SELECT MAX(order_index) m FROM questions WHERE study_id = ?").get(req.params.id).m || 0;
  const info = db
    .prepare(`INSERT INTO questions (study_id, order_index, type, text, required, section) VALUES (?, ?, 'text', '', 1, ?)`)
    .run(req.params.id, maxOrder + 1, section);
  logAudit(req.session.user.email, "add_question_inline", "questions", info.lastInsertRowid, { section });
  const created = db.prepare("SELECT * FROM questions WHERE id = ?").get(info.lastInsertRowid);
  res.json(created);
});

// Partial update of one question's fields -- whatever the card's autosave
// sends (text on blur, type/required/section on change, the options array
// whenever a row is added/removed/edited).
router.patch("/studies/:id/questions/:qid", (req, res) => {
  const q = db.prepare("SELECT * FROM questions WHERE id = ? AND study_id = ?").get(req.params.qid, req.params.id);
  if (!q) return res.status(404).json({ error: "Question not found." });
  const b = req.body || {};
  const text = b.text !== undefined ? String(b.text).trim() : q.text;
  if (!text) return res.status(400).json({ error: "Question text can't be empty." });
  const next = {
    code: b.code !== undefined ? (String(b.code).trim() || null) : q.code,
    type: b.type !== undefined ? b.type : q.type,
    text,
    required: b.required !== undefined ? (b.required ? 1 : 0) : q.required,
    options_json:
      b.options !== undefined
        ? (() => {
            const cleaned = (Array.isArray(b.options) ? b.options : []).map((o) => String(o).trim()).filter(Boolean);
            return cleaned.length ? JSON.stringify(cleaned) : null;
          })()
        : q.options_json,
    min_value: b.min_value !== undefined ? (b.min_value === "" || b.min_value === null ? null : parseFloat(b.min_value)) : q.min_value,
    max_value: b.max_value !== undefined ? (b.max_value === "" || b.max_value === null ? null : parseFloat(b.max_value)) : q.max_value,
    section: b.section !== undefined ? (String(b.section).trim() || null) : q.section,
  };
  db.prepare(
    `UPDATE questions SET code=?, type=?, text=?, required=?, options_json=?, min_value=?, max_value=?, section=? WHERE id=?`
  ).run(next.code, next.type, next.text, next.required, next.options_json, next.min_value, next.max_value, next.section, q.id);
  logAudit(req.session.user.email, "update_question_inline", "questions", q.id, b);
  res.json(db.prepare("SELECT * FROM questions WHERE id = ?").get(q.id));
});

// Persist a full drag-and-drop reorder -- the client sends every active
// question id in its new top-to-bottom order and this renumbers them 1..N.
router.post("/studies/:id/questions/reorder", (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
  const stmt = db.prepare("UPDATE questions SET order_index = ? WHERE id = ? AND study_id = ?");
  db.transaction((list) => {
    list.forEach((id, i) => stmt.run(i + 1, id, req.params.id));
  })(ids);
  res.json({ ok: true });
});

// Rename a section across every question that carries it (and any
// section-level skip rule pointed at the old name).
router.patch("/studies/:id/sections", (req, res) => {
  const oldName = (req.body.oldName || "").trim();
  const newName = (req.body.newName || "").trim();
  if (!oldName || !newName) return res.status(400).json({ error: "Section name can't be empty." });
  db.prepare("UPDATE questions SET section = ? WHERE study_id = ? AND section = ?").run(newName, req.params.id, oldName);
  db.prepare("UPDATE skip_rules SET target_section = ? WHERE study_id = ? AND target_section = ?").run(newName, req.params.id, oldName);
  logAudit(req.session.user.email, "rename_section", "questions", null, { oldName, newName });
  res.json({ ok: true });
});

// Ungroup a section: its questions go back to "No section" and any
// section-level skip rule targeting it is removed (a rule with no section
// to attach to would otherwise be orphaned).
router.post("/studies/:id/sections/delete", (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Section name can't be empty." });
  db.prepare("UPDATE questions SET section = NULL WHERE study_id = ? AND section = ?").run(req.params.id, name);
  db.prepare("DELETE FROM skip_rules WHERE study_id = ? AND target_section = ?").run(req.params.id, name);
  logAudit(req.session.user.email, "delete_section", "questions", null, { name });
  res.json({ ok: true });
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
// Skip Logic now lives as a section on the combined Questionnaire Builder
// page (see GET /studies/:id/questionnaire) rather than its own tab -- this
// route just redirects old links/bookmarks to that section.
router.get("/studies/:id/skip-logic", (req, res) => {
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#skip-logic`);
});

router.post("/studies/:id/skip-logic", (req, res) => {
  const { target_type, target_question_id, target_section, condition_question_id, operator, value, action, terminate_scope } = req.body;
  const isTerminate = action === "terminate";
  const isSection = !isTerminate && target_type === "section";
  // "is one of" / "is none of" / "includes" accept a comma-separated value list
  // in the form -- normalize to the same "|" join the auto-created (template
  // import) rules and the respondent form's matching logic both use.
  const storedValue = ["in", "not_in", "includes"].includes(operator)
    ? String(value || "").split(",").map((v) => v.trim()).filter(Boolean).join("|")
    : value;
  const info = db
    .prepare(
      `INSERT INTO skip_rules (study_id, target_question_id, target_section, condition_question_id, operator, value, action, terminate_scope)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.id,
      // A terminate rule has no target question/section -- it ends the entry
      // (or the respondent's whole participation) rather than showing/hiding
      // something else, so both stay null regardless of what target_type was posted.
      isTerminate ? null : (isSection ? null : target_question_id || null),
      isTerminate ? null : (isSection ? target_section || null : null),
      condition_question_id,
      operator,
      storedValue,
      action,
      isTerminate && terminate_scope === "study" ? "study" : (isTerminate ? "entry" : null)
    );
  logAudit(req.session.user.email, "add_skip_rule", "skip_rules", null, req.body);
  if (req.xhr) {
    const rule = db
      .prepare(
        `SELECT sr.*, tq.text as target_text, cq.text as condition_text FROM skip_rules sr
         LEFT JOIN questions tq ON tq.id = sr.target_question_id
         JOIN questions cq ON cq.id = sr.condition_question_id
         WHERE sr.id = ?`
      )
      .get(info.lastInsertRowid);
    return res.json(rule);
  }
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#skip-logic`);
});

router.post("/studies/:id/skip-logic/:rid/delete", (req, res) => {
  db.prepare("DELETE FROM skip_rules WHERE id = ?").run(req.params.rid);
  if (req.xhr) return res.json({ ok: true });
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#skip-logic`);
});

// ---------- Brands / SKU ----------
// Brand/SKU List now lives as a section on the combined Questionnaire
// Builder page too -- see GET /studies/:id/questionnaire.
router.get("/studies/:id/brands", (req, res) => {
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#brands`);
});

router.post("/studies/:id/brands", (req, res) => {
  const { name, category, sku } = req.body;
  db.prepare("INSERT INTO brands (study_id, name, category, sku) VALUES (?, ?, ?, ?)").run(req.params.id, name, category, sku);
  logAudit(req.session.user.email, "add_brand", "brands", null, req.body);
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#brands`);
});

router.post("/studies/:id/brands/:bid/delete", (req, res) => {
  db.prepare("UPDATE brands SET active = 0 WHERE id = ?").run(req.params.bid);
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#brands`);
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

// ---------- AI summary (spec 4.3, P1) ----------
router.get("/ai-summary", (req, res) => {
  const { study, studies } = getStudyOrFirst(req);
  if (!study) return res.redirect("/admin/studies");
  res.render("admin/ai_summary", {
    study,
    studies,
    summaries: aiSummary.listSummaries(study.id),
    aiConfigured: aiSummary.isAiModelConfigured(),
    openTextSampleSize: aiSummary.OPEN_TEXT_SAMPLE_SIZE,
    from: req.query.from || "",
    to: req.query.to || "",
    error: req.query.error || null,
    generated: req.query.generated || null,
  });
});

router.post("/ai-summary/generate", async (req, res) => {
  const studyId = parseInt(req.body.study_id, 10);
  const from = (req.body.from || "").trim() || null;
  const to = (req.body.to || "").trim() || null;
  const qs = (extra) =>
    `study=${studyId}&from=${encodeURIComponent(from || "")}&to=${encodeURIComponent(to || "")}${extra}`;

  if (from && to && from > to) {
    return res.redirect(`/admin/ai-summary?${qs(`&error=${encodeURIComponent("The start date is after the end date.")}`)}`);
  }
  try {
    const row = await aiSummary.generateSummary(studyId, { from, to, generatedBy: req.session.user.email });
    logAudit(req.session.user.email, "generate_ai_summary", "ai_summaries", row.id, {
      study_id: studyId, from, to, provider: row.provider,
    });
    res.redirect(`/admin/ai-summary?${qs(`&generated=${row.id}`)}`);
  } catch (e) {
    // A failed model call must not lose the admin's period selection.
    res.redirect(`/admin/ai-summary?${qs(`&error=${encodeURIComponent(e.message || "Could not generate a summary.")}`)}`);
  }
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
  const lockCounts = db.prepare("SELECT respondent_id, COUNT(*) c FROM respondent_credentials GROUP BY respondent_id").all();
  const lockCountByRespondent = Object.fromEntries(lockCounts.map((row) => [row.respondent_id, row.c]));
  const withRisk = respondents.map((r) => ({
    ...r,
    risk: classifyRisk(r.id),
    diaryUrl: respondentDiaryUrl(req, r.unique_token),
    hasLock: !!lockCountByRespondent[r.id],
  }));
  // Remote self-onboarding invite link (spec Flow B step 1). The code is
  // allocated lazily on first view so studies that never recruit remotely
  // never get one. remoteOpen reflects whether the link would actually work
  // right now -- an admin handing out a link for a draft or F2F-only study
  // would otherwise only find out when respondents hit a refusal page.
  const joinCode = getOrCreateJoinCode(study.id);
  res.render("admin/study_respondents", {
    study,
    respondents: withRisk,
    tab: "respondents",
    joinCode,
    joinUrl: `${appBaseUrl(req)}/join/${joinCode}`,
    remoteOpen: remoteOnboardingOpen(study),
    activated: req.query.activated,
  });
});

// Release a recruitment hold (see lib/qc.js applyRecruitmentHolds): a
// respondent registered with a duplicate contact or without recorded consent
// stays 'registered' and can't log entries until research has looked at the
// flag and activated them here. The flag itself is deliberately NOT
// auto-resolved -- the QC design rule is that flags stay visible and are
// dispositioned explicitly on the worklist, with the audit trail intact.
router.post("/studies/:id/respondents/:respondentId/activate", (req, res) => {
  const respondent = db
    .prepare("SELECT * FROM respondents WHERE id = ? AND study_id = ?")
    .get(req.params.respondentId, req.params.id);
  if (!respondent) return res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
  db.prepare("UPDATE respondents SET activation_status = 'activated' WHERE id = ?").run(respondent.id);
  logAudit(req.session.user.email, "release_recruitment_hold", "respondents", respondent.id, {
    respondent_code: respondent.respondent_code,
  });
  res.redirect(`/admin/studies/${req.params.id}/respondents?activated=${encodeURIComponent(respondent.respondent_code)}`);
});

// QR for the study's public remote sign-up link, so the invite can be printed
// on a flyer or shown on screen rather than typed out.
router.get("/studies/:id/join-qr.png", async (req, res) => {
  const study = db.prepare("SELECT * FROM studies WHERE id = ?").get(req.params.id);
  if (!study) return res.status(404).end();
  const code = getOrCreateJoinCode(study.id);
  await qrPngToResponse(res, `${appBaseUrl(req)}/join/${code}`);
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
              dr.submit_time, dr.channel, dr.status, dr.terminate_note, dr.is_practice
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
