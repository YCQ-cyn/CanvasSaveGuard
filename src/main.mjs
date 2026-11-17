import { STORE_KEY, clone, signature, collectMedia, mergeProjects, newerProjects, prepareArchive, safeName } from './core.mjs';
import { Vault } from './vault.mjs';
import { makeZip, verifyZip } from './zip.mjs';
import { installPointerPassthrough, POINTER_PATCH_VERSION } from './pointer-surfaces.mjs';
import { missingMediaDetails } from './media-locations.mjs';
import { installLegacyRecheck, BUILD_VERSION } from './status-upgrade.mjs';
import { installRetryPanel } from './retry-panel.mjs';
import { installDeletedCleanup, installCleanupUpgradeNotice, installCleanupMessaging, installAutomaticDeletedCleanup } from './cleanup.mjs';
import { withMediaAccess } from './cleanup-storage.mjs';
import { installCleanupProgress } from './cleanup-progress.mjs';
import { installAuditUpgrade } from './audit-upgrade.mjs';
import { installPanelLayout } from './panel-layout.mjs';
import { nodeMediaOwners } from './media-ownership.mjs';
import { installNativeCompatibility } from './native-compatibility.mjs';
import { projectObjectIds, DELETION_GRACE_MS } from './deletion-grace.mjs';
import { reconcileRecordedDeletions, removedHistoryObjects } from './project-recovery.mjs';
import { installMediaReport } from './media-report.mjs';
import { installGridSnapControl } from './grid-preference.mjs';
import { installDescendantControl } from './descendant-preference.mjs';
import { createRetryFlight } from './retry-flight.mjs';
import { prepareImageDownload } from './image-download.mjs';
import { isMediaTextField } from './media-fields.mjs';

