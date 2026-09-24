const store = require("./store");
const { loadQuestionnaire } = require("./questionnaire");
const { validateSubmission } = require("./answerValidation");
const { visibleQuestionIds, findTerminateMatch } = require("./skipLogic");
const { scheduled } = require("./advancedQuestionnaire");
const { runQcForRecord, checkCrossChannelDuplicate } = require("./qc");
const { logAudit } = require("./audit");
const twilioMedia = require("./twilioMedia");
const { deleteMedia } = require("./mediaStorage");
const { parseCategories } = require("./categories");

const MEDIA_TYPES = new Set(["photo", "video", "audio"]);

// Meta's WhatsApp List Picker: single-select only, 2-10 rows, each row's
// visible text capped at 24 characters (Twilio content-type limit). A
// question outside those bounds keeps the existing typed-number prompt.
const LIST_PICKER_MIN_ITEMS = 2;
const LIST_PICKER_MAX_ITEMS = 10;
const LIST_PICKER_MAX_ITEM_CHARS = 24;

function listPickerOptions(question) {
  if (question.type !== "single") return null;
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length < LIST_PICKER_MIN_ITEMS || options.length > LIST_PICKER_MAX_ITEMS) return null;
  if (options.some((option) => String(option).length > LIST_PICKER_MAX_ITEM_CHARS)) return null;
  return options;
}

function json(value, fallback = {}) {
  if (value && typeof value === "object") return value;
  try {
    const parsed = JSON.parse(String(value || ""));
    return parsed && typeof parsed === "object" ? parsed : fallback;
  } catch (_) {
    return fallback;
  }
}

function firstName(respondent) {
  return String(respondent.name || "").trim().split(/\s+/)[0];
}

function command(value) {
  return String(value || "").trim().toLowerCase();
}

function helpText({ inEntry = false } = {}) {
  const lines = [
    "DIARY — start a new diary entry",
    "STATUS — see your submitted-entry count",
    "MENU — see your studies and commands",
    "HELP — show this help",
    "STOP — request withdrawal from this study",
  ];
  if (inEntry) lines.splice(1, 0,
    "REPEAT — show the current question again",
    "BACK — change your previous answer",
    "PAUSE — save your place for later",
    "CANCEL — discard this entry"
  );
  return lines.join("\n");
}

function optionFor(raw, options) {
  const value = String(raw || "").trim();
  const number = Number(value);
  if (Number.isInteger(number) && number >= 1 && number <= options.length) return options[number - 1];
  return options.find((option) => String(option).toLowerCase() === value.toLowerCase()) || null;
}

function questionPrompt(question, position, total) {
  const required = question.required ? "" : " (optional — reply SKIP)";
  let prompt = `${position}/${total} ${question.text}${required}`;
  const options = Array.isArray(question.options) ? question.options : [];
  if (options.length) prompt += `\n${options.map((option, index) => `${index + 1} ${option}`).join("\n")}`;
  if (question.type === "multi") prompt += "\nReply with all choices separated by commas, for example 1,3.";
  if (question.type === "rank") prompt += "\nReply with every option number in order, for example 3,1,2.";
  if (question.type === "date") prompt += "\nUse YYYY-MM-DD.";
  if (question.type === "time") prompt += "\nUse 24-hour time, HH:mm.";
  if (["numeric", "scale"].includes(question.type) && (question.min_value != null || question.max_value != null)) {
    prompt += `\nRange: ${question.min_value != null ? question.min_value : "any"} to ${question.max_value != null ? question.max_value : "any"}.`;
  }
  if (MEDIA_TYPES.has(question.type)) {
    prompt += `\nSend one ${question.type === "photo" ? "photo" : question.type === "video" ? "video" : "voice note or audio file"} now.${question.required ? " If you cannot attach it, reply SKIP and the missing evidence will be flagged for review." : ""}`;
  }
  prompt += "\n\nReply CANCEL at any time to discard this entry.";
  return prompt;
}

// Fresh-question result: a plain string for every case the typed-reply flow
// already handles, or -- only when eligible -- an object signalling the
// caller (routes/whatsappWebhook.js) to send a List Picker instead. Retries
// after a bad answer always stay plain text (see call sites of
// questionPrompt below); re-sending a fresh interactive picker on every
// validation error would be noisy, and the numbered list still works typed.
function questionResult(question, position, total) {
  const prompt = questionPrompt(question, position, total);
  const options = listPickerOptions(question);
  return options ? { prompt, question, options } : prompt;
}

