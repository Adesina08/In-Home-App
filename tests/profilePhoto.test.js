const {test,before,after}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');
const express=require('express');require('express-async-errors');const store=require('../lib/store');
let dir,server,url,token,otherToken;
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aHZ0AAAAASUVORK5CYII=','base64');
before(async()=>{
 dir=await fs.mkdtemp(path.join(os.tmpdir(),'inicio-photo-'));process.env.UPLOAD_DIR=dir;process.env.STORAGE_PROVIDER='local';await store.connect({uri:'',file:path.join(dir,'db.json')});
 const own=await store.insert('respondents',{name:'Photo owner',study_id:1}),other=await store.insert('respondents',{name:'Another person',study_id:1});
 token=(await require('../lib/mobileAuth').issueSession({respondentId:own.id})).token;otherToken=(await require('../lib/mobileAuth').issueSession({respondentId:other.id})).token;
 const app=express();app.use('/profile',require('../routes/mobileProfileApi'));server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));url=`http://127.0.0.1:${server.address().port}/profile`;
});
after(async()=>{await new Promise(resolve=>server.close(resolve));await store.close();await fs.rm(dir,{recursive:true,force:true});});
function upload(bytes=png,auth=token,type='image/png') {const body=new FormData();body.append('photo',new Blob([bytes],{type}),'photo.png');return fetch(url+'/photo',{method:'POST',headers:auth?{Authorization:`Bearer ${auth}`}:{},body});}
test('profile image upload persists and is readable only by its authenticated owner',async()=>{
 assert.equal((await upload(png,null)).status,401);const response=await upload();assert.equal(response.status,200);const {profile}=await response.json();assert.equal(profile.hasPhoto,true);assert.equal(profile.photo_path,undefined);
 const photo=await fetch(url+'/photo',{headers:{Authorization:`Bearer ${token}`}});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/png');assert.deepEqual(Buffer.from(await photo.arrayBuffer()),png);
 assert.equal((await fetch(url+'/photo')).status,401);assert.equal((await fetch(url+`/photo?profileId=${profile.id}`,{headers:{Authorization:`Bearer ${otherToken}`}})).status,404);
});
test('invalid image bytes and oversized uploads are rejected without replacing the current photo',async()=>{
 const original=await store.findOne('respondent_profiles',{photo_path:{$exists:true}});
 assert.equal((await upload(Buffer.from('<script>bad</script>'))).status,400);assert.equal((await upload(Buffer.alloc(3*1024*1024+1))).status,400);
 assert.equal((await store.findOne('respondent_profiles',{id:original.id})).photo_path,original.photo_path);
});
test('replacing a profile image removes the previous stored image',async()=>{
 const original=await store.findOne('respondent_profiles',{photo_path:{$exists:true}});assert.equal((await upload()).status,200);const current=await store.findOne('respondent_profiles',{id:original.id});assert.notEqual(current.photo_path,original.photo_path);
 await assert.rejects(fs.access(path.join(dir,path.basename(original.photo_path))),{code:'ENOENT'});await fs.access(path.join(dir,path.basename(current.photo_path)));
});
