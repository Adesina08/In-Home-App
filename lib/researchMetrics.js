// Shared definitions for dashboards, exports, reports and incentive eligibility.
const DAY = 86400000;
const percent = (n, d) => d ? Math.round(n / d * 10000) / 100 : null;
function dateOf(value) { return String(value || '').slice(0, 10); }
function utcDate(value) { return new Date(`${dateOf(value)}T00:00:00Z`); }
function periodKey(value, cadence) {
  const d = utcDate(value);
  if (!Number.isFinite(d.getTime())) return null;
  if (cadence === 'monthly') return d.toISOString().slice(0, 7);
  if (cadence === 'weekly') d.setUTCDate(d.getUTCDate() - (d.getUTCDay() + 6) % 7);
  return d.toISOString().slice(0, 10);
}
function participation(study, respondents, records, { from, to, now = new Date().toISOString() } = {}) {
  const cadence = study.diary_mode;
  const requirement = Math.max(1, Number(study.required_entries_per_period) || 1);
  if (!study.start_date || !['daily','weekly','monthly','hybrid'].includes(cadence)) return { expected: null, completed: null, rate: null, missing: [], note: 'Configure a study start date and daily, weekly, monthly or hybrid participation requirements.' };
  const effectiveCadence = cadence === 'hybrid' ? (study.hybrid_summary_cadence || 'weekly') : cadence;
  const end = [dateOf(now), dateOf(study.end_date), to].filter(Boolean).sort()[0];
  const missing = [];
  let expected = 0, completed = 0;
  for (const r of respondents) {
    const start = [dateOf(study.start_date), dateOf(r.participation_start || r.activated_at || r.created_at), from].filter(Boolean).sort().at(-1);
    if (!start || !end || start > end) continue;
    const keys = new Set();
    // Fixed calendar units; multiple occasions in one period cannot inflate compliance.
    for (let d = utcDate(start), count = 0; d <= utcDate(end) && count < 36600; d = new Date(d.getTime() + DAY), count++) keys.add(periodKey(d.toISOString(), effectiveCadence));
    const tally = new Map();
    records.filter(rec => rec.respondent_id === r.id && (cadence !== 'hybrid' || rec.participation_kind === 'period_summary')).forEach(rec => {
      const day = dateOf(rec.occurrence_time || rec.entry_time);
      if (day < start || day > end) return;
      const key = periodKey(day, effectiveCadence);
      tally.set(key, (tally.get(key) || 0) + 1);
    });
    for (const key of keys) {
      expected++;
      if ((tally.get(key) || 0) >= requirement) completed++;
      else missing.push({ respondent_id: r.id, period: key, recorded: tally.get(key) || 0, required: requirement });
    }
  }
  return { expected, completed, rate: percent(completed, expected), missing, cadence: effectiveCadence, requirement, note: 'UTC calendar participation units through the selected end date, capped at today; current open periods are included.' };
}
function analyse({ study, respondents, records, answers, questions, from, to, now }) {
  const byRecord = new Map();
  answers.forEach(a => { if (!byRecord.has(a.record_id)) byRecord.set(a.record_id, {}); byRecord.get(a.record_id)[a.question_id] = a.value; });
  const question = code => questions.find(q => q.code === code);
  const brandCode=study.brand_question_code||'brand',quantityCode=study.quantity_question_code||'quantity';
  const brandQuestions=questions.filter(q=>q.code===brandCode||q.source_code===brandCode);
  const quantityQuestions=questions.filter(q=>q.code===quantityCode||q.source_code===quantityCode);
  const factor=Number(study.volume_unit_factor);
  const comparableVolume=factor>0&&!!study.volume_unit&&quantityQuestions.length>0;
  const brands=new Map();let totalVolume=0;const sequence=new Map();const brandAnswered=new Set();
  for(const r of [...records].sort((a,b)=>String(a.occurrence_time||a.entry_time).localeCompare(String(b.occurrence_time||b.entry_time))||a.id-b.id)){
    const a=byRecord.get(r.id)||{},occasionBrands=new Set();
    for(const q of brandQuestions){
      const values=[...new Set(String(a[q.id]??'').split('|').filter(Boolean))];
      if(values.length)brandAnswered.add(r.id);
      const quantityQ=quantityQuestions.find(other=>q.loop_item?other.loop_item===q.loop_item:!other.loop_item);
      const raw=quantityQ?a[quantityQ.id]:null;
      const qty=raw==null||raw===''?null:Number(raw);
      const volume=comparableVolume&&values.length===1&&qty!==null&&Number.isFinite(qty)&&qty>=0?qty*factor:null;
      if(volume!==null)totalVolume+=volume;
      for(const brand of values){
        if(!brands.has(brand))brands.set(brand,{brand,records:new Set(),people:new Map(),volume:0,volume_records:new Set()});
        const b=brands.get(brand);b.records.add(r.id);if(!b.people.has(r.respondent_id))b.people.set(r.respondent_id,new Set());b.people.get(r.respondent_id).add(r.id);
        if(volume!==null){b.volume+=volume;b.volume_records.add(r.id);}occasionBrands.add(brand);
      }
    }
    if(occasionBrands.size===1){if(!sequence.has(r.respondent_id))sequence.set(r.respondent_id,[]);sequence.get(r.respondent_id).push([...occasionBrands][0]);}
  }
  const transitions = new Map();
  for (const [respondentId,list] of sequence) for(let i=1;i<list.length;i++) { const key = JSON.stringify([list[i-1],list[i]]); if(!transitions.has(key))transitions.set(key,{n:0,people:new Set()});const cell=transitions.get(key);cell.n++;cell.people.add(respondentId); }
  const stats=[...brands.values()].map(b=>({brand:b.brand,occasions:b.records.size,consumers:b.people.size,consumer_incidence_pct:percent(b.people.size,respondents.length),share_of_occasions_pct:percent(b.records.size,records.length),repeat_rate_pct:percent([...b.people.values()].filter(set=>set.size>=2).length,b.people.size),volume:comparableVolume&&b.volume_records.size?b.volume:null,volume_base:b.volume_records.size,share_of_volume_pct:comparableVolume&&b.volume_records.size?percent(b.volume,totalVolume):null})).sort((a,b)=>b.occasions-a.occasions||a.brand.localeCompare(b.brand));
  const first = from || study.start_date || records.map(r=>dateOf(r.occurrence_time||r.entry_time)).sort()[0];
  const last = [to,study.end_date,dateOf(now || new Date().toISOString())].filter(Boolean).sort()[0];
  const personDays = first && last ? respondents.reduce((sum,r)=>{ const start=[dateOf(first),dateOf(r.participation_start||r.activated_at||r.created_at)].filter(Boolean).sort().at(-1); return sum+Math.max(0,(utcDate(last)-utcDate(start))/DAY+1); },0) : null;
  const peopleBrands = new Map();
  for (const b of brands.values()) for(const person of b.people.keys()) { if(!peopleBrands.has(person))peopleBrands.set(person,new Set());peopleBrands.get(person).add(b.brand); }
  return {
    compliance: participation(study,respondents,records,{from,to,now}), brands: stats,
    base: { respondents: respondents.length, valid_occasions: records.length, brand_answered_occasions: brandAnswered.size },
    category_incidence_pct: percent(new Set(records.map(r=>r.respondent_id)).size,respondents.length),
    avg_occasions_per_week: personDays ? Math.round(records.length/(personDays/7)*100)/100 : null,
    repertoire: peopleBrands.size ? [...peopleBrands.values()].reduce((sum,set)=>sum+set.size,0)/peopleBrands.size : null,
    transitions: [...transitions].map(([key,cell])=>({from:JSON.parse(key)[0],to:JSON.parse(key)[1],n:cell.n,consumers:cell.people.size})),
    volume_unit: comparableVolume ? study.volume_unit : null,
  };
}
module.exports = { analyse, participation, periodKey, percent, dateOf };
