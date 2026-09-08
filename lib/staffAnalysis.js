const store = require('./store');
const { loadStudyReport } = require('./studyReport');
const { percent } = require('./researchMetrics');
const SEGMENTS = { gender: 'Gender', age_band: 'Age group', location: 'Location', education_level: 'Education', occupation: 'Occupation' };
function segmentValue(profile, field) {
  if (field === 'age_band') {
    const age = Number(profile.age);
    return age > 0 ? (age < 25 ? 'Under 25' : age < 35 ? '25–34' : age < 45 ? '35–44' : age < 55 ? '45–54' : '55+') : 'Not recorded';
  }
  return String(profile[field] || 'Not recorded');
}
async function staffAnalysis(studyId, { from = '', to = '', question = '', segment = 'gender' } = {}) {
  if (!Object.hasOwn(SEGMENTS, segment)) throw new Error('Choose a supported demographic group.');
  const report = await loadStudyReport(studyId, { from, to });
  const families = new Map();
  // Open text and media are explored separately; categorical charts keep whole numeric values, including zero.
  for (const q of report.questions) {
    if (!['single', 'multi', 'numeric', 'number', 'select', 'select_one', 'select_multiple'].includes(q.type)) continue;
    const code = q.source_code || q.code || String(q.id);
    if (!families.has(code)) families.set(code, { code, text: q.text, ids: [] });
    families.get(code).ids.push(q.id);
  }
  const questions = [...families.values()];
  const selectedQuestion = question ? families.get(question) : families.get(report.study.brand_question_code || 'brand') || questions[0];
  if (question && !selectedQuestion) throw new Error('Choose a question from this study.');
  const snapshots = await store.find('respondent_profile_snapshots', { study_id: studyId }, { sort: { id: -1 } });
  const profiles = new Map();
  for (const s of snapshots) if (!profiles.has(s.respondent_id)) {
    try { profiles.set(s.respondent_id, JSON.parse(s.snapshot_json || '{}')); } catch { profiles.set(s.respondent_id, {}); }
  }
  const people = new Map(report.respondents.map(r => [r.id, segmentValue(profiles.get(r.id) || r, segment)]));
  const records = new Map(report.eligibleRecords.map(r => [r.id, r]));
  const answerByRecord = new Map();
  for (const a of report.answers) {
    if (!selectedQuestion?.ids.includes(a.question_id) || !records.has(a.record_id) || a.value == null) continue;
    const values = String(a.value).split('|').map(v => v.trim()).filter(Boolean);
    if (!values.length) continue;
    if (!answerByRecord.has(a.record_id)) answerByRecord.set(a.record_id, new Set());
    for (const value of values) answerByRecord.get(a.record_id).add(value);
  }
  const groups = new Map();
  for (const label of people.values()) if (!groups.has(label)) groups.set(label, { label, respondents: new Set(), answered: 0, counts: new Map() });
  const totals = new Map();
  const contributors = new Set();
  for (const [id, values] of answerByRecord) {
    const person = records.get(id).respondent_id;
    const group = groups.get(people.get(person));
    group.answered++; group.respondents.add(person); contributors.add(person);
    for (const value of values) {
      group.counts.set(value, (group.counts.get(value) || 0) + 1);
      totals.set(value, (totals.get(value) || 0) + 1);
    }
  }
  const distribution = [...totals].map(([label, n]) => ({ label, n, pct: percent(n, answerByRecord.size) })).sort((a, b) => b.n - a.n || a.label.localeCompare(b.label));
  const minimum = Math.max(2, Number(report.study.minimum_base_size) || 5);
  const crosstab = [...groups.values()].sort((a, b) => a.label.localeCompare(b.label)).map(g => ({
    label: g.label, respondents: g.respondents.size, answered: g.answered, lowBase: g.respondents.size < minimum,
    cells: distribution.map(d => ({ label: d.label, n: g.counts.get(d.label) || 0, pct: percent(g.counts.get(d.label) || 0, g.answered) })),
  }));
  const days = new Map();
  for (const r of report.eligibleRecords) {
    const day = String(r.occurrence_time || r.entry_time).slice(0, 10);
    days.set(day, (days.get(day) || 0) + 1);
  }
  // Include true zero days between observations so a line never bridges a missing day as activity.
  const bounds = [...days.keys()].sort();
  if (bounds.length) for (let time = Date.parse(bounds[0]); time <= Date.parse(bounds.at(-1)); time += 86400000) {
    const day = new Date(time).toISOString().slice(0, 10); if (!days.has(day)) days.set(day, 0);
  }
  const modes = new Map();
  for (const r of report.eligibleRecords) {
    const label = ({ video: 'Video', form: 'Standard', standard: 'Standard', audio: 'Voice note', voice: 'Voice note' })[r.entry_mode] || 'Not recorded';
    modes.set(label, (modes.get(label) || 0) + 1);
  }
  return { report, questions, question: selectedQuestion?.code || '', questionLabel: selectedQuestion?.text || 'No structured questions available', segment, segments: SEGMENTS, distribution, crosstab, minimum, answered: answerByRecord.size, answerContributors: contributors.size,
    trend: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([label, n]) => ({ label, n })), modes: [...modes].map(([label, n]) => ({ label, n })) };
}
function csvCell(value) { return '"' + String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""') + '"'; }
function analysisCsv(data) {
  const rows = [['Study', data.report.study.name], ['From', data.report.from || 'All dates'], ['To', data.report.to || 'All dates'], ['Question', data.questionLabel], ['Segment', data.segments[data.segment]], ['Percent base', 'Answered eligible occasions within each row; multi-select percentages can exceed 100%'], [], ['Group', 'Answering respondents', 'Answered occasions', ...data.distribution.flatMap(d => [d.label + ' count', d.label + ' row %'])], ...data.crosstab.map(g => [g.label, g.respondents, g.answered, ...g.cells.flatMap(c => [c.n, c.pct])])];
  return '\ufeff' + rows.map(row => row.map(csvCell).join(',')).join('\r\n');
}
module.exports = { staffAnalysis, analysisCsv, SEGMENTS };