function parseAnswer(question, raw) {
  const value = String(raw || "").trim();
  if (!value) return { ok: false, error: "Please send an answer." };
  if (command(value) === "skip") {
    if (MEDIA_TYPES.has(question.type) || !question.required) return { ok: true, skipped: true };
    return { ok: false, error: "This question is required and cannot be skipped." };
  }
  if (MEDIA_TYPES.has(question.type)) {
    return { ok: false, error: `Please send a ${question.type} attachment, reply SKIP to continue, or CANCEL to discard this entry.` };
  }

  const options = Array.isArray(question.options) ? question.options : [];
  if (question.type === "single") {
    const selected = optionFor(value, options);
    return selected ? { ok: true, value: selected } : { ok: false, error: "Please reply with one of the listed option numbers." };
  }
  if (["multi", "rank"].includes(question.type)) {
    const parts = value.split(/[,;|]/).map((part) => part.trim()).filter(Boolean);
    const selected = parts.map((part) => optionFor(part, options));
    if (!parts.length || selected.some((item) => !item)) return { ok: false, error: "Please use only the listed option numbers, separated by commas." };
    if (new Set(selected).size !== selected.length) return { ok: false, error: "Please list each choice only once." };
    if (question.type === "rank" && selected.length !== options.length) return { ok: false, error: "Please rank every listed option exactly once." };
    return { ok: true, value: selected.join("|") };
  }
  if (["numeric", "scale"].includes(question.type)) {
    const number = Number(value);
    if (!Number.isFinite(number)) return { ok: false, error: "Please reply with a number." };
    if (question.min_value != null && number < Number(question.min_value)) return { ok: false, error: `Please enter ${question.min_value} or more.` };
    if (question.max_value != null && number > Number(question.max_value)) return { ok: false, error: `Please enter ${question.max_value} or less.` };
    return { ok: true, value: String(number) };
  }
  if (question.type === "date") {
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
    return valid ? { ok: true, value } : { ok: false, error: "Please use a valid date in YYYY-MM-DD format." };
  }
  if (question.type === "time") {
    return /^([01]\d|2[0-3]):[0-5]\d$/.test(value)
      ? { ok: true, value }
      : { ok: false, error: "Please use a valid 24-hour time in HH:mm format." };
  }
  return { ok: true, value };
}

async function diaryContext(session) {
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  if (!respondent) return { error: "We couldn't find your study enrolment. Please reopen your invitation." };
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) return { error: "We couldn't find this study. Please contact the study team." };
  if (respondent.withdrawn_at || respondent.erased_at || respondent.activation_status === "disqualified") {
    return { error: "This study participation is no longer active. Please contact the study team if you think this is a mistake." };
  }
  if (respondent.activation_status === "registered") return { error: "Your participation is awaiting study-team activation, so a diary entry cannot be started yet." };
  if (!['active', 'activated'].includes(respondent.activation_status) || respondent.consent_status !== "given") {
    return { error: "Your enrolment is not ready for diary entries yet. Please complete your invitation or contact the study team." };
  }
  const today = store.nowSql().slice(0, 10);
  if (study.status !== "live" || respondent.end_validation_status === "completed" ||
      (study.start_date && study.start_date > today) || (study.end_date && study.end_date < today)) {
    return { error: "This study is not currently accepting new diary entries." };
  }
  if (respondent.end_validation_status === "pending") {
    return { error: "Your end-of-study check is due. Please complete it from your personal INICIO Diary app/link." };
  }
  return { respondent, study };
}

async function activeQuestions(session, respondent, study) {
  const occurrenceTime = session.diary_occurrence_time || new Date().toISOString();
  const occasionNumber = Number(session.diary_occasion_number) || 1;
  const questionnaire = await loadQuestionnaire(study.id, { respondentId: respondent.id });
  return {
    questions: questionnaire.questions.filter((question) => scheduled(question, { occurrenceTime, occasionNumber })),
    rules: questionnaire.rules,
  };
}

function nextVisibleQuestion(questions, rules, answers) {
  const visible = visibleQuestionIds(questions, rules, answers);
  return questions.find((question) => visible.has(question.id) && !Object.prototype.hasOwnProperty.call(answers, String(question.id))) || null;
}

