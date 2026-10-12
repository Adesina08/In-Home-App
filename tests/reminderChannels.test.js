const { test } = require('node:test');
const assert = require('node:assert/strict');
const { reminderChannelsFor, reminderThresholds } = require('../lib/reminders');

const study = { reminder_channels: ['whatsapp', 'sms', 'email', 'in-app'] };

test('WhatsApp participants are reminded only on WhatsApp', () => {
  assert.deepEqual(reminderChannelsFor({ chosen_mode: 'whatsapp' }, study), ['whatsapp']);
});

test('mobile app users get no server reminders (the app schedules them on-device)', () => {
  assert.deepEqual(reminderChannelsFor({ chosen_mode: 'app' }, study), []);
});

test('respondents without a mode fall back to the study channels', () => {
  assert.deepEqual(reminderChannelsFor({ chosen_mode: null }, study), study.reminder_channels);
  assert.deepEqual(reminderChannelsFor({}, { default_reminder_channel: 'sms' }), ['sms']);
});

test('reminder thresholds follow the diary cadence unless overridden', () => {
  assert.deepEqual(reminderThresholds({ diary_mode: 'weekly' }), { dueHours: 168, missedHours: 336 });
  assert.deepEqual(reminderThresholds({ diary_mode: 'daily', reminder_due_hours: 6 }), { dueHours: 6, missedHours: 12 });
  assert.deepEqual(reminderThresholds({ reminder_due_hours: 6, reminder_missed_hours: 9 }), { dueHours: 6, missedHours: 9 });
});

const { reminderTiming, reminderTimingComparison } = require('../lib/reminders');

test('one app respondent in five keeps fixed reminder timing as the control', () => {
  assert.equal(reminderTiming({ id: 10 }), 'fixed');
  assert.equal(reminderTiming({ id: 11 }), 'habit');
});

test('timing comparison scores on-time intervals per arm for app respondents only', () => {
  const day = (d, h = 20) => `2026-10-${String(d).padStart(2, '0')} ${String(h).padStart(2, '0')}:00:00`;
  const records = [
    ...[13, 14, 15].map((d) => ({ respondent_id: 1, status: 'submitted', submit_time: day(d) })),
    { respondent_id: 5, status: 'submitted', submit_time: day(13) },
    { respondent_id: 5, status: 'submitted', submit_time: day(16) },
    { respondent_id: 5, status: 'submitted', submit_time: day(11) }, // before the experiment
    { respondent_id: 1, status: 'submitted', submit_time: day(16), is_practice: 1 },
    { respondent_id: 7, status: 'submitted', submit_time: day(13) },
  ];
  const respondents = [{ id: 1, chosen_mode: 'app' }, { id: 5, chosen_mode: 'app' }, { id: 7, chosen_mode: 'whatsapp' }];
  const result = reminderTimingComparison({ diary_mode: 'daily' }, respondents, records, Date.parse('2026-10-16T21:00:00Z'));
  // Respondent 1's open gap (25h since the last entry) is already late.
  assert.deepEqual(result.habit, { respondents: 1, entriesPerRespondent: 3, onTimeRate: 2 / 3, intervals: 3 });
  assert.deepEqual(result.fixed, { respondents: 1, entriesPerRespondent: 2, onTimeRate: 0, intervals: 1 });
});
