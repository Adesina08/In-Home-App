const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const express = require("express");
require("express-async-errors");

const store = require("../lib/store");
const whatsappFlow = require("../lib/whatsappFlow");

const httpFetch = global.fetch;
let dir;
let server;
let base;
let respondent;
let study;
let questionIds;
let originalFetch;

function inbound(fields) {
  return httpFetch(base, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      From: "whatsapp:+2348012345678",
      ...fields,
    }),
  });
}

before(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "inicio-whatsapp-flow-"));
  process.env.UPLOAD_DIR = dir;
  process.env.STORAGE_PROVIDER = "local";
  process.env.MESSAGING_PROVIDER = "twilio";
  process.env.TWILIO_ACCOUNT_SID = "AC" + "a".repeat(32);
  process.env.TWILIO_AUTH_TOKEN = "test-auth-token";
  process.env.TWILIO_WHATSAPP_FROM_NUMBER = "+14155238886";
  process.env.WHATSAPP_FLOW_TOKEN_SECRET = "test-flow-secret-that-is-long-enough";
  process.env.VERIFY_TWILIO_WEBHOOKS = "false";

  await store.connect({ uri: "", file: path.join(dir, "data.json") });
  study = await store.insert("studies", {
    name: "Flow diary study",
    status: "live",
    version: 1,
    mandatory_photo: 1,
  });
  respondent = await store.insert("respondents", {
    study_id: study.id,
    respondent_code: "FLOW-001",
    name: "Flow Respondent",
    contact: "+2348012345678",
    contact_verified_at: store.nowSql(),
    presurvey_completed_at: store.nowSql(),
    activation_status: "active",
    consent_status: "given",
    chosen_mode: "whatsapp",
    preferred_channel: "whatsapp",
  });
  const used = await store.insert("questions", {
    study_id: study.id,
    code: "used",
    text: "Did you use the product?",
    type: "single",
    options_json: JSON.stringify(["Yes", "No"]),
    order_index: 1,
    required: 1,
  });
  const detail = await store.insert("questions", {
    study_id: study.id,
    code: "detail",
    text: "What happened?",
    type: "text",
    order_index: 2,
    required: 1,
  });
  const photo = await store.insert("questions", {
    study_id: study.id,
    code: "photo",
    text: "Send a pack photo",
    type: "photo",
    order_index: 3,
    required: 1,
  });
  questionIds = { used: used.id, detail: detail.id, photo: photo.id };
  await store.insert("skip_rules", {
    study_id: study.id,
    condition_question_id: used.id,
    target_question_id: detail.id,
    operator: "equals",
    value: "Yes",
    action: "show",
  });
  await store.insert("whatsapp_sessions", {
    contact: "+2348012345678",
    respondent_id: respondent.id,
    step: "ready",
  });
  process.env.TWILIO_WHATSAPP_FLOW_CONTENT_SIDS = JSON.stringify({
    [String(study.id) + ":1"]: "HX" + "f".repeat(32),
  });

  const app = express();
  app.use(express.urlencoded({ extended: true }));
  app.use("/", require("../routes/whatsappWebhook"));
  server = app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  base = "http://127.0.0.1:" + server.address().port;

  originalFetch = global.fetch;
});

after(async () => {
  global.fetch = originalFetch;
  await new Promise((resolve) => server.close(resolve));
  await store.close();
  await fs.rm(dir, { recursive: true, force: true });
});

test("compiler creates a versioned native Flow and leaves media in WhatsApp chat", () => {
  const compiled = whatsappFlow.compileFlow({
    study: { id: 9, version: 4, name: "Test" },
    questionnaire: {
      version: 4,
      questions: [
        {
          id: 11,
          code: "choice",
          text: "Choose one",
          type: "single",
          required: 1,
          options: ["Yes", "No"],
          otherSpecifyOptions: [],
        },
        {
          id: 12,
          code: "detail",
          text: "Tell us more",
          type: "text",
          required: 1,
          options: [],
          otherSpecifyOptions: [],
        },
        {
          id: 13,
          code: "evidence",
          text: "Add evidence",
          type: "video",
          required: 1,
          options: [],
          otherSpecifyOptions: [],
        },
      ],
      rules: [{
        condition_question_id: 11,
        target_question_id: 12,
        operator: "equals",
        value: "Yes",
        action: "show",
      }],
    },
  });

  assert.equal(compiled.flow.version, "7.3");
  assert.deepEqual(compiled.includedQuestionIds, [11, 12]);
  assert.deepEqual(compiled.fallbackQuestionIds, [13]);
  assert.equal(compiled.flow.screens[0].terminal, true);
  const json = JSON.stringify(compiled.flow);
  assert.match(json, /RadioButtonsGroup/);
  assert.match(json, /q_11/);
  assert.match(json, /If/);
  assert.match(json, /Submit diary/);
});