async function completeDiary(session, respondent, study, questions, rules, answers, otherText, saveSession) {
  const body = {
    occurrence_time: session.diary_occurrence_time,
    occasion_number: session.diary_occasion_number,
    other_text_json: otherText,
  };
  for (const question of questions) {
    if (answers[String(question.id)] !== undefined) body[`q_${question.id}`] = question.type === "multi" ? String(answers[String(question.id)]).split("|") : answers[String(question.id)];
  }
  const terminateMatch = findTerminateMatch(rules, answers);
  if (!terminateMatch) {
    const problems = validateSubmission({ questions, rules, body });
    if (problems.length) {
      const problem = problems[0];
      delete answers[String(problem.questionId)];
      await saveSession({ diary_answers_json: JSON.stringify(answers) });
      const question = questions.find((item) => item.id === problem.questionId);
      return `${problem.message}\n\n${questionPrompt(question, questions.indexOf(question) + 1, questions.length)}`;
    }
  }

  const now = store.nowSql();
  const occurrenceTime = store.toSqlTime(session.diary_occurrence_time) || now;
  const status = terminateMatch ? "screened_out" : "submitted";
  const terminateNote = terminateMatch ? `Terminated: question ${terminateMatch.condition_question_id} ${terminateMatch.operator} ${terminateMatch.value}` : null;
  let recordId = Number(session.diary_record_id) || null;
  let record = recordId ? await store.findOne("diary_records", { id: recordId, respondent_id: respondent.id }) : null;
  if (!record) {
    recordId = (await store.insert("diary_records", {
      respondent_id: respondent.id,
      study_id: study.id,
      period_label: occurrenceTime.slice(0, 10),
      occurrence_time: occurrenceTime,
      capture_time: occurrenceTime,
      sync_time: now,
      submit_time: now,
      channel: "whatsapp",
      status: "ingesting",
      is_practice: 0,
      entry_mode: "standard",
      terminate_note: terminateNote,
      whatsapp_flow_token_hash: session.diary_flow_token_hash || null,
    })).id;
    session = await saveSession({ diary_record_id: recordId });
  }
  const visible = visibleQuestionIds(questions, rules, answers);
  for (const question of questions) {
    const value = answers[String(question.id)];
    if (!visible.has(question.id) || value === undefined || MEDIA_TYPES.has(question.type)) continue;
    if (await store.findOne("responses", { record_id: recordId, question_id: question.id })) continue;
    await store.insert("responses", {
      record_id: recordId,
      question_id: question.id,
      value: String(value),
      other_text_json: otherText[String(question.id)] ? JSON.stringify(otherText[String(question.id)]) : null,
      study_version: study.version || 1,
    });
  }

  const mediaByQuestion = json(session.diary_media_json);
  const attachedMedia = [];
  for (const [questionId, stagedId] of Object.entries(mediaByQuestion)) {
    const staged = await store.findOne("staged_media", { id: Number(stagedId), respondent_id: respondent.id });
    if (!staged) continue;
    let media = await store.findOne("media", { record_id: recordId, staged_media_id: staged.id });
    if (!media) {
      const inserted = await store.insert("media", {
        record_id: recordId,
        question_id: Number(questionId),
        staged_media_id: staged.id,
        media_type: staged.media_type,
        mimetype: staged.mimetype,
        file_path: staged.file_path,
      });
      media = await store.findOne("media", { id: inserted.id });
    }
    if (!staged.consumed_at) await store.update("staged_media", { id: staged.id }, { consumed_at: now });
    attachedMedia.push(media);
  }
  await store.update("diary_records", { id: recordId }, { status });

  let brandProvider = null;
  let audioProvider = null;
  try { brandProvider = require("./brandDetection").getProvider(); } catch (error) { console.error("WhatsApp brand detection unavailable:", error.message); }
  try { audioProvider = require("./audioTranscription").getProvider(); } catch (error) { console.error("WhatsApp transcription unavailable:", error.message); }
  const brands = await require("./productCandidates").forStudy(study);
  const categories = parseCategories(study.category);
  for (const media of attachedMedia) {
    if (media.media_type === "audio") {
      // Brand detection on a voice note reads the transcript, not a frame,
      // so it's chained onto transcription rather than run alongside it.
      if (audioProvider) {
        audioProvider.transcribe(media)
          .then((result) => { if (result?.text && brandProvider) brandProvider.detect({ ...media, transcript_text: result.text }, brands, categories).catch(() => {}); })
          .catch(() => {});
      }
    } else if (brandProvider) {
      brandProvider.detect(media, brands, categories).catch(() => {});
    }
  }

  if (!terminateMatch) {
    await store.update("respondents", { id: respondent.id, activation_status: { $ne: "active" } }, { activation_status: "active" });
    await runQcForRecord(recordId);
    await checkCrossChannelDuplicate(respondent.id, occurrenceTime.slice(0, 10));
  } else if (terminateMatch.terminate_scope === "study") {
    await store.update("respondents", { id: respondent.id }, {
      activation_status: "disqualified",
      disqualified_at: now,
      disqualify_reason: terminateNote,
    });
  }
  logAudit(respondent.respondent_code, terminateMatch ? "whatsapp_diary_terminated" : "whatsapp_diary_submit", "diary_records", recordId, {});
  await saveSession({
    step: terminateMatch && terminateMatch.terminate_scope === "study" ? "declined" : "ready",
    diary_answers_json: null,
    diary_other_text_json: null,
    diary_question_id: null,
    diary_other_question_id: null,
    diary_other_option: null,
    diary_media_json: null,
    diary_record_id: null,
    diary_flow_token_hash: null,
    diary_flow_questionnaire_version: null,
  });
  return terminateMatch
    ? "Thank you. Based on that answer, this diary entry has ended and your responses were saved."
    : `Thank you${firstName(respondent) ? `, ${firstName(respondent)}` : ""}. Your WhatsApp diary entry has been submitted. Reply DIARY whenever you need to add another one.`;
}

