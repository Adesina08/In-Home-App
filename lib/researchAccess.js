const store = require('./store');
async function clientGrant(user, studyId) {
  if (['admin','superadmin'].includes(user?.role)) return { study_id: studyId, media: true, exports: true, text: true };
  if (user?.role !== 'client') return null;
  const grant = await store.findOne('client_grants', { user_id: user.id, study_id: studyId });
  if (grant) return grant.enabled === false ? null : grant;
  return Number(user.study_id) === Number(studyId) ? { study_id: studyId, media: false, exports: true, text: false } : null;
}
function clientSafeReport(report, grant) {
  const minimum = Math.max(2,Number(report.study.minimum_base_size)||5);
  const suppressed = new Set(report.eligibleRecords.map(r=>r.respondent_id)).size < minimum;
  const safe = { ...report, suppressed, minimumBase: minimum };
  // Never send the raw dataset through templates or export payloads.
  delete safe.entries; delete safe.study; delete safe.records; delete safe.eligibleRecords; delete safe.answers; delete safe.questions; delete safe.respondents;
  if (!grant.media || suppressed) safe.media = [];
  else {const people=new Set(report.respondents.filter(r=>r.media_consent===true).map(r=>r.id));safe.media=report.media.filter(m=>people.has(report.eligibleRecords.find(r=>r.id===m.record_id)?.respondent_id)).map(({record_id,...media})=>media);}
  if (!grant.text || suppressed) { safe.openText=[];safe.words=[]; }
  if (suppressed) {
    safe.brands=[];safe.occasions=[];safe.trend=[];safe.entries=[];
    safe.submitted=null;safe.contributors=null;safe.eligible=null;safe.flagged=null;
    safe.provenance={ respondent:null,aiConfirmed:null,excluded:null };
    safe.analytics = { ...report.analytics, brands:[],transitions:[],category_incidence_pct:null,repertoire:null,avg_occasions_per_week:null,base:{ respondents:null,valid_occasions:null },compliance:{rate:null,completed:null,expected:null,missing:[]} };
  } else {
    // Suppress low bases within each brand/transition as well as the whole selection.
    safe.analytics = { ...report.analytics, brands: report.analytics.brands.filter(b=>b.consumers>=minimum), transitions:report.analytics.transitions.filter(t=>t.consumers>=minimum) };
    const allowed = new Set(safe.analytics.brands.map(b=>b.brand));
    safe.brands = safe.brands.filter(b=>allowed.has(b.label));
    // Exact occasion/day cells can identify small subgroups; only show qualifying cells.
    safe.occasions=[];safe.trend=[];
    for(const item of report.occasions) {
      const qids=new Set(report.questions.filter(q=>q.code==='occasion').map(q=>q.id));
      const ids=new Set(report.answers.filter(a=>qids.has(a.question_id)&&String(a.value)===item.label).map(a=>a.record_id));
      if(new Set(report.eligibleRecords.filter(r=>ids.has(r.id)).map(r=>r.respondent_id)).size>=minimum)safe.occasions.push(item);
    }
    for(const item of report.trend) if(new Set(report.records.filter(r=>String(r.occurrence_time||r.entry_time).slice(0,10)===item.day).map(r=>r.respondent_id)).size>=minimum)safe.trend.push(item);
    safe.analytics.compliance = { ...safe.analytics.compliance, missing:[] };
  }
  return safe;
}
function clientKpi(kpi,report){
 const {computeKpi,parseConditions,answerMatches}=require('./kpi');
 const minimum=Math.max(2,Number(report.study.minimum_base_size)||5);
 const count=rows=>new Set(rows.map(e=>e.respondentId)).size;
 const conditions=parseConditions(kpi.conditions_json);
 let base=report.entries.filter(e=>conditions.every(c=>answerMatches(e.answers[c.question_id],c.operator,c.value)));
 let numerator=base;
 if(['average','percent_choosing'].includes(kpi.metric))base=base.filter(e=>e.answers[kpi.question_id]!==undefined&&e.answers[kpi.question_id]!==null&&String(e.answers[kpi.question_id]).trim()!=='');
 if(kpi.metric==='average')base=base.filter(e=>Number.isFinite(Number(e.answers[kpi.question_id])));
 if(kpi.metric==='percent_choosing'){const targets=String(kpi.option_value||'').split('|');numerator=base.filter(e=>String(e.answers[kpi.question_id]).split('|').some(v=>targets.includes(v)));}
 const hidden=count(base)<minimum||(count(numerator)>0&&count(numerator)<minimum);
 if(hidden)return{display:'—',basis:'Suppressed: small respondent base'};
 return computeKpi(kpi,report.entries,{respondentIds:report.respondents.map(r=>r.id)});
}
module.exports={clientGrant,clientSafeReport,clientKpi};
