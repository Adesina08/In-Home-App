const { test } = require('node:test');
const assert = require('node:assert/strict');
const XLSX = require('xlsx');
const { parseUpload } = require('../lib/questionnaireParser');
const { validateSubmission } = require('../lib/answerValidation');

test('questionnaire template behaviours preserve comma-containing options and termination scope', async () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{
    Code: 'Q1', Question: 'Which item?', Type: 'single',
    Options: 'Product A|Other, specify', Required: 'Yes',
    'Other specify options': 'Other, specify',
    'Terminate study options': 'Product A',
  }]), 'Questionnaire');
  const parsed = await parseUpload(XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' }), 'questionnaire.xlsx');
  assert.deepEqual(parsed.rows[0].options, ['Product A', 'Other, specify']);
  assert.deepEqual(parsed.rows[0].other_specify_options, ['Other, specify']);
  assert.deepEqual(parsed.rows[0].terminate_study_options, ['Product A']);
  assert.deepEqual(parsed.rows[0].warnings, []);
});

test('Other specify requires text only while its option and question are active', () => {
  const questions = [
    { id: 1, code: 'gate', text: 'Continue?', type: 'single', required: 1, options_json: '["Yes","No"]' },
    { id: 2, code: 'item', text: 'Which item?', type: 'single', required: 1, options_json: '["Product A","Other"]', other_specify_options_json: '["Other"]' },
  ];
  const rules = [{ condition_question_id: 1, target_question_id: 2, operator: 'equals', value: 'Yes', action: 'show' }];
  const missing = validateSubmission({ questions, rules, body: { occurrence_time: '2026-09-08T10:00:00Z', q_1: 'Yes', q_2: 'Other', other_text_json: '{}' } });
  assert.match(missing.find((item) => item.questionId === 2).message, /Please specify/);
  assert.deepEqual(validateSubmission({ questions, rules, body: { occurrence_time: '2026-09-08T10:00:00Z', q_1: 'Yes', q_2: 'Other', other_text_json: '{"2":{"Other":"Homemade blend"}}' } }), []);
  assert.deepEqual(validateSubmission({ questions, rules, body: { occurrence_time: '2026-09-08T10:00:00Z', q_1: 'No', q_2: 'Other', other_text_json: '{}' } }), []);
});
