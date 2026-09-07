const store = require('./store');

function validatePeriod({ from = '', to = '' } = {}) {
  for (const value of [from, to]) {
    if (value && (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) {
      throw new Error('Choose valid calendar dates.');
    }
  }
  if (from && to && from > to) throw new Error('The start date is after the end date.');
  return { from: from || '', to: to || '' };
}
function periodFilter(from, to) {
  validatePeriod({ from, to });
  return { ...(from ? { $gte: from } : {}), ...(to ? { $lte: `${to}\uffff` } : {}) };
}
const STOP_WORDS = new Set(('a about above after again against all am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers herself him himself his how i if in into is it its itself just me more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours yourself yourselves also really much get got like one two dont didnt im ive thats'.split(' ')));
function wordCloud(texts) {
  const counts = new Map();
  for (const text of texts) {
    const cleaned = String(text).replace(/https?:\/\/\S+|\S+@\S+|\+?\d[\d\s()-]{5,}\d/gi, ' ');
    for (const word of cleaned.toLowerCase().match(/\p{L}[\p{L}’']*/gu) || []) {
      const normalized = word.replace(/[’']/g, '');
      if (normalized.length < 3 || STOP_WORDS.has(normalized)) continue;
      counts.set(normalized, (counts.get(normalized) || 0) + 1);
    }
  }
  return [...counts].map(([word, count]) => ({ word, count })).sort((a, b) => b.count - a.count || a.word.localeCompare(b.word)).slice(0, 40);
}
function confirmed(response) {
  return response.source !== 'ai_video' || [true, 1, '1'].includes(response.verified);
}
async function loadStudyReport(studyId, period = {}) {
  const { from, to } = validatePeriod(period);
  const study = await store.findOne('studies', { id: studyId }) || {};
  const respondents = await store.find('respondents', { study_id: studyId, is_practice: 0 });
  const selectionEnd=[to,study.end_date,new Date().toISOString().slice(0,10)].filter(Boolean).sort()[0];
  const cohort = respondents.filter(r => ['active','activated','completed'].includes(r.activation_status) && r.consent_status === 'given' && !r.withdrawn_at && String(r.participation_start||r.activated_at||r.created_at||'').slice(0,10)<=selectionEnd);
  const cohortIds=new Set(cohort.map(r=>r.id));
  const excludedPeople = new Set(respondents.filter(r => r.withdrawn_at || r.consent_status === 'withdrawn' || r.activation_status === 'disqualified').map(r => r.id));
  const records = (await store.find('diary_records', { study_id: studyId, is_practice: 0, status: 'submitted' }, { sort: { entry_time: -1, id: -1 } })).filter(r => {
    const day = String(r.occurrence_time || r.entry_time).slice(0,10);
    return (!from || day >= from) && day <= selectionEnd && !excludedPeople.has(r.respondent_id) && cohortIds.has(r.respondent_id);
  });
  const ids = records.map(r => r.id);
  const [flags, questions, rawAnswers, rawMedia] = await Promise.all([
    store.find('qc_flags', { status: 'open', record_id: { $in: ids } }),
    store.find('questions', { study_id: studyId }),
    store.find('responses', { record_id: { $in: ids } }, { sort: { id: -1 } }),
    store.find('media', { record_id: { $in: ids } }, { sort: { id: -1 } }),
  ]);
  const blocked = new Set(flags.map(f => f.record_id));
  records.filter(r => ['excluded','pending_ai'].includes(r.review_status) || (study.require_record_approval && r.review_status !== 'accepted')).forEach(r => blocked.add(r.id));
  const questionMap = new Map(questions.map(q => [q.id, q]));
  const answerKeys=new Set();
  const answers = rawAnswers.filter(a => {const key=`${a.record_id}:${a.question_id}`;if(blocked.has(a.record_id)||!confirmed(a)||!questionMap.has(a.question_id)||answerKeys.has(key))return false;answerKeys.add(key);return true;});
  const openText = answers.filter(a => questionMap.get(a.question_id).type === 'text' && a.value != null && String(a.value).trim()).map(a => ({ question: questionMap.get(a.question_id).text, answer: String(a.value) }));
  const byRecord = new Map(records.map(r => [r.id, r]));
  const media = rawMedia.filter(m => !blocked.has(m.record_id) && ['photo', 'video', 'audio'].includes(m.media_type)).map(m => ({ id: m.id, record_id:m.record_id, media_type: m.media_type, file_path: m.file_path, day: String(byRecord.get(m.record_id).occurrence_time || byRecord.get(m.record_id).entry_time || '').slice(0, 10) }));
  const distribution = code => {
    const counts = new Map();
    for (const answer of answers) {
      if (questionMap.get(answer.question_id).code !== code || answer.value == null || String(answer.value).trim() === '') continue;
      const label = String(answer.value);
      counts.set(label, (counts.get(label) || 0) + 1);
    }
    return [...counts].map(([label, n]) => ({ label, n })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  };
  const days = new Map();
  records.forEach(r => { const day = String(r.occurrence_time || r.entry_time).slice(0, 10); days.set(day, (days.get(day) || 0) + 1); });
  const eligible = records.filter(r => !blocked.has(r.id));
  const answerMaps = new Map();
  answers.forEach(a => { if (!answerMaps.has(a.record_id)) answerMaps.set(a.record_id, {}); answerMaps.get(a.record_id)[a.question_id] = a.value; });
  const analytics = require('./researchMetrics').analyse({ study, respondents: cohort, records: eligible, answers, questions, from, to });
  return {
    analytics, records, eligibleRecords: eligible, answers, questions, respondents: cohort, study,
    from, to, submitted: records.length, contributors: new Set(records.map(r => r.respondent_id)).size,
    flagged: blocked.size, eligible: eligible.length, media, openText,
    words: wordCloud(openText.map(a => a.answer)), brands: analytics.brands.map(b=>({label:b.brand,n:b.occasions})), occasions: distribution('occasion'),
    trend: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, n]) => ({ day, n })),
    provenance: { respondent: answers.filter(a => a.source !== 'ai_video').length, aiConfirmed: answers.filter(a => a.source === 'ai_video').length, excluded: rawAnswers.length - answers.length },
    entries: eligible.map(r => ({ recordId: r.id, respondentId: r.respondent_id, answers: answerMaps.get(r.id) || {} })),
  };
}
module.exports = { validatePeriod, periodFilter, wordCloud, confirmed, loadStudyReport };
