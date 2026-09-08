const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const staffEmail = require('../lib/staffEmail');

let dir;
let whatsappRespondent;
let smsRespondent;
let originalEmailSend;

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'inicio-messaging-routing-'));
  await store.connect({ uri: '', file: path.join(dir, 'data.json') });
  whatsappRespondent = await store.insert('respondents', { contact: '+2348011111111', preferred_channel: 'whatsapp' });
  smsRespondent = await store.insert('respondents', { contact: '+2348022222222', preferred_channel: 'app' });
  originalEmailSend = staffEmail.sendRespondentMessage;
});

after(async () => {
  staffEmail.sendRespondentMessage = originalEmailSend;
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test('email contacts use Resend while phone contacts follow respondent preference', async () => {
  process.env.MESSAGING_PROVIDER = 'mock';
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM_EMAIL = 'sender@example.test';
  process.env.APP_BASE_URL = 'https://example.test';
  let emailed = null;
  staffEmail.sendRespondentMessage = async (message) => {
    emailed = message;
    return { ok: true, body: 'email body', providerMessageId: 'email-message-id' };
  };

  const provider = require('../lib/whatsapp').getProvider();
  try {
    const emailResult = await provider.send({ to: 'person@example.test', template: 'otp_contact_verification', variables: { code: '123456' } });
    assert.equal(emailResult.ok, true);
    assert.equal(emailed.to, 'person@example.test');
    assert.equal((await store.findOne('whatsapp_outbox', { provider: 'resend_email' })).status, 'sent');
  } finally {
    staffEmail.sendRespondentMessage = originalEmailSend;
  }

  const whatsappResult = await provider.send({ respondentId: whatsappRespondent.id, to: '+2348011111111', template: 'diary_due_reminder', variables: { study: 'Test' } });
  const smsResult = await provider.send({ respondentId: smsRespondent.id, to: '+2348022222222', template: 'diary_due_reminder', variables: { study: 'Test' } });
  assert.equal(whatsappResult.simulated, true);
  assert.equal(smsResult.simulated, true);
  assert.equal((await store.findOne('whatsapp_outbox', { respondent_id: whatsappRespondent.id })).provider, 'mock_whatsapp');
  assert.equal((await store.findOne('whatsapp_outbox', { respondent_id: smsRespondent.id })).provider, 'mock_sms');
});

test('Resend accepts the full sender format and the conventional email alias', () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.APP_BASE_URL = 'https://example.test';
  process.env.RESEND_FROM = 'tech team <iniciomis@inicio-insights.com>';
  delete process.env.RESEND_FROM_EMAIL;
  delete process.env.RESEND_FROM_NAME;
  delete process.env.SENDER_EMAIL;
  assert.equal(staffEmail.configured(), true);
  assert.equal(staffEmail.fromAddress(), 'tech team <iniciomis@inicio-insights.com>');

  delete process.env.RESEND_FROM;
  process.env.SENDER_EMAIL = 'iniciomis@inicio-insights.com';
  assert.equal(staffEmail.configured(), true);
  assert.equal(staffEmail.fromAddress(), 'INICIO Diary <iniciomis@inicio-insights.com>');
});

test('Resend adapter sends the rendered message through the email API', async () => {
  process.env.RESEND_API_KEY = 're_test';
  process.env.RESEND_FROM = 'tech team <iniciomis@inicio-insights.com>';
  process.env.APP_BASE_URL = 'https://example.test';
  let request = null;
  const originalFetch = global.fetch;
  global.fetch = async (url, options) => {
    request = { url: String(url), options };
    return new Response(JSON.stringify({ id: 'resend-message-id' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  let result;
  try {
    result = await staffEmail.sendRespondentMessage({
      to: 'person@example.test',
      template: 'otp_contact_verification',
      variables: { code: '123456' },
    });
  } finally {
    global.fetch = originalFetch;
  }
  const payload = JSON.parse(request.options.body);
  assert.equal(request.url, 'https://api.resend.com/emails');
  assert.equal(request.options.method, 'POST');
  assert.equal(new Headers(request.options.headers).get('authorization'), 'Bearer re_test');
  assert.equal(payload.from, 'tech team <iniciomis@inicio-insights.com>');
  assert.equal(payload.to, 'person@example.test');
  assert.match(payload.text, /123456/);
  assert.equal(result.providerMessageId, 'resend-message-id');
});

test('Twilio uses independent SMS and WhatsApp sender numbers', async () => {
  process.env.MESSAGING_PROVIDER = 'twilio';
  process.env.TWILIO_ACCOUNT_SID = `AC${'a'.repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = 'test-token';
  process.env.TWILIO_SMS_FROM_NUMBER = '+18038860281';
  process.env.TWILIO_WHATSAPP_FROM_NUMBER = '+14155238886';
  delete process.env.TWILIO_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_SMS_MESSAGING_SERVICE_SID;
  delete process.env.TWILIO_WHATSAPP_MESSAGING_SERVICE_SID;
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (_url, options) => {
    calls.push(Object.fromEntries(options.body));
    return new Response(JSON.stringify({ sid: `SM${'b'.repeat(32)}` }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  try {
    const provider = require('../lib/whatsapp').getProvider();
    await provider.send({ respondentId: smsRespondent.id, to: '+2348022222222', channel: 'sms', template: 'otp_contact_verification', variables: { code: '123456' } });
    await provider.send({ respondentId: whatsappRespondent.id, to: '+2348011111111', channel: 'whatsapp', template: 'otp_contact_verification', variables: { code: '654321' } });
  } finally {
    global.fetch = originalFetch;
  }
  assert.equal(calls[0].From, '+18038860281');
  assert.equal(calls[0].To, '+2348022222222');
  assert.equal(calls[1].From, 'whatsapp:+14155238886');
  assert.equal(calls[1].To, 'whatsapp:+2348011111111');
});
