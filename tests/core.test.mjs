import test from 'node:test';
import { readFile, access } from 'node:fs/promises';
import { batchIntersectsViewport, selectedDownloadNodes } from '../src/batch-layout.mjs';
import assert from 'node:assert/strict';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { unzipSync, zipSync, strToU8 } from 'fflate';
import { collectMedia, mergeProjects, newerProjects, prepareArchive, sha256, safeName } from '../src/core.mjs';
import { makeZip, verifyZip } from '../src/zip.mjs';
import { Vault } from '../src/vault.mjs';
import { BUILD_VERSION } from '../src/status-upgrade.mjs';
import { prepareImageDownload } from '../src/image-download.mjs';
import { hasUnkeyedBlob } from '../src/cleanup-storage.mjs';
import { isMediaTextField } from '../src/media-fields.mjs';
import vm from 'node:vm';

test('restoration checks protection results for its imported canvas snapshots', async () => {
  const main=await readFile(new URL('../src/main.mjs',import.meta.url),'utf8');
  const start=main.indexOf('  function importArchive(file)'),end=main.indexOf('  function repairPointer()',start);
  assert.ok(start>0&&end>start);
  const execute=async failures=>{
    const context={withArchive:action=>action(),verifyZip:async()=>({projects:1,data:{projects:[{project:{title:'restored',nodes:[]},files:[]}]}}),
      canvasStore:{getState:()=>({importProject:()=> 'restored'})},isMediaTextField,flushJobs:async()=>{},
      currentError:()=> 'old canvas error',protectionErrors:failures,latestSignature:id=>id==='restored'?'new-signature':'old-signature',render:()=>{}};
    return vm.runInNewContext(main.slice(start,end)+'\nimportArchive({});',context);
  };
  const oldFailure=new Map([['old',{signature:'old-signature',message:'old canvas error'}]]);
  assert.equal(await execute(oldFailure),'restored');
  assert.equal(oldFailure.size,1);
  await assert.rejects(execute(new Map([['restored',{signature:'new-signature',message:'new canvas protection failed',details:[]}]])),/new canvas protection failed/);
});

test('literal text is excluded from media matching while real references and embedded media remain protected', () => {
  const source={nodes:[{type:'text',title:'blob:title',metadata:{content:'blob:text',prompt:'image:literal',references:['image:required'],
    text:{type:'image',storageKey:'image:embedded',content:'blob:embedded'}}}]};
  assert.deepEqual([...collectMedia(source).keys()].sort(),['image:embedded','image:required']);
  assert.equal(hasUnkeyedBlob(source),false);
  assert.equal(hasUnkeyedBlob({nodes:[{type:'image',metadata:{content:'blob:actual'}}]}),true);
  assert.equal(hasUnkeyedBlob({nodes:[{type:'text',metadata:{content:'blob:text',references:['blob:required']}}]}),true);
});

test('collapsed download retains a result whose obsolete mapping points at a text node', () => {
  const nodes=[{id:'root',type:'image',metadata:{storageKey:'image:a',primaryImageId:'a',images:[{id:'a',storageKey:'image:a'},{id:'b',storageKey:'image:b'}],imageBatchExpanded:false,guardBatchChildren:{b:'text'}}},
    {id:'text',type:'text',metadata:{batchRootId:'root',guardBatchImageId:'b',content:'Preserve text'}}];
  const before=JSON.stringify(nodes),selected=selectedDownloadNodes(nodes,new Set(['root']));
  assert.deepEqual(selected.map(node=>node.metadata.storageKey),['image:a','image:b']);
  assert.equal(JSON.stringify(nodes),before);
});

