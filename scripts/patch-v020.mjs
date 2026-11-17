import { createHash } from 'node:crypto';
import { batchImagePosition, batchConnectionPath, createBatchInteraction, legacyBatchRoot, legacyBatchMembers, dragNodeMembers, removeBatchImage, pruneLegacyBatchNodes, animateBatchCard, batchPanelTop, batchIntersectsViewport, canvasNodeIndex, isExpandableImageGroup, isImageGroupExpanded, selectionLayoutState, selectedLayoutRoots, selectedLayoutUnits, arrangeSelectedNodes, selectedDownloadNodes } from '../src/batch-layout.mjs';
import { retryRegionIntersects } from '../src/retry-region.mjs';
import { layoutTrackCenters, alignedSelectionPositions, compactSelectionPositions, snapGridPoint, snapGridOffset, selectionToolbarPosition } from '../src/selection-layout.mjs';
import { createBatchComponents } from '../src/batch-components.mjs';
import { BATCH_VISUAL_VERSION } from '../src/native-compatibility.mjs';
import { BUILD_VERSION } from '../src/status-upgrade.mjs';
import { copyImageNode } from '../src/batch-clipboard.mjs';
import { useSidebarWindow } from '../src/sidebar-window.mjs';
import { commitCanvasHistory, retainedCanvasHistory } from '../src/history-commit.mjs';
import { DELETION_GRACE_MS } from '../src/deletion-grace.mjs';
import { materializeBatchImage, synchronizeBatchGraph, batchMediaDescriptor, batchMediaEqual, copyBatchMedia } from '../src/batch-graph.mjs';

