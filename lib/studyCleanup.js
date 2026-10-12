// Removing a study's data, shared by the superadmin study/respondent deletes
// (routes/superadmin.js) and the sample-study reset (lib/sampleStudies.js).
const store = require("./store");

async function removeWhere(collection, filter) {
  try {
    return await store.remove(collection, filter);
  } catch (e) {
    // A newer/older pilot database may not have every optional collection yet.
    // Do not leave the primary respondent/study undeletable because an optional
    // supporting collection is absent.
    console.warn(`Cleanup skipped ${collection}:`, e.message);
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
  for (const media of stagedMedia) await require("./mediaStorage").deleteMedia(media.file_path);
  await removeWhere("staged_media", { respondent_id: respondentId });

  if (recordIds.length) {
    const mediaRows = await store.find("media", { record_id: { $in: recordIds } });
    // Sample-study illustrations ship with the app (public/sample-media) and
    // are shared by every copy, so they are never deleted from disk.
    for (const media of mediaRows) if (!isSampleMedia(media.file_path)) await require("./mediaStorage").deleteMedia(media.file_path);
    await removeWhere("responses", { record_id: { $in: recordIds } });
    await removeWhere("media", { record_id: { $in: recordIds } });
    await removeWhere("qc_flags", { record_id: { $in: recordIds } });
    await removeWhere("coded_verbatims", { record_id: { $in: recordIds } });
  }

  await removeWhere("qc_flags", { respondent_id: respondentId });
  await removeWhere("reminders", { respondent_id: respondentId });
  await removeWhere("whatsapp_outbox", { respondent_id: respondentId });
  await removeWhere("whatsapp_sessions", { respondent_id: respondentId });
  await removeWhere("whatsapp_inbound_messages", { respondent_id: respondentId });
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
      if (profile && profile.photo_path) await require("./mediaStorage").deleteMedia(profile.photo_path);
      await removeWhere("respondent_profiles", { account_id: respondent.account_id });
      await removeWhere("respondent_accounts", { id: respondent.account_id });
    }
  } else if (respondent.profile_id) {
    const profile = await store.findOne("respondent_profiles", { id: respondent.profile_id });
    if (profile && profile.photo_path) await require("./mediaStorage").deleteMedia(profile.photo_path);
    await removeWhere("respondent_profiles", { id: respondent.profile_id });
  }

  return respondent;
}

/**
 * Everything that belongs to a study -- respondents and their entries, the
 * questionnaire, consent, KPIs, reporting -- leaving the study row itself.
 * `keepAccess` leaves client grants and interviewer assignments in place.
 * Returns how many respondents were removed.
 */
async function clearStudyContents(studyId, { keepAccess = false } = {}) {
  const respondents = await store.find("respondents", { study_id: studyId }, { projection: { id: 1 } });
  for (const respondent of respondents) await deleteRespondentCascade(respondent.id);

  for (const collection of ["skip_rules", "questions", "question_imports", "questionnaire_versions", "brands", "consent_versions", "kpi_config", "kpi_mappings", "ai_summaries"]) {
    await removeWhere(collection, { study_id: studyId });
  }
  try { await require("./videoSummary").removeVideoSummaries({ study_id: studyId }); }
  catch (e) { console.warn("Study cleanup skipped video_summaries:", e.message); }
  await removeWhere("respondent_profile_snapshots", { study_id: studyId });
  const access = keepAccess ? [] : ["interviewer_assignments", "client_grants"];
  for (const collection of [...access, "fieldwork_visits", "backchecks", "incentive_rules", "incentive_ledger", "report_snapshots", "report_schedules", "research_alerts", "research_audit", "theme_codes", "coded_verbatims", "privacy_requests", "follow_up_log", "end_validations"]) {
    await removeWhere(collection, { study_id: studyId });
  }
  return respondents.length;
}

const SAMPLE_MEDIA_PREFIX = "/public/sample-media/";
function isSampleMedia(filePath) {
  return String(filePath || "").startsWith(SAMPLE_MEDIA_PREFIX);
}

module.exports = { removeWhere, deleteRespondentCascade, clearStudyContents, isSampleMedia, SAMPLE_MEDIA_PREFIX };
