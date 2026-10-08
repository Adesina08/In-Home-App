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

test('exclusive options save on multi-select, follow renames and are rejected when combined', async () => {
  const question = await store.insert('questions', {
    study_id: study.id,
    text: 'Which brands?',
    type: 'multi',
    active: 1,
    options_json: JSON.stringify(['Brand A', 'Brand B', 'None of these', "Don't know"]),
  });
  const save = (option, body) => fetch(`${base}/admin/studies/${study.id}/questions/${question.id}/option-behaviour`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ option, terminate_scope: '', allows_specify: false, ...body }),
  }).then((r) => r.json());

  await save('None of these', { exclusive: true, terminate_scope: 'study' });
  const { question: saved } = await save("Don't know", { exclusive: true });
  assert.deepEqual(JSON.parse(saved.exclusive_options_json), ['None of these', "Don't know"]);
  assert.ok(await store.findOne('skip_rules', { condition_question_id: question.id, value: 'None of these', action: 'terminate' }));

  const renamed = await updateOptions(question.id, ['Brand A', 'Brand B', 'None', "Don't know"]);
  assert.deepEqual(JSON.parse(renamed.exclusive_options_json), ['None', "Don't know"]);

  const { validateSubmission } = require('../lib/answerValidation');
  const q = await store.findOne('questions', { id: question.id });
  const problems = (answer) => validateSubmission({ questions: [q], rules: [], body: { [`q_${q.id}`]: answer.split('|') } });
  assert.equal(problems('None|Brand A').length, 1);
  assert.equal(problems("None|Don't know").length, 1);
  assert.deepEqual(problems('None'), []);
  assert.deepEqual(problems('Brand A|Brand B'), []);
});

test('exclusive options are ignored on single-choice questions', () => {
  const { exclusiveOptionsOf } = require('../lib/questionnaire');
  assert.deepEqual(exclusiveOptionsOf({ type: 'single', exclusive_options_json: '["None"]' }), []);
  assert.deepEqual(exclusiveOptionsOf({ type: 'multi', exclusive_options_json: '["None"]' }), ['None']);
});

test('skip-logic route stores a compound rule and rejects a condition from another study', async () => {
  const [a, b, target] = await Promise.all(['Q A', 'Q B', 'Target'].map((text) =>
    store.insert('questions', { study_id: study.id, text, type: 'single', active: 1, options_json: '["Yes","No"]' })));
  const post = (body) => fetch(`${base}/admin/studies/${study.id}/skip-logic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ target_type: 'question', target_question_id: target.id, action: 'show', ...body }),
  });
  const response = await post({ match: 'any', conditions: [
    { question_id: a.id, operator: 'equals', value: 'Yes' },
    { question_id: b.id, operator: 'in', value: 'Yes, No' },
  ] });
  assert.equal(response.status, 200);
  const rule = await response.json();
  assert.equal(rule.match, 'any');
  assert.equal(rule.condition_question_id, a.id);
  assert.deepEqual(JSON.parse(rule.conditions_json).map((c) => c.value), ['Yes', 'Yes|No']);

  const other = await store.insert('studies', { name: 'Other study' });
  const foreign = await store.insert('questions', { study_id: other.id, text: 'Foreign', type: 'text', active: 1 });
  const rejected = await post({ conditions: [{ question_id: foreign.id, operator: 'equals', value: 'x' }] });
  assert.equal(rejected.status, 400);
});

test('option-logic saves jumps, a default branch, scores and variables, and only jumps forward', async () => {
  const made = [];
  for (const [i, text] of ['Source', 'Middle', 'Last'].entries()) {
    made.push(await store.insert('questions', { study_id: study.id, text, type: i ? 'text' : 'single', active: 1, order_index: 500 + i, options_json: i ? null : '["Yes","No"]' }));
  }
  const [q, , end] = made;
  const post = (body) => fetch(`${base}/admin/studies/${study.id}/questions/${q.id}/option-logic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify(body),
  });
  const response = await post({ jumps: { No: String(end.id) }, default_jump: 'end', scores: { Yes: 5 }, variables: { Yes: { name: 'buyer', value: '' } } });
  assert.equal(response.status, 200, await response.clone().text());
  const data = await response.json();
  assert.deepEqual(JSON.parse(data.question.option_scores_json), { Yes: 5 });
  const mine = data.rules.filter((r) => r.source_question_id === q.id);
  assert.ok(mine.some((r) => r.action === 'skip_to' && r.value === 'No' && r.target_question_id === end.id));
  assert.ok(mine.some((r) => r.action === 'skip_to' && r.is_default && r.skip_to_end));
  assert.ok(mine.some((r) => r.action === 'set_variable' && r.variable_name === 'buyer' && r.variable_value === 'Yes'));

  // Saving again replaces the table rather than adding to it.
  const again = await (await post({ jumps: {}, scores: {}, variables: {} })).json();
  assert.equal(again.rules.filter((r) => r.source_question_id === q.id).length, 0);

  const backwards = await fetch(`${base}/admin/studies/${study.id}/questions/${end.id}/option-logic`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({}),
  });
  assert.equal(backwards.status, 404); // not a choice question
  const badJump = await post({ jumps: { Yes: String(q.id) } });
  assert.equal(badJump.status, 400);
});

