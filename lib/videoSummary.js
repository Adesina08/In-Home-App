// Research summaries retain complete timestamped evidence and reviewed reels.
const crypto = require("crypto");
const fs = require("fs");
const store = require("./store");
const { loadStudyReport, validatePeriod } = require("./studyReport");
const aiSummary = require("./aiSummary");

const research = require('./videoResearch');
/** The eligible videos for a study/period, labelled without sampling or truncation. */
async function collectVideoEvidence(studyId, { from, to } = {}) {
  validatePeriod({ from, to });
  const report = await loadStudyReport(studyId, { from, to });
  const recordOwner = new Map(report.records.map((r) => [r.id, r.respondent_id]));
  const questionText = new Map(report.questions.map((q) => [q.id, q.text]));
  const shareable = new Set(report.respondents.filter((r) => r.media_consent === true).map((r) => r.id));
  const videos = report.media
    .filter((m) => m.media_type === "video" && recordOwner.has(m.record_id))
    .sort((a, b) => b.day.localeCompare(a.day) || b.id - a.id);

  // Labels are assigned in respondent-id order so the same person keeps the
  // same label across regenerations of the same period.
  const people = [...new Set(videos.map((m) => recordOwner.get(m.record_id)))].sort((a, b) => a - b);
  const labelFor = new Map(people.map((id, i) => [id, `Respondent ${i + 1}`]));

  const all = videos.map((m, i) => {
    const transcript = m.transcript_status === "done" ? String(m.transcript_text || "").trim() : "";
    return {
      clip_id: `V${i + 1}`,
      media_id: m.id,
      file_path: m.file_path,
      respondent_id: recordOwner.get(m.record_id),
      respondent: labelFor.get(recordOwner.get(m.record_id)),
      day: m.day,
      question: m.question_id != null ? questionText.get(m.question_id) || null : null,
      transcript,
      brand_seen: m.detection_status === "done" && m.detected_brand ? m.detected_brand : null,
      shareable: shareable.has(recordOwner.get(m.record_id)),
    };
  });

  const brandCounts = new Map();
  for (const v of all) {
    if (!v.brand_seen) continue;
    const row = brandCounts.get(v.brand_seen) || { brand: v.brand_seen, videos: 0, people: new Set() };
    row.videos += 1;
    row.people.add(v.respondent_id);
    brandCounts.set(v.brand_seen, row);
  }

  return {
    stats: {
      videos: all.length,
      respondents: people.length,
      transcribed: all.filter((v) => v.transcript).length,
      shareable: all.filter((v) => v.shareable).length,
      sampled: all.length,
    },
    brands: [...brandCounts.values()]
      .map((b) => ({ brand: b.brand, videos: b.videos, respondents: b.people.size }))
      .sort((a, b) => b.respondents - a.respondents || b.videos - a.videos || a.brand.localeCompare(b.brand)),
    videos: all,
    version: research.VERSION,
    research_model: research.modelName(),
    questions: report.questions.map(q => ({ key: String(q.id), text: q.text })),
  };
}

function signatureOf(evidence) {
  return crypto.createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
}

async function currentSignature(studyId, period = {}) {
  return signatureOf(await collectVideoEvidence(studyId, period));
}

