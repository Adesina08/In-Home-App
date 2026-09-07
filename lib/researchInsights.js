const store = require('./store');
const { loadStudyReport } = require('./studyReport');
const { percent } = require('./researchMetrics');
const SEGMENTS = ['gender','location','education_level','occupation','age_band'];
function profileValue(p, field) { if(field==='age_band') return Number(p.age)>0 ? (p.age<25?'Under 25':p.age<35?'25–34':p.age<45?'35–44':p.age<55?'45–54':'55+') : 'Not recorded'; return String(p[field]||'Not recorded'); }
async function insights(studyId, { from='',to='',segment='gender',question='',compare=false }={}) {
  if(!SEGMENTS.includes(segment))throw new Error('Choose a supported segment.');
  const report=await loadStudyReport(studyId,{from,to});
  const profiles=await store.find('respondent_profile_snapshots',{study_id:studyId},{sort:{id:-1}});
  const profileMap=new Map();for(const p of profiles)if(!profileMap.has(p.respondent_id)){ let profile={}; try { profile=JSON.parse(p.snapshot_json||'{}'); } catch {} profileMap.set(p.respondent_id,profile); }
  const code=question||report.study.brand_question_code||'brand';
  const family=report.questions.filter(q=>q.code===code||q.source_code===code);
  const q=family.find(q=>q.code===code)||family[0];
  const questionIds=new Set(family.map(q=>q.id));
  const groups=new Map();
  for(const r of report.respondents){const key=profileValue(profileMap.get(r.id)||r,segment);if(!groups.has(key))groups.set(key,new Set());groups.get(key).add(r.id);}
  const min=Math.max(2,Number(report.study.minimum_base_size)||5);
  const crossTabs=[];
  for(const [group,people] of groups){
    const eligible=report.eligibleRecords.filter(r=>people.has(r.respondent_id));const ids=new Set(eligible.map(r=>r.id));
    const rows=q?report.answers.filter(a=>questionIds.has(a.question_id)&&ids.has(a.record_id)):[];
    const counts=new Map();rows.forEach(a=>String(a.value).split('|').filter(Boolean).forEach(value=>{if(!counts.has(value))counts.set(value,new Set());counts.get(value).add(a.record_id);}));
    const answered=new Set(rows.map(a=>a.record_id)).size;
    crossTabs.push({group,base:people.size,suppressed:people.size<min,answered,values:[...counts].map(([label,recs])=>({label,n:recs.size,pct:percent(recs.size,answered),consumers:new Set(eligible.filter(r=>recs.has(r.id)).map(r=>r.respondent_id)).size}))});
  }
  let comparison=null;
  if(compare&&from&&to){const days=(Date.parse(to)-Date.parse(from))/86400000+1;const before=new Date(Date.parse(from)-86400000).toISOString().slice(0,10);const start=new Date(Date.parse(from)-days*86400000).toISOString().slice(0,10);const prior=await loadStudyReport(studyId,{from:start,to:before});comparison={from:start,to:before,base:prior.analytics.base,brands:report.analytics.brands.map(b=>{const old=prior.analytics.brands.find(p=>p.brand===b.brand);return{consumers:b.consumers,previousConsumers:old?.consumers||0,brand:b.brand,current:b.consumer_incidence_pct,previous:old?.consumer_incidence_pct??null,change:old&&old.consumer_incidence_pct!==null&&b.consumer_incidence_pct!==null?Math.round((b.consumer_incidence_pct-old.consumer_incidence_pct)*100)/100:null};})};}
  const codes=await store.find('theme_codes',{study_id:studyId});
  const coded=await store.find('coded_verbatims',{study_id:studyId,review_status:'approved'});
  const eligibleIds=new Set(report.eligibleRecords.map(r=>r.id));
  const themes=codes.map(code=>({name:code.name,n:new Set(coded.filter(c=>c.theme_id===code.id&&eligibleIds.has(c.record_id)).map(c=>c.record_id)).size,consumers:new Set(coded.filter(c=>c.theme_id===code.id&&eligibleIds.has(c.record_id)).map(c=>report.eligibleRecords.find(r=>r.id===c.record_id)?.respondent_id)).size})).filter(t=>t.n>0);
  return{report,crossTabs,comparison,themes,segment,question:q?.code||'',questionLabel:q?.text||'No matching question'};
}
// A bounded query interpreter chooses approved analyses; it never invents SQL or numbers.
function interpretQuery(text) {
  const query=String(text||'').toLowerCase();
  if(/switch/.test(query))return{view:'switching',label:'Observed brand transitions'};
  if(/repeat/.test(query))return{view:'brands',label:'Brand repeat rates'};
  if(/theme|reason|sentiment/.test(query))return{view:'themes',label:'Human-approved theme codes'};
  const segment=SEGMENTS.find(s=>query.includes(s.replace('_',' '))) || (/age/.test(query)?'age_band':'gender');
  if(/brand|segment|compar|gender|age|location|occupation/.test(query))return{view:'crosstabs',segment,compare:/compar|change|previous/.test(query),label:'Approved brand and segment analysis'};
  return{view:null,label:'Supported queries include brand comparison, gender or age segments, repeat rate, switching and coded themes.'};
}
module.exports={insights,SEGMENTS,interpretQuery};