async function advance(session, saveSession) {
  const context = await diaryContext(session);
  if (context.error) {
    await saveSession({ step: "ready" });
    return context.error;
  }
  const { respondent, study } = context;
  const { questions, rules } = await activeQuestions(session, respondent, study);
  if (!questions.length) {
    await saveSession({ step: "ready", diary_answers_json: null, diary_question_id: null, diary_flow_token_hash: null, diary_flow_questionnaire_version: null });
    return "This study does not have any diary questions available right now. Please contact the study team.";
  }
  const answers = json(session.diary_answers_json);
  const otherText = json(session.diary_other_text_json);
  const question = nextVisibleQuestion(questions, rules, answers);
  if (!question) return completeDiary(session, respondent, study, questions, rules, answers, otherText, saveSession);
  await saveSession({ step: "diary", diary_question_id: question.id });
  return questionResult(question, questions.indexOf(question) + 1, questions.length);
}

async function beginDiary(session, saveSession, options = {}) {
  const context = await diaryContext(session);
  if (context.error) return { ok: false, message: context.error };
  const occasionNumber = Number(options.occasionNumber) ||
    (await store.count("diary_records", { respondent_id: context.respondent.id, status: "submitted", is_practice: 0 })) + 1;
  const started = options.occurrenceTime || new Date().toISOString();
  const next = await saveSession({
    step: "diary",
    diary_occurrence_time: started,
    diary_occasion_number: occasionNumber,
    diary_answers_json: "{}",
    diary_other_text_json: "{}",
    diary_question_id: null,
    diary_other_question_id: null,
    diary_other_option: null,
    diary_media_json: "{}",
    diary_record_id: null,
    diary_flow_token_hash: options.flowTokenHash || null,
    diary_flow_questionnaire_version: options.questionnaireVersion || null,
  });
  const questionnaire = await activeQuestions(next, context.respondent, context.study);
  if (!questionnaire.questions.length) {
    await saveSession({ step: "ready", diary_answers_json: null, diary_question_id: null, diary_flow_token_hash: null, diary_flow_questionnaire_version: null });
    return { ok: false, message: "This study does not have any diary questions available right now. Please contact the study team." };
  }
  return { ok: true, session: next, context, ...questionnaire };
}

async function startDiary(session, saveSession) {
  const begun = await beginDiary(session, saveSession);
  if (!begun.ok) return begun.message;
  return advance(begun.session, saveSession);
}

function flowOption(question, value) {
  const options = Array.isArray(question.options) ? question.options : [];
  const match = /^o_(\d+)$/.exec(String(value || ""));
  if (match) return options[Number(match[1]) - 1] || null;
  return optionFor(value, options);
}

function flowAnswer(question, value) {
  if (value === undefined || value === null || value === "") return null;
  if (question.type === "single") {
    const selected = flowOption(question, value);
    return selected ? { ok: true, value: selected } : null;
  }
  if (question.type === "multi") {
    const raw = Array.isArray(value) ? value : String(value).split("|");
    const selected = raw.map((item) => flowOption(question, item));
    if (!selected.length || selected.some((item) => !item) || new Set(selected).size !== selected.length) return null;
    if (question.max_selections && selected.length > Number(question.max_selections)) return null;
    return { ok: true, value: selected.join("|") };
  }
  const parsed = parseAnswer(question, String(value));
  return parsed.ok && !parsed.skipped ? parsed : null;
}

// Merge one completed WhatsApp Flow into the same in-progress session used by
// the chat questionnaire. Questions that the Flow cannot represent remain
// unanswered, so advance() asks them in WhatsApp before the entry is saved.
async function applyFlowAnswers(session, submitted, saveSession) {
  const context = await diaryContext(session);
  if (context.error) {
    await saveSession({ step: "ready" });
    return context.error;
  }
  const { questions, rules } = await activeQuestions(session, context.respondent, context.study);
  const answers = json(session.diary_answers_json);
  const otherText = json(session.diary_other_text_json);

  for (const question of questions) {
    if (MEDIA_TYPES.has(question.type)) continue;
    const field = "q_" + question.id;
    if (!Object.prototype.hasOwnProperty.call(submitted, field)) continue;
    const parsed = flowAnswer(question, submitted[field]);
    if (!parsed) continue;
    answers[String(question.id)] = parsed.value;

    const selected = String(parsed.value).split("|");
    const specify = Array.isArray(question.otherSpecifyOptions) ? question.otherSpecifyOptions : [];
    for (const option of selected.filter((item) => specify.includes(item))) {
      const optionIndex = (Array.isArray(question.options) ? question.options : []).indexOf(option) + 1;
      const detail = submitted["other_" + question.id + "_" + optionIndex] ?? submitted["other_" + question.id];
      if (String(detail || "").trim()) {
        otherText[String(question.id)] = { ...(otherText[String(question.id)] || {}), [option]: String(detail).trim() };
      }
    }
  }

  let next = await saveSession({
    step: "diary",
    diary_answers_json: JSON.stringify(answers),
    diary_other_text_json: JSON.stringify(otherText),
    diary_question_id: null,
    diary_flow_received_at: store.nowSql(),
  });

  const visible = visibleQuestionIds(questions, rules, answers);
  for (const question of questions) {
    if (!visible.has(question.id)) continue;
    const selected = String(answers[String(question.id)] || "").split("|");
    const specify = Array.isArray(question.otherSpecifyOptions) ? question.otherSpecifyOptions : [];
    const missing = selected.find((option) => specify.includes(option) && !String(otherText[String(question.id)]?.[option] || "").trim());
    if (!missing) continue;
    next = await saveSession({
      diary_other_question_id: question.id,
      diary_other_option: missing,
      diary_question_id: question.id,
    });
    return "You selected “" + missing + "”. Please type your answer in your own words.";
  }
  return advance(next, saveSession);
}

