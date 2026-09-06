const store = require('./store');
const { loadStudyReport } = require('./studyReport');
const { participation } = require('./researchMetrics');
const crypto = require('crypto');
async function audit(actor, action, studyId, detail={}) {
  // Governance changes await their audit record; a failed audit is visible to the caller.
  return store.insert('research_audit',{study_id:studyId,actor:actor||'system',action,detail,created_at:store.nowSql()});
}
async function insertOnce(collection, id, doc) {
  try { await store.insert(collection,{...doc,id}); return true; }
  catch(e) { if(e.code===11000)return false; throw e; }
}
async function assignedStudies(user) {
  const studies=await store.find('studies',{status:{$ne:'closed'}},{sort:{id:1}});
  if(user.role!=='interviewer')return studies;
  const assignments=await store.find('interviewer_assignments',{user_id:user.id,enabled:true});
  return studies.filter(s=>assignments.some(a=>a.study_id===s.id));
}
async function assigned(user, studyId) { return (await assignedStudies(user)).some(s=>s.id===studyId); }
function screen(study, answers={}) {
  const rules=study.screener_questions||[];
  if(!rules.length)return {ok:false,error:'The research team must configure the study screener before face-to-face registration.'};
  for(const q of rules){const value=String(answers[q.code]??'').trim();if(!value)return{ok:false,error:`Answer: ${q.text}`};if(!q.allowed.includes(value))return{ok:false,error:'This respondent does not meet the study eligibility criteria.'};}
  return{ok:true};
}
async function handover(respondent, actor) {
  if(respondent.consent_status!=='given'||respondent.withdrawn_at)throw new Error('Study consent is required.');
  if(!respondent.training_completed_at)throw new Error('Complete the training checklist first.');
  if(!await store.count('diary_records',{respondent_id:respondent.id,is_practice:1,status:'submitted'}))throw new Error('The respondent must submit a practice diary on their own device first.');
  if(await store.count('qc_flags',{respondent_id:respondent.id,record_id:null,status:'open'}))throw new Error('Resolve recruitment holds before handover.');
  await audit(actor,'handover',respondent.study_id,{respondent_id:respondent.id});
  await store.update('respondents',{id:respondent.id},{handover_at:store.nowSql(),activated_at:store.nowSql(),activation_status:'activated'});
}
async function incentives(studyId) {
  const report=await loadStudyReport(studyId);
  const rules=await store.find('incentive_rules',{study_id:studyId,enabled:true});
  for(const r of report.respondents)for(const rule of rules){
    let eligible=false, evidence={};
    if(rule.milestone==='onboarding'){eligible=!!r.handover_at||r.recruitment_mode!=='f2f'&&!!r.tutorial_completed_at;evidence={handover_at:r.handover_at};}
    if(rule.milestone==='participation'){
      const p=participation(report.study,[r],report.eligibleRecords);eligible=p.completed>=rule.required_periods&&rule.required_periods>0;evidence={completed:p.completed,required:rule.required_periods};
    }
    if(rule.milestone==='closeout'){eligible=r.end_validation_status==='completed';evidence={end_validation_status:r.end_validation_status};}
    const id=`${studyId}:${rule.milestone}:${rule.required_periods||0}:${r.id}`;
    const existing=await store.findOne('incentive_ledger',{id});
    if(eligible)await insertOnce('incentive_ledger',id,{study_id:studyId,respondent_id:r.id,rule_id:rule.id,milestone:rule.milestone,amount:rule.amount,currency:rule.currency,status:'eligible',evidence,created_at:store.nowSql()});
    if(existing&&existing.status==='eligible'&&!eligible)await store.update('incentive_ledger',{id,status:'eligible'},{status:'held',evidence});
    if(existing&&existing.status==='held'&&eligible)await store.update('incentive_ledger',{id,status:'held'},{status:'eligible',evidence});
  }
  const activeRules=new Set(rules.map(r=>r.id));
  for(const row of await store.find('incentive_ledger',{study_id:studyId,status:'eligible'}))if(!activeRules.has(row.rule_id))await store.update('incentive_ledger',{id:row.id},{status:'held',hold_reason:'Reward rule disabled; review required.'});
  return store.find('incentive_ledger',{study_id:studyId},{sort:{created_at:-1}});
}
async function snapshot(studyId, actor, period={}, id) {
  const report=await loadStudyReport(studyId,period);
  const payload={eligible_contributors:new Set(report.eligibleRecords.map(r=>r.respondent_id)).size,analytics:report.analytics,brands:report.brands,occasions:report.occasions,trend:report.trend,provenance:report.provenance};
  // A snapshot stores aggregate evidence only. Client release is a separate human decision.
  payload.analytics={...payload.analytics,compliance:{...payload.analytics.compliance,missing:[]}};
  const doc={study_id:studyId,period_start:period.from||null,period_end:period.to||null,status:'draft',payload,created_at:store.nowSql(),created_by:actor,fingerprint:crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex')};
  if(id){await insertOnce('report_snapshots',id,doc);return id;}
  return (await store.insert('report_snapshots',doc)).id;
}
async function runResearchJobs(now=new Date()) {
  for(const schedule of await store.find('report_schedules',{enabled:true})){
    try{
      const day=now.toISOString().slice(0,10);
      if(schedule.next_run>day)continue;
      const to=new Date(Date.parse(day)-86400000).toISOString().slice(0,10);
      const from=new Date(Date.parse(day)-schedule.lookback_days*86400000).toISOString().slice(0,10);
      await snapshot(schedule.study_id,'scheduled',{from,to},`schedule:${schedule.id}:${schedule.next_run}`);
      const report=await loadStudyReport(schedule.study_id,{from,to});
      if(report.analytics.compliance.rate!==null&&report.analytics.compliance.rate<schedule.compliance_below)await insertOnce('research_alerts',`${schedule.id}:${schedule.next_run}`,{study_id:schedule.study_id,status:'open',message:`Participation compliance is ${report.analytics.compliance.rate}% (threshold ${schedule.compliance_below}%).`,created_at:store.nowSql()});
      await store.update('report_schedules',{id:schedule.id,next_run:schedule.next_run},{next_run:new Date(Date.parse(day)+schedule.interval_days*86400000).toISOString().slice(0,10),last_success_at:store.nowSql(),last_error:null});
    }catch(e){await store.update('report_schedules',{id:schedule.id},{last_error:e.message,last_error_at:store.nowSql()});}
  }
}
async function visitOutcome(user,id,status,notes=''){
 const visit=await store.findOne('fieldwork_visits',{id:Number(id)});
 if(!visit||user.role==='interviewer'&&visit.user_id!==user.id||!await assigned(user,visit.study_id))throw new Error('Visit not assigned to this account.');
 if(!['visited','no_answer','ineligible','recruited'].includes(status))throw new Error('Choose a valid visit outcome.');
 await audit(user.email,'visit_outcome',visit.study_id,{visit_id:visit.id,status});await store.update('fieldwork_visits',{id:visit.id},{status,notes:String(notes||'').slice(0,2000),visited_at:store.nowSql(),recorded_by:user.id});
}
module.exports={visitOutcome,audit,insertOnce,assignedStudies,assigned,screen,handover,incentives,snapshot,runResearchJobs};
