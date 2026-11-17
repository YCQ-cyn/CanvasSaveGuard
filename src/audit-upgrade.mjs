import { collectMedia, mediaKey } from './core.mjs';
import { readCleanupRoots, runMediaCleanup, installAutomaticDeletedCleanup } from './cleanup.mjs';

function nativeModules(doc) {
  if (globalThis.CanvasSaveGuardNative) return Promise.resolve(globalThis.CanvasSaveGuardNative);
  if (![...doc.scripts].some(script => script.src.includes('/10u8p1p4fll6y.js'))) {
    return Promise.reject(Error('网站资源版本未匹配，请先保存完整 ZIP。'));
  }
  return new Promise((resolve, reject) => {
    const id = `canvas-guard-audit-${crypto.randomUUID()}`;
    globalThis.TURBOPACK.push(['static/chunks/canvas-guard-audit.js', id, context => {
      try { resolve({ store: context.i(83629).useCanvasStore, images: context.i(7065), media: context.i(23241) }); }
      catch (error) { reject(error); }
    }]);
    globalThis.TURBOPACK.push(['static/chunks/canvas-guard-audit.js', { otherChunks: [], runtimeModuleIds: [id] }]);
  });
}

async function persistedReferenceKeys() {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('infinite-canvas');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const names = ['app_state', 'image_generation_logs', 'video_generation_logs'].filter(name => db.objectStoreNames.contains(name));
    if (!names.length) return [];
    const transaction = db.transaction(names, 'readonly');
    const values = await Promise.all(names.map(name => new Promise((resolve, reject) => {
      const store = transaction.objectStore(name);
      const request = name === 'app_state' ? store.get('infinite-canvas:asset_store') : store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    })));
    const keys = new Map();
    for (const value of values) if (value) collectMedia(typeof value === 'string' ? JSON.parse(value) : value, keys);
    return [...keys.keys()];
  } finally { db.close(); }
}

// Retain the open page's writer, media caches, session images and lease. The
// added operation reads its native module exports rather than restarting them.
export function installAuditUpgrade(guard, doc) {
  if (guard.referenceAuditVersion === 1 || guard.deletedOnlyVersion !== 1 || !guard.cleanupEndpoint || !globalThis.CanvasSaveGuardHistory?.ready) return;
  const endpoint = guard.cleanupEndpoint;
  const originalPrepare = endpoint.prepare.bind(endpoint);
  const modulesReady = nativeModules(doc);
  modulesReady.catch(() => {});
  let modules;
  let summary = { nodes: 0, connections: 0 };
  let knownUrls = [];
  function roots() {
    if (!globalThis.CanvasSaveGuardHistory?.ready) throw Error('画布尚未读取完成，请等待后重试。');
    return readCleanupRoots(modules.store, globalThis.CanvasSaveGuardHistory, doc, true, () => knownUrls);
  }
  const leased = new Set();
  const originalRelease = endpoint.release.bind(endpoint);
  endpoint.release = token => { leased.delete(token); return originalRelease(token); };
  endpoint.referenceAuditVersion = 1;
  endpoint.prepareAudit = async (token, prune) => {
    modules = await modulesReady;
    const hook = globalThis.CanvasSaveGuardHistory;
    const originalPrune = hook.prune;
    hook.prune = (...args) => { summary = originalPrune(...args); return summary; };
    let prepared;
    try { prepared = await originalPrepare(token, prune); }
    finally { hook.prune = originalPrune; }
    leased.add(token);
    await new Promise(resolve => setTimeout(resolve, 0));
    knownUrls = await resolveKeys([...roots().keys, ...await persistedReferenceKeys()]);
    return { ...prepared, ...roots() };
  };
  endpoint.auditRoots = token => {
    if (!leased.has(token)) throw Error('缓存核对会话已结束，请重试。');
    return roots();
  };
  const fetchBlob = async url => {
    const response = await fetch(url);
    if (!response.ok) throw Error(`读取临时图片失败：HTTP ${response.status}`);
    return response.blob();
  };
  const resolveKeys = async requestedKeys => {
    const keys = [...new Set(requestedKeys.filter(mediaKey))];
    const aliases = [];
    for (let offset = 0; offset < keys.length; offset += 16) {
      const batch = keys.slice(offset, offset + 16);
      await Promise.all(batch.map(async key => {
        try {
          const resolve = key.startsWith('image:') ? modules.images.resolveImageUrl : modules.media.resolveMediaUrl;
          const url = await resolve(key, '');
          if (url?.startsWith('blob:')) aliases.push([url, key, true]);
        } catch { /* The reference audit independently retains unreadable owners. */ }
      }));
      guard.cleanupProgress?.update({ step: 2, stage: '正在核对原页面媒体地址', current: Math.min(offset + batch.length, keys.length), total: keys.length });
    }
    return aliases;
  };
  guard.referenceAuditVersion = 1;
  guard.cleanupDeleted = async () => {
    modules = await modulesReady;
    summary = { nodes: 0, connections: 0 };
    return runMediaCleanup(guard, 'deleted-audited', {
      flush: async () => {
        try { await guard.flush(); }
        catch { /* Existing protection errors remain in the original status UI. */ }
      },
      fetchBlob, getSummary: () => summary,
    });
  };
  installAutomaticDeletedCleanup(guard);
}
