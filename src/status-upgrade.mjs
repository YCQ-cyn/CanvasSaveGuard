import { missingMediaDetails } from './media-locations.mjs';
export const BUILD_VERSION='1.0.43';

// Older pages keep their existing writer and vault. Recheck the latest project
// through that writer rather than clearing a warning without verifying its bytes.
export function installLegacyRecheck(guard,doc) {
  if(guard.recheckCurrent||guard.statusPatchVersion===BUILD_VERSION)return;
  guard.statusPatchVersion=BUILD_VERSION;
  const shadow=doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if(!shadow)return;
  const buttons=shadow.querySelector('.buttons');
  if(!buttons)return;
  const button=doc.createElement('button');button.id='recheck';button.textContent='重新检查';buttons.prepend(button);
  button.onclick=async()=>{
    button.disabled=true;
    try {
      const store=await new Promise((resolve,reject)=>{
        if(globalThis.CanvasSaveGuardNative)return resolve(globalThis.CanvasSaveGuardNative.store);
        if(![...doc.scripts].some(s=>s.src.includes('/10u8p1p4fll6y.js')))return reject(Error('网站资源版本未匹配，无法重新检查。'));
        const id=`canvas-guard-recheck-${crypto.randomUUID()}`;
        globalThis.TURBOPACK.push(['static/chunks/canvas-save-guard-recheck.js',id,context=>{
          try{resolve(context.i(83629).useCanvasStore);}catch(error){reject(error);}
        }]);
        globalThis.TURBOPACK.push(['static/chunks/canvas-save-guard-recheck.js',{otherChunks:[],runtimeModuleIds:[id]}]);
      });
      const id=decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1]||'');
      const project=store.getState().projects.find(p=>p.id===id);
      if(!project)throw Error('请先打开具体画布。');
      store.getState().updateProject(id,{nodes:project.nodes});
      try{await guard.flush();}catch(error){
        const detail=shadow.querySelector('#detail');
        const keys=(detail?.textContent||'').split('\n').map(s=>s.trim()).filter(s=>/^(image|video|audio|file|video-reference|audio-reference):/.test(s));
        if(detail&&keys.length){detail.textContent=missingMediaDetails(store.getState().projects.find(p=>p.id===id),keys).join('\n');detail.hidden=false;}
        throw error;
      }
    }catch(error){
      const status=shadow.querySelector('#status');if(status){status.textContent=error.message;status.className='bad';}
    }finally{button.disabled=false;}
  };
  // Apply once on update: re-evaluate the deleted image's warning without a page reload.
  button.click();
}