test('temporary download keys cannot substitute a different stored file and transient blobs request fresh validation', async () => {
  const temporary = new Blob(['temporary'],{type:'image/png'}), stored = new Blob(['stored'],{type:'image/png'}), reads=[], validation=[];
  const selected = [
    {id:'temporary',type:'image',metadata:{content:'blob:temporary'}},
    {id:'stored',type:'image',metadata:{storageKey:'image:download-0'}},
  ];
  const prepared=await prepareImageDownload(selected,async key=>{reads.push(key);return stored;},async()=>temporary,async(blob,key,options)=>validation.push(options));
  const zip=unzipSync(new Uint8Array(await (await makeZip(prepared,{filesOnly:true})).arrayBuffer()));
  assert.deepEqual(Object.values(zip).map(bytes=>new TextDecoder().decode(bytes)),['temporary','stored']);
  assert.deepEqual(reads,['image:download-0']);
  assert.deepEqual(validation,[{cache:false},{cache:true}]);
});

test('download and archive names replace control characters from multiline titles', () => {
  assert.equal(safeName('first\nsecond\r\nthird\u0000file'),'first_second__third_file');
  assert.doesNotMatch(safeName('image\tname\u001fend'),/[\u0000-\u001f]/);
});

test('literal blob URLs and media-key-looking prompts remain text through backup and ZIP verification', async () => {
  const source={id:'literal-text',title:'blob:literal-title',nodes:[
    {id:'picture',type:'image',metadata:{storageKey:'image:real',content:'blob:real',prompt:'image:real',composerContent:'blob:composer',references:['image:real']}},
    {id:'text',type:'text',metadata:{content:'blob:literal-body',prompt:'image:prompt-only'}},
    {id:'key-text',type:'text',metadata:{content:'image:real'}},
  ],connections:[]};
  const before=JSON.stringify(source), reads=[];
  const prepared=await prepareArchive([source],async key=>{reads.push(key);return new Blob(['actual image'],{type:'image/png'});},async()=>{throw Error('Unexpected text fetch');});
  assert.deepEqual(reads,['image:real']);
  const checked=await verifyZip(await makeZip(prepared));
  assert.equal(checked.files,1);
  assert.equal(checked.data.projects[0].project.title,source.title);
  assert.equal(checked.data.projects[0].project.nodes[0].metadata.prompt,'image:real');
  assert.equal(checked.data.projects[0].project.nodes[0].metadata.composerContent,'blob:composer');
  assert.deepEqual(checked.data.projects[0].project.nodes.slice(1),source.nodes.slice(1));
  assert.equal(JSON.stringify(source),before);
});

test('collapsed selection downloads every result once while expanded selection retains its explicit image scope', async () => {
  const image = id => ({ id, storageKey:`image:${id}`, status:'success', content:`blob:${id}` });
  const nodes = [
    { id:'collapsed',type:'image',metadata:{...image('c1'),primaryImageId:'c1',images:['c1','c2','c3','c4','c5'].map(image),imageBatchExpanded:false,references:['image:input']} },
    { id:'expanded',type:'image',metadata:{...image('e1'),primaryImageId:'e1',images:['e1','e2','e3'].map(image),imageBatchExpanded:true} },
    { id:'unselected',type:'image',metadata:image('unselected') },
  ];
  const before = JSON.stringify(nodes);
  const selected = selectedDownloadNodes(nodes,new Set(['collapsed','expanded']),[{nodeId:'collapsed',imageId:'c2'},{nodeId:'expanded',imageId:'e2'}]);
  assert.deepEqual(selected.map(node=>node.metadata.storageKey),['image:c1','image:c2','image:c3','image:c4','image:c5','image:e1','image:e2']);
  assert.equal(JSON.stringify(nodes),before);
  const prepared = await prepareImageDownload(selected,async key=>new Blob([key],{type:'image/png'}),async()=>null,async()=>{});
  const zip = unzipSync(new Uint8Array(await (await makeZip(prepared,{filesOnly:true})).arrayBuffer()));
  assert.equal(Object.keys(zip).length,7);
  assert.deepEqual(Object.values(zip).map(bytes=>new TextDecoder().decode(bytes)),selected.map(node=>node.metadata.storageKey));
});

