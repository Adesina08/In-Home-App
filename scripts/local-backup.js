// Local development backup/restore drill; deliberately cannot restore over a live file.
const fs=require('fs/promises');const crypto=require('crypto');const path=require('path');
async function backup(source,destination){
 const bytes=await fs.readFile(source),data=JSON.parse(bytes);if(!data.collections||!data.counters)throw new Error('Not an Inicio local database.');
 await fs.writeFile(destination,bytes,{flag:'wx',mode:0o600});
 const manifest={sha256:crypto.createHash('sha256').update(bytes).digest('hex'),created_at:new Date().toISOString(),collections:Object.fromEntries(Object.entries(data.collections).map(([key,rows])=>[key,rows.length]))};
 await fs.writeFile(destination+'.manifest.json',JSON.stringify(manifest,null,2),{flag:'wx',mode:0o600});return manifest;
}
async function restore(source,destination){
 const bytes=await fs.readFile(source),manifest=JSON.parse(await fs.readFile(source+'.manifest.json','utf8'));
 if(crypto.createHash('sha256').update(bytes).digest('hex')!==manifest.sha256)throw new Error('Backup checksum does not match.');
 const data=JSON.parse(bytes);for(const [key,n]of Object.entries(manifest.collections))if(data.collections[key]?.length!==n)throw new Error('Collection counts do not match.');
 await fs.writeFile(destination,bytes,{flag:'wx',mode:0o600});return manifest;
}
if(require.main===module){const [mode,source,destination]=process.argv.slice(2);if(!['backup','restore'].includes(mode)||!source||!destination){console.error('Usage: node scripts/local-backup.js backup|restore SOURCE NEW_DESTINATION');process.exitCode=1;}else(mode==='backup'?backup:restore)(path.resolve(source),path.resolve(destination)).then(m=>console.log(JSON.stringify(m,null,2))).catch(e=>{console.error(e.message);process.exitCode=1;});}
module.exports={backup,restore};