export function patchV020(original, createRetryBridge) {
  const hash = createHash('sha256').update(original).digest('hex');
  if (hash !== 'd945e49e52ee3a8636b3ee9f2ede5f7b851dbb8fcf665d08a24f91fd70f6ceeb') {
    throw Error('v0.20.0 站点资源与已核对版本不一致。');
  }
  let source = original;
  function replace(from, to) {
    if (source.split(from).length !== 2) throw Error(`v0.20.0 补丁定位失败 ${from.slice(0, 100)}`);
    source = source.replace(from, to);
  }
  replace('clt={getItem:async e=>{const t=await zg.getItem(e)',
    'clt={getItem:async e=>{globalThis.CanvasSaveGuard?.connectStorage(zg);const t=await zg.getItem(e)');
  replace('[Z,G]=f.useState([]),[ee,re]=f.useState([])',
    '[Z,guardSetNodes]=f.useState([]),G=f.useCallback(update=>guardSetNodes(previous=>synchronizeBatchGraph(previous,typeof update==="function"?update(previous):update)),[]),[ee,re]=f.useState([])');
  replace('is=f.useCallback((K,de,ce)=>{const ge=lo(K,de),_e=',
    'is=f.useCallback((K,de,ce,commit=false)=>{const world=lo(K,de),child=globalThis.CanvasSaveGuardBatch?.resolveConnectionTarget(world,ce,commit);if(child)return child;const ge=world,_e=');
  replace('const ce=is(K.clientX,K.clientY,de);ce.nodeId?',
    'const ce=is(K.clientX,K.clientY,de,true);ce.nodeId?');
  replace('function lL(e,t,n,r){const o=n.find',
    'function lL(e,t,n,r){const source=canvasNodeIndex(n).get(e);if(r==="target"&&source&&legacyBatchRoot(source,n))return lL(t,e,n,"source");const o=n.find');
  replace('p.jsx(qjt,{nodes:Z,selectedNodeIds:Ae',
    'p.jsx(CanvasGuardSidePanel,{nodes:Z,selectedNodeIds:Ae');
  replace('},[v,N,e]),P=()=>',
    '},[v,N,e]),guardWindow=useSidebarWindow(f,T==="grid"?N:$,T,JSON.stringify([l,u])),P=()=>');
  replace('className:"min-h-0 flex-1 overflow-y-auto px-2 pb-3",children:T==="grid"?',
    'className:"min-h-0 flex-1 overflow-y-auto px-2 pb-3",ref:guardWindow.ref,onScroll:guardWindow.onScroll,"data-guard-node-list":true,children:T==="grid"?');
  replace('className:"grid gap-2 px-1 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]",children:N.map(',
    'className:"grid gap-2 px-1 [grid-template-columns:repeat(auto-fill,minmax(88px,1fr))]",style:guardWindow.style,children:guardWindow.items.map(');
  replace('className:"space-y-1.5",children:$.map(({node:',
    'className:"space-y-1.5",style:guardWindow.style,children:guardWindow.items.map(({node:');
  replace('const Tst=Object.freeze', `{
    const patched = globalThis.CanvasSaveGuard?.connectMedia({
      getImageBlob:sp,setImageBlob:SR,uploadImage:go,resolveImageUrl:Vc,
      deleteStoredImages:aH,cleanupUnusedImages:fye,ensureImagePreview:_m,previewUrlFor:Pu
    },true);
    if(patched){sp=patched.getImageBlob;SR=patched.setImageBlob;go=patched.uploadImage;
      Vc=patched.resolveImageUrl;fye=patched.cleanupUnusedImages;
      _m=patched.ensureImagePreview;Pu=patched.previewUrlFor;}
  }const Tst=Object.freeze`);
  replace('function E6(e,t=new Set)', `{
    const patched = globalThis.CanvasSaveGuard?.connectMedia({
      getMediaBlob:A0,setMediaBlob:yH,uploadMediaFile:hm,resolveMediaUrl:xO,
      deleteStoredMedia:hlt,cleanupUnusedMedia:mlt
    },false);
    if(patched){A0=patched.getMediaBlob;yH=patched.setMediaBlob;hm=patched.uploadMediaFile;
      xO=patched.resolveMediaUrl;mlt=patched.cleanupUnusedMedia;}
  }function E6(e,t=new Set)`);
  replace('Oee=Oee.then(async()=>{const t=await sp(e);t&&await iH(e,t)})',
    'Oee=Oee.then(()=>{const build=async()=>{const t=await sp(e);return t?iH(e,t):void 0};return globalThis.CanvasSaveGuard?globalThis.CanvasSaveGuard.withMediaAccess(build):build()})');
  replace('return n.blob?dye(e,n.blob):void 0;Ost(e)}function Ost(e){Oee=',
    'return n.blob?dye(e,n.blob):void 0;return Ost(e)}function Ost(e){return Oee=');
  replace('const de=new Set(K);G(ce=>ce.filter(_e=>!de.has(_e.id))',
    'globalThis.CanvasSaveGuardHistory?.commitPending(true);const de=legacyBatchMembers(new Set(K),zn.current);const removed=zn.current.filter(node=>de.has(node.id));const inline=removed.flatMap(node=>{const root=legacyBatchRoot(node,zn.current),image=root?.metadata?.images?.find(image=>image.id===node.metadata?.guardBatchImageId);return image?[{nodeId:root.id,image}]:[]});globalThis.CanvasSaveGuard?.recordDeletedObjects(a,removed,xr.current.filter(link=>de.has(link.fromNodeId)||de.has(link.toNodeId)),inline);G(ce=>pruneLegacyBatchNodes(ce,de)');
  replace('bv=f.useCallback(K=>{re(de=>de.filter(ce=>ce.id!==K))',
    'bv=f.useCallback(K=>{globalThis.CanvasSaveGuardHistory?.commitPending(true);globalThis.CanvasSaveGuard?.recordDeletedObjects(a,[],xr.current.filter(link=>link.id===K));re(de=>de.filter(ce=>ce.id!==K))');
  replace('xv=f.useCallback((K,de)=>{re(ce=>ce.filter(ge=>ge.fromNodeId!==K||ge.toNodeId!==de))',
    'xv=f.useCallback((K,de)=>{globalThis.CanvasSaveGuardHistory?.commitPending(true);globalThis.CanvasSaveGuard?.recordDeletedObjects(a,[],xr.current.filter(link=>link.fromNodeId===K&&link.toNodeId===de));re(ce=>ce.filter(ge=>ge.fromNodeId!==K||ge.toNodeId!==de))');
  replace('oE=f.useCallback(()=>{G([]),re([])',
    'oE=f.useCallback(()=>{globalThis.CanvasSaveGuardHistory?.commitPending(true);globalThis.CanvasSaveGuard?.recordDeletedObjects(a,zn.current,xr.current);G([]),re([])');
  replace('...O.current.past.slice(-49)', '...retainedCanvasHistory(O.current.past,49)');
  replace('Vu=f.useCallback(()=>{const K=O.current.past.pop()',
    'Vu=f.useCallback(()=>{globalThis.CanvasSaveGuardHistory?.commitPending();const K=O.current.past.pop()');
  replace('eu=f.useCallback(()=>{const K=O.current.future.pop(),de=T.current;!K||!de||(O.current.past.push(de),Sp(K))},[Sp])',
    'eu=f.useCallback(()=>{globalThis.CanvasSaveGuardHistory?.commitPending();const K=O.current.future.pop(),de=T.current;!K||!de||(globalThis.CanvasSaveGuard?.recordHistoryRedo(a,de,K),O.current.past.push(de),Sp(K))},[Sp,a])');
  replace('const z=!L?.closest("[data-node-id],[data-connection-id]"),_=R.ctrlKey||v?',
    'const z=!L?.closest("[data-node-id],[data-connection-id]"),_=R.shiftKey?"select":R.ctrlKey||v?');

  replace('if(G?.onDoubleClick&&ee){G.onDoubleClick(ee)&&Me.stopPropagation();return}if(t.type===De.Image&&Ce)',
    'if(t.type===De.Image&&Ae&&!Me.target.closest("button")){Me.stopPropagation();R?.(t.id);return}if(G?.onDoubleClick&&ee){G.onDoubleClick(ee)&&Me.stopPropagation();return}if(t.type===De.Image&&Ce)');
  replace('onMouseDownCapture:Me=>{l||O?.(Me,t.id)}',
    'onMouseDownCapture:Me=>{l||Me.target.closest("[data-guard-batch-image],[data-guard-batch-port]")||O?.(Me,t.id)},onDoubleClickCapture:Me=>{if(!l&&t.type===De.Image&&Ae&&!Me.target.closest("[data-guard-batch-image],[data-guard-batch-port],button,input,textarea,select,[contenteditable=true]")){Me.preventDefault();Me.stopPropagation();R?.(t.id)}}');
  replace('Tp=f.useCallback(K=>{Rt(de=>{const ce=new Set(de);return ce.has(K)?ce.delete(K):ce.add(K),ce})},[])',
    'Tp=f.useCallback(K=>{const node=zn.current.find(item=>item.id===K);const expanded=node?.type===De.Image?node.metadata?.isBatchRoot?!node.metadata.imageBatchExpanded:node.metadata?.imageBatchExpanded===false:!Ue.has(K);G(nodes=>nodes.map(node=>node.id===K&&node.type===De.Image?{...node,metadata:{...node.metadata,imageBatchExpanded:expanded}}:node));Rt(de=>{const ce=new Set(de);return expanded?ce.add(K):ce.delete(K),ce})},[Ue])');
  replace('t?h.filter(T=>T.id!==x).map((T,E)=>p.jsx(xjt,{node:e,image:T,index:E,scale:n,onView:()=>c?.(T.id),onSetPrimary:()=>o?.(T.id),onDuplicate:()=>i?.(T.id),onDownload:()=>s?.(T.id),onRetry:()=>a?.(T.id),onDelete:()=>l?.(T.id)},T.id)):null',
    'p.jsx(CanvasGuardBatchResults,{node:e,expanded:t,scale:n,onView:c,onSetPrimary:o,onDuplicate:i,onDownload:s,onRetry:a,onDelete:l})');
  replace('be=t.type===De.Image?t.metadata?.images?.length||0:t.type===De.Text&&t.metadata?.texts?.length||0,Ae=be>1',
    'be=t.type===De.Image?t.metadata?.images?.length||(t.metadata?.isBatchRoot?t.metadata?.batchChildIds?.length||0:0):t.type===De.Text&&t.metadata?.texts?.length||0,Ae=be>1||t.type===De.Image&&be>0&&(t.metadata?.isBatchRoot||t.metadata?.batchDisplayRoot)');
  replace('h=e.metadata?.images||[],g=h.length,b=g>1,x=e.metadata?.primaryImageId',
    'h=e.metadata?.images||[],g=h.length||(e.metadata?.isBatchRoot?e.metadata.batchChildIds?.length||0:0),b=g>1||g>0&&(e.metadata?.isBatchRoot||e.metadata?.batchDisplayRoot),x=e.metadata?.primaryImageId');
  replace('batchExpanded:Ue.has(K.id),showImageInfo:Nt',
    'batchExpanded:K.type===De.Image&&(K.metadata?.images?.length>1||K.metadata?.isBatchRoot||K.metadata?.batchDisplayRoot)?K.metadata?.isBatchRoot?!!K.metadata?.imageBatchExpanded:K.metadata?.imageBatchExpanded!==false:Ue.has(K.id),showImageInfo:Nt');
  replace('H0.map(K=>p.jsx(ljt,{data:K,scale:ie.k',
    'H0.map(K=>p.jsx(CanvasGuardNode,{data:K,guardParent:Do.get(K.metadata?.batchRootId),scale:ie.k');
  replace('H0=f.useMemo(()=>Z.filter(K=>K.position.x+K.width>ws.left&&K.position.x<ws.right&&K.position.y+K.height>ws.top&&K.position.y<ws.bottom),[Z,ws])',
    'H0=f.useMemo(()=>Z.filter(K=>batchIntersectsViewport(K,ws)),[Z,ws])');
  replace('const i=t.find(s=>s.id===e);return i&&cH(i)?[i]:[]',
    'const i=canvasNodeIndex(t).get(e);return i&&cH(i)?[i]:[]');
  replace('if(!de||!ce)return[];const ge=de.position.x+de.width',
    'if(!de||!ce)return[];const guardFromRoot=legacyBatchRoot(de,Z),guardToRoot=legacyBatchRoot(ce,Z);if(guardFromRoot&&!guardFromRoot.metadata.imageBatchExpanded||guardToRoot&&!guardToRoot.metadata.imageBatchExpanded)return[];const ge=de.position.x+de.width');
  replace('const _e=new Set(ge);ce.forEach(jt=>{ge.has(jt.id)',
    'const _e=dragNodeMembers(new Set(ge),ce,xr.current,!!globalThis.CanvasSaveGuard?.getMoveDescendants?.());ce.forEach(jt=>{ge.has(jt.id)');
  replace('A.current={isDraggingNode:!0,hasMoved:!1,startX:K.clientX',
    'A.current={guardClickedNodeId:de,isDraggingNode:!0,hasMoved:!1,startX:K.clientX');
  replace('const ce=!A.current.hasMoved&&A.current.initialSelectedNodes.size===1,ge=A.current.initialSelectedNodes.keys().next().value',
    'const ce=!A.current.hasMoved&&Co.current.size===1,ge=A.current.guardClickedNodeId||A.current.initialSelectedNodes.keys().next().value');
  replace('mn=A.current.movedIds;if(P.current=!1',
    'mn=A.current.movedIds,guardDelta=globalThis.CanvasSaveGuardBatch?.snapOffset(Tt,A.current.guardClickedNodeId,ct,jt,A.current.guardSnapBypass)||{x:ct,y:jt};if(P.current=!1');
  replace('position:{x:Jn.x+ct,y:Jn.y+jt}', 'position:{x:Jn.x+guardDelta.x,y:Jn.y+guardDelta.y}');
  replace('ct=A.current.movedIds;(Math.abs(K.clientX',
    'ct=A.current.movedIds,guardDelta=globalThis.CanvasSaveGuardBatch?.snapOffset(_e,A.current.guardClickedNodeId,ce,ge,(A.current.guardSnapBypass=K.altKey)||!A.current.hasMoved&&Math.abs(ce*de.k)<=3&&Math.abs(ge*de.k)<=3)||{x:ce,y:ge};(Math.abs(K.clientX');
  replace('position:{x:mn.x+ce,y:mn.y+ge}', 'position:{x:mn.x+guardDelta.x,y:mn.y+guardDelta.y}');
  replace('position:{x:en.x+ce,y:en.y+ge}', 'position:{x:en.x+guardDelta.x,y:en.y+guardDelta.y}');
  replace('style:{transform:`translateX(-50%) scale(${1/n})`,transformOrigin:"top center"},"data-node-panel":t.id',
    'style:{top:globalThis.CanvasSaveGuardBatch?.panelTop(t,S),transform:`translateX(-50%) scale(${1/n})`,transformOrigin:"top center"},"data-node-panel":t.id');
  replace('vv=f.useCallback(()=>{const K=Co.current;if(!K.size)return;',
    'vv=f.useCallback(()=>{if(globalThis.CanvasSaveGuardBatch?.copySelection())return;const K=Co.current;if(!K.size)return;');
  replace('ge={...de,id:ce,title:`${de.title} Copy`,position:{x:de.position.x+36,y:de.position.y+36}},_e=xr.current.filter(ct=>ct.toNodeId===K)',
    'ge={...(globalThis.CanvasSaveGuardBatch?.contextCopyTarget(K)||copyImageNode(de)),id:ce,title:`${de.title} Copy`,position:{x:de.position.x+36,y:de.position.y+36}},_e=xr.current.filter(ct=>ct.toNodeId===K&&!legacyBatchRoot(de,zn.current))');
  replace('Fe.type==="node"?xp(new Set([Fe.nodeId])):bv(Fe.connectionId)',
    'Fe.type==="node"?(globalThis.CanvasSaveGuardBatch?.deleteContextImage(Fe.nodeId)||xp(new Set([Fe.nodeId]))):bv(Fe.connectionId)');
  replace('onDelete:()=>xp(new Set(Ae))',
    'onDelete:()=>{globalThis.CanvasSaveGuardBatch?.deleteSelection()||xp(new Set(Ae))}');
  replace('p.jsx(jjt,{selectedCount:Ae.size',
    'p.jsx(CanvasGuardToolbar,{selectedCount:Ae.size,guardViewport:ie,guardSelection:Ae,guardNodes:Z');
  replace('function jjt({selectedCount:e,',
    'function jjt({selectedCount:e,guardNativeSelectedCount=e,');
  replace('id:"tool-focus",label:$("canvas.toolbar.focus"),disabled:!e',
    'id:"tool-focus",label:$("canvas.toolbar.focus"),disabled:!guardNativeSelectedCount');
  replace('style:{left:u+h/2,top:d-8},onMouseDown:',
    '"data-guard-native-selection-toolbar":true,style:{left:u+h/2,top:d-8},onMouseDown:');
  replace('const mn={...de,currentWorldX:ce.x,currentWorldY:ce.y};wl.current=mn',
    'for(const node of zn.current){const root=legacyBatchRoot(node,zn.current);if(root&&!root.metadata.imageBatchExpanded)Tt.delete(node.id)}const mn={...de,currentWorldX:ce.x,currentWorldY:ce.y};wl.current=mn');
  replace('wl.current=ce,Qe(ce),K.shiftKey||Xe(new Set)',
    'wl.current=ce,Qe(ce),globalThis.CanvasSaveGuardBatch?.beginRectangle(ce),K.shiftKey||Xe(new Set)');
  replace('wl.current=mn,Qe(mn),Xe(Tt)},[lo])',
    'wl.current=mn,Qe(mn),Xe(Tt),globalThis.CanvasSaveGuardBatch?.selectRectangle(mn)},[lo])');
  replace('if(K.buttons===0){wl.current=null,Qe(null);return}',
    'if(K.buttons===0){wl.current=null,Qe(null);globalThis.CanvasSaveGuardBatch?.cancelRectangle();return}');
  replace('if(Gd(K.clientX,K.clientY),wl.current=null,Qe(null),Js.current)return;',
    'if(Gd(K.clientX,K.clientY),wl.current=null,Qe(null),globalThis.CanvasSaveGuardBatch?.endRectangle(),Js.current)return;');
  // Inline cards stop bubbling mouseup. Finish selection in pointerup capture
  // so releasing over a child still locks the world rectangle exactly once.
  replace('const K=ce=>Gd(ce.clientX,ce.clientY),de=()=>Gd();return window.addEventListener("mousemove",Sv)',
    'const K=ce=>{Gd(ce.clientX,ce.clientY);if(wl.current){wl.current=null;Qe(null);globalThis.CanvasSaveGuardBatch?.endRectangle()}},de=()=>{Gd();wl.current=null;Qe(null);globalThis.CanvasSaveGuardBatch?.cancelRectangle()};return window.addEventListener("mousemove",Sv)');
  replace('window.addEventListener("pointerup",K),window.addEventListener("pointercancel",de)',
    'window.addEventListener("pointerup",K,true),window.addEventListener("pointercancel",de,true)');
  replace('window.removeEventListener("pointerup",K),window.removeEventListener("pointercancel",de)',
    'window.removeEventListener("pointerup",K,true),window.removeEventListener("pointercancel",de,true)');
  replace('O=S*(e.width+18),T=(C-b+1)*(e.height+18),E=t.content?',
    'guardPosition=batchImagePosition(e,t.id,n),O=guardPosition.x,T=guardPosition.y,E=t.content?');
  replace('function xjt({node:e,image:t,index:n,scale:r,onView:o,onSetPrimary:i,onDuplicate:s,onDownload:a,onRetry:l,onDelete:c})',
    'function xjt({node:e,image:t,index:n,scale:r,guardClosing=false,onView:o,onSetPrimary:i,onDuplicate:s,onDownload:a,onRetry:l,onDelete:c})');
  replace('return p.jsxs("div",{className:`absolute z-20 overflow-hidden rounded-3xl ${t.content?',
    'const guardCard=f.useRef(null);f.useLayoutEffect(()=>{const animation=animateBatchCard(guardCard.current,guardPosition,n,guardClosing);return()=>animation?.cancel()},[e.id,t.id,guardClosing]);return p.jsxs("div",{ref:guardCard,"data-guard-batch-node":e.id,"data-guard-batch-image":t.id,"data-guard-batch-closing":guardClosing,className:`absolute z-20 overflow-hidden rounded-3xl ${t.content?');
  replace('animation:`canvas-batch-child-in 320ms ${n*35}ms cubic-bezier(.2,.85,.18,1) both`},onMouseDown:N=>N.stopPropagation(),onPointerDown:N=>N.stopPropagation()',
    'animation:"none"},onMouseDown:N=>globalThis.CanvasSaveGuardBatch?.beginDrag(N,e.id,t.id),onPointerDown:N=>N.stopPropagation(),onContextMenu:N=>{globalThis.CanvasSaveGuardBatch?.setContextImage(e.id,t.id)}');

  // Each item retains the original retry callback and its controller. Item keys
  // keep a later retry in the same batch from aborting an earlier submitted item.
  replace('vs=f.useCallback((K,de,ce=de,ge=new AbortController)=>{const _e=za.current.get(K);return _e?.controller!==ge&&_e?.controller.abort(),za.current.set(K,',
    'vs=f.useCallback((K,de,ce=de,ge=new AbortController,guardKey=K)=>{globalThis.CanvasSaveGuard?.registerGenerationOwner?.(ge.signal,K,guardKey);const _e=za.current.get(guardKey);return _e?.controller!==ge&&_e?.controller.abort(),za.current.set(guardKey,');
  replace('Ci=f.useCallback((K,de)=>{za.current.get(K)?.controller===de&&za.current.delete(K)},[])',
    'Ci=f.useCallback((K,de,guardKey=K)=>{za.current.get(guardKey)?.controller===de&&za.current.delete(guardKey)},[])');
  replace('const en=await vP(await BB(de,mn,{signal:_e}));',
    'const en=await protectCanvasGeneratedMedia(_e,async()=>vP(await BB(de,mn,{signal:_e})));');
  replace('const ct=await vP(await BB(_e,{id:ce,provider:K.metadata?.videoTaskProvider==="gemini"?"gemini":"openai",model:_e.model},{signal:ge.signal}));',
    'const ct=await protectCanvasGeneratedMedia(ge.signal,async()=>vP(await BB(_e,{id:ce,provider:K.metadata?.videoTaskProvider==="gemini"?"gemini":"openai",model:_e.model},{signal:ge.signal})));');
  replace('const Zr=await Rse(await Pse(_e,Qn,{signal:io.signal}),_e.audioFormat);',
    'const Zr=await protectCanvasGeneratedMedia(io.signal,async()=>Rse(await Pse(_e,Qn,{signal:io.signal}),_e.audioFormat));');
  replace('const _o=await Rse(await Pse(ct,Tt,{signal:Rr.signal}),ct.audioFormat);',
    'const _o=await protectCanvasGeneratedMedia(Rr.signal,async()=>Rse(await Pse(ct,Tt,{signal:Rr.signal}),ct.audioFormat));');
  replace('za.current.forEach(ce=>{ce.runningNodeId===K&&(ce.controller.abort(),za.current.delete(ce.targetNodeId)',
    'za.current.forEach((ce,guardKey)=>{ce.runningNodeId===K&&(ce.controller.abort(),za.current.delete(guardKey)');
  replace('const Rr=vs(K.id,ce.id,K.id);try{if(K.type===De.Text)',
    'const guardRequestKey=de?JSON.stringify([K.id,de]):K.id;const Rr=vs(K.id,ce.id,K.id,new AbortController,guardRequestKey);try{if(K.type===De.Text)');
  replace('finally{Ci(K.id,Rr),on(null)}', 'finally{Ci(K.id,Rr,guardRequestKey),on(null)}');
  replace('const Wu=f.useCallback(async(K,de)=>{',
    'const Wu=f.useCallback(async(K,de)=>{const guardRelease=globalThis.CanvasSaveGuard?.beginRetry?.(a,K.id,de);if(guardRelease===false)return;try{');
  replace('finally{Ci(K.id,Rr,guardRequestKey),on(null)}},[pp,R,Ci,L,e,z,qd,vs,n])',
    'finally{Ci(K.id,Rr,guardRequestKey),on(null)}}finally{guardRelease?.()}},[pp,R,Ci,L,e,z,qd,vs,n,a])');
  replace('pn=await go(Jn.dataUrl,{signal:Rr.signal}),Cn=fi[De.Image],$r={id:de||',
    'pn=await go(Jn.dataUrl,{signal:Rr.signal,guardImageId:de}),Cn=fi[De.Image],$r={id:de||');
  replace('Ua=await go(co.dataUrl,{signal:nu.signal}),Pp=us(Ua.width,Ua.height,nf.width,nf.height),ta={id:ii,',
    'Ua=await go(co.dataUrl,{signal:nu.signal,guardImageId:ii}),Pp=us(Ua.width,Ua.height,nf.width,nf.height),ta={id:ii,');
  replace('Av=f.useCallback((K,de)=>{(zn.current.find',
    'Av=f.useCallback((K,de)=>{const mapped=zn.current.find(node=>node.id===K)?.metadata?.guardBatchChildren?.[de];if(mapped&&zn.current.some(node=>node.id===mapped)){xp(new Set([mapped]));return;}globalThis.CanvasSaveGuardHistory?.commitPending(true);const removed=zn.current.find(node=>node.id===K)?.metadata?.images?.find(image=>image.id===de);if(removed)globalThis.CanvasSaveGuard?.recordDeletedObjects(a,[],[],[{nodeId:K,image:removed}]);(zn.current.find');
  replace('const ct=_e.metadata?.images?.filter(jt=>jt.id!==de)||[];return{..._e,metadata:{..._e.metadata,images:ct,count:ct.length,primaryImageId:_e.metadata?.primaryImageId===de?ct[0]?.id:_e.metadata?.primaryImageId}}',
    'return removeBatchImage(_e,de)');
  replace('images:di.map(ii=>({id:ii,status:Vi,content:"",naturalWidth:0,naturalHeight:0,bytes:0,mimeType:""})),primaryImageId:void 0,...qo',
    'images:di.map(ii=>({id:ii,status:Vi,content:"",naturalWidth:0,naturalHeight:0,bytes:0,mimeType:""})),batchDisplayRoot:di.length>1,batchResultLayoutVersion:2,imageBatchExpanded:di.length>1,primaryImageId:void 0,...qo');

  replace('[pp,R,Ci,L,e,z,qd,vs,n,a]),Av=f.useCallback', `[pp,R,Ci,L,e,z,qd,vs,n,a]);
    f.useEffect(()=>{
      if(!Et)return;
      const batch=createBatchInteraction({projectId:a,getNodes:()=>zn.current,updateNodes:updater=>G(updater),applyMaterialized:nodes=>{zn.current=nodes;G(nodes)},getViewport:()=>xs.current,setViewport:viewport=>Ce(viewport),
        getCanvasRect:()=>x.current?.getBoundingClientRect(),
        commitNodes:(updater,onCommitted)=>{
          globalThis.CanvasSaveGuardHistory?.commitPending();
          G(updater);
          requestAnimationFrame(()=>{
            const history=globalThis.CanvasSaveGuardHistory;
            if(history?.projectId!==a||globalThis.CanvasSaveGuardBatch!==batch)return;
            history.commitPending();
            onCommitted?.(zn.current);
            globalThis.CanvasSaveGuardBatch?.refreshControls();
          });
        },
        setDragging:dragging=>{P.current=dragging;I.current=dragging;nn(dragging)},deleteImage:(nodeId,imageId)=>Av(nodeId,imageId),deleteNodes:ids=>xp(ids),
        getSelectedIds:()=>Co.current,selectNodes:ids=>Xe(ids),getConnections:()=>xr.current,setClipboard:value=>{C.current=value},startConnection:(event,nodeId,side)=>fE(event,nodeId,side)});
      globalThis.CanvasSaveGuardBatch=batch;
      batch.refreshControls();
      return()=>{batch.dispose();if(globalThis.CanvasSaveGuardBatch===batch)delete globalThis.CanvasSaveGuardBatch;};
    },[a,Et]);
    f.useEffect(()=>{
      if(!Et)return;
      Rt(current=>{
        const next=new Set(current);
        for(const node of Z)if(node.type===De.Image){
          if(node.metadata?.images?.length>1||node.metadata?.batchDisplayRoot){
            if(node.metadata?.imageBatchExpanded!==false)next.add(node.id);else next.delete(node.id);
          }
        }
        return next.size===current.size&&[...next].every(id=>current.has(id))?current:next;
      });
    },[Z,Et]);
    f.useEffect(()=>{
      if(!Et)return;
      const retry=(${createRetryBridge.toString()})(a,()=>zn.current,(node,imageId)=>Wu(node,imageId),()=>Ue);
      retry.getViewport=()=>xs.current;
      retry.getCanvasRect=()=>x.current?.getBoundingClientRect();
      const hook={
        projectId:a,ready:Et,deletedOnlyVersion:1,
        idle:()=>!($.current||P.current||I.current||A.current.isDraggingNode||wl.current),
        snapshot:Hu,viewport:()=>({...xs.current}),
        retained:()=>({history:O.current,lastHistory:T.current,clipboard:C.current}),
        commitPending:(preserveDeletion=false)=>{
          if($.current)return;
          if(E.current){clearTimeout(E.current);E.current=null;}
          const committed=commitCanvasHistory(O.current,T.current,Hu());
          O.current=committed.history;T.current=committed.current;
          if(preserveDeletion)T.current[Symbol.for('canvas-save-guard:undo-until')]=Date.now()+${DELETION_GRACE_MS};
          if(committed.changed)Je({canUndo:O.current.past.length>0,canRedo:O.current.future.length>0});
        },
        prune:pruneHistory=>{
          if(!hook.idle())throw Error('请先结束拖动或撤销，再清理删除缓存。');
          const current=Hu(),before=JSON.stringify(current);
          const cleaned=pruneHistory(current,hook.retained());
          if(before!==JSON.stringify(Hu()))throw Error('画布发生变化，已停止清理。');
          if(E.current){clearTimeout(E.current);E.current=null;}
          if(cleaned.lastHistory&&JSON.stringify(cleaned.lastHistory)!==JSON.stringify(current)){
            cleaned.history.past=retainedCanvasHistory([...cleaned.history.past,cleaned.lastHistory]);
            cleaned.history.future=[];
          }
          O.current=cleaned.history;T.current=current;C.current=cleaned.clipboard;
          Je({canUndo:O.current.past.length>0,canRedo:O.current.future.length>0});
          return cleaned.summary;
        }
      };
      globalThis.CanvasSaveGuardRetry=retry;globalThis.CanvasSaveGuardHistory=hook;
      globalThis.CanvasSaveGuardRetryRegion?.refresh();
      return()=>{
        if(globalThis.CanvasSaveGuardRetry===retry)delete globalThis.CanvasSaveGuardRetry;
        if(globalThis.CanvasSaveGuardHistory===hook)delete globalThis.CanvasSaveGuardHistory;
      };
    },[a,Et,Wu,Hu,Ue]);
    const Av=f.useCallback`);

  replace('Mae.createRoot(document.getElementById("root")).render', `
    globalThis.CanvasSaveGuardNative={version:'v0.20.0',patchVersion:'${BUILD_VERSION}',batchVisualVersion:${BATCH_VISUAL_VERSION},store:Ni,storage:zg,config:Wr,
      images:{getImageBlob:sp,setImageBlob:SR,uploadImage:go,resolveImageUrl:Vc,deleteStoredImages:aH,ensureImagePreview:_m,previewUrlFor:Pu},
      media:{getMediaBlob:A0,setMediaBlob:yH,uploadMediaFile:hm,resolveMediaUrl:xO,deleteStoredMedia:hlt}};
    if(globalThis.CanvasSaveGuard){
      globalThis.CanvasSaveGuard.connectSite(globalThis.CanvasSaveGuardNative);
      BU=(...args)=>globalThis.CanvasSaveGuard.exportProjects(...args);
    }
    Mae.createRoot(document.getElementById("root")).render`);
  // This is an ES module redirected to an extension URL. Preserve the site's
  // origin for its lazy syntax-highlighting chunk.
  source = source.replaceAll('import("./highlighted-body-OFNGDK62-DqkoDgyK.js")',
    'import("https://canvas.best/assets/highlighted-body-OFNGDK62-DqkoDgyK.js")');
  source += `\n${[batchImagePosition,batchConnectionPath,createBatchInteraction,legacyBatchRoot,legacyBatchMembers,dragNodeMembers,retryRegionIntersects,removeBatchImage,pruneLegacyBatchNodes,animateBatchCard,batchPanelTop,batchIntersectsViewport,canvasNodeIndex,isExpandableImageGroup,isImageGroupExpanded,selectionLayoutState,selectedLayoutRoots,selectedLayoutUnits,arrangeSelectedNodes,selectedDownloadNodes,layoutTrackCenters,alignedSelectionPositions,compactSelectionPositions,snapGridPoint,snapGridOffset,selectionToolbarPosition,createBatchComponents,copyImageNode,useSidebarWindow,commitCanvasHistory,retainedCanvasHistory,materializeBatchImage,synchronizeBatchGraph,batchMediaDescriptor,batchMediaEqual,copyBatchMedia].map(fn=>fn.toString()).join('\n')}
    function protectCanvasGeneratedMedia(signal,action){return globalThis.CanvasSaveGuard?.protectGeneratedMedia?globalThis.CanvasSaveGuard.protectGeneratedMedia(signal,action):action();}
    const CanvasGuardSidePanel=f.memo(qjt);
    const {Results:CanvasGuardBatchResults,Node:CanvasGuardNode,Toolbar:CanvasGuardToolbar}=createBatchComponents(f,p,ljt,xjt,CanvasGuardBatchLines,jjt,()=>ur[or(state=>state.theme)]);
    function CanvasGuardBatchLines({node,scale,closing}){
      const theme=ur[or(state=>state.theme)];
      return p.jsx("svg",{className:"pointer-events-none absolute left-0 top-0 overflow-visible",width:1,height:1,
        style:{zIndex:0,opacity:closing?0:1,transition:"opacity 220ms"},"aria-hidden":true,children:(node.metadata?.images||[]).map((image,index)=>
          p.jsx("path",{"data-guard-batch-node":node.id,"data-guard-batch-line":image.id,
            d:batchConnectionPath(node,batchImagePosition(node,image.id,index)),fill:"none",stroke:theme.node.muted,
            strokeWidth:2,opacity:0.82},image.id))});
    }\n`;
  return source;
}
