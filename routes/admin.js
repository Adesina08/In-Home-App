const express = require("express");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const multer = require("multer");
const path = require("path");
const store = require("../lib/store");
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
const { CATEGORIES, parseCategories, toStoredCategories } = require("../lib/categories");
const accounts = require("../lib/respondentAccounts");
const { nextRespondentCode } = require("../lib/respondentCode");
const messaging = require("../lib/whatsapp");
const kpiEngine = require("../lib/kpi");
const { v4: uuidv4 } = require("uuid");
const { loadQuestionnaire } = require("../lib/questionnaire");
const { markQuestionnaireDirty, publishVersion } = require("../lib/studyVersion");

const router = express.Router();
router.use(requireRole("admin"));

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
    // The response has already gone out, so there is nothing left to await
    // into -- the flag is written fire-and-forget. A failure is logged rather
    // than swallowed: it would leave an edited study not showing as edited,
    // which is invisible in the UI and needs to be findable in the logs.
    if (res.statusCode < 400) {
      markQuestionnaireDirty(toId(match[1])).catch((e) =>
        console.error("Could not flag the questionnaire as edited:", e.message)
      );
    }
  });
  next();
});

const importUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

// SQLite's INTEGER affinity quietly turned an id arriving as the string "7"
// (off a URL or a form field) into the number 7, on both sides of a comparison
// and on the way into an INTEGER column. The document store matches types
// exactly, so ids are converted here instead. A non-numeric value is passed
// through unchanged, so it still matches nothing, exactly as before.
function toId(v) {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  return Number.isNaN(n) ? v : n;
}

async function getStudyOrFirst(req) {
  const studies = await store.find("studies", {}, { sort: { id: 1 } });
  const studyId = parseInt(req.query.study || req.params.id, 10);
  const study = studies.find((s) => s.id === studyId) || studies[0] || null;
  return { study, studies };
}

