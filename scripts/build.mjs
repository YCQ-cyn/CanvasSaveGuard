import { build } from 'esbuild';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { RETRY_PANEL_VERSION } from '../src/retry-panel.mjs';
import { patchV020 } from './patch-v020.mjs';
import { createCanvasRetryBridge, createBatchCanvasRetryBridge } from '../src/retry-bridge.mjs';
import { BUILD_VERSION } from '../src/status-upgrade.mjs';
import { commitCanvasHistory, retainedCanvasHistory } from '../src/history-commit.mjs';
import { DELETION_GRACE_MS } from '../src/deletion-grace.mjs';
import { retryRegionIntersects } from '../src/retry-region.mjs';
import { dragNodeMembers, legacyBatchMembers, legacyBatchRoot, canvasNodeIndex } from '../src/batch-layout.mjs';
const root=new URL('../',import.meta.url),out=new URL('extension/',root);
await mkdir(new URL('patches/',out),{recursive:true});
await build({entryPoints:[new URL('src/main.mjs',root).pathname.replace(/^\/([A-Z]:)/,'$1')],outfile:new URL('guard.js',out).pathname.replace(/^\/([A-Z]:)/,'$1'),bundle:true,format:'iife',target:'chrome120',legalComments:'eof'});
await build({
  entryPoints: [new URL('src/retry-userscript.mjs', root).pathname.replace(/^\/([A-Z]:)/, '$1')],
  outfile: new URL('canvas-retry.user.js', root).pathname.replace(/^\/([A-Z]:)/, '$1'),
  bundle: true, format: 'iife', target: 'chrome120', legalComments: 'eof',
  banner: { js: `// ==UserScript==
// @name         无限画布 · 一键重试全部失败项
// @namespace    local.canvas-retry
// @version      ${RETRY_PANEL_VERSION}
// @description  独立控制手动和自动重试，自动间隔按秒设置且至少60秒，跳过收起的图片组。
// @match        https://canvas.modelaryx.com/*
// @match        https://canvas.best/*
// @grant        none
// @run-at       document-idle
// ==/UserScript==` }
});
let source=await readFile(new URL('upstream/canvas-client-v040.original.js',root),'utf8');
const hash=createHash('sha256').update(source).digest('hex');
if(hash!=='889e42fb3b1871e347252e4cea6bba8092e16bd66edeacba80413b455f3a34f2')throw Error('上游资源版本发生变化，拒绝生成未经核对的补丁。');
function replaceOnce(from,to){if(source.split(from).length!==2)throw Error(`补丁定位失败：${from.slice(0,70)}`);source=source.replace(from,to);}
replaceOnce('is=(0,l.useCallback)(async t=>{var n;',
  'is=(0,l.useCallback)(async t=>{const guardRelease=globalThis.CanvasSaveGuard?.beginRetry?.(void 0,t.id);if(guardRelease===false)return;try{var n;');
replaceOnce('},[k,e,C]),il=(0,l.useCallback)',
  '}finally{guardRelease?.()}},[k,e,C]),il=(0,l.useCallback)');
