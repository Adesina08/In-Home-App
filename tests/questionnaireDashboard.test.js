const { test } = require('node:test');
const assert = require('node:assert/strict');
const { buildQuestionnaireDashboard } = require('../lib/questionnaireDashboard');

function fixture() {
  return {
    questions: [
      { id: 1, order_index: 1, section: 'Consumption', code: 'drink', type: 'single', text: 'Which drink?', options_json: '["Tea","Coffee"]' },
      { id: 2, order_index: 2, section: 'Consumption', code: 'reasons', type: 'multi', text: 'Why this choice?', options_json: '["Taste","Price","Habit"]' },
      { id: 3, order_index: 3, section: 'Experience', code: 'spend', type: 'numeric', text: 'How much did you spend?' },
      { id: 4, order_index: 4, section: 'Experience', code: 'rating', type: 'scale', text: 'Rate the experience', min_value: 1, max_value: 5 },
      { id: 5, order_index: 5, section: 'Experience', code: 'describe', type: 'longtext', text: 'Describe the moment' },
      { id: 6, order_index: 6, section: 'Evidence', code: 'photo', type: 'photo', text: 'Show the product' },
    ],
    eligibleRecords: [
      { id: 101, respondent_id: 10 },
      { id: 102, respondent_id: 20 },
    ],
    answers: [
      { record_id: 101, question_id: 1, value: 'Tea' },
      { record_id: 102, question_id: 1, value: 'Coffee' },
      { record_id: 101, question_id: 2, value: 'Taste|Habit' },
      { record_id: 102, question_id: 2, value: 'Price' },
      { record_id: 101, question_id: 3, value: '10' },
      { record_id: 102, question_id: 3, value: '20' },
      { record_id: 101, question_id: 4, value: '4' },
      { record_id: 102, question_id: 4, value: '5' },
      { record_id: 101, question_id: 5, value: 'Relaxing evening tea ritual' },
      { record_id: 102, question_id: 5, value: 'Relaxing coffee moment' },
    ],
    media: [
      { record_id: 101, question_id: 6, media_type: 'photo', detected_brand: 'Example' },
      { record_id: 102, question_id: 6, media_type: 'photo' },
    ],
  };
}

function charts(result) {
  return result.sections.flatMap(section => section.charts);
}

test('questionnaire sections and types generate matching dashboard visuals', () => {
  const result = buildQuestionnaireDashboard(fixture());
  assert.deepEqual(result.sections.map(section => section.name), ['Consumption', 'Experience', 'Evidence']);
  assert.equal(result.chartCount, 6);

  const generated = charts(result);
  const drink = generated.find(chart => chart.code === 'drink');
  assert.equal(drink.kind, 'distribution');
  assert.deepEqual(drink.items, [{ label: 'Tea', n: 1 }, { label: 'Coffee', n: 1 }]);

  const spend = generated.find(chart => chart.code === 'spend');
  assert.deepEqual(spend.metrics, [
    { label: 'Average', value: 15 },
    { label: 'Median', value: 15 },
    { label: 'Minimum', value: 10 },
    { label: 'Maximum', value: 20 },
  ]);
  assert.equal(generated.find(chart => chart.code === 'rating').average, 4.5);
  assert.deepEqual(generated.find(chart => chart.code === 'describe').items.slice(0, 2), [{ label: 'relaxing', n: 2 }, { label: 'coffee', n: 1 }]);
  assert.deepEqual(generated.find(chart => chart.code === 'photo').metrics, [
    { label: 'Files', value: 2 },
    { label: 'Transcribed', value: 0 },
    { label: 'Brand detected', value: 1 },
  ]);
});

test('client options suppress small cells and honour text and media permissions', () => {
  const result = buildQuestionnaireDashboard(fixture(), { minimumBase: 2, allowText: false, allowMedia: false });
  const generated = charts(result);
  assert.equal(generated.some(chart => chart.kind === 'text'), false);
  assert.equal(generated.some(chart => chart.kind === 'media'), false);
  assert.deepEqual(generated.find(chart => chart.code === 'drink').items, []);
  assert.ok(generated.find(chart => chart.code === 'spend'));
});

test('suppressed selections return no generated question results', () => {
  assert.deepEqual(buildQuestionnaireDashboard(fixture(), { suppressed: true }), { sections: [], chartCount: 0, omittedCount: 0 });
});
