const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const sampleStudies = require('../lib/sampleStudies');
const kpiMapping = require('../lib/kpiMapping');
const { loadStudyReport } = require('../lib/studyReport');

let dir, real, created;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-samples-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  real = await store.insert('studies', { name: 'A real study', study_type: 'in_home', status: 'live' });
  created = await sampleStudies.ensureSampleStudies();
});
after(async () => {
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

const sampleOf = (key) => store.findOne('studies', { sample_key: key });

test('creates an In-Home and an Out-of-Home sample once, next to real studies', async () => {
  assert.equal(created.length, 2);
  assert.equal((await sampleOf('in_home')).study_type, 'in_home');
  assert.equal((await sampleOf('ooh')).study_type, 'ooh');
  assert.deepEqual(await sampleStudies.ensureSampleStudies(), []);
  assert.equal(await store.count('studies', {}), 3);
  assert.equal((await store.findOne('studies', { id: real.id })).name, 'A real study');
  assert.equal(await store.count('respondents', { study_id: real.id }), 0);
});

test('every recipe KPI has a value from the mock data', async () => {
  for (const key of ['in_home', 'ooh']) {
    const study = await sampleOf(key);
    const report = await loadStudyReport(study.id);
    assert.ok(report.eligible > 100, `${key} has entries`);
    assert.ok(report.flagged > 0, `${key} has planted QC flags`);
    for (const section of await kpiMapping.recipeSections(study, report)) {
      for (const kpi of section.kpis) {
        assert.ok(['approved', 'auto'].includes(kpi.state), `${key} ${kpi.key} is ${kpi.state}`);
        assert.ok(kpi.value !== null && kpi.value !== undefined, `${key} ${kpi.key} has no value`);
      }
    }
  }
});

test('mock respondents have no contact details and get no reminders', async () => {
  const ids = (await store.find('studies', { is_sample: 1 })).map((s) => s.id);
  const people = await store.find('respondents', { study_id: { $in: ids } });
  assert.ok(people.length > 20);
  assert.ok(people.every((p) => !p.contact));
  await require('../lib/reminders').runReminderEngine();
  assert.equal(await store.count('reminders', { respondent_id: { $in: people.map((p) => p.id) } }), 0);
});

test('reset rebuilds an edited sample in place and keeps client access', async () => {
  const study = await sampleOf('ooh');
  const questions = await store.count('questions', { study_id: study.id });
  const records = await store.count('diary_records', { study_id: study.id });
  await store.update('studies', { id: study.id }, { name: 'Renamed', status: 'closed' });
  await store.remove('questions', { study_id: study.id, code: 'brand' });
  await store.insert('client_grants', { user_id: 99, study_id: study.id, media: true });

  await sampleStudies.resetSampleStudy(study.id);

  const after = await store.findOne('studies', { id: study.id });
  assert.equal(after.name, 'On-the-Go Snacks & Drinks (SAMPLE)');
  assert.equal(after.status, 'live');
  assert.equal(await store.count('questions', { study_id: study.id }), questions);
  assert.equal(await store.count('diary_records', { study_id: study.id }), records);
  assert.equal(await store.count('client_grants', { study_id: study.id }), 1);
  assert.equal(await store.count('studies', {}), 3);
});

test('only a sample study can be reset', async () => {
  await assert.rejects(sampleStudies.resetSampleStudy(real.id), /Only a sample study/);
});
