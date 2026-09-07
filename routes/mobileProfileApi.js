const express = require("express");
const mobileAuth = require("../lib/mobileAuth");
const profiles = require("../lib/respondentProfiles");
const store = require("../lib/store");
const { logAudit } = require("../lib/audit");

const router = express.Router();

async function principal(req, res) {
  const p = await mobileAuth.authenticateRequest(req);
  if (!p) {
    res.status(401).json({ error: "Please sign in again." });
    return null;
  }
  return p;
}

async function profileFor(p) {
  if (p.account) return profiles.ensureForAccount(p.account);
  if (p.respondent) return profiles.ensureForRespondent(p.respondent);
  return null;
}

router.get("/", async (req, res) => {
  const p = await principal(req, res);
  if (!p) return;
  const profile = await profileFor(p);
  res.json({
    profile: profiles.publicProfile(profile),
    required: !profile || !profile.completed_at,
    prefillName: (profile && profile.name) || (p.account && p.account.name) || (p.respondent && p.respondent.name) || "",
  });
});

router.put("/", async (req, res) => {
  const p = await principal(req, res);
  if (!p) return;
  const profile = await profileFor(p);
  if (!profile) return res.status(404).json({ error: "Your INICIO profile could not be found." });

  const result = await profiles.completeProfile(profile.id, req.body || {});
  if (!result.ok) return res.status(400).json({ error: "Please check your answers.", fields: result.errors });

  if (p.respondent) {
    await store.update("respondents", { id: p.respondent.id }, { profile_id: profile.id, name: result.profile.name });
  }

  logAudit(
    p.account ? `account:${p.account.id}` : `respondent:${p.respondent.id}`,
    "profile_completed",
    "respondent_profiles",
    profile.id,
    { recontact_consent: result.profile.recontact_consent }
  );

  res.json({ profile: profiles.publicProfile(result.profile), required: false });
});

const multer = require('multer');
const fs = require('node:fs/promises');
const path = require('node:path');
const mediaStorage = require('../lib/mediaStorage');
const avatarUpload = multer({dest:process.env.UPLOAD_DIR || path.join(__dirname,'../uploads'),limits:{fileSize:3*1024*1024,files:1}});
// Profile photos are private to the signed-in profile; no caller-supplied owner ID.
router.post('/photo', async(req,res,next)=>{
  req.photoPrincipal=await principal(req,res);if(req.photoPrincipal)next();
}, (req,res,next)=>avatarUpload.single('photo')(req,res,error=>error?res.status(400).json({error:error.code==='LIMIT_FILE_SIZE'?'Choose an image smaller than 3 MB.':'Upload one profile image.'}):next()), async(req,res)=>{
  if(!req.file)return res.status(400).json({error:'Choose a profile image.'});
  let stored, retained=false;
  try{
    const profile=await profileFor(req.photoPrincipal);
    if(!profile)return res.status(404).json({error:'Profile not found.'});
    const bytes=await fs.readFile(req.file.path);
    const type=bytes[0]===0xff&&bytes[1]===0xd8&&bytes[2]===0xff?'image/jpeg':bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))?'image/png':bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'?'image/webp':null;
    if(!type)return res.status(400).json({error:'Choose a JPEG, PNG or WebP image.'});
    req.file.mimetype=type;stored=await mediaStorage.persistUpload(req.file);
    await store.update('respondent_profiles',{id:profile.id},{photo_path:stored,photo_type:type,photo_updated_at:new Date().toISOString()});
    retained=true;
    if(profile.photo_path)await mediaStorage.deleteMedia(profile.photo_path).catch(()=>{});
    res.json({profile:profiles.publicProfile(await store.findOne('respondent_profiles',{id:profile.id}))});
  }catch(error){if(stored&&!retained)await mediaStorage.deleteMedia(stored).catch(()=>{});throw error;}
  finally{if(!retained||mediaStorage.PROVIDER==='azure_blob')await fs.rm(req.file.path,{force:true}).catch(()=>{});}
});
router.get('/photo',async(req,res)=>{
  const p=await principal(req,res);if(!p)return;
  const profile=await profileFor(p);if(!profile?.photo_path)return res.status(404).json({error:'No profile image.'});
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'}).type(profile.photo_type||'image/jpeg');
  res.send(await mediaStorage.readMediaBuffer(profile.photo_path));
});

module.exports = router;
