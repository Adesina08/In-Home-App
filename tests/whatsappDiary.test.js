const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
require('express-async-errors');
const store = require('../lib/store');

let dir;
let server;
let base;
let respondent;
let study;
const httpFetch = global.fetch;

function inbound(body, sid) {
  return fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: 'whatsapp:+2348012345678', Body: body, MessageSid: sid }),
  });
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-whatsapp-diary-'));
  process.env.UPLOAD_DIR = dir;
  process.env.STORAGE_PROVIDER = 'local';
  process.env.TWILIO_ACCOUNT_SID = `AC${'1'.repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
  process.env.VERIFY_TWILIO_WEBHOOKS = 'false';
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  study = await store.insert('studies', {
    name: 'WhatsApp study', status: 'live', mandatory_photo: 0, back_entry_hours: 24, version: 1,
  });
  await store.insert('consent_versions', { study_id: study.id, version: 1, status: 'approved', body: 'Approved consent' });
  respondent = await store.insert('respondents', {
    study_id: study.id, respondent_code: 'WA-001', name: 'Ada Example', contact: '+2348012345678',
    activation_status: 'active', consent_status: 'given', consent_version: 1,
    chosen_mode: 'whatsapp', preferred_channel: 'whatsapp',
  });
  await store.insert('questions', {
    id: 101, study_id: study.id, code: 'used', text: 'Did you use the product?', type: 'single',
    options_json: '["Yes","No"]', order_index: 1, required: 1,
  });
  await store.insert('questions', {
    id: 102, study_id: study.id, code: 'detail', text: 'What happened?', type: 'text',
    order_index: 2, required: 1,
  });
  await store.insert('skip_rules', {
    study_id: study.id, condition_question_id: 101, target_question_id: 102,
    operator: 'equals', value: 'Yes', action: 'show',
  });
  await store.insert('whatsapp_sessions', {
    contact: '+2348012345678', respondent_id: respondent.id, step: 'ready',
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use('/', require('../routes/whatsappWebhook'));
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('WhatsApp diary validates, applies skip logic, submits, and deduplicates webhook retries', async () => {
  let response = await inbound('DIARY', 'SM-start');
  assert.equal(response.status, 200);
  assert.match(await response.text(), /Did you use the product/);

  response = await inbound('3', 'SM-invalid');
  assert.match(await response.text(), /listed option numbers/);
  assert.equal(await store.count('diary_records', {}), 0);

  response = await inbound('1', 'SM-choice');
  assert.match(await response.text(), /What happened/);

  response = await inbound('I prepared it at home', 'SM-detail');
  const submittedReply = await response.text();
  assert.match(submittedReply, /has been submitted/);

  const record = await store.findOne('diary_records', { respondent_id: respondent.id });
  assert.equal(record.channel, 'whatsapp');
  assert.equal(record.status, 'submitted');
  const answers = await store.find('responses', { record_id: record.id }, { sort: { question_id: 1 } });
  assert.deepEqual(answers.map((item) => item.value), ['Yes', 'I prepared it at home']);

  response = await inbound('STATUS', 'SM-newer-after-submit');
  assert.match(await response.text(), /1 submitted diary entry/);
  response = await inbound('I prepared it at home', 'SM-detail');
  assert.equal(await response.text(), submittedReply);
  assert.equal(await store.count('diary_records', { respondent_id: respondent.id }), 1);
});

test('CANCEL discards an in-progress WhatsApp diary', async () => {
  let response = await inbound('DIARY', 'SM-start-two');
  assert.match(await response.text(), /Did you use the product/);
  response = await inbound('CANCEL', 'SM-cancel');
  assert.match(await response.text(), /cancelled/);
  assert.equal(await store.count('diary_records', { respondent_id: respondent.id }), 1);
  assert.equal((await store.findOne('whatsapp_sessions', { contact: '+2348012345678' })).step, 'ready');
});

test('WhatsApp diary can pause, resume, repeat and go back without losing control of the entry', async () => {
  let response = await inbound('DIARY', 'SM-controls-start');
  assert.match(await response.text(), /Did you use the product/);
  response = await inbound('1', 'SM-controls-first');
  assert.match(await response.text(), /What happened/);
  response = await inbound('PAUSE', 'SM-controls-pause');
  assert.match(await response.text(), /saved at this question/);
  assert.equal((await store.findOne('whatsapp_sessions', { contact: '+2348012345678' })).step, 'paused_diary');
  response = await inbound('CONTINUE', 'SM-controls-resume');
  assert.match(await response.text(), /What happened/);
  response = await inbound('BACK', 'SM-controls-back');
  assert.match(await response.text(), /Did you use the product/);
  response = await inbound('CANCEL', 'SM-controls-cancel');
  assert.match(await response.text(), /cancelled/);
});

test('STOP requires explicit WITHDRAW confirmation and can safely return to the diary menu', async () => {
  let response = await inbound('STOP', 'SM-stop-request');
  assert.match(await response.text(), /Reply WITHDRAW to confirm/);
  assert.equal((await store.findOne('whatsapp_sessions', { contact: '+2348012345678' })).step, 'stop_confirm');
  response = await inbound('CONTINUE', 'SM-stop-return');
  assert.match(await response.text(), /Withdrawal was not requested/);
  assert.equal((await store.findOne('whatsapp_sessions', { contact: '+2348012345678' })).step, 'ready');
  assert.equal((await store.findOne('respondents', { id: respondent.id })).withdrawn_at, undefined);
});

test('JOIN enforces browser gates, exact verified phone ownership, and does not repeat study consent', async () => {
  const blockedContact = '+2348070000001';
  await store.insert('respondents', {
    study_id: study.id, respondent_code: 'WA-BLOCKED', name: 'Blocked Person', contact: blockedContact,
    unique_token: 'blocked-token', consent_status: 'given', consent_version: 1,
    contact_verified_at: store.nowSql(), chosen_mode: 'whatsapp', activation_status: 'invited',
  });
  const post = (contact, body, sid) => httpFetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: `whatsapp:${contact}`, Body: body, MessageSid: sid }),
  });
  let response = await post(blockedContact, 'JOIN blocked-token', 'SM-join-blocked');
  assert.match(await response.text(), /complete the pre-survey/);
  assert.equal(await store.findOne('whatsapp_sessions', { contact: blockedContact }), undefined);

  const readyContact = '+2348070000002';
  const joined = await store.insert('respondents', {
    study_id: study.id, respondent_code: 'WA-JOIN', name: 'Joined Person', contact: readyContact,
    unique_token: 'ready-token', consent_status: 'given', consent_version: 1,
    presurvey_completed_at: store.nowSql(), contact_verified_at: store.nowSql(),
    chosen_mode: 'whatsapp', preferred_channel: 'whatsapp', activation_status: 'invited',
  });
  response = await post(readyContact, 'JOIN ready-token', 'SM-join-ready');
  const text = await response.text();
  assert.match(text, /remaining fields in your one-time INICIO profile/);
  assert.match(text, /Where do you currently live/);
  assert.doesNotMatch(text, /Reply YES to take part/);
  const updated = await store.findOne('respondents', { id: joined.id });
  assert.equal(updated.activation_status, 'activated');
  assert.ok(updated.account_id);
  assert.equal((await store.findOne('respondent_accounts', { id: updated.account_id })).password_hash, undefined);
});

test('MENU can switch between active WhatsApp studies for the same verified account', async () => {
  const account = await store.insert('respondent_accounts', { contact: respondent.contact, name: respondent.name });
  await store.update('respondents', { id: respondent.id }, { account_id: account.id });
  const secondStudy = await store.insert('studies', { name: 'Second WhatsApp study', status: 'live', version: 1 });
  await store.insert('consent_versions', { study_id: secondStudy.id, version: 1, status: 'approved', body: 'Second consent' });
  const second = await store.insert('respondents', {
    study_id: secondStudy.id, account_id: account.id, respondent_code: 'WA-SECOND', name: respondent.name,
    contact: respondent.contact, consent_status: 'given', consent_version: 1, chosen_mode: 'whatsapp',
    preferred_channel: 'whatsapp', activation_status: 'active', contact_verified_at: store.nowSql(), presurvey_completed_at: store.nowSql(),
  });
  let response = await inbound('MENU', 'SM-menu-studies');
  assert.match(await response.text(), /Second WhatsApp study/);
  response = await inbound('STUDY 2', 'SM-switch-study');
  assert.match(await response.text(), /Second WhatsApp study is now your current study/);
  const switchedSession = await store.findOne('whatsapp_sessions', { contact: '+2348012345678' });
  assert.ok(switchedSession, `expected WhatsApp session; found ${JSON.stringify(await store.find('whatsapp_sessions', {}))}`);
  assert.equal(switchedSession.respondent_id, second.id);
  await store.update('whatsapp_sessions', { contact: respondent.contact }, { respondent_id: respondent.id, step: 'ready' });
});

test('WhatsApp completes a due end-of-study validation without sending the respondent to the app', async () => {
  const closeStudy = await store.insert('studies', {
    name: 'Closing study', status: 'live', version: 1,
    close_out_questions: [
      { code: 'experience', text: 'How was the study?', type: 'single', options: ['Easy', 'Difficult'], required: true },
      { code: 'comments', text: 'Any final comments?', type: 'text', required: false },
    ],
  });
  const contact = '+2348070000003';
  const person = await store.insert('respondents', {
    study_id: closeStudy.id, respondent_code: 'WA-CLOSE', name: 'Close Person', contact,
    activation_status: 'active', consent_status: 'given', chosen_mode: 'whatsapp', preferred_channel: 'whatsapp',
    end_validation_status: 'pending',
  });
  await store.insert('whatsapp_sessions', { contact, respondent_id: person.id, step: 'ready' });
  const post = (body, sid) => httpFetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: `whatsapp:${contact}`, Body: body, MessageSid: sid }),
  });
  let response = await post('DIARY', 'SM-close-start');
  assert.match(await response.text(), /final study check/);
  response = await post('1', 'SM-close-answer');
  assert.match(await response.text(), /Any final comments/);
  response = await post('SKIP', 'SM-close-finish');
  assert.match(await response.text(), /final study check is complete/);
  assert.equal((await store.findOne('respondents', { id: person.id })).end_validation_status, 'completed');
  assert.deepEqual((await store.findOne('end_validations', { respondent_id: person.id })).answers, { experience: 'Easy', comments: '' });
});

test('WhatsApp photo answers are downloaded from Twilio and attached through private storage', async () => {
  const study = await store.insert('studies', { name: 'Media study', status: 'live', mandatory_photo: 1 });
  const contact = '+2348099999999';
  const person = await store.insert('respondents', {
    study_id: study.id, respondent_code: 'WA-002', name: 'Media Person', contact,
    activation_status: 'active', consent_status: 'given', chosen_mode: 'whatsapp', preferred_channel: 'whatsapp',
  });
  const question = await store.insert('questions', {
    study_id: study.id, code: 'pack', text: 'Send a pack photo', type: 'photo', order_index: 1, required: 1,
  });
  await store.insert('whatsapp_sessions', { contact, respondent_id: person.id, step: 'ready' });

  const post = (fields) => httpFetch(base, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ From: `whatsapp:${contact}`, ...fields }),
  });
  let response = await post({ Body: 'DIARY', MessageSid: 'SM-media-start' });
  assert.match(await response.text(), /Send a pack photo/);

  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    assert.equal(String(url), 'https://api.twilio.com/media/test-photo');
    assert.match(options.headers.Authorization, /^Basic /);
    return new Response(Buffer.from('private whatsapp image'), {
      status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': '22' },
    });
  };
  try {
    response = await post({
      Body: '', MessageSid: 'SM-media-file', NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/test-photo', MediaContentType0: 'image/jpeg',
    });
  } finally {
    global.fetch = originalFetch;
  }
  assert.match(await response.text(), /has been submitted/);
  const record = await store.findOne('diary_records', { respondent_id: person.id, channel: 'whatsapp' });
  const media = await store.findOne('media', { record_id: record.id });
  assert.equal(media.question_id, question.id);
  assert.equal((await require('../lib/mediaStorage').readMediaBuffer(media.file_path)).toString(), 'private whatsapp image');
  assert.equal(await store.count('qc_flags', { record_id: record.id, flag_type: 'missing_photo_evidence' }), 0);
});

test('Twilio media downloader rejects untrusted hosts and oversized attachments', async () => {
  const { download } = require('../lib/twilioMedia');
  await assert.rejects(
    download({ url: 'https://example.com/not-twilio', expectedType: 'photo', claimedContentType: 'image/jpeg', fetchImpl: async () => { throw new Error('must not fetch'); } }),
    /untrusted/,
  );
  const previous = process.env.WHATSAPP_MEDIA_MAX_BYTES;
  process.env.WHATSAPP_MEDIA_MAX_BYTES = '1024';
  try {
    await assert.rejects(
      download({
        url: 'https://api.twilio.com/media/too-large', expectedType: 'photo', claimedContentType: 'image/jpeg',
        fetchImpl: async () => new Response(Buffer.alloc(1025), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
      }),
      /exceeds/,
    );
  } finally {
    if (previous === undefined) delete process.env.WHATSAPP_MEDIA_MAX_BYTES;
    else process.env.WHATSAPP_MEDIA_MAX_BYTES = previous;
  }
});
