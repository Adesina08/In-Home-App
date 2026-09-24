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
  const assignedIds=new Set(assignments.map(a=>a.study_id));
  // `users.study_id` is written at account-creation time in the same request
  // that's meant to also write the matching interviewer_assignments row --
  // but the two are two separate writes, not one transaction, and there is
  // no admin UI to fix an interviewer's study scope after the fact. If the
  // second write is ever lost (a request interrupted mid-flight is enough),
  // the account is otherwise stuck locked out of every study with nothing
  // in the UI to explain why. Falling back to the legacy column here is the
  // same trade already made for admin/client roles elsewhere in this file.
  if(user.study_id!=null)assignedIds.add(user.study_id);
  return studies.filter(s=>assignedIds.has(s.id));
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
function rewardRuleOrder(rule) {
  if(rule.milestone==='onboarding')return 0;
  if(rule.milestone==='participation')return 10+(Number(rule.required_periods)||0);
  return 100000;
}
function safeCompleted(progress) { return Number(progress&&progress.completed)||0; }
function rewardCelebrationSettings(study={}) {
  const duration=Number(study.reward_celebration_duration_ms);
  return{
    enabled:study.reward_celebration_enabled!==false,
    headline:String(study.reward_celebration_headline||'Reward unlocked!').slice(0,80),
    message:String(study.reward_celebration_message||'You completed {milestone}. {amount} is eligible and awaiting payment.').slice(0,240),
    primaryColor:/^#[0-9A-F]{6}$/i.test(study.reward_celebration_primary_color||'')?study.reward_celebration_primary_color:'#1D4ED8',
    accentColor:/^#[0-9A-F]{6}$/i.test(study.reward_celebration_accent_color||'')?study.reward_celebration_accent_color:'#72D8FF',
    durationMs:Number.isFinite(duration)?Math.min(6000,Math.max(1500,duration)):3200,
  };
}
function rewardLabel(row) {
  if(row.milestone==='onboarding')return'Getting started';
  if(row.milestone==='closeout')return'Final study completion';
  return`${Number(row.evidence&&row.evidence.required)||''} participation period${Number(row.evidence&&row.evidence.required)===1?'':'s'}`.trim();
}
function rewardCelebration(study,ledger) {
  const settings=rewardCelebrationSettings(study);if(!settings.enabled)return null;
  const rows=ledger.filter(row=>['eligible','processing','paid'].includes(row.status)&&(Number(row.celebration_seen_version)||0)<(Number(row.celebration_version)||1));
  if(!rows.length)return null;
  const currency=rows[0].currency;const amount=rows.filter(row=>row.currency===currency).reduce((sum,row)=>sum+Number(row.amount||0),0);
  const milestone=rows.length===1?rewardLabel(rows[0]):`${rows.length} reward milestones`;
  const amountLabel=`${currency} ${amount.toLocaleString()}`;
  const defaultMessage=rows.every(row=>row.status==='paid')?'Your reward has been marked as paid by the research team.':settings.message;
  const message=defaultMessage.replaceAll('{amount}',amountLabel).replaceAll('{milestone}',milestone).replaceAll('{count}',String(rows.length));
  return{headline:settings.headline,message,primaryColor:settings.primaryColor,accentColor:settings.accentColor,durationMs:settings.durationMs,amount,currency,items:rows.map(row=>({ledgerId:row.id,version:Number(row.celebration_version)||1,milestone:row.milestone,amount:row.amount,currency:row.currency,status:row.status}))};
}
async function evaluateIncentives(studyId,{respondentId}={}) {
  const report=await loadStudyReport(studyId);
  const rules=(await store.find('incentive_rules',{study_id:studyId,enabled:true})).sort((a,b)=>rewardRuleOrder(a)-rewardRuleOrder(b));
  const respondents=respondentId==null?report.respondents:report.respondents.filter(r=>r.id===Number(respondentId));
  const participationTarget=Math.max(0,...rules.filter(rule=>rule.milestone==='participation').map(rule=>Number(rule.required_periods)||0));
  const respondentIds=respondents.map(r=>r.id);
  const blockingFlags=respondentIds.length?await store.find('qc_flags',{respondent_id:{$in:respondentIds},status:'open',severity:{$in:['critical','high']}}):[];
  const blockedRespondents=new Set(blockingFlags.map(flag=>flag.respondent_id));
  const progressByRespondent=new Map();

  for(const r of respondents){
    const validProgress=participation(report.study,[r],report.eligibleRecords);
    const submittedProgress=participation(report.study,[r],report.records);
    progressByRespondent.set(r.id,{valid:validProgress,submitted:submittedProgress,blocking:blockedRespondents.has(r.id)});
    for(const rule of rules){
      let eligible=false,evidence={};
      if(rule.milestone==='onboarding'){
        eligible=!!r.handover_at||(report.study.recruitment_mode!=='f2f'&&!!r.tutorial_completed_at);
        evidence={handover_at:r.handover_at,tutorial_completed_at:r.tutorial_completed_at};
      }
      if(rule.milestone==='participation'){
        eligible=safeCompleted(validProgress)>=Number(rule.required_periods)&&Number(rule.required_periods)>0;
        evidence={completed:safeCompleted(validProgress),submitted:safeCompleted(submittedProgress),required:Number(rule.required_periods)};
      }
      if(rule.milestone==='closeout'){
        eligible=r.end_validation_status==='completed'&&safeCompleted(validProgress)>=participationTarget&&!blockedRespondents.has(r.id);
        evidence={end_validation_status:r.end_validation_status,completed:safeCompleted(validProgress),required:participationTarget,blocking_qc:blockedRespondents.has(r.id)};
      }

      // Older ledgers used milestone/threshold in the id. Looking up by
      // rule_id preserves them, while a replacement rule at the same threshold
      // can now earn independently under its own rule-scoped id.
      const legacyId=`${studyId}:${rule.milestone}:${rule.required_periods||0}:${r.id}`;
      const existing=await store.findOne('incentive_ledger',{respondent_id:r.id,rule_id:rule.id})||await store.findOne('incentive_ledger',{id:legacyId});
      const id=existing?existing.id:`${studyId}:rule:${rule.id}:${r.id}`;
      if(eligible&&!existing)await insertOnce('incentive_ledger',id,{study_id:studyId,respondent_id:r.id,rule_id:rule.id,milestone:rule.milestone,amount:rule.amount,currency:rule.currency,status:'eligible',evidence,celebration_version:1,celebration_seen_version:0,created_at:store.nowSql(),updated_at:store.nowSql()});
      if(existing&&['eligible','processing'].includes(existing.status)&&!eligible)await store.update('incentive_ledger',{id,status:existing.status},{status:'held',hold_reason:'Reward requirements are under review.',evidence,updated_at:store.nowSql()});
      if(existing&&existing.status==='held'&&eligible)await store.update('incentive_ledger',{id,status:'held'},{status:'eligible',hold_reason:null,evidence,updated_at:store.nowSql()});
    }
  }

  const activeRules=new Set(rules.map(r=>r.id));
  const ledgerFilter={study_id:studyId,...(respondentId==null?{}:{respondent_id:Number(respondentId)})};
  for(const row of await store.find('incentive_ledger',ledgerFilter))if(['eligible','processing'].includes(row.status)&&!activeRules.has(row.rule_id))await store.update('incentive_ledger',{id:row.id},{status:'held',hold_reason:'Reward rule disabled; review required.',updated_at:store.nowSql()});
  const ledger=await store.find('incentive_ledger',ledgerFilter,{sort:{created_at:-1}});
  return{report,rules,respondents,participationTarget,progressByRespondent,ledger};
}
async function incentives(studyId,options={}) {
  return (await evaluateIncentives(studyId,options)).ledger;
}
async function rewardProgress(studyId,respondentId) {
  const context=await evaluateIncentives(studyId,{respondentId});
  const respondent=context.respondents[0]||await store.findOne('respondents',{id:Number(respondentId),study_id:studyId});
  if(!respondent)return{rewards:[],summary:[],lastUpdated:store.nowSql()};
  const progress=context.progressByRespondent.get(respondent.id)||{valid:{completed:0},submitted:{completed:0},blocking:false};
  const ledgerByRule=new Map(context.ledger.filter(row=>row.rule_id!=null).map(row=>[row.rule_id,row]));
  const cadence=progress.valid.cadence||progress.submitted.cadence||context.report.study.diary_mode||'study';
  const rewards=context.rules.map(rule=>{
    const ledger=ledgerByRule.get(rule.id);
    const required=rule.milestone==='participation'?Number(rule.required_periods)||0:rule.milestone==='closeout'?context.participationTarget:1;
    const completed=rule.milestone==='participation'?safeCompleted(progress.valid):rule.milestone==='closeout'?safeCompleted(progress.valid):(respondent.handover_at||respondent.tutorial_completed_at?1:0);
    const submitted=rule.milestone==='participation'?safeCompleted(progress.submitted):completed;
    let status=ledger&&ledger.status;
    if(!status){
      const awaitingReview=rule.milestone==='participation'&&submitted>=required&&completed<required||rule.milestone==='closeout'&&respondent.end_validation_status==='completed'&&((submitted>=required&&completed<required)||progress.blocking);
      status=awaitingReview?'under_review':'in_progress';
    }
    return{
      ledgerId:ledger&&ledger.id||null,ruleId:rule.id,milestone:rule.milestone,amount:rule.amount,currency:rule.currency,status,
      requiredPeriods:required,completedPeriods:Math.min(completed,required||completed),submittedPeriods:submitted,cadence,
      paidAt:ledger&&ledger.paid_at||null,paymentReference:ledger&&ledger.payment_reference||null,
      holdReason:status==='held'?'This reward needs review by the research team.':null,active:true,
    };
  });
  const activeRuleIds=new Set(context.rules.map(rule=>rule.id));
  for(const row of context.ledger){
    if(activeRuleIds.has(row.rule_id))continue;
    rewards.push({ledgerId:row.id,ruleId:row.rule_id,milestone:row.milestone,amount:row.amount,currency:row.currency,status:row.status,requiredPeriods:Number(row.evidence&&row.evidence.required)||0,completedPeriods:Number(row.evidence&&row.evidence.completed)||0,submittedPeriods:Number(row.evidence&&row.evidence.submitted)||0,cadence,paidAt:row.paid_at||null,paymentReference:row.payment_reference||null,holdReason:row.status==='held'?'This reward needs review by the research team.':null,active:false});
  }
  const summary=[...new Set(rewards.map(reward=>reward.currency))].map(currency=>{
    const currencyRewards=rewards.filter(reward=>reward.currency===currency);
    const total=status=>currencyRewards.filter(reward=>reward.status===status).reduce((sum,reward)=>sum+Number(reward.amount||0),0);
    return{currency,potential:currencyRewards.filter(reward=>reward.active).reduce((sum,reward)=>sum+Number(reward.amount||0),0),eligible:total('eligible'),processing:total('processing'),paid:total('paid'),held:total('held')};
  });
  return{rewards,summary,cadence,celebration:rewardCelebration(context.report.study,context.ledger),lastUpdated:store.nowSql()};
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
module.exports={visitOutcome,audit,insertOnce,assignedStudies,assigned,screen,handover,incentives,rewardProgress,rewardCelebrationSettings,snapshot,runResearchJobs};
