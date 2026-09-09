// Study version publishing (spec 3.1: "Publish a study version; retain the
// version used on every submitted diary record").
//
// The questionnaire builder edits the working questions/skip_rules collections
// as a draft. lib/questionnaireVersions.js stores immutable published snapshots
// and respondent-facing loaders read the snapshot matching studies.version.
// That means editing v2 can no longer rewrite what a v1 response actually saw.
const store = require("./store");
const { logAudit } = require("./audit");
const versions = require("./questionnaireVersions");

/** Flag that the questionnaire has changed since the last published version. */
async function markQuestionnaireDirty(studyId) {
  if (!studyId) return;
  await store.update("studies", { id: studyId }, { questionnaire_dirty: 1 });
}

/**
 * Publish the current draft as the next immutable version. Returns the new
 * version number, or null if there is genuinely nothing new to publish.
 */
async function publishVersion(studyId, actorEmail) {
  const study = await store.findOne("studies", { id: studyId });
  if (!study) return null;

  const currentVersion = Number(study.version) || 1;
  const actor = actorEmail || "system";

  // Existing production data predates snapshots. Ensure the current numbered
  // version has a baseline before advancing it, so publishing v2 can never
  // overwrite the stored v1 instrument.
  const currentSnapshot = await versions.ensureSnapshot(studyId, currentVersion, {
    actor: "system",
    source: "pre_publish_baseline",
  });
  const draft = await versions.draftPayload(studyId);
  if (!draft) return null;

  // The dirty flag drives the UI, but compare content too. This closes the tiny
  // race between an AJAX edit response finishing and its finish-handler setting
  // questionnaire_dirty, and also catches edits from any future code path that
  // forgets to set the flag.
  const draftHash = versions.contentHash(draft);
  const contentChanged = !currentSnapshot || currentSnapshot.content_hash !== draftHash;
  if (!study.questionnaire_dirty && !contentChanged) return null;

  const next = currentVersion + 1;
  const nextSnapshot = await versions.writeFutureSnapshot(study, next, draft, actor);
  await store.update("studies", { id: studyId }, {
    version: next,
    version_published_at: nextSnapshot ? nextSnapshot.published_at : store.nowSql(),
    questionnaire_dirty: 0,
  });
  logAudit(actor, "publish_study_version", "studies", studyId, {
    from_version: currentVersion,
    to_version: next,
    snapshot_id: nextSnapshot ? nextSnapshot.id : null,
    content_hash: draftHash,
  });
  return next;
}

module.exports = { markQuestionnaireDirty, publishVersion };
