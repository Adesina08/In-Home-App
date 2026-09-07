const crypto=require('crypto');
const fs=require('fs');
const store=require('./store');
const {insertOnce}=require('./researchOperations');
function failure(message,status=400){return Object.assign(new Error(message),{status});}
function timestamps(body,study,now=new Date()){
  const parse=(value,label)=>{const d=new Date(value);if(!value||!Number.isFinite(d.getTime()))throw failure(`Enter a valid ${label}.`);if(d>new Date(now.getTime()+300000))throw failure(`${label} cannot be in the future.`);return d;};
  const captured=parse(body.capture_time||now.toISOString(),'capture time');
  const submitted=parse(body.submit_time||now.toISOString(),'submission time');
  const occurrence=parse(body.occurrence_time||captured.toISOString(),'occasion time');
  if(captured>submitted||occurrence>submitted)throw failure('Capture and occasion time must precede submission.');
  // Back-entry eligibility is evaluated at capture, so a later offline sync does not erase a valid occasion.
  if((captured-occurrence)/3600000>Number(study.back_entry_hours??24))throw failure('This occasion is outside the study back-entry window.');
  const day=occurrence.toISOString().slice(0,10);
  if(study.start_date&&day<study.start_date||study.end_date&&day>study.end_date)throw failure('The occasion must fall within the study dates.');
  return{occurrence_time:store.toSqlTime(occurrence),capture_time:store.toSqlTime(captured),submit_time:store.toSqlTime(submitted),sync_time:store.toSqlTime(now)};
}
async function digest(req){
  const hash=crypto.createHash('sha256');
  Object.keys(req.body).sort().forEach(k=>hash.update(JSON.stringify([k,req.body[k]])));
  for(const file of [...(req.files||[]),...(req.file?[req.file]:[])].sort((a,b)=>a.fieldname.localeCompare(b.fieldname))){hash.update(file.fieldname);hash.update(file.mimetype);for await(const chunk of fs.createReadStream(file.path))hash.update(chunk);}
  return hash.digest('hex');
}
async function begin(req,res,respondent,doc){
  const key=String(req.body.submission_id||crypto.randomUUID());
  if(!/^[a-zA-Z0-9_-]{12,100}$/.test(key))throw failure('Invalid submission identifier.');
  const id=`${respondent.id}:${key}`, fingerprint=await digest(req), owner=crypto.randomUUID();
  await insertOnce('diary_submissions',id,{respondent_id:respondent.id,fingerprint,state:'ready',record_id:null,created_at:store.nowSql()});
  const row=await store.findOne('diary_submissions',{id});
  if(row.fingerprint!==fingerprint)throw failure('This submission identifier already belongs to different answers.',409);
  if(row.state==='done'){res.status(200).json({recordId:row.record_id,status:row.result_status,replayed:true});return null;}
  const won=await store.update('diary_submissions',{id,$or:[{state:'ready'},{state:'processing',lease_until:{$lt:store.nowSql()}}]},{state:'processing',owner,lease_until:store.nowSql(600000)});
  if(!won.changes)throw failure('This entry is already syncing. Retry shortly.',503);
  req.submission={id,owner};
  const heartbeat=setInterval(()=>store.update('diary_submissions',{id,owner,state:'processing'},{lease_until:store.nowSql(600000)}).catch(()=>{}),30000);heartbeat.unref();
  res.on('finish',()=>clearInterval(heartbeat));res.on('close',()=>clearInterval(heartbeat));
  let recordId=row.record_id;
  if(recordId){
    const record=await store.findOne('diary_records',{id:recordId});
    if(record&&record.status!=='ingesting'){await finish(req,recordId,record.status);res.json({recordId,status:record.status,replayed:true});return null;}
    for(const media of await store.find('media',{record_id:recordId}))await require('./mediaStorage').deleteMedia(media.file_path);
    await store.remove('responses',{record_id:recordId});await store.remove('media',{record_id:recordId});await store.remove('qc_flags',{record_id:recordId});
    await store.update('diary_records',{id:recordId},{...doc,status:'ingesting'});
  }else{
    recordId=(await store.insert('diary_records',{...doc,status:'ingesting',submission_id:key})).id;
    await store.update('diary_submissions',{id,owner},{record_id:recordId});
  }
  return recordId;
}
async function finish(req,recordId,status){
  await store.update('diary_records',{id:recordId},{status});
  if(req.submission)await store.update('diary_submissions',{id:req.submission.id,owner:req.submission.owner},{state:'done',result_status:status,completed_at:store.nowSql()});
}
async function release(req,error){if(req.submission)await store.update('diary_submissions',{id:req.submission.id,owner:req.submission.owner,state:'processing'},{state:'ready',last_error:error?.status?error.message:'Upload interrupted; safe to retry.',last_attempt_at:store.nowSql()});}
function cleanupUploads(req,res,next){res.on('finish',()=>{(async()=>{for(const f of [...(req.files||[]),...(req.file?[req.file]:[])]){if(!await store.findOne('media',{file_path:`/uploads/${f.filename}`}))await fs.promises.rm(f.path,{force:true});}})().catch(e=>console.error('Temporary diary upload cleanup failed:',e.message));});next();}
module.exports={timestamps,begin,finish,release,cleanupUploads};
