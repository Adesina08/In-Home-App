const { test } = require('node:test');
const assert = require('node:assert/strict');
const { generateQuestionnaire, buildPrompt } = require('../lib/questionnaireGenerator');

const study = { id: 1, name: 'Energy OOH', study_type: 'ooh', diary_mode: 'daily', category: 'Energy drinks' };
const brief = { description: 'How young adults drink energy drinks out of home.', brands: 'Red Bull, Monster', notes: '', questionCount: 10 };
const reply = (questions) => async () => JSON.stringify({ questions });

test('AI questions become import rows through the template normaliser', async () => {
  const rows = await generateQuestionnaire({ study, brief, complete: reply([
    { code: 'Q1', section: 'Screening', question: 'Did you drink an energy drink today?', type: 'single', options: ['Yes', 'No'], required: true, condition: '' },
    { code: 'Q2', section: 'Occasion', question: 'Which brand?', type: 'single', options: ['Red Bull', 'Monster', 'Other'], other_specify_options: ['Other'], condition: 'Show if Q1 equals Yes' },
    { code: 'Q3', section: 'Occasion', question: 'How much did you pay?', type: 'numeric', required: false, minimum: 0 },
    { code: 'Q4', question: '   ', type: 'text' },
  ]) });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((r) => [r.code, r.type, r.required]), [['Q1', 'single', true], ['Q2', 'single', true], ['Q3', 'numeric', false]]);
  assert.deepEqual(rows[1].options, ['Red Bull', 'Monster', 'Other']);
  assert.deepEqual(rows[1].other_specify_options, ['Other']);
  assert.equal(rows[1].condition_raw, 'Show if Q1 equals Yes');
  assert.equal(rows[2].min_value, 0);
});

test('appended questions are renumbered past existing codes, conditions included', async () => {
  const existing = [{ code: 'Q1', text: 'Age', type: 'numeric' }, { code: 'Q7', text: 'Gender', type: 'single' }];
  const rows = await generateQuestionnaire({ study, brief, existing, complete: reply([
    { code: 'Q1', question: 'Did you drink one?', type: 'single', options: ['Yes', 'No'] },
    { code: 'Q2', question: 'Where?', type: 'single', options: ['Bar', 'Office'], condition: 'Show if Q1 equals Yes' },
  ]) });
  assert.deepEqual(rows.map((r) => r.code), ['Q8', 'Q9']);
  assert.equal(rows[1].condition_raw, 'Show if Q8 equals Yes');
});

test('unknown types are flagged and invalid conditions dropped rather than guessed', async () => {
  const rows = await generateQuestionnaire({ study, brief, complete: reply([
    { code: 'Q1', question: 'Rate it', type: 'stars', options: [], condition: 'only for heavy users' },
  ]) });
  assert.equal(rows[0].type, 'text');
  assert.ok(rows[0].warnings.some((w) => /Unrecognized type/.test(w)));
  assert.equal(rows[0].condition_raw, '');
});

test('the prompt carries the brief, the KPI inputs and existing questions', () => {
  const prompt = buildPrompt(study, brief, [{ code: 'Q1', text: 'Age', type: 'numeric' }]);
  const payload = JSON.parse(prompt.slice(prompt.indexOf('{')));
  assert.match(prompt, /JSON/);
  assert.equal(payload.brief.brands_of_interest, 'Red Bull, Monster');
  assert.ok(payload.kpi_inputs.some((i) => i.role === 'brand'));
  assert.deepEqual(payload.existing_questions, [{ code: 'Q1', text: 'Age', type: 'numeric' }]);
});

test('bad AI replies surface a readable error', async () => {
  await assert.rejects(generateQuestionnaire({ study, brief, complete: async () => 'not json' }), /valid JSON/);
  await assert.rejects(generateQuestionnaire({ study, brief, complete: reply([]) }), /didn't return any questions/);
  await assert.rejects(generateQuestionnaire({ study, brief, complete: null }), /No AI provider/);
});
