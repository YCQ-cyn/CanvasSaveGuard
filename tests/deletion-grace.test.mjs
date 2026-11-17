import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { deletionWindow, projectObjectIds } from '../src/deletion-grace.mjs';
import { recordedDeletionKeys, pruneDeletedHistory } from '../src/deleted-history.mjs';
import { Vault } from '../src/vault.mjs';
import { copyImageNode } from '../src/batch-clipboard.mjs';
import { installAutomaticDeletedCleanup } from '../src/cleanup.mjs';
import { reconcileRecordedDeletions, removedHistoryObjects } from '../src/project-recovery.mjs';
import { commitCanvasHistory, retainedCanvasHistory } from '../src/history-commit.mjs';

test('a delete becomes eligible exactly after sixty seconds and re-deletion blocks earlier receipts', () => {
  const first = { projectId:'p',source:'user-delete',nodeIds:['node'],keys:['image:owned'],deletedAt:1000,cleanupAfter:61000 };
  assert.equal(deletionWindow([first],'p',60999).ready.length,0);
  assert.deepEqual([...recordedDeletionKeys([first],'p',60999)],[]);
  assert.deepEqual([...recordedDeletionKeys([first],'p',61000)],['image:owned']);
  const later = { ...first,deletedAt:50000,cleanupAfter:110000 };
  assert.deepEqual([...recordedDeletionKeys([first,later],'p',61000)],[]);
  assert.equal(deletionWindow([first,later],'p',61000).waiting.nextAt,110000);
  assert.deepEqual([...recordedDeletionKeys([first,later],'p',110000)],['image:owned']);
});

test('undo cancels the restored item without cancelling other deleted items and a new delete starts a full minute', async () => {
  const indexedDB=new IDBFactory(),vault=new Vault(indexedDB);
  const nodes=['one','two'].map(id=>({id,type:'image',metadata:{storageKey:'image:'+id}}));
  await vault.recordDeletedObjects('p',nodes,[],[],1000);
  let records=await vault.all('cleanup_candidates');
  assert.equal(deletionWindow(records,'p',60999).waiting.total,2);
  assert.equal(await vault.cancelRestoredDeletedObjects('p',projectObjectIds({nodes:[{id:'brand-new'}],connections:[{id:'new-connection'}]}),20000),0);
  assert.equal(await vault.cancelRestoredDeletedObjects('p',projectObjectIds({nodes:[nodes[0]],connections:[]}),20000),1);
  records=await vault.all('cleanup_candidates');
  assert.deepEqual([...recordedDeletionKeys(records,'p',70000)],['image:two']);
  await vault.recordDeletedObjects('p',[nodes[0]],[],[],50000);
  records=await vault.all('cleanup_candidates');
  assert.deepEqual([...recordedDeletionKeys(records,'p',109999)],['image:two']);
  assert.deepEqual([...recordedDeletionKeys(records,'p',110000)].sort(),['image:one','image:two']);
  assert.equal(records.filter(record=>record.source==='user-delete').length,2);
  (await vault.open()).close();
});

test('copied representative or child contains one image and keeps prompts and exact media references', () => {
  const images=[{id:'a',storageKey:'image:a',content:'blob:a',status:'success'},{id:'b',storageKey:'image:b',content:'blob:b',status:'success'}];
  const root={id:'root',type:'image',position:{x:1,y:2},metadata:{images,primaryImageId:'b',storageKey:'image:b',content:'blob:b',batchChildIds:['child'],batchRootId:'old',isBatchRoot:true,batchDisplayRoot:true,imageBatchExpanded:true,prompt:'keep prompt',model:'keep model',count:2}};
  const before=JSON.stringify(root),copied=copyImageNode(root),child=copyImageNode(root,images[0],{x:3,y:4});
  assert.equal(copied.metadata.storageKey,'image:b');assert.equal(child.metadata.storageKey,'image:a');
  for(const value of [copied,child]) { assert.equal(value.metadata.images,undefined);assert.equal(value.metadata.batchRootId,undefined);assert.equal(value.metadata.batchChildIds,undefined);assert.equal(value.metadata.prompt,'keep prompt');assert.equal(value.metadata.model,'keep model');assert.equal(value.metadata.count,1); }
  assert.equal(JSON.stringify(root),before);
});

