import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { projectMediaKeys, projectDeletionWindow } from '../src/project-deletion.mjs';
import { Vault } from '../src/vault.mjs';
import { cleanUnreferencedMedia } from '../src/cleanup-storage.mjs';
import { STORE_KEY } from '../src/core.mjs';
import { installAutomaticDeletedCleanup, installDeletedCleanup } from '../src/cleanup.mjs';

const at = value => new Date(value).toISOString();
const picture = (id, key = `image:${id}`) => ({id, type:'image', metadata:{storageKey:key,status:'success'}});
const project = (id, nodes = [], updatedAt = 1000) => ({id,nodes,connections:[],updatedAt:at(updatedAt)});

test('whole-project deletion requires explicit native or action evidence and the full sixty seconds', () => {
  const old = project('old',[picture('original')]);
  const data = {projects:[old],records:[{source:'node-media',projectId:'old',nodeId:'removed-earlier',key:'image:earlier',observedAt:2000},
    {source:'generated-media',projectId:'old',nodeId:'pending',key:'image:late',startedAt:2000},
    {source:'generated-media',projectId:'old',nodeId:'newer',key:'image:future',startedAt:4000}]};
  assert.equal(projectDeletionWindow(data,70000).ready.length,0);
  assert.equal(projectDeletionWindow({...data,tombstones:[{id:'old',at:at(3000)}]},70000).ready.length,0);
  const explicit={...data,nativeTombstones:[{id:'old',deletedAt:at(3000)}]};
  assert.equal(projectDeletionWindow(explicit,62999).waiting.nextAt,63000);
  assert.deepEqual(projectDeletionWindow(explicit,63000).ready[0].keys,['image:earlier','image:late','image:original']);
  assert.equal(projectDeletionWindow({...explicit,nativeTombstones:[{id:'old',deletedAt:'invalid'}]},70000).ready.length,0);
  assert.equal(projectDeletionWindow({...explicit,liveProjectIds:['old']},70000).ready.length,0);
  assert.equal(projectDeletionWindow({...explicit,liveProjects:[old]},70000).ready.length,0);
  assert.equal(projectDeletionWindow({...explicit,projects:[project('old',[picture('restore')],4000)]},70000).ready.length,0);
  assert.ok(projectDeletionWindow({nativeTombstones:[{id:'old',deletedAt:at(3001)}],tombstones:[{id:'old',at:at(3000),source:'user-delete-project',keys:['image:newly-created']}]},70000).ready[0].keys.includes('image:newly-created'));
});

test('whole-project provenance includes chat and reference media and excludes literal prompt or text keys', () => {
  const old=project('old',[picture('image'),{id:'text',type:'text',title:'image:title',metadata:{content:'image:literal',prompt:'image:prompt',references:['image:reference']}}]);
  old.chatSessions=[{messages:[{text:'image:text',attachments:[{storageKey:'image:attachment'}]}]}];
  assert.deepEqual([...projectMediaKeys(old)].sort(),['image:attachment','image:image','image:reference']);
});

