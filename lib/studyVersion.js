// Study version publishing (spec 3.1: "Publish a study version; retain the
// version used on every submitted diary record").
//
// `studies.version` was always stamped onto every saved response, but nothing
// ever incremented it -- so editing a live questionnaire silently changed what
// "version 1" meant, and two responses both labelled v1 could have been
// answering different wording. That makes the stamp actively misleading rather
// than merely unused, which matters as soon as anyone analyses the data.
//
// The model here is deliberately simple: any questionnaire edit marks the
// study dirty, and an admin explicitly publishes a new version when they're
// happy with it. Responses keep stamping whatever version is current, so
// entries collected before a publish stay attributed to the version that was
// actually on screen when they were answered.
const db = require("./db");
const { logAudit } = require("./audit");

/** Flag that the questionnaire has changed since the last published version. */
function markQuestionnaireDirty(studyId) {
  if (!studyId) return;
  db.prepare("UPDATE studies SET questionnaire_dirty = 1 WHERE id = ?").run(studyId);
}

/**
 * Publish the next version. Returns the new version number, or null if there
 * was nothing to publish (no unpublished changes).
 */
function publishVersion(studyId, actorEmail) {
  const study = db.prepare("SELECT id, version, questionnaire_dirty FROM studies WHERE id = ?").get(studyId);
  if (!study) return null;
  if (!study.questionnaire_dirty) return null;

  const next = (study.version || 1) + 1;
  db.prepare(
    "UPDATE studies SET version = ?, version_published_at = datetime('now'), questionnaire_dirty = 0 WHERE id = ?"
  ).run(next, studyId);
  logAudit(actorEmail || "system", "publish_study_version", "studies", studyId, {
    from_version: study.version || 1,
    to_version: next,
  });
  return next;
}

module.exports = { markQuestionnaireDirty, publishVersion };