async function discardStagedMedia(session) {
  for (const stagedId of Object.values(json(session.diary_media_json))) {
    const staged = await store.findOne("staged_media", { id: Number(stagedId), respondent_id: session.respondent_id });
    if (!staged || staged.consumed_at) continue;
    await deleteMedia(staged.file_path).catch(() => {});
    await store.remove("staged_media", { id: staged.id });
  }
}

async function discardDiary(session, saveSession, message) {
  await discardStagedMedia(session);
  await saveSession({
    step: "ready",
    diary_answers_json: null,
    diary_other_text_json: null,
    diary_media_json: null,
    diary_question_id: null,
    diary_other_question_id: null,
    diary_other_option: null,
    diary_record_id: null,
    diary_flow_token_hash: null,
    diary_flow_questionnaire_version: null,
  });
  return message;
}

async function repeatQuestion(session) {
  const context = await diaryContext(session);
  if (context.error) return context.error;
  const { questions } = await activeQuestions(session, context.respondent, context.study);
  const question = questions.find((item) => item.id === Number(session.diary_question_id));
  if (!question) return "Your saved entry has no current question. Reply CONTINUE to resume it.";
  if (session.diary_other_question_id) {
    return `You selected “${session.diary_other_option}”. Please type your answer in your own words, or reply BACK to change your selection.`;
  }
  return questionResult(question, questions.indexOf(question) + 1, questions.length);
}

async function statusMessage(session, { inEntry = false } = {}) {
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  const study = respondent ? await store.findOne("studies", { id: respondent.study_id }) : null;
  const submitted = await store.count("diary_records", { respondent_id: session.respondent_id, status: "submitted", is_practice: 0 });
  const prefix = study ? `${study.name}: ` : "";
  return `${prefix}${submitted} submitted diary ${submitted === 1 ? "entry" : "entries"}.${inEntry ? " Your current entry is still in progress." : " Reply DIARY to add another."}`;
}

async function backOneQuestion(session, saveSession) {
  const context = await diaryContext(session);
  if (context.error) return context.error;
  const { questions, rules } = await activeQuestions(session, context.respondent, context.study);
  const answers = json(session.diary_answers_json);
  const otherText = json(session.diary_other_text_json);
  const mediaByQuestion = json(session.diary_media_json);
  const visible = visibleQuestionIds(questions, rules, answers);
  const currentIndex = Math.max(0, questions.findIndex((item) => item.id === Number(session.diary_question_id)));
  const prior = questions
    .slice(0, currentIndex)
    .filter((item) => visible.has(item.id) && Object.prototype.hasOwnProperty.call(answers, String(item.id)));
  const target = session.diary_other_question_id
    ? questions.find((item) => item.id === Number(session.diary_other_question_id))
    : prior[prior.length - 1];
  if (!target) return "You're already at the first question. Reply REPEAT to see it again.";

  const targetIndex = questions.indexOf(target);
  for (const question of questions.slice(targetIndex)) {
    const key = String(question.id);
    delete answers[key];
    delete otherText[key];
    const stagedId = mediaByQuestion[key];
    if (stagedId) {
      const staged = await store.findOne("staged_media", { id: Number(stagedId), respondent_id: session.respondent_id });
      if (staged && !staged.consumed_at) {
        await deleteMedia(staged.file_path).catch(() => {});
        await store.remove("staged_media", { id: staged.id });
      }
      delete mediaByQuestion[key];
    }
  }
  await saveSession({
    step: "diary",
    diary_question_id: target.id,
    diary_answers_json: JSON.stringify(answers),
    diary_other_text_json: JSON.stringify(otherText),
    diary_media_json: JSON.stringify(mediaByQuestion),
    diary_other_question_id: null,
    diary_other_option: null,
  });
  return questionResult(target, targetIndex + 1, questions.length);
}

async function requestWithdrawal(session, saveSession, returnStep) {
  await saveSession({ step: "stop_confirm", stop_return_step: returnStep || session.step || "ready" });
  return "STOP can withdraw you from this study and stop future study reminders. Your existing research data will be handled under the study consent and privacy process. Reply WITHDRAW to confirm, or CONTINUE to go back.";
}

