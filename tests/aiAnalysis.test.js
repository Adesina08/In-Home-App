const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
require('express-async-errors');
const express = require('express');
const store = require('../lib/store');
let dir, study, question, person, server, base;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-ai-analysis-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  study = await store.insert('studies', { name: 'Analysis study', minimum_base_size: 1 });
  person = await store.insert('respondents', { study_id: study.id, is_practice: 0, activation_status: 'activated', consent_status: 'given', gender: 'Outdated', participation_start: '2026-01-01' });
  await store.insert('respondent_profile_snapshots', { study_id: study.id, respondent_id: person.id, snapshot_json: JSON.stringify({ gender: 'Women', age: 29, location: 'Lagos' }) });
  question = await store.insert('questions', { study_id: study.id, code: 'brand', type: 'multi', text: 'Brands' });
  const record = await store.insert('diary_records', { study_id: study.id, respondent_id: person.id, status: 'submitted', is_practice: 0, occurrence_time: '2026-01-02', entry_mode: 'standard' });
  await store.insert('responses', { record_id: record.id, question_id: question.id, value: 'A|B', source: 'form', verified: 0 });
  await store.insert('ai_summaries', {
    study_id: study.id, period_start: null, period_end: null,
    base_records: 1, base_respondents: 1,
    metrics_json: JSON.stringify({ base: { submitted_records: 1 } }),
    open_text_json: JSON.stringify([]),
    narrative: 'A short test narrative.',
    themes_json: JSON.stringify([{ name: 'Convenience', mentions: 3, sentiment: 'positive', example: 'It was quick to grab.' }]),
    sentiment_json: JSON.stringify({ positive: 60, neutral: 30, negative: 10 }),
    provider: 'azure_openai', model: 'summary-model',
    source_signature: 'irrelevant-for-this-test',
    used_ai_model: 1, generated_by: 'test', review_status: 'draft',
  });
  const app = express();
  app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon;
  app.use((req, res, next) => { req.session = { user: req.headers['x-test-role'] ? { role: req.headers['x-test-role'], name: 'Test staff', email: 'staff@example.test' } : null }; res.locals.user = req.session.user; res.locals.currentPath = req.path; next(); });
  app.use('/admin', require('../routes/admin'));
  server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise(r => server.close(r)); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });

test('AI summary page surfaces thematic analysis, sentiment and Location/Gender/Age crosstabs for the saved summary', async () => {
  const summaries = await store.find('ai_summaries', { study_id: study.id });
  const summary = summaries[0];
  const res = await fetch(`${base}/admin/ai-summary?study=${study.id}&summary=${summary.id}`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Thematic analysis/);
  assert.match(html, /Convenience/);
  assert.match(html, /3 mentions in the sample/);
  assert.match(html, /Sentiment analysis/);
  assert.match(html, /Positive/);
  assert.match(html, /Crosstab/);
  assert.match(html, />Location<\/th>/);
  assert.match(html, />Gender<\/th>/);
  assert.match(html, />Age<\/th>/);
  assert.match(html, /Lagos/);
  assert.match(html, /Women/);
});

test('AI summary page degrades gracefully when no summary has been generated yet', async () => {
  const res = await fetch(`${base}/admin/ai-summary?study=${study.id}&from=2030-01-01&to=2030-01-02`, { headers: { 'x-test-role': 'admin' } });
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.match(html, /Generate a summary to read thematic analysis/);
  assert.match(html, /Generate a summary to read sentiment/);
});