replaceOnce('},[k,e,C]),il=(0,l.useCallback)', `},[k,e,C]);
(0,l.useEffect)(() => {
  if (!eU) return;
  const adapter = (${createCanvasRetryBridge.toString()})(i, () => tB.current, node => is(node));
  adapter.getViewport = () => tL.current;
  adapter.getCanvasRect = () => a.current?.getBoundingClientRect();
  globalThis.CanvasSaveGuardRetry = adapter;
  globalThis.CanvasSaveGuardRetryRegion?.refresh();
  return () => { if (globalThis.CanvasSaveGuardRetry === adapter) delete globalThis.CanvasSaveGuardRetry; };
}, [i, is, eU]);
let il=(0,l.useCallback)`);
replaceOnce('"data-node-id":e.id,className:', '"data-node-id":e.id,"data-batch-collapsed":e.metadata?.isBatchRoot&&f>1&&!x?"true":void 0,className:');
// Add Shift on blank canvas to the site's own rectangle selection. Node-level
// Shift-click continues using the existing additive selection handler.
replaceOnce('if(0===e.button&&(e.ctrlKey||e.metaKey)&&i){e.preventDefault()', 'if(0===e.button&&(e.shiftKey||e.ctrlKey||e.metaKey)&&i){e.preventDefault()');
replaceOnce('tW.current&&t2(),0!==e.button)return;if(!e.ctrlKey&&!e.metaKey){eM(null)', 'tW.current&&t2(),0!==e.button)return;if(!e.shiftKey&&!e.ctrlKey&&!e.metaKey){eM(null)');
replaceOnce('t=()=>nP();return window.addEventListener("mousemove",nz)', 't=()=>{nP();tU.current=null;eM(null);globalThis.CanvasSaveGuardRetryRegion?.cancel(i)};return window.addEventListener("mousemove",nz)');
replaceOnce('let e=e=>nP(e.clientX,e.clientY),t=()=>{nP();tU.current=null;', 'let e=e=>{nP(e.clientX,e.clientY);if(tU.current){globalThis.CanvasSaveGuardRetryRegion?.capture(i,tU.current);tU.current=null;eM(null)}},t=()=>{nP();tU.current=null;');
replaceOnce('window.addEventListener("pointerup",e),window.addEventListener("pointercancel",t)', 'window.addEventListener("pointerup",e,true),window.addEventListener("pointercancel",t,true)');
replaceOnce('window.removeEventListener("pointerup",e),window.removeEventListener("pointercancel",t)', 'window.removeEventListener("pointerup",e,true),window.removeEventListener("pointercancel",t,true)');
replaceOnce('tU.current=n,eM(n),e.shiftKey||ep(new Set)', 'tU.current=n,eM(n),globalThis.CanvasSaveGuardRetryRegion?.begin(i),e.shiftKey||ep(new Set)');
replaceOnce('if(nP(e.clientX,e.clientY),tU.current=null,eM(null),tW.current)return;', 'if(nP(e.clientX,e.clientY),tU.current&&globalThis.CanvasSaveGuardRetryRegion?.capture(i,tU.current),tU.current=null,eM(null),tW.current)return;');
replaceOnce('if(0===e.buttons){tU.current=null,eM(null);return}', 'if(0===e.buttons){tU.current=null,eM(null);globalThis.CanvasSaveGuardRetryRegion?.cancel(i);return}');
replaceOnce('tL.current=ed,tF.current=ev,tO.current=ew,tW.current=ej}', 'tL.current=ed,tF.current=ev,tO.current=ew,tW.current=ej,globalThis.CanvasSaveGuardRetryRegion?.paint(ed)}');
replaceOnce('let r=new Set(a);i.forEach(e=>{a.has(e.id)', 'let r=dragNodeMembers(a,i,tD.current,!!globalThis.CanvasSaveGuard?.getMoveDescendants?.());i.forEach(e=>{a.has(e.id)');
// Record the exact objects removed by native Delete/menu/toolbar handlers.
// Visibility and changes inferred from other operations never authorize cleanup.
replaceOnce('tB.current.forEach(n=>{e.has(n.id)&&n.metadata?.batchChildIds?.forEach(e=>t.add(e))}),en(e=>{let n=e.filter(e=>!t.has(e.id))', 'tB.current.forEach(n=>{e.has(n.id)&&n.metadata?.batchChildIds?.forEach(e=>t.add(e))}),globalThis.CanvasSaveGuardHistory?.commitPending?.(true),globalThis.CanvasSaveGuard?.recordDeletedObjects?.(i,tB.current.filter(e=>t.has(e.id)),tD.current.filter(e=>t.has(e.fromNodeId)||t.has(e.toNodeId))),en(e=>{let n=e.filter(e=>!t.has(e.id))');
replaceOnce('nv=(0,l.useCallback)(e=>{ea(t=>t.filter(t=>t.id!==e))', 'nv=(0,l.useCallback)(e=>{globalThis.CanvasSaveGuardHistory?.commitPending?.(true);globalThis.CanvasSaveGuard?.recordDeletedObjects?.(i,[],tD.current.filter(t=>t.id===e));ea(t=>t.filter(t=>t.id!==e))');
replaceOnce('...u.current.past.slice(-49)', '...retainedCanvasHistory(u.current.past,49)');
replaceOnce('nM=(0,l.useCallback)(()=>{let e=u.current.past.pop()',
  'nM=(0,l.useCallback)(()=>{globalThis.CanvasSaveGuardHistory?.commitPending?.();let e=u.current.past.pop()');
