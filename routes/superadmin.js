const express = require("express");
const store = require("../lib/store");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { getSchedulerIntervalMinutes, setSchedulerIntervalMinutes, MIN_MINUTES, MAX_MINUTES } = require("../lib/systemSettings");
const { deleteRespondentCascade, clearStudyContents, removeWhere } = require("../lib/studyCleanup");

const router = express.Router();

// Guard each route individually, NOT with router.use(requireRole(...)).
//
// This router is mounted at /admin ahead of routes/admin.js so its three paths
// win. But a path-less router.use() runs for every request that *enters* the
// router -- which is every /admin/* request -- and requireRole renders 403
// instead of calling next(). A router-level guard here therefore 403s an Admin
// on the whole admin section before routes/admin.js is ever reached.
const onlySuperadmin = requireRole("superadmin");

function toId(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : value;
}

// Platform-wide operational settings -- currently just the scheduler
// interval, previously only reachable via an Azure App Service environment
// variable. Superadmin-only: this is one setting for the whole platform, not
// a per-study one, so it does not belong on an individual study's Settings
// page and it is not something an ordinary Admin should be able to change
// (an interval set too low on a busy platform is a real load concern).
router.get("/system-settings", onlySuperadmin, async (req, res) => {
  const currentMinutes = await getSchedulerIntervalMinutes();
  res.render("admin/system_settings", {
    currentMinutes,
    minMinutes: MIN_MINUTES,
    maxMinutes: MAX_MINUTES,
    saved: req.query.saved,
  });
});

router.post("/system-settings", onlySuperadmin, async (req, res) => {
  const applied = await setSchedulerIntervalMinutes(req.body.scheduler_interval_minutes, req.session.user.email);
  logAudit(req.session.user.email, "update_system_settings", "system_settings", null, {
    scheduler_interval_minutes: applied,
  });
  // Takes effect on the scheduler's next cycle automatically (lib/scheduler.js
  // re-reads this value before every run) -- no restart needed.
  res.redirect("/admin/system-settings?saved=1");
});

router.get("/superadmin", onlySuperadmin, async (req, res) => {
  const studies = await store.find("studies", {}, { sort: { id: 1 } });
  const requestedStudyId = req.query.study ? toId(req.query.study) : null;
  const selectedStudy =
    studies.find((s) => s.id === requestedStudyId) || studies[0] || null;

  const [respondentCounts, recordCounts, submittedCounts, respondentStudyRows, openFlags] = await Promise.all([
    store.countBy("respondents", "study_id", {}),
    store.countBy("diary_records", "study_id", {}),
    store.countBy("diary_records", "study_id", { status: "submitted" }),
    store.find("respondents", {}, { projection: { id: 1, study_id: 1 } }),
    store.find("qc_flags", { status: "open" }, { projection: { respondent_id: 1 } }),
  ]);
  const studyByRespondent = new Map(respondentStudyRows.map(r => [r.id, r.study_id]));
  const flagsByStudy = new Map();
  for (const flag of openFlags) {
    const id = studyByRespondent.get(flag.respondent_id);
    if (id !== undefined) flagsByStudy.set(id, (flagsByStudy.get(id) || 0) + 1);
  }
  const studyCards = studies.map(study => ({
    ...study,
    respondent_count: respondentCounts[study.id] || 0,
    record_count: recordCounts[study.id] || 0,
    submitted_count: submittedCounts[study.id] || 0,
    open_flag_count: flagsByStudy.get(study.id) || 0,
  }));

  const respondents = selectedStudy
    ? await store.find(
        "respondents",
        { study_id: selectedStudy.id },
        { sort: { id: 1 } }
      )
    : [];

  // Platform-wide totals for the header cards in the comps.
  const platform = {
    studies: await store.count("studies", {}),
    respondents: await store.count("respondents", {}),
    records: await store.count("diary_records", { status: "submitted" }),
    openFlags: await store.count("qc_flags", { status: "open" }),
  };
  res.render("admin/superadmin", {
    studies: studyCards,
    selectedStudy,
    respondents,
    platform,
    deleted: req.query.deleted || null,
  });
});

router.get("/data-management", onlySuperadmin, async (req, res) => {
  const studies = await store.find("studies", {}, { sort: { name: 1 } });
  const study = studies.find((item) => String(item.id) === String(req.query.study)) || studies[0] || null;
  const status = String(req.query.status || "");
  const search = String(req.query.search || "").trim().toLowerCase();
  let respondents = study ? await store.find("respondents", { study_id: study.id }, { sort: { id: 1 } }) : [];
  if (status) respondents = respondents.filter((item) => item.activation_status === status);
  if (search) respondents = respondents.filter((item) => [item.name, item.contact, item.respondent_code].some((value) => String(value || "").toLowerCase().includes(search)));
  const retention = study ? await require("../lib/researchPrivacy").retentionCandidates(study) : [];
  const audit = study ? await store.find("research_audit", { study_id: study.id }, { sort: { created_at: -1 }, limit: 30 }) : [];
  res.render("admin/data_management", { studies, study, respondents, retention, audit, status, search, result: req.query.result || "" });
});