// Run this outside start() so clicking the extension can also repair an already
// open page using version 1.0.0 without restarting its protection or refreshing.
installPointerPassthrough(document);
installCleanupMessaging();
installRetryPanel(document);
if(globalThis.CanvasSaveGuard){
  globalThis.CanvasSaveGuard.pointerPatchVersion=POINTER_PATCH_VERSION;
  const heading=document.querySelector('#canvas-save-guard')?.shadowRoot?.querySelector('strong');
  if(heading)heading.textContent=`画布助手 · ${globalThis.CanvasSaveGuard.version || BUILD_VERSION}`;
  installLegacyRecheck(globalThis.CanvasSaveGuard,document);
  installCleanupUpgradeNotice(globalThis.CanvasSaveGuard,document);
  installCleanupProgress(globalThis.CanvasSaveGuard,document);
  installMediaReport(globalThis.CanvasSaveGuard,document);
  installGridSnapControl(globalThis.CanvasSaveGuard,document);
  installDescendantControl(globalThis.CanvasSaveGuard,document);
  installAuditUpgrade(globalThis.CanvasSaveGuard,document);
  installPanelLayout(document);
  installNativeCompatibility(globalThis.CanvasSaveGuard,document,BUILD_VERSION);
}
if (!globalThis.CanvasSaveGuard) start();
function start() {
  const vault = new Vault(indexedDB);
  const services = {};
  const jobs = new Set();
  const urls = new Map();
  const sessionUrls = new Map();
  const resolvingUrls = new Map();
  const resolvingPreviews = new Map();
  const protectionErrors = new Map();
  const protectedSnapshots = new Map();
  const pendingProjects = new Map();
  const queuedProtection = new Map();
  const validatedMedia = new Set();
  const generationOwners = new WeakMap();
  const recordedMediaOwners = new Set();
  const observedObjects = new Map();
  const projectSignatures = new WeakMap();
  let pendingProjectDeletionWrites = 0;
  let canvasStore, rawStorage, previous = new Map(), baseline = new Map();
  let tail = Promise.resolve(), lastError = '', lastErrorProject = '', lastErrorSignature = null, deleted = new Set(), bootedLate = document.readyState !== 'loading';
  let ui, details = [], locked = false;
  let archiveActive = false;
  const retryFlight = createRetryFlight(currentId);

  const guard = globalThis.CanvasSaveGuard = {
    version:BUILD_VERSION, pointerPatchVersion:POINTER_PATCH_VERSION, clickPatched:false,
    status:()=>({attached:!!canvasStore,pending:currentPending(),error:currentError(),protectedAt:currentProtection()?.at||'',clickPatched:guard.clickPatched,late:bootedLate,nativePatchVersion:globalThis.CanvasSaveGuardNative?.patchVersion||'',batchVisualVersion:globalThis.CanvasSaveGuardNative?.batchVisualVersion||0}),
    exportCurrent:()=>exportProjects([currentProject()]),
    downloadSelectedImages,
    verify:verifyZip,
    flush:async()=>{await flushJobs();const error=currentError();if(error)throw Error(error);},
    recheckCurrent:()=>recheckCurrent(),
    attachCurrent:()=>attachExisting(),
    persistentMediaVersion:1, deletionGraceVersion:1,
    withMediaAccess,
    beginRetry: retryFlight,
    isRetryPending: (nodeId,imageId) => retryFlight.has(currentId(),nodeId,imageId),
    connectStorage: storage => wrapStorage(storage),
    connectMedia: (exports, image) => wrapMedia(exports, image),
    connectSite: site => {
      globalThis.CanvasSaveGuardNative = site;
      attachStore(site.store);
      guard.clickPatched = true;
      installNativeCompatibility(guard,document,BUILD_VERSION);
    },
    exportProjects: (projects, name) => exportProjects(projects, name),
    copyImageToClipboard: metadata => {
      if (!navigator.clipboard?.write || !globalThis.ClipboardItem) return Promise.resolve();
      const png = (async () => {
        const blob = metadata.storageKey ? await readBlob(metadata.storageKey) : await fetchBlob(metadata.content);
        if (blob.type === 'image/png') return blob;
        const bitmap = await createImageBitmap(blob), canvas = document.createElement('canvas');
        canvas.width=bitmap.width;canvas.height=bitmap.height;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();
        return new Promise(resolve=>canvas.toBlob(resolve,'image/png'));
      })();
      return navigator.clipboard.write([new ClipboardItem({'image/png':png})]);
    },
    registerGenerationOwner: (signal, nodeId, requestKey) => {
      const imageId = requestKey !== nodeId ? JSON.parse(requestKey)[1] : undefined;
      generationOwners.set(signal, { projectId: currentId(), nodeId, imageId, startedAt: Date.now() });
    },
    protectGeneratedMedia: async (signal, action) => {
      const item = await action();
      const owner = generationOwners.get(signal);
      if (owner && item.storageKey) {
        await withMediaAccess(() => vault.recordGeneratedMedia(owner, item.storageKey));
        const node = canvasStore?.getState().projects.find(project => project.id === owner.projectId)?.nodes.find(node => node.id === owner.nodeId);
        if (!node) guard.scheduleDeletedCleanup?.(owner.projectId);
      }
      return item;
    },
    recordDeletedObjects: (projectId, nodes, connections, images = []) => {
      const snapshot = clone({ nodes, connections, images });
      const deletedAt = Date.now();
      job(() => withMediaAccess(() => vault.recordDeletedObjects(projectId, snapshot.nodes, snapshot.connections, snapshot.images, deletedAt))).catch(() => {});
    },
    recordDeletedProjects: projects => {
      if (!projects.length) return;
      const deletedAt = Date.now();
      pendingProjectDeletionWrites += 1;
      job(() => withMediaAccess(() => vault.recordDeletedProjects(projects, deletedAt)))
        .then(() => guard.scheduleDeletedCleanup?.(currentId())).catch(() => {})
        .finally(() => { pendingProjectDeletionWrites -= 1; });
    },
    recordHistoryRedo: (projectId, current, next) => {
      const objects = removedHistoryObjects(current, next);
      if (!objects.nodes.length && !objects.connections.length && !objects.images.length) return;
      const snapshot = clone(objects);
      const deletedAt = Date.now();
      current[Symbol.for('canvas-save-guard:undo-until')] = deletedAt + DELETION_GRACE_MS;
      job(() => withMediaAccess(() => vault.recordRedoneDeletedObjects(projectId, snapshot, deletedAt)))
        .then(count => { if (count) guard.scheduleDeletedCleanup?.(projectId); }).catch(() => {});
    },
  };
  const fail = error => {
    if(error?.code==='ZIP_BUSY'){render(error.message);return;}
    lastError=error?.message||String(error);lastErrorProject=currentId();lastErrorSignature=latestSignature(currentId());details=error?.missing?.map(m=>`${m.key}：${m.reason}`)||error?.details||[];render();
  };
  function currentId(){return decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1]||'');}
  function projectSignature(project) { if(!projectSignatures.has(project))projectSignatures.set(project,signature(project));return projectSignatures.get(project); }
  function latestSignature(id){const project=canvasStore?.getState().projects.find(p=>p.id===id);return project?projectSignature(project):null;}
  function currentPending(){return pendingProjects.get(currentId())||0;}
  function currentProtection(){const entry=protectedSnapshots.get(currentId());return entry?.signature===latestSignature(currentId())?entry:null;}
  function currentFailure(){const entry=protectionErrors.get(currentId());return entry?.signature===latestSignature(currentId())?entry:null;}
  function currentError() {
    return currentFailure()?.message||(lastErrorProject===currentId()&&lastErrorSignature===latestSignature(currentId())?lastError:'');
  }
  function job(action,projectId) {
    if(projectId)pendingProjects.set(projectId,(pendingProjects.get(projectId)||0)+1);
    const promise=tail.then(action);
    jobs.add(promise);tail=promise.catch(error=>{if(!projectId)fail(error);});
    promise.finally(()=>{jobs.delete(promise);if(projectId)pendingProjects.set(projectId,Math.max(0,(pendingProjects.get(projectId)||0)-1));render();}).catch(()=>{});render();
    return promise;
  }
  async function flushJobs() {
    let pending;
    do { pending = tail; await pending; } while (pending !== tail);
  }
  async function withLock(action) {
    if(!navigator.locks)throw Error('当前浏览器不支持保存锁，请使用新版 Edge 或 Chrome。');
    return navigator.locks.request('canvas-save-guard:persist',action);
  }
  async function fetchBlob(url) {
    if(!/^(blob:|data:|https?:)/.test(url))throw Error('无效媒体地址');
    const response=await fetch(url);
    if(!response.ok)throw Error(`读取图片失败：HTTP ${response.status}`);
    const blob=await response.blob();if(!blob.size)throw Error('图片文件为空');return blob;
  }
  async function readBlob(key) {
    const protectedBlob=await vault.get('media',key);
    if(protectedBlob)return protectedBlob;
    const getter=key.startsWith('image:')?services.getImageBlob:services.getMediaBlob;
    const blob=getter?await getter(key):null;
    return blob;
  }
  function rememberMediaUrl(key, url) {
    if (typeof url !== 'string' || !url.startsWith('blob:')) return;
    urls.set(key, url);
    sessionUrls.set(url, key);
  }
  async function validateMedia(blob,key,{cache=true}={}) {
    if(cache&&validatedMedia.has(key))return;
    if(!blob?.size)throw Error('媒体文件为空');
    if(!key.startsWith('image:')){if(cache)validatedMedia.add(key);return;}
    const image=new Image(),url=URL.createObjectURL(blob);
    try {image.src=url;await image.decode();if(!image.naturalWidth||!image.naturalHeight)throw Error('empty image');if(cache)validatedMedia.add(key);}
    catch{throw Error(`图片文件无法正常解码：${key}`);}
    finally{image.src='';URL.revokeObjectURL(url);}
  }
  async function saveProject(project, force = false, observedAt = Date.now()) {
    const snapshotSignature=projectSignature(project);
    if(latestSignature(project.id)!==snapshotSignature)return;
    const persistentProject=project;
    const storedKeys=new Set(await vault.keys('media'));
    const files=new Map(),missing=[];
    for(const [key,sources] of collectMedia(persistentProject)) {
      if(!force&&storedKeys.has(key)&&validatedMedia.has(key))continue;
      let blob=await readBlob(key);
      if(!blob)for(const source of sources){try{blob=await fetchBlob(source);if(blob)break;}catch{}}
      if(blob?.size){try{if(force)validatedMedia.delete(key);await validateMedia(blob,key);if(!storedKeys.has(key))files.set(key,blob);}catch{missing.push({key,reason:'图片无法解码'});}}else missing.push(key);
    }
    if(latestSignature(project.id)!==snapshotSignature)return;
    const owners = nodeMediaOwners(project, observedAt, [...urls].map(([key,url]) => [url,key])).filter(owner => !recordedMediaOwners.has(JSON.stringify([owner.projectId,owner.nodeId,owner.imageId||null,owner.key])));
    await vault.protect([persistentProject],files,owners);
    for (const owner of owners) recordedMediaOwners.add(JSON.stringify([owner.projectId,owner.nodeId,owner.imageId||null,owner.key]));
    if(latestSignature(project.id)!==snapshotSignature)return;
    if(missing.length)throw Object.assign(Error(`本地保护未完成：${missing.length} 个媒体文件无法读取。`),{details:missingMediaDetails(project,missing)});
    protectionErrors.delete(project.id);
    protectedSnapshots.set(project.id,{signature:snapshotSignature,at:new Date().toLocaleTimeString('zh-CN',{hour12:false})});
    if(lastErrorProject===project.id){lastError='';details=[];}
  }
  function protectProject(project, force = false) {
    const queued=queuedProtection.get(project.id);
    if(queued){queued.project=project;queued.force ||= force;queued.observedAt=Date.now();return queued.promise;}
    const entry={project,force,observedAt:Date.now(),promise:null};
    queuedProtection.set(project.id,entry);
    entry.promise=job(async()=>{
      queuedProtection.delete(project.id);
      const snapshotSignature=projectSignature(entry.project),snapshot=JSON.parse(snapshotSignature);
      projectSignatures.set(snapshot,snapshotSignature);
      try {await withMediaAccess(()=>saveProject(snapshot,entry.force,entry.observedAt));}
      catch(error){
        if(latestSignature(snapshot.id)===snapshotSignature)protectionErrors.set(snapshot.id,{signature:snapshotSignature,message:error.message,details:error.details||[]});
        throw error;
      }
    },project.id);
    return entry.promise;
  }
  async function recheckCurrent() {
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const project=currentProject();notice='';lastError='';details=[];protectionErrors.delete(project.id);
    await protectProject(project,true);render();
  }
  function attachStore(store) {
    if(canvasStore===store)return;
    canvasStore=store;
    // Wrap the native action itself, including calls from the canvas menu and
    // home-page multi-delete. Updating the action avoids a pre-hydration write.
    const nativeDelete = store.getState().deleteProjects;
    if (nativeDelete) store.getState().deleteProjects = function(ids) {
      const removing = new Set(ids);
      guard.recordDeletedProjects(store.getState().projects.filter(project => removing.has(project.id)));
      return nativeDelete.apply(this, arguments);
    };
    const observe=state=>{
      const next=new Map(state.projects.map(p=>[p.id,projectSignature(p)]));
      for(const p of state.projects)if(previous.get(p.id)!==next.get(p.id)) {
        deleted.delete(p.id);
        notice='';
        const objects = projectObjectIds(p), priorObjects = observedObjects.get(p.id);
        const restored = new Set([...objects].filter(id => !priorObjects?.has(id)));
        observedObjects.set(p.id,objects);
        if (restored.size) {
          const observedAt = Date.now();
          job(() => withMediaAccess(() => vault.cancelRestoredDeletedObjects(p.id,restored,observedAt))).then(cancelled => { if(cancelled)guard.scheduleDeletedCleanup?.(p.id); }).catch(() => {});
        }
        protectProject(p).catch(()=>{});
      }
      for(const id of previous.keys())if(!next.has(id)) {
        protectionErrors.delete(id);protectedSnapshots.delete(id);
        deleted.add(id);
        job(async()=>{if((await vault.get('deleted',id))?.source!=='user-delete-project')await vault.put('deleted',id,{id,at:new Date().toISOString()});}).catch(()=>{});
      }
      previous=next;render();
    };
    store.subscribe(observe);observe(store.getState());
  }
  function wrapStorage(storage) {
    if(storage.__canvasGuard)return storage;
    const get=storage.getItem.bind(storage),set=storage.setItem.bind(storage);
    rawStorage={get,set};
    storage.getItem=async key=>{
      const raw=await get(key);if(key!==STORE_KEY)return raw;
      const data=raw?JSON.parse(raw):{state:{projects:[]},version:0};
      const [protectedProjects,tombstones,deletions] = await Promise.all([
        vault.all('projects'),vault.all('deleted'),vault.all('cleanup_candidates'),
      ]);
      // A new/imported canvas may already exist while the initial disk read is
      // pending. Protect those live changes even if their backup is queued.
      const loadingState = canvasStore?.getState();
      const loadingProjects = canvasStore?.persist?.hasHydrated() ? [] : loadingState?.projects || [];
      data.state.projects=newerProjects(data.state.projects||[],[...protectedProjects,...loadingProjects],
        [...tombstones,...data.state.deletedProjects||[],...loadingState?.deletedProjects||[]])
        .filter(project => !deleted.has(project.id))
        .map(project => reconcileRecordedDeletions(project,deletions));
      baseline=new Map(data.state.projects.map(p=>[p.id,projectSignature(p)]));
      return JSON.stringify(data);
    };
    storage.setItem=(key,value)=>withMediaAccess(async()=>{
      if(key!==STORE_KEY)return set(key,value);
      const incoming=JSON.parse(value);
      const incomingSignatures=new Map(incoming.state.projects.map(p=>[p.id,projectSignature(p)]));
      const changed=incoming.state.projects.filter(p=>baseline.get(p.id)!==incomingSignatures.get(p.id));
      baseline=incomingSignatures;
      return withLock(async()=>{
        const raw=await get(key),disk=raw?JSON.parse(raw):{state:{projects:[]},version:0};
        const protectedProjects=await vault.all('projects'),tombstones=await vault.all('deleted');
        const merged=newerProjects(disk.state.projects||[],protectedProjects,[...tombstones,...disk.state.deletedProjects||[],...incoming.state.deletedProjects||[]]);
        disk.state={...disk.state,...incoming.state,projects:mergeProjects(merged,changed,deleted)};
        await set(key,JSON.stringify(disk));
      }).catch(error=>{fail(error);throw error;});
    });
    storage.__canvasGuard=true;return storage;
  }
  function wrapMedia(exports,image) {
    const getName=image?'getImageBlob':'getMediaBlob',setName=image?'setImageBlob':'setMediaBlob',uploadName=image?'uploadImage':'uploadMediaFile',resolveName=image?'resolveImageUrl':'resolveMediaUrl';
    for(const name of [getName,setName,image?'deleteStoredImages':'deleteStoredMedia'])if(exports[name])services[name] ||= exports[name];
    const get=exports[getName],set=exports[setName],upload=exports[uploadName];
    if(!get||!set)return exports;
    const result={...exports};
    result[getName]=async key=>{
      const existing=await get(key);if(existing)return existing;
      const backup=await vault.get('media',key);
      if(backup){
        rememberMediaUrl(key,await set(key,backup));
        const preview=image&&exports.previewUrlFor?.(key);
        if(preview)sessionUrls.set(preview,key);
      }
      return backup;
    };
    result[setName]=(key,blob)=>withMediaAccess(async()=>{
      validatedMedia.delete(key);await validateMedia(blob,key);await vault.put('media',key,blob);
      const url=await set(key,blob);
      rememberMediaUrl(key,url);
      const preview=image&&exports.previewUrlFor?.(key);
      if(preview)sessionUrls.set(preview,key);
      return url;
    });
    if(upload)result[uploadName]=(...args)=>withMediaAccess(async()=>{
      const requestOwner = generationOwners.get(args[1]?.signal);
      const owner = requestOwner && { ...requestOwner, imageId: args[1]?.guardImageId || requestOwner.imageId };
      const item=await upload(...args);
      if(item.storageKey && item.url) rememberMediaUrl(item.storageKey,item.url);
      const preview=image&&exports.previewUrlFor?.(item.storageKey);
      if(preview)sessionUrls.set(preview,item.storageKey);
      if(item.storageKey){const blob=await get(item.storageKey);if(!blob?.size)throw Error('图片入库失败，未标记为保存成功。');await validateMedia(blob,item.storageKey);await vault.put('media',item.storageKey,blob);}
      if (owner && item.storageKey) {
        await vault.recordGeneratedMedia(owner, item.storageKey);
        const node = canvasStore?.getState().projects.find(project => project.id === owner.projectId)?.nodes.find(node => node.id === owner.nodeId);
        if (!node || owner.imageId && !node.metadata?.images?.some(image => image.id === owner.imageId)) guard.scheduleDeletedCleanup?.(owner.projectId);
      }
      return item;
    });
    result[resolveName]=async(key,fallback='')=>{
      if(!key)return fallback;
      if(urls.has(key))return urls.get(key);
      let pending=resolvingUrls.get(key);
      if(!pending){
        pending=(async()=>{
          const blob=await result[getName](key);
          // An upload or backup restore may have supplied the URL while this
          // read was pending. Reuse it before allocating another blob handle.
          if(urls.has(key))return urls.get(key);
          if(!blob)return null;
          const url=URL.createObjectURL(blob);
          rememberMediaUrl(key,url);
          return url;
        })().finally(()=>resolvingUrls.delete(key));
        resolvingUrls.set(key,pending);
      }
      return await pending||fallback;
    };
    if(image){
      for(const name of ['getImageBlob','setImageBlob'])services[name]=result[name];
      if(exports.ensureImagePreview)result.ensureImagePreview=key=>{
        let pending=resolvingPreviews.get(key);
        if(!pending){
          pending=Promise.resolve().then(()=>exports.ensureImagePreview(key)).then(url=>{
            if(url)sessionUrls.set(url,key);
            return url;
          }).finally(()=>resolvingPreviews.delete(key));
          resolvingPreviews.set(key,pending);
        }
        return pending;
      };
      if(exports.previewUrlFor)result.previewUrlFor=key=>{
        const url=exports.previewUrlFor(key);
        if(url)sessionUrls.set(url,key);
        return url;
      };
    }
    // Only recorded native deletions can authorize cache removal.
    result[image?'cleanupUnusedImages':'cleanupUnusedMedia']=async()=>{};
    return result;
  }
  function adaptExports(entries) {
    if(!Array.isArray(entries))return entries;
    const values={};
    for(let i=0;i<entries.length;){const name=entries[i++],kind=entries[i++];if(kind===0)values[name]=entries[i++];else if(typeof entries[i]==='function')i++;}
    let patched={...values};
    if(values.localForageStorage)patched.localForageStorage=wrapStorage(values.localForageStorage);
    if(values.getImageBlob)patched=wrapMedia(patched,true);
    if(values.getMediaBlob)patched=wrapMedia(patched,false);
    if(values.exportCanvasProjects)patched.exportCanvasProjects=exportProjects;
    if(values.useCanvasStore)attachStore(values.useCanvasStore);
    const out=entries.slice();
    for(let i=0;i<out.length;){const name=out[i++],kind=out[i++];if(kind===0){out[i]=patched[name];i++;}else if(typeof out[i]==='function')i++;}
    return out;
  }
  const wrapped=new WeakSet();
  function wrapChunk(chunk) {
    if(!Array.isArray(chunk))return chunk;
    const out=chunk.slice();
    for(let i=1;i<out.length;i++)if(typeof out[i]==='function'&&!wrapped.has(out[i])){
      const original=out[i];
      const factory=function(context,...args){
        const proxy=new Proxy(context,{get(target,key){
          if(key==='s')return (entries,...args)=>target.s(adaptExports(entries),...args);
          return Reflect.get(target,key);
        }});
        return original(proxy,...args);
      };
      wrapped.add(factory);out[i]=factory;
    }
    return out;
  }
  function wrapRuntime(runtime) {
    if(!runtime||typeof runtime.push!=='function'||runtime.__canvasGuard)return runtime;
    if(Array.isArray(runtime))for(let i=0;i<runtime.length;i++)runtime[i]=wrapChunk(runtime[i]);
    const push=runtime.push;
    runtime.push=function(...chunks){return push.apply(this,chunks.map(wrapChunk));};
    Object.defineProperty(runtime,'__canvasGuard',{value:true});return runtime;
  }
  if(location.hostname==='canvas.modelaryx.com'){
    let runtime=wrapRuntime(globalThis.TURBOPACK||[]);
    Object.defineProperty(globalThis,'TURBOPACK',{configurable:true,get:()=>runtime,set:value=>{runtime=wrapRuntime(value);}});
  }

  function currentProject() {
    if(!canvasStore)throw Error('尚未接入画布。请确认网站版本受支持。');
    const id=decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1]||'');
    const project=canvasStore.getState().projects.find(p=>p.id===id);
    if(!project)throw Error('请在具体画布页面使用“保存完整 ZIP”。');
    return project;
  }
  function downloadSelectedImages(nodes) {
    return withArchive(async()=>{
      const title=currentProject().title;
      render('正在读取所选图片的原文件…');
      const prepared=await withMediaAccess(()=>prepareImageDownload(nodes,readBlob,fetchBlob,validateMedia));
      let updatedAt=0;
      const zip=await makeZip(prepared,{filesOnly:true,onProgress:(done,total)=>{
        if(done!==total&&performance.now()-updatedAt<120)return;
        updatedAt=performance.now();render(`正在打包所选图片 ${done} / ${total}`);
      }});
      const url=URL.createObjectURL(zip),anchor=document.createElement('a');
      anchor.href=url;anchor.download=`${safeName(title)}-所选图片.zip`;anchor.click();
      setTimeout(()=>URL.revokeObjectURL(url),60000);
      lastError='';details=[];
      render(`已下载 ${prepared.data.projects[0].files.length} 张所选原图${prepared.skipped?`，跳过 ${prepared.skipped} 个尚无图片文件的选中项`:''}`);
      return true;
    }).catch(error=>{fail(error);return false;});
  }
  async function withArchive(action) {
    if(archiveActive){
      const error=Error('已有 ZIP 操作正在进行，请完成后再操作。');
      error.code='ZIP_BUSY';
      throw error;
    }
    archiveActive=true;
    try {render();return await action();}
    finally {archiveActive=false;render();}
  }
  function exportProjects(projects,fileName) {
    return withArchive(async()=>{
      if(!projects.length)throw Error('没有选中画布。');
      // Let the application's effect publish the latest visible frame before taking an immutable snapshot.
      await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
      await flushJobs();
      const fresh=projects.map(p=>canvasStore?.getState().projects.find(x=>x.id===p.id)||p);
      render('正在核对并准备完整画布备份…');
      const prepared=await withMediaAccess(()=>prepareArchive(fresh,readBlob,fetchBlob,validateMedia));
      let lastProgress=0;
      const progress=label=>(current,total)=>{if(current!==total&&performance.now()-lastProgress<120)return;lastProgress=performance.now();render(`${label} ${current} / ${total}`);};
      const zip=await makeZip(prepared,{onProgress:progress('正在打包媒体')});
      await verifyZip(zip,{retainEntries:false,onProgress:progress('正在校验媒体')});
      const anchor=document.createElement('a');anchor.href=URL.createObjectURL(zip);
      anchor.download=`${safeName(fileName||fresh[0].title)}-完整备份-${new Date().toISOString().replace(/[:.]/g,'-')}.zip`;
      anchor.click();setTimeout(()=>URL.revokeObjectURL(anchor.href),60000);
      lastError='';details=[];render(`已校验并导出 ${prepared.data.projects.flatMap(p=>p.files).length} 个媒体文件`);
      return zip;
    }).catch(error=>{fail(error);throw error;});
  }
  function importArchive(file) {
    return withArchive(async()=>{
      if(!canvasStore)throw Error('尚未接入画布');
      const checked=await verifyZip(file,{retainEntries:false});
      const remap=new Map();
      for(const p of checked.data.projects)for(const f of p.files) {
        if(!remap.has(f.storageKey))remap.set(f.storageKey,`${f.storageKey.split(':')[0]}:guard-${crypto.randomUUID()}`);
        const key=remap.get(f.storageKey),blob=new Blob([await checked.readEntry(f.path)],{type:f.mimeType});
        const setter=key.startsWith('image:')?services.setImageBlob:services.setMediaBlob;
        if(!setter)throw Error('媒体存储服务尚未加载，请先打开一个画布。');
        await validateMedia(blob,key);await vault.put('media',key,blob);await setter(key,blob);
      }
      const translate=(value,nodeType)=>{
        if(typeof value==='string')return remap.get(value)||(value.startsWith('guard-file:')?`guard-file:${remap.get(value.slice(11))||value.slice(11)}`:value);
        if(Array.isArray(value))return value.map(item=>translate(item,nodeType));
        if(value&&typeof value==='object'){
          if(['image','video','audio','text','config'].includes(value.type||value.kind))nodeType=value.type||value.kind;
          return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,isMediaTextField(k,v,nodeType)?v:translate(v,nodeType)]));
        }
        return value;
      };
      let id;
      const importedIds=[];
      for(const p of checked.data.projects){
        id=canvasStore.getState().importProject({...translate(p.project),title:`${p.project.title}（恢复）`});
        importedIds.push(id);
      }
      await flushJobs();
      for(const importedId of importedIds){
        const failure=protectionErrors.get(importedId);
        if(failure?.signature===latestSignature(importedId))throw Object.assign(Error(failure.message),{details:failure.details});
      }
      render(`已恢复 ${checked.projects} 张画布，可在“我的画布”打开`);return id;
    });
  }
  function repairPointer() {
    window.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}));
    window.dispatchEvent(new MouseEvent('mouseup',{bubbles:true}));
    window.dispatchEvent(new KeyboardEvent('keyup',{code:'Space',key:' ',bubbles:true}));
    document.body.style.cursor='';document.body.style.userSelect='';
    render('已结束残留拖动；若右下角挡住图片，请收起重试工具');
  }
  function attachExisting() {
    if(canvasStore)return;
    if(globalThis.CanvasSaveGuardNative){guard.connectSite(globalThis.CanvasSaveGuardNative);return;}
    if(location.hostname==='canvas.best'){
      const supported=[...document.scripts].some(script=>script.src.includes('/assets/index-BcbSchFn.js'));
      render(supported?'请先用网站导出当前画布，再刷新一次，加载新版画布保护接口。':'站点资源已更新，请更新扩展以接入这个版本。');
      return;
    }
    if(!globalThis.TURBOPACK||Array.isArray(globalThis.TURBOPACK))return;
    if(![...document.scripts].some(script=>script.src.includes('/10u8p1p4fll6y.js'))){fail(Error('网站资源版本未匹配，未接入自动保护。'));return;}
    // Public runtime module loading, using IDs verified against the deployed v0.4.0 build. No eval or source rewriting at runtime.
    const id=`canvas-guard-attach-${crypto.randomUUID()}`;
    globalThis.TURBOPACK.push(['static/chunks/canvas-save-guard-attach.js',id,context=>{
      try {
        wrapStorage(context.i(48566).localForageStorage);
        const images=context.i(7065),media=context.i(23241);
        for(const name of ['getImageBlob','setImageBlob','deleteStoredImages'])services[name] ||= images[name];
        for(const name of ['getMediaBlob','setMediaBlob','deleteStoredMedia'])services[name] ||= media[name];
        attachStore(context.i(83629).useCanvasStore);
      }catch(error){fail(Error('网站版本未匹配，未启用自动保护。'+error.message));}
    }]);
    globalThis.TURBOPACK.push(['static/chunks/canvas-save-guard-attach.js',{otherChunks:[],runtimeModuleIds:[id]}]);
  }
  function mount() {
    if(ui||!document.body)return;
    const host=document.createElement('aside');host.id='canvas-save-guard';
    host.dataset.canvasShortcutsIgnore='';
    host.style.cssText='position:fixed;right:16px;bottom:18px;z-index:2147483647;max-width:350px;pointer-events:none';
    const shadow=host.attachShadow({mode:'open'});
    shadow.innerHTML=`<style>:host{font:13px/1.5 system-ui,sans-serif;color-scheme:light dark}section{pointer-events:auto;background:light-dark(#fff,#24262b);color:light-dark(#252831,#f2f3f5);border:1px solid #7f87914d;border-radius:12px;padding:10px 12px;box-shadow:0 4px 24px #0002;width:310px;box-sizing:border-box}header{display:flex;align-items:center;justify-content:space-between;gap:12px}strong{font-size:13px}button{font:inherit;cursor:pointer;border:1px solid #7f879160;border-radius:7px;padding:5px 8px;background:transparent;color:inherit}button:hover{background:#7f879118}button:disabled{opacity:.5;cursor:wait}.buttons{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}#status{font-size:12px;margin-top:5px;word-break:break-word}#detail{white-space:pre-wrap;max-height:160px;overflow:auto;word-break:break-all;font-size:11px;margin:8px 0 0}small{display:block;color:light-dark(#646c79,#b4bbc6);font-size:11px;margin-top:7px}.bad{color:light-dark(#b52525,#ffb2ac)}section.closed{width:auto}.closed .body{display:none}#fold{padding:0 6px;border:0}</style><section><header><strong>画布保存保护</strong><button id="fold" aria-label="收起保存工具">收起</button></header><div class="body"><div id="status">正在接入画布…</div><div class="buttons"><button id="save">保存完整 ZIP</button><button id="check">检查 ZIP</button><button id="restore">恢复 ZIP</button><button id="pointer">恢复鼠标</button><button id="retry">收起重试工具</button></div><small id="compat"></small><pre id="detail" hidden></pre></div></section>`;
    shadow.querySelector('strong').textContent=`画布助手 · ${BUILD_VERSION}`;
    document.body.append(host);ui=shadow;
    shadow.querySelector('#fold').onclick=()=>{const closed=shadow.querySelector('section').classList.toggle('closed');shadow.querySelector('#fold').textContent=closed?'展开':'收起';};
    const run=action=>async()=>{if(locked)return;locked=true;render('正在处理…');try{await action();}catch(e){fail(e);}finally{locked=false;render();}};
    const recheck=document.createElement('button');recheck.id='recheck';recheck.textContent='重新检查';shadow.querySelector('.buttons').prepend(recheck);
    recheck.onclick=run(()=>guard.recheckCurrent());
    const cleanup = document.createElement('button');
    cleanup.id = 'cleanup';
    cleanup.textContent = '清理删除缓存';
    cleanup.title = '删除项保留一分钟供 Ctrl＋Z 撤销，期满后只清理无人引用的对应缓存。';
    shadow.querySelector('.buttons').append(cleanup);
    cleanup.onclick = run(async () => {
      await guard.cleanupDeleted();
      lastError='';details=[];
      notice='';render();
    });
    shadow.querySelector('#save').onclick=run(()=>guard.exportCurrent());
    function choose(action){const input=document.createElement('input');input.type='file';input.accept='.zip,application/zip';input.onchange=()=>{if(input.files[0])run(()=>action(input.files[0]))();};input.click();}
    shadow.querySelector('#check').onclick=()=>choose(file=>withArchive(async()=>{const result=await verifyZip(file,{retainEntries:false});lastError='';details=[];render(`检查通过：${result.projects} 张画布，${result.files} 个文件${result.hashed?'，SHA-256 校验通过':'（旧包无文件校验值）'}`);}));
    shadow.querySelector('#restore').onclick=()=>choose(importArchive);
    shadow.querySelector('#pointer').onclick=repairPointer;
    shadow.querySelector('#retry').onclick=()=>{const panel=document.querySelector('#local-canvas-retry-panel');if(!panel){render('当前页面没有批量重试工具');return;}const hidden=panel.style.display!=='none';panel.style.display=hidden?'none':'';shadow.querySelector('#retry').textContent=hidden?'显示重试工具':'收起重试工具';};
    installCleanupProgress(guard, document);
    installMediaReport(guard, document, currentProject, () => [...sessionUrls]);
    installGridSnapControl(guard, document);
    installDescendantControl(guard, document);
    installPanelLayout(document);
    installNativeCompatibility(guard,document,BUILD_VERSION);
    render();attachExisting();
  }
  let notice='';
  function render(message) {
    if(message)notice=message;
    if(!ui)return;
    const status=ui.querySelector('#status');
    const error=currentError();
    status.className=error?'bad':'';
    status.textContent=error|| (currentPending()?`正在保护当前画布的 ${currentPending()} 项更新，请等待完成`:(notice||(currentProtection()?`已保护 · ${currentProtection().at}`:'正在读取当前画布…')));
    const currentDetails=currentFailure()?.details||(lastErrorProject===currentId()?details:[]);
    ui.querySelector('#detail').hidden=!currentDetails.length;ui.querySelector('#detail').textContent=currentDetails.join('\n');
    ui.querySelector('#compat').textContent='图片入库后自动保护。删除项保留一分钟，可 Ctrl＋Z 撤销；期满后清理无人引用的对应缓存。';
    for(const button of ui.querySelectorAll('#save,#restore,#recheck,#cleanup'))button.disabled=locked||!canvasStore;
    for(const button of ui.querySelectorAll('#save,#restore'))button.disabled ||= archiveActive;
    ui.querySelector('#check').disabled=locked||archiveActive;
  }
  window.addEventListener('beforeunload',event=>{if(locked||archiveActive||currentPending()||pendingProjectDeletionWrites||currentError()){event.preventDefault();event.returnValue='';}});
  installDeletedCleanup({
    guard,
    getStore: () => canvasStore,
    getServices: () => services,
    flush: flushJobs,
    getDeletedObjects: projectId => vault.deletedObjects(projectId, canvasStore?.getState().projects || [], canvasStore?.getState().deletedProjects || []),
    getKnownMediaUrls: () => [...sessionUrls],
    fetchBlob,
    releaseSessionMedia: (retained, candidates) => {
      for (const key of candidates) if (!retained.has(key)) {
        urls.delete(key);
        validatedMedia.delete(key);
      }
      for (const [url,key] of sessionUrls) if(candidates.has(key)&&!retained.has(key)) {
        URL.revokeObjectURL(url);sessionUrls.delete(url);
      }
      return { files: 0, bytes: 0 };
    },
  });
  installAutomaticDeletedCleanup(guard);
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
}
