const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
require("express-async-errors");

const store = require("../lib/store");
const { loadQuestionnaire } = require("../lib/questionnaire");

let directory;
let server;
let base;
let studyId;
let respondentId;
let presurveyId;
let diaryId;

before(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), "inicio-invite-order-"));
  await store.connect({ uri: "", file: path.join(directory, "data.json") });
  const study = await store.insert("studies", { name: "Invite sequence study", status: "live", diary_mode: "daily", version: 1 });
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
  app.use("/invite", require("../routes/invitePresurvey"));
  app.use("/invite", require("../routes/inviteAppHandoff"));
  app.use("/invite", require("../routes/invite"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
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
  assert.match(await introduction.text(), /Read study consent/);

  const earlyPresurvey = await request("/presurvey");
  assert.equal(earlyPresurvey.headers.get("location"), "/invite/invite-order-token/consent");
  const earlyChoice = await request("/choose", { method: "POST", body: new URLSearchParams({ mode: "app" }) });
  assert.equal(earlyChoice.headers.get("location"), "/invite/invite-order-token/consent");

  const consentPage = await request("/consent");
  assert.match(await consentPage.text(), /Approved study consent wording/);
  const agreed = await request("/consent", { method: "POST", body: new URLSearchParams({ agree: "1", consent_version: "1" }) });
  assert.equal(agreed.headers.get("location"), "/invite/invite-order-token/presurvey");

  const presurvey = await request("/presurvey");
  const presurveyHtml = await presurvey.text();
  assert.match(presurveyHtml, /Are you eligible\?/);
  assert.doesNotMatch(presurveyHtml, /What did you consume\?/);
  const completed = await request("/presurvey", { method: "POST", body: new URLSearchParams({ name: "Test Respondent", contact: "test@example.com", [`pq_${presurveyId}`]: "Yes" }) });
  assert.equal(completed.headers.get("location"), "/invite/invite-order-token/choose");

  const choice = await request("");
  assert.match(await choice.text(), /How would you like to take part\?/);
  const selected = await request("/choose", { method: "POST", body: new URLSearchParams({ mode: "app" }) });
  assert.equal(selected.headers.get("location"), "/invite/invite-order-token/account");
  const account = await request("/account");
  assert.match(await account.text(), /Create your INICIO Diary login/);
  const created = await request("/account-app", { method: "POST", body: new URLSearchParams({ username: "invite.tester", password: "strong-pass-123", confirm_password: "strong-pass-123" }) });
  assert.equal(created.headers.get("location"), "/invite/invite-order-token/ready");
  const ready = await request("/ready");
  assert.match(await ready.text(), /Download INICIO Diary/);

  const saved = await store.findOne("respondents", { id: respondentId });
  assert.equal(saved.consent_status, "given");
  assert.equal(saved.presurvey_answers[presurveyId], "Yes");
  assert.equal(saved.chosen_mode, "app");
  assert.equal(saved.activation_status, "activated");
});

test("respondent diary questionnaire excludes presurvey questions", async () => {
  const invitation = await loadQuestionnaire(studyId);
  assert.deepEqual(invitation.questions.map((q) => q.id), [presurveyId, diaryId]);
  const diary = await loadQuestionnaire(studyId, { respondentId });
  assert.deepEqual(diary.questions.map((q) => q.id), [diaryId]);
});
