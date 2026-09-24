const crypto = require("crypto");
const store = require("./store");
const { canonical } = require("./contact");
const whatsappDiary = require("./whatsappDiary");
const messaging = require("./whatsapp");

const FLOW_TYPES = new Set(["text", "single", "multi", "numeric", "scale", "date", "time"]);
const MEDIA_TYPES = new Set(["photo", "video", "audio"]);
const QUESTIONS_PER_SCREEN = 5;
const MAX_SCREENS = 10;
const SCREEN_NAMES = ["ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE", "TEN"];

function env(name) {
  return String(process.env[name] || "").trim();
}

function tokenSecret() {
  const value = env("WHATSAPP_FLOW_TOKEN_SECRET") || env("SESSION_SECRET");
  if (!value) return null;
  if (process.env.NODE_ENV === "production" && value === "dev-only-insecure-secret-change-me") return null;
  return value;
}

function tokenTtlSeconds() {
  const value = Number(env("WHATSAPP_FLOW_TOKEN_TTL_SECONDS") || 259200);
  return Number.isFinite(value) && value >= 300 ? Math.floor(value) : 259200;
}

function encode(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function hashToken(token) {
  return crypto.createHash("sha256").update(String(token)).digest("hex");
}

function issueToken({ respondentId, studyId, questionnaireVersion, occurrenceTime, occasionNumber }) {
  const secret = tokenSecret();
  if (!secret) throw new Error("WHATSAPP_FLOW_TOKEN_SECRET (or SESSION_SECRET) is required to launch a WhatsApp Flow.");
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    v: 1,
    rid: Number(respondentId),
    sid: Number(studyId),
    qv: Number(questionnaireVersion) || 1,
    occ: occurrenceTime,
    n: Number(occasionNumber) || 1,
    iat: now,
    exp: now + tokenTtlSeconds(),
    jti: crypto.randomBytes(12).toString("hex"),
  };
  const body = encode(payload);
  const signature = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  const token = body + "." + signature;
  return { token, tokenHash: hashToken(token), payload };
}

function verifyToken(token) {
  const secret = tokenSecret();
  const parts = String(token || "").split(".");
  if (!secret || parts.length !== 2) return { ok: false, error: "This diary form link is invalid." };
  const expected = crypto.createHmac("sha256", secret).update(parts[0]).digest();
  let supplied;
  try {
    supplied = Buffer.from(parts[1], "base64url");
  } catch (_) {
    return { ok: false, error: "This diary form link is invalid." };
  }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) {
    return { ok: false, error: "This diary form link is invalid." };
  }
  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch (_) {
    return { ok: false, error: "This diary form link is invalid." };
  }
  const now = Math.floor(Date.now() / 1000);
  if (payload.v !== 1 || !payload.rid || !payload.sid || !payload.exp || payload.exp < now) {
    return { ok: false, error: "This diary form has expired. Reply DIARY to open a new one." };
  }
  return { ok: true, payload, tokenHash: hashToken(token) };
}

function parseJson(value) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (_) {
    return null;
  }
}

function submissionFrom(body) {
  const interactive = parseJson(body && body.InteractiveData);
  const flowData = parseJson(body && body.FlowData);
  const value = interactive || flowData;
  if (!value) return null;
  const reply = value.nfm_reply || value.flowResponse || value;
  const responseJson = parseJson(reply && (reply.response_json || reply.responseJson));
  const submitted = responseJson || (reply && typeof reply === "object" ? reply : null);
  return submitted && submitted.flow_token ? submitted : null;
}

function isStartCommand(value) {
  return ["diary", "start", "new", "new diary"].includes(String(value || "").trim().toLowerCase());
}