test('mature deletion prunes only its exact flattened clipboard source and leaves live state byte-identical', () => {
  const a={id:'a',storageKey:'image:a'},b={id:'b',storageKey:'image:b'};
  const root={id:'root',type:'image',position:{x:1,y:2},metadata:{images:[a,b],primaryImageId:'a'}};
  const current={nodes:[{...root,metadata:{...root.metadata,images:[b],primaryImageId:'b'}}],connections:[]};
  const clipboard={nodes:[{...copyImageNode(root,a),id:'flattened-a'},{...copyImageNode(root,b),id:'flattened-b'}],connections:[],sources:[{id:'flattened-a',nodeId:'root',imageId:'a'},{id:'flattened-b',nodeId:'root',imageId:'b'}]};
  const before=JSON.stringify(current),retained={history:{past:[{nodes:[root],connections:[]}],future:[]},clipboard};
  const pruned=pruneDeletedHistory(current,retained,{nodeIds:[],connectionIds:[],images:[{nodeId:'root',imageId:'a'}]});
  assert.equal(JSON.stringify(current),before);
  assert.deepEqual(pruned.clipboard.nodes.map(n=>n.metadata.storageKey),['image:b']);
  assert.deepEqual(pruned.clipboard.sources,[clipboard.sources[1]]);
  assert.deepEqual(pruned.history.past[0].nodes[0].metadata.images,[b]);
  assert.deepEqual(pruned.summary.candidateKeys,['image:a']);
  const restored={...current,nodes:[root]};
  assert.deepEqual(pruneDeletedHistory(restored,retained,{nodeIds:[],connectionIds:[],images:[{nodeId:'root',imageId:'a'}]}).clipboard,clipboard);
});

