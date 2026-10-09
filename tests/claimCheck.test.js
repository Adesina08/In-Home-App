const { test } = require('node:test');
const assert = require('node:assert/strict');
const { checkNarrative, numbersIn } = require('../lib/claimCheck');

const metrics = {
  base: { submitted_records: 1240, contributing_respondents: 34 },
  report_story: { sections: [{ measures: [{ measure: 'Brand penetration', value: 'Golden Penny · 40.25%', basis: 'of 5 households' }, { measure: 'Repurchase cycle', value: '7 days' }] }] },
  share: 0.833,
  period: { from: '2026-01-01', to: '2026-01-31' },
};

test('numbers are read with their precision, and dates, clock times and years are not figures', () => {
  const found = numbersIn('Between 2026-01-01 and 12:30 in 2026, 1,240 entries; 40% and 40.3% and -3.');
  assert.deepEqual(found.map((n) => n.text), ['1,240', '40%', '40.3%', '-3']);
  assert.equal(found.find((n) => n.text === '40.3%').decimals, 1);
});

test('figures from the snapshot support the text, rounded to the precision written', () => {
  const ok = checkNarrative('1,240 entries from 34 respondents. Golden Penny reached 40% of 5 households; 83% share; a 7 day cycle.', metrics);
  assert.equal(ok.checked, 6);
  assert.deepEqual(ok.unsupported, []);
});

test('calculated, estimated or misread numbers are listed with their context', () => {
  const result = checkNarrative('Golden Penny reached 40.4% of households, up 12 points, about 1,250 packs.', metrics);
  assert.deepEqual(result.unsupported.map((n) => n.text), ['40.4%', '12', '1,250']);
  assert.match(result.unsupported[1].context, /up 12 points/);
});
