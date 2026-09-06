const express=require('express');
const store=require('../lib/store');
const {requireRole}=require('../lib/auth');
const {validatePeriod}=require('../lib/studyReport');
const {insights,interpretQuery,SEGMENTS}=require('../lib/researchInsights');
const ops=require('../lib/researchOperations');
const router=express.Router();
router.use(requireRole('admin','research'));
router.use('/studies/:id/research',async(req,res,next)=>{
  req.study=await store.findOne('studies',{id:Number(req.params.id)});
  if(!req.study)return res.status(404).render('error',{message:'Study not found.'});
  next();
});
router.get('/studies/:id/research',async(req,res)=>{
  const study=req.study;let period;
  try { period=validatePeriod(req.query); } catch(e) { return res.status(400).render("error",{message:e.message}); }
  const query=interpretQuery(req.query.ask);const segment=req.query.segment||query.segment||'gender';
  if(!SEGMENTS.includes(segment))return res.status(400).render("error",{message:"Choose a supported segment."});
  const data=await insights(study.id,{...period,segment,question:req.query.question||'',compare:req.query.compare==='1'||query.compare});
  const collections=['fieldwork_visits','interviewer_assignments','incentive_rules','incentive_ledger','report_schedules','report_snapshots','research_alerts','client_grants','backchecks','privacy_requests','research_audit'];
  const lists={};for(const name of collections)lists[name]=await store.find(name,{study_id:study.id},{sort:{id:-1},limit:100});
  res.render('admin/research',{syncIssues:await store.find('diary_submissions',{respondent_id:{$in:(await store.find('respondents',{study_id:study.id})).map(r=>r.id)},state:{$ne:'done'}},{sort:{created_at:-1},limit:50}),retention:await require('../lib/researchPrivacy').retentionCandidates(study),themes:await store.find('theme_codes',{study_id:study.id}),study,data,lists,period,SEGMENTS,query,ask:req.query.ask||'',users:await store.find('users',{}, {projection:{id:1,name:1,email:1,role:1}}),respondents:await store.find('respondents',{study_id:study.id}),summaries:await store.find('ai_summaries',{study_id:study.id},{sort:{id:-1},limit:20}),error:req.query.error||'',saved:req.query.saved==='1'});
});
function positive(value,label,max=100000){const n=Number(value);if(!Number.isFinite(n)||n<=0||n>max)throw new Error(`${label} must be greater than zero and at most ${max}.`);return n;}
function whole(value,label,max=100000){const n=positive(value,label,max);if(!Number.isInteger(n))throw new Error(`${label} must be a whole number.`);return n;}
function json(value,fallback){if(!value)return fallback;try{return JSON.parse(value);}catch{throw new Error('Check the JSON configuration.');}}
router.post('/studies/:id/research/:action',async(req,res)=>{
  const study=req.study,b=req.body,actor=req.session.user.email,action=req.params.action;
  try{
    if(action==='settings'){
      const required=whole(b.required_entries_per_period,'Entries per period',100);
      const min=whole(b.minimum_base_size,'Minimum base',1000);if(min<2)throw new Error('Minimum base must be at least two.');
      const patch={required_entries_per_period:required,minimum_base_size:min,brand_question_code:String(b.brand_question_code||'brand'),quantity_question_code:String(b.quantity_question_code||'quantity'),volume_unit:String(b.volume_unit||'').trim(),volume_unit_factor:b.volume_unit_factor?positive(b.volume_unit_factor,'Unit conversion'):null,hybrid_summary_cadence:b.hybrid_summary_cadence==='daily'?'daily':'weekly',require_record_approval:b.require_record_approval==='1',retention_days:b.retention_days?whole(b.retention_days,'Retention days',36500):null};
      await ops.audit(actor,action,study.id,patch);await store.update('studies',{id:study.id},patch);
    }else if(action==='advanced-question'){
      const q=await store.findOne('questions',{id:Number(b.question_id),study_id:study.id});if(!q)throw new Error('Question not found.');
      const nth=b.every_nth_occasion?whole(b.every_nth_occasion,'Every nth occasion',1000):null;
      const from=b.from_hour_utc===''?null:Number(b.from_hour_utc),to=b.to_hour_utc===''?null:Number(b.to_hour_utc);
      if((from===null)!==(to===null)||from!==null&&(!Number.isInteger(from)||!Number.isInteger(to)||from<0||from>23||to<0||to>23||from===to))throw new Error('Set both UTC hours (0–23), with different start and end hours, or leave both blank.');
      await ops.audit(actor,action,study.id,{question_id:q.id});await store.update('questions',{id:q.id},{rotate_options:b.rotate_options==='1',every_nth_occasion:nth,from_hour_utc:from,to_hour_utc:to});
    }else if(action==='loop'){
      const q=await store.findOne('questions',{id:Number(b.question_id),study_id:study.id});if(!q||q.loop_source_id)throw new Error('Choose a base question to repeat.');
      if(!['product','member'].includes(b.kind))throw new Error('Choose product or household member.');
      const items=[...new Set(String(b.items||'').split('\n').map(s=>s.trim()).filter(Boolean))];if(!items.length||items.length>30)throw new Error('Enter 1–30 loop items, one per line.');
      const {id,...base}=q;
      await ops.audit(actor,action,study.id,{question_id:q.id,items});
      for(const [i,item] of items.entries()){
        if(await store.findOne('questions',{study_id:study.id,loop_source_id:id,loop_item:item}))continue;
        await store.insert('questions',{...base,active:1,code:`${q.code||'q'+q.id}__${b.kind}_${i+1}`,source_code:q.code,loop_source_id:id,loop_kind:b.kind,loop_item:item,text:`${q.text} — ${item}`,order_index:Number(q.order_index)+(i+1)/100});
      }
      await store.update('questions',{id:q.id},{active:0});
    }else if(action==='instrument'){
      const screener=json(b.screener_questions,[]);if(!Array.isArray(screener)||screener.some(q=>!q.code||!q.text||!Array.isArray(q.options)||!Array.isArray(q.allowed)||!q.allowed.length||q.allowed.some(a=>!q.options.includes(a))))throw new Error('Each screener needs code, text, options and allowed answers.');
      const closeout=json(b.close_out_questions,[]);if(!Array.isArray(closeout)||closeout.some(q=>!q.code||!q.text||!['text','single'].includes(q.type)||(q.type==='single'&&!Array.isArray(q.options))))throw new Error('Close-out questions need code, text, type (single or text) and options for single choice.');
      await ops.audit(actor,action,study.id);await store.update('studies',{id:study.id},{screener_questions:screener,close_out_questions:closeout});
    }else if(action==='assignment'){
      const user=await store.findOne('users',{id:Number(b.user_id),role:'interviewer'});if(!user)throw new Error('Choose an interviewer.');
      const id=`${study.id}:${user.id}`;await ops.audit(actor,action,study.id,{user_id:user.id});
      await ops.insertOnce('interviewer_assignments',id,{study_id:study.id,user_id:user.id});await store.update('interviewer_assignments',{id},{enabled:b.enabled==='1',area:String(b.area||''),household_target:b.household_target?whole(b.household_target,'Household target'):null,updated_at:store.nowSql()});
    }else if(action==='visit'){
      const user=await store.findOne('users',{id:Number(b.user_id),role:'interviewer'});if(!user||!await ops.assigned(user,study.id))throw new Error('Assign this interviewer to the study first.');
      if(!String(b.household_code||'').trim()||!String(b.address||'').trim())throw new Error('Enter the household reference and visit location.');
      const {from}=validatePeriod({from:b.visit_date});if(!from)throw new Error('Choose the planned visit date.');
      await ops.audit(actor,action,study.id,{user_id:user.id});await store.insert('fieldwork_visits',{study_id:study.id,user_id:user.id,household_code:String(b.household_code),address:String(b.address),visit_date:from,status:'planned',created_at:store.nowSql()});
    }else if(action==='incentive-rule'){
      if(!['onboarding','participation','closeout'].includes(b.milestone))throw new Error('Choose an approved milestone.');
      if(!/^[A-Z]{3}$/.test(b.currency||''))throw new Error('Enter a three-letter currency code.');
      const rule={study_id:study.id,milestone:b.milestone,amount:positive(b.amount,'Amount'),currency:b.currency,required_periods:b.milestone==='participation'?whole(b.required_periods,'Completed periods'):null,enabled:true};
      if(await store.findOne('incentive_rules',{study_id:study.id,milestone:rule.milestone,required_periods:rule.required_periods,enabled:true}))throw new Error('An active rule already exists for this milestone. Disable it before configuring a replacement.');
      await ops.audit(actor,action,study.id,rule);await store.insert('incentive_rules',rule);
    }else if(action==='disable-rule'||action==='disable-schedule'){
      const collection=action==='disable-rule'?'incentive_rules':'report_schedules';const row=await store.findOne(collection,{id:Number(b.id),study_id:study.id});if(!row)throw new Error('Configuration not found.');await ops.audit(actor,action,study.id,{id:row.id});await store.update(collection,{id:row.id},{enabled:false});if(action==='disable-rule')await ops.incentives(study.id);
    }else if(action==='incentive-evaluate'){await ops.incentives(study.id);await ops.audit(actor,action,study.id);
    }else if(action==='incentive-pay'){
      await ops.incentives(study.id);const row=await store.findOne('incentive_ledger',{id:b.ledger_id,study_id:study.id,status:'eligible'});if(!row)throw new Error('This reward is not currently eligible.');
      if(!String(b.reference||'').trim())throw new Error('Enter the completed payment reference.');
      await ops.audit(actor,action,study.id,{ledger_id:row.id,reference:b.reference});await store.update('incentive_ledger',{id:row.id,status:'eligible'},{status:'paid',paid_at:store.nowSql(),paid_by:actor,payment_reference:b.reference});
    }else if(action==='grant'){
      const user=await store.findOne('users',{id:Number(b.user_id),role:'client'});if(!user)throw new Error('Choose a client account.');
      const id=`${study.id}:${user.id}`;await ops.audit(actor,action,study.id,{user_id:user.id});await ops.insertOnce('client_grants',id,{study_id:study.id,user_id:user.id});await store.update('client_grants',{id},{enabled:b.enabled==='1',media:b.media==='1',text:b.text==='1',exports:b.exports==='1'});
    }else if(action==='schedule'){
      const interval=whole(b.interval_days,'Interval days',365),lookback=whole(b.lookback_days,'Window days',3650);const threshold=Number(b.compliance_below);if(!Number.isFinite(threshold)||threshold<0||threshold>100)throw new Error('Compliance threshold must be 0–100.');
      const {from}=validatePeriod({from:b.next_run});if(!from)throw new Error('Choose the first run date.');
      await ops.audit(actor,action,study.id);await store.insert('report_schedules',{study_id:study.id,enabled:true,interval_days:interval,lookback_days:lookback,compliance_below:threshold,next_run:from});
    }else if(action==='run-jobs'){await ops.runResearchJobs();await ops.audit(actor,action,study.id);
    }else if(action==='snapshot'){await ops.snapshot(study.id,actor,validatePeriod(b));
    }else if(action==='approve-summary'){
      const row=await store.findOne('ai_summaries',{id:Number(b.id),study_id:study.id});if(!row)throw new Error('Summary not found.');await ops.audit(actor,action,study.id,{summary_id:row.id});await store.update('ai_summaries',{id:row.id},{review_status:'approved',approved_by:actor,approved_at:store.nowSql(),client_narrative:String(b.narrative||'').trim()||row.narrative});
    }else if(action==='approve-report'){
      const id=/^\d+$/.test(b.id)?Number(b.id):b.id;const row=await store.findOne('report_snapshots',{id,study_id:study.id});if(!row)throw new Error('Report not found.');await ops.audit(actor,action,study.id,{report_id:id});await store.update('report_snapshots',{id},{status:'approved',approved_by:actor,approved_at:store.nowSql()});
    }else if(action==='record-review'){
      const row=await store.findOne('diary_records',{id:Number(b.record_id),study_id:study.id});if(!row||!['accepted','excluded','pending'].includes(b.status))throw new Error('Choose a valid record and review decision.');if(!String(b.reason||'').trim())throw new Error('Record the reason for the decision.');await ops.audit(actor,action,study.id,{record_id:row.id,status:b.status,reason:b.reason});await store.update('diary_records',{id:row.id},{review_status:b.status,review_reason:b.reason,reviewed_by:actor,reviewed_at:store.nowSql()});
    }else if(action==='backcheck'){
      const r=await store.findOne('respondents',{id:Number(b.respondent_id),study_id:study.id});if(!r||!['pending','passed','failed'].includes(b.result))throw new Error('Choose a respondent and backcheck result.');await ops.audit(actor,action,study.id,{respondent_id:r.id});await store.insert('backchecks',{study_id:study.id,respondent_id:r.id,result:b.result,notes:String(b.notes||''),reviewer:actor,created_at:store.nowSql()});
    }else if(action==='withdraw'){
      const r=await store.findOne('respondents',{id:Number(b.respondent_id),study_id:study.id});if(!r)throw new Error('Respondent not found.');await require('../lib/researchPrivacy').withdraw(r,actor);
    }else if(action==='erase'){
      const r=await store.findOne('respondents',{id:Number(b.respondent_id),study_id:study.id});if(!r||b.confirm!==r.respondent_code)throw new Error('Enter the respondent code to confirm the retention deletion.');await require('../lib/researchPrivacy').eraseStudyParticipation(study,r,actor);
    }else if(action==='theme'){
      if(!String(b.name||'').trim())throw new Error('Enter a theme name.');await store.insert('theme_codes',{study_id:study.id,name:String(b.name).trim()});
    }else if(action==='code-theme'){
      const record=await store.findOne('diary_records',{id:Number(b.record_id),study_id:study.id});const theme=await store.findOne('theme_codes',{id:Number(b.theme_id),study_id:study.id});if(!record||!theme)throw new Error('Choose a study record and theme.');await ops.audit(actor,action,study.id,{record_id:record.id,theme_id:theme.id});await ops.insertOnce('coded_verbatims',`${record.id}:${theme.id}`,{study_id:study.id,record_id:record.id,theme_id:theme.id,review_status:'approved',reviewed_by:actor});
    }else throw new Error('Unknown research action.');
    return res.redirect(`/admin/studies/${study.id}/research?saved=1`);
  }catch(e){return res.redirect(`/admin/studies/${study.id}/research?error=${encodeURIComponent(e.message)}`);}
});
module.exports=router;
