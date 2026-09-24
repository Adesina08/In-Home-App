const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const express = require('express');
const bcrypt = require('bcryptjs');
require('express-async-errors');
const store = require('../lib/store');
const staffEmail = require('../lib/staffEmail');

let dir, server, base, sent;
before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-admin-users-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  await store.insert('studies', { name: 'Account study' });
  staffEmail.sendCredentials = async (message) => { sent = message; };
  const app = express(); app.use(express.urlencoded({ extended: true })); app.use(express.json());
  app.set('views', path.join(__dirname, '../views')); app.set('view engine', 'ejs'); app.locals.icon = require('../lib/icons').icon;
  app.use((req, res, next) => { const role = req.headers['x-test-role']; req.session = { user: role ? { role, name: 'Test user', email: `${role}@test.local` } : null }; res.locals.user = req.session.user; res.locals.currentPath = req.path; next(); });
  app.use('/admin', require('../routes/admin'));
  server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { await new Promise((resolve) => server.close(resolve)); await store.close(); await fs.rm(dir, { recursive: true, force: true }); });

test('only superadmins create users and credentials are emailed, expiring and never stored in plain text', async () => {
  const body = new URLSearchParams({ name: 'Client One', email: 'CLIENT@example.test', role: 'client', study_id: '1' });
  assert.equal((await fetch(base + '/admin/users', { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'admin' }, body })).status, 403);
  assert.equal(await store.count('users', {}), 0);
  const response = await fetch(base + '/admin/users', { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body });
  assert.equal(response.status, 302);
  const user = await store.findOne('users', { email: 'client@example.test' });
  assert.equal(user.role, 'client'); assert.equal(user.must_change_password, 1); assert.equal(user.invite_delivery_status, 'sent');
  assert.equal(sent.email, user.email); assert.equal(sent.role, 'client'); assert.equal(sent.password.length, 12); assert.equal(await bcrypt.compare(sent.password, user.password_hash), true);
  assert.ok(user.temporary_password_expires_at > store.nowSql());
  assert.equal(Object.values(user).includes(sent.password), false);
  assert.equal((await fetch(base + '/admin/users', { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body })).status, 409);
});

test('study scope accepts multiple studies for interviewers and clients', async () => {
  await store.insert('studies', { name: 'Second study' });
  await store.insert('studies', { name: 'Third study' });

  const interviewerBody = new URLSearchParams();
  interviewerBody.append('name', 'Multi Interviewer');
  interviewerBody.append('email', 'multi.interviewer@example.test');
  interviewerBody.append('role', 'interviewer');
  interviewerBody.append('study_id', '1');
  interviewerBody.append('study_id', '2');
  const interviewerResponse = await fetch(base + '/admin/users', { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: interviewerBody });
  assert.equal(interviewerResponse.status, 302);
  const interviewer = await store.findOne('users', { email: 'multi.interviewer@example.test' });
  assert.equal(interviewer.study_id, 1);
  const assignments = await store.find('interviewer_assignments', { user_id: interviewer.id });
  assert.deepEqual(assignments.map((a) => a.study_id).sort(), [1, 2]);
  assert.ok(assignments.every((a) => a.enabled === true));

  const clientBody = new URLSearchParams();
  clientBody.append('name', 'Multi Client');
  clientBody.append('email', 'multi.client@example.test');
  clientBody.append('role', 'client');
  clientBody.append('study_id', '2');
  clientBody.append('study_id', '3');
  const clientResponse = await fetch(base + '/admin/users', { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: clientBody });
  assert.equal(clientResponse.status, 302);
  const client = await store.findOne('users', { email: 'multi.client@example.test' });
  const grants = await store.find('client_grants', { user_id: client.id });
  assert.deepEqual(grants.map((g) => g.study_id).sort(), [2, 3]);
  assert.ok(grants.every((g) => g.enabled === true && g.media === true && g.text === true && g.exports === true));
});

