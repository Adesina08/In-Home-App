const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const versions = require('../lib/questionnaireVersions');
const { loadQuestionnaire, isQuestionActive } = require('../lib/questionnaire');
const { markQuestionnaireDirty, publishVersion } = require('../lib/studyVersion');
const { validateSubmission } = require('../lib/answerValidation');

let dir;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-questionnaire-versioning-'));
  await store.connect({ uri: '', file: path.join(dir, 'db.json') });
});
after(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('published questionnaire snapshots stay immutable while draft edits remain previewable', async () => {
  const { id: studyId } = await store.insert('studies', { name: 'Versioned study', status: 'live', diary_mode: 'daily', version: 1 });
  const { id: questionId } = await store.insert('questions', {
    study_id: studyId,
    order_index: 1,
    code: 'Q1',
    type: 'single',
    text: 'Published v1 wording',
    options_json: JSON.stringify(['Yes', 'No']),
  });

  await versions.ensureSnapshot(studyId, 1, { actor: 'test', source: 'test_baseline' });
  await store.update('questions', { id: questionId }, { text: 'Draft v2 wording' });
  await markQuestionnaireDirty(studyId);

  const liveV1 = await loadQuestionnaire(studyId);
  const draftV2 = await loadQuestionnaire(studyId, {}, { draft: true });
  assert.equal(liveV1.source, 'published');
  assert.equal(liveV1.questions[0].text, 'Published v1 wording');
  assert.equal(draftV2.source, 'draft');
  assert.equal(draftV2.questions[0].text, 'Draft v2 wording');

  assert.equal(await publishVersion(studyId, 'researcher@example.com'), 2);
  const liveV2 = await loadQuestionnaire(studyId);
  assert.equal(liveV2.version, 2);
  assert.equal(liveV2.questions[0].text, 'Draft v2 wording');

  await store.update('questions', { id: questionId }, { text: 'Future v3 draft' });
  await markQuestionnaireDirty(studyId);
  const stillV2 = await loadQuestionnaire(studyId);
  assert.equal(stillV2.questions[0].text, 'Draft v2 wording');
  assert.equal((await versions.getSnapshot(studyId, 1)).questions[0].text, 'Published v1 wording');
  assert.equal((await versions.getSnapshot(studyId, 2)).questions[0].text, 'Draft v2 wording');
});

test('legacy active values are interpreted consistently by builder and preview', () => {
  assert.equal(isQuestionActive({ active: 1 }), true);
  assert.equal(isQuestionActive({ active: true }), true);
  assert.equal(isQuestionActive({}), true);
  assert.equal(isQuestionActive({ active: 0 }), false);
  assert.equal(isQuestionActive({ active: false }), false);
  assert.equal(isQuestionActive({ active: '0' }), false);
});

test('multi select maximum is enforced server-side', () => {
  const question = {
    id: 99,
    code: 'snacks',
    text: 'Which brands did you buy?',
    type: 'multi',
    required: 1,
    max_selections: 4,
    options_json: JSON.stringify(['A', 'B', 'C', 'D', 'E']),
  };
  assert.deepEqual(validateSubmission({ questions: [question], rules: [], body: { q_99: ['A', 'B', 'C', 'D'] } }), []);
  const errors = validateSubmission({ questions: [question], rules: [], body: { q_99: ['A', 'B', 'C', 'D', 'E'] } });
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /Select up to 4 options/);
});