test('automatic cleanup checks each deletion revision once and new late media still triggers another pass', async t => {
  const originals=Object.fromEntries(['document','location','CanvasSaveGuardHistory'].map(name=>[name,Object.getOwnPropertyDescriptor(globalThis,name)]));
  t.after(()=>{for(const [name,descriptor] of Object.entries(originals)){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  t.mock.timers.enable({apis:['setTimeout','Date'],now:100000});
  globalThis.document={addEventListener(){}};
  globalThis.location={pathname:'/canvas/p'};
  globalThis.CanvasSaveGuardHistory={ready:true,idle:()=>true};
  let calls=0;
  const state={nodeIds:['removed'],connectionIds:[],images:[],mediaKeys:['image:removed'],revision:'delete-1',waiting:{total:0,nextAt:null}};
  const guard={recordDeletedObjects(){},deletedCleanupState:async()=>({...state}),cleanupDeleted:async()=>{calls++;guard.deletedCleanupChecked('p',state.revision);}};
  installAutomaticDeletedCleanup(guard);
  const advance=async ms=>{t.mock.timers.tick(ms);for(let i=0;i<12;i++)await Promise.resolve();};
  await advance(350);assert.equal(calls,1);
  for(let i=0;i<3;i++){guard.scheduleDeletedCleanup('p');await advance(250);}
  assert.equal(calls,1,'ordinary updates must not rescan already checked deletion receipts');
  state.mediaKeys.push('image:late');state.revision='delete-1-with-late-output';guard.scheduleDeletedCleanup('p');await advance(250);assert.equal(calls,2);
  state.revision='delete-2';guard.recordDeletedObjects('p',[{id:'removed'}],[]);await advance(250);assert.equal(calls,3,'deleting the same item again is a new cleanup revision');
});

test('redo restarts only previously authorized deletion receipts and preserves unrelated history removals', async () => {
  const indexedDB = new IDBFactory();
  const vault = new Vault(indexedDB);
  const nodes = ['deleted','unrelated'].map(id => ({ id, type:'image', metadata:{storageKey:'image:'+id} }));
  const current = { nodes, connections:[] };
  const next = { nodes:[], connections:[] };
  await vault.recordDeletedObjects('p',[nodes[0]],[],[],1000);
  await vault.cancelRestoredDeletedObjects('p',projectObjectIds(current),2000);
  assert.equal(await vault.recordRedoneDeletedObjects('p',removedHistoryObjects(current,next),3000),1);
  const records = await vault.all('cleanup_candidates');
  assert.equal(records.find(record=>record.source==='user-delete').cleanupAfter,63000);
  assert.deepEqual([...recordedDeletionKeys(records,'p',63000)],['image:deleted']);
  (await vault.open()).close();
});

test('recovery honors active deletions in stale snapshots, cancelled undo and project isolation', () => {
  const image = id => ({id,storageKey:'image:'+id,status:'success'});
  const root = {id:'root',type:'image',metadata:{...image('removed-child'),images:[image('removed-child'),image('keep-child')],primaryImageId:'removed-child'}};
  const old = {id:'p',nodes:[{id:'deleted',type:'image',metadata:{storageKey:'image:deleted'}},root,{id:'keep',type:'text',metadata:{content:'keep prompts and text'}}],connections:[{id:'deleted-link',fromNodeId:'root',toNodeId:'keep'},{id:'keep-link',fromNodeId:'keep',toNodeId:'root'}],chatSessions:[{id:'keep-chat'}],viewport:{x:1,y:2,k:1}};
  const records=[{projectId:'p',source:'user-delete',nodeIds:['deleted'],connectionIds:['deleted-link'],images:[{nodeId:'root',imageId:'removed-child'}],deletedAt:1000,cleanupAfter:61000}];
  const before=JSON.stringify(old),cleaned=reconcileRecordedDeletions(old,records);
  assert.equal(JSON.stringify(old),before);
  assert.deepEqual(cleaned.nodes.map(node=>node.id),['root','keep']);
  assert.equal(cleaned.nodes[0].metadata.storageKey,'image:keep-child');
  assert.deepEqual(cleaned.connections.map(link=>link.id),['keep-link']);
  assert.equal(cleaned.chatSessions,old.chatSessions);
  assert.equal(cleaned.viewport,old.viewport);
  assert.equal(reconcileRecordedDeletions(old,[{...records[0],cancelled:true}]),old);
  const imported={...old,id:'restored-project'};
  assert.equal(reconcileRecordedDeletions(imported,records),imported);
});

test('partially undoing a legacy grouped deletion preserves the other exact deleted objects', async () => {
  const vault = new Vault(new IDBFactory());
  const receipt={source:'user-delete',projectId:'p',nodeIds:['restore','keep-deleted'],connectionIds:['removed-link'],images:[],keys:['image:unknown-legacy-owner'],deletedAt:1000,cleanupAfter:61000};
  await vault.put('cleanup_candidates','legacy-combined',receipt);
  await vault.cancelRestoredDeletedObjects('p',projectObjectIds({nodes:[{id:'restore'}],connections:[]}),2000);
  const records=await vault.all('cleanup_candidates');
  const ready=deletionWindow(records,'p',61000).ready;
  assert.deepEqual(ready[0].nodeIds,['keep-deleted']);
  assert.deepEqual(ready[0].connectionIds,['removed-link']);
  assert.deepEqual(ready[0].keys,[]);
  const project={id:'p',nodes:[{id:'restore'},{id:'keep-deleted'},{id:'unrelated'}],connections:[{id:'removed-link',fromNodeId:'restore',toNodeId:'unrelated'}]};
  assert.deepEqual(reconcileRecordedDeletions(project,records).nodes.map(n=>n.id),['restore','unrelated']);
  (await vault.open()).close();
});

test('history commits preserve pre-delete positions and connections before the native debounce expires', () => {
  const original={nodes:[{id:'a',position:{x:1,y:2}},{id:'b',position:{x:3,y:4}}],connections:[{id:'link',fromNodeId:'a',toNodeId:'b'}]};
  const moved={...original,nodes:original.nodes.map(node=>({...node,position:{x:node.position.x+30,y:node.position.y+20}}))};
  const beforeDelete=commitCanvasHistory({past:[],future:[]},original,moved);
  const deleted={...moved,nodes:[],connections:[]};
  const beforeUndo=commitCanvasHistory(beforeDelete.history,beforeDelete.current,deleted);
  assert.equal(beforeUndo.history.past.at(-1),moved);
  assert.equal(beforeUndo.current,deleted);
  const unchanged=commitCanvasHistory(beforeUndo.history,beforeUndo.current,{...deleted});
  assert.equal(unchanged.changed,false);
  assert.equal(unchanged.history,beforeUndo.history);
});

test('a deletion undo boundary survives more than fifty edits until its full minute expires', () => {
  const entries=Array.from({length:80},(_,index)=>({nodes:[{id:index}],connections:[]}));
  entries[5][Symbol.for('canvas-save-guard:undo-until')]=61000;
  assert.equal(retainedCanvasHistory(entries,50,60999)[0],entries[5]);
  assert.equal(retainedCanvasHistory(entries,50,61000)[0],entries[30]);
  assert.equal(retainedCanvasHistory(entries,50,61000).length,50);
});
