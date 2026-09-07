const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const { loadStudyReport, validatePeriod, wordCloud } = require('../lib/studyReport');
const { generateSummary } = require('../lib/aiSummary');
let dir, study;
before(async () => {
  process.env.AI_SUMMARY_PROVIDER = 'template';
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-report-test-'));
  await store.connect({ uri: '', file: path.join(dir, 'test.json') });
  study = await store.insert('studies', { name: 'Report study',minimum_base_size:2 });
  for(const id of [99,100])await store.insert('respondents',{id,study_id:study.id,activation_status:'active',consent_status:'given',media_consent:true});
  await store.insert('client_grants',{user_id:7,study_id:study.id,enabled:true,media:true,text:true,exports:true});
  const other = await store.insert('studies', { name: 'Foreign study' });
  const q = await store.insert('questions', { study_id: study.id, type: 'text', code: 'brand', text: 'Experience' });
  for (const [sid, status, practice, date, flagged, source, verified, value] of [
    [study.id, 'submitted', 0, '2026-09-06 23:59:59', false, 'respondent', 0, 'Fresh fresh breakfast'],
    [study.id, 'submitted', 0, '2026-09-06 00:00:00', false, 'ai_video', 1, 'Fresh breakfast'],
    [study.id, 'submitted', 0, '2026-09-06 12:00:00', true, 'respondent', 0, 'Flagged'],
    [study.id, 'submitted', 0, '2026-09-06 12:00:00', false, 'ai_video', 0, 'Unconfirmed'],
    [study.id, 'draft', 0, '2026-09-06 12:00:00', false, 'respondent', 0, 'Draft'],
    [study.id, 'submitted', 1, '2026-09-06 12:00:00', false, 'respondent', 0, 'Practice'],
    [study.id, 'submitted', 0, '2026-09-07 00:00:00', false, 'respondent', 0, 'Tomorrow'],
    [other.id, 'submitted', 0, '2026-09-06 12:00:00', false, 'respondent', 0, 'Foreign'],
  ]) {
    const r = await store.insert('diary_records', { study_id: sid, respondent_id: source==='ai_video'?100:99, status, is_practice: practice, entry_time: date });
    await store.insert('responses', { record_id: r.id, question_id: q.id, value, source, verified });
    await store.insert('media', { record_id: r.id, media_type: 'video', file_path: `${value}.mp4` });
    if (flagged) await store.insert('qc_flags', { record_id: r.id, status: 'open' });
  }
});
after(async () => { await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
test('rejects invalid dates and reversed periods', () => {
  for (const from of ['2026-02-30', '2026-13-01', 'yesterday', ['2026-09-06']]) assert.throws(() => validatePeriod({ from }));
  assert.throws(() => validatePeriod({ from: '2026-09-07', to: '2026-09-06' }));
  assert.deepEqual(validatePeriod({ from: '2024-02-29' }), { from: '2024-02-29', to: '' });
});
test('visual base scopes study and inclusive dates, excludes drafts, practice, flagged media and unconfirmed answers', async () => {
  const report = await loadStudyReport(study.id, { from: '2026-09-06', to: '2026-09-06' });
  assert.equal(report.submitted, 4);
  assert.equal(report.eligible, 3);
  assert.equal(report.media.length, 3);
  assert.equal(report.openText.length, 2);
  assert.deepEqual(report.provenance, { respondent: 1, aiConfirmed: 1, excluded: 2 });
  assert.deepEqual(report.words, [{ word: 'fresh', count: 3 }, { word: 'breakfast', count: 2 }]);
  assert.equal(report.entries.length, 3);
  assert.equal(report.brands.length, 2);
});
test('empty study period produces honest empty collections', async () => {
  const r = await loadStudyReport(study.id, { from: '2030-01-01' });
  for (const key of ['media','words','openText','trend','brands','entries']) assert.deepEqual(r[key], []);
  assert.equal(r.submitted, 0);
});
test('cloud removes common words and contact/link tokens', () => {
  assert.deepEqual(wordCloud(['The fresh and fresh https://site.test/secret me@example.org +234 800 123 4567']), [{ word: 'fresh', count: 2 }]);
});
test('summary generation awaits the metrics and stores real distributions', async () => {
  const summary = await generateSummary(study.id, { from: '2026-09-06', to: '2026-09-06', generatedBy: 'test' });
  const metrics = JSON.parse(summary.metrics_json);
  assert.equal(metrics.base.submitted_records, 4);
  assert.equal(metrics.brands.length, 2);
  assert.equal(metrics.quality.qc_flag_rate_pct, 25);
  assert.equal(summary.used_ai_model, 0);
  assert.match(summary.narrative, /4/);
  assert.equal(JSON.parse(summary.open_text_json).length, 2);
  await assert.rejects(generateSummary(study.id, { from: '2026-02-30' }));
});

test('client routes enforce assignment, render inline media and export the same scoped base', async () => {
  const express = require('express');
  const app = express();
  app.set('view engine', 'ejs');
  app.set('views', path.join(__dirname, '../views'));
  app.locals.mediaUrl = value => '/uploads/' + value;
  app.use((req, res, next) => {
    req.session = { user: { id:req.headers['x-test-unassigned']?8:7,role: 'client', study_id: req.headers['x-test-unassigned'] ? null : study.id, email: 'test@example.test' } };
    res.locals.user = req.session.user;
    res.locals.currentPath = req.path;
    next();
  });
  app.use('/client', require('../routes/client'));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/client`;
  try {
    const response = await fetch(`${url}/insights?study=${study.id}&from=2026-09-06&to=2026-09-06`);
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<video controls playsinline preload="none"/);
    assert.doesNotMatch(html, /<a[^>]*href="[^\"]*(?:records|Foreign|Flagged|Draft|Practice)/);
    assert.doesNotMatch(html, /Foreign\.mp4|Flagged\.mp4|Tomorrow\.mp4/);
    assert.equal((await fetch(`${url}/insights?study=999`)).status, 404);
    assert.equal((await fetch(`${url}/export?study=999`)).status, 404);
    assert.equal((await fetch(url, { headers: { 'x-test-unassigned': '1' } })).status, 404);
    assert.equal((await fetch(`${url}?from=2026-02-30`)).status, 400);
    const csv = await fetch(`${url}/export?from=2026-09-06&to=2026-09-06`);
    assert.match(csv.headers.get('content-type'), /text\/csv/);
    assert.match(await csv.text(), /"Submitted entries","4"/);
    const snapshotId=await require('../lib/researchOperations').snapshot(study.id,'test',{from:'2026-09-06',to:'2026-09-06'});
    let history=await fetch(`${url}/reports`);assert.doesNotMatch(await history.text(),/Generated 2026/);
    await store.update('report_snapshots',{id:snapshotId},{status:'approved',approved_at:'2026-09-06 12:00:00'});
    history=await fetch(`${url}/reports`);assert.equal(history.status,200);assert.match(await history.text(),/approved 2026-09-06/);
    assert.equal((await fetch(`${url}/analysis?from=2026-09-06&to=2026-09-06`)).status,200);
    await store.update('client_grants',{user_id:7,study_id:study.id},{exports:false});assert.equal((await fetch(`${url}/export`)).status,403);
    const anonymous = await fetch(`${url}/insights?from=2030-01-01`);
    assert.match(await anonymous.text(), /No eligible media/);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
