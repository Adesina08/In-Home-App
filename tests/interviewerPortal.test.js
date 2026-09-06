const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
require('express-async-errors');
const store = require('../lib/store');
let directory, server, base, study, own, foreign;
before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-interviewer-tests-'));
  await store.connect({ uri: '', file: path.join(directory, 'data.json') });
  study = await store.insert('studies', { name: 'Field study', status: 'live', market: 'Nigeria',screener_questions:[{code:'user',text:'Category user?',options:['Yes','No'],allowed:['Yes']}] });
  await store.insert('interviewer_assignments',{study_id:study.id,user_id:7,enabled:true});
  await store.insert('consent_versions', { study_id: study.id, status: 'approved', version: 1, body: 'Study consent wording.' });
  own = await store.insert('respondents', { study_id: study.id, interviewer_id: 7, name: 'Own respondent', respondent_code: 'OWN-1', unique_token: 'own-token', activation_status: 'completed' });
  foreign = await store.insert('respondents', { study_id: study.id, interviewer_id: 8, name: 'Private respondent', respondent_code: 'PRIVATE-1', unique_token: 'private-token', activation_status: 'activated' });
  const app = express();
  app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs');
  app.locals.icon = require('../lib/icons').icon;
  app.use(express.urlencoded({ extended: true }));
  app.use((req, res, next) => { req.session = { user: { id: 7, role: req.headers['x-test-role'] || 'interviewer', name: 'Test interviewer', email: 'test@example.test' } }; res.locals.user = req.session.user; res.locals.currentPath = req.path; next(); });
  app.use('/interviewer', require('../routes/interviewer'));
  server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}/interviewer`;
});
after(async () => { await new Promise(resolve => server.close(resolve)); await store.close(); await fs.rm(directory, { recursive: true, force: true }); });
const register = data => fetch(base + '/register', { method: 'POST', body: new URLSearchParams(data) });

test('roster includes only own recruits once, and completed respondents are not pending', async () => {
  const response = await fetch(base); const html = await response.text();
  assert.equal(response.status, 200);
  assert.equal((html.match(/data-roster-row/g) || []).length, 1);
  assert.doesNotMatch(html, /Private respondent/);
  assert.match(html, /Setup pending<\/dt><dd>0<\/dd>/);
});
test('handover and QR retain respondent ownership checks; superadmin can support any respondent', async () => {
  assert.equal((await fetch(`${base}/respondents/${foreign.id}`)).status, 404);
  assert.equal((await fetch(`${base}/respondents/${foreign.id}/qr.png`)).status, 404);
  const ownPage = await fetch(`${base}/respondents/${own.id}`);
  assert.match(await ownPage.text(), /own-token/);
  assert.equal((await fetch(`${base}/respondents/${foreign.id}`, { headers: { 'x-test-role': 'superadmin' } })).status, 200);
});
test('registration rejects unavailable studies and missing fields without creating records', async () => {
  const beforeCount = await store.count('respondents', {});
  for (const data of [
    { study_id: 999, eligible: 1, name: 'Test', contact: '08011112222' },
    { study_id: study.id, name: 'Retain this name', contact: '08011112222' },
    { study_id: study.id, eligible: 1, name: '', contact: '08011112222' },
  ]) { const response = await register(data); assert.equal(response.status, 400); }
  const failed = await register({ study_id: study.id, name: 'Retain this name', contact: '08011112222' });
  const html = await failed.text(); assert.match(html, /Retain this name/); assert.match(html, /Study consent wording/);
  const noConsent = await store.insert('studies', { name: 'Unconfigured', status: 'live' });
  assert.equal((await register({ study_id: noConsent.id, eligible: 1, name: 'Test', contact: '08011112222' })).status, 400);
  assert.equal(await store.count('respondents', {}), beforeCount);
});
test('successful registration offers a handover and duplicate contacts show the held screen', async () => {
  const data = { study_id: study.id, 'screener[user]':'Yes',consent_version:1,eligible: 1, consent_given: 1, name: 'New test recruit', contact: '08012345678', preferred_channel: 'app' };
  const response = await register(data); assert.equal(response.status, 200);
  assert.match(await response.text(), /Training and practice/);
  const duplicate = await register(data); assert.match(await duplicate.text(), /research team needs to review this/);
  const held = await store.findOne('respondents', { name: data.name }, { sort: { id: -1 } });
  const share = await fetch(`${base}/respondents/${held.id}`); const html = await share.text();
  assert.match(html, /Activation on hold/); assert.doesNotMatch(html, /data-copy-link|\/qr.png/);
});