test('skip-logic route stores a custom logic rule and rejects an invalid expression', async () => {
  const target = await store.insert('questions', { study_id: study.id, text: 'Custom target', type: 'text', active: 1 });
  const post = (expression) => fetch(`${base}/admin/studies/${study.id}/skip-logic`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' },
    body: JSON.stringify({ action: 'hide', target_type: 'question', target_question_id: target.id, conditions: [{ expression }] }),
  });
  const ok = await post("selectedCount('Q3') >= 2");
  assert.equal(ok.status, 200);
  assert.deepEqual(JSON.parse((await ok.json()).conditions_json), [{ expression: "selectedCount('Q3') >= 2" }]);
  const bad = await post('alert(1)');
  assert.equal(bad.status, 400);
  assert.match((await bad.json()).error, /Unknown function/);
});

test('questionnaire import turns logic columns into scores, jumps, variables and custom logic', async () => {
  const { parseUpload } = require('../lib/questionnaireParser');
  assert.equal(typeof parseUpload, 'function');
  const csv = [
    'Code,Question,Type,Options,Exclusive options,Option scores,Skip logic,Default jump,Set variables,Custom logic',
    'S1,How often?,single,Daily|Weekly|Never,,Daily=3|Weekly=1,Never=END,S3,Daily=segment:Heavy,',
    'S2,Why?,text,,,,,,,Hide if score < 3',
    'S3,Which?,multi,A|B|None,None,A=2,,,,Jump to END if selectedCount(\'S3\') > 1',
    'S4,Last,text,,,,,,,',
  ].join('\n');
  const parsed = await parseUpload(Buffer.from(csv), 'logic.csv');
  const [first, second, third] = parsed.rows;
  assert.deepEqual(first.option_scores, { Daily: 3, Weekly: 1 });
  assert.deepEqual(first.jumps, { Never: 'END' });
  assert.equal(first.default_jump, 'S3');
  assert.deepEqual(first.variables, { Daily: { name: 'segment', value: 'Heavy' } });
  assert.deepEqual(second.custom_logic, { action: 'hide', target: null, expression: 'score < 3' });
  assert.deepEqual(third.exclusive_options, ['None']);
  assert.deepEqual(third.custom_logic, { action: 'skip_to', target: 'END', expression: "selectedCount('S3') > 1" });

  const bad = await parseUpload(Buffer.from('Code,Question,Type,Options,Custom logic\nX1,Q,text,,Show if alert(1)'), 'bad.csv');
  assert.ok(bad.rows[0].warnings.some((w) => /Unknown function/.test(w)));
  assert.equal(bad.rows[0].custom_logic, null);
});

test('committing an import creates the logic rules and option scores', async () => {
  const { parseUpload } = require('../lib/questionnaireParser');
  const target = await store.insert('studies', { name: 'Import logic study' });
  const csv = [
    'Code,Question,Type,Options,Option scores,Skip logic,Default jump,Set variables,Custom logic',
    'I1,How often?,single,Daily|Never,Daily=3,Never=END,I3,Daily=segment,',
    'I2,Why?,text,,,,,,Hide if score < 3',
    'I3,Last,text,,,,,,',
  ].join('\n');
  const parsed = await parseUpload(Buffer.from(csv), 'logic.csv');
  const imp = await store.insert('question_imports', { study_id: target.id, payload_json: JSON.stringify(parsed.rows), warnings_json: '[]' });
  const form = new URLSearchParams();
  parsed.rows.forEach((row, i) => {
    form.set(`rows[${i}][include]`, '1');
    form.set(`rows[${i}][code]`, row.code);
    form.set(`rows[${i}][text]`, row.text);
    form.set(`rows[${i}][type]`, row.type);
    form.set(`rows[${i}][options]`, row.options.join('|'));
  });
  const response = await fetch(`${base}/admin/studies/${target.id}/questionnaire/preview/${imp.id}/commit`, { method: 'POST', body: form, redirect: 'manual' });
  assert.equal(response.status, 302);
  assert.match(response.headers.get('location'), /rulesCreated=4&rulesSkipped=0/);

  const questions = await store.find('questions', { study_id: target.id }, { sort: { order_index: 1 } });
  const [i1, i2, i3] = questions;
  assert.deepEqual(JSON.parse(i1.option_scores_json), { Daily: 3 });
  const rules = await store.find('skip_rules', { study_id: target.id });
  assert.ok(rules.some((r) => r.action === 'skip_to' && r.value === 'Never' && r.skip_to_end));
  assert.ok(rules.some((r) => r.action === 'skip_to' && r.is_default && r.target_question_id === i3.id));
  assert.ok(rules.some((r) => r.action === 'set_variable' && r.variable_name === 'segment' && r.variable_value === 'Daily'));
  assert.ok(rules.some((r) => r.action === 'hide' && r.target_question_id === i2.id && /score < 3/.test(r.conditions_json)));
});

test('a "Skip logic" column holds jumps in new templates and conditions in older files', async () => {
  const { parseUpload } = require('../lib/questionnaireParser');
  const csv = 'Code,Question,Type,Options,Skip logic\nA1,One?,single,Yes|No,No=END\nA2,Two?,text,,Show if Q1 equals Yes';
  const { rows } = await parseUpload(Buffer.from(csv), 'mixed.csv');
  assert.deepEqual(rows[0].jumps, { No: 'END' });
  assert.equal(rows[0].condition_raw, '');
  assert.equal(rows[1].condition_raw, 'Show if Q1 equals Yes');
  assert.deepEqual(rows[1].warnings, []);
});