async function stopConfirmationMessage(session, raw, saveSession) {
  const value = command(raw);
  if (["continue", "resume", "no", "cancel"].includes(value)) {
    const returnStep = ["diary", "paused_diary", "closeout", "paused_closeout", "ready"].includes(session.stop_return_step) ? session.stop_return_step : "ready";
    const next = await saveSession({ step: returnStep, stop_return_step: null });
    if (returnStep === "diary") return repeatQuestion(next);
    if (returnStep === "paused_diary") return "Your diary entry is still paused. Reply CONTINUE when you're ready to resume it.";
    if (returnStep === "closeout") return handleCloseoutAnswer(next, "REPEAT", saveSession);
    if (returnStep === "paused_closeout") return "Your final study check is still paused. Reply CONTINUE when you're ready to resume it.";
    return "Withdrawal was not requested. Reply DIARY to start an entry, or MENU for help.";
  }
  if (value !== "withdraw") {
    return "Reply WITHDRAW to confirm that you want to leave this study, or CONTINUE to go back.";
  }
  await discardStagedMedia(session);
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  if (respondent && !respondent.withdrawn_at) {
    await require("./researchPrivacy").withdraw(respondent, respondent.respondent_code || `whatsapp:${respondent.id}`);
  }
  await saveSession({
    step: "withdrawn",
    stop_return_step: null,
    diary_answers_json: null,
    diary_other_text_json: null,
    diary_media_json: null,
    diary_question_id: null,
    diary_record_id: null,
    diary_flow_token_hash: null,
    diary_flow_questionnaire_version: null,
  });
  return "You have been withdrawn from this study and will not receive further study reminders. Contact the study team if you need help with your data or believe this was a mistake.";
}

async function pausedMessage(session, raw, saveSession) {
  const value = command(raw);
  if (["continue", "resume", "diary"].includes(value)) {
    const next = await saveSession({ step: "diary" });
    return repeatQuestion(next);
  }
  if (value === "cancel") {
    return discardDiary(session, saveSession, "This WhatsApp diary entry was cancelled and nothing was submitted. Reply DIARY when you want to start again.");
  }
  if (value === "stop") return requestWithdrawal(session, saveSession, "paused_diary");
  if (value === "status") return statusMessage(session, { inEntry: true });
  if (["help", "menu"].includes(value)) return `Your diary entry is paused.\n\n${helpText({ inEntry: true })}`;
  return "Your diary entry is paused. Reply CONTINUE to resume it, CANCEL to discard it, or HELP for options.";
}

async function eligibleStudies(session) {
  const current = await store.findOne("respondents", { id: session.respondent_id });
  if (!current) return [];
  const filter = current.account_id ? { account_id: current.account_id } : { contact: current.contact };
  const respondents = await store.find("respondents", filter, { sort: { id: 1 } });
  const result = [];
  for (const respondent of respondents) {
    if (respondent.chosen_mode !== "whatsapp" || respondent.consent_status !== "given" || respondent.withdrawn_at || respondent.erased_at) continue;
    if (!["active", "activated"].includes(respondent.activation_status)) continue;
    const study = await store.findOne("studies", { id: respondent.study_id });
    const consent = await store.findOne("consent_versions", { study_id: respondent.study_id, status: "approved" }, { sort: { version: -1 } });
    if (!study || !consent || Number(respondent.consent_version) !== Number(consent.version)) continue;
    if (respondent.end_validation_status === "completed") continue;
    result.push({ respondent, study });
  }
  return result;
}

async function menuMessage(session) {
  const studies = await eligibleStudies(session);
  const studyLines = studies.length > 1
    ? `\n\nYour active studies:\n${studies.map(({ respondent, study }, index) => `${index + 1} ${study.name}${respondent.id === session.respondent_id ? " (current)" : ""}`).join("\n")}\nReply STUDY and its number to switch, for example STUDY 2.`
    : studies.length === 1
      ? `\n\nCurrent study: ${studies[0].study.name}`
      : "";
  return `${helpText()}${studyLines}`;
}

async function switchStudy(session, raw, saveSession) {
  const match = /^study\s+(\d+)$/i.exec(String(raw || "").trim());
  if (!match) return null;
  const studies = await eligibleStudies(session);
  const selected = studies[Number(match[1]) - 1];
  if (!selected) return "That study number is not available. Reply MENU to see your active studies.";
  await saveSession({
    respondent_id: selected.respondent.id,
    profile_id: selected.respondent.profile_id || session.profile_id || null,
    step: "ready",
    diary_answers_json: null,
    diary_other_text_json: null,
    diary_media_json: null,
    diary_question_id: null,
    diary_record_id: null,
    diary_flow_token_hash: null,
    diary_flow_questionnaire_version: null,
  });
  return `${selected.study.name} is now your current study. Reply DIARY to start an entry, STATUS for your progress, or MENU for help.`;
}

async function closeoutContext(session) {
  const respondent = await store.findOne("respondents", { id: session.respondent_id });
  if (!respondent) return { error: "We couldn't find your study enrolment. Please reopen your invitation." };
  const study = await store.findOne("studies", { id: respondent.study_id });
  if (!study) return { error: "We couldn't find this study. Please contact the study team." };
  const today = store.nowSql().slice(0, 10);
  const due = respondent.end_validation_status === "pending" || study.status === "closed" || (study.end_date && study.end_date < today);
  return { respondent, study, due, completed: respondent.end_validation_status === "completed" };
}