test("signed Flow launch and submission feed the normal diary and media pipeline", async () => {
  let flowToken;
  let outboundForm;
  global.fetch = async (url, options) => {
    if (String(url).includes("/Messages.json")) {
      outboundForm = Object.fromEntries(options.body);
      flowToken = JSON.parse(outboundForm.ContentVariables)["1"];
      return new Response(JSON.stringify({ sid: "SM" + "b".repeat(32) }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (String(url) === "https://api.twilio.com/media/flow-photo") {
      return new Response(Buffer.from("flow photo"), {
        status: 200,
        headers: { "content-type": "image/jpeg", "content-length": "10" },
      });
    }
    throw new Error("Unexpected fetch " + url);
  };

  let response = await inbound({ Body: "DIARY", MessageSid: "SM-flow-start" });
  assert.equal(response.status, 200);
  const flowOutbox = await store.findOne("whatsapp_outbox", { respondent_id: respondent.id }, { sort: { id: -1 } });
  assert.equal(flowOutbox && flowOutbox.status, "sent", flowOutbox && flowOutbox.payload_json);
  assert.doesNotMatch(await response.text(), /Did you use/);
  assert.equal(outboundForm.ContentSid, "HX" + "f".repeat(32));
  assert.ok(flowToken);
  assert.equal(whatsappFlow.verifyToken(flowToken).ok, true);

  response = await inbound({
    Body: "",
    MessageSid: "SM-flow-submit",
    InteractiveData: JSON.stringify({
      flowResponse: {
        flow_token: flowToken,
        ["q_" + questionIds.used]: "o_1",
        ["q_" + questionIds.detail]: "I prepared it at home",
      },
    }),
  });
  assert.match(await response.text(), /Send a pack photo/);
  assert.equal(await store.count("diary_records", { respondent_id: respondent.id }), 0);

  response = await inbound({
    Body: "",
    MessageSid: "SM-flow-photo",
    NumMedia: "1",
    MediaUrl0: "https://api.twilio.com/media/flow-photo",
    MediaContentType0: "image/jpeg",
  });
  assert.match(await response.text(), /has been submitted/);

  const record = await store.findOne("diary_records", { respondent_id: respondent.id });
  assert.equal(record.channel, "whatsapp");
  assert.equal(record.status, "submitted");
  assert.equal(record.whatsapp_flow_token_hash, whatsappFlow.hashToken(flowToken));
  const answers = await store.find("responses", { record_id: record.id }, { sort: { question_id: 1 } });
  assert.deepEqual(answers.map((answer) => answer.value), ["Yes", "I prepared it at home"]);
  assert.equal((await store.findOne("media", { record_id: record.id })).question_id, questionIds.photo);

  response = await inbound({
    Body: "",
    MessageSid: "SM-flow-submit-replay",
    InteractiveData: JSON.stringify({ flowResponse: { flow_token: flowToken } }),
  });
  assert.match(await response.text(), /already submitted/);
  assert.equal(await store.count("diary_records", { respondent_id: respondent.id }), 1);
});

test("compiler carries earlier answers across multiple Flow screens", () => {
  const questions = Array.from({ length: 6 }, (_, index) => ({
    id: index + 101,
    code: "q" + (index + 1),
    text: "Question " + (index + 1),
    type: "text",
    required: 1,
    options: [],
    otherSpecifyOptions: [],
  }));
  const compiled = whatsappFlow.compileFlow({
    study: { id: 4, version: 2, name: "Multi-screen" },
    questionnaire: { version: 2, questions, rules: [] },
  });

  assert.equal(compiled.flow.screens.length, 2);
  const firstAction = compiled.flow.screens[0].layout.children[0].children.at(-1)["on-click-action"];
  assert.equal(firstAction.name, "navigate");
  assert.equal(firstAction.payload.q_101, "${form.q_101}");
  assert.equal(compiled.flow.screens[1].data.q_101.type, "string");
  const finalAction = compiled.flow.screens[1].layout.children[0].children.at(-1)["on-click-action"];
  assert.equal(finalAction.payload.q_101, "${data.q_101}");
  assert.equal(finalAction.payload.q_106, "${form.q_106}");
});

test("parser accepts Meta nfm_reply response_json payloads", () => {
  const parsed = whatsappFlow.submissionFrom({
    InteractiveData: JSON.stringify({
      nfm_reply: { response_json: JSON.stringify({ flow_token: "signed", q_1: "answer" }) },
    }),
  });
  assert.deepEqual(parsed, { flow_token: "signed", q_1: "answer" });
});

test("due reminder sends the versioned native Flow template", async () => {
  let outboundForm;
  global.fetch = async (url, options) => {
    assert.match(String(url), /\/Messages\.json$/);
    outboundForm = Object.fromEntries(options.body);
    return new Response(JSON.stringify({ sid: "SM" + "c".repeat(32) }), {
      status: 201,
      headers: { "content-type": "application/json" },
    });
  };

  const reminderRespondent = await store.findOne("respondents", { id: respondent.id });
  const reminderStudy = await store.findOne("studies", { id: study.id });
  const result = await whatsappFlow.sendReminder({ respondent: reminderRespondent, study: reminderStudy, requirement: "due" });
  assert.equal(result.ok, true);
  assert.equal(result.flow, true);
  assert.equal(outboundForm.ContentSid, "HX" + "f".repeat(32));
  const reminderToken = JSON.parse(outboundForm.ContentVariables)["1"];
  const checked = whatsappFlow.verifyToken(reminderToken);
  assert.equal(checked.ok, true);
  assert.equal(checked.payload.rid, respondent.id);
  assert.equal(checked.payload.qv, reminderStudy.version);
});