async function generateVideoSummary(studyId, { from, to, generatedBy, force = false, summaryId } = {}) {
  const evidence = await collectVideoEvidence(studyId, { from, to });
  if (!evidence.stats.videos) throw new Error("There are no eligible respondent videos in this period to summarise.");
  if (!research.isConfigured()) throw new Error("Configure video understanding before generating a research video summary.");
  const sourceSignature = signatureOf(evidence);
  const provider = aiSummary.getProvider();
  if (!force && !summaryId) {
    const existing = await store.findOne("video_summaries", { study_id: studyId, source_signature: sourceSignature, generation_status: 'ready', provider: provider.name, model: provider.model || null }, { sort: { generated_at: -1, id: -1 } });
    if (existing) return existing;
  }
  for (const [i, video] of evidence.videos.entries()) {
    const result = await research.analyseVideo(video, evidence.questions);
    Object.assign(video, { analysis_status: result.status, analysis_error: result.error || null, failed_ranges: result.failed_ranges || [], duration: result.duration || null,
      moments: (result.moments || []).map((m, n) => ({ ...m, id: `${video.clip_id}M${n + 1}` })) });
    if (summaryId) await store.update('video_summaries', { id: summaryId }, { processed_count: i + 1, video_count: evidence.stats.videos, generation_updated_at: store.nowSql() });
  }
  const coverage = {
    eligible: evidence.videos.length,
    analysed: evidence.videos.filter(v => v.analysis_status === 'done').length,
    partial: evidence.videos.filter(v => v.analysis_status === 'partial').length,
    failed: evidence.videos.filter(v => v.analysis_status === 'error').length,
    unavailable: evidence.videos.filter(v => v.analysis_status === 'unavailable').length,
    with_evidence: evidence.videos.filter(v => v.moments.length).length,
    respondents: new Set(evidence.videos.filter(v => v.moments.length).map(v => v.respondent)).size,
  };
  // Persist coverage before synthesis so a text-provider failure cannot hide
  // which videos were processed successfully.
  if (summaryId) await store.update('video_summaries', { id: summaryId }, {
    evidence_json: JSON.stringify(evidence.videos), coverage_json: JSON.stringify(coverage), respondent_count: evidence.stats.respondents,
  });
  const { overview, overview_sources, points } = await research.synthesise(evidence.videos, evidence.questions, provider);
  if (sourceSignature !== await currentSignature(studyId, { from, to })) throw new Error('The eligible videos or consent changed during analysis. Generate again using the current evidence.');
  const values = {
    study_id: studyId, period_start: from || null, period_end: to || null,
    video_count: evidence.stats.videos, respondent_count: evidence.stats.respondents,
    transcribed_count: evidence.stats.transcribed, sampled_count: evidence.stats.videos,
    overview, overview_sources_json: JSON.stringify(overview_sources), points_json: JSON.stringify(points), brands_json: JSON.stringify(evidence.brands),
    evidence_json: JSON.stringify(evidence.videos), coverage_json: JSON.stringify(coverage),
    provider: provider.name, model: provider.model || null, source_signature: sourceSignature,
    used_ai_model: provider.usesAiModel ? 1 : 0, generated_by: generatedBy || 'system',
    generation_status: 'ready', generation_updated_at: store.nowSql(), review_revision: 1,
    reel_status: points.some(p => p.clips.length) ? 'pending' : 'no_clips',
  };
  if (summaryId) await store.update('video_summaries', { id: summaryId }, values);
  else summaryId = (await store.insert('video_summaries', values)).id;
  return store.findOne('video_summaries', { id: summaryId });
}
const generations = new Set();
async function startGeneration(studyId, options = {}) {
  if (!research.isConfigured() || !aiSummary.isAiModelConfigured()) throw new Error('Video understanding and a summary provider must be configured.');
  validatePeriod(options);
  const existing = await store.findOne('video_summaries', { study_id: studyId, period_start: options.from || null, period_end: options.to || null, generation_status: 'processing' });
  if (existing && generations.has(existing.id)) return existing;
  const evidence = await collectVideoEvidence(studyId, options);
  if (!evidence.stats.videos) throw new Error('There are no eligible videos in this period.');
  const row = await store.insert('video_summaries', { study_id: studyId, period_start: options.from || null, period_end: options.to || null, generation_status: 'processing', generation_updated_at: store.nowSql(), video_count: evidence.stats.videos, processed_count: 0, generated_by: options.generatedBy });
  generations.add(row.id);
  void generateVideoSummary(studyId, { ...options, force: true, summaryId: row.id }).then(async saved => {
    if (saved.reel_status === 'pending') await buildReel(saved.id);
  }).catch(async error => {
    const reason = error?.code === 'insufficient_quota' ? 'The OpenAI API project has no available quota. Check its billing and usage limit.'
      : error?.status === 401 ? 'The research summary provider rejected its API key. Check the server configuration.'
      : error?.status === 404 ? 'The configured research summary model is unavailable to this API project.'
      : error?.status === 503 ? 'The research summary provider is temporarily unavailable (503).'
      : error?.status === 429 ? 'The research summary provider has reached its current request limit (429).'
      : /timed out|abort/i.test(error?.message || '') ? 'The research summary request timed out.'
      : 'Research synthesis could not finish.';
    await store.update('video_summaries', { id: row.id }, { generation_status: 'failed', generation_error: `${reason} Retry generation; completed video analysis is retained.` });
  }).catch(() => {}).finally(() => generations.delete(row.id));
  return row;
}
function generationStatus(row) {
  if (row?.generation_status !== 'processing') return row?.generation_status || 'legacy';
  return generations.has(row.id) ? 'processing' : 'interrupted';
}

const reelBuilds = new Set();

