const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
const session = require("express-session");
require("express-async-errors");

const store = require("../lib/store");
const { loadQuestionnaire } = require("../lib/questionnaire");
const staffEmail = require("../lib/staffEmail");

let directory;
let server;
let base;
let studyId;
let respondentId;
let presurveyId;
let diaryId;
let sentCode;
let originalEmailSend;
let originalWhatsappNumber;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "inicio-invite-order-"));
  process.env.RESEND_API_KEY = "test-key";
  process.env.RESEND_FROM = "Inicio <sender@example.test>";
  process.env.APP_BASE_URL = "https://example.test";
  originalWhatsappNumber = process.env.WHATSAPP_BOT_NUMBER;
  process.env.WHATSAPP_BOT_NUMBER = "+15551234567";
  originalEmailSend = staffEmail.sendRespondentMessage;
  staffEmail.sendRespondentMessage = async ({ variables }) => {
    sentCode = variables.code;
    return { ok: true, body: "Test code delivery", providerMessageId: "email-test-id" };
  };
  await store.connect({ uri: "", file: path.join(directory, "data.json") });
  const study = await store.insert("studies", { name: "Invite sequence study", status: "live", recruitment_mode: "remote", join_code: "INVTEST2", diary_mode: "daily", version: 1 });
  studyId = study.id;
  await store.insert("consent_versions", { study_id: studyId, version: 1, status: "approved", body: "Approved study consent wording" });
  presurveyId = (await store.insert("questions", { study_id: studyId, active: 1, order_index: 1, code: "SCREEN", section: "Pre-survey", type: "single", text: "Are you eligible?", options_json: JSON.stringify(["Yes", "No"]), required: 1 })).id;
  diaryId = (await store.insert("questions", { study_id: studyId, active: 1, order_index: 2, code: "DIARY", section: "Daily diary", type: "text", text: "What did you consume?", required: 1 })).id;
  await require("../lib/questionnaireVersions").ensureSnapshot(studyId, 1, { actor: "test", source: "test" });
  respondentId = (await store.insert("respondents", { study_id: studyId, respondent_code: "INV-1", unique_token: "invite-order-token", activation_status: "invited" })).id;

  const app = express();
  app.set("views", path.join(__dirname, "../views"));
  app.set("view engine", "ejs");
  app.locals.icon = require("../lib/icons").icon;
  app.use(express.urlencoded({ extended: true }));
  app.use(session({ secret: "invite-order-test", resave: false, saveUninitialized: false }));
  app.use("/join", require("../routes/joinEntryBridge"));
  app.use("/join", require("../routes/join"));
  app.use("/invite", require("../routes/invitePresurvey"));
  app.use("/invite", require("../routes/inviteAppHandoff"));
  app.use("/invite", require("../routes/invite"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  staffEmail.sendRespondentMessage = originalEmailSend;
  if (originalWhatsappNumber === undefined) delete process.env.WHATSAPP_BOT_NUMBER;
  else process.env.WHATSAPP_BOT_NUMBER = originalWhatsappNumber;
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(directory, { recursive: true, force: true });
});

function request(route, options = {}) {
  return fetch(`${base}/invite/invite-order-token${route}`, { redirect: "manual", ...options });
}

