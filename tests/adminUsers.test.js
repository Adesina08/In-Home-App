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
});