test('inline questionnaire timing and rotation settings persist and invalid values are rejected', async () => {
  const inserted = await store.insert('questions', { study_id: 1, text: 'When?', type: 'single', required: 1, options_json: '["Morning","Evening"]', active: 1 });
  const endpoint = `${base}/admin/studies/1/questions/${inserted.id}`;
  const response = await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
    body: JSON.stringify({ rotate_options: true, every_nth_occasion: 3, from_hour_utc: 8, to_hour_utc: 20 }),
  });
  assert.equal(response.status, 200);
  const question = await store.findOne('questions', { id: inserted.id });
  assert.equal(question.rotate_options, 1);
  assert.equal(question.every_nth_occasion, 3);
  assert.equal(question.from_hour_utc, 8);
  assert.equal(question.to_hour_utc, 20);
  const invalid = await fetch(endpoint, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
    body: JSON.stringify({ every_nth_occasion: 'not-a-number' }),
  });
  assert.equal(invalid.status, 400);
  assert.equal((await store.findOne('questions', { id: inserted.id })).every_nth_occasion, 3);

  // Production contains imported Mongo rows created before optional timing
  // fields existed. An unrelated autosave must normalize both absent values
  // to null rather than rejecting them as an equal start/end hour window.
  const legacy = await store.insert('questions', { study_id: 1, text: 'Legacy question', type: 'text', active: 1 });
  const legacyResponse = await fetch(`${base}/admin/studies/1/questions/${legacy.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-test-role': 'admin' },
    body: JSON.stringify({ applicable_cadences: ['realtime'] }),
  });
  assert.equal(legacyResponse.status, 200);
  const normalized = await store.findOne('questions', { id: legacy.id });
  assert.equal(normalized.from_hour_utc, null);
  assert.equal(normalized.to_hour_utc, null);
  assert.equal(normalized.applicable_cadences, '["realtime"]');
});

test('superadmin can change a user\'s role and study scope, and only a superadmin may', async () => {
  const { id } = await store.insert('users', { name: 'Scope Target', email: 'scope.target@example.test', role: 'interviewer', password_hash: 'x' });
  await store.insert('interviewer_assignments', { study_id: 1, user_id: id, enabled: true });

  const body = new URLSearchParams(); body.append('role', 'client'); body.append('study_id', '2'); body.append('study_id', '3');
  const denied = await fetch(`${base}/admin/users/${id}/update`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'admin' }, body });
  assert.equal(denied.status, 403);

  const response = await fetch(`${base}/admin/users/${id}/update`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body });
  assert.equal(response.status, 302);
  const updated = await store.findOne('users', { id });
  assert.equal(updated.role, 'client');
  assert.equal(updated.study_id, 2);

  // The stale interviewer assignment is disabled, not left dangling, once the
  // account is no longer an interviewer.
  const staleAssignments = await store.find('interviewer_assignments', { user_id: id, enabled: true });
  assert.equal(staleAssignments.length, 0);
  const grants = await store.find('client_grants', { user_id: id, enabled: true });
  assert.deepEqual(grants.map((g) => g.study_id).sort(), [2, 3]);
});

test('cannot demote or delete the platform\'s last superadmin', async () => {
  await store.remove('users', { role: 'superadmin' });
  const { id } = await store.insert('users', { name: 'Only Super', email: 'only.super@example.test', role: 'superadmin', password_hash: 'x' });

  const demote = await fetch(`${base}/admin/users/${id}/update`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: new URLSearchParams({ role: 'admin' }) });
  assert.equal(demote.status, 400);
  assert.equal((await store.findOne('users', { id })).role, 'superadmin');

  const del = await fetch(`${base}/admin/users/${id}/delete`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: new URLSearchParams({ confirm: 'DELETE' }) });
  assert.equal(del.status, 400);
  assert.ok(await store.findOne('users', { id }));

  // A second superadmin makes the first deletable/demotable again.
  await store.insert('users', { name: 'Second Super', email: 'second.super@example.test', role: 'superadmin', password_hash: 'x' });
  const demoteOk = await fetch(`${base}/admin/users/${id}/update`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: new URLSearchParams({ role: 'admin' }) });
  assert.equal(demoteOk.status, 302);
});

test('superadmin can hard-delete a user, cleaning up dependent rows and unlinking enrolled respondents', async () => {
  const { id } = await store.insert('users', { name: 'Delete Target', email: 'delete.target@example.test', role: 'interviewer', password_hash: 'x' });
  await store.insert('interviewer_assignments', { study_id: 1, user_id: id, enabled: true });
  const { id: respondentId } = await store.insert('respondents', { study_id: 1, interviewer_id: id, respondent_code: 'R-DEL-1' });

  const withoutConfirm = await fetch(`${base}/admin/users/${id}/delete`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: new URLSearchParams({ confirm: 'nope' }) });
  assert.equal(withoutConfirm.status, 400);
  assert.ok(await store.findOne('users', { id }));

  const response = await fetch(`${base}/admin/users/${id}/delete`, { method: 'POST', redirect: 'manual', headers: { 'x-test-role': 'superadmin' }, body: new URLSearchParams({ confirm: 'delete' }) });
  assert.equal(response.status, 302);
  assert.equal(await store.findOne('users', { id }), undefined);
  assert.equal(await store.count('interviewer_assignments', { user_id: id }), 0);

  const respondent = await store.findOne('respondents', { id: respondentId });
  assert.equal(respondent.interviewer_id, null);
});