test("invitation enforces introduction, consent, pre-survey, method and account in order", async () => {
  const introduction = await request("");
  assert.equal(introduction.status, 200);
  const introductionHtml = await introduction.text();
  assert.match(introductionHtml, /Read study consent/);
  assert.match(introductionHtml, /Diary access/);
  assert.equal((introductionHtml.match(/class="onboarding-step-number"/g) || []).length, 4);

  const earlyPresurvey = await request("/presurvey");
  assert.equal(earlyPresurvey.headers.get("location"), "/invite/invite-order-token/consent");
  const earlyChoice = await request("/choose", { method: "POST", body: new URLSearchParams({ mode: "app" }) });
  assert.equal(earlyChoice.headers.get("location"), "/invite/invite-order-token/consent");

  const consentPage = await request("/consent");
  const consentHtml = await consentPage.text();
  assert.match(consentHtml, /Approved study consent wording/);
  assert.equal((consentHtml.match(/class="onboarding-step-number"/g) || []).length, 4);
  const agreed = await request("/consent", { method: "POST", body: new URLSearchParams({ agree: "1", consent_version: "1" }) });
  assert.equal(agreed.headers.get("location"), "/invite/invite-order-token/presurvey");

  const presurvey = await request("/presurvey");
  const presurveyHtml = await presurvey.text();
  assert.match(presurveyHtml, /Are you eligible\?/);
  assert.doesNotMatch(presurveyHtml, /What did you consume\?/);
  assert.equal((presurveyHtml.match(/class="onboarding-step-number"/g) || []).length, 4);
  const completed = await request("/presurvey", { method: "POST", body: new URLSearchParams({ name: "Test Respondent", contact: "test@example.com", [`pq_${presurveyId}`]: "Yes" }) });
  assert.equal(completed.headers.get("location"), "/invite/invite-order-token/verify");

  const earlyAccount = await request("/account");
  assert.equal(earlyAccount.headers.get("location"), "/invite/invite-order-token/verify");
  const earlyChoiceAfterPresurvey = await request("/choose", { method: "POST", body: new URLSearchParams({ mode: "app" }) });
  assert.equal(earlyChoiceAfterPresurvey.headers.get("location"), "/invite/invite-order-token/verify");
  const verification = await request("/verify");
  const verificationHtml = await verification.text();
  assert.match(verificationHtml, /test@example.com/);
  assert.equal((verificationHtml.match(/class="onboarding-step-number"/g) || []).length, 4);
  const send = await request("/verify/send", { method: "POST" });
  assert.equal(send.headers.get("location"), "/invite/invite-order-token/verify?sent=1");
  assert.match(sentCode, /^\d{6}$/);
  const wrong = await request("/verify", { method: "POST", body: new URLSearchParams({ code: sentCode === "999999" ? "000000" : "999999" }) });
  assert.equal(wrong.status, 400);
  const verified = await request("/verify", { method: "POST", body: new URLSearchParams({ code: sentCode }) });
  assert.equal(verified.headers.get("location"), "/invite/invite-order-token/choose");

  const choice = await request("");
  const choiceHtml = await choice.text();
  assert.match(choiceHtml, /How would you like to take part\?/);
  assert.match(choiceHtml, /Phone required/);
  assert.equal((choiceHtml.match(/class="onboarding-step-number"/g) || []).length, 4);
  const whatsappWithEmail = await request("/choose", { method: "POST", body: new URLSearchParams({ mode: "whatsapp" }) });
  assert.equal(whatsappWithEmail.status, 400);
  assert.match(await whatsappWithEmail.text(), /needs a verified phone number/);
  const selected = await request("/choose", { method: "POST", body: new URLSearchParams({ mode: "app" }) });
  assert.equal(selected.headers.get("location"), "/invite/invite-order-token/account");
  const account = await request("/account");
  const accountHtml = await account.text();
  assert.match(accountHtml, /Create your INICIO Diary login/);
  assert.equal((accountHtml.match(/class="onboarding-step-number"/g) || []).length, 4);
  const created = await request("/account-app", { method: "POST", body: new URLSearchParams({ username: "invite.tester", password: "strong-pass-123", confirm_password: "strong-pass-123" }) });
  assert.equal(created.headers.get("location"), "/invite/invite-order-token/ready");
  const ready = await request("/ready");
  assert.match(await ready.text(), /Download INICIO Diary/);

  const saved = await store.findOne("respondents", { id: respondentId });
  assert.equal(saved.consent_status, "given");
  assert.ok(saved.contact_verified_at);
  assert.equal(saved.presurvey_answers[presurveyId], "Yes");
  assert.equal(saved.chosen_mode, "app");
  assert.equal(saved.activation_status, "activated");
});

