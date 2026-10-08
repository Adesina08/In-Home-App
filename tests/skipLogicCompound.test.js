const { test } = require('node:test');
const assert = require('node:assert/strict');
const { visibleQuestionIds, findTerminateMatch } = require('../lib/skipLogic');

const questions = [
  { id: 1, section: null },
  { id: 2, section: null },
  { id: 3, section: null },
  { id: 4, section: 'Later' },
];
const compound = (match, extra = {}) => ({
  action: 'show',
  target_question_id: 3,
  condition_question_id: 1,
  operator: 'equals',
  value: 'Yes',
  match,
  conditions_json: JSON.stringify([
    { question_id: 1, operator: 'equals', value: 'Yes' },
    { question_id: 2, operator: 'in', value: 'A|B' },
  ]),
  ...extra,
});

test('AND rule shows its target only when every condition matches', () => {
  const rules = [compound('all')];
  assert.ok(visibleQuestionIds(questions, rules, { 1: 'Yes', 2: 'B' }).has(3));
  assert.ok(!visibleQuestionIds(questions, rules, { 1: 'Yes', 2: 'C' }).has(3));
});

test('OR rule shows its target when any condition matches', () => {
  const rules = [compound('any')];
  assert.ok(visibleQuestionIds(questions, rules, { 1: 'No', 2: 'A' }).has(3));
  assert.ok(!visibleQuestionIds(questions, rules, { 1: 'No', 2: 'C' }).has(3));
});

test('a legacy single-condition rule still works', () => {
  const rules = [{ action: 'hide', target_question_id: 2, condition_question_id: 1, operator: 'equals', value: 'No' }];
  assert.ok(!visibleQuestionIds(questions, rules, { 1: 'No' }).has(2));
  assert.ok(visibleQuestionIds(questions, rules, { 1: 'Yes' }).has(2));
});

test('several show rules on one question combine instead of the last one winning', () => {
  const rules = [
    { action: 'show', target_question_id: 3, condition_question_id: 1, operator: 'equals', value: 'Yes' },
    { action: 'show', target_question_id: 3, condition_question_id: 2, operator: 'equals', value: 'Male' },
  ];
  assert.ok(visibleQuestionIds(questions, rules, { 1: 'Yes', 2: 'Female' }).has(3));
  assert.ok(!visibleQuestionIds(questions, rules, { 1: 'No', 2: 'Female' }).has(3));
});

test('a matching hide rule wins over a matching show rule', () => {
  const rules = [
    { action: 'show', target_question_id: 3, condition_question_id: 1, operator: 'equals', value: 'Yes' },
    { action: 'hide', target_question_id: 3, condition_question_id: 2, operator: 'equals', value: 'A' },
  ];
  assert.ok(!visibleQuestionIds(questions, rules, { 1: 'Yes', 2: 'A' }).has(3));
});

test('a question in a hidden section stays hidden', () => {
  const rules = [{ action: 'hide', target_section: 'Later', condition_question_id: 1, operator: 'equals', value: 'No' }];
  assert.ok(!visibleQuestionIds(questions, rules, { 1: 'No' }).has(4));
  assert.ok(visibleQuestionIds(questions, rules, { 1: 'Yes' }).has(4));
});

test('a compound terminate rule never fires on an unanswered condition', () => {
  const rule = { ...compound('all'), action: 'terminate', target_question_id: null, conditions_json: JSON.stringify([
    { question_id: 1, operator: 'not_equals', value: 'Yes' },
    { question_id: 2, operator: 'equals', value: 'A' },
  ]) };
  assert.equal(findTerminateMatch([rule], { 2: 'A' }), null);
  assert.equal(findTerminateMatch([rule], { 1: 'No', 2: 'A' }), rule);
});

const fs = require('node:fs');
const path = require('node:path');
const { derivedValues } = require('../lib/skipLogic');

