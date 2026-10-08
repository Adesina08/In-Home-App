const os = require('node:os'), path = require('node:path'), fs = require('node:fs');
process.env.UPLOAD_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'inicio-video-uploads-'));
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const ffmpeg = require('ffmpeg-static');
require('express-async-errors');
const express = require('express');
const store = require('../lib/store');
const summary = require('../lib/videoSummary');
const research = require('../lib/videoResearch');
const reel = require('../lib/videoReel');
let dir, study, ada, tunde, server, base, realFetch, row, videoRequests = 0;
const prompts = [];
before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'inicio-video-summary-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  process.env.AI_SUMMARY_PROVIDER = 'gemini'; process.env.GEMINI_API_KEY = 'test-key';
  realFetch = global.fetch;
  global.fetch = async (url, options) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) return realFetch(url, options);
    const body = JSON.parse(options.body), parts = body.contents[0].parts;
    const prompt = JSON.parse(parts[0].text); prompts.push(prompt);
    let result;
    if (parts.length > 1) {
      const index = videoRequests++ % 3;
      const moments = [
        [{ kind: 'visual', start: 1, end: 2.5, text: 'Milk is poured into a cup', question: String(question.id) }],
        [{ kind: 'speech', start: 1, end: 2.5, text: 'Indomie costs more now', question: String(question.id) }],
        [{ kind: 'speech', start: 1, end: 2.5, text: 'I cook Indomie for my kids', question: String(question.id) }],
      ][index];
      result = { moments };
    } else if (prompt.evidence) {
      result = { findings: prompt.evidence.map(m => ({ point: m.text, supports: [m.id] })) };
    } else if (prompt.findings) {
      result = { groups: prompt.findings.map(p => ({ point: p.point, sources: [p.id] })) };
    } else if (prompt.paragraphs) {
      result = { paragraphs: [{ text: 'Household meals include milk and noodles. One respondent describes rising noodle prices, while another cooks noodles for their children.', sources: prompt.paragraphs.map((_, i) => i) }] };
    } else throw new Error('Unexpected model request');
    return new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: JSON.stringify(result) }] } }] }), { status: 200 });
  };
  study = await store.insert('studies', { name: 'Video study', minimum_base_size: 1 });
  const question = await store.insert('questions', { study_id: study.id, text: 'Describe the meal and your experience', type: 'text', code: 'meal' });
  const person = extra => store.insert('respondents', { study_id: study.id, is_practice: 0, activation_status: 'activated', consent_status: 'given', participation_start: '2026-01-01', ...extra });
  ada = await person({ media_consent: true }); tunde = await person({ media_consent: false });
  async function video(person, day, transcript) {
    const record = await store.insert('diary_records', { study_id: study.id, respondent_id: person.id, status: 'submitted', is_practice: 0, occurrence_time: day });
    const file = `/uploads/v${record.id}.mp4`;
    execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=red:s=320x240:d=1:r=30', '-f', 'lavfi', '-i', 'color=blue:s=320x240:d=2:r=30', '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-pix_fmt', 'yuv420p', path.join(process.env.UPLOAD_DIR, path.basename(file))]);
    return store.insert('media', { record_id: record.id, question_id: question.id, media_type: 'video', file_path: file, transcript_status: transcript ? 'done' : 'not_run', transcript_text: transcript });
  }
  await video(ada, '2026-01-02', 'I cook Indomie for my kids');
  await video(ada, '2026-01-03', '');
  await video(tunde, '2026-01-02', 'Indomie costs more now');
  const app = express(); app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon; app.locals.mediaUrl = p => `/media/file?path=${encodeURIComponent(p)}`;
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.session = { user: { role: req.headers['x-test-role'] || 'admin', id: 7, study_id: study.id, name: 'Test staff', email: 'staff@example.test' } }; res.locals.user = req.session.user; res.locals.currentPath = req.path; next(); });
  app.use('/admin', require('../routes/admin')); app.use('/client', require('../routes/client'));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  global.fetch = realFetch; await new Promise(r => server.close(r)); await store.close();
  fs.rmSync(process.env.UPLOAD_DIR, { recursive: true, force: true }); fs.rmSync(dir, { recursive: true, force: true });
});
test('collects all eligible videos without transcript truncation or a 60-video sample', async () => {
  const other = await store.insert('studies', { name: 'Large study' });
  const person = await store.insert('respondents', { study_id: other.id, is_practice: 0, activation_status: 'activated', consent_status: 'given', participation_start: '2026-01-01' });
  const record = await store.insert('diary_records', { study_id: other.id, respondent_id: person.id, is_practice: 0, status: 'submitted', occurrence_time: '2026-01-02' });
  for (let i = 0; i < 65; i++) await store.insert('media', { record_id: record.id, media_type: 'video', transcript_status: 'done', transcript_text: 'evidence '.repeat(200) });
  const evidence = await summary.collectVideoEvidence(other.id);
  assert.equal(evidence.videos.length, 65); assert.equal(evidence.stats.respondents, 1);
  assert.equal(evidence.videos[0].transcript.length, 1799);
});
test('full duration chunks have no gaps, and invalid or unknown timecoded evidence is rejected', () => {
  const ranges = research.chunks(137.2); assert.equal(ranges[0].start, 0); assert.equal(ranges.at(-1).end, 137.2);
  ranges.slice(1).forEach((r, i) => assert.ok(r.start < ranges[i].end));
  assert.throws(() => research.validateMoments({ moments: [{ start: 0, end: 90, text: 'x', kind: 'speech' }] }, 45, 0, new Set()), /invalid time/);
  assert.throws(() => research.validateMoments({ moments: [{ start: 0, end: 1, text: 'x', kind: 'speech', question: 'fake' }] }, 45, 0, new Set()), /unknown question/);
});
test('generation uses every video, source-linked findings and consented timestamped clips', async () => {
  row = summary.hydrate(await summary.generateVideoSummary(study.id, { generatedBy: 'staff@example.test' }));
  assert.equal(row.review_status, 'draft'); assert.equal(row.points.length, 3); assert.equal(videoRequests, 3);
  assert.deepEqual(row.coverage, { eligible: 3, analysed: 3, partial: 0, failed: 0, unavailable: 0, with_evidence: 3, respondents: 2 });
  const price = row.points.find(p => /costs/.test(p.point));
  assert.equal(price.respondent_base, 2); assert.equal(price.respondents.length, 1); assert.equal(price.clips.length, 0);
  const kids = row.points.find(p => /kids/.test(p.point));
  assert.equal(kids.quote, 'I cook Indomie for my kids'); assert.equal(kids.clips[0].start, 0.5); assert.equal(kids.clips[0].end, 3);
  for (const prompt of prompts) assert.doesNotMatch(JSON.stringify(prompt), /respondent_id|media_id|file_path|\.mp4/);
  await summary.generateVideoSummary(study.id, { force: true }); assert.equal(videoRequests, 3, 'completed source analysis is cached');
});
test('OpenAI synthesises the video research summary while reusing Gemini video evidence', async () => {
  const originalFetch = global.fetch, originalProvider = process.env.AI_SUMMARY_PROVIDER, originalKey = process.env.OPENAI_API_KEY;
  const beforeVideoCalls = videoRequests; let openaiCalls = 0;
  process.env.AI_SUMMARY_PROVIDER = 'openai'; process.env.OPENAI_API_KEY = 'test-openai-key';
  global.fetch = async (url, options) => {
    assert.equal(url, 'https://api.openai.com/v1/responses'); openaiCalls++;
    const prompt = JSON.parse(JSON.parse(options.body).input);
    const result = prompt.evidence ? { findings: prompt.evidence.map(m => ({ point: m.text, supports: [m.id] })) }
      : prompt.findings ? { groups: prompt.findings.map(p => ({ point: p.point, sources: [p.id] })) }
      : { paragraphs: [{ text: 'Reviewed meal experiences include milk, noodles and a concern about prices.', sources: prompt.paragraphs.map((_, i) => i) }] };
    return new Response(JSON.stringify({ status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(result) }] }] }));
  };
  try {
    const generated = summary.hydrate(await summary.generateVideoSummary(study.id));
    assert.equal(generated.provider, 'openai'); assert.equal(generated.model, 'gpt-5.4-mini');
    assert.equal(generated.points.length, 3); assert.equal(generated.coverage.analysed, 3);
    assert.equal(videoRequests, beforeVideoCalls); assert.ok(openaiCalls >= 2);
    assert.equal(generated.review_status, 'draft');
  } finally { global.fetch = originalFetch; process.env.AI_SUMMARY_PROVIDER = originalProvider; if (originalKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = originalKey; }
});
test('counts distinct people and recordings across batches and retains opposite experiences', async () => {
  const videos = Array.from({ length: 66 }, (_, i) => ({ clip_id: `V${i}`, respondent: i < 65 ? 'Person A' : 'Person B', shareable: false, moments: [{ id: `M${i}`, text: (i < 65 ? 'easy ' : 'difficult ').repeat(180), kind: 'speech', question: 'q', start: 1, end: 3 }] }));
  let batches = 0;
  const provider = { complete: async ({ prompt }) => {
    const data = JSON.parse(prompt);
    if (data.evidence) { batches++; return JSON.stringify({ findings: ['easy', 'difficult'].map(word => ({ point: word, supports: data.evidence.filter(m => m.text.startsWith(word)).map(m => m.id) })).filter(p => p.supports.length) }); }
    if (data.paragraphs) return JSON.stringify({ paragraphs: [{ text: 'Preparation experiences differ.', sources: data.paragraphs.map((_, i) => i) }] });
    return JSON.stringify({ groups: ['easy', 'difficult'].map(word => ({ point: word, sources: data.findings.filter(p => p.point === word).map(p => p.id) })).filter(p => p.sources.length) });
  } };
  const result = await research.synthesise(videos, [{ key: 'q', text: 'Preparation experience' }], provider);
  assert.ok(batches > 1); assert.equal(result.points.length, 2);
  const easy = result.points.find(p => p.point === 'easy'); assert.equal(easy.video_count, 65); assert.equal(easy.respondents.length, 1); assert.equal(easy.respondent_base, 2);
  assert.equal(result.points.find(p => p.point === 'difficult').respondents.length, 1);
});
test('unsupported citations and malformed model replies cannot become findings', async () => {
  const videos = [{ respondent: 'A', moments: [{ id: 'M1', text: 'hello', question: null }] }];
  await assert.rejects(research.synthesise(videos, [], { complete: async () => '{broken' }));
  await assert.rejects(research.synthesise(videos, [], { complete: async () => JSON.stringify({ findings: [{ point: 'invented', supports: ['missing'] }] }) }), /missing evidence/);
});
test('the reel seeks to the selected moment, renders captions and produces a playable video', async () => {
  await summary.buildReel(row.id); row = summary.hydrate(await store.findOne('video_summaries', { id: row.id }));
  assert.equal(row.reel_status, 'ready', row.reel_error); assert.ok(Math.abs(row.reel_seconds - 14) < 0.2);
  const file = path.join(process.env.UPLOAD_DIR, path.basename(row.reel_path));
  const pixel = execFileSync(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-ss', '6.75', '-i', file, '-vf', 'crop=2:2:640:360', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  assert.ok(pixel[2] > pixel[0] + 100, 'the reel shows blue source footage after the selected start, not the red opening');
  const plan = reel.planReel(row, 'Study');
  assert.ok(plan.some(p => p.kind === 'clip' && p.subtitles.some(s => s.text.includes('kids'))));
  assert.equal(reel.assTime(75.25), '0:01:15.25');
  assert.equal((await fetch(`${base}/admin/video-summary/${row.id}/reel`)).status, 200);
});
test('review page exposes coverage, evidence, time controls and explicit approval', async () => {
  const page = await (await fetch(`${base}/admin/video-summary?study=${study.id}&summary=${row.id}`)).text();
  assert.match(page, /Analysis coverage/); assert.match(page, /Edit findings and selected clips/); assert.match(page, /Start \(seconds\)/); assert.match(page, /evidence_reviewed/);
  assert.doesNotMatch(page, /up to 60|most recent were read/);
  await assert.rejects(summary.approveVideoSummary(study.id, row.id, { revision: row.review_revision }), /Confirm you checked/);
});
test('review rejects unsupported boundaries; approval publishes the reviewed version and editing revokes it', async () => {
  const edits = () => row.points.map((p, i) => ({ index: i, include: '1', order: i, point: p.point, clips: p.clips.map(c => ({ ...c, include: '1' })) }));
  const bad = edits(); bad.find(p => p.clips.length).clips[0].start = 2;
  await assert.rejects(summary.saveReview(study.id, row.id, { revision: row.review_revision, overview: row.overview, points: bad }), /Clips must include/);
  let client = await (await fetch(`${base}/client/insights?study=${study.id}`)).text(); assert.doesNotMatch(client, /What respondents showed us on video/);
  await summary.approveVideoSummary(study.id, row.id, { revision: row.review_revision, evidenceReviewed: '1', approvedBy: 'staff@example.test' });
  client = await (await fetch(`${base}/client/insights?study=${study.id}`)).text(); assert.match(client, /What respondents showed us on video/); assert.match(client, /Analysis coverage/); assert.doesNotMatch(client, /Respondent 1/);
  assert.equal((await fetch(`${base}/client/video-summary/${row.id}/reel?study=${study.id}`)).status, 200);
  const view = summary.clientView(row, new Set([ada.id])); assert.equal(view.points.find(p => /costs/.test(p.point)).quote, '');
  row = summary.hydrate(await summary.saveReview(study.id, row.id, { revision: row.review_revision, overview: 'Reviewed study overview.', points: edits() }));
  assert.equal(row.review_status, 'draft'); assert.equal(row.reel_status, 'pending');
  assert.equal(await summary.latestApproved(study.id) ?? null, null);
  await assert.rejects(summary.saveReview(study.id, row.id, { revision: row.review_revision - 1, overview: row.overview, points: edits() }), /review changed/);
  await summary.buildReel(row.id);
});
test('client media grants and current consent control reel access', async () => {
  const grant = await store.insert('client_grants', { user_id: 7, study_id: study.id, enabled: true, media: true, text: true });
  await summary.approveVideoSummary(study.id, row.id, { revision: row.review_revision, evidenceReviewed: '1', approvedBy: 'staff@example.test' });
  const headers = { 'x-test-role': 'client' };
  assert.equal((await fetch(`${base}/client/video-summary/${row.id}/reel?study=${study.id}`, { headers })).status, 200);
  await store.update('client_grants', { id: grant.id }, { media: false });
  assert.equal((await fetch(`${base}/client/video-summary/${row.id}/reel?study=${study.id}`, { headers })).status, 404);
  await store.update('client_grants', { id: grant.id }, { media: true });
  await store.update('respondents', { id: ada.id }, { media_consent: false });
  assert.equal((await fetch(`${base}/client/video-summary/${row.id}/reel?study=${study.id}`, { headers })).status, 404);
  await store.update('respondents', { id: ada.id }, { media_consent: true });
});
test('generation returns immediately, reuses an active job and reports progress', async () => {
  const original = research.synthesise;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  research.synthesise = async (...args) => { await gate; return original(...args); };
  try {
    const request = () => fetch(`${base}/admin/video-summary/generate`, { method: 'POST', redirect: 'manual', body: new URLSearchParams({ study_id: study.id }) });
    const first = await request(); assert.equal(first.status, 302);
    const location = first.headers.get('location');
    const second = await request(); assert.equal(second.headers.get('location'), location);
    const id = Number(new URL(location, base).searchParams.get('generated'));
    let pending = await store.findOne('video_summaries', { id });
    assert.equal(summary.generationStatus(pending), 'processing');
    const page = await (await fetch(`${base}${location}`)).text(); assert.match(page, /Analysing videos/);
    release();
    for (let n = 0; n < 100; n++) {
      pending = await store.findOne('video_summaries', { id });
      if (pending.reel_status === 'ready' || pending.generation_status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(pending.generation_status, 'ready'); assert.equal(pending.reel_status, 'ready');
  } finally { release(); research.synthesise = original; }
});
test('consent changes block rebuilding and approval of old evidence', async () => {
  await store.update('respondents', { id: ada.id }, { media_consent: false });
  await assert.rejects(summary.approveVideoSummary(study.id, row.id, { revision: row.review_revision, evidenceReviewed: '1' }), /consent changed/);
  await summary.buildReel(row.id); const failed = await store.findOne('video_summaries', { id: row.id }); assert.equal(failed.reel_status, 'failed');
});

test('partial and failed analyses remain visible and require coverage acknowledgement', async () => {
  const original = research.analyseVideo;
  research.analyseVideo = async (video, questions) => {
    const result = await original(video, questions);
    if (video.clip_id === 'V1') return { ...result, status: 'error', moments: [], failed_ranges: [{ start: 0, end: 3, error: 'Fixture provider failure' }] };
    if (video.clip_id === 'V2') return { ...result, status: 'partial', failed_ranges: [{ start: 2.5, end: 3, error: 'Fixture provider failure' }] };
    return result;
  };
  try {
    const partial = summary.hydrate(await summary.generateVideoSummary(study.id, { force: true }));
    assert.equal(partial.coverage.analysed, 1); assert.equal(partial.coverage.partial, 1); assert.equal(partial.coverage.failed, 1);
    assert.equal(partial.reel_status, 'no_clips');
    await assert.rejects(summary.approveVideoSummary(study.id, partial.id, { revision: partial.review_revision, evidenceReviewed: '1' }), /incomplete video coverage/);
    await summary.approveVideoSummary(study.id, partial.id, { revision: partial.review_revision, evidenceReviewed: '1', coverageAcknowledged: '1' });
    const view = summary.clientView(partial, new Set()); assert.equal(view.coverage.failed, 1);
  } finally { research.analyseVideo = original; }
});

test('malformed video model output is retained as a failed range rather than invented evidence', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => new Response(JSON.stringify({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: 'invalid JSON' }] } }] }), { status: 200 });
  try {
    const v = (await summary.collectVideoEvidence(study.id)).videos[0];
    const result = await research.analyseVideo(v, [{ key: 'different', text: 'A changed question invalidates the completed cache.' }]);
    assert.equal(result.status, 'error'); assert.equal(result.failed_ranges.length, 1); assert.deepEqual(result.moments, []);
    assert.doesNotMatch(result.failed_ranges[0].error, /test-key/);
  } finally { global.fetch = originalFetch; }
});

test('background synthesis failure preserves coverage and reports provider availability', async () => {
  const original = research.synthesise;
  research.synthesise = async () => { const error = new Error('provider unavailable'); error.status = 503; throw error; };
  try {
    const started = await summary.startGeneration(study.id);
    let failed;
    for (let n = 0; n < 100; n++) {
      failed = await store.findOne('video_summaries', { id: started.id });
      if (failed.generation_status === 'failed') break;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(failed.generation_status, 'failed'); assert.match(failed.generation_error, /503/);
    assert.equal(summary.hydrate(failed).coverage.eligible, 3);
    const page = await (await fetch(`${base}/admin/video-summary?study=${study.id}&summary=${failed.id}`)).text();
    assert.match(page, /Video coverage retained/); assert.match(page, /503/);
  } finally { research.synthesise = original; }
});
