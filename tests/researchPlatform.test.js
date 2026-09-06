const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const path=require('node:path');const os=require('node:os');const {EventEmitter}=require('node:events');
const store=require('../lib/store');const ops=require('../lib/researchOperations');
const {analyse,participation}=require('../lib/researchMetrics');
let dir;
before(async()=>{dir=await fs.mkdtemp(path.join(os.tmpdir(),'inicio-research-'));await store.connect({uri:'',file:path.join(dir,'db.json')});});
after(async()=>{await store.close();await fs.rm(dir,{recursive:true,force:true});});
async function study(extra={}){return store.insert('studies',{name:'Research test',status:'live',start_date:'2026-09-01',diary_mode:'daily',...extra});}
async function person(id,extra={}){return store.insert('respondents',{study_id:id,consent_status:'given',activation_status:'active',created_at:'2026-09-01 00:00:00',...extra});}
test('compliance counts completed calendar periods, caps future dates and respects staggered enrolment',()=>{
 const result=participation({start_date:'2026-09-01',diary_mode:'daily'},[{id:1,created_at:'2026-09-01'},{id:2,created_at:'2026-09-02'}],[{respondent_id:1,occurrence_time:'2026-09-01'},{respondent_id:1,occurrence_time:'2026-09-01'},{respondent_id:2,occurrence_time:'2026-09-02'}],{now:'2026-09-03',to:'2026-12-31'});
 assert.equal(result.expected,5);assert.equal(result.completed,2);assert.equal(result.rate,40);
 assert.equal(participation({start_date:'2026-09-01',diary_mode:'hybrid'},[{id:1}], [{respondent_id:1,occurrence_time:'2026-09-01'}],{now:'2026-09-02'}).completed,0);
});
test('brand incidence, repeat, volume and frequency use respondent and occasion bases',()=>{
 const result=analyse({study:{start_date:'2026-09-01',diary_mode:'daily',volume_unit:'ml',volume_unit_factor:100},respondents:[{id:1,created_at:'2026-09-01'},{id:2,created_at:'2026-09-01'}],records:[1,2,3].map((id)=>({id,respondent_id:id===3?2:1,occurrence_time:`2026-09-0${id}`})),questions:[{id:1,code:'brand'},{id:2,code:'quantity'}],answers:[{record_id:1,question_id:1,value:'A'},{record_id:2,question_id:1,value:'A'},{record_id:3,question_id:1,value:'B'},{record_id:1,question_id:2,value:'1'},{record_id:2,question_id:2,value:'2'},{record_id:3,question_id:2,value:'1'}],now:'2026-09-07'});
 assert.equal(result.brands[0].consumer_incidence_pct,50);assert.equal(result.brands[0].repeat_rate_pct,100);assert.equal(result.brands[0].share_of_volume_pct,75);assert.equal(result.avg_occasions_per_week,1.5);assert.deepEqual(result.transitions,[{from:'A',to:'A',n:1,consumers:1}]);
});
test('study report excludes withdrawn and unconsented records, applies occurrence dates and approval',async()=>{
 const s=await study({require_record_approval:true});const r=await person(s.id),withdrawn=await person(s.id,{withdrawn_at:'2026-09-02'});
 for(const [who,approval]of [[r.id,'accepted'],[r.id,'pending'],[withdrawn.id,'accepted']])await store.insert('diary_records',{study_id:s.id,respondent_id:who,status:'submitted',review_status:approval,entry_time:'2026-09-06',occurrence_time:'2026-09-02'});
 const report=await require('../lib/studyReport').loadStudyReport(s.id,{from:'2026-09-02',to:'2026-09-02'});assert.equal(report.submitted,2);assert.equal(report.eligible,1);assert.equal(report.analytics.base.respondents,1);
});
test('client suppression strips raw data and independently enforces media and export grants',async()=>{
 const s=await study(),r=await person(s.id);await store.insert('diary_records',{study_id:s.id,respondent_id:r.id,status:'submitted'});
 const report=await require('../lib/studyReport').loadStudyReport(s.id);const safe=require('../lib/researchAccess').clientSafeReport(report,{media:true,text:true});assert.equal(safe.suppressed,true);assert.equal(safe.analytics.base.respondents,null);assert.equal(safe.records,undefined);assert.equal(safe.answers,undefined);assert.equal(safe.entries.length,0);
 assert.equal(await require('../lib/researchAccess').clientGrant({id:1,role:'client'},s.id),null);
 await store.insert('client_grants',{study_id:s.id,user_id:1,enabled:true,media:false,exports:false});assert.equal((await require('../lib/researchAccess').clientGrant({id:1,role:'client'},s.id)).exports,false);
});
test('assignment and handover require the configured screener, training and a real practice entry',async()=>{
 const s=await study({screener_questions:[{code:'use',text:'Use category?',options:['Yes','No'],allowed:['Yes']}]});const config=await store.findOne('studies',{id:s.id});assert.equal(ops.screen(config,{use:'No'}).ok,false);assert.equal(ops.screen(config,{use:'Yes'}).ok,true);
 const user={id:88,role:'interviewer'};assert.equal(await ops.assigned(user,s.id),false);await store.insert('interviewer_assignments',{study_id:s.id,user_id:user.id,enabled:true});assert.equal(await ops.assigned(user,s.id),true);
 const r=await person(s.id,{activation_status:'training'});await assert.rejects(ops.handover(await store.findOne('respondents',{id:r.id}),'test'),/training/);
 await store.update('respondents',{id:r.id},{training_completed_at:store.nowSql()});await assert.rejects(ops.handover(await store.findOne('respondents',{id:r.id}),'test'),/practice/);
 await store.insert('diary_records',{study_id:s.id,respondent_id:r.id,is_practice:1,status:'submitted'});await ops.handover(await store.findOne('respondents',{id:r.id}),'test');assert.equal((await store.findOne('respondents',{id:r.id})).activation_status,'activated');
});
test('incentive eligibility is idempotent, period-based and held after QC excludes the evidence',async()=>{
 const s=await study(),r=await person(s.id);const record=await store.insert('diary_records',{study_id:s.id,respondent_id:r.id,status:'submitted',occurrence_time:'2026-09-01'});
 await store.insert('incentive_rules',{study_id:s.id,enabled:true,milestone:'participation',required_periods:1,amount:50,currency:'NGN'});
 await ops.incentives(s.id);await ops.incentives(s.id);let rows=await store.find('incentive_ledger',{study_id:s.id});assert.equal(rows.length,1);assert.equal(rows[0].status,'eligible');
 await store.insert('qc_flags',{record_id:record.id,status:'open'});await ops.incentives(s.id);rows=await store.find('incentive_ledger',{study_id:s.id});assert.equal(rows[0].status,'held');
});
test('concurrent scheduled jobs create one snapshot and retain approval separation',async()=>{
 const s=await study();await store.insert('report_schedules',{study_id:s.id,enabled:true,next_run:'2026-09-06',interval_days:7,lookback_days:7,compliance_below:50});
 await Promise.all([ops.runResearchJobs(new Date('2026-09-06')),ops.runResearchJobs(new Date('2026-09-06'))]);const rows=await store.find('report_snapshots',{study_id:s.id});assert.equal(rows.length,1);assert.equal(rows[0].status,'draft');assert.deepEqual(rows[0].payload.analytics.compliance.missing,[]);
});
test('idempotent submission resumes a partial record and replays receipt without duplicating data',async()=>{
 const s=await study(),r=await person(s.id),submission=require('../lib/diarySubmission');
 const req={body:{submission_id:'packet_test_12345',answers_json:'{}'},files:[]};const response=()=>{const res=new EventEmitter();res.status=()=>res;res.json=value=>{res.payload=value;res.emit('finish');return res;};return res;};
 const res=response(),id=await submission.begin(req,res,r,{study_id:s.id,respondent_id:r.id});await store.insert('responses',{record_id:id,question_id:1,value:'Partial'});await submission.release(req);res.emit('finish');
 const req2={body:{...req.body},files:[]},res2=response();assert.equal(await submission.begin(req2,res2,r,{study_id:s.id,respondent_id:r.id}),id);assert.equal(await store.count('responses',{record_id:id}),0);await submission.finish(req2,id,'submitted');res2.emit('finish');
 const res3=response();assert.equal(await submission.begin({body:{...req.body},files:[]},res3,r,{}),null);assert.equal(res3.payload.recordId,id);assert.equal(await store.count('diary_records',{study_id:s.id}),1);
 await assert.rejects(submission.begin({body:{...req.body,answers_json:'{"x":1}'},files:[]},response(),r,{}),/different answers/);
});
test('capture, submit and sync timestamps remain distinct and late sync preserves valid back-entry',()=>{
 const {timestamps}=require('../lib/diarySubmission');const times=timestamps({occurrence_time:'2026-09-01T09:00:00Z',capture_time:'2026-09-01T10:00:00Z',submit_time:'2026-09-01T11:00:00Z'},{back_entry_hours:4},new Date('2026-09-06T12:00:00Z'));assert.equal(times.capture_time,'2026-09-01 10:00:00');assert.equal(times.sync_time,'2026-09-06 12:00:00');assert.throws(()=>timestamps({occurrence_time:'invalid'},{},new Date()),/valid/);
});
test('scale, rank, calendar, time and scheduled question validation reject invalid values',()=>{
 const {validateSubmission}=require('../lib/answerValidation');const questions=[{id:1,type:'scale',min_value:1,max_value:5,required:1},{id:2,type:'rank',options:['A','B'],required:1},{id:3,type:'date',required:1},{id:4,type:'time',required:1},{id:5,type:'text',required:1,every_nth_occasion:2}];
 assert.equal(validateSubmission({questions,rules:[],body:{q_1:'3',q_2:'B|A',q_3:'2024-02-29',q_4:'23:50',occasion_number:1}}).length,0);
 assert.equal(validateSubmission({questions,rules:[],body:{q_1:'7',q_2:'A|A',q_3:'2026-02-30',q_4:'26:00',occasion_number:2}}).length,5);
 const {rotate}=require('../lib/advancedQuestionnaire');assert.deepEqual(rotate(['A','B','C'],'seed'),rotate(['A','B','C'],'seed'));
});
test('withdrawal removes access and puts published narratives back into review',async()=>{
 const s=await study(),r=await person(s.id);await store.insert('ai_summaries',{study_id:s.id,review_status:'approved'});await require('../lib/researchPrivacy').withdraw(await store.findOne('respondents',{id:r.id}),'test');const row=await store.findOne('respondents',{id:r.id});assert.equal(row.consent_status,'withdrawn');assert.equal((await store.findOne('ai_summaries',{study_id:s.id})).review_status,'withdrawal_review');
});
test('backup restore verifies checksums and refuses overwrite',async()=>{
 const {backup,restore}=require('../scripts/local-backup');const source=path.join(dir,'db.json'),copy=path.join(dir,'backup.json'),target=path.join(dir,'restored.json');const manifest=await backup(source,copy);assert.ok(manifest.collections.studies>0);await restore(copy,target);assert.deepEqual(await fs.readFile(source),await fs.readFile(target));await assert.rejects(restore(copy,target),{code:'EEXIST'});await fs.appendFile(copy,' ');await assert.rejects(restore(copy,path.join(dir,'bad.json')),/checksum/);
});

test('segment tables include repeated question instances without counting an occasion twice',async()=>{
 const s=await study(),r=await person(s.id,{gender:'Female'});
 const base=await store.insert('questions',{study_id:s.id,code:'brand',text:'Brand',type:'single',active:0});
 const first=await store.insert('questions',{study_id:s.id,code:'brand__product_1',source_code:'brand',type:'single',active:1});
 const second=await store.insert('questions',{study_id:s.id,code:'brand__product_2',source_code:'brand',type:'single',active:1});
 const record=await store.insert('diary_records',{study_id:s.id,respondent_id:r.id,status:'submitted',occurrence_time:'2026-09-01'});
 for(const q of [first,second])await store.insert('responses',{record_id:record.id,question_id:q.id,value:'A'});
 const result=await require('../lib/researchInsights').insights(s.id);
 assert.equal(result.question,'brand');assert.equal(result.crossTabs[0].answered,1);
 assert.deepEqual(result.crossTabs[0].values,[{label:'A',n:1,pct:100,consumers:1}]);
});
