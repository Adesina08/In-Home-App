const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function load() {
  const source = fs.readFileSync(path.join(__dirname, '../expo-mobile/src/reminders.ts'), 'utf8');
  const ts = require('../expo-mobile/node_modules/typescript');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true } }).outputText;
  const module = { exports: {} };
  vm.runInNewContext(compiled, { module, exports: module.exports, Date, require(name) {
    if (name === 'react-native') return { Platform: { OS: 'web' } };
    if (name === 'expo-notifications') return {};
    throw new Error(name);
  } });
  return module.exports;
}
const { habitMinute, alignToHabit, planReminderTimes } = load();
const at = (day, h, m = 0) => new Date(2026, 9, day, h, m).getTime(); // local time
const minuteOf = (t) => new Date(t).getHours() * 60 + new Date(t).getMinutes();

test('finds the usual logging time and ignores the odd outlier', () => {
  assert.equal(habitMinute([at(1, 20), at(2, 20, 30), at(3, 19, 30), at(4, 9)]), 20 * 60);
});

test('averages across midnight on the clock face', () => {
  assert.equal(habitMinute([at(1, 23, 30), at(3, 0, 30), at(3, 23, 50), at(5, 0, 10)]), 0);
});

test('no habit from too few or scattered entries', () => {
  assert.equal(habitMinute([at(1, 20), at(2, 20)]), null);
  assert.equal(habitMinute([at(1, 6), at(2, 11), at(3, 15), at(4, 20), at(5, 23)]), null);
});

test('aligns to the nearest habit occurrence but never before the floor', () => {
  assert.equal(alignToHabit(at(10, 15), 20 * 60, 0), at(10, 20));
  assert.equal(alignToHabit(at(10, 2), 20 * 60, 0), at(9, 20));
  assert.equal(alignToHabit(at(10, 2), 20 * 60, at(10, 0)), at(10, 20));
});

test('habit plans move every reminder to the usual time; fixed plans do not', () => {
  const history = [at(1, 20), at(2, 20), at(3, 20)];
  const plan = { dueHours: 24, missedHours: 48, active: true, endDate: null, timing: 'habit' };
  const last = at(3, 9); // logged unusually early today
  const habit = planReminderTimes(plan, last, history, at(3, 10));
  assert.equal(habit.timing, 'habit');
  assert.ok(habit.times.every((t) => minuteOf(t.at) === 20 * 60));
  assert.ok(habit.times.every((t, i) => i === 0 || t.at - habit.times[i - 1].at >= 36e5));
  assert.ok(habit.times[0].at >= last + 12 * 36e5);
  const fixed = planReminderTimes({ ...plan, timing: 'fixed' }, last, history, at(3, 10));
  assert.equal(fixed.timing, 'fixed');
  assert.equal(fixed.times[0].at, last + 24 * 36e5);
});
