const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
require('express-async-errors');
const store = require('../lib/store');

let directory;
let server;
let base;
let study;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-questionnaire-options-'));
  await store.connect({ uri: '', file: path.join(directory, 'data.json') });
  study = await store.insert('studies', { name: 'Questionnaire option study' });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.set('views', path.join(__dirname, '../views'));
  app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon;
  app.use((req, res, next) => {
    req.session = { user: { role: 'admin', name: 'Test admin', email: 'admin@test.local' } };
    res.locals.user = req.session.user;
    res.locals.currentPath = req.path;
    next();
  });
  app.use('/admin', require('../routes/admin'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

async function updateOptions(questionId, options) {
  const response = await fetch(`${base}/admin/studies/${study.id}/questions/${questionId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ options }),
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

test('option reorder returns canonical options and preserves text-keyed behaviour', async () => {
  const question = await store.insert('questions', {
    study_id: study.id,
    text: 'Choose one',
    type: 'single',
    active: 1,
    options_json: JSON.stringify(['First', 'Other']),
    other_specify_options_json: JSON.stringify(['Other']),
  });
  await store.insert('skip_rules', {
    study_id: study.id,
    condition_question_id: question.id,
    operator: 'equals',
    value: 'Other',
    action: 'terminate',
    terminate_scope: 'study',
  });

  const payload = await updateOptions(question.id, ['Other', 'First']);
  assert.deepEqual(JSON.parse(payload.options_json), ['Other', 'First']);
  assert.deepEqual(JSON.parse(payload.other_specify_options_json), ['Other']);
  assert.ok(await store.findOne('skip_rules', { condition_question_id: question.id, value: 'Other' }));
});

test('adding an option returns it in options_json for the editor redraw', async () => {
  const question = await store.insert('questions', {
    study_id: study.id,
    text: 'Choose another',
    type: 'multi',
    active: 1,
    options_json: JSON.stringify(['Existing']),
  });

  const payload = await updateOptions(question.id, ['Existing', 'New option']);
  assert.deepEqual(JSON.parse(payload.options_json), ['Existing', 'New option']);
  const stored = await store.findOne('questions', { id: question.id });
  assert.deepEqual(JSON.parse(stored.options_json), ['Existing', 'New option']);
});

test('the editor merges the canonical response instead of the request options alias', async () => {
  const source = await fs.readFile(path.join(__dirname, '../views/admin/study_questionnaire_v2.ejs'), 'utf8');
  assert.match(source, /var savedQuestion = updated\.question \|\| updated;/);
  assert.match(source, /Object\.assign\(\{\}, q, savedQuestion\)/);
  assert.match(source, /type="button" id="addOpt"/);
});
