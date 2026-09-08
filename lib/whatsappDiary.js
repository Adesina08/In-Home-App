const store = require("./store");
const { loadQuestionnaire } = require("./questionnaire");
const { validateSubmission } = require("./answerValidation");
const { visibleQuestionIds, findTerminateMatch } = require("./skipLogic");
const { scheduled } = require("./advancedQuestionnaire");
const { runQcForRecord, checkCrossChannelDuplicate } = require("./qc");
const { logAudit } = require("./audit");
const twilioMedia = require("./twilioMedia");
const { deleteMedia } = require("./mediaStorage");

const MEDIA_TYPES = new Set(["photo", "video", "audio"]);

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
  for (const media of attachedMedia) {
    if (media.media_type === "audio" && audioProvider) audioProvider.transcribe(media).catch(() => {});
    if (media.media_type !== "audio" && brandProvider) brandProvider.detect(media, brands).catch(() => {});
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
    await saveSession({ step: "ready", diary_answers_json: null, diary_question_id: null });
    return "This study does not have any diary questions available right now. Please contact the study team.";
  }
  const answers = json(session.diary_answers_json);
  const otherText = json(session.diary_other_text_json);
  const question = nextVisibleQuestion(questions, rules, answers);
  if (!question) return completeDiary(session, respondent, study, questions, rules, answers, otherText, saveSession);
  await saveSession({ step: "diary", diary_question_id: question.id });
  return questionPrompt(question, questions.indexOf(question) + 1, questions.length);
}

async function startDiary(session, saveSession) {
  const context = await diaryContext(session);
  if (context.error) return context.error;
  const occasionNumber = (await store.count("diary_records", { respondent_id: context.respondent.id, status: "submitted", is_practice: 0 })) + 1;
  const started = new Date().toISOString();
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
  });
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

async function handleDiaryAnswer(session, raw, saveSession, inboundMedia = []) {
  if (command(raw) === "cancel") {
    await discardStagedMedia(session);
    await saveSession({ step: "ready", diary_answers_json: null, diary_other_text_json: null, diary_media_json: null, diary_question_id: null, diary_record_id: null });
    return "This WhatsApp diary entry was cancelled and nothing was submitted. Reply DIARY when you want to start again.";
  }
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
  if (["diary", "start", "new", "new diary"].includes(value)) return startDiary(session, saveSession);
  if (value === "status") {
    const submitted = await store.count("diary_records", { respondent_id: session.respondent_id, status: "submitted", is_practice: 0 });
    return `You have ${submitted} submitted diary ${submitted === 1 ? "entry" : "entries"}. Reply DIARY to add another.`;
  }
  return "You're enrolled. Reply DIARY to start a new diary entry, or STATUS to see how many entries you have submitted.";
}

module.exports = { startDiary, handleDiaryAnswer, readyMessage, parseAnswer, questionPrompt };