test("phone entered during invite setup receives an SMS code and verifies", async () => {
  const { id } = await store.insert("respondents", {
    study_id: studyId, respondent_code: "INV-PHONE", unique_token: "invite-phone-token",
    consent_status: "given", consent_version: 1,
  });
  const presurvey = await fetch(`${base}/invite/invite-phone-token/presurvey`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ name: "Phone Respondent", contact: "0801 234 5678", [`pq_${presurveyId}`]: "Yes" }),
  });
  assert.equal(presurvey.headers.get("location"), "/invite/invite-phone-token/verify");
  const respondent = await store.findOne("respondents", { id });
  assert.equal(respondent.contact, "+2348012345678");
  const edit = await fetch(`${base}/invite/invite-phone-token/presurvey?edit=1`);
  assert.equal(edit.status, 200);
  const corrected = await fetch(`${base}/invite/invite-phone-token/presurvey`, {
    method: "POST", redirect: "manual",
    body: new URLSearchParams({ name: "Phone Respondent", contact: "0802 345 6789", [`pq_${presurveyId}`]: "Yes" }),
  });
  assert.equal(corrected.headers.get("location"), "/invite/invite-phone-token/verify");
  assert.equal((await store.findOne("respondents", { id })).contact, "+2348023456789");

  const priorProvider = process.env.MESSAGING_PROVIDER;
  const originalFetch = global.fetch;
  process.env.MESSAGING_PROVIDER = "twilio";
  process.env.TWILIO_ACCOUNT_SID = `AC${"a".repeat(32)}`;
  process.env.TWILIO_AUTH_TOKEN = "test-token";
  process.env.TWILIO_SMS_FROM_NUMBER = "+18038860281";
  let sms;
  global.fetch = async (url, options) => {
    if (String(url).includes("api.twilio.com")) {
      sms = Object.fromEntries(options.body);
      return new Response(JSON.stringify({ sid: `SM${"b".repeat(32)}` }), { status: 201, headers: { "content-type": "application/json" } });
    }
    return originalFetch(url, options);
  };
  try {
    const sent = await fetch(`${base}/invite/invite-phone-token/verify/send`, { method: "POST", redirect: "manual" });
    assert.equal(sent.headers.get("location"), "/invite/invite-phone-token/verify?sent=1");
    assert.equal(sms.To, "+2348023456789");
    const code = sms.Body.match(/\b\d{6}\b/)[0];
    const verified = await fetch(`${base}/invite/invite-phone-token/verify`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ code }),
    });
    assert.equal(verified.headers.get("location"), "/invite/invite-phone-token/choose");
    assert.ok((await store.findOne("respondents", { id })).contact_verified_at);
    const chosen = await fetch(`${base}/invite/invite-phone-token/choose`, {
      method: "POST", redirect: "manual", body: new URLSearchParams({ mode: "whatsapp" }),
    });
    assert.equal(chosen.headers.get("location"), "https://wa.me/15551234567?text=JOIN%20invite-phone-token");
    const whatsappRespondent = await store.findOne("respondents", { id });
    assert.equal(whatsappRespondent.chosen_mode, "whatsapp");
    assert.equal(whatsappRespondent.account_id, undefined);
    const directAccount = await fetch(`${base}/invite/invite-phone-token/account`, { redirect: "manual" });
    assert.equal(directAccount.headers.get("location"), "https://wa.me/15551234567?text=JOIN%20invite-phone-token");
  } finally {
    global.fetch = originalFetch;
    if (priorProvider === undefined) delete process.env.MESSAGING_PROVIDER;
    else process.env.MESSAGING_PROVIDER = priorProvider;
  }
});

test("simulated code delivery does not claim that a code was sent", async () => {
  const respondent = await store.insert("respondents", {
    study_id: studyId, respondent_code: "INV-MOCK", unique_token: "invite-mock-token",
    consent_status: "given", consent_version: 1,
    presurvey_completed_at: store.nowSql(), contact: "+2348034567890",
  });
  const priorProvider = process.env.MESSAGING_PROVIDER;
  process.env.MESSAGING_PROVIDER = "mock";
  try {
    const response = await fetch(`${base}/invite/invite-mock-token/verify/send`, { method: "POST" });
    assert.equal(response.status, 502);
    assert.match(await response.text(), /Code delivery is not configured/);
    assert.ok(!await store.findOne("otp_codes", { respondent_id: respondent.id }));
  } finally {
    if (priorProvider === undefined) delete process.env.MESSAGING_PROVIDER;
    else process.env.MESSAGING_PROVIDER = priorProvider;
  }
});

test("public study link starts at the four-step invitation introduction", async () => {
  const response = await fetch(`${base}/join/INVTEST2`, { redirect: "manual" });
  assert.equal(response.status, 302);
  const target = response.headers.get("location");
  assert.match(target, /^\/invite\/[^/]+$/);
  const introduction = await fetch(`${base}${target}`);
  assert.equal(introduction.status, 200);
  const html = await introduction.text();
  assert.match(html, /Read study consent/);
  assert.equal((html.match(/class="onboarding-step-number"/g) || []).length, 4);

  const cookie = response.headers.get("set-cookie").split(";")[0];
  const reopened = await fetch(`${base}/join/INVTEST2`, { redirect: "manual", headers: { cookie } });
  assert.equal(reopened.headers.get("location"), target);
  const respondent = await store.findOne("respondents", { unique_token: target.slice("/invite/".length) });
  assert.equal(respondent.source_join_code, "INVTEST2");
  const presurvey = await fetch(`${base}${target}/presurvey`, { redirect: "manual" });
  assert.equal(presurvey.headers.get("location"), `${target}/consent`);
});

test("respondent diary questionnaire excludes presurvey questions", async () => {
  const invitation = await loadQuestionnaire(studyId);
  assert.deepEqual(invitation.questions.map((q) => q.id), [presurveyId, diaryId]);
  const diary = await loadQuestionnaire(studyId, { respondentId });
  assert.deepEqual(diary.questions.map((q) => q.id), [diaryId]);
});
