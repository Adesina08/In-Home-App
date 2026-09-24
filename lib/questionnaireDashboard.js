const { parseOptions } = require('./questionnaire');
const { wordCloud } = require('./studyReport');

const CHOICE_TYPES = new Set(['single', 'multi', 'rank']);
const TEXT_TYPES = new Set(['text', 'longtext']);
const MEDIA_TYPES = new Set(['photo', 'video', 'audio']);

function round(value, places = 2) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function orderOf(question) {
  const order = Number(question.order_index);
  return Number.isFinite(order) ? order : Number(question.id) || Number.MAX_SAFE_INTEGER;
}

function answeredPeople(rows, peopleByRecord) {
  return new Set(rows.map(row => peopleByRecord.get(Number(row.record_id))).filter(id => id != null));
}

function splitValues(value) {
  return String(value == null ? '' : value).split('|').map(item => item.trim()).filter(Boolean);
}

function displayTitle(group, allQuestions) {
  if (!group.sourceCode) return group.questions[0]?.text || 'Untitled question';
  const source = allQuestions.find(question => question.code === group.sourceCode && !question.source_code);
  return source?.text || group.questions[0]?.text || group.sourceCode;
}

function groupedQuestions(questions, evidenceQuestionIds) {
  const sourceCodes = new Set(questions.map(question => question.source_code).filter(Boolean));
  const groups = new Map();
  for (const question of questions.filter(question => evidenceQuestionIds.has(Number(question.id))).sort((a, b) => orderOf(a) - orderOf(b))) {
    const sourceCode = question.source_code || (sourceCodes.has(question.code) ? question.code : null);
    const key = sourceCode ? `source:${sourceCode}:${question.type}` : `question:${question.id}`;
    if (!groups.has(key)) groups.set(key, { key, sourceCode, questions: [] });
    groups.get(key).questions.push(question);
  }
  return [...groups.values()];
}

function optionLabels(group, allQuestions) {
  const labels = [];
  const source = group.sourceCode ? allQuestions.find(question => question.code === group.sourceCode && !question.source_code) : null;
  for (const question of [...(source ? [source] : []), ...group.questions]) {
    for (const option of parseOptions(question.options_json !== undefined ? question.options_json : question.options)) {
      const label = String(option).trim();
      if (label && !labels.includes(label)) labels.push(label);
    }
  }
  return labels;
}

function distributionChart({ group, rows, allQuestions, peopleByRecord, minimumBase, type }) {
  const configured = optionLabels(group, allQuestions);
  const counts = new Map(configured.map(label => [label, { label, n: 0, people: new Set() }]));
  for (const row of rows) {
    const values = type === 'rank' ? splitValues(row.value).slice(0, 1) : [...new Set(splitValues(row.value))];
    for (const label of values) {
      if (!counts.has(label)) counts.set(label, { label, n: 0, people: new Set() });
      const item = counts.get(label);
      item.n += 1;
      const person = peopleByRecord.get(Number(row.record_id));
      if (person != null) item.people.add(person);
    }
  }
  const items = [...counts.values()]
    .filter(item => item.n === 0 || item.people.size >= minimumBase)
    .map(({ label, n }) => ({ label, n }))
    .sort((a, b) => {
      const aOrder = configured.indexOf(a.label), bOrder = configured.indexOf(b.label);
      return b.n - a.n
        || (aOrder < 0 ? Number.MAX_SAFE_INTEGER : aOrder) - (bOrder < 0 ? Number.MAX_SAFE_INTEGER : bOrder)
        || a.label.localeCompare(b.label);
    });
  return {
    kind: 'distribution',
    subtitle: type === 'multi' ? 'Selections across eligible answer instances; totals can exceed 100%.' : type === 'rank' ? 'First-ranked choice across eligible answers.' : 'Eligible answer distribution.',
    items,
  };
}

function scaleChart({ rows, peopleByRecord, minimumBase, group }) {
  const values = rows.map(row => Number(row.value)).filter(Number.isFinite);
  const counts = new Map();
  for (const row of rows) {
    const value = Number(row.value);
    if (!Number.isFinite(value)) continue;
    const label = String(value);
    if (!counts.has(label)) counts.set(label, { label, n: 0, people: new Set() });
    const item = counts.get(label);
    item.n += 1;
    const person = peopleByRecord.get(Number(row.record_id));
    if (person != null) item.people.add(person);
  }
  const question = group.questions[0] || {};
  const hasRange = question.min_value !== null && question.min_value !== undefined && question.min_value !== ''
    && question.max_value !== null && question.max_value !== undefined && question.max_value !== '';
  const minimum = Number(question.min_value), maximum = Number(question.max_value);
  if (hasRange && Number.isInteger(minimum) && Number.isInteger(maximum) && maximum >= minimum && maximum - minimum <= 10) {
    for (let value = minimum; value <= maximum; value += 1) if (!counts.has(String(value))) counts.set(String(value), { label: String(value), n: 0, people: new Set() });
  }
  return {
    kind: 'scale',
    subtitle: 'Rating distribution and mean across eligible answers.',
    average: values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length) : null,
    items: [...counts.values()].filter(item => item.n === 0 || item.people.size >= minimumBase).map(({ label, n }) => ({ label, n })).sort((a, b) => Number(a.label) - Number(b.label)),
  };
}

