const store = require('./store');

// The selected flag must come from the already-authorized study worklist.
async function loadConsoleQc(study, flags, requestedId) {
  const selectedFlag = flags.find(flag => String(flag.id) === String(requestedId)) || flags[0] || null;
  const record = selectedFlag?.record_id
    ? await store.findOne('diary_records', { id: selectedFlag.record_id, study_id: study.id, respondent_id: selectedFlag.respondent_id })
    : null;
  if (!record) return { selectedFlag, reviewRecord: null, reviewAnswers: [], reviewMedia: [] };
  const [questions, responses, media] = await Promise.all([
    store.find('questions', { study_id: study.id }, { sort: { order_index: 1, id: 1 } }),
    store.find('responses', { record_id: record.id }),
    store.find('media', { record_id: record.id }, { sort: { id: 1 } }),
  ]);
  const responseByQuestion = new Map(responses.map(response => [response.question_id, response]));
  const answers = questions.filter(question => question.type !== 'section' && (question.active === 1 || responseByQuestion.has(question.id))).map(question => {
    const response = responseByQuestion.get(question.id);
    return {
      code: question.code, text: question.text,
      value: response?.value ?? null,
      source: response?.source || 'respondent',
      verified: response?.verified === undefined ? 1 : response.verified,
      study_version: response?.study_version || null,
    };
  });
  return { selectedFlag, reviewRecord: record, reviewAnswers: answers, reviewMedia: media };
}
module.exports = { loadConsoleQc };
