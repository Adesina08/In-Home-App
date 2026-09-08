const express = require("express");
const store = require("../lib/store");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");
const { getSchedulerIntervalMinutes, setSchedulerIntervalMinutes, MIN_MINUTES, MAX_MINUTES } = require("../lib/systemSettings");

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

async function removeWhere(collection, filter) {
  try {
    return await store.remove(collection, filter);
  } catch (e) {
    // A newer/older pilot database may not have every optional collection yet.
    // Do not leave the primary respondent/study undeletable because an optional
    // supporting collection is absent.
    console.warn(`Superadmin cleanup skipped ${collection}:`, e.message);
    return { changes: 0 };
  }
}

async function deleteRespondentCascade(respondentId) {
  const respondent = await store.findOne("respondents", { id: respondentId });
  if (!respondent) return null;

  const records = await store.find(
    "diary_records",
    { respondent_id: respondentId },
    { projection: { id: 1 } }
  );
  const recordIds = records.map((r) => r.id);
  const stagedMedia = await store.find("staged_media", { respondent_id: respondentId });
  for (const media of stagedMedia) await require("../lib/mediaStorage").deleteMedia(media.file_path);
  await removeWhere("staged_media", { respondent_id: respondentId });

  if (recordIds.length) {
    const mediaRows = await store.find("media", { record_id: { $in: recordIds } });
    for (const media of mediaRows) await require("../lib/mediaStorage").deleteMedia(media.file_path);
    await removeWhere("responses", { record_id: { $in: recordIds } });
    await removeWhere("media", { record_id: { $in: recordIds } });
    await removeWhere("qc_flags", { record_id: { $in: recordIds } });
    await removeWhere("coded_verbatims", { record_id: { $in: recordIds } });
  }

  await removeWhere("qc_flags", { respondent_id: respondentId });
  await removeWhere("reminders", { respondent_id: respondentId });
  await removeWhere("whatsapp_outbox", { respondent_id: respondentId });
  await removeWhere("whatsapp_sessions", { respondent_id: respondentId });
  await removeWhere("respondent_credentials", { respondent_id: respondentId });
  await removeWhere("otp_codes", { respondent_id: respondentId });
  await removeWhere("push_subscriptions", { respondent_id: respondentId });
  await removeWhere("respondent_profile_snapshots", { respondent_id: respondentId });
  await removeWhere("end_validations", { respondent_id: respondentId });
  await removeWhere("follow_up_log", { respondent_id: respondentId });
  await removeWhere("incentive_ledger", { respondent_id: respondentId });
  await removeWhere("backchecks", { respondent_id: respondentId });
  await removeWhere("privacy_requests", { respondent_id: respondentId });
  await removeWhere("diary_submissions", { respondent_id: respondentId });
  await removeWhere("mobile_sessions", { respondent_id: respondentId });
  await removeWhere("diary_records", { respondent_id: respondentId });
  await removeWhere("respondents", { id: respondentId });

  // The account represents a person across studies. Delete it only when this
  // was their final enrolment; otherwise the same account must continue to work
  // for their remaining studies.
  if (respondent.account_id) {
    const remaining = await store.count("respondents", { account_id: respondent.account_id });
    if (!remaining) {
      await removeWhere("mobile_sessions", { account_id: respondent.account_id });
      const profile = await store.findOne("respondent_profiles", { account_id: respondent.account_id });
      if (profile && profile.photo_path) await require("../lib/mediaStorage").deleteMedia(profile.photo_path);
      await removeWhere("respondent_profiles", { account_id: respondent.account_id });
      await removeWhere("respondent_accounts", { id: respondent.account_id });
    }
  } else if (respondent.profile_id) {
    const profile = await store.findOne("respondent_profiles", { id: respondent.profile_id });
    if (profile && profile.photo_path) await require("../lib/mediaStorage").deleteMedia(profile.photo_path);
    await removeWhere("respondent_profiles", { id: respondent.profile_id });
  }

  return respondent;
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

  const respondents = await store.find(
    "respondents",
    { study_id: studyId },
    { projection: { id: 1 } }
  );
  for (const respondent of respondents) {
    await deleteRespondentCascade(respondent.id);
  }

  await removeWhere("skip_rules", { study_id: studyId });
  await removeWhere("questions", { study_id: studyId });
  await removeWhere("question_imports", { study_id: studyId });
  await removeWhere("brands", { study_id: studyId });
  await removeWhere("consent_versions", { study_id: studyId });
  await removeWhere("kpi_config", { study_id: studyId });
  await removeWhere("ai_summaries", { study_id: studyId });
  await removeWhere("respondent_profile_snapshots", { study_id: studyId });
  for (const collection of ["interviewer_assignments", "fieldwork_visits", "backchecks", "incentive_rules", "incentive_ledger", "client_grants", "report_snapshots", "report_schedules", "research_alerts", "research_audit", "theme_codes", "coded_verbatims", "privacy_requests", "follow_up_log", "end_validations"]) {
    await removeWhere(collection, { study_id: studyId });
  }

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
      respondents_deleted: respondents.length,
      permanent: true,
    }
  );

  res.redirect("/admin/superadmin?deleted=study");
});

module.exports = router;