test('the mobile app ships a byte-identical copy of the logic engine', () => {
  const server = fs.readFileSync(path.join(__dirname, '../public/js/skip-logic.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(__dirname, '../expo-mobile/skipLogic.js'), 'utf8');
  assert.equal(mobile, server, 'Copy public/js/skip-logic.js to expo-mobile/skipLogic.js');
});

const survey = [
  { id: 10, type: 'single', option_scores_json: '{"Daily":3,"Weekly":1}' },
  { id: 11, type: 'text' },
  { id: 12, type: 'text' },
  { id: 13, type: 'multi', option_scores_json: '{"A":2,"B":2}' },
  { id: 14, type: 'text' },
];
const jump = (extra) => ({ action: 'skip_to', source_question_id: 10, condition_question_id: 10, operator: 'equals', ...extra });

test('skip-to hides the questions between the source and its destination', () => {
  const rules = [jump({ value: 'Never', target_question_id: 13 })];
  const visible = visibleQuestionIds(survey, rules, { 10: 'Never' });
  assert.deepEqual([...visible].sort(), [10, 13, 14]);
  assert.equal(visibleQuestionIds(survey, rules, { 10: 'Daily' }).size, 5);
});

test('jumping to the end hides everything after the source', () => {
  const rules = [jump({ value: 'Never', skip_to_end: 1 })];
  assert.deepEqual([...visibleQuestionIds(survey, rules, { 10: 'Never' })], [10]);
});

test('the default branch runs only once the source is answered and nothing else matched', () => {
  const rules = [
    jump({ value: 'Never', skip_to_end: 1 }),
    { action: 'skip_to', source_question_id: 10, is_default: 1, target_question_id: 12 },
  ];
  assert.equal(visibleQuestionIds(survey, rules, {}).size, 5);
  assert.ok(!visibleQuestionIds(survey, rules, { 10: 'Daily' }).has(11));
  assert.deepEqual([...visibleQuestionIds(survey, rules, { 10: 'Never' })], [10]);
});

test('scores add up across visible questions and drive branching', () => {
  const answers = { 10: 'Daily', 13: 'A|B' };
  assert.equal(derivedValues(survey, [], answers).score, 7);
  const rules = [{ action: 'hide', target_question_id: 14, conditions_json: JSON.stringify([{ variable: 'score', operator: 'gte', value: '7' }]) }];
  assert.ok(!visibleQuestionIds(survey, rules, answers).has(14));
  assert.ok(visibleQuestionIds(survey, rules, { 10: 'Weekly' }).has(14));
  // A question skipped by a jump stops counting towards the score.
  const skipped = [jump({ value: 'Daily', target_question_id: 14 })];
  assert.equal(derivedValues(survey, skipped, answers).score, 3);
});

test('variables are set per option, read by later rules, and stored', () => {
  const rules = [
    { action: 'set_variable', source_question_id: 10, condition_question_id: 10, operator: 'equals', value: 'Daily', variable_name: 'segment', variable_value: 'Heavy' },
    { action: 'hide', target_question_id: 11, conditions_json: JSON.stringify([{ variable: 'segment', operator: 'equals', value: 'Heavy' }]) },
  ];
  assert.ok(!visibleQuestionIds(survey, rules, { 10: 'Daily' }).has(11));
  assert.deepEqual(JSON.parse(derivedValues(survey, rules, { 10: 'Daily' }).variables_json), { segment: 'Heavy' });
  assert.equal(derivedValues(survey, rules, { 10: 'Weekly' }).variables_json, null);
});

test('QuestionPro-style ${...} pipes render as live placeholders', () => {
  const { renderPipeHtml } = require('../lib/piping');
  const html = renderPipeHtml('Hi ${respondent_name}, score ${score}, code ${custom1} <b>', { respondent: { name: 'Ada' } });
  assert.match(html, /^Hi Ada,/);
  assert.match(html, /data-pipe-ref="score"/);
  assert.match(html, /data-pipe-ref="custom1"/);
  assert.match(html, /&lt;b&gt;$/);
});

test('custom logic expressions read answers by code, score and variables', () => {
  const coded = [
    { id: 1, code: 'Q1', type: 'single', options: ['Yes', 'No'], option_scores_json: '{"Yes":4}' },
    { id: 2, code: 'Q3', type: 'multi', options: ['A', 'B', 'C'] },
    { id: 3, code: 'Q4', type: 'text' },
  ];
  const hideIf = (expression) => [{ action: 'hide', target_question_id: 3, conditions_json: JSON.stringify([{ expression }]) }];
  const hidden = (expression, answers) => !visibleQuestionIds(coded, hideIf(expression), answers).has(3);
  const answers = { 1: 'Yes', 2: 'A|C' };
  assert.ok(hidden("selectedCount('Q3') >= 2 and score > 3", answers));
  assert.ok(hidden("$survey.getSelectedOptionIndex('q1') == 1", answers));
  assert.ok(hidden("isSelected('Q3', 'C') && !isSelected('Q3', 'B')", answers));
  assert.ok(hidden("answer('Q1') == 'Yes' or number('Q9') > 1", answers));
  assert.ok(!hidden("selectedCount('Q3') > 2", answers));
  assert.ok(!hidden('constructor', answers), 'a bare name is a variable, never an object property');
});

test('expressions are parsed, not executed: anything outside the language is rejected', () => {
  const { validateExpression } = require('../public/js/skip-logic.js');
  assert.equal(validateExpression("answer('Q1') == 'Yes'"), null);
  for (const bad of ['alert(1)', 'window.location', "answer('Q1'", 'this.constructor', "fetch('x')", '1 +', '`x`']) {
    assert.ok(validateExpression(bad), `${bad} should be rejected`);
  }
});
