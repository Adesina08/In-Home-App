const express = require("express");
const store = require("../lib/store");
const { requireRole } = require("../lib/auth");
const { logAudit } = require("../lib/audit");

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

  if (recordIds.length) {
    await removeWhere("responses", { record_id: { $in: recordIds } });
    await removeWhere("media", { record_id: { $in: recordIds } });
    await removeWhere("qc_flags", { record_id: { $in: recordIds } });
  }

  await removeWhere("qc_flags", { respondent_id: respondentId });
  await removeWhere("reminders", { respondent_id: respondentId });
  await removeWhere("whatsapp_outbox", { respondent_id: respondentId });
  await removeWhere("whatsapp_sessions", { respondent_id: respondentId });
  await removeWhere("respondent_credentials", { respondent_id: respondentId });
  await removeWhere("push_subscriptions", { respondent_id: respondentId });
  await removeWhere("respondent_profile_snapshots", { respondent_id: respondentId });
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
      await removeWhere("respondent_accounts", { id: respondent.account_id });
    }
  }

  return respondent;
}

router.get("/superadmin", onlySuperadmin, async (req, res) => {
  const studies = await store.find("studies", {}, { sort: { id: 1 } });
  const requestedStudyId = req.query.study ? toId(req.query.study) : null;
  const selectedStudy =
    studies.find((s) => s.id === requestedStudyId) || studies[0] || null;

  const studyCards = [];
  for (const study of studies) {
    studyCards.push({
      ...study,
      respondent_count: await store.count("respondents", { study_id: study.id }),
      record_count: await store.count("diary_records", { study_id: study.id }),
    });
  }

  const respondents = selectedStudy
    ? await store.find(
        "respondents",
        { study_id: selectedStudy.id },
        { sort: { id: 1 } }
      )
    : [];

  res.render("admin/superadmin", {
    studies: studyCards,
    selectedStudy,
    respondents,
    deleted: req.query.deleted || null,
  });
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
