import { chromium } from 'playwright';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const projectRoot=path.resolve(import.meta.dirname,'..');
const results=path.join(tmpdir(),'canvas-save-guard-tests');await mkdir(results,{recursive:true});
const profile=await mkdtemp(path.join(tmpdir(),'canvas-guard-profile-'));
const extension=path.join(projectRoot,'extension');
const context=await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,viewport:{width:1360,height:960},acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const errors=[];const page=await context.newPage();
page.on('pageerror',e=>{errors.push(e.stack||e.message);console.error('PAGE ERROR',e.stack||e.message);});
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
const report=[];
const pass=(name,detail)=>{report.push({name,detail});console.log('PASS',name,detail||'');};
try{
  await page.route('**/__guard_seed__',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><title>Isolated fixture</title>'}));
  await page.goto('https://canvas.modelaryx.com/__guard_seed__');
  await page.evaluate(async()=>{
    const canvas=document.createElement('canvas');canvas.width=16;canvas.height=16;const c=canvas.getContext('2d');c.fillStyle='#5479e5';c.fillRect(0,0,16,16);
    const blob=await new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
    const p={id:'guard-test',title:'保护测试',createdAt:'2026-11-10T01:00:00Z',updatedAt:'2026-11-10T01:00:00Z',connections:[{id:'connection',fromNodeId:'root',toNodeId:'child'}],chatSessions:[],activeChatId:null,backgroundMode:'lines',showImageInfo:false,viewport:{x:0,y:0,k:1},nodes:[
      {id:'root',type:'image',title:'组主图',position:{x:150,y:140},width:200,height:200,metadata:{status:'success',content:'blob:https://canvas.modelaryx.com/expired-root',storageKey:'image:root',naturalWidth:16,naturalHeight:16,bytes:blob.size,mimeType:'image/png',isBatchRoot:true,batchChildIds:['child'],primaryImageId:'root',imageBatchExpanded:true,references:['image:reference']}},
      {id:'child',type:'image',title:'组子图',position:{x:470,y:140},width:200,height:200,metadata:{status:'success',content:'blob:https://canvas.modelaryx.com/expired-child',storageKey:'image:child',naturalWidth:16,naturalHeight:16,bytes:blob.size,mimeType:'image/png',batchRootId:'root'}}
    ]};
    const db=await new Promise((resolve,reject)=>{const req=indexedDB.open('infinite-canvas',3);req.onupgradeneeded=()=>{for(const s of ['app_state','image_files','media_files','image_generation_logs','video_generation_logs','local-forage-detect-blob-support'])if(!req.result.objectStoreNames.contains(s))req.result.createObjectStore(s);};req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});
    await new Promise((resolve,reject)=>{const tx=db.transaction(['app_state','image_files'],'readwrite');tx.objectStore('app_state').put(JSON.stringify({state:{projects:[p]},version:0}),'infinite-canvas:canvas_store');for(const key of ['image:root','image:child','image:reference'])tx.objectStore('image_files').put(blob,key);tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
  });
  await page.goto('https://canvas.modelaryx.com/canvas/guard-test');
  await page.waitForSelector('[data-node-id="root"]',{timeout:45000});
  await page.waitForFunction(()=>window.CanvasSaveGuard?.status().attached&&window.CanvasSaveGuard.status().pending===0&&!!window.CanvasSaveGuard.status().protectedAt,{timeout:20000});
  assert.equal(await page.title(),'无限画布');
  assert.equal(await page.evaluate(()=>window.CanvasSaveGuard.status().clickPatched),true);
  pass('actual v0.4.0 page loads with extension and patched resource');
  const images=()=>page.locator('[data-node-id] img').evaluateAll(images=>images.every(i=>i.complete&&i.naturalWidth===16));
  assert.equal(await images(),true);pass('all fixture images decode from stored original bytes');
  await page.locator('[data-node-id="root"]').click({position:{x:100,y:100}});
  await page.waitForSelector('[data-node-id="root"] > div[class*="top-full"]');
  pass('clicking a batch root opens its native operation panel');
  await page.mouse.move(250,240);await page.mouse.down();await page.mouse.move(290,270,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('[data-node-id="root"]').style.transform==='translate(190px, 170px)'&&document.querySelector('[data-node-id="child"]').style.transform==='translate(510px, 170px)');
  await page.evaluate(()=>window.CanvasSaveGuard.flush());
  pass('batch dragging moves root and child by the same 40 x 30 pixels');
  await page.evaluate(()=>{const overlay=document.querySelector('#local-canvas-retry-panel');overlay.style.cssText='position:fixed;left:500px;top:150px;width:240px;height:240px;z-index:2147483647;cursor:default;pointer-events:auto';});
  assert.equal(await page.evaluate(()=>document.elementFromPoint(610,250).id),'local-canvas-retry-panel');
  await page.locator('#canvas-save-guard').getByRole('button',{name:'收起重试工具',exact:true}).click();
  assert.notEqual(await page.evaluate(()=>document.elementFromPoint(610,250).id),'local-canvas-retry-panel');
  await page.locator('[data-node-id="child"]').click({position:{x:100,y:100}});
  await page.waitForSelector('[data-node-id="child"] > div[class*="top-full"]');
  pass('collapsing the retry overlay restores native clicks on the image underneath');

  // Reproduce the live failure: stacked Ant Design notices intercept the centre
  // of the canvas even though its native hand tool is still selected.
  await page.evaluate(()=>{
    const style=document.querySelector('#canvas-save-guard-pointer-style');style.disabled=true;
    const root=document.createElement('div');root.className='ant-message';root.id='guard-message-fixture';
    root.style.cssText='position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    const notice=document.createElement('div');notice.className='ant-message-notice';
    notice.style.cssText='position:absolute;left:500px;top:150px;width:240px;height:240px;pointer-events:auto;background:rgba(250,250,250,.9);color:#252831';
    const title=document.createElement('div');title.className='ant-message-notice-title';title.textContent='测试提示仍然保留';
    const button=document.createElement('button');button.textContent='测试提示关闭按钮';button.style.cssText='position:absolute;left:20px;bottom:10px';button.onclick=()=>root.dataset.action='clicked';
    notice.append(title,button);root.append(notice);document.body.append(root);
  });
  assert.equal(await page.evaluate(()=>!!document.elementFromPoint(610,250).closest('#guard-message-fixture')),true);
  await page.evaluate(()=>{document.querySelector('#canvas-save-guard-pointer-style').disabled=false;});
  assert.equal(await page.evaluate(()=>!!document.elementFromPoint(610,250).closest('#guard-message-fixture')),false);
  assert.equal(await page.getByText('测试提示仍然保留',{exact:true}).isVisible(),true);
  pass('message text remains visible while its rectangle stops intercepting canvas input');
  await page.mouse.click(900,450);
  await page.waitForFunction(()=>!document.querySelector('[data-node-id="child"] > div[class*="top-full"]'));
  await page.locator('[data-node-id="child"]').click({position:{x:100,y:100}});
  await page.waitForSelector('[data-node-id="child"] > div[class*="top-full"]');
  pass('native image selection works underneath a message card');
  const childBounds=await page.locator('[data-node-id="child"]').boundingBox();
  await page.mouse.move(childBounds.x+100,childBounds.y+100);await page.mouse.down();await page.mouse.move(childBounds.x+120,childBounds.y+110,{steps:5});await page.mouse.up();
  await page.waitForFunction(()=>document.querySelector('[data-node-id="child"]').style.transform==='translate(530px, 180px)');
  pass('native image dragging works underneath a message card');
  await page.getByRole('button',{name:'测试提示关闭按钮',exact:true}).click();
  assert.equal(await page.locator('#guard-message-fixture').getAttribute('data-action'),'clicked');
  pass('explicit message buttons remain clickable');
  await page.evaluate(()=>{window.__existingGuardReference=window.CanvasSaveGuard;document.querySelector('#canvas-save-guard-pointer-style').remove();});
  await page.addScriptTag({path:path.join(extension,'guard.js')});
  assert.equal(await page.evaluate(()=>window.__existingGuardReference===window.CanvasSaveGuard),true);
  assert.equal(await page.evaluate(()=>document.querySelector('#canvas-save-guard-pointer-style').dataset.version),'1.0.1');
  assert.equal(await page.locator('#canvas-save-guard').count(),1);
  assert.equal(await page.evaluate(()=>!!document.elementFromPoint(610,250).closest('#guard-message-fixture')),false);
  pass('message repair attaches to an existing protection session without refreshing or replacing its state');
  await page.evaluate(()=>document.querySelector('#guard-message-fixture').remove());

  const downloadPromise=page.waitForEvent('download');
  await page.locator('#canvas-save-guard').getByRole('button',{name:'保存完整 ZIP',exact:true}).click();
  const download=await downloadPromise;
  const zipPath=path.join(results,'verified.zip');await download.saveAs(zipPath);
  pass('one-click ZIP export downloads after verification',zipPath);
  await page.evaluate(async()=>{
    const id='canvas-guard-browser-test-read';
    window.TURBOPACK.push(['static/chunks/canvas-guard-browser-test.js',id,context=>{window.__guardTestStore=context.i(83629).useCanvasStore;}]);
    window.TURBOPACK.push(['static/chunks/canvas-guard-browser-test.js',{otherChunks:[],runtimeModuleIds:[id]}]);
  });
  await page.waitForFunction(()=>!!window.__guardTestStore);
  await page.evaluate(async()=>{
    window.__guardTestStore.getState().importProject({title:'其他画布缺图',nodes:[{id:'other-missing',type:'image',title:'旧画布丢失图',position:{x:0,y:0},width:100,height:100,metadata:{storageKey:'image:unrelated-missing',status:'success'}}]});
    await window.CanvasSaveGuard.flush();
  });
  assert.equal(await page.evaluate(()=>window.CanvasSaveGuard.status().error),'');
  assert.match(await page.locator('#canvas-save-guard').locator('#status').innerText(),/已保护|已校验并导出/);
  pass('a missing image in another project does not contaminate the current canvas status');
  await page.evaluate(async()=>{
    const store=window.__guardTestStore,p=store.getState().projects.find(p=>p.id==='guard-test');
    window.__guardCleanNodes=p.nodes;
    store.getState().updateProject(p.id,{nodes:[...p.nodes.map(n=>n.id==='root'?{...n,metadata:{...n.metadata,references:[...(n.metadata.references||[]),'image:removed-file']}}:n),{id:'removed-file-node',type:'image',title:'即将删除的图片',position:{x:850,y:150},width:100,height:100,metadata:{storageKey:'image:removed-file',status:'success'}}]});
    try{await window.CanvasSaveGuard.flush();}catch{}
  });
  await page.waitForFunction(()=>window.CanvasSaveGuard.status().pending===0&&window.CanvasSaveGuard.status().error.includes('无法读取'));
  await page.evaluate(async()=>{
    const store=window.__guardTestStore,p=store.getState().projects.find(p=>p.id==='guard-test');
    store.getState().updateProject(p.id,{nodes:p.nodes.filter(n=>n.id!=='removed-file-node')});
    try{await window.CanvasSaveGuard.flush();}catch{}
  });
  assert.match(await page.locator('#canvas-save-guard').locator('#detail').innerText(),/生成参考图/);
  assert.doesNotMatch(await page.locator('#canvas-save-guard').locator('#detail').innerText(),/removed-file-node/);
  const blockedExport=await page.evaluate(async()=>{try{await window.CanvasSaveGuard.exportCurrent();return false;}catch{return true;}});
  assert.equal(blockedExport,true);
  pass('deleting a visible image keeps a real remaining reference warning and identifies its owning node');
  await page.evaluate(async()=>{
    window.__guardTestStore.getState().updateProject('guard-test',{nodes:window.__guardCleanNodes});
    await window.CanvasSaveGuard.flush();
  });
  await page.waitForFunction(()=>window.CanvasSaveGuard.status().pending===0&&!window.CanvasSaveGuard.status().error);
  assert.equal(await page.locator('#canvas-save-guard').locator('#detail').isVisible(),false);
  pass('removing the last reference clears the warning automatically without refreshing');
  await page.evaluate(async()=>{
    const store=window.__guardTestStore;
    store.getState().updateProject('guard-test',{nodes:[...window.__guardCleanNodes,{id:'stale-missing',type:'image',position:{x:0,y:0},width:100,height:100,metadata:{storageKey:'image:stale',status:'success'}}]});
    store.getState().updateProject('guard-test',{nodes:window.__guardCleanNodes});
    await window.CanvasSaveGuard.flush();
  });
  assert.equal(await page.evaluate(()=>window.CanvasSaveGuard.status().error),'');
  await page.locator('#canvas-save-guard').getByRole('button',{name:'重新检查',exact:true}).click();
  await page.waitForFunction(()=>!document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#recheck').disabled&&window.CanvasSaveGuard.status().pending===0&&!window.CanvasSaveGuard.status().error);
  assert.match(await page.locator('#canvas-save-guard').locator('#status').innerText(),/已保护/);
  pass('obsolete queued snapshots cannot resurrect a warning, and Recheck verifies the latest canvas');
  const expected=await page.evaluate(async()=>{
    const store=window.__guardTestStore,p=store.getState().projects.find(p=>p.id==='guard-test');
    store.getState().updateProject(p.id,{nodes:p.nodes.map(n=>n.id==='root'?{...n,title:'刷新前最后修改'}:n)});
    await window.CanvasSaveGuard.flush();
    const db=await new Promise(resolve=>{const request=indexedDB.open('infinite-canvas');request.onsuccess=()=>resolve(request.result);});
    await new Promise((resolve,reject)=>{const tx=db.transaction(['app_state','image_files'],'readwrite');tx.objectStore('app_state').put(JSON.stringify({state:{projects:[]},version:0}),'infinite-canvas:canvas_store');tx.objectStore('image_files').delete('image:root');tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error);});db.close();
    return p.nodes.map(n=>({id:n.id,position:n.position}));
  });
  await page.reload();
  await page.waitForSelector('[data-node-id="root"]');
  await page.waitForFunction(()=>window.CanvasSaveGuard?.status().pending===0&&!!window.CanvasSaveGuard.status().protectedAt);
  assert.equal(await images(),true);
  assert.equal(await page.locator('[data-node-id="root"] img').getAttribute('alt'),'刷新前最后修改');
  pass('refresh recovers a missing original database record and missing image from the independent vault');

  // A separate fresh browser profile proves the ZIP does not depend on the vault or old blob URLs.
  const nativeBrowser=await chromium.launch({headless:true});
  try{
    const fresh=await nativeBrowser.newPage({viewport:{width:1360,height:960}});
    await fresh.goto('https://canvas.modelaryx.com/canvas',{waitUntil:'domcontentloaded'});
    await fresh.getByRole('button',{name:'导入画布',exact:true}).waitFor();
    await fresh.waitForLoadState('networkidle');
    await fresh.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
    await fresh.locator('input[type=file][accept*="zip"]').setInputFiles(zipPath);
    await fresh.waitForFunction(()=>document.querySelector('[data-node-id="root"]') || [...document.querySelectorAll('button')].some(button=>/保护测试.*个节点/.test(button.textContent))).catch(async error=>{console.log('IMPORT DIAGNOSTIC',fresh.url(),await fresh.locator('body').innerText());throw error;});
    const imported = fresh.getByRole('button',{name:/保护测试.*个节点/});
    if (await imported.count()) await imported.click();
    await fresh.waitForSelector('[data-node-id="root"]');
    assert.equal(await fresh.locator('[data-node-id] img').evaluateAll(images=>images.length===2&&images.every(i=>i.complete&&i.naturalWidth===16)),true);
    await fresh.screenshot({path:path.join(results,'native-import.png')});
    pass('ZIP imports through the unmodified native site in a fresh browser, all images render');
    await fresh.addScriptTag({path:path.join(extension,'guard.js')});
    await fresh.waitForFunction(()=>window.CanvasSaveGuard?.status().attached&&window.CanvasSaveGuard.status().pending===0&&!!window.CanvasSaveGuard.status().protectedAt);
    assert.equal(await fresh.evaluate(()=>window.CanvasSaveGuard.status().late),true);
    assert.equal(await fresh.locator('[data-node-id] img').evaluateAll(images=>images.length===2&&images.every(i=>i.complete&&i.naturalWidth===16)),true);
    pass('already-open native page attaches and protects existing images without refreshing');
  }finally{await nativeBrowser.close();}
  if(process.env.GUARD_LEGACY_SCRIPT){
    const legacyBrowser=await chromium.launch({headless:true});
    try{
      const legacy=await legacyBrowser.newPage({viewport:{width:1360,height:960}});
      await legacy.goto('https://canvas.modelaryx.com/canvas',{waitUntil:'domcontentloaded'});
      await legacy.getByRole('button',{name:'导入画布',exact:true}).waitFor();
      await legacy.locator('input[type=file][accept*="zip"]').setInputFiles(zipPath);
      await legacy.waitForFunction(()=>document.querySelector('[data-node-id="root"]') || [...document.querySelectorAll('button')].some(button=>/保护测试.*个节点/.test(button.textContent)));
      const imported = legacy.getByRole('button',{name:/保护测试.*个节点/});
      if (await imported.count()) await imported.click();
      await legacy.waitForSelector('[data-node-id="root"]');
      await legacy.addScriptTag({path:process.env.GUARD_LEGACY_SCRIPT});
      await legacy.waitForFunction(()=>window.CanvasSaveGuard?.status().attached&&!window.CanvasSaveGuard.status().pending);
      await legacy.evaluate(()=>{
        const id='guard-legacy-store-test';
        window.TURBOPACK.push(['static/chunks/guard-legacy-test.js',id,c=>{window.__legacyStore=c.i(83629).useCanvasStore;}]);
        window.TURBOPACK.push(['static/chunks/guard-legacy-test.js',{otherChunks:[],runtimeModuleIds:[id]}]);
      });
      await legacy.waitForFunction(()=>!!window.__legacyStore);
      await legacy.evaluate(async()=>{
        window.__legacyStore.getState().importProject({title:'旧错误复现',nodes:[{id:'missing',type:'image',position:{x:0,y:0},width:100,height:100,metadata:{storageKey:'image:legacy-missing',status:'success'}}]});
        try{await window.CanvasSaveGuard.flush();}catch{}
        window.__legacyGuardReference=window.CanvasSaveGuard;
      });
      assert.match(await legacy.locator('#canvas-save-guard').locator('#status').innerText(),/无法读取/);
      await legacy.addScriptTag({path:path.join(extension,'guard.js')});
      await legacy.waitForFunction(()=>!!document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#recheck'));
      await legacy.waitForFunction(()=>!document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#recheck').disabled);
      assert.equal(await legacy.evaluate(()=>window.CanvasSaveGuard===window.__legacyGuardReference),true);
      assert.equal(await legacy.evaluate(()=>window.CanvasSaveGuard.status().error),'');
      assert.match(await legacy.locator('#canvas-save-guard').locator('#status').innerText(),/已保护/);
      assert.equal(await legacy.locator('[data-node-id] img').evaluateAll(imgs=>imgs.length===2&&imgs.every(i=>i.naturalWidth===16)),true);
      pass('v1.0.1 stale global warning is repaired in place, preserving the old live protection session and images');
    }finally{await legacyBrowser.close();}
  }
  await page.screenshot({path:path.join(results,'protected-canvas.png')});
  const appErrors=errors.filter(e=>!e.includes('favicon')&&!e.includes('404')&&!e.includes('favicon.ico'));
  assert.deepEqual(appErrors,[]);
  pass('no relevant application console errors');
  await writeFile(path.join(results,'results.json'),JSON.stringify({passed:report,errors,expected},null,2));
  console.log('RESULTS',results);
}catch(error){
  await page.screenshot({path:path.join(results,'failure.png')}).catch(()=>{});
  console.error('FAIL',error.message,errors);throw error;
}finally{
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir())+path.sep));
  await rm(profile,{recursive:true,force:true});
}
