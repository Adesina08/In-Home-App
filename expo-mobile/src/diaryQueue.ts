import AsyncStorage from '@react-native-async-storage/async-storage';
import * as FileSystem from 'expo-file-system/legacy';
import { File } from 'expo-file-system';
import { api } from './api';
export type QueuedMedia={uri:string;fileName?:string|null;mimeType?:string|null;field:string};
export type DiaryPacket={id:string;respondentId:number;kind:'standard'|'video';fields:Record<string,string>;media:QueuedMedia[];state:'pending'|'needs_attention';attempts:number;error?:string;createdAt:string};
const key=(id:number)=>`inicio.queue.v1.${id}`;
let serial:Promise<any>=Promise.resolve();
function locked<T>(fn:()=>Promise<T>):Promise<T>{const next=serial.then(fn,fn);serial=next.catch(()=>{});return next;}
export const packetId=()=>`entry_${Date.now()}_${Math.random().toString(36).slice(2)}_${Math.random().toString(36).slice(2)}`;
export async function listQueue(id:number):Promise<DiaryPacket[]>{const raw=await AsyncStorage.getItem(key(id));return raw?JSON.parse(raw):[];}
export async function preserveMedia(asset:QueuedMedia, folder:string):Promise<QueuedMedia>{
  if(!FileSystem.documentDirectory)throw new Error('Durable offline media storage requires the installed mobile app.');
  const dir=`${FileSystem.documentDirectory}diary/${folder}/`;await FileSystem.makeDirectoryAsync(dir,{intermediates:true});
  const name=`${asset.field.replace(/[^a-zA-Z0-9_-]/g,'_')}_${Date.now()}.${(asset.fileName||'file.bin').split('.').pop()}`;
  const uri=dir+name;await FileSystem.copyAsync({from:asset.uri,to:uri});return{...asset,uri};
}
export async function enqueue(packet:DiaryPacket):Promise<void>{return locked(async()=>{
  const rows=await listQueue(packet.respondentId);if(rows.some(p=>p.id===packet.id))return;
  const saved:QueuedMedia[]=[];for(const asset of packet.media)saved.push(await preserveMedia(asset,packet.id));
  await AsyncStorage.setItem(key(packet.respondentId),JSON.stringify([...rows,{...packet,media:saved}]));
});}
export async function removeQueued(id:number,packet:string):Promise<void>{return locked(async()=>{
  const rows=await listQueue(id);await AsyncStorage.setItem(key(id),JSON.stringify(rows.filter(p=>p.id!==packet)));
  if(FileSystem.documentDirectory)await FileSystem.deleteAsync(`${FileSystem.documentDirectory}diary/${packet}`,{idempotent:true});
});}
const syncing=new Set<number>();
export async function syncQueue(id:number,manual=false):Promise<void>{
  if(syncing.has(id))return;syncing.add(id);
  try{
    // Ownership is checked by every submission endpoint; only the open enrollment is retried.
    for(const packet of await listQueue(id)){
      if(packet.state==='needs_attention'&&!manual)continue;
      try{
        const form=new FormData();Object.entries(packet.fields).forEach(([k,v])=>form.append(k,v));form.append('submission_id',packet.id);
        for(const m of packet.media){const info=await FileSystem.getInfoAsync(m.uri);if(!info.exists)throw Object.assign(new Error('Saved evidence is missing from this device. Review this entry before retrying.'),{status:422});form.append(m.field,new File(m.uri));}
        const receipt=packet.kind==='video'?await api.analyzeVideo(id,form):await api.submitDiary(id,form);
        if(!receipt?.recordId||!['submitted','screened_out','draft'].includes(receipt.status))throw new Error('The server did not confirm receipt. This entry remains saved for retry.');
        await removeQueued(id,packet.id);
      }catch(e:any){
        try{const receipt=await api.submissionReceipt(id,packet.id);if(receipt?.recordId){await removeQueued(id,packet.id);continue;}}catch{}
        await locked(async()=>{const rows=await listQueue(id);const item=rows.find(p=>p.id===packet.id);if(item){item.attempts++;item.error=e.message;item.state=e.status>=400&&e.status<500?'needs_attention':'pending';await AsyncStorage.setItem(key(id),JSON.stringify(rows));}});
        if(!e.status||e.status>=500||e.status===401)break;
      }
    }
  }finally{syncing.delete(id);}
}
