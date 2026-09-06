const express = require('express');
const store = require('../lib/store');
const { requireRole } = require('../lib/auth');
const { loadStudyReport, validatePeriod, periodFilter } = require('../lib/studyReport');
const { computeKpi } = require('../lib/kpi');
const router = express.Router();
router.use(requireRole('client', 'admin'));

async function loadPage(req, res, next) {
  const assigned = req.session.user.study_id;
  const studies = assigned ? [await store.findOne('studies', { id: assigned })].filter(Boolean) : req.session.user.role === 'client' ? [] : await store.find('studies', {}, { sort: { id: 1 } });
  const requested = req.query.study === undefined ? studies[0]?.id : Number(req.query.study);
  const study = studies.find(s => s.id === requested);
  if (!study) return res.status(404).render('error', { message: 'This study is not available to your account.', user: req.session.user });
  let period;
  try { period = validatePeriod({ from: req.query.from, to: req.query.to }); }
  catch (e) { return res.status(400).render('error', { message: e.message, user: req.session.user }); }
  const report = await loadStudyReport(study.id, period);
  const [kpis, respondents, totalEntries, insight] = await Promise.all([
    store.find('kpi_config', { study_id: study.id, enabled: 1 }, { sort: { id: 1 } }),
    store.find('respondents', { study_id: study.id, is_practice: 0 }),
    store.count('diary_records', { study_id: study.id, is_practice: 0, ...((period.from || period.to) ? { entry_time: periodFilter(period.from, period.to) } : {}) }),
    store.findOne('ai_summaries', { study_id: study.id, period_start: period.from || null, period_end: period.to || null }, { sort: { generated_at: -1, id: -1 } }),
  ]);
  const completionRate = totalEntries ? Math.round(report.submitted / totalEntries * 100) : 0;
  const active = respondents.filter(r => ['active', 'activated'].includes(r.activation_status)).length;
  const firstDay = period.from || report.trend[0]?.day;
  const lastDay = period.to || report.trend.at(-1)?.day;
  const weeks = firstDay && lastDay ? Math.max(1, (Date.parse(lastDay) - Date.parse(firstDay)) / 86400000 + 1) / 7 : 0;
  const builtIn = {
    completion_rate: `${completionRate}%`, compliance_rate: `${completionRate}%`, active_respondents: active,
    qc_flag_rate: `${report.submitted ? Math.round(report.flagged / report.submitted * 100) : 0}%`,
    brand_incidence: report.brands.length,
    avg_occasions_per_week: active && weeks ? (report.submitted / active / weeks).toFixed(1) : '—',
  };
  const kpiValues = kpis.map(k => { const result = computeKpi(k, report.entries); return { ...k, display: result?.display ?? builtIn[k.kpi_key] ?? '—', basis: result?.basis || '' }; });
  res.locals.clientData = { study, studies, report, kpis: kpiValues, insight, completionRate, active, totalRespondents: respondents.length, ...period };
  next();
}
router.get(['/', '/insights'], loadPage, (req, res) => res.render('client/dashboard', { ...res.locals.clientData, insights: req.path === '/insights' }));
router.get('/export', loadPage, (req, res) => {
  const { report, study, from, to } = res.locals.clientData;
  const rows = [['Study', study.name], ['Period start', from || 'All dates'], ['Period end', to || 'All dates'], ['Metric', 'Value'], ['Submitted entries', report.submitted], ['Contributors', report.contributors], ['Entries with open QC flags', report.flagged], ['Eligible entries', report.eligible], [], ['Brand answer', 'Mentions'], ...report.brands.map(b => [b.label, b.n]), [], ['Occasion answer', 'Mentions'], ...report.occasions.map(o => [o.label, o.n]), [], ['Day', 'Submitted entries'], ...report.trend.map(t => [t.day, t.n]), [], ['Word', 'Mentions'], ...report.words.map(w => [w.word, w.count])];
  const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`;
  res.attachment(`study-${study.id}-report.csv`).type('text/csv').send('\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'));
});
module.exports = router;