async function launch({ session, contact, saveSession, source = "chat" }) {
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  const study = respondent ? await store.findOne("studies", { id: respondent.study_id }) : null;
  const today = store.nowSql().slice(0, 10);
  if (respondent.end_validation_status === "pending" || study.status === "closed" ||
      (study.end_date && study.end_date < today)) return { launched: false };

  if (!respondent || !study) return { launched: false };

  let contentSid;
  try {
    contentSid = messaging.whatsappFlowContentSid(study.id, study.version);
  } catch (error) {
    return { launched: false, error: error.message };
  }
  if (!contentSid) return { launched: false };
  if (!respondent.presurvey_completed_at || !respondent.contact_verified_at || respondent.chosen_mode !== "whatsapp") {
    return { launched: false, message: "Please reopen your INICIO invitation and finish the required browser steps before starting a WhatsApp diary." };
  }

  const occurrenceTime = new Date().toISOString();
  const occasionNumber = (await store.count("diary_records", {
    respondent_id: respondent.id,
    status: "submitted",
    is_practice: 0,
  })) + 1;
  let issued;
  try {
    issued = issueToken({
      respondentId: respondent.id,
      studyId: study.id,
      questionnaireVersion: study.version,
      occurrenceTime,
      occasionNumber,
    });
  } catch (error) {
    return { launched: false, error: error.message };
  }

  const begun = await whatsappDiary.beginDiary(session, saveSession, {
    occurrenceTime,
    occasionNumber,
    flowTokenHash: issued.tokenHash,
    questionnaireVersion: study.version,
  });
  if (!begun.ok) return { launched: false, message: begun.message };

  const sent = await messaging.sendWhatsAppFlow({
    respondentId: respondent.id,
    to: contact,
    contentSid,
    flowToken: issued.token,
    studyName: study.name,
    source,
  }).catch((error) => ({ ok: false, error: error.message }));

  if (sent && sent.ok && !sent.simulated) {
    return { launched: true, message: "Open the diary form in the WhatsApp message above." };
  }

  return {
    launched: false,
    message: await whatsappDiary.advance(begun.session, saveSession),
    error: sent && sent.error,
  };
}

async function sendReminder({ respondent, study, requirement = "due" }) {
  if (!respondent || !study || respondent.chosen_mode !== "whatsapp" ||
      respondent.consent_status !== "given" || !respondent.presurvey_completed_at ||
      !respondent.contact_verified_at) return null;
  const today = store.nowSql().slice(0, 10);
  if (respondent.end_validation_status === "pending" || study.status === "closed" ||
      (study.end_date && study.end_date < today)) return null;
  let contentSid;
  try {
    contentSid = messaging.whatsappFlowContentSid(study.id, study.version);
  } catch (_) {
    return null;
  }
  if (!contentSid) return null;

  const session = await store.findOne("whatsapp_sessions", { contact: canonical(respondent.contact) });
  if (session && session.step !== "ready") return null;

  const occurrenceTime = new Date().toISOString();
  const occasionNumber = (await store.count("diary_records", {
    respondent_id: respondent.id,
    status: "submitted",
    is_practice: 0,
  })) + 1;
  let issued;
  try {
    issued = issueToken({
      respondentId: respondent.id,
      studyId: study.id,
      questionnaireVersion: study.version,
      occurrenceTime,
      occasionNumber,
    });
  } catch (_) {
    return null;
  }

  const sent = await messaging.sendWhatsAppFlow({
    respondentId: respondent.id,
    to: respondent.contact,
    contentSid,
    flowToken: issued.token,
    studyName: study.name,
    source: "reminder",
  }).catch(() => null);
  return sent && sent.ok && !sent.simulated
    ? { ...sent, flow: true, requirement }
    : null;
}

