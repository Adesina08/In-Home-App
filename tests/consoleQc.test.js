const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const { loadConsoleQc } = require('../lib/consoleQc');
let directory, study, otherStudy, respondent, otherRespondent, record, foreignRecord, question;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-console-qc-'));
  await store.connect({ uri: '', file: path.join(directory, 'data.json') });
  study = await store.insert('studies', { name: 'Review study' });
  otherStudy = await store.insert('studies', { name: 'Other study' });
  respondent = await store.insert('respondents', { study_id: study.id });
  otherRespondent = await store.insert('respondents', { study_id: otherStudy.id });
  record = await store.insert('diary_records', { study_id: study.id, respondent_id: respondent.id });
  foreignRecord = await store.insert('diary_records', { study_id: otherStudy.id, respondent_id: otherRespondent.id });
  question = await store.insert('questions', { study_id: study.id, active: 1, code: 'quantity', text: 'Quantity', type: 'numeric', order_index: 1 });
  await store.insert('questions', { study_id: study.id, active: 1, code: 'unanswered', text: 'Unanswered', type: 'text', order_index: 2 });
  const historical = await store.insert('questions', { study_id: study.id, active: 0, code: 'old', text: 'Historical answer', type: 'text', order_index: 3 });
  await store.insert('questions', { study_id: study.id, active: 0, code: 'unused', text: 'Removed without answer', type: 'text', order_index: 4 });
  await store.insert('responses', { record_id: record.id, question_id: question.id, value: 0, source: 'ai_video', verified: 0, study_version: 1 });
  await store.insert('responses', { record_id: record.id, question_id: historical.id, value: 'Earlier wording', study_version: 1 });
  await store.insert('media', { record_id: record.id, file_path: 'sample.jpg', media_type: 'photo' });
  await store.insert('media', { record_id: foreignRecord.id, file_path: 'private-other-study.jpg', media_type: 'photo' });
});
after(async () => { await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
function flag(id, recordId = record.id) { return { id, record_id: recordId, respondent_id: respondent.id }; }

test('QC review keeps zero values, unanswered questions, historical answers and AI provenance', async () => {
  const result = await loadConsoleQc(study, [flag(1)], '1');
  assert.equal(result.reviewRecord.id, record.id);
  assert.equal(result.reviewAnswers.length, 3);
  assert.deepEqual(result.reviewAnswers[0], { code: 'quantity', text: 'Quantity', value: 0, source: 'ai_video', verified: 0, study_version: 1 });
  assert.equal(result.reviewAnswers[1].value, null);
  assert.equal(result.reviewAnswers[2].value, 'Earlier wording');
  assert.equal(result.reviewMedia.length, 1);
  assert.equal(result.reviewMedia[0].file_path, 'sample.jpg');
});
test('a requested flag outside the authorized worklist cannot select another study', async () => {
  const result = await loadConsoleQc(study, [flag(1)], '999');
  assert.equal(result.selectedFlag.id, 1);
  assert.equal(result.reviewRecord.id, record.id);
});
test('an inconsistent flag cannot expose a record or media from another study', async () => {
  const result = await loadConsoleQc(study, [flag(2, foreignRecord.id)], '2');
  assert.equal(result.reviewRecord, null);
  assert.deepEqual(result.reviewAnswers, []);
  assert.deepEqual(result.reviewMedia, []);
});
test('a record belonging to another respondent is not exposed', async () => {
  const result = await loadConsoleQc(study, [{ ...flag(3), respondent_id: otherRespondent.id }], '3');
  assert.equal(result.reviewRecord, null);
});
test('empty worklists and respondent-level flags have honest empty evidence', async () => {
  assert.deepEqual(await loadConsoleQc(study, [], '1'), { selectedFlag: null, reviewRecord: null, reviewAnswers: [], reviewMedia: [] });
  const result = await loadConsoleQc(study, [flag(4, null)], '4');
  assert.equal(result.selectedFlag.id, 4);
  assert.equal(result.reviewRecord, null);
  assert.deepEqual(result.reviewMedia, []);
});