// ---------- Ops Dashboard ----------
router.get("/", async (req, res) => {
  const { study, studies } = await getStudyOrFirst(req);
  if (!study) return res.redirect("/admin/studies");

  // GROUP BY activation_status in one round trip -- countBy returns the same
  // { value: count } shape the old Object.fromEntries built.
  const funnelMap = await store.countBy("respondents", "activation_status", { study_id: study.id, is_practice: 0 });

  const totalRespondents = await store.count("respondents", { study_id: study.id, is_practice: 0 });
  const expected = await store.count("diary_records", { study_id: study.id, is_practice: 0 });
  const completed = await store.count("diary_records", { study_id: study.id, status: "submitted", is_practice: 0 });
  const missed = await store.count("diary_records", { study_id: study.id, status: "draft", is_practice: 0 });
  const screenedOut = await store.count("diary_records", { study_id: study.id, status: "screened_out", is_practice: 0 });

  // The qc_flags -> respondents JOIN done in JS: the study scope becomes an
  // $in over that study's respondent ids, and respondent_code /
  // respondent_name are stitched on afterwards under the same aliases the
  // template reads.
  const flagRespondents = await store.find(
    "respondents",
    { study_id: study.id },
    { projection: { id: 1, respondent_code: 1, name: 1 } }
  );
  const flagRespById = new Map(flagRespondents.map((r) => [r.id, r]));
  const openFlags = (
    await store.find(
      "qc_flags",
      { respondent_id: { $in: [...flagRespById.keys()] }, status: "open" },
      { sort: { created_time: -1 }, limit: 8 }
    )
  ).map((f) => ({
    ...f,
    respondent_code: flagRespById.get(f.respondent_id).respondent_code,
    respondent_name: flagRespById.get(f.respondent_id).name,
  }));

  // The LEFT JOIN users -> respondents tally, done in JS. The join condition
  // carried the study, so a respondent on another study counts towards neither
  // column -- and an interviewer who recruited nobody still gets a row of
  // zeroes, exactly as the LEFT JOIN produced.
  const interviewerUsers = await store.find("users", { role: "interviewer" }, { sort: { id: 1 } });
  const respondentsForInterviewers = await store.find(
    "respondents",
    { study_id: study.id },
    { projection: { id: 1, interviewer_id: 1, activation_status: 1 } }
  );
  const interviewers = interviewerUsers.map((u) => {
    const mine = respondentsForInterviewers.filter((r) => r.interviewer_id === u.id);
    return {
      id: u.id,
      name: u.name,
      recruited: mine.length,
      activated: mine.filter((r) => ["active", "activated", "completed"].includes(r.activation_status)).length,
    };
  });

  const respondentsForRisk = await store.find("respondents", { study_id: study.id, is_practice: 0 }, { projection: { id: 1 } });
  const riskCounts = { green: 0, amber: 0, red: 0 };
  for (const r of respondentsForRisk) riskCounts[await classifyRisk(r.id)]++;

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
router.get("/studies", async (req, res) => {
  const studies = await store.find("studies", {}, { sort: { id: -1 } });
  res.render("admin/studies", { studies });
});

router.post("/studies", async (req, res) => {
  const { name, market, diary_mode, recruitment_mode } = req.body;
  const category = toStoredCategories(req.body.category);
  const { id } = await store.insert("studies", { name, market, category, diary_mode, recruitment_mode });
  // seed default KPI candidates
  const defaults = [
    ["completion_rate", "Diary Completion Rate"],
    ["compliance_rate", "Compliance Rate"],
    ["brand_incidence", "Brand Incidence"],
    ["avg_occasions_per_week", "Avg Occasions / Week"],
    ["qc_flag_rate", "QC Flag Rate"],
    ["active_respondents", "Active Respondents"],
  ];
  for (const [k, l] of defaults) {
    await store.insert("kpi_config", { study_id: id, kpi_key: k, label: l, enabled: 1 });
  }
  logAudit(req.session.user.email, "create", "studies", id, req.body);
  res.redirect(`/admin/studies/${id}`);
});

router.get("/studies/:id", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  if (!study) return res.status(404).render("error", { message: "Study not found", user: req.session.user });
  res.render("admin/study_settings", {
    study, tab: "settings",
    CATEGORIES, selectedCategories: parseCategories(study.category),
  });
});

router.post("/studies/:id/settings", async (req, res) => {
  const b = req.body;
  const studyId = toId(req.params.id);

  // End validation (spec 4.1): a study can't be closed while critical/high QC
  // exceptions are still unreviewed -- closing is what freezes the dataset for
  // delivery, so anything still in dispute has to be dispositioned first.
  // Every other settings change on this form saves normally; only the
  // transition *into* 'closed' is gated.
  const current = await store.findOne("studies", { id: studyId }, { projection: { status: 1 } });
  if (b.status === "closed" && current && current.status !== "closed") {
    const blocking = await unresolvedBlockingFlags({ studyId });
    if (blocking.length) {
      const study = await store.findOne("studies", { id: studyId });
      return res.status(400).render("admin/study_settings", {
        study,
        tab: "settings",
        closeBlocked: blocking,
        CATEGORIES,
        selectedCategories: parseCategories(study.category),
      });
    }
  }

  // The duplicate check is entered as a percentage (nobody thinks in 0.9) but
  // stored 0-1, which is what the QC engine compares against. Clamped so a
  // typo'd 900 can't silently disable the rule by making it unreachable.
  const dupPct = Math.min(100, Math.max(1, parseInt(b.duplicate_similarity_pct, 10) || 90));

  await store.update("studies", { id: studyId }, {
    name: b.name,
    market: b.market,
    category: toStoredCategories(b.category),
    status: b.status,
    diary_mode: b.diary_mode,
    recruitment_mode: b.recruitment_mode,
    back_entry_hours: parseInt(b.back_entry_hours) || 24,
    mandatory_photo: b.mandatory_photo ? 1 : 0,
    duplicate_similarity_threshold: dupPct / 100,
    burst_entry_count_threshold: parseInt(b.burst_entry_count_threshold) || 3,
    burst_entry_window_hours: parseInt(b.burst_entry_window_hours) || 2,
    reminder_due_hours: b.reminder_due_hours ? parseInt(b.reminder_due_hours) : null,
    reminder_missed_hours: b.reminder_missed_hours ? parseInt(b.reminder_missed_hours) : null,
    default_reminder_channel: b.default_reminder_channel,
    qc_back_entry_enabled: b.qc_back_entry_enabled ? 1 : 0,
    qc_duplicate_enabled: b.qc_duplicate_enabled ? 1 : 0,
    qc_burst_enabled: b.qc_burst_enabled ? 1 : 0,
    invite_brief: (b.invite_brief || "").trim() || null,
  });
  logAudit(req.session.user.email, "update_settings", "studies", req.params.id, b);
  res.redirect(`/admin/studies/${req.params.id}?saved=1`);
});

// ---------- Questionnaire builder ----------
router.get("/studies/:id/questionnaire", async (req, res) => {
  const studyId = toId(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  const questions = await store.find("questions", { study_id: studyId }, { sort: { order_index: 1 } });
  // This page also carries the Skip Logic and Brand/SKU sections (previously
  // separate tabs, merged onto one scrollable page) -- so it loads their data
  // too. Skip Logic's dropdowns/section list only ever consider active
  // (non-removed) questions, same filter the old standalone route used.
  const activeQuestions = questions.filter((q) => q.active);
  const sections = [...new Set(activeQuestions.map((q) => q.section).filter(Boolean))];
  // The skip-rule joins done in JS: LEFT onto the target question, INNER onto
  // the condition question. Both sides are questions of this same study, so
  // the list already loaded above is the lookup. The inner join dropped a rule
  // whose condition question had gone -- that is kept. target_text /
  // condition_text keep their aliases, the template reads them.
  const questionsById = new Map(questions.map((q) => [q.id, q]));
  const rules = (await store.find("skip_rules", { study_id: studyId }, { sort: { id: 1 } }))
    .filter((sr) => questionsById.has(sr.condition_question_id))
    .map((sr) => ({
      ...sr,
      target_text: questionsById.has(sr.target_question_id) ? questionsById.get(sr.target_question_id).text : null,
      condition_text: questionsById.get(sr.condition_question_id).text,
    }));
  const brands = await store.find("brands", { study_id: studyId }, { sort: { name: 1 } });
  // The rebuilt three-pane builder. Mounted behind ?v=2 rather than replacing
  // the old view outright: this is the most complex interactive screen in the
  // app, and being able to switch back mid-pilot is worth more than a clean
  // deletion. Both read the same data and call the same endpoints.
  const builderView = req.query.v === "2"
    ? "admin/study_questionnaire_v2"
    : "admin/study_questionnaire";

  res.render(builderView, {
    study, questions, activeQuestions, sections, rules, brands, tab: "questionnaire",
    user: req.session.user,
    imported: req.query.imported,
    rulesCreated: req.query.rulesCreated,
    rulesSkipped: req.query.rulesSkipped,
    published: req.query.published,
  });
});

// Publish the next questionnaire version. Every response saved from here on
// is stamped with the new number (see routes/respondent.js), so entries
// answered against the old wording stay attributed to the old version.
router.post("/studies/:id/questionnaire/publish", async (req, res) => {
  const version = await publishVersion(toId(req.params.id), req.session.user.email);
  const suffix = version ? `published=${version}` : "published=none";
  res.redirect(`/admin/studies/${req.params.id}/questionnaire?${suffix}`);
});

// Read-only, respondent-view preview of the questionnaire as it stands right
// now -- reuses the exact same active-question + skip-rule query the live
// respondent diary form uses (lib/questionnaire.js), so what an admin sees
// here (including which questions the skip logic shows/hides as they click
// around) matches production exactly. Nothing here is ever saved.
router.get("/studies/:id/questionnaire/live-preview", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  if (!study) return res.status(404).render("error", { message: "Study not found.", user: req.session.user });
  const { questions, rules } = await loadQuestionnaire(study.id);
  // Stand-in respondent so {respondent_name}-style pipe tokens render as a
  // realistic example here instead of the bare "…" fallback -- an admin
  // checking their wording needs to see the shape of the finished sentence.
  const previewRespondent = { name: "Sample Respondent", respondent_code: "R00-0000" };
  res.render("admin/study_questionnaire_live_preview", {
    study, questions, rules, previewRespondent, tab: "questionnaire",
  });
});

router.post("/studies/:id/questionnaire", async (req, res) => {
  const { code, type, text, required, options, min_value, max_value, section } = req.body;
  const studyId = toId(req.params.id);
  const maxOrder = (await store.max("questions", "order_index", { study_id: studyId })) || 0;
  const optionsJson = options ? JSON.stringify(options.split(",").map((o) => o.trim()).filter(Boolean)) : null;
  await store.insert("questions", {
    study_id: studyId,
    order_index: maxOrder + 1,
    code,
    type,
    text,
    required: required ? 1 : 0,
    options_json: optionsJson,
    min_value: min_value || null,
    max_value: max_value || null,
    section: (section || "").trim() || null,
  });
  logAudit(req.session.user.email, "add_question", "questions", null, req.body);
  res.redirect(`/admin/studies/${req.params.id}/questionnaire`);
});

router.post("/studies/:id/questionnaire/:qid/delete", async (req, res) => {
  await store.update("questions", { id: toId(req.params.qid) }, { active: 0 });
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
router.post("/studies/:id/questions", async (req, res) => {
  const section = (req.body.section || "").trim() || null;
  const studyId = toId(req.params.id);
  const maxOrder = (await store.max("questions", "order_index", { study_id: studyId })) || 0;
  const { id } = await store.insert("questions", {
    study_id: studyId,
    order_index: maxOrder + 1,
    type: "text",
    text: "",
    required: 1,
    section,
  });
  logAudit(req.session.user.email, "add_question_inline", "questions", id, { section });
  const created = await store.findOne("questions", { id });
  res.json(created);
});

// Partial update of one question's fields -- whatever the card's autosave
// sends (text on blur, type/required/section on change, the options array
// whenever a row is added/removed/edited).
router.patch("/studies/:id/questions/:qid", async (req, res) => {
  const q = await store.findOne("questions", { id: toId(req.params.qid), study_id: toId(req.params.id) });
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
  await store.update("questions", { id: q.id }, {
    code: next.code,
    type: next.type,
    text: next.text,
    required: next.required,
    options_json: next.options_json,
    min_value: next.min_value,
    max_value: next.max_value,
    section: next.section,
  });
  logAudit(req.session.user.email, "update_question_inline", "questions", q.id, b);
  res.json(await store.findOne("questions", { id: q.id }));
});

// Persist a full drag-and-drop reorder -- the client sends every active
// question id in its new top-to-bottom order and this renumbers them 1..N.
router.post("/studies/:id/questions/reorder", async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter((n) => Number.isInteger(n)) : [];
  const studyId = toId(req.params.id);
  // The store has no transaction: the renumbering is applied one row at a
  // time, in the order the client sent, which is what the transaction body did.
  for (const [i, id] of ids.entries()) {
    await store.update("questions", { id, study_id: studyId }, { order_index: i + 1 });
  }
  res.json({ ok: true });
});

// Rename a section across every question that carries it (and any
// section-level skip rule pointed at the old name).
router.patch("/studies/:id/sections", async (req, res) => {
  const oldName = (req.body.oldName || "").trim();
  const newName = (req.body.newName || "").trim();
  if (!oldName || !newName) return res.status(400).json({ error: "Section name can't be empty." });
  const studyId = toId(req.params.id);
  await store.update("questions", { study_id: studyId, section: oldName }, { section: newName });
  await store.update("skip_rules", { study_id: studyId, target_section: oldName }, { target_section: newName });
  logAudit(req.session.user.email, "rename_section", "questions", null, { oldName, newName });
  res.json({ ok: true });
});

// Ungroup a section: its questions go back to "No section" and any
// section-level skip rule targeting it is removed (a rule with no section
// to attach to would otherwise be orphaned).
router.post("/studies/:id/sections/delete", async (req, res) => {
  const name = (req.body.name || "").trim();
  if (!name) return res.status(400).json({ error: "Section name can't be empty." });
  const studyId = toId(req.params.id);
  await store.update("questions", { study_id: studyId, section: name }, { section: null });
  await store.remove("skip_rules", { study_id: studyId, target_section: name });
  logAudit(req.session.user.email, "delete_section", "questions", null, { name });
  res.json({ ok: true });
});

// ---------- Questionnaire upload / parse / preview / commit ----------
router.get("/studies/:id/questionnaire/upload", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  res.render("admin/study_questionnaire_upload", { study, tab: "questionnaire", error: null });
});

router.post("/studies/:id/questionnaire/upload", importUpload.single("file"), async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
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
    const { id } = await store.insert("question_imports", {
      study_id: study.id,
      source_filename: req.file.originalname,
      source_type: result.sourceType,
      payload_json: JSON.stringify(result.rows),
      warnings_json: JSON.stringify(result.warnings || []),
    });
    logAudit(req.session.user.email, "questionnaire_upload", "question_imports", id, {
      filename: req.file.originalname,
      rows: result.rows.length,
    });
    res.redirect(`/admin/studies/${study.id}/questionnaire/preview/${id}`);
  } catch (e) {
    res.render("admin/study_questionnaire_upload", { study, tab: "questionnaire", error: `Could not read that file: ${e.message}` });
  }
});

