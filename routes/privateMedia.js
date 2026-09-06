const express=require('express');
const store=require('../lib/store');
const {clientGrant}=require('../lib/researchAccess');
const router=express.Router();
async function permitted(req,media){
  const record=await store.findOne('diary_records',{id:media.record_id});if(!record)return false;
  const r=await store.findOne('respondents',{id:record.respondent_id});if(!r||r.withdrawn_at||r.erased_at||r.consent_status!=='given')return false;
  const principal=await require('../lib/mobileAuth').authenticateRequest(req);
  const user=req.session?.user||principal?.user;
  if(['admin','superadmin','research'].includes(user?.role))return true;
  if(user?.role==='client'){
    const grant=await clientGrant(user,record.study_id);if(!grant?.media||r.media_consent!==true)return false;
    const report=await require('../lib/studyReport').loadStudyReport(record.study_id);
    return new Set(report.eligibleRecords.map(r=>r.respondent_id)).size>=Math.max(2,Number(report.study.minimum_base_size)||5)&&report.media.some(m=>m.id===media.id);
  }
  return req.session?.respondentAccountId&&req.session.respondentAccountId===r.account_id || principal?.account&&principal.account.id===r.account_id || principal?.respondent?.id===r.id;
}
async function serve(req,res,next){
  try{
    const filePath=req.path.startsWith('/uploads/')?`/uploads/${req.params.file}`:String(req.query.path||'');
    const media=await store.findOne('media',{file_path:filePath});
    if(!media||!await permitted(req,media))return res.sendStatus(404);
    res.set('Cache-Control','private, no-store');res.set('X-Content-Type-Options','nosniff');
    const mime={photo:'image/jpeg',video:'video/mp4',audio:'audio/mp4'}[media.media_type];if(mime)res.type(mime);
    if(filePath.startsWith('azureblob://'))return res.redirect(require('../lib/mediaStorage').getMediaUrl(filePath));
    res.sendFile(require('path').resolve(process.env.UPLOAD_DIR||require('path').join(__dirname,'..','uploads'),require('path').basename(filePath)),err=>{if(err&&!res.headersSent)res.sendStatus(404);});
  }catch(e){next(e);}
}
router.get('/media/file',serve);router.get('/uploads/:file',serve);
module.exports=router;
module.exports.permitted=permitted;
