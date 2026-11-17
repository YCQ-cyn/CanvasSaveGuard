// Browser plugin not available. Isolated extension API tests with synthetic media.
import { chromium } from 'playwright';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { BATCH_VISUAL_VERSION } from '../src/native-compatibility.mjs';
const extension = path.resolve(import.meta.dirname,'../extension');
const profile = await mkdtemp(path.join(tmpdir(),'canvas-archive-audit-'));
const context = await chromium.launchPersistentContext(profile,{channel:'chromium',headless:true,acceptDownloads:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`]});
const page=await context.newPage(), downloads=[], errors=[];
page.setDefaultTimeout(20000);
page.on('download',download=>downloads.push(download));
page.on('pageerror',error=>errors.push(error.message));
try {
  await page.route('https://canvas.best/canvas/archive-audit',route=>route.fulfill({contentType:'text/html',body:'<title>Archive API fixture</title><h1>Archive API fixture</h1>'}));
  await page.route('https://canvas.best/__broken-image__',route=>route.fulfill({contentType:'text/html',body:'<html>This is an error response</html>'}));
  await page.goto('https://canvas.best/canvas/archive-audit');
  await page.waitForFunction(()=>!!window.CanvasSaveGuard);
  await page.evaluate(async batchVisualVersion=>{
    const canvas=document.createElement('canvas');canvas.width=32;canvas.height=32;canvas.getContext('2d').fillRect(0,0,32,32);
    const png=await new Promise(resolve=>canvas.toBlob(resolve));
    window.__png=png;
    const files=new Map();
    const media=window.CanvasSaveGuard.connectMedia({getImageBlob:async key=>files.get(key),setImageBlob:async(key,blob)=>{
      if(window.__importWriteGate){window.__importWriteWaited=true;await window.__importWriteGate;}
      files.set(key,blob);return URL.createObjectURL(blob);
    }},true);
    window.__media=media;
    const project={id:'archive-audit',title:'Archive API fixture',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),nodes:[],connections:[]};
    const state={projects:[project]};window.__state=state;
    window.CanvasSaveGuard.connectSite({store:{getState:()=>state,subscribe:()=>()=>{}},patchVersion:window.CanvasSaveGuard.version,batchVisualVersion});
    await window.CanvasSaveGuard.flush();
    await media.setImageBlob('image:download-0',png);
  },BATCH_VISUAL_VERSION);
  const badImageAccepted=await page.evaluate(()=>window.CanvasSaveGuard.downloadSelectedImages([{id:'broken',type:'image',metadata:{content:'https://canvas.best/__broken-image__'}}]));
  await page.waitForTimeout(60);
  const badImageDownloads=downloads.length;
  await page.evaluate(async()=>{
    const blob=new Blob([window.__png,new Uint8Array(2*1024*1024)],{type:'image/png'});
    await window.__media.setImageBlob('image:large',blob);
    window.__state.projects=[{...window.__state.projects[0],nodes:[{id:'large',type:'image',metadata:{storageKey:'image:large',status:'success'}}]}];
    const original=Blob.prototype.stream;window.__restoreStream=()=>{Blob.prototype.stream=original;};
    let release;const gate=new Promise(resolve=>{release=resolve;});window.__releaseStream=release;
    window.__streamStarts=0;
    Blob.prototype.stream=function(){
      const input=original.call(this);const first=++window.__streamStarts===1;
      return new ReadableStream({async start(controller){
        if(first)await gate;
        const reader=input.getReader();
        try{while(true){const next=await reader.read();if(next.done)break;controller.enqueue(next.value);}controller.close();}catch(error){controller.error(error);}finally{reader.releaseLock();}
      }});
    };
    window.__fullExport=window.CanvasSaveGuard.exportCurrent();
  });
  await page.waitForFunction(()=>window.__streamStarts===1);
  await page.evaluate(()=>{window.__secondResult=null;window.__secondDownload=window.CanvasSaveGuard.downloadSelectedImages(window.__state.projects[0].nodes).then(result=>{window.__secondResult=result;return result;});});
  await page.waitForTimeout(250);
  const overlapping=await page.evaluate(()=>({streams:window.__streamStarts,secondResult:window.__secondResult,saveError:window.CanvasSaveGuard.status().error}));
  await page.evaluate(async()=>{window.__releaseStream();await Promise.all([window.__fullExport,window.__secondDownload]);window.__restoreStream();});
  const retried=await page.evaluate(()=>window.CanvasSaveGuard.downloadSelectedImages(window.__state.projects[0].nodes));
  await page.waitForTimeout(60);
  await page.evaluate(()=>{
    window.__state.importProject=project=>{window.__imported=project;return 'restored';};
    window.__state.projects=[{...window.__state.projects[0],title:'blob:literal-title',nodes:[
      {id:'image',type:'image',metadata:{storageKey:'image:large',content:'guard-file:image:large',status:'success',prompt:'image:large',composerContent:'blob:composer',references:['image:large']}},
      {id:'text',type:'text',metadata:{content:'image:large',prompt:'image:prompt-only'}},
      {id:'blob-text',type:'text',metadata:{content:'blob:literal-body'}},
    ]}];
  });
  const literalDownload=page.waitForEvent('download');
  await page.evaluate(()=>window.CanvasSaveGuard.exportCurrent());
  const literalPath=path.join(tmpdir(),'canvas-v042-literal-backup.zip');
  await (await literalDownload).saveAs(literalPath);
  const chooser=page.waitForEvent('filechooser');
  await page.evaluate(()=>{window.__importWriteGate=new Promise(resolve=>{window.__releaseImportWrite=resolve;});});
  await page.locator('#canvas-save-guard').getByRole('button',{name:'恢复 ZIP',exact:true}).click();
  await (await chooser).setFiles(literalPath);
  await page.waitForFunction(()=>window.__importWriteWaited);
  const importBusy=await page.evaluate(async()=>({downloadAccepted:await window.CanvasSaveGuard.downloadSelectedImages(window.__state.projects[0].nodes),saveError:window.CanvasSaveGuard.status().error}));
  assert.equal(importBusy.downloadAccepted,false);
  assert.equal(importBusy.saveError,'');
  await page.evaluate(()=>window.__releaseImportWrite());
  await page.waitForFunction(()=>document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#status').textContent.startsWith('已恢复 1 张画布'));
  const restored=await page.evaluate(()=>window.__imported);
  assert.equal(restored.nodes[0].metadata.prompt,'image:large');
  assert.equal(restored.nodes[0].metadata.composerContent,'blob:composer');
  assert.equal(restored.nodes[1].metadata.content,'image:large');
  assert.equal(restored.nodes[1].metadata.prompt,'image:prompt-only');
  assert.equal(restored.nodes[2].metadata.content,'blob:literal-body');
  assert.match(restored.nodes[0].metadata.storageKey,/^image:guard-/);
  assert.equal(restored.nodes[0].metadata.references[0],restored.nodes[0].metadata.storageKey);
  assert.equal(restored.nodes[0].metadata.content,`guard-file:${restored.nodes[0].metadata.storageKey}`);
  console.log('PASS ZIP restore keeps literal prompt/text bytes while remapping real media references');
  const result={literalTextRestored:true,badImageAccepted,badImageDownloads,overlapping,importBusy,retried,errors};
  assert.equal(badImageAccepted,false);
  assert.equal(badImageDownloads,0);
  assert.equal(overlapping.streams,1);
  assert.equal(overlapping.secondResult,false);
  assert.equal(overlapping.saveError,'');
  assert.equal(retried,true);
  assert.deepEqual(errors,[]);
  await writeFile(path.join(tmpdir(),'canvas-v042-archive-audit-after.json'),JSON.stringify(result,null,2));
  console.log(JSON.stringify(result,null,2));
}finally{
  await context.close();assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir())+path.sep));await rm(profile,{recursive:true,force:true});
}