function numericChart(rows) {
  const values = rows.map(row => Number(row.value)).filter(Number.isFinite);
  return {
    kind: 'numeric',
    subtitle: 'Summary of eligible numeric answers.',
    metrics: values.length ? [
      { label: 'Average', value: round(values.reduce((sum, value) => sum + value, 0) / values.length) },
      { label: 'Median', value: round(median(values)) },
      { label: 'Minimum', value: Math.min(...values) },
      { label: 'Maximum', value: Math.max(...values) },
    ] : [],
  };
}

function textChart(rows, peopleByRecord, minimumBase) {
  const terms = new Map();
  for (const row of rows) {
    const person = peopleByRecord.get(Number(row.record_id));
    for (const item of wordCloud([row.value])) {
      if (!terms.has(item.word)) terms.set(item.word, { label: item.word, n: 0, people: new Set() });
      const term = terms.get(item.word);
      term.n += item.count;
      if (person != null) term.people.add(person);
    }
  }
  const words = [...terms.values()]
    .filter(item => item.people.size >= minimumBase)
    .map(({ label, n }) => ({ label, n }))
    .sort((a, b) => b.n - a.n || a.label.localeCompare(b.label))
    .slice(0, 8);
  return { kind: 'text', subtitle: 'Most frequent terms in eligible written answers.', items: words };
}

function mediaChart(media) {
  return {
    kind: 'media',
    subtitle: 'Eligible evidence submitted for this questionnaire prompt.',
    metrics: [
      { label: 'Files', value: media.length },
      { label: 'Transcribed', value: media.filter(item => item.transcript_status === 'done' && item.transcript_text).length },
      { label: 'Brand detected', value: media.filter(item => item.detected_brand).length },
    ],
  };
}

function buildQuestionnaireDashboard(report, options = {}) {
  const minimumBase = Math.max(1, Number(options.minimumBase) || 1);
  const maxCharts = Math.max(1, Number(options.maxCharts) || 24);
  if (!report || options.suppressed) return { sections: [], chartCount: 0, omittedCount: 0 };

  const questions = Array.isArray(report.questions) ? report.questions : [];
  const answers = Array.isArray(report.answers) ? report.answers : [];
  const media = Array.isArray(options.media) ? options.media : (Array.isArray(report.media) ? report.media : []);
  const peopleByRecord = new Map((report.eligibleRecords || report.records || []).map(record => [Number(record.id), record.respondent_id]));
  const answersByQuestion = new Map();
  for (const answer of answers) {
    const id = Number(answer.question_id);
    if (!answersByQuestion.has(id)) answersByQuestion.set(id, []);
    answersByQuestion.get(id).push(answer);
  }
  const mediaByQuestion = new Map();
  for (const item of media) {
    if (item.question_id == null) continue;
    const id = Number(item.question_id);
    if (!mediaByQuestion.has(id)) mediaByQuestion.set(id, []);
    mediaByQuestion.get(id).push(item);
  }
  const evidenceIds = new Set([...answersByQuestion.keys(), ...mediaByQuestion.keys()]);
  const charts = [];

  for (const group of groupedQuestions(questions, evidenceIds)) {
    const questionIds = group.questions.map(question => Number(question.id));
    const rows = questionIds.flatMap(id => answersByQuestion.get(id) || []);
    const groupMedia = questionIds.flatMap(id => mediaByQuestion.get(id) || []);
    const type = group.questions[0]?.type || 'text';
    if (TEXT_TYPES.has(type) && options.allowText === false) continue;
    if (MEDIA_TYPES.has(type) && options.allowMedia === false) continue;
    const people = new Set([
      ...answeredPeople(rows, peopleByRecord),
      ...groupMedia.map(item => peopleByRecord.get(Number(item.record_id))).filter(id => id != null),
    ]);
    if (people.size < minimumBase) continue;

    let visual;
    if (CHOICE_TYPES.has(type)) visual = distributionChart({ group, rows, allQuestions: questions, peopleByRecord, minimumBase, type });
    else if (type === 'scale') visual = scaleChart({ rows, peopleByRecord, minimumBase, group });
    else if (type === 'numeric') visual = numericChart(rows);
    else if (type === 'date' || type === 'time') visual = distributionChart({ group, rows, allQuestions: questions, peopleByRecord, minimumBase, type: 'single' });
    else if (TEXT_TYPES.has(type)) visual = textChart(rows, peopleByRecord, minimumBase);
    else if (MEDIA_TYPES.has(type)) visual = mediaChart(groupMedia);
    else continue;

    const first = group.questions[0] || {};
    charts.push({
      key: group.key,
      code: group.sourceCode || first.code || `q${first.id}`,
      title: displayTitle(group, questions),
      section: first.section || 'Questionnaire results',
      type,
      answered: MEDIA_TYPES.has(type) ? groupMedia.length : rows.length,
      respondents: people.size,
      ...visual,
    });
  }

  const selected = charts.slice(0, maxCharts);
  const sections = [];
  for (const chart of selected) {
    let section = sections.find(item => item.name === chart.section);
    if (!section) { section = { name: chart.section, charts: [] }; sections.push(section); }
    section.charts.push(chart);
  }
  return { sections, chartCount: selected.length, omittedCount: Math.max(0, charts.length - selected.length) };
}

module.exports = { buildQuestionnaireDashboard };