test('collapsed migrated groups include actual nested offscreen children and their latest media while preserving pending nodes', () => {
  const node = (id,key,metadata={}) => ({ id,type:'image',position:{x:50000,y:50000},metadata:{storageKey:key,status:'success',...metadata} });
  const nodes = [
    node('root','image:first',{isBatchRoot:true,batchChildIds:['first','nested'],imageBatchExpanded:false,primaryImageId:'first'}),
    node('first','image:first',{batchRootId:'root'}),
    node('nested','image:nested',{batchRootId:'root',primaryImageId:'primary',imageBatchExpanded:true,
      images:[{id:'primary',storageKey:'image:nested'},{id:'mapped',storageKey:'image:stale'},{id:'pending',status:'loading'}],guardBatchChildren:{mapped:'deep'}}),
    node('deep','image:latest',{batchRootId:'nested',guardBatchImageId:'mapped'}),
    node('other','image:unselected',{batchRootId:'root'}),
  ];
  const before = JSON.stringify(nodes), selected = selectedDownloadNodes(nodes,new Set(['root','deep']));
  assert.deepEqual(selected.map(item=>item.metadata.storageKey),['image:first','image:nested',undefined,'image:latest']);
  assert.equal(selected.find(item=>item.metadata.status==='loading').metadata.storageKey,undefined);
  assert.equal(JSON.stringify(nodes),before);
});

test('whole-group download traverses deep ownership and cycles iteratively without changing the original graph', () => {
  const nodes = Array.from({length:12000},(_,index)=>({id:String(index),type:'image',metadata:{storageKey:`image:${index}`,isBatchRoot:true,
    batchRootId:String((index+11999)%12000),batchChildIds:[String((index+1)%12000)],imageBatchExpanded:false}}));
  const before = JSON.stringify(nodes), selected = selectedDownloadNodes(nodes,new Set(['0']));
  assert.equal(selected.length,12000);
  assert.equal(new Set(selected.map(node=>node.metadata.storageKey)).size,12000);
  assert.equal(JSON.stringify(nodes),before);
});

test('selected-image download includes only selected displayed files, keeps order and original bytes and reports empty failures', async () => {
  const first = new Blob(['original png bytes'], { type: 'image/png' });
  const second = new Blob(['original webp bytes'], { type: 'image/webp' });
  const selected = [
    { id: 'main', type: 'image', title: 'same/title', metadata: { storageKey: 'image:first', references: ['image:unselected-reference'] } },
    { id: 'child', type: 'image', title: 'same/title', metadata: { storageKey: 'image:second' } },
    { id: 'duplicate', type: 'image', title: 'same/title', metadata: { storageKey: 'image:first' } },
    { id: 'failed', type: 'image', metadata: { status: 'error' } },
    { id: 'text', type: 'text', metadata: { content: 'keep text' } },
  ];
  const before = JSON.stringify(selected), reads = [];
  const prepared = await prepareImageDownload(selected, async key => { reads.push(key); return key === 'image:first' ? first : second; }, () => { throw Error('Unexpected fetch'); }, async () => {});
  assert.deepEqual(reads, ['image:first', 'image:second']);
  assert.equal(prepared.skipped, 1);
  assert.equal(JSON.stringify(selected), before);
  const zip = unzipSync(new Uint8Array(await (await makeZip(prepared, { filesOnly: true })).arrayBuffer()));
  assert.deepEqual(Object.keys(zip), ['001-same_title.png', '002-same_title.webp', '003-same_title.png']);
  assert.deepEqual(zip['001-same_title.png'], new Uint8Array(await first.arrayBuffer()));
  assert.deepEqual(zip['002-same_title.webp'], new Uint8Array(await second.arrayBuffer()));
  await assert.rejects(prepareImageDownload([selected[3]], async () => null, async () => null, async () => {}), /没有可下载/);
  await assert.rejects(prepareImageDownload([selected[0]], async () => null, async () => null, async () => {}), /无法读取/);
});

