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
