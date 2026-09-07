const express = require('express');
const store = require('../lib/store');
const { requireRole } = require('../lib/auth');
const { loadStudyReport, validatePeriod, periodFilter } = require('../lib/studyReport');
const { computeKpi } = require('../lib/kpi');
const {clientGrant,clientSafeReport,clientKpi}=require('../lib/researchAccess');
const router = express.Router();
router.use(requireRole('client', 'admin'));

async function loadPage(req, res, next) {
  const user=req.session.user;
  const available=await store.find('studies',{}, {sort:{id:1}});
  const studies=[];for(const s of available)if(await clientGrant(user,s.id))studies.push(s);
  const requested = req.query.study === undefined ? studies[0]?.id : Number(req.query.study);
  const study = studies.find(s => s.id === requested);
  if (!study) return res.status(404).render('error', { message: 'This study is not available to your account.', user: req.session.user });
  let period;
  try { period = validatePeriod({ from: req.query.from, to: req.query.to }); }
  catch (e) { return res.status(400).render('error', { message: e.message, user: req.session.user }); }
  const grant=await clientGrant(user,study.id);
  const raw=await loadStudyReport(study.id,period);
  const report=user.role==='client'?clientSafeReport(raw,grant):raw;
  const kpis=await store.find('kpi_config',{study_id:study.id,enabled:1},{sort:{id:1}});
  const summaries=await store.find('ai_summaries',{study_id:study.id,review_status:'approved',period_start:period.from||null,period_end:period.to||null},{sort:{generated_at:-1,id:-1}});
  const summary=summaries[0];
  const insight=summary&&!report.suppressed?{...summary,narrative:summary.client_narrative||summary.narrative}:null;
  const a=report.analytics;
  const fmt=n=>n===null||n===undefined?'—':`${n}%`;
  const builtIn={completion_rate:fmt(a.compliance.rate),compliance_rate:fmt(a.compliance.rate),active_respondents:report.suppressed?'—':raw.respondents.length,qc_flag_rate:report.suppressed?'—':fmt(require('../lib/researchMetrics').percent(raw.flagged,raw.submitted)),brand_incidence:'See brand table',avg_occasions_per_week:a.avg_occasions_per_week??'—'};
  const kpiValues=kpis.map(k=>{const result=!report.suppressed?(user.role==='client'?clientKpi(k,raw):computeKpi(k,raw.entries,{respondentIds:raw.respondents.map(r=>r.id)})):null;return{...k,display:result?.display??builtIn[k.kpi_key]??'—',basis:result?.basis||''};});
  res.locals.clientData={study,studies,report,kpis:kpiValues,insight,grant,completionRate:a.compliance.rate,active:report.suppressed?'—':raw.respondents.length,totalRespondents:report.suppressed?'—':raw.respondents.length,...period};
  next();
}
router.get(['/', '/insights'], loadPage, (req, res) => res.render('client/dashboard', { ...res.locals.clientData, insights: req.path === '/insights' }));
router.get('/analysis',loadPage,async(req,res)=>{
  const base=res.locals.clientData;
  const interpreter=require('../lib/researchInsights').interpretQuery(req.query.ask);
  if(req.query.segment&&!require('../lib/researchInsights').SEGMENTS.includes(req.query.segment))return res.status(400).render('error',{message:'Choose a supported segment.'});
  const data=await require('../lib/researchInsights').insights(base.study.id,{from:base.from,to:base.to,segment:req.query.segment||interpreter.segment||'gender',compare:req.query.compare==='1'||interpreter.compare});
  const min=Math.max(2,Number(base.study.minimum_base_size)||5);
  // Entire tables are suppressed if a group or cell has a small base, preventing deduction through totals.
  const suppress=base.report.suppressed||data.crossTabs.some(c=>c.base<min||c.values.some(v=>v.consumers<min));
  const tabs=suppress?[]:data.crossTabs;
  const comparison=!base.report.suppressed&&data.comparison?{...data.comparison,brands:data.comparison.brands.filter(b=>b.consumers>=min&&b.previousConsumers>=min)}:null;
  const themes=base.report.suppressed?[]:data.themes.filter(t=>t.consumers>=min);
  res.render('client/analysis',{...base,segment:data.segment,segments:require('../lib/researchInsights').SEGMENTS,tabs,comparison,themes,suppress,ask:req.query.ask||'',queryLabel:interpreter.label});
});
router.get('/reports',loadPage,async(req,res)=>{
  const base=res.locals.clientData,min=Math.max(2,Number(base.study.minimum_base_size)||5);
  const rows=await store.find('report_snapshots',{study_id:base.study.id,status:'approved'},{sort:{created_at:-1}});
  const snapshots=rows.filter(r=>r.payload.eligible_contributors>=min).map(row=>({...row,payload:{analytics:{...row.payload.analytics,brands:row.payload.analytics.brands.filter(b=>b.consumers>=min),transitions:[]}}}));
  res.render('client/report_history',{...base,snapshots});
});
router.get('/export', loadPage, (req, res) => {
  const { report, study, from, to, grant } = res.locals.clientData;
  if(!grant.exports)return res.status(403).render("error",{message:"CSV exports are not enabled for this account."});
  const rows = [['Study', study.name], ['Period start', from || 'All dates'], ['Period end', to || 'All dates'], ['Metric', 'Value'], ['Compliance percent',report.analytics.compliance.rate],['Expected participation periods',report.analytics.compliance.expected],['Completed participation periods',report.analytics.compliance.completed],['Occasions per participant week',report.analytics.avg_occasions_per_week], ['Submitted entries', report.submitted], ['Contributors', report.contributors], ['Entries with open QC flags', report.flagged], ['Eligible entries', report.eligible], [], ['Brand','Consumers','Consumer incidence percent','Occasions','Occasion share percent','Repeat percent','Volume share percent'],...report.analytics.brands.map(b=>[b.brand,b.consumers,b.consumer_incidence_pct,b.occasions,b.share_of_occasions_pct,b.repeat_rate_pct,b.share_of_volume_pct]), [], ['Brand answer', 'Mentions'], ...report.brands.map(b => [b.label, b.n]), [], ['Occasion answer', 'Mentions'], ...report.occasions.map(o => [o.label, o.n]), [], ['Day', 'Submitted entries'], ...report.trend.map(t => [t.day, t.n]), [], ['Word', 'Mentions'], ...report.words.map(w => [w.word, w.count])];
  const cell = value => `"${String(value ?? '').replace(/^[=+@\-\t\r]/, "'$&").replace(/"/g, '""')}"`;
  res.attachment(`study-${study.id}-report.csv`).type('text/csv').send('\ufeff' + rows.map(row => row.map(cell).join(',')).join('\r\n'));
});
module.exports = router;
