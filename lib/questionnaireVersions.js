const crypto = require("crypto");
const store = require("./store");

// Immutable questionnaire snapshots. The builder keeps editing the normal
// questions/skip_rules collections as a draft; respondents read one of these
// snapshots, keyed by studies.version. That separation is what makes a version
// number mean something: v1 stays the exact instrument v1 respondents saw even
// while an admin is preparing v2.

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== "object") return value;
  return Object.keys(value)
    .filter((key) => key !== "_id")
    .sort()
    .reduce((out, key) => {
      out[key] = stable(value[key]);
      return out;
    }, {});
}

function contentHash(payload) {
  return crypto.createHash("sha256").update(JSON.stringify(stable(payload))).digest("hex");
}

function sortQuestions(a, b) {
  const ao = Number(a.order_index) || 0;
  const bo = Number(b.order_index) || 0;
  return ao - bo || (Number(a.id) || 0) - (Number(b.id) || 0);
}

function sortRules(a, b) {
  return (Number(a.id) || 0) - (Number(b.id) || 0);
}

async function draftPayload(studyId) {
  const [study, questions, rules] = await Promise.all([
    store.findOne("studies", { id: studyId }),
    store.find("questions", { study_id: studyId }),
    store.find("skip_rules", { study_id: studyId }),
  ]);
  if (!study) return null;
  return {
    questions: questions.slice().sort(sortQuestions),
    rules: rules.slice().sort(sortRules),
    // diary_mode changes which cadence-scoped questions are delivered, so it
    // is part of the published instrument rather than silently borrowed from
    // whatever the study happens to be configured as months later.
    study_config: { diary_mode: study.diary_mode || null },
  };
}

async function getSnapshot(studyId, version) {
  return store.findOne("questionnaire_versions", { study_id: studyId, version: Number(version) || 1 });
}

/**
 * Store one immutable version. If a snapshot already exists it wins: once a
 * version has been exposed to respondents, later draft edits must never mutate
 * that historical record.
 */
async function ensureSnapshot(studyId, version, { actor = "system", source = "legacy_bootstrap", payload = null } = {}) {
  const v = Number(version) || 1;
  const existing = await getSnapshot(studyId, v);
  if (existing) return existing;

  const body = payload || await draftPayload(studyId);
  if (!body) return null;
  const publishedAt = store.nowSql();
  const { id } = await store.insert("questionnaire_versions", {
    study_id: studyId,
    version: v,
    questions: body.questions,
    rules: body.rules,
    study_config: body.study_config || {},
    content_hash: contentHash(body),
    published_at: publishedAt,
    published_by: actor || "system",
    source,
  });
  return store.findOne("questionnaire_versions", { id });
}

/**
 * Used for the NEXT version during publish. A failed publish can leave a future
 * snapshot behind before studies.version is advanced. That snapshot has never
 * been live, so it is safe to refresh it with the latest draft on retry.
 */
async function writeFutureSnapshot(study, version, payload, actor) {
  const v = Number(version);
  const data = {
    questions: payload.questions,
    rules: payload.rules,
    study_config: payload.study_config || {},
    content_hash: contentHash(payload),
    published_at: store.nowSql(),
    published_by: actor || "system",
    source: "publish",
  };
  const existing = await getSnapshot(study.id, v);
  if (existing) {
    // If the study is already at/after this version, it is historical and must
    // not be touched. This branch is only for an orphan from a previously
    // interrupted publish attempt.
    if ((Number(study.version) || 1) < v) {
      await store.update("questionnaire_versions", { id: existing.id }, data);
      return store.findOne("questionnaire_versions", { id: existing.id });
    }
    return existing;
  }
  const { id } = await store.insert("questionnaire_versions", {
    study_id: study.id,
    version: v,
    ...data,
  });
  return store.findOne("questionnaire_versions", { id });
}

/**
 * Production had version numbers before immutable snapshots existed. Seed the
 * currently recorded version once at startup so the deployment establishes a
 * hard historical boundary before any new edits are made. The source field is
 * deliberately explicit: it is a legacy baseline, not a claim that we can
 * reconstruct questionnaire wording that was already overwritten in the old
 * mutable model.
 */
async function bootstrapPublishedSnapshots() {
  const studies = await store.find("studies", {}, { sort: { id: 1 } });
  let created = 0;
  for (const study of studies) {
    const version = Number(study.version) || 1;
    if (await getSnapshot(study.id, version)) continue;
    const snapshot = await ensureSnapshot(study.id, version, {
      actor: "system",
      source: "legacy_bootstrap",
    });
    if (snapshot) created++;
  }
  if (created) console.log(`Seeded ${created} legacy questionnaire version snapshot${created === 1 ? "" : "s"}.`);
  return created;
}

module.exports = {
  draftPayload,
  contentHash,
  getSnapshot,
  ensureSnapshot,
  writeFutureSnapshot,
  bootstrapPublishedSnapshots,
};
