const store=require('./store');
const {audit}=require('./researchOperations');
const fs=require('fs/promises');
const path=require('path');
async function withdraw(respondent,actor){
  await audit(actor,'withdrawal',respondent.study_id,{respondent_id:respondent.id});
  await store.update('respondents',{id:respondent.id},{consent_status:'withdrawn',activation_status:'withdrawn',withdrawn_at:store.nowSql(),media_consent:false});
  await store.update('incentive_ledger',{respondent_id:respondent.id,status:'eligible'},{status:'held',hold_reason:'Consent withdrawn; research review required.'});
  await store.remove('mobile_sessions',{respondent_id:respondent.id});
  // Previously published narratives may contain this person's evidence; require a fresh review.
  await store.update('ai_summaries',{study_id:respondent.study_id},{review_status:'withdrawal_review'});
  await store.update('report_snapshots',{study_id:respondent.study_id},{status:'withdrawal_review'});
  await store.insert('privacy_requests',{study_id:respondent.study_id,respondent_id:respondent.id,type:'withdrawal',status:'pending',created_at:store.nowSql()});
}
async function retentionCandidates(study,now=new Date()){
  if(!Number(study.retention_days))return[];
  const cutoff=new Date(now.getTime()-Number(study.retention_days)*86400000).toISOString().slice(0,10);
  return(await store.find('respondents',{study_id:study.id})).filter(r=>!r.erased_at&&((r.withdrawn_at&&r.withdrawn_at.slice(0,10)<=cutoff)||(study.end_date&&study.end_date<=cutoff)));
}
async function eraseStudyParticipation(study,respondent,actor){
  if(!(await retentionCandidates(study)).some(r=>r.id===respondent.id))throw new Error('This participation is not due for retention deletion.');
  await audit(actor,'retention_deletion_started',study.id,{respondent_id:respondent.id});
  await store.update('respondents',{id:respondent.id},{consent_status:'withdrawn',activation_status:'withdrawn',media_consent:false});
  const records=await store.find('diary_records',{respondent_id:respondent.id});const ids=records.map(r=>r.id);
  for(const m of await store.find('media',{record_id:{$in:ids}}))await require('./mediaStorage').deleteMedia(m.file_path);
  for(const name of ['responses','media','qc_flags'])await store.remove(name,{record_id:{$in:ids}});
  for(const name of ['diary_records','respondent_profile_snapshots','end_validations','mobile_sessions','respondent_credentials','coded_verbatims'])await store.remove(name,name==='coded_verbatims'?{record_id:{$in:ids}}:{respondent_id:respondent.id});
  await store.update('respondents',{id:respondent.id},{name:null,contact:null,unique_token:null,account_id:null,profile_id:null,screener_answers:null,erased_at:store.nowSql()});
  await store.update('privacy_requests',{respondent_id:respondent.id},{status:'completed',completed_at:store.nowSql()});
  await store.remove('ai_summaries',{study_id:study.id});await store.remove('report_snapshots',{study_id:study.id});
  await audit(actor,'retention_deletion_completed',study.id,{respondent_id:respondent.id});
}
module.exports={withdraw,retentionCandidates,eraseStudyParticipation};
