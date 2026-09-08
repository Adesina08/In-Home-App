const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
require('express-async-errors');
const store = require('../lib/store');

let dir, server, base, mediaFiles;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-data-management-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use(express.json());
  app.set('views', path.join(__dirname, '../views'));
  app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon;
  app.use((req, res, next) => {
    req.session = { user: { id: 1, role: req.headers['x-test-role'] || 'superadmin', name: 'Root', email: 'root@test.local' } };
    res.locals.user = req.session.user;
    res.locals.currentPath = req.path;
    next();
  });
  app.use('/admin', require('../routes/superadmin'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await Promise.all((mediaFiles || []).map((file) => fs.rm(file, { force: true })));
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('bulk deletion removes selected respondents, linked records and physical media', async () => {
  const study = await store.insert('studies', { name: 'Delete test' });
  const account = await store.insert('respondent_accounts', { contact: '+2348000000000' });
  const profile = await store.insert('respondent_profiles', { account_id: account.id, name: 'Delete me' });
  await store.update('respondent_accounts', { id: account.id }, { profile_id: profile.id });
  const respondents = [];
  mediaFiles = [];
  for (let index = 0; index < 2; index += 1) {
    const respondent = await store.insert('respondents', {
      study_id: study.id,
      respondent_code: `DEL-00${index + 1}`,
      account_id: index === 0 ? account.id : null,
      profile_id: index === 0 ? profile.id : null,
      name: `Person ${index + 1}`,
      contact: `+234800000000${index}`,
    });
    respondents.push(respondent);
    const record = await store.insert('diary_records', { study_id: study.id, respondent_id: respondent.id, status: 'submitted' });
    await store.insert('responses', { record_id: record.id, question_id: 1, value: 'Answer' });
    await store.insert('otp_codes', { respondent_id: respondent.id, contact: respondent.contact, code_hash: 'hash' });
    const filename = `delete-test-${process.pid}-${index}.jpg`;
    const fullPath = path.join(__dirname, '../uploads', filename);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, 'private evidence');
    mediaFiles.push(fullPath);
    await store.insert('media', { record_id: record.id, file_path: `/uploads/${filename}` });
  }
  const stagedName = `delete-test-staged-${process.pid}.jpg`;
  const stagedPath = path.join(__dirname, '../uploads', stagedName);
  await fs.writeFile(stagedPath, 'staged evidence');
  mediaFiles.push(stagedPath);
  await store.insert('staged_media', { respondent_id: respondents[0].id, file_path: `/uploads/${stagedName}` });

  const body = new URLSearchParams({ study_id: String(study.id), confirm: 'DELETE' });
  respondents.forEach((item) => body.append('respondent_ids', String(item.id)));
  const response = await fetch(`${base}/admin/data-management/respondents/delete`, {
    method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body,
  });
  assert.equal(response.status, 302);
  assert.equal(await store.count('respondents', { study_id: study.id }), 0);
  assert.equal(await store.count('diary_records', { study_id: study.id }), 0);
  assert.equal(await store.count('responses', {}), 0);
  assert.equal(await store.count('media', {}), 0);
  assert.equal(await store.count('staged_media', {}), 0);
  assert.equal(await store.count('otp_codes', {}), 0);
  assert.equal(await store.count('respondent_accounts', { id: account.id }), 0);
  assert.equal(await store.count('respondent_profiles', { id: profile.id }), 0);
  for (const file of mediaFiles) await assert.rejects(fs.access(file));
  assert.equal(await store.count('studies', { id: study.id }), 1);
});