test('built manifest, package and redirected native resource share the release version', async () => {
  const manifest = JSON.parse(await readFile(new URL('../extension/manifest.json', import.meta.url), 'utf8'));
  const rules = JSON.parse(await readFile(new URL('../extension/rules.json', import.meta.url), 'utf8'));
  const packageInfo = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const resource = `patches/canvas-client-v020-${BUILD_VERSION}.js`;
  assert.equal(manifest.version, BUILD_VERSION);
  assert.equal(packageInfo.version, BUILD_VERSION);
  assert.ok(manifest.web_accessible_resources.some(entry => entry.resources.includes(resource)));
  assert.equal(rules.find(rule => rule.id === 2).action.redirect.extensionPath, `/${resource}`);
  await access(new URL(`../extension/${resource}`, import.meta.url));
});

test('rollback removes collapsed-unload controls and rendering subscriptions from both supported native bundles', async () => {
  for (const file of ['guard.js', 'patches/canvas-client-v040.js', `patches/canvas-client-v020-${BUILD_VERSION}.js`]) {
    const source = await readFile(new URL(`../extension/${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /getCollapsedUnload|subscribeCollapsedRendering|collapsedImageNodeIds|canvas-guard-batch-viewport|canvas-save-guard:collapsed-unload/);
  }
});

test('viewport culling retains an expanded offscreen parent while a result remains visible', () => {
  const node = { type: 'image', position: { x: 0, y: 0 }, width: 100, height: 80,
    metadata: { images: [{ id: 'first' }, { id: 'second' }], batchImagePositions: { first: { x: 800, y: 200 }, second: { x: -500, y: -300 } } } };
  const before = JSON.stringify(node);
  assert.equal(batchIntersectsViewport(node, { left: 810, right: 850, top: 210, bottom: 240 }), true);
  assert.equal(batchIntersectsViewport(node, { left: -490, right: -450, top: -290, bottom: -250 }), true);
  assert.equal(batchIntersectsViewport(node, { left: 2000, right: 2100, top: 1000, bottom: 1100 }), false);
  assert.equal(batchIntersectsViewport({ ...node, metadata: { ...node.metadata, imageBatchExpanded: false } }, { left: 810, right: 850, top: 210, bottom: 240 }), false);
  assert.equal(batchIntersectsViewport({ ...node, type: 'text' }, { left: 810, right: 850, top: 210, bottom: 240 }), false);
  assert.equal(batchIntersectsViewport(node, { left: 10, right: 50, top: 10, bottom: 50 }), true);
  assert.equal(JSON.stringify(node), before);
});
import { describeMediaReferences, missingMediaDetails } from '../src/media-locations.mjs';

const image=new Blob([Uint8Array.from([137,80,78,71,13,10,26,10,1,2,3])],{type:'image/png'});
const project=()=>({id:'test',title:'测试画布',updatedAt:'2026-11-10T01:00:00Z',nodes:[{id:'root',type:'image',position:{x:10,y:20},width:192,height:208,metadata:{content:'blob:https://canvas.modelaryx.com/old',storageKey:'image:one',status:'success',batchChildIds:['child'],references:['image:reference']}}],connections:[],viewport:{x:1,y:2,k:.5},chatSessions:[]});
const files=new Map([['image:one',image],['image:reference',image]]);

test('collects image groups and bare reference keys, without treating prompts as keys',()=>{
  const p=project();p.nodes.push({metadata:{storageKey:'image:two',references:['video:ref']}});
  assert.deepEqual([...collectMedia(p).keys()].sort(),['image:one','image:reference','image:two','video:ref']);
});
test('a deleted image still used as a generation reference is identified by node and field',()=>{
  const p=project(),locations=describeMediaReferences(p,'image:reference');
  assert.equal(locations.length,1);assert.match(locations[0],/节点 1/);assert.match(locations[0],/生成参考图/);
  assert.ok(missingMediaDetails(p,['image:reference']).some(s=>s.includes('仍被引用：')));
  assert.deepEqual(describeMediaReferences(p,'image:removed'),[]);
});
test('stale unrelated projects do not replace a newer project from another tab',()=>{
  assert.deepEqual(mergeProjects([{id:'a',n:2},{id:'b',n:1}],[{id:'b',n:3}]),[{id:'a',n:2},{id:'b',n:3}]);
});
test('explicit deletions are honored, while missing items in stale snapshots are preserved',()=>{
  assert.deepEqual(mergeProjects([{id:'a'},{id:'b'}],[{id:'b'}],new Set(['a'])),[{id:'b'}]);
  assert.deepEqual(mergeProjects([{id:'a'}],[]),[{id:'a'}]);
});
test('refresh chooses a protected snapshot newer than the original delayed write',()=>{
  assert.equal(newerProjects([{id:'a',updatedAt:'2026-01-01',n:1}],[{id:'a',updatedAt:'2026-01-02',n:2}])[0].n,2);
  assert.equal(newerProjects([{id:'a',updatedAt:'2026-01-01'}],[],[{id:'a',at:'2026-01-02'}]).length,0);
});
test('missing images stop the export, including bare reference images',async()=>{
  await assert.rejects(prepareArchive([project()],async key=>key==='image:one'?image:null,async()=>{throw Error('expired');}),error=>error.missing.some(m=>m.key==='image:reference'));
});
test('in-flight generation cannot masquerade as a complete archive',async()=>{
  const p=project();p.nodes[0].metadata.status='loading';
  await assert.rejects(prepareArchive([p],key=>files.get(key),async()=>image),/正在生成/);
});
test('undecodable images stop export rather than becoming a hash-valid broken image',async()=>{
  await assert.rejects(prepareArchive([project()],key=>files.get(key),async()=>image,async()=>{throw Error('图片文件无法正常解码');}),/无法正常解码/);
});
test('portable ZIP preserves layout and exact bytes, removes session-only URLs',async()=>{
  const prepared=await prepareArchive([project()],key=>files.get(key),async()=>image);
  const zip=await makeZip(prepared),checked=await verifyZip(zip);
  assert.equal(checked.files,2);assert.equal(checked.hashed,true);
  assert.deepEqual(checked.data.projects[0].project.viewport,project().viewport);
  assert.deepEqual(checked.data.projects[0].project.nodes[0].position,{x:10,y:20});
  assert.ok(!JSON.stringify(checked.data).includes('blob:'));
  for(const file of checked.data.projects[0].files)assert.equal(await sha256(checked.entries[file.path]),await sha256(await image.arrayBuffer()));
});
test('readable unkeyed blob media is included as a real file',async()=>{
  const p=project();delete p.nodes[0].metadata.storageKey;p.nodes[0].metadata.references=[];
  const prepared=await prepareArchive([p],async()=>null,async()=>image);
  assert.equal(prepared.data.projects[0].files.length,1);
  assert.ok(prepared.data.projects[0].project.nodes[0].metadata.storageKey.startsWith('image:guard-'));
});
test('text content that is a URL stays text and is not fetched as a media file',async()=>{
  const p=project();p.nodes.push({id:'text',type:'text',metadata:{status:'success',content:'https://example.com/a-note'}});
  let fetched=false;
  const prepared=await prepareArchive([p],key=>files.get(key),async()=>{fetched=true;throw Error('must not fetch');});
  assert.equal(fetched,false);assert.equal(prepared.data.projects[0].project.nodes[1].metadata.content,'https://example.com/a-note');
});
test('a complete native archive with keyed blob content can be structurally checked',async()=>{
  const p=project(),data={app:'infinite-canvas',version:3,projects:[{project:p,files:[...files.keys()].map((key,i)=>({storageKey:key,path:`files/${i}.png`,bytes:image.size,mimeType:image.type}))}]};
  const entries={'projects.json':strToU8(JSON.stringify(data))};
  for(const f of data.projects[0].files)entries[f.path]=new Uint8Array(await image.arrayBuffer());
  const result=await verifyZip(new Blob([zipSync(entries)]));assert.equal(result.files,2);assert.equal(result.hashed,false);
});
test('a removed file in an otherwise valid ZIP is detected',async()=>{
  const zip=await makeZip(await prepareArchive([project()],key=>files.get(key),async()=>image));
  const entries=unzipSync(new Uint8Array(await zip.arrayBuffer()));
  delete entries[Object.keys(entries).find(name=>name.endsWith('.png'))];
  await assert.rejects(verifyZip(new Blob([zipSync(entries)])),error=>error.details.some(d=>d.startsWith('缺文件')));
});
test('same-length file corruption is detected with SHA-256',async()=>{
  const zip=await makeZip(await prepareArchive([project()],key=>files.get(key),async()=>image));
  const entries=unzipSync(new Uint8Array(await zip.arrayBuffer()));
  const path=Object.keys(entries).find(name=>name.endsWith('.png'));entries[path][8]^=255;
  await assert.rejects(verifyZip(new Blob([zipSync(entries)])),error=>error.details.some(d=>d.startsWith('文件损坏')));
});
test('edited layout metadata is detected even when all media remain',async()=>{
  const zip=await makeZip(await prepareArchive([project()],key=>files.get(key),async()=>image));
  const entries=unzipSync(new Uint8Array(await zip.arrayBuffer()));
  entries['projects.json']=strToU8(new TextDecoder().decode(entries['projects.json']).replace('测试画布','被修改的画布'));
  await assert.rejects(verifyZip(new Blob([zipSync(entries)])),error=>error.details.some(d=>d.includes('画布说明文件')));
});
test('independent vault persists actual media and project across a new connection',async()=>{
  const name=`guard-test-${Date.now()}`,vault=new Vault(indexedDB,name),p=project();
  await vault.protect([p],files);
  const reopened=new Vault(indexedDB,name);
  assert.deepEqual(await reopened.get('projects',p.id),p);
  assert.deepEqual(new Uint8Array(await (await reopened.get('media','image:one')).arrayBuffer()),new Uint8Array(await image.arrayBuffer()));
});

test('a synchronous media-write failure aborts the whole protected snapshot and a later retry remains complete', async () => {
  const vault = new Vault(indexedDB, `guard-write-failure-${Date.now()}`), previous = project();
  await vault.protect([previous], files);
  const next = structuredClone(previous); next.title = 'new snapshot';
  next.nodes.push({ id: 'new', type: 'image', metadata: { storageKey: 'image:new', status: 'success' } });
  const original = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (value, key) {
    if (this.name === 'media' && key === 'image:new') throw new DOMException('Synthetic storage quota failure', 'QuotaExceededError');
    return original.apply(this, arguments);
  };
  try { await assert.rejects(vault.protect([next], new Map([['image:new', image]])), /quota failure/); }
  finally { IDBObjectStore.prototype.put = original; }
  assert.deepEqual(await vault.get('projects', previous.id), previous);
  assert.equal(await vault.get('media', 'image:new'), undefined);
  await vault.protect([next], new Map([['image:new', image]]));
  assert.deepEqual(await vault.get('projects', previous.id), next);
  assert.equal(await sha256(await (await vault.get('media', 'image:new')).arrayBuffer()), await sha256(await image.arrayBuffer()));
});


test('legacy undated projects survive hydration and v0.20 deletedProjects tombstones use the latest deletion time', () => {
  const project = { id: 'legacy', nodes: [], connections: [] };
  assert.deepEqual(newerProjects([project], []), [project]);
  assert.deepEqual(newerProjects([{ ...project, updatedAt: '2026-11-01T00:00:00Z' }], [], [
    { id: 'legacy', at: '2026-11-11T00:00:00Z' }, { id: 'legacy', deletedAt: '2026-11-10T00:00:00Z' },
  ]), []);
});