router.get("/studies/:id/questionnaire/preview/:importId", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  const imp = await store.findOne("question_imports", { id: toId(req.params.importId), study_id: toId(req.params.id) });
  if (!imp) return res.status(404).render("error", { message: "Import not found or already committed.", user: req.session.user });
  const rows = JSON.parse(imp.payload_json);
  const fileWarnings = JSON.parse(imp.warnings_json || "[]");
  res.render("admin/study_questionnaire_preview", { study, imp, rows, fileWarnings, tab: "questionnaire", VALID_TYPES: require("../lib/questionnaireParser").VALID_TYPES });
});

router.post("/studies/:id/questionnaire/preview/:importId/commit", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  const imp = await store.findOne("question_imports", { id: toId(req.params.importId), study_id: toId(req.params.id) });
  if (!imp) return res.status(404).render("error", { message: "Import not found or already committed.", user: req.session.user });

  const editedRows = Array.isArray(req.body.rows) ? req.body.rows : Object.values(req.body.rows || {});
  // The parsed-but-unedited rows carry metadata the edit form doesn't expose as
  // fields (condition_raw, is_section_anchor, the template's own "#" number) --
  // zip them back up by index with the edited text/type/options the user confirmed.
  const originalRows = JSON.parse(imp.payload_json);
  const maxOrder = (await store.max("questions", "order_index", { study_id: study.id })) || 0;
  let inserted = 0;
  const questionIdByTemplateRow = new Map(); // template "#" -> newly inserted question id, included rows only
  // for...of rather than forEach: each insert is awaited, and the running
  // `inserted` counter feeds the next row's order_index, so they have to stay
  // in sequence.
  for (const [i, r] of editedRows.entries()) {
    if (!r || !r.include || !r.text || !r.text.trim()) continue;
    const optionsArr = (r.options || "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean);
    const { id } = await store.insert("questions", {
      study_id: study.id,
      order_index: maxOrder + inserted + 1,
      code: r.code || null,
      type: r.type || "text",
      text: r.text.trim(),
      required: r.required ? 1 : 0,
      options_json: optionsArr.length ? JSON.stringify(optionsArr) : null,
      min_value: r.min !== undefined && r.min !== "" ? parseFloat(r.min) : null,
      max_value: r.max !== undefined && r.max !== "" ? parseFloat(r.max) : null,
      section: r.section && r.section.trim() ? r.section.trim() : null,
    });
    inserted++;
    const orig = originalRows[i];
    if (orig && orig.row !== undefined) questionIdByTemplateRow.set(orig.row, id);
  }

  // Second pass: turn each row's parsed Condition into real skip_rules now that
  // every included row has a question id. A section anchor's own condition
  // becomes ONE section-level rule (covers every question in that section); a
  // plain "Show if" on a non-anchor row, or a "; show if ..." tacked onto a
  // "Same section as" reference, becomes a per-question rule targeting that row.
  const sectionsRuled = new Set();
  let rulesCreated = 0;
  let rulesSkipped = 0;
  for (const [i, orig] of originalRows.entries()) {
    const edited = editedRows[i];
    if (!edited || !edited.include || !questionIdByTemplateRow.has(orig.row)) continue;
    const parsed = parseConditionText(orig.condition_raw);
    if (parsed.empty) continue;

    if (orig.is_section_anchor && parsed.own) {
      const sectionKey = (edited.section || "").trim();
      if (sectionKey && !sectionsRuled.has(sectionKey)) {
        const conditionId = questionIdByTemplateRow.get(parsed.own.conditionRow);
        if (conditionId) {
          await store.insert("skip_rules", {
            study_id: study.id,
            target_question_id: null,
            target_section: sectionKey,
            condition_question_id: conditionId,
            operator: parsed.own.operator,
            value: parsed.own.values.join("|"),
            action: "show",
          });
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
        await store.insert("skip_rules", {
          study_id: study.id,
          target_question_id: targetId,
          target_section: null,
          condition_question_id: conditionId,
          operator: parsed.own.operator,
          value: parsed.own.values.join("|"),
          action: "show",
        });
        rulesCreated++;
      } else {
        rulesSkipped++;
      }
    }
  }

  await store.remove("question_imports", { id: imp.id });
  logAudit(req.session.user.email, "questionnaire_commit", "questions", null, { importId: imp.id, inserted, rulesCreated, rulesSkipped });
  res.redirect(`/admin/studies/${study.id}/questionnaire?imported=${inserted}&rulesCreated=${rulesCreated}&rulesSkipped=${rulesSkipped}`);
});

router.post("/studies/:id/questionnaire/preview/:importId/discard", async (req, res) => {
  await store.remove("question_imports", { id: toId(req.params.importId) });
  res.redirect(`/admin/studies/${req.params.id}/questionnaire/upload`);
});

// ---------- Skip logic ----------
// Skip Logic now lives as a section on the combined Questionnaire Builder
// page (see GET /studies/:id/questionnaire) rather than its own tab -- this
// route just redirects old links/bookmarks to that section.
router.get("/studies/:id/skip-logic", (req, res) => {
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#skip-logic`);
});

router.post("/studies/:id/skip-logic", async (req, res) => {
  const { target_type, target_question_id, target_section, condition_question_id, operator, value, action, terminate_scope } = req.body;
  const isTerminate = action === "terminate";
  const isSection = !isTerminate && target_type === "section";
  // "is one of" / "is none of" / "includes" accept a comma-separated value list
  // in the form -- normalize to the same "|" join the auto-created (template
  // import) rules and the respondent form's matching logic both use.
  const storedValue = ["in", "not_in", "includes"].includes(operator)
    ? String(value || "").split(",").map((v) => v.trim()).filter(Boolean).join("|")
    : value;
  const { id } = await store.insert("skip_rules", {
    study_id: toId(req.params.id),
    // A terminate rule has no target question/section -- it ends the entry
    // (or the respondent's whole participation) rather than showing/hiding
    // something else, so both stay null regardless of what target_type was posted.
    target_question_id: isTerminate ? null : (isSection ? null : toId(target_question_id)),
    target_section: isTerminate ? null : (isSection ? target_section || null : null),
    condition_question_id: toId(condition_question_id),
    operator,
    value: storedValue,
    action,
    terminate_scope: isTerminate && terminate_scope === "study" ? "study" : (isTerminate ? "entry" : null),
  });
  logAudit(req.session.user.email, "add_skip_rule", "skip_rules", null, req.body);
  if (req.xhr) {
    // Same two joins as the Questionnaire page, for this one rule: LEFT onto
    // the target question, INNER onto the condition question -- so a rule
    // whose condition question is missing yields nothing, as before.
    const created = await store.findOne("skip_rules", { id });
    const tq = created.target_question_id ? await store.findOne("questions", { id: created.target_question_id }) : null;
    const cq = await store.findOne("questions", { id: created.condition_question_id });
    const rule = cq
      ? { ...created, target_text: tq ? tq.text : null, condition_text: cq.text }
      : undefined;
    return res.json(rule);
  }
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#skip-logic`);
});

router.post("/studies/:id/skip-logic/:rid/delete", async (req, res) => {
  await store.remove("skip_rules", { id: toId(req.params.rid) });
  if (req.xhr) return res.json({ ok: true });
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#skip-logic`);
});

// ---------- Brands / SKU ----------
// Brand/SKU List now lives as a section on the combined Questionnaire
// Builder page too -- see GET /studies/:id/questionnaire.
router.get("/studies/:id/brands", (req, res) => {
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#brands`);
});

router.post("/studies/:id/brands", async (req, res) => {
  const { name, category, sku } = req.body;
  await store.insert("brands", { study_id: toId(req.params.id), name, category, sku });
  logAudit(req.session.user.email, "add_brand", "brands", null, req.body);
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#brands`);
});

router.post("/studies/:id/brands/:bid/delete", async (req, res) => {
  await store.update("brands", { id: toId(req.params.bid) }, { active: 0 });
  res.redirect(`/admin/studies/${req.params.id}/questionnaire#brands`);
});

// ---------- Consent ----------
router.get("/studies/:id/consent", async (req, res) => {
  const studyId = toId(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  const versions = await store.find("consent_versions", { study_id: studyId }, { sort: { version: -1 } });
  res.render("admin/study_consent", { study, versions, tab: "consent" });
});

router.post("/studies/:id/consent", async (req, res) => {
  const { body } = req.body;
  const studyId = toId(req.params.id);
  const maxV = (await store.max("consent_versions", "version", { study_id: studyId })) || 0;
  await store.insert("consent_versions", { study_id: studyId, version: maxV + 1, body, status: "draft" });
  logAudit(req.session.user.email, "add_consent_draft", "consent_versions", null, { version: maxV + 1 });
  res.redirect(`/admin/studies/${req.params.id}/consent`);
});

router.post("/studies/:id/consent/:cid/approve", async (req, res) => {
  await store.update("consent_versions", { id: toId(req.params.cid) }, {
    status: "approved",
    approved_by: req.session.user.name,
    approved_at: store.nowSql(),
  });
  logAudit(req.session.user.email, "approve_consent", "consent_versions", req.params.cid, {});
  res.redirect(`/admin/studies/${req.params.id}/consent`);
});

// ---------- KPIs ----------
router.get("/studies/:id/kpis", async (req, res) => {
  const studyId = toId(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  // No ORDER BY before: rowid order, which is the id, and the list is shown.
  const kpis = await store.find("kpi_config", { study_id: studyId }, { sort: { id: 1 } });
  const questions = await store.find(
    "questions",
    { study_id: studyId, active: 1 },
    { sort: { order_index: 1, id: 1 }, projection: { id: 1, code: 1, text: 1, type: 1, options_json: 1 } }
  );
  const questionsById = Object.fromEntries(questions.map((q) => [q.id, q]));

  // Computed here as well as on the client dashboard so an admin can see the
  // real number while building the KPI, rather than defining it blind and
  // finding out days later that it reads 0% or an em-dash.
  const { results, entryCount } = await kpiEngine.computeAll(study.id, kpis);

  res.render("admin/study_kpis", {
    study,
    kpis,
    questions,
    questionsById,
    metrics: kpiEngine.METRICS,
    operators: kpiEngine.OPERATORS,
    describeKpi: (k) => kpiEngine.describeKpi(k, questionsById),
    computed: results,
    entryCount,
    error: req.query.error || null,
    tab: "kpis",
  });
});

router.post("/studies/:id/kpis/:kid/toggle", async (req, res) => {
  const kpi = await store.findOne("kpi_config", { id: toId(req.params.kid) });
  await store.update("kpi_config", { id: toId(req.params.kid) }, { enabled: kpi.enabled ? 0 : 1 });
  res.redirect(`/admin/studies/${req.params.id}/kpis`);
});

router.post("/studies/:id/kpis/:kid/delete", async (req, res) => {
  const kpi = await store.findOne("kpi_config", { id: toId(req.params.kid), study_id: toId(req.params.id) });
  if (kpi) {
    await store.remove("kpi_config", { id: kpi.id });
    logAudit(req.session.user.email, "delete_kpi", "kpi_config", kpi.id, { label: kpi.label });
  }
  res.redirect(`/admin/studies/${req.params.id}/kpis`);
});

// Build a KPI from the study's own questionnaire. The conditions arrive as
// parallel arrays (cond_question[], cond_operator[], cond_value[]) because
// the builder lets an admin add as many filter rows as they need.
router.post("/studies/:id/kpis", async (req, res) => {
  const studyId = req.params.id;
  const back = (msg) =>
    res.redirect(`/admin/studies/${studyId}/kpis${msg ? `?error=${encodeURIComponent(msg)}` : ""}`);

  const label = (req.body.label || "").trim();
  const metric = req.body.metric || "";
  if (!label) return back("Give the KPI a name so the client knows what they're looking at.");
  if (!kpiEngine.METRICS[metric]) return back("Choose what this KPI measures.");

  const spec = kpiEngine.METRICS[metric];
  const questionId = req.body.question_id ? Number(req.body.question_id) : null;
  if (spec.needsQuestion && !questionId) return back("Choose which question this KPI is about.");

  // Option values arrive as a checkbox group -- one or several.
  let optionValue = null;
  if (spec.needsOption) {
    const raw = req.body.option_value;
    const values = (Array.isArray(raw) ? raw : raw ? [raw] : []).filter(Boolean);
    if (!values.length) return back("Choose at least one option to measure.");
    optionValue = values.join("|");
  }

  const cq = [].concat(req.body.cond_question || []);
  const co = [].concat(req.body.cond_operator || []);
  const cv = [].concat(req.body.cond_value || []);
  const conditions = cq
    .map((q, i) => ({ question_id: Number(q), operator: co[i] || "equals", value: (cv[i] || "").trim() }))
    .filter((c) => c.question_id && c.value !== "");

  // kpi_key is kept for the six built-ins and for CSV column headers; a
  // generated one keeps custom KPIs distinguishable without asking an admin
  // to invent a machine name.
  const key = `custom_${metric}_${Date.now().toString(36)}`;
  const { id } = await store.insert("kpi_config", {
    study_id: toId(studyId),
    kpi_key: key,
    label,
    enabled: 1,
    metric,
    question_id: questionId,
    option_value: optionValue,
    conditions_json: conditions.length ? JSON.stringify(conditions) : null,
    unit: (req.body.unit || "").trim() || null,
  });
  logAudit(req.session.user.email, "create_kpi", "kpi_config", id, { label, metric });
  back(null);
});

// Bulk invitations share one implementation with the interviewer side -- see
// routes/bulkInvite.js. Mounted per-role so each keeps its own path prefix.
router.use("/studies/:id/bulk-invite", require("./bulkInvite"));

// ---------- Users ----------
router.get("/users", async (req, res) => {
  const userRows = await store.find("users", {}, { sort: { id: 1 } });
  const studies = await store.find("studies", {}, { sort: { name: 1 } });
  // LEFT JOIN users -> studies, done in JS off the study list this page already
  // loads. study_name keeps its alias -- the template reads it.
  const studiesById = new Map(studies.map((s) => [s.id, s]));
  const users = userRows.map((u) => ({
    ...u,
    study_name: studiesById.has(u.study_id) ? studiesById.get(u.study_id).name : null,
  }));
  res.render("admin/users", {
    users, studies,
    // Shown once, immediately after a reset, then gone on the next load.
    resetEmail: req.query.reset || null,
    resetTemp: req.query.temp || null,
  });
});

router.post("/users", async (req, res) => {
  const { name, email, password, role, study_id } = req.body;
  const hash = bcrypt.hashSync(password, 10);
  try {
    await store.insert("users", {
      name,
      email: email.toLowerCase(),
      password_hash: hash,
      role,
      study_id: toId(study_id),
    });
    logAudit(req.session.user.email, "create_user", "users", null, { email, role });
  } catch (e) {
    return res.render("error", { message: "Could not create user (email may already exist).", user: req.session.user });
  }
  res.redirect("/admin/users");
});

// ---------- Password reset ----------
//
// Staff and client passwords are reset here rather than by email, because no
// mail provider is configured -- a self-serve "check your inbox" flow would
// promise something the app cannot deliver. /forgot-password tells people to
// ask a research manager; this is what the manager does.
//
// The temporary password is generated, never chosen by the admin: an admin who
// picks it knows it, and a password two people know is not a password. It is
// shown exactly once, on the redirect, and stored only as a bcrypt hash.
router.post("/users/:id/reset-password", async (req, res) => {
  const id = Number(req.params.id);
  const target = await store.findOne("users", { id });
  if (!target) return res.status(404).render("error", { message: "User not found.", user: req.session.user });

  // Superadmin is the only role that can reset another superadmin, so an admin
  // cannot take over the account that can delete studies.
  if (target.role === "superadmin" && req.session.user.role !== "superadmin") {
    return res.status(403).render("error", {
      message: "Only a superadmin can reset another superadmin's password.",
      user: req.session.user,
    });
  }

  // Ambiguous characters left out (0/O, 1/l/I): this gets read aloud down a
  // phone line or copied off a sticky note.
  const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";
  let temp = "";
  for (let i = 0; i < 12; i++) temp += ALPHABET[crypto.randomInt(ALPHABET.length)];

  await store.update("users", { id }, {
    password_hash: bcrypt.hashSync(temp, 10),
    must_change_password: 1,
  });
  logAudit(req.session.user.email, "reset_user_password", "users", id, { email: target.email });

  // Passed through the URL so it survives the redirect. It is single-use and
  // useless without the account's email, and the alternative -- rendering the
  // list inline -- loses the redirect-after-POST that stops a refresh issuing
  // a second password.
  res.redirect(`/admin/users?reset=${encodeURIComponent(target.email)}&temp=${encodeURIComponent(temp)}`);
});

// ---------- AI summary (spec 4.3, P1) ----------
router.get("/ai-summary", async (req, res) => {
  const { study, studies } = await getStudyOrFirst(req);
  if (!study) return res.redirect("/admin/studies");
  res.render("admin/ai_summary", {
    study,
    studies,
    summaries: await aiSummary.listSummaries(study.id),
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
router.get("/qc", async (req, res) => {
  const { study, studies } = await getStudyOrFirst(req);
  if (!study) return res.redirect("/admin/studies");
  const statusFilter = req.query.status || "open";
  // The qc_flags -> respondents JOIN in JS. The "(? = 'all' OR status = ?)"
  // switch becomes a filter key that is simply left off when 'all' is asked
  // for; respondent_code / respondent_name / rid keep their aliases.
  const qcRespondents = await store.find(
    "respondents",
    { study_id: study.id },
    { projection: { id: 1, respondent_code: 1, name: 1 } }
  );
  const qcRespById = new Map(qcRespondents.map((r) => [r.id, r]));
  const flagFilter = { respondent_id: { $in: [...qcRespById.keys()] } };
  if (statusFilter !== "all") flagFilter.status = statusFilter;
  const flags = (await store.find("qc_flags", flagFilter, { sort: { created_time: -1 } })).map((f) => {
    const r = qcRespById.get(f.respondent_id);
    return { ...f, respondent_code: r.respondent_code, respondent_name: r.name, rid: r.id };
  });
  res.render("admin/qc_worklist", { study, studies, flags, statusFilter });
});

router.post("/qc/:id/action", async (req, res) => {
  const { status, action_note } = req.body;
  const patch = { status, reviewer: req.session.user.name, action_note };
  // The SQL CASE only stamped resolved_at on the move to 'resolved', and left
  // whatever was already there for every other status.
  if (status === "resolved") patch.resolved_at = store.nowSql();
  await store.update("qc_flags", { id: toId(req.params.id) }, patch);
  logAudit(req.session.user.email, "qc_action", "qc_flags", req.params.id, { status, action_note });
  res.redirect(req.get("Referrer") || "/admin/qc");
});

// ---------- Respondents (recruitment detail) ----------
router.get("/studies/:id/respondents", async (req, res) => {
  const studyId = toId(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  const respondents = await store.find("respondents", { study_id: studyId }, { sort: { id: -1 } });
  // GROUP BY respondent_id in one round trip. The keys are strings, exactly as
  // Object.fromEntries produced before, so the lookup below still works.
  const lockCountByRespondent = await store.countBy("respondent_credentials", "respondent_id");
  const withRisk = [];
  for (const r of respondents) {
    withRisk.push({
      ...r,
      risk: await classifyRisk(r.id),
      diaryUrl: respondentDiaryUrl(req, r.unique_token),
      hasLock: !!lockCountByRespondent[r.id],
    });
  }
  // Remote self-onboarding invite link (spec Flow B step 1). The code is
  // allocated lazily on first view so studies that never recruit remotely
  // never get one. remoteOpen reflects whether the link would actually work
  // right now -- an admin handing out a link for a draft or F2F-only study
  // would otherwise only find out when respondents hit a refusal page.
  const joinCode = await getOrCreateJoinCode(study.id);
  res.render("admin/study_respondents", {
    study,
    respondents: withRisk,
    tab: "respondents",
    joinCode,
    joinUrl: `${appBaseUrl(req)}/join/${joinCode}`,
    remoteOpen: remoteOnboardingOpen(study),
    accountsAllowed: accounts.accountsAllowedFor(study),
    activated: req.query.activated,
    invited: req.query.invited,
    inviteError: req.query.inviteError,
  });
});

// Invite someone onto this study. If an account already exists for that
// contact they're enrolled directly -- that's the whole point of accounts: a
// person on their third study shouldn't be re-registered from scratch, and
// their existing enrolments stay linked to the same identity.
//
// The enrolment starts un-activated with consent pending. Consent is legally
// per-study, recorded against that study's approved wording, so being on one
// study can never carry consent into another -- the invitee sees the consent
// screen for this study before their diary opens.
router.post("/studies/:id/respondents/invite", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  if (!study) return res.status(404).render("error", { message: "Study not found.", user: req.session.user });
  const contact = (req.body.contact || "").trim();
  const name = (req.body.name || "").trim();
  const back = (msg, ok) =>
    res.redirect(`/admin/studies/${study.id}/respondents?${ok ? "invited" : "inviteError"}=${encodeURIComponent(msg)}`);

  if (!contact) return back("Enter a phone number or email to invite.", false);

  const account = await accounts.findOrCreate({ contact, name });
  const existing = await accounts.enrolmentFor(account.id, study.id);
  if (existing) {
    return back(`${name || contact} is already on this study as ${existing.respondent_code}.`, false);
  }

  // Someone recruited face-to-face on this study may already be using the same
  // number without an account attached. Creating a second enrolment would split
  // their diary and read as a duplicate respondent in every report, so refuse
  // and point at the row that already exists -- the admin can link that row to
  // the account from the respondent's own page instead.
  // The lower(replace(...)) comparison is done in JS -- both sides are
  // normalised the same way and compared as strings, rather than putting a
  // contact the admin typed into a regex.
  const normalisedContact = account.contact.replace(/[\s\-()]/g, "").toLowerCase();
  const sameContact = (
    await store.find(
      "respondents",
      { study_id: study.id },
      { sort: { id: 1 }, projection: { respondent_code: 1, name: 1, contact: 1 } }
    )
  ).find((r) => r.contact != null && r.contact.replace(/[\s\-()]/g, "").toLowerCase() === normalisedContact);
  if (sameContact) {
    return back(
      `That contact is already on this study as ${sameContact.respondent_code}${
        sameContact.name ? ` (${sameContact.name})` : ""
      }. Open that respondent to link them to an account instead.`,
      false
    );
  }

  const token = uuidv4();
  const code = await nextRespondentCode(study.id);
  const { id } = await store.insert("respondents", {
    study_id: study.id,
    respondent_code: code,
    name: account.name || name || null,
    contact: account.contact,
    recruitment_mode: "remote",
    preferred_channel: "app",
    consent_status: "pending",
    activation_status: "invited",
    unique_token: token,
    is_practice: 0,
    account_id: account.id,
  });

  logAudit(req.session.user.email, "invite_respondent", "respondents", id, {
    study_id: study.id, account_id: account.id,
  });
  back(`${account.name || account.contact} invited as ${code}. They'll see this study next time they sign in.`, true);
});

// ---------- Respondent drill-down ----------
// Studies -> Respondents -> one respondent -> one diary entry. Before this,
// the chain stopped at the respondent list: the only way to see what someone
// actually answered was to export the study CSV and read it in a spreadsheet,
// or to open Media Review, which lists every file in the study rather than the
// entry it belongs to. All the data was already linked to the record -- this
// is the view onto it.
//
// Deliberately read-only for answers. The spec's QC design rule is that flags
// never delete respondent data: the original record is preserved, the reason
// is shown, and the decision is audited. Letting staff retype an answer would
// quietly break that guarantee, so review happens here and disposition happens
// on the QC Worklist.
async function loadRespondentOr404(req, res) {
  const respondent = await store.findOne("respondents", {
    id: toId(req.params.respondentId),
    study_id: toId(req.params.id),
  });
  if (!respondent) {
    res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
    return null;
  }
  return respondent;
}

router.get("/studies/:id/respondents/:respondentId", async (req, res) => {
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  const respondent = await loadRespondentOr404(req, res);
  if (!respondent) return;

  // Counts are joined in rather than queried per row so a respondent with a
  // few hundred entries doesn't fan out into hundreds of extra statements.
  // The correlated sub-selects become one query per collection over this
  // respondent's records, tallied in JS.
  const recordRows = await store.find("diary_records", { respondent_id: respondent.id }, { sort: { entry_time: -1 } });
  const recordIds = recordRows.map((r) => r.id);
  const answerCounts = await store.countBy("responses", "record_id", { record_id: { $in: recordIds } });
  const mediaForRecords = await store.find(
    "media",
    { record_id: { $in: recordIds } },
    { projection: { record_id: 1, media_type: 1 } }
  );
  const openFlagCounts = await store.countBy("qc_flags", "record_id", { record_id: { $in: recordIds }, status: "open" });
  const records = recordRows.map((dr) => {
    const mine = mediaForRecords.filter((m) => m.record_id === dr.id);
    return {
      ...dr,
      // countBy keys are strings; the id indexes them the same way it did the
      // Object.fromEntries maps this code used before.
      answer_count: answerCounts[dr.id] || 0,
      media_count: mine.length,
      photo_count: mine.filter((m) => m.media_type === "photo").length,
      video_count: mine.filter((m) => m.media_type === "video").length,
      audio_count: mine.filter((m) => m.media_type === "audio").length,
      open_flags: openFlagCounts[dr.id] || 0,
    };
  });

  // Respondent-level flags (recruitment holds, burst entry, cross-channel
  // duplicates) aren't tied to any one entry, so they'd be invisible on the
  // entry pages -- surface them here.
  const flags = await store.find("qc_flags", { respondent_id: respondent.id }, { sort: { created_time: -1 } });

  const hasLock = !!(await store.count("respondent_credentials", { respondent_id: respondent.id }));

  const interviewer = respondent.interviewer_id
    ? await store.findOne("users", { id: respondent.interviewer_id }, { projection: { name: 1, email: 1 } })
    : null;

  // The sign-in account behind this enrolment, if any, plus the other studies
  // it's on -- so "is this the same person we already have on Study B?" is
  // answerable here instead of by eye across two respondent lists.
  const account = await accounts.getById(respondent.account_id);
  const otherEnrolments = account
    ? (await accounts.enrolmentsFor(account.id)).filter((e) => e.id !== respondent.id)
    : [];
  // Offered when the row has no account yet: an account already registered to
  // this exact contact, which an admin can attach deliberately. Not attached
  // automatically -- see the header of lib/respondentAccounts.js.
  const linkCandidate =
    !account && respondent.contact ? await accounts.findByContact(respondent.contact) : null;

  const risk = await classifyRisk(respondent.id);

  res.render("admin/respondent_detail", {
    study,
    respondent,
    records,
    flags,
    hasLock,
    interviewer,
    account,
    otherEnrolments,
    linkCandidate,
    accountsAllowed: accounts.accountsAllowedFor(study),
    linked: req.query.linked,
    linkError: req.query.linkError,
    risk,
    respondentLink: respondentDiaryUrl(req, respondent.unique_token),
    messagingLive: messaging.isRealMessagingConfigured(),
    tab: "respondents",
  });
});

// Text a respondent their diary link. Same action the interviewer has in the
// field, for the case where someone loses their link after fieldwork has moved
// on and there's nobody standing in front of them with a QR code.
router.post("/studies/:id/respondents/:respondentId/send-link", async (req, res) => {
  const respondent = await loadRespondentOr404(req, res);
  if (!respondent) return;
  const study = await store.findOne("studies", { id: toId(req.params.id) });
  const back = (key, msg) =>
    res.redirect(`/admin/studies/${req.params.id}/respondents/${respondent.id}?${key}=${encodeURIComponent(msg)}`);

  if (!respondent.contact) return back("linkError", "This respondent has no phone number on file.");

  const result = await messaging.getProvider().send({
    respondentId: respondent.id,
    to: respondent.contact,
    template: "diary_link_invite",
    variables: {
      name: respondent.name,
      study: study.name,
      link: respondentDiaryUrl(req, respondent.unique_token),
    },
  });
  logAudit(req.session.user.email, "send_diary_link", "respondents", respondent.id, {
    to: respondent.contact, ok: !!result.ok,
  });

  if (!result.ok) return back("linkError", result.error || "The message could not be sent.");
  if (result.simulated) {
    return back(
      "linkError",
      `Messaging isn't connected yet, so nothing was delivered to ${respondent.contact} — the message was logged to the Message Log only.`
    );
  }
  back("linked", `Diary link sent to ${respondent.contact}.`);
});

// Attach an existing respondent row to a sign-in account, or detach it.
//
// Deliberately a manual admin action rather than something the app infers from
// a matching contact. Respondents recruited face-to-face had their contact
// typed in by an interviewer and never verified, and a household sharing one
// phone is an allowed case -- so "same number" is a prompt to a human, not
// proof of the same person. Both directions are audited.
router.post("/studies/:id/respondents/:respondentId/account", async (req, res) => {
  const respondent = await loadRespondentOr404(req, res);
  if (!respondent) return;
  const back = (msg, ok) =>
    res.redirect(
      `/admin/studies/${req.params.id}/respondents/${respondent.id}?${
        ok ? "linked" : "linkError"
      }=${encodeURIComponent(msg)}`
    );

  if (req.body.action === "unlink") {
    if (!respondent.account_id) return back("This respondent isn't linked to an account.", false);
    await store.update("respondents", { id: respondent.id }, { account_id: null });
    logAudit(req.session.user.email, "unlink_respondent_account", "respondents", respondent.id, {
      account_id: respondent.account_id,
    });
    return back("Account unlinked. Their diary link still works as before.", true);
  }

  if (respondent.account_id) return back("This respondent is already linked to an account.", false);
  const contact = (req.body.contact || respondent.contact || "").trim();
  if (!contact) return back("This respondent has no phone number or email on file.", false);

  const account = await accounts.findOrCreate({ contact, name: respondent.name });
  const clash = await accounts.enrolmentFor(account.id, respondent.study_id);
  if (clash) {
    return back(
      `That account is already on this study as ${clash.respondent_code}. Two enrolments on one study would split their diary.`,
      false
    );
  }
  await store.update("respondents", { id: respondent.id }, { account_id: account.id });
  logAudit(req.session.user.email, "link_respondent_account", "respondents", respondent.id, {
    account_id: account.id,
  });
  back(`Linked to the account for ${account.contact}. They'll see this study when they sign in.`, true);
});

router.get("/studies/:id/records/:recordId", async (req, res) => {
  const studyId = Number(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  const record = await store.findOne("diary_records", { id: Number(req.params.recordId), study_id: studyId });
  if (!record) return res.status(404).render("error", { message: "Diary entry not found.", user: req.session.user });
  const respondent = await store.findOne("respondents", { id: record.respondent_id });

  // LEFT JOIN from questions, not from responses: a question that was skipped
  // (or hidden by skip logic) has no response row, and showing the gap is the
  // point -- an entry that looks complete because the unanswered questions
  // simply aren't rendered is exactly the thing QC review needs to catch.
  // Inactive questions are still included when they carry an answer, so an
  // entry answered against an older questionnaire version still reads in full.
  // The LEFT JOIN is stitched in JS: every question for the study, with this
  // entry's answer attached where one exists. The WHERE clause is reproduced
  // exactly -- an inactive question is kept only when it actually carries an
  // answer, which is what lets an entry answered against an older
  // questionnaire version still read in full.
  const allQuestions = await store.find("questions", { study_id: study.id }, { sort: { order_index: 1, id: 1 } });
  const responseRows = await store.find("responses", { record_id: record.id });
  const answerByQuestion = new Map(responseRows.map((r) => [r.question_id, r]));
  const answers = allQuestions
    .map((q) => {
      const r = answerByQuestion.get(q.id);
      return {
        id: q.id, code: q.code, text: q.text, type: q.type, section: q.section,
        order_index: q.order_index, required: q.required, active: q.active,
        value: r ? r.value : null,
        study_version: r ? r.study_version : null,
        // Provenance. A video-mode entry is submitted with no respondent
        // review, so some answers here were written by the extractor, not
        // chosen by a person. Marking which is which is the whole reason the
        // fields exist -- an unverified machine guess must never read as
        // something the respondent said.
        response_id: r ? r.id : null,
        source: r ? (r.source || "respondent") : null,
        verified: r ? (r.verified === undefined ? 1 : r.verified) : null,
      };
    })
    .filter((a) => a.active === 1 || (a.value !== null && a.value !== undefined));

  const unverified = answers.filter((a) => a.source === "ai_video" && !a.verified);

  const media = await store.find("media", { record_id: record.id }, { sort: { id: 1 } });
  const flags = await store.find("qc_flags", { record_id: record.id }, { sort: { created_time: -1 } });

  // The version stamped on this entry's answers, which may be older than the
  // study's current version if the questionnaire has been republished since.
  const answeredVersion = (answers.find((a) => a.study_version) || {}).study_version || null;

  res.render("admin/record_detail", {
    study, record, respondent, answers, media, flags, answeredVersion,
    unverifiedCount: unverified.length,
    tab: "respondents",
  });
});

// Confirm or correct the answers a video review produced.
//
// Video mode ends at submit, so nobody checked these at the point of entry.
// Confirming here is what turns a machine's guess into an answer of record --
// and it is deliberately a per-question decision, because "the AI got four of
// six right" is the normal case and blanket-approving all six would put two
// wrong answers into the client's data.
router.post("/studies/:id/records/:recordId/verify", async (req, res) => {
  const studyId = Number(req.params.id);
  const record = await store.findOne("diary_records", { id: Number(req.params.recordId), study_id: studyId });
  if (!record) return res.status(404).render("error", { message: "Diary entry not found.", user: req.session.user });

  const rows = await store.find("responses", { record_id: record.id });
  const confirmed = [];
  const corrected = [];
  const rejected = [];

  for (const r of rows) {
    if ((r.source || "respondent") !== "ai_video" || r.verified) continue;
    const decision = req.body[`decision_${r.id}`];
    if (!decision) continue;

    if (decision === "reject") {
      // The AI was wrong and the reviewer has nothing to replace it with.
      // The row is removed rather than kept as a wrong answer -- a missing
      // answer is honest, an incorrect one is not.
      await store.remove("responses", { id: r.id });
      rejected.push(r.question_id);
    } else if (decision === "correct") {
      const value = req.body[`value_${r.id}`];
      await store.update("responses", { id: r.id }, {
        value: Array.isArray(value) ? value.join("|") : String(value || ""),
        source: "researcher",
        verified: 1,
      });
      corrected.push(r.question_id);
    } else {
      await store.update("responses", { id: r.id }, { verified: 1 });
      confirmed.push(r.question_id);
    }
  }

  // The flag closes only once nothing on this entry is still unverified.
  const stillOpen = (await store.find("responses", { record_id: record.id }))
    .filter((r) => (r.source || "respondent") === "ai_video" && !r.verified);
  if (!stillOpen.length) {
    const openFlags = await store.find("qc_flags", { record_id: record.id, flag_type: "ai_answers_unverified", status: "open" });
    for (const f of openFlags) {
      await store.update("qc_flags", { id: f.id }, { status: "resolved", resolved_time: store.nowSql() });
    }
  }

  logAudit(req.session.user.email, "verify_ai_answers", "diary_records", record.id, {
    confirmed: confirmed.length, corrected: corrected.length, rejected: rejected.length,
  });
  res.redirect(`/admin/studies/${studyId}/records/${record.id}`);
});

// Per-respondent and per-entry exports, alongside the existing study-level ones.
// One row per answer (long format) rather than one wide row per entry, because
// the questionnaire changes between versions and a wide export silently drops
// or misaligns columns when it does.
// One row per ANSWER rather than one wide row per entry, so a questionnaire
// that changes between versions can't silently misalign columns.
//
// The joins are stitched in JS. Key order in these objects IS the CSV column
// order (see toCsv), so it reproduces the old SELECT list exactly -- an export
// whose columns move is an export that breaks whatever the client built on it.
async function answerRowsForRecords(recordIds) {
  if (!recordIds.length) return [];
  const records = await store.find("diary_records", { id: { $in: recordIds } }, { sort: { id: 1 } });
  const respondents = await store.find("respondents", { id: { $in: [...new Set(records.map((r) => r.respondent_id))] } });
  const byRespondent = new Map(respondents.map((r) => [r.id, r]));
  const responses = await store.find("responses", { record_id: { $in: recordIds } });
  const questions = await store.find("questions", { id: { $in: [...new Set(responses.map((r) => r.question_id))] } });
  const byQuestion = new Map(questions.map((q) => [q.id, q]));

  const out = [];
  for (const dr of records) {
    const r = byRespondent.get(dr.respondent_id);
    if (!r) continue; // INNER JOIN on respondents: an orphaned entry is dropped
    const mine = responses
      .filter((resp) => resp.record_id === dr.id)
      .sort((a, b) => {
        const qa = byQuestion.get(a.question_id);
        const qb = byQuestion.get(b.question_id);
        return (qa ? qa.order_index : 0) - (qb ? qb.order_index : 0);
      });
    // LEFT JOIN: an entry with no responses at all still produces one row.
    const rows = mine.length ? mine : [null];
    for (const resp of rows) {
      const q = resp ? byQuestion.get(resp.question_id) : null;
      out.push({
        respondent_code: r.respondent_code,
        record_id: dr.id,
        period_label: dr.period_label,
        occurrence_time: dr.occurrence_time,
        entry_time: dr.entry_time,
        submit_time: dr.submit_time,
        status: dr.status,
        entry_mode: dr.entry_mode,
        is_practice: dr.is_practice,
        question_code: q ? q.code : null,
        question_text: q ? q.text : null,
        question_type: q ? q.type : null,
        section: q ? q.section : null,
        answer: resp ? resp.value : null,
        study_version: resp ? resp.study_version : null,
      });
    }
  }
  return out;
}

async function mediaRowsForRecords(recordIds) {
  if (!recordIds.length) return [];
  const rows = await store.find("media", { record_id: { $in: recordIds } }, { sort: { record_id: 1, id: 1 } });
  // Key order is the CSV column order -- kept identical to the old SELECT list.
  return rows.map((m) => ({
    record_id: m.record_id,
    media_type: m.media_type,
    file_path: m.file_path,
    upload_time: m.upload_time,
    detection_status: m.detection_status,
    detected_brand: m.detected_brand,
    transcript_status: m.transcript_status,
    transcript_text: m.transcript_text,
  }));
}

router.get("/studies/:id/respondents/:respondentId/export.csv", async (req, res) => {
  const respondent = await loadRespondentOr404(req, res);
  if (!respondent) return;
  const ids = (await store.find("diary_records", { respondent_id: respondent.id }, { sort: { id: 1 }, projection: { id: 1 } })).map((r) => r.id);
  const rows = await answerRowsForRecords(ids);
  logAudit(req.session.user.email, "export_respondent", "respondents", respondent.id, { rows: rows.length });
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", `attachment; filename=${respondent.respondent_code || "respondent"}_answers.csv`);
  res.send(toCsv(rows));
});

router.get("/studies/:id/respondents/:respondentId/media.csv", async (req, res) => {
  const respondent = await loadRespondentOr404(req, res);
  if (!respondent) return;
  const ids = (await store.find("diary_records", { respondent_id: respondent.id }, { sort: { id: 1 }, projection: { id: 1 } })).map((r) => r.id);
  const rows = await mediaRowsForRecords(ids);
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", `attachment; filename=${respondent.respondent_code || "respondent"}_media.csv`);
  res.send(toCsv(rows));
});

router.get("/studies/:id/records/:recordId/export.csv", async (req, res) => {
  const record = await store.findOne("diary_records", {
    id: Number(req.params.recordId),
    study_id: Number(req.params.id),
  });
  if (!record) return res.status(404).render("error", { message: "Diary entry not found.", user: req.session.user });
  const rows = await answerRowsForRecords([record.id]);
  logAudit(req.session.user.email, "export_record", "diary_records", record.id, { rows: rows.length });
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", `attachment; filename=entry_${record.id}_answers.csv`);
  res.send(toCsv(rows));
});

// Release a recruitment hold (see lib/qc.js applyRecruitmentHolds): a
// respondent registered with a duplicate contact or without recorded consent
// stays 'registered' and can't log entries until research has looked at the
// flag and activated them here. The flag itself is deliberately NOT
// auto-resolved -- the QC design rule is that flags stay visible and are
// dispositioned explicitly on the worklist, with the audit trail intact.
router.post("/studies/:id/respondents/:respondentId/activate", async (req, res) => {
  const respondent = await store.findOne("respondents", {
    id: Number(req.params.respondentId),
    study_id: Number(req.params.id),
  });
  if (!respondent) return res.status(404).render("error", { message: "Respondent not found.", user: req.session.user });
  await store.update("respondents", { id: respondent.id }, { activation_status: "activated" });
  logAudit(req.session.user.email, "release_recruitment_hold", "respondents", respondent.id, {
    respondent_code: respondent.respondent_code,
  });
  res.redirect(`/admin/studies/${req.params.id}/respondents?activated=${encodeURIComponent(respondent.respondent_code)}`);
});

// QR for the study's public remote sign-up link, so the invite can be printed
// on a flyer or shown on screen rather than typed out.
router.get("/studies/:id/join-qr.png", async (req, res) => {
  const study = await store.findOne("studies", { id: Number(req.params.id) });
  if (!study) return res.status(404).end();
  const code = await getOrCreateJoinCode(study.id);
  await qrPngToResponse(res, `${appBaseUrl(req)}/join/${code}`);
});

// On-demand QR PNG for one respondent's diary link -- generated only when a
// staff member actually opens it (rather than up front for every row), so a
// study with hundreds of respondents doesn't pay to render codes no one views.
router.get("/studies/:id/respondents/:respondentId/qr.png", async (req, res) => {
  const respondent = await store.findOne("respondents", {
    id: Number(req.params.respondentId),
    study_id: Number(req.params.id),
  });
  if (!respondent) return res.status(404).end();
  await qrPngToResponse(res, respondentDiaryUrl(req, respondent.unique_token));
});

// ---------- Reminders / WhatsApp ----------
router.post("/reminders/run", async (req, res) => {
  const result = await runReminderEngine();
  res.redirect(`/admin?ran=${result.created}`);
});

router.get("/whatsapp-outbox", async (req, res) => {
  const outbox = await store.find("whatsapp_outbox", {}, { sort: { created_at: -1 }, limit: 100 });
  // LEFT JOIN stitched in JS: a message whose respondent has since been
  // deleted still appears, with a blank code, exactly as before.
  const codeById = new Map(
    (await store.find("respondents", { id: { $in: [...new Set(outbox.map((m) => m.respondent_id))] } }))
      .map((r) => [r.id, r.respondent_code])
  );
  const messages = outbox.map((m) => ({ ...m, respondent_code: codeById.get(m.respondent_id) || null }));
  res.render("admin/whatsapp_outbox", {
    messages,
    isReal: messaging.isRealMessagingConfigured(),
    configError: messaging.messagingConfigError(),
    providerName: messaging.providerName(),
  });
});

// ---------- Media review / brand detection ----------
router.get("/studies/:id/media", async (req, res) => {
  const studyId = Number(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  // Two INNER JOINs, stitched in JS. Media whose entry or respondent has gone
  // is dropped rather than shown with blanks, matching the old query.
  const records = await store.find("diary_records", { study_id: studyId });
  const recordById = new Map(records.map((r) => [r.id, r]));
  const codeById = new Map(
    (await store.find("respondents", { id: { $in: [...new Set(records.map((r) => r.respondent_id))] } }))
      .map((r) => [r.id, r.respondent_code])
  );
  const items = (await store.find("media", { record_id: { $in: records.map((r) => r.id) } }, { sort: { upload_time: -1 } }))
    .map((m) => {
      const rec = recordById.get(m.record_id);
      if (!rec) return null;
      const code = codeById.get(rec.respondent_id);
      if (code === undefined) return null;
      return { ...m, respondent_code: code, period_label: rec.period_label };
    })
    .filter(Boolean);
  res.render("admin/study_media", { study, items, tab: "media" });
});

router.post("/media/:id/detect", async (req, res) => {
  const media = await store.findOne("media", { id: Number(req.params.id) });
  if (!media) return res.status(404).render("error", { message: "Media item not found.", user: req.session.user });
  const record = await store.findOne("diary_records", { id: media.record_id });
  const brands = await store.find("brands", { study_id: record.study_id, active: 1 }, { sort: { id: 1 } });
  try {
    const provider = getBrandDetectionProvider();
    await provider.detect(media, brands);
    logAudit(req.session.user.email, "brand_detection_run", "media", media.id, {});
  } catch (e) {
    await store.update("media", { id: media.id }, {
      detection_status: "error",
      detection_raw_json: JSON.stringify({ error: e.message }),
    });
  }
  res.redirect(req.get("Referrer") || `/admin/studies/${record.study_id}/media`);
});

router.post("/media/:id/transcribe", async (req, res) => {
  const media = await store.findOne("media", { id: Number(req.params.id) });
  if (!media) return res.status(404).render("error", { message: "Media item not found.", user: req.session.user });
  const record = await store.findOne("diary_records", { id: media.record_id });
  try {
    const provider = getAudioTranscriptionProvider();
    await provider.transcribe(media);
    logAudit(req.session.user.email, "audio_transcription_run", "media", media.id, {});
  } catch (e) {
    await store.update("media", { id: media.id }, {
      transcript_status: "error",
      transcript_raw_json: JSON.stringify({ error: e.message }),
    });
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

router.get("/export/respondents.csv", async (req, res) => {
  const { study } = await getStudyOrFirst(req);
  const rows = await store.find("respondents", { study_id: study.id }, { sort: { id: 1 } });
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=respondents.csv");
  res.send(toCsv(rows));
});

router.get("/export/diary.csv", async (req, res) => {
  const { study } = await getStudyOrFirst(req);
  const records = await store.find("diary_records", { study_id: study.id }, { sort: { id: 1 } });
  const codeById = new Map(
    (await store.find("respondents", { id: { $in: [...new Set(records.map((r) => r.respondent_id))] } }))
      .map((r) => [r.id, r.respondent_code])
  );
  // Key order is the CSV column order -- identical to the old SELECT list.
  const rows = records
    .filter((dr) => codeById.has(dr.respondent_id)) // INNER JOIN semantics
    .map((dr) => ({
      id: dr.id,
      respondent_id: dr.respondent_id,
      respondent_code: codeById.get(dr.respondent_id),
      period_label: dr.period_label,
      occurrence_time: dr.occurrence_time,
      entry_time: dr.entry_time,
      submit_time: dr.submit_time,
      channel: dr.channel,
      status: dr.status,
      terminate_note: dr.terminate_note,
      is_practice: dr.is_practice,
    }));
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=diary_records.csv");
  res.send(toCsv(rows));
});

router.get("/export/qc.csv", async (req, res) => {
  const { study } = await getStudyOrFirst(req);
  const respondentIds = (await store.find("respondents", { study_id: study.id }, { projection: { id: 1 } })).map((r) => r.id);
  const rows = await store.find("qc_flags", { respondent_id: { $in: respondentIds } }, { sort: { id: 1 } });
  res.set("Content-Type", "text/csv");
  res.set("Content-Disposition", "attachment; filename=qc_flags.csv");
  res.send(toCsv(rows));
});

module.exports = router;