test('the home page can finish deleted-project cleanup once without scheduling unrelated live-node cleanup', async t => {
  const descriptors=Object.fromEntries(['document','location','CanvasSaveGuardHistory'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  globalThis.document={addEventListener(){}};globalThis.location={pathname:'/canvas'};delete globalThis.CanvasSaveGuardHistory;
  let calls=0;
  const state={nodeIds:[],connectionIds:[],images:[],projectDeletions:[{id:'old',keys:['image:old']}],revision:'old-only',waiting:{total:0,nextAt:null}};
  const guard={status:()=>({attached:true}),recordDeletedObjects(){},deletedCleanupState:async()=>state,
    cleanupDeleted:async()=>{calls++;guard.deletedCleanupChecked('',state.revision);}};
  installAutomaticDeletedCleanup(guard);
  const advance=async ms=>{t.mock.timers.tick(ms);for(let i=0;i<16;i++)await Promise.resolve();};
  await advance(350);assert.equal(calls,1);
  for(let i=0;i<3;i++){guard.scheduleDeletedCleanup('old');await advance(250);}
  assert.equal(calls,1);
  state.projectDeletions[0].keys.push('image:late-output');state.revision='old-with-late-output';
  guard.scheduleDeletedCleanup('old');await advance(250);assert.equal(calls,2);
  assert.deepEqual(state.nodeIds,[]);
});

test('slow deletion-record reads keep editing unlocked and stop history pruning if a user edit arrives', async t => {
  const descriptors=Object.fromEntries(['document','window','location','CanvasSaveGuardHistory'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor]of Object.entries(descriptors)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  const events=[];
  globalThis.document={addEventListener:name=>events.push(name),removeEventListener(){},documentElement:{setAttribute(){},removeAttribute(){}}};
  globalThis.window={addEventListener(){}};globalThis.location={pathname:'/canvas/current'};
  let projects=[project('current',[picture('keep')])],release,pruned=false;
  const pending=new Promise(resolve=>{release=resolve;});
  globalThis.CanvasSaveGuardHistory={projectId:'current',ready:true,deletedOnlyVersion:1,
    snapshot:()=>projects[0],prune:()=>{pruned=true;}};
  const guard={};
  installDeletedCleanup({guard,getStore:()=>({getState:()=>({projects})}),getServices:()=>({}),flush:async()=>{},
    getDeletedObjects:()=>pending,getKnownMediaUrls:()=>[],fetchBlob:async()=>{},releaseSessionMedia:()=>({})});
  const prepare=guard.cleanupEndpoint.prepare('test',true);
  assert.deepEqual(events,[],'no input blocker while waiting for IndexedDB');
  projects=[project('current',[picture('keep'),picture('new')])];
  release({nodeIds:[],connectionIds:[],images:[],waiting:{total:0,nextAt:null}});
  await assert.rejects(prepare,/画布正在编辑/);
  assert.equal(pruned,false);assert.deepEqual(events,[]);
  guard.cleanupEndpoint.release('test');
});

test('native deletion receipts persist before removal and a later deletion starts a fresh minute', async () => {
  const vault=new Vault(new IDBFactory());
  await vault.protect([project('old',[picture('one')])]);
  await vault.recordDeletedProjects([project('old',[picture('one')])],10000);
  let state=await vault.deletedObjects('new');
  assert.equal(state.projectDeletions[0].id,'old');
  assert.equal(state.waiting.nextAt,null);
  await vault.recordDeletedProjects([project('old',[picture('two')])],Date.now());
  state=await vault.deletedObjects('new');
  assert.equal(state.projectDeletions.length,0);
  assert.equal(state.waiting.total,1);
  assert.equal((await vault.deletedObjects('new',[project('old')])).waiting.total,0);
  (await vault.open()).close();
});

async function fixture() {
  const indexedDB=new IDBFactory();
  const original=await new Promise(resolve=>{const request=indexedDB.open('infinite-canvas',8);request.onupgradeneeded=()=>{
    for(const name of ['app_state','image_files','image_previews','media_files','agent_chat_messages'])request.result.createObjectStore(name);
  };request.onsuccess=()=>resolve(request.result);});
  const vault=new Vault(indexedDB);
  const bytes=new Blob(['exact retained media bytes'],{type:'image/png'});
  const deletedAt=Date.now()-60001;
  const deletedProject=project('old',[picture('deleted'),picture('shared'),picture('asset'),picture('chat')],deletedAt-1000);
  const live=project('new',[picture('live'),picture('uses-shared','image:shared')]);
  const keys=['deleted','shared','asset','chat','live','unknown','earlier'];
  await vault.protect([deletedProject,live],new Map(keys.map(id=>['image:'+id,bytes])));
  await vault.put('cleanup_candidates','owner',{source:'node-media',projectId:'old',nodeId:'previously-removed',key:'image:earlier',observedAt:deletedAt-2000});
  const write=(store,key,value)=>new Promise(resolve=>{const tx=original.transaction(store,'readwrite');tx.objectStore(store).put(value,key);tx.oncomplete=resolve;});
  for(const id of keys){await write('image_files','image:'+id,bytes);await write('image_previews','image:'+id,{blob:bytes});}
  const state={state:{projects:[live],deletedProjects:[{id:'old',deletedAt:at(deletedAt)}]},version:0};
  await write('app_state',STORE_KEY,JSON.stringify(state));
  await write('app_state','infinite-canvas:asset_store',JSON.stringify({state:{assets:[{storageKey:'image:asset'}]}}));
  await write('agent_chat_messages','attachment',{attachments:[{storageKey:'image:chat'}]});
  const read=(store,key)=>new Promise(resolve=>{const request=original.transaction(store).objectStore(store).get(key);request.onsuccess=()=>resolve(request.result);});
  const scan={mode:'deleted-audited',projectId:'new',liveProjectIds:['new'],keys:['image:live','image:shared'],candidateKeys:[],preserveAllMedia:false,referenceData:{aliases:[],urls:[]}};
  const clean=()=>cleanUnreferencedMedia(indexedDB,scan,{},()=>{},{fetchBlob:async()=>{throw Error('unreadable');},validateReferences:async()=>{}});
  return {indexedDB,original,vault,bytes,state,scan,write,read,clean,deletedAt,deletedProject,live};
}

test('new empty canvas cleans previously deleted project files from original, vault and previews while retaining all shared and untracked bytes', async () => {
  const f=await fixture();
  const before=await f.read('app_state',STORE_KEY);
  const result=await f.clean();
  assert.deepEqual(result.keys.sort(),['image:deleted','image:earlier']);
  assert.equal(result.deletedProjects.total,1);
  assert.equal(result.deletedProjects.backups,1);
  for(const id of ['deleted','earlier']){
    assert.equal(await f.read('image_files','image:'+id),undefined);
    assert.equal(await f.read('image_previews','image:'+id),undefined);
    assert.equal(await f.vault.get('media','image:'+id),undefined);
  }
  for(const id of ['shared','asset','chat','live','unknown']){
    assert.equal(await(await f.read('image_files','image:'+id)).text(),await f.bytes.text());
    assert.equal(await(await f.vault.get('media','image:'+id)).text(),await f.bytes.text());
  }
  assert.equal(await f.vault.get('projects','old'),undefined);
  assert.deepEqual(await f.vault.get('projects','new'),f.live);
  assert.equal(await f.read('app_state',STORE_KEY),before);
  const receipt=await f.vault.get('deleted','old');
  assert.equal(receipt.source,'user-delete-project');
  assert.ok(receipt.keys.includes('image:shared'));
  // Later reference removal can use the durable receipt after the old backup is gone.
  f.scan.keys=['image:live'];f.state.state.projects=[project('new',[picture('live')])];
  await f.write('app_state',STORE_KEY,JSON.stringify(f.state));
  await f.vault.protect(f.state.state.projects);
  assert.ok((await f.clean()).keys.includes('image:shared'));
  f.original.close();(await f.vault.open()).close();
});

test('a whole-project deletion in its grace period blocks earlier mature candidates and keeps the backup', async () => {
  const f=await fixture();
  f.state.state.deletedProjects=[{id:'old',deletedAt:at(Date.now())}];
  await f.write('app_state',STORE_KEY,JSON.stringify(f.state));
  f.scan.candidateKeys=['image:deleted'];
  assert.deepEqual((await f.clean()).keys,[]);
  assert.ok(await f.vault.get('projects','old'));
  assert.ok(await f.read('image_files','image:deleted'));
  f.original.close();(await f.vault.open()).close();
});

test('an active old tab, a restored project and unresolved live references each prevent whole-project removal', async () => {
  const f=await fixture();
  f.scan.liveProjectIds.push('old');
  assert.deepEqual((await f.clean()).keys,[]);
  f.scan.liveProjectIds.pop();
  const restored=project('old',[picture('deleted')],Date.now());
  f.state.state.projects.push(restored);
  await f.write('app_state',STORE_KEY,JSON.stringify(f.state));
  assert.deepEqual((await f.clean()).keys,[]);
  f.state.state.projects.pop();await f.write('app_state',STORE_KEY,JSON.stringify(f.state));
  f.scan.referenceData.urls.push({url:'blob:unknown',path:'current.reference'});
  const unresolved=await f.clean();assert.equal(unresolved.preserveAllMedia,true);assert.deepEqual(unresolved.keys,[]);
  assert.ok(await f.vault.get('projects','old'));assert.ok(await f.read('image_files','image:deleted'));
  f.original.close();(await f.vault.open()).close();
});