// The settings a reel renders with (its own, else the study's defaults), the
// study's uploaded logo/music, and respondent profiles for caption fields.
async function reelLook(study, ownSettings) {
  const { effective } = require("./reelSettings");
  const { loadProfiles, segmentValue } = require("./staffAnalysis");
  const look = effective(study, ownSettings);
  const profiles = new Map();
  if (look.settings.captions.fields.some((f) => ["age", "gender", "location"].includes(f)) && study) {
    for (const [id, profile] of await loadProfiles(study.id)) {
      profiles.set(id, { age_band: segmentValue(profile, "age_band"), gender: segmentValue(profile, "gender"), location: segmentValue(profile, "location") });
    }
  }
  return { ...look, profiles };
}

/**
 * Cut and join the highlight reel for a saved summary. Slow (one encode per
 * clip), so routes start it without awaiting; the page shows reel_status
 * until it is "ready". A newer reel replaces and deletes the old file.
 */
async function buildReel(summaryId) {
  if (reelBuilds.has(summaryId)) return;
  reelBuilds.add(summaryId);
  const { planReel, renderReel } = require("./videoReel");
  const mediaStorage = require("./mediaStorage");
  let row;
  try {
    row = hydrate(await store.findOne("video_summaries", { id: summaryId }));
    if (!row) return;
    const study = await store.findOne("studies", { id: row.study_id });
    await assertCurrentEvidence(row);
    const look = await reelLook(study, row.reel_settings_json);
    const plan = planReel(row, study && study.name, look);
    if (!plan) {
      await store.update("video_summaries", { id: row.id }, { reel_status: "no_clips" });
      return;
    }
    await store.update("video_summaries", { id: row.id }, { reel_status: "building", reel_started_at: store.nowSql(), reel_error: null });
    const reel = await renderReel(plan, look);
    try {
      await assertCurrentEvidence(row);
      const reelPath = await mediaStorage.persistBuffer(fs.readFileSync(reel.file), "video/mp4");
      const updated = await store.update("video_summaries", { id: row.id, review_revision: row.review_revision }, { reel_status: "ready", reel_path: reelPath, reel_seconds: reel.seconds, reel_built_at: store.nowSql() });
      if (!updated.changes) { await mediaStorage.deleteMedia(reelPath); return; }
      if (row.reel_path && row.reel_path !== reelPath) await mediaStorage.deleteMedia(row.reel_path).catch(() => {});
    } finally {
      reel.cleanup();
    }
  } catch (e) {
    console.warn(`Video reel for summary ${summaryId} failed: ${e.message}`);
    await store.update("video_summaries", { id: summaryId, ...(row ? { review_revision: row.review_revision } : {}) }, { reel_status: "failed", reel_error: String(e.message || e).slice(0, 500) }).catch(() => {});
  } finally {
    reelBuilds.delete(summaryId);
  }
}

/** Start a reel build without waiting for it. */
function startReelBuild(summaryId) {
  buildReel(summaryId).catch(() => {});
}

/** A build that has sat in "building" this long was cut short (e.g. a restart). */
function reelStatus(row) {
  if (!row) return null;
  if (["building", "pending"].includes(row.reel_status) && !reelBuilds.has(row.id)) {
    const started = Date.parse(String(row.reel_started_at || row.generated_at || "").replace(" ", "T") + "Z");
    if (Number.isFinite(started) && Date.now() - started > 30 * 60000) return "failed";
  }
  return row.reel_status || "none";
}

/** Respondents whose faces/voices are in the reel. */
function reelRespondentIds(row) {
  const s = hydrate(row);
  const byClip = new Map(s.evidence.map((v) => [v.clip_id, v.respondent_id]));
  return [...new Set(s.points.flatMap((p) => p.clips || []).map((clip) => byClip.get(typeof clip === "string" ? clip : clip.clip_id)).filter((id) => id != null))];
}

/** Stream a ready reel file (local disk) or redirect to a short-lived signed URL (Blob). */
function sendReel(res, row, options) {
  if (!row || row.reel_status !== "ready" || !row.reel_path) return res.sendStatus(404);
  return sendReelFile(res, row.reel_path, options);
}

