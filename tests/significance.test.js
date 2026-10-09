const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../lib/significance');
const crosstab = require('../lib/crosstab');

const r4 = (x) => Math.round(x * 10000) / 10000;

test('the statistics reproduce reference values', () => {
  assert.equal(r4(s.normalCdf(1.96)), 0.975);
  assert.equal(r4(s.tTwoTailed(2.228, 10)), 0.05);
  assert.equal(r4(s.tTwoTailed(2.042, 30)), 0.05);
  const z = s.proportions(60, 100, 45, 100);
  assert.equal(r4(z.z), 2.124);
  assert.equal(r4(z.p), 0.0337);
  assert.equal(s.proportions(0, 10, 0, 12), null, 'nothing to test when both are 0%');
  assert.deepEqual([0, 25, 26].map(s.letter), ['A', 'Z', 'AA']);
});

// 100 entries in Lagos (60 chose Tea, spend around 50) and 100 in Abuja (45 Tea, spend around 40).
function report() {
  const questions = [
    { id: 1, code: 'drink', type: 'single', text: 'Which drink?', options_json: '["Tea","Coffee"]', order_index: 1 },
    { id: 2, code: 'city', type: 'single', text: 'Which city?', options_json: '["Lagos","Abuja"]', order_index: 2 },
    { id: 3, code: 'spend', type: 'numeric', text: 'Spend?', order_index: 3 },
  ];
  const entries = [];
  for (let i = 0; i < 200; i++) {
    const lagos = i < 100, k = lagos ? i : i - 100;
    entries.push({ recordId: i + 1, respondentId: i + 1, channel: 'app', answers: { 1: k < (lagos ? 60 : 45) ? 'Tea' : 'Coffee', 2: lagos ? 'Lagos' : 'Abuja', 3: String((lagos ? 50 : 40) + (k % 10) - 4.5) } });
  }
  return { questions, entries, respondents: entries.map((e) => ({ id: e.respondentId })) };
}

test('crosstab cells carry the letters of the columns they are significantly higher than', () => {
  const result = crosstab.buildCrosstab(report(), { side: ['q:drink', 'q:spend'], top: ['q:city'], significance: '95', minimum: 30 });
  assert.deepEqual(result.columns.map((c) => c.letter), [null, 'A', 'B']);
  const tea = result.tables[0].rows.find((r) => r.label === 'Tea');
  assert.deepEqual(tea.cells.map((c) => c.sig), [[], ['B'], []], 'Lagos 60% is higher than Abuja 45% (p = 0.034)');
  const coffee = result.tables[0].rows.find((r) => r.label === 'Coffee');
  assert.deepEqual(coffee.cells[2].sig, ['A']);
  assert.deepEqual(result.tables[1].stats[1].sig, ['B'], 'mean spend 50 vs 40 by Welch t-test');

  const strict = crosstab.buildCrosstab(report(), { side: ['q:drink'], top: ['q:city'], significance: '99', minimum: 30 });
  assert.deepEqual(strict.tables[0].rows[0].cells[1].sig, [], 'p = 0.034 is not significant at 99%');
  const lowBase = crosstab.buildCrosstab(report(), { side: ['q:drink'], top: ['q:city'], significance: '95', minimum: 150 });
  assert.deepEqual(lowBase.tables[0].rows[0].cells[1].sig, [], 'low-base columns are not tested');
  const off = crosstab.buildCrosstab(report(), { side: ['q:drink'], top: ['q:city'] });
  assert.equal(off.significance, null);

  const csv = crosstab.toCsv(result, { study: { name: 'Sig study' }, metrics: ['n', 'colPct'] });
  assert.match(csv, /"Lagos \(A\)","Abuja \(B\)"/);
  assert.match(csv, /"","Significance","","B",""/);
  assert.match(csv, /two-proportion z-test/);
});