replaceOnce('nI=(0,l.useCallback)(()=>{let e=u.current.future.pop(),t=m.current;e&&t&&(u.current.past.push(t),n$(e))},[n$])',
  'nI=(0,l.useCallback)(()=>{globalThis.CanvasSaveGuardHistory?.commitPending?.();let e=u.current.future.pop(),t=m.current;e&&t&&(globalThis.CanvasSaveGuard?.recordHistoryRedo?.(i,t,e),u.current.past.push(t),n$(e))},[n$,i])');
replaceOnce('w.current={isDraggingNode:!0,hasMoved:!1,startX:e.clientX','w.current={guardClickedNodeId:t,isDraggingNode:!0,hasMoved:!1,startX:e.clientX');
replaceOnce('let n=!w.current.hasMoved&&1===w.current.initialSelectedNodes.length,i=w.current.initialSelectedNodes[0]?.id','let n=!w.current.hasMoved&&null!=e&&null!=t,i=w.current.guardClickedNodeId||w.current.initialSelectedNodes[0]?.id');
replaceOnce('window.addEventListener("pointermove",e),window.addEventListener("pointerup",t),()=>{window.removeEventListener("pointermove",e),window.removeEventListener("pointerup",t)}','window.addEventListener("pointermove",e),window.addEventListener("pointerup",t),window.addEventListener("pointercancel",t),window.addEventListener("blur",t),()=>{window.removeEventListener("pointermove",e),window.removeEventListener("pointerup",t),window.removeEventListener("pointercancel",t),window.removeEventListener("blur",t)}');
// Pointer events from the top-level node's unhandled empty shell must still select that node.
replaceOnce('onContextMenu:t=>R(t,e.id),children:[(0,s.jsxs)("div",{className:"relative h-full w-full overflow-visible rounded-3xl border-2"','onContextMenu:t=>R(t,e.id),onMouseDown:t=>{t.target===t.currentTarget&&k(t,e.id)},children:[(0,s.jsxs)("div",{className:"relative h-full w-full overflow-visible rounded-3xl border-2"');
replaceOnce('tX=(0,l.useCallback)(e=>{M({extra:e,history:u.current,lastHistory:m.current})},[M]);(0,l.useEffect)', `tX=(0,l.useCallback)(e=>{M({extra:e,history:u.current,lastHistory:m.current})},[M]);
(0,l.useEffect)(() => {
  const adapter = {
    projectId: i,
    ready: eU,
    deletedOnlyVersion: 1,
    idle: () => !(f.current || g.current || b.current || tU.current),
    viewport: () => ({ ...tL.current }),
    snapshot: tq,
    retained: () => ({ history: u.current, lastHistory: m.current, clipboard: c.current, agent: tk }),
    commitPending: (preserveDeletion=false) => {
      if(f.current)return;
      if(h.current){clearTimeout(h.current);h.current=null;}
      const committed=commitCanvasHistory(u.current,m.current,tq());
      u.current=committed.history;m.current=committed.current;
      if(preserveDeletion)m.current[Symbol.for('canvas-save-guard:undo-until')]=Date.now()+${DELETION_GRACE_MS};
      if(committed.changed)tI({canUndo:u.current.past.length>0,canRedo:u.current.future.length>0});
    },
    prune: pruneHistory => {
      if (f.current || g.current || b.current) throw Error("请先结束拖动或撤销，再清理删除缓存。");
      const current = tq();
      const before = JSON.stringify(current);
      const cleaned = pruneHistory(current, { history: u.current, lastHistory: m.current, clipboard: c.current, agent: tk });
      if (before !== JSON.stringify(tq())) throw Error("画布发生变化，已停止清理。");
      if (h.current) { clearTimeout(h.current); h.current = null; }
      u.current = cleaned.history;
      if (cleaned.lastHistory && JSON.stringify(cleaned.lastHistory) !== JSON.stringify(current)) {
        u.current.past = retainedCanvasHistory([...u.current.past, cleaned.lastHistory]);
        u.current.future = [];
      }
      m.current = current;
      c.current = cleaned.clipboard;
      if (tk) tj(cleaned.agent);
      tI({ canUndo: u.current.past.length > 0, canRedo: u.current.future.length > 0 });
      return cleaned.summary;
    }
  };
  globalThis.CanvasSaveGuardHistory = adapter;
  return () => { if (globalThis.CanvasSaveGuardHistory === adapter) delete globalThis.CanvasSaveGuardHistory; };
}, [i, tq, tk, eU]);
(0,l.useEffect)`);
source+='\n'+[retainedCanvasHistory,commitCanvasHistory,retryRegionIntersects,dragNodeMembers,legacyBatchMembers,legacyBatchRoot,canvasNodeIndex].map(fn=>fn.toString()).join('\n')+'\n;globalThis.CanvasSaveGuard&&(globalThis.CanvasSaveGuard.clickPatched=true);\n';
await writeFile(new URL('patches/canvas-client-v040.js',out),source);
await writeFile(new URL('upstream-build.json',out),JSON.stringify({site:'https://canvas.modelaryx.com',version:'v0.4.0',chunk:'04vm3dhh2jasn.js',originalSha256:hash,supportedSites:[{origin:'https://canvas.modelaryx.com',version:'v0.4.0',chunk:'04vm3dhh2jasn.js'},{origin:'https://canvas.best',version:'v0.20.0',chunk:'index-BcbSchFn.js',originalSha256:'d945e49e52ee3a8636b3ee9f2ede5f7b851dbb8fcf665d08a24f91fd70f6ceeb'}],patches:['batch-root-click','pan-cancel','node-shell-click','deleted-history-interface','collapsed-batch-marker','offscreen-retry-interface','explicit-deletion-records','shift-rectangle-selection']},null,2));
const viteSource = await readFile(new URL('upstream/canvas-client-v020.original.js',root),'utf8');
const nativeFile = `canvas-client-v020-${BUILD_VERSION}.js`;
await writeFile(new URL(`patches/${nativeFile}`,out),patchV020(viteSource,createBatchCanvasRetryBridge));
// Running unpacked extensions can retain the previous static redirect rules
// until they are reloaded. Keep the script those active rules still reference.
for(const file of ['manifest.json','rules.json']) {
  let config = (await readFile(new URL('src/'+file,root),'utf8')).replaceAll('canvas-client-v020.js',nativeFile);
  if (file === 'manifest.json') {
    const manifest = JSON.parse(config);
    manifest.version = BUILD_VERSION;
    config = JSON.stringify(manifest, null, 2) + '\n';
  }
  await writeFile(new URL(file,out),config);
}
for(const file of ['background.js','cleanup-bridge.js'])await copyFile(new URL('src/'+file,root),new URL(file,out));
await mkdir(new URL('icons/', out), {recursive: true});
for (const size of [16, 32, 48, 128]) {
  await copyFile(new URL(`src/icons/icon-${size}.png`, root), new URL(`icons/icon-${size}.png`, out));
}
await copyFile(new URL('使用说明.md',root),new URL('使用说明.md',out));
await copyFile(new URL('THIRD_PARTY_NOTICES.txt',root),new URL('THIRD_PARTY_NOTICES.txt',out));
await copyFile(new URL('UPSTREAM_LICENSE.txt',root),new URL('UPSTREAM_LICENSE.txt',out));
await copyFile(new URL('UPSTREAM_V020_LICENSE.txt',root),new URL('UPSTREAM_V020_LICENSE.txt',out));
console.log('扩展已构建：'+out.pathname);