function sendReelFile(res, storedPath, { download = null } = {}) {
  res.set("Cache-Control", "private, no-store");
  res.set("X-Content-Type-Options", "nosniff");
  if (storedPath.startsWith("azureblob://")) return res.redirect(require("./mediaStorage").getMediaUrl(storedPath));
  const path = require("path");
  const dir = process.env.UPLOAD_DIR || path.join(__dirname, "..", "uploads");
  if (download) res.attachment(download);
  res.type("video/mp4").sendFile(path.resolve(dir, path.basename(storedPath)), (err) => { if (err && !res.headersSent) res.sendStatus(404); });
}

// ---------- Extra named reels ----------
//
// Besides the summary's main reel (the one clients see once the summary is
// approved), staff can keep several named cuts of the same reviewed findings
// -- e.g. "60s client cut", "Vertical for WhatsApp" -- each with its own
// settings. They are staff-only; "use as client reel" copies a cut's settings
// onto the main reel, which returns the summary to draft for re-approval.
const extraBuilds = new Set();

async function listReels(summaryId) {
  return store.find("video_reels", { summary_id: Number(summaryId) }, { sort: { id: 1 } });
}

async function createReel(summaryId, { name, settings, createdBy }) {
  const row = hydrate(await store.findOne("video_summaries", { id: Number(summaryId) }));
  if (!row || row.generation_status === "processing") throw new Error("Video summary not found or still generating.");
  const label = String(name || "").trim().slice(0, 80);
  if (!label) throw new Error("Give the reel a name, e.g. “60s client cut”.");
  const { normalize } = require("./reelSettings");
  const { id } = await store.insert("video_reels", {
    summary_id: row.id, study_id: row.study_id, name: label,
    settings_json: settings ? JSON.stringify(normalize(settings)) : null,
    status: "pending", created_by: createdBy || null, started_at: store.nowSql(),
  });
  startExtraReelBuild(id);
  return store.findOne("video_reels", { id });
}

async function updateReelSettings(reelId, settings) {
  const reel = await store.findOne("video_reels", { id: Number(reelId) });
  if (!reel) throw new Error("Reel not found.");
  if (extraBuilds.has(reel.id)) throw new Error("That reel is building. Wait for it to finish before changing it.");
  const { normalize } = require("./reelSettings");
  await store.update("video_reels", { id: reel.id }, { settings_json: settings ? JSON.stringify(normalize(settings)) : null, status: "pending", error: null, started_at: store.nowSql() });
  startExtraReelBuild(reel.id);
  return store.findOne("video_reels", { id: reel.id });
}

async function buildExtraReel(reelId) {
  if (extraBuilds.has(reelId)) return;
  extraBuilds.add(reelId);
  const { planReel, renderReel } = require("./videoReel");
  const mediaStorage = require("./mediaStorage");
  try {
    const reel = await store.findOne("video_reels", { id: reelId });
    if (!reel) return;
    const row = hydrate(await store.findOne("video_summaries", { id: reel.summary_id }));
    const study = await store.findOne("studies", { id: reel.study_id });
    await assertCurrentEvidence(row);
    const look = await reelLook(study, reel.settings_json);
    const plan = planReel(row, study && study.name, look);
    if (!plan) { await store.update("video_reels", { id: reel.id }, { status: "no_clips" }); return; }
    await store.update("video_reels", { id: reel.id }, { status: "building", started_at: store.nowSql(), error: null });
    const built = await renderReel(plan, look);
    try {
      const storedPath = await mediaStorage.persistBuffer(fs.readFileSync(built.file), "video/mp4");
      await store.update("video_reels", { id: reel.id }, { status: "ready", path: storedPath, seconds: built.seconds, built_at: store.nowSql(), review_revision: row.review_revision });
      if (reel.path && reel.path !== storedPath) await mediaStorage.deleteMedia(reel.path).catch(() => {});
    } finally {
      built.cleanup();
    }
  } catch (e) {
    console.warn(`Extra reel ${reelId} failed: ${e.message}`);
    await store.update("video_reels", { id: reelId }, { status: "failed", error: String(e.message || e).slice(0, 500) }).catch(() => {});
  } finally {
    extraBuilds.delete(reelId);
  }
}

function startExtraReelBuild(reelId) {
  buildExtraReel(reelId).catch(() => {});
}

/** An extra reel's status, treating a build cut short by a restart as failed. */
function extraReelStatus(reel) {
  if (["building", "pending"].includes(reel.status) && !extraBuilds.has(reel.id)) {
    const started = Date.parse(String(reel.started_at || "").replace(" ", "T") + "Z");
    if (Number.isFinite(started) && Date.now() - started > 30 * 60000) return "failed";
  }
  return reel.status;
}

