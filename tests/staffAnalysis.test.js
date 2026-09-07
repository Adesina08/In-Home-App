const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
require('express-async-errors');
const express = require('express');
const store = require('../lib/store');
const { staffAnalysis, analysisCsv } = require('../lib/staffAnalysis');
let dir, study, question, loop, person, server, base;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-analysis-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  study = await store.insert('studies', { name: '=Example', minimum_base_size: 5 });
  person = await store.insert('respondents', { study_id: study.id, is_practice: 0, activation_status: 'activated', consent_status: 'given', gender: 'Outdated', participation_start: '2026-01-01' });
  await store.insert('respondent_profile_snapshots', { study_id: study.id, respondent_id: person.id, snapshot_json: JSON.stringify({ gender: 'Women', age: 29 }) });
  question = await store.insert('questions', { study_id: study.id, code: 'brand', type: 'multi', text: 'Brands' });
  loop = await store.insert('questions', { study_id: study.id, code: 'brand_2', source_code: 'brand', type: 'multi', text: 'Brands (second product)' });
  for (const [day, options] of [['2026-01-01', {}], ['2026-01-03', {}], ['2026-01-04', { blocked: true }], ['2026-01-05', { ai: true }], ['2026-01-06', { practice: true }]]) {
    const r = await store.insert('diary_records', { study_id: study.id, respondent_id: person.id, status: 'submitted', is_practice: options.practice ? 1 : 0, occurrence_time: day, entry_mode: 'standard' });
    await store.insert('responses', { record_id: r.id, question_id: question.id, value: options.blocked ? 'Excluded' : options.ai ? 'Unconfirmed' : 'A|A|B', source: options.ai ? 'ai_video' : 'form', verified: 0 });
    if (!options.blocked && !options.ai) await store.insert('responses', { record_id: r.id, question_id: loop.id, value: 'A|0' });
    if (options.blocked) await store.insert('qc_flags', { record_id: r.id, status: 'open' });
  }
  const app = express();
  app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon;
  app.use((req, res, next) => { req.session = { user: req.headers['x-test-role'] ? { role: req.headers['x-test-role'], name: 'Test staff' } : null }; res.locals.user = req.session.user; res.locals.currentPath = req.path; next(); });
  app.use('/admin', require('../routes/admin'));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });
test('crosstabs deduplicate selections across loops, retain zero, and exclude practice, QC and unconfirmed AI answers', async () => {
  const d = await staffAnalysis(study.id);
  assert.equal(d.answered, 2); assert.equal(d.answerContributors, 1);
  assert.deepEqual(d.distribution.map(v => [v.label, v.n, v.pct]), [['0', 2, 100], ['A', 2, 100], ['B', 2, 100]]);
  assert.equal(d.crosstab[0].label, 'Women'); assert.equal(d.crosstab[0].lowBase, true); assert.equal(d.crosstab[0].respondents, 1);
  assert.equal(d.trend.find(t => t.label === '2026-01-02').n, 0);
  const csv = analysisCsv(d); assert.match(csv, /"'=Example"/); assert.match(csv, /"Women","1","2"/);
});
test('date filters apply consistently and foreign questions or demographic fields are rejected', async () => {
  const d = await staffAnalysis(study.id, { from: '2026-01-03', to: '2026-01-03', segment: 'age_band' });
  assert.equal(d.answered, 1); assert.equal(d.crosstab[0].label, '25–34'); assert.equal(d.trend.length, 1);
  await assert.rejects(staffAnalysis(study.id, { question: 'foreign-question' }), /Choose a question/);
  await assert.rejects(staffAnalysis(study.id, { segment: '__proto__' }), /Choose a supported/);
  await assert.rejects(staffAnalysis(study.id, { from: '2026-02-30' }), /valid calendar/);
});
test('empty selections do not invent answers or percentages', async () => {
  const d = await staffAnalysis(study.id, { from: '2026-02-01', to: '2026-02-02' });
  assert.equal(d.answered, 0); assert.deepEqual(d.distribution, []); assert.deepEqual(d.trend, []); assert.equal(d.crosstab[0].answered, 0);
});
test('both staff roles can render and export analysis; clients and unauthenticated requests cannot', async () => {
  for (const role of ['admin', 'superadmin']) {
    const response = await fetch(base + '/admin/analysis', { headers: { 'x-test-role': role } });
    assert.equal(response.status, 200); const html = await response.text(); assert.match(html, /Crosstab/); assert.match(html, /href="\/admin\/analysis/); assert.match(html, /response-chart/);
    const csv = await fetch(base + '/admin/analysis/export', { headers: { 'x-test-role': role } }); assert.equal(csv.status, 200); assert.match(csv.headers.get('content-type'), /text\/csv/);
  }
  assert.equal((await fetch(base + '/admin/analysis', { headers: { 'x-test-role': 'client' } })).status, 403);
  assert.equal((await fetch(base + '/admin/analysis', { redirect: 'manual' })).status, 302);
  for (const [query, status] of [['study=999', 404], ['segment=invalid', 400], ['from=invalid', 400]]) assert.equal((await fetch(base + '/admin/analysis?' + query, { headers: { 'x-test-role': 'admin' } })).status, status);
});