router.post("/data-management/respondents/delete", onlySuperadmin, async (req, res) => {
  const studyId = toId(req.body.study_id);
  const ids = [...new Set([].concat(req.body.respondent_ids || []).map(toId))];
  if (String(req.body.confirm || "").trim().toUpperCase() !== "DELETE" || !ids.length) return res.status(400).render("error", { message: "Select respondents and type DELETE to confirm.", user: req.session.user });
  const rows = await store.find("respondents", { id: { $in: ids }, study_id: studyId });
  if (rows.length !== ids.length) return res.status(400).render("error", { message: "The selection changed or includes respondents outside this study. Refresh and select again.", user: req.session.user });
  const deleted = [], failed = [];
  for (const row of rows) {
    try { await deleteRespondentCascade(row.id); deleted.push(row.id); logAudit(req.session.user.email, "superadmin_delete_respondent", "respondents", row.id, { study_id: studyId, respondent_code: row.respondent_code, batch: true, permanent: true }); }
    catch (error) { failed.push({ id: row.id, error: error.message }); }
  }
  logAudit(req.session.user.email, "superadmin_bulk_delete_respondents", "studies", studyId, { requested: ids.length, deleted, failed });
  res.redirect(`/admin/data-management?study=${encodeURIComponent(studyId)}&result=${encodeURIComponent(`${deleted.length} deleted${failed.length ? `, ${failed.length} failed` : ""}`)}`);
});

router.post("/data-management/respondents/:id/withdraw", onlySuperadmin, async (req, res) => {
  const respondent = await store.findOne("respondents", { id: toId(req.params.id) });
  if (!respondent) return res.sendStatus(404);
  await require("../lib/researchPrivacy").withdraw(respondent, req.session.user.email);
  res.redirect(`/admin/data-management?study=${encodeURIComponent(respondent.study_id)}&result=Withdrawal%20recorded`);
});

router.post("/data-management/respondents/:id/erase", onlySuperadmin, async (req, res) => {
  const respondent = await store.findOne("respondents", { id: toId(req.params.id) });
  const study = respondent && await store.findOne("studies", { id: respondent.study_id });
  if (!respondent || !study || req.body.confirm !== respondent.respondent_code) return res.status(400).render("error", { message: "Enter the exact respondent code to erase due participation.", user: req.session.user });
  await require("../lib/researchPrivacy").eraseStudyParticipation(study, respondent, req.session.user.email);
  res.redirect(`/admin/data-management?study=${encodeURIComponent(study.id)}&result=Retention%20deletion%20completed`);
});

router.post("/superadmin/respondents/:id/delete", onlySuperadmin, async (req, res) => {
  if (String(req.body.confirm || "").trim().toUpperCase() !== "DELETE") {
    return res.status(400).render("error", {
      message: "Deletion cancelled. Type DELETE to permanently remove a respondent.",
      user: req.session.user,
    });
  }

  const respondentId = toId(req.params.id);
  const respondent = await store.findOne("respondents", { id: respondentId });
  if (!respondent) {
    return res.status(404).render("error", {
      message: "Respondent not found.",
      user: req.session.user,
    });
  }

  const studyId = respondent.study_id;
  const deleted = await deleteRespondentCascade(respondentId);
  logAudit(
    req.session.user.email,
    "superadmin_delete_respondent",
    "respondents",
    respondentId,
    {
      respondent_code: deleted.respondent_code,
      study_id: studyId,
      permanent: true,
    }
  );

  res.redirect(`/admin/superadmin?study=${encodeURIComponent(studyId)}&deleted=respondent`);
});

router.post("/superadmin/studies/:id/delete", onlySuperadmin, async (req, res) => {
  if (String(req.body.confirm || "").trim().toUpperCase() !== "DELETE") {
    return res.status(400).render("error", {
      message: "Deletion cancelled. Type DELETE to permanently remove a study.",
      user: req.session.user,
    });
  }

  const studyId = toId(req.params.id);
  const study = await store.findOne("studies", { id: studyId });
  if (!study) {
    return res.status(404).render("error", {
      message: "Study not found.",
      user: req.session.user,
    });
  }

  const respondentsDeleted = await clearStudyContents(studyId);

  // Preserve staff/client accounts but detach them from a project that no
  // longer exists.
  await store.update("users", { study_id: studyId }, { study_id: null });
  await removeWhere("studies", { id: studyId });

  logAudit(
    req.session.user.email,
    "superadmin_delete_study",
    "studies",
    studyId,
    {
      study_name: study.name,
      respondents_deleted: respondentsDeleted,
      permanent: true,
    }
  );

  res.redirect("/admin/superadmin?deleted=study");
});

// Exposed so scripts/purge-respondents.js can reuse the same tested cascade
// (media blobs, accounts/profiles, every dependent collection) instead of
// re-deriving it.
router.deleteRespondentCascade = deleteRespondentCascade;

module.exports = router;