async function deleteReel(reelId) {
  const reel = await store.findOne("video_reels", { id: Number(reelId) });
  if (!reel) return;
  if (reel.path) await require("./mediaStorage").deleteMedia(reel.path).catch(() => {});
  await store.remove("video_reels", { id: reel.id });
}

/** Copy a cut's settings onto the main client reel and rebuild it (back to draft). */
async function useAsClientReel(reelId) {
  const reel = await store.findOne("video_reels", { id: Number(reelId) });
  if (!reel) throw new Error("Reel not found.");
  const row = await store.findOne("video_summaries", { id: reel.summary_id });
  if (reelBuilds.has(row.id) || ["pending", "building"].includes(row.reel_status)) throw new Error("The client reel is building. Wait for it to finish.");
  await setMainReelSettings(row.id, reel.settings_json);
  return row;
}

/** Save the main reel's own settings (null = use the study defaults) and rebuild it. */
async function setMainReelSettings(summaryId, settings) {
  const { normalize } = require("./reelSettings");
  await store.update("video_summaries", { id: Number(summaryId) }, {
    reel_settings_json: settings ? JSON.stringify(normalize(settings)) : null,
    review_status: "draft", approved_at: null, reel_status: "pending", reel_started_at: store.nowSql(), reel_error: null,
  });
  startReelBuild(Number(summaryId));
}

/** Delete summaries and their reel files, extra reels included (erasure, study deletion). */
async function removeVideoSummaries(filter) {
  for (const row of await store.find("video_summaries", filter)) {
    if (row.reel_path) await require("./mediaStorage").deleteMedia(row.reel_path).catch(() => {});
    for (const reel of await store.find("video_reels", { summary_id: row.id })) {
      if (reel.path) await require("./mediaStorage").deleteMedia(reel.path).catch(() => {});
    }
    await store.remove("video_reels", { summary_id: row.id });
  }
  await store.remove("video_summaries", filter);
}

/** A stored row with its JSON columns parsed. */
function hydrate(row) {
  if (!row) return null;
  const parse = (value, fallback) => { try { return JSON.parse(value) ?? fallback; } catch (_) { return fallback; } };
  return { ...row, points: parse(row.points_json, []), brands: parse(row.brands_json, []), evidence: parse(row.evidence_json, []), coverage: parse(row.coverage_json, null) };
}

/**
 * What a client may see of an approved summary: no respondent labels, no
 * transcripts, and a quote only when the person who said it consented to
 * their media being shared.
 */
function clientView(row, consentingRespondentIds) {
  const s = hydrate(row);
  if (!s) return null;
  const owner = new Map(s.evidence.map((v) => [v.respondent, v.respondent_id]));
  return {
    id: s.id,
    generated_at: s.generated_at,
    approved_at: s.approved_at,
    used_ai_model: s.used_ai_model,
    video_count: s.video_count,
    reel_ready: s.reel_status === "ready" && !!s.reel_path && reelRespondentIds(row).every(id => consentingRespondentIds.has(id)),
    reel_seconds: s.reel_seconds || null,
    respondent_count: s.respondent_count,
    overview: s.client_overview || s.overview,
    coverage: s.coverage,
    brands: s.brands,
    points: s.points.map((p) => ({
      point: p.point,
      question: p.question || null,
      respondent_base: p.respondent_base ?? s.respondent_count,
      video_count: p.video_count ?? null,
      respondents: p.respondents.length,
      quote: p.quote && consentingRespondentIds.has(owner.get(p.quote_respondent)) ? p.quote : "",
    })),
  };
}

async function listVideoSummaries(studyId, limit = 20) {
  return store.find("video_summaries", { study_id: studyId }, { sort: { generated_at: -1, id: -1 }, limit });
}