function closeoutPrompt(question, position, total) {
  const optional = question.required ? "" : " (optional — reply SKIP)";
  let prompt = `${position}/${total} ${question.text}${optional}`;
  if (question.type === "single") {
    prompt += `\n${(question.options || []).map((option, index) => `${index + 1} ${option}`).join("\n")}`;
  }
  return `${prompt}\n\nReply REPEAT, BACK, PAUSE or STOP if you need help.`;
}

function parseCloseoutAnswer(question, raw) {
  const value = String(raw || "").trim();
  if (command(value) === "skip" && !question.required) return { ok: true, value: "" };
  if (!value) return { ok: false, error: "Please send an answer." };
  if (question.type === "single") {
    const selected = optionFor(value, question.options || []);
    return selected ? { ok: true, value: selected } : { ok: false, error: "Please reply with one of the listed option numbers." };
  }
  return { ok: true, value };
}

async function startCloseout(session, saveSession) {
  const context = await closeoutContext(session);
  if (context.error) return context.error;
  if (context.completed) return "Your final study check is already complete. Thank you for taking part.";
  if (!context.due) return null;
  const questions = require("./closeOutQuestionnaire").questionsFor(context.study);
  if (!questions.length) return "The final study check is not available. Please contact the study team.";
  await saveSession({ step: "closeout", closeout_index: 0, closeout_answers_json: "{}" });
  return `Your diary period has ended. Please complete this short final study check.\n\n${closeoutPrompt(questions[0], 1, questions.length)}`;
}

async function handleCloseoutAnswer(session, raw, saveSession) {
  const context = await closeoutContext(session);
  if (context.error) return context.error;
  const questions = require("./closeOutQuestionnaire").questionsFor(context.study);
  let index = Number(session.closeout_index) || 0;
  const answers = json(session.closeout_answers_json);
  const action = command(raw);

  if (action === "stop") return requestWithdrawal(session, saveSession, "closeout");
  if (["pause", "cancel"].includes(action)) {
    await saveSession({ step: "paused_closeout" });
    return "Your final study check is saved. Reply CONTINUE when you're ready to resume it.";
  }
  if (["repeat", "continue", "resume"].includes(action)) return closeoutPrompt(questions[index], index + 1, questions.length);
  if (["help", "menu"].includes(action)) return `Your final study check is still in progress. Reply REPEAT, BACK, PAUSE or STOP.`;
  if (action === "status") return `Your final study check is in progress at question ${index + 1} of ${questions.length}.`;
  if (action === "back") {
    if (index === 0) return "You're already at the first final-check question.";
    index -= 1;
    delete answers[questions[index].code];
    await saveSession({ closeout_index: index, closeout_answers_json: JSON.stringify(answers) });
    return closeoutPrompt(questions[index], index + 1, questions.length);
  }

  const question = questions[index];
  const parsed = parseCloseoutAnswer(question, raw);
  if (!parsed.ok) return `${parsed.error}\n\n${closeoutPrompt(question, index + 1, questions.length)}`;
  answers[question.code] = parsed.value;
  index += 1;
  if (index < questions.length) {
    await saveSession({ closeout_index: index, closeout_answers_json: JSON.stringify(answers) });
    return closeoutPrompt(questions[index], index + 1, questions.length);
  }

  const closeOut = require("./closeOutQuestionnaire");
  const errors = closeOut.validate(answers, context.study);
  if (Object.keys(errors).length) {
    const failedIndex = questions.findIndex((item) => errors[item.code]);
    await saveSession({ closeout_index: failedIndex, closeout_answers_json: JSON.stringify(answers) });
    return `${errors[questions[failedIndex].code]}\n\n${closeoutPrompt(questions[failedIndex], failedIndex + 1, questions.length)}`;
  }
  await require("./researchOperations").insertOnce("end_validations", `closeout:${context.respondent.id}`, {
    respondent_id: context.respondent.id,
    study_id: context.study.id,
    answers,
    completed_at: store.nowSql(),
  });
  await store.update("respondents", { id: context.respondent.id }, { end_validation_status: "completed" });
  logAudit(context.respondent.respondent_code, "end_validation_completed", "respondents", context.respondent.id, {
    channel: "whatsapp",
    missed_occasions: answers.missed_occasions,
  });
  await saveSession({ step: "ready", closeout_index: null, closeout_answers_json: null });
  return `Thank you${firstName(context.respondent) ? `, ${firstName(context.respondent)}` : ""}. Your final study check is complete and your diary is now closed.`;
}