async function handleSubmission({ contact, body, session, saveSession }) {
  const submitted = submissionFrom(body);
  if (!submitted) return null;
  const checked = verifyToken(submitted.flow_token);
  if (!checked.ok) return checked.error;

  const respondent = await store.findOne("respondents", { id: Number(checked.payload.rid) });
  if (!respondent || Number(respondent.study_id) !== Number(checked.payload.sid)) {
    return "We could not match this diary form to an active study invitation.";
  }
  if (!respondent.presurvey_completed_at || !respondent.contact_verified_at || respondent.chosen_mode !== "whatsapp") {
    return "Please reopen your INICIO invitation and finish the required browser steps before using this diary form.";
  }

  if (canonical(respondent.contact) !== canonical(contact)) {
    return "This diary form belongs to a different verified WhatsApp number.";
  }
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study || Number(study.version || 1) !== Number(checked.payload.qv)) {
    return "The study questionnaire changed after this form was opened. Reply DIARY to open the current version.";
  }

  const existingRecord = await store.findOne("diary_records", {
    respondent_id: respondent.id,
    whatsapp_flow_token_hash: checked.tokenHash,
  });
  if (existingRecord) return "This WhatsApp diary form was already submitted.";

  let current = session;
  const diaryInProgress = current && ["diary", "paused_diary"].includes(current.step);
  if (current && !["ready", "diary", "paused_diary"].includes(current.step)) {
    return "Finish or cancel your current WhatsApp step before opening this diary form.";
  }
  if (diaryInProgress && current.diary_flow_token_hash !== checked.tokenHash) {
    return "You have another diary entry in progress. Reply CANCEL to discard it, then open this form again.";
  }
  if (!current || current.respondent_id !== respondent.id || current.diary_flow_token_hash !== checked.tokenHash) {
    current = await saveSession({ respondent_id: respondent.id, step: "ready" });
    const begun = await whatsappDiary.beginDiary(current, saveSession, {
      occurrenceTime: checked.payload.occ,
      occasionNumber: checked.payload.n,
      flowTokenHash: checked.tokenHash,
      questionnaireVersion: checked.payload.qv,
    });
    if (!begun.ok) return begun.message;
    current = begun.session;
  }
  return whatsappDiary.applyFlowAnswers(current, submitted, saveSession);
}

function incompatibleReason(question) {
  if (!FLOW_TYPES.has(question.type)) {
    if (MEDIA_TYPES.has(question.type)) return "media is collected in the WhatsApp chat";
    return "question type is not supported by WhatsApp Flows";
  }
  if (question.rotate_options) return "rotated options must be prepared per respondent";
  if (question.every_nth_occasion || question.from_hour_utc != null || question.to_hour_utc != null) {
    return "question visibility depends on the diary occasion";
  }
  if (String(question.text || "").length > 4096) return "question text exceeds the Flow text limit";
  if (["single", "multi"].includes(question.type)) {
    const options = Array.isArray(question.options) ? question.options : [];
    if (options.length < 1 || options.length > 20) return "choice count is outside the supported Flow range";
    if (options.some((option) => String(option).length > 30)) return "one or more choice labels exceed 30 characters";
  }
  return null;
}

function optionId(question, value) {
  const index = (Array.isArray(question.options) ? question.options : []).indexOf(value);
  return index >= 0 ? "o_" + (index + 1) : null;
}

function inputComponents(question) {
  const name = "q_" + question.id;
  const components = [{ type: "TextBody", text: String(question.text || "") }];
  const common = { name, required: !!question.required };
  if (question.type === "single") {
    const choices = question.options.map((option, index) => ({ id: "o_" + (index + 1), title: String(option) }));
    components.push({
      type: choices.length > 7 ? "Dropdown" : "RadioButtonsGroup",
      label: "Choose one",
      "data-source": choices,
      ...common,
    });
  } else if (question.type === "multi") {
    components.push({
      type: "CheckboxGroup",
      label: question.max_selections ? "Choose up to " + question.max_selections : "Choose all that apply",
      "data-source": question.options.map((option, index) => ({ id: "o_" + (index + 1), title: String(option) })),
      ...common,
    });
  } else if (question.type === "date") {
    components.push({ type: "DatePicker", label: "Choose a date", ...common });
  } else if (question.type === "text") {
    components.push({ type: "TextArea", label: "Your answer", ...common });
  } else {
    const helper = question.type === "time"
      ? "Use 24-hour time, for example 14:30"
      : (question.min_value != null || question.max_value != null)
        ? "Enter a value from " + (question.min_value ?? "any") + " to " + (question.max_value ?? "any")
        : "Enter a number";
    components.push({
      type: "TextInput",
      label: "Your answer",
      "input-type": question.type === "time" ? "text" : "number",
      "helper-text": helper,
      ...(question.type === "time" ? { pattern: "^([01]\\d|2[0-3]):[0-5]\\d$" } : {}),
      ...common,
    });
  }
  return components;
}

