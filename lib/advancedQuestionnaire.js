const crypto=require('crypto');
function scheduled(q,{occurrenceTime=new Date().toISOString(),occasionNumber=1}={}){
  if(q.every_nth_occasion&&occasionNumber%q.every_nth_occasion!==0)return false;
  const date=new Date(occurrenceTime);if(!Number.isFinite(date.getTime()))return false;
  const hour=date.getUTCHours();
  if(q.from_hour_utc!=null&&q.to_hour_utc!=null){const from=Number(q.from_hour_utc),to=Number(q.to_hour_utc);if(from<to?hour<from||hour>=to:hour<from&&hour>=to)return false;}
  return true;
}
function rotate(options,seed){return [...options].map(value=>({value,key:crypto.createHash('sha256').update(`${seed}:${value}`).digest('hex')})).sort((a,b)=>a.key.localeCompare(b.key)).map(x=>x.value);}
function contextualize(questions,context={}){return questions.map(q=>({...q,options:q.rotate_options&&context.respondentId?rotate(q.options,`${context.respondentId}:${q.id}`):q.options}));}
module.exports={scheduled,rotate,contextualize};