async function pausedCloseoutMessage(session, raw, saveSession) {
  const value = command(raw);
  if (["continue", "resume"].includes(value)) {
    const next = await saveSession({ step: "closeout" });
    return handleCloseoutAnswer(next, "REPEAT", saveSession);
  }
  if (value === "stop") return requestWithdrawal(session, saveSession, "paused_closeout");
  return "Your final study check is paused. Reply CONTINUE to resume it, or STOP if you want to request withdrawal from this study.";
}

async function handleDiaryAnswer(session, raw, saveSession, inboundMedia = []) {
  const action = command(raw);
  if (action === "cancel") return discardDiary(session, saveSession, "This WhatsApp diary entry was cancelled and nothing was submitted. Reply DIARY when you want to start again.");
  if (action === "stop") return requestWithdrawal(session, saveSession, "diary");
  if (action === "pause") {
    await saveSession({ step: "paused_diary" });
    return "Your diary entry is saved at this question. Reply CONTINUE when you're ready to resume, or CANCEL to discard it.";
  }
  if (["repeat", "continue", "resume", "diary"].includes(action)) return repeatQuestion(session);
  if (action === "back") return backOneQuestion(session, saveSession);
  if (action === "status") return statusMessage(session, { inEntry: true });
  if (["help", "menu"].includes(action)) return `Your current entry is still in progress.\n\n${helpText({ inEntry: true })}`;
  const context = await diaryContext(session);
  if (context.error) {
    await saveSession({ step: "ready" });
    return context.error;
  }
  const { questions } = await activeQuestions(session, context.respondent, context.study);
  const answers = json(session.diary_answers_json);
  const otherText = json(session.diary_other_text_json);

  if (session.diary_other_question_id) {
    const detail = String(raw || "").trim();
    if (!detail) return "Please type what you mean by Other, or reply CANCEL to discard this diary entry.";
    const qid = String(session.diary_other_question_id);
    otherText[qid] = { ...(otherText[qid] || {}), [session.diary_other_option]: detail };
    const next = await saveSession({ diary_other_text_json: JSON.stringify(otherText), diary_other_question_id: null, diary_other_option: null });
    return advance(next, saveSession);
  }

  const question = questions.find((item) => item.id === Number(session.diary_question_id));
  if (!question) return advance(session, saveSession);

  if (MEDIA_TYPES.has(question.type) && inboundMedia.length) {
    const attachment = inboundMedia.find((item) => String(item.contentType || "").toLowerCase().startsWith(`${question.type === "photo" ? "image" : question.type}/`)) || inboundMedia[0];
    try {
      const staged = await twilioMedia.ingest({
        respondentId: context.respondent.id,
        questionId: question.id,
        mediaType: question.type,
        url: attachment.url,
        contentType: attachment.contentType,
      });
      const mediaByQuestion = json(session.diary_media_json);
      mediaByQuestion[String(question.id)] = staged.id;
      answers[String(question.id)] = "__media__";
      const next = await saveSession({ diary_answers_json: JSON.stringify(answers), diary_media_json: JSON.stringify(mediaByQuestion) });
      return advance(next, saveSession);
    } catch (error) {
      return `We couldn't securely save that attachment: ${error.message}\n\n${questionPrompt(question, questions.indexOf(question) + 1, questions.length)}`;
    }
  }
  const parsed = parseAnswer(question, raw);
  if (!parsed.ok) return `${parsed.error}\n\n${questionPrompt(question, questions.indexOf(question) + 1, questions.length)}`;
  if (!parsed.skipped) answers[String(question.id)] = parsed.value;
  else answers[String(question.id)] = "";

  const otherOptions = Array.isArray(question.otherSpecifyOptions) ? question.otherSpecifyOptions : [];
  const selected = String(parsed.value || "").split("|");
  const otherOption = selected.find((item) => otherOptions.includes(item));
  const patch = { diary_answers_json: JSON.stringify(answers) };
  if (otherOption) {
    patch.diary_other_question_id = question.id;
    patch.diary_other_option = otherOption;
    await saveSession(patch);
    return `You selected “${otherOption}”. Please type your answer in your own words.`;
  }
  const next = await saveSession(patch);
  return advance(next, saveSession);
}

async function readyMessage(session, raw, saveSession) {
  const value = command(raw);
  const switched = await switchStudy(session, raw, saveSession);
  if (switched) return switched;
  if (["diary", "start", "new", "new diary", "closeout", "final check"].includes(value)) {
    const closeout = await startCloseout(session, saveSession);
    return closeout || startDiary(session, saveSession);
  }
  if (value === "status") return statusMessage(session);
  if (value === "stop") return requestWithdrawal(session, saveSession, "ready");
  if (["menu", "help"].includes(value)) return menuMessage(session);
  return "You're enrolled. Reply DIARY to start a new diary entry, STATUS for your progress, or MENU for help.";
}

module.exports = {
  startDiary,
  handleDiaryAnswer,
  readyMessage,
  pausedMessage,
  handleCloseoutAnswer,
  pausedCloseoutMessage,
  stopConfirmationMessage,
  parseAnswer,
  questionPrompt,
  beginDiary,
  applyFlowAnswers,
  advance,
};