function sourceReference(questionId, screenForQuestion, currentScreen) {
  const field = "q_" + questionId;
  const sourceScreen = screenForQuestion.get(Number(questionId));
  return sourceScreen === currentScreen
    ? "$" + "{form." + field + "}"
    : "$" + "{data." + field + "}";
}

function quoted(value) {
  return "'" + String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'") + "'";
}

function conditionFor(rule, questionsById, screenForQuestion, currentScreen) {
  const source = questionsById.get(Number(rule.condition_question_id));
  const reference = sourceReference(rule.condition_question_id, screenForQuestion, currentScreen);
  const values = String(rule.value || "").split("|");
  const comparisons = values.map((value) => {
    const mapped = ["single", "multi"].includes(source.type) ? optionId(source, value) : value;
    return reference + " == " + quoted(mapped == null ? value : mapped);
  });
  let match;
  if (rule.operator === "not_equals") match = reference + " != " + quoted(optionId(source, rule.value) || rule.value);
  else if (rule.operator === "not_in") match = comparisons.map((part) => part.replace(" == ", " != ")).join(" && ");
  else match = comparisons.join(" || ");
  if (rule.action === "hide") return "!(" + match + ")";
  return match;
}

function compileFlow({ study, questionnaire }) {
  const warnings = [];
  const questions = questionnaire.questions || [];
  const fallback = new Map();
  for (const question of questions) {
    const reason = incompatibleReason(question);
    if (reason) fallback.set(Number(question.id), reason);
  }

  for (const question of questions) {
    const relevantRules = (questionnaire.rules || []).filter((rule) =>
      rule.action !== "terminate" &&
      (Number(rule.target_question_id) === Number(question.id) ||
        (rule.target_section && question.section === rule.target_section))
    );
    if (relevantRules.length > 1) {
      fallback.set(Number(question.id), "multiple skip rules must be evaluated in chat");
    }
  }

  // A conditional target stays in chat when its source cannot be represented,
  // or when the rule uses multi-select membership that Flow expressions cannot
  // reproduce without changing the questionnaire's meaning.
  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of questionnaire.rules || []) {
      if (rule.action === "terminate") continue;
      const targets = rule.target_question_id
        ? [Number(rule.target_question_id)]
        : questions.filter((question) => question.section && question.section === rule.target_section).map((question) => Number(question.id));
      const source = questions.find((question) => Number(question.id) === Number(rule.condition_question_id));
      const sourceIndex = questions.indexOf(source);
      const unsupportedSource = !source || fallback.has(Number(source.id)) || rule.operator === "includes" || source.type === "multi";
      for (const target of targets) {
        const targetIndex = questions.findIndex((question) => Number(question.id) === target);
        const forwardDependency = sourceIndex >= 0 && targetIndex >= 0 && sourceIndex >= targetIndex;
        if ((unsupportedSource || forwardDependency) && !fallback.has(target)) {
          fallback.set(target, forwardDependency
            ? "skip logic depends on a later question"
            : "skip logic depends on a question handled in chat");
          changed = true;
        }
      }
    }
  }

  const compatible = questions.filter((question) => !fallback.has(Number(question.id)));
  const included = compatible.slice(0, QUESTIONS_PER_SCREEN * MAX_SCREENS);
  for (const question of compatible.slice(QUESTIONS_PER_SCREEN * MAX_SCREENS)) {
    fallback.set(Number(question.id), "questionnaire exceeds the ten-screen Flow limit");
  }
  if (!included.length) throw new Error("This questionnaire has no structured questions that can be placed in a WhatsApp Flow.");

  for (const [questionId, reason] of fallback) {
    const question = questions.find((item) => Number(item.id) === questionId);
    warnings.push((question && (question.code || question.text)) + ": " + reason + ".");
  }

  const groups = [];
  for (let index = 0; index < included.length; index += QUESTIONS_PER_SCREEN) {
    groups.push(included.slice(index, index + QUESTIONS_PER_SCREEN));
  }
  const screenForQuestion = new Map();
  groups.forEach((group, index) => {
    const screenId = "DIARY_" + SCREEN_NAMES[index];
    group.forEach((question) => screenForQuestion.set(Number(question.id), screenId));
  });
  const questionsById = new Map(questions.map((question) => [Number(question.id), question]));

  const screens = groups.map((group, screenIndex) => {
    const screenId = "DIARY_" + SCREEN_NAMES[screenIndex];
    const previousQuestions = groups.slice(0, screenIndex).flat();
    const payloadQuestions = [...previousQuestions, ...group];
    const children = [];
    let previousSection = null;
    for (const question of group) {
      if (question.section && question.section !== previousSection) {
        children.push({ type: "TextSubheading", text: String(question.section) });
        previousSection = question.section;
      }
      let components = inputComponents(question);
      const relevantRules = (questionnaire.rules || []).filter((rule) =>
        rule.action !== "terminate" &&
        (Number(rule.target_question_id) === Number(question.id) ||
          (rule.target_section && question.section === rule.target_section))
      );
      const rule = relevantRules[relevantRules.length - 1];
      if (rule) {
        components = [{
          type: "If",
          condition: conditionFor(rule, questionsById, screenForQuestion, screenId),
          then: components,
        }];
      }
      children.push(...components);
    }

    const payload = Object.fromEntries(payloadQuestions.map((question) => [
      "q_" + question.id,
      sourceReference(question.id, screenForQuestion, screenId),
    ]));
    const isLast = screenIndex === groups.length - 1;
    const action = isLast
      ? { name: "complete", payload }
      : {
          name: "navigate",
          next: { type: "screen", name: "DIARY_" + SCREEN_NAMES[screenIndex + 1] },
          payload,
        };
    children.push({ type: "Footer", label: isLast ? "Submit diary" : "Continue", "on-click-action": action });

    return {
      id: screenId,
      title: groups.length === 1 ? "Diary questions" : "Diary " + (screenIndex + 1) + " of " + groups.length,
      ...(previousQuestions.length ? {
        data: Object.fromEntries(previousQuestions.map((question) => [
          "q_" + question.id,
          question.type === "multi"
            ? { type: "array", items: { type: "string" }, __example__: ["o_1"] }
            : { type: "string", __example__: "example" },
        ])),
      } : {}),
      ...(isLast ? { terminal: true, success: true } : {}),
      layout: {
        type: "SingleColumnLayout",
        children: [{ type: "Form", name: "diary_form", children }],
      },
    };
  });

  return {
    flow: { version: "7.3", screens },
    includedQuestionIds: included.map((question) => Number(question.id)),
    fallbackQuestionIds: [...fallback.keys()],
    warnings,
    firstScreenId: screens[0].id,
    studyId: study.id,
    questionnaireVersion: questionnaire.version || study.version || 1,
  };
}

module.exports = {
  isStartCommand,
  issueToken,
  verifyToken,
  hashToken,
  submissionFrom,
  launch,
  sendReminder,
  handleSubmission,
  compileFlow,
};