async function assertCurrentEvidence(row) {
  const current = await collectVideoEvidence(row.study_id, { from: row.period_start, to: row.period_end });
  if (signatureOf(current) !== row.source_signature) throw new Error('The source videos, eligibility or consent changed. Generate a new summary before sharing.');
  return current;
}
async function saveReview(studyId, id, { overview, points, revision } = {}) {
  const row = hydrate(await store.findOne('video_summaries', { id: Number(id), study_id: studyId }));
  if (!row || row.generation_status !== 'ready') throw new Error('Generate a timestamped summary before editing.');
  if (Number(revision) !== row.review_revision) throw new Error('This review changed. Reload before saving.');
  if (reelBuilds.has(row.id) || ['pending', 'building'].includes(row.reel_status)) throw new Error('The reel is building. Wait for it to finish before editing.');
  await assertCurrentEvidence(row);
  if (!Array.isArray(points)) throw new Error('The review form is invalid.');
  const seen = new Set();
  const reviewed = points.filter(p => p.include === '1').map(edit => {
    const index = Number(edit.index), original = row.points[index];
    if (!original || seen.has(index)) throw new Error('Invalid finding.');
    seen.add(index);
    const point = String(edit.point || '').trim();
    if (!point || point.length > 1000) throw new Error('Each finding needs a description of at most 1,000 characters.');
    const clips = (Array.isArray(edit.clips) ? edit.clips : []).filter(c => c.include === '1').map(c => {
      const v = row.evidence.find(v => v.moments?.some(m => m.id === c.moment_id));
      const moment = v?.moments.find(m => m.id === c.moment_id);
      const start = Number(c.start), end = Number(c.end);
      if (!moment || !original.supports.includes(moment.id) || !v.shareable || c.start === '' || c.end === '' || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > v.duration || end <= start || start > moment.start || end < moment.end) throw new Error('Clips must include their supporting moment, stay within the source video and have sharing consent.');
      return { moment_id: moment.id, clip_id: v.clip_id, start, end };
    });
    if (new Set(clips.map(c => c.moment_id)).size !== clips.length) throw new Error('A moment can only appear once in a finding.');
    return { ...original, point, clips, order: Number(edit.order) || 0 };
  }).sort((a, b) => a.order - b.order);
  if (!reviewed.length) throw new Error('Keep at least one supported finding.');
  const text = String(overview || '').trim();
  if (!text || text.length > 10000) throw new Error('Add an overview of at most 10,000 characters.');
  const updated = await store.update('video_summaries', { id: row.id, review_revision: row.review_revision }, {
    overview: text, client_overview: null, overview_sources_json: null, points_json: JSON.stringify(reviewed), review_revision: row.review_revision + 1,
    review_status: 'draft', approved_at: null, approved_by: null,
    reel_status: reviewed.some(p => p.clips.length) ? 'pending' : 'no_clips', reel_error: null,
  });
  if (!updated.changes) throw new Error('This review changed. Reload before saving.');
  return store.findOne('video_summaries', { id: row.id });
}
async function approveVideoSummary(studyId, id, { approvedBy, revision, evidenceReviewed, coverageAcknowledged } = {}) {
  const row = hydrate(await store.findOne('video_summaries', { id: Number(id), study_id: studyId }));
  if (!row || row.generation_status !== 'ready' || !row.points.length) throw new Error('Generate and review a supported summary first.');
  if (Number(revision) !== row.review_revision) throw new Error('This review changed. Reload before approving.');
  if (evidenceReviewed !== '1') throw new Error('Confirm you checked the findings, timecodes, captions and reel against the source videos.');
  if (row.coverage.analysed !== row.coverage.eligible && coverageAcknowledged !== '1') throw new Error('Acknowledge incomplete video coverage before approving.');
  if (!['ready', 'no_clips'].includes(row.reel_status)) throw new Error('Wait for the reviewed reel to finish before approving.');
  await assertCurrentEvidence(row);
  const updated = await store.update('video_summaries', { id: row.id, review_revision: row.review_revision, reel_status: row.reel_status }, {
    review_status: 'approved', approved_by: approvedBy, approved_at: store.nowSql(), client_overview: row.overview,
  });
  if (!updated.changes && row.review_status !== 'approved') throw new Error('This review changed. Reload before approving.');
  return store.findOne('video_summaries', { id: row.id });
}

async function latestApproved(studyId, { from, to } = {}) {
  return store.findOne("video_summaries", {
    study_id: studyId, review_status: "approved", period_start: from || null, period_end: to || null,
  }, { sort: { generated_at: -1, id: -1 } });
}

module.exports = {
  collectVideoEvidence,
  startGeneration,
  generationStatus,
  saveReview,
  assertCurrentEvidence,
  currentSignature,
  generateVideoSummary,
  buildReel,
  startReelBuild,
  reelStatus,
  removeVideoSummaries,
  reelRespondentIds,
  sendReel,
  sendReelFile,
  listReels,
  createReel,
  updateReelSettings,
  buildExtraReel,
  extraReelStatus,
  deleteReel,
  useAsClientReel,
  setMainReelSettings,
  listVideoSummaries,
  approveVideoSummary,
  latestApproved,
  hydrate,
  clientView,

};
