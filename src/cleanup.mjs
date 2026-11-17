import { collectMedia } from './core.mjs';
import { pruneDeletedHistory } from './deleted-history.mjs';
import { CLEANUP_LOCK, cleanUnreferencedMedia, hasUnkeyedBlob } from './cleanup-storage.mjs';
import { collectReferenceData, appendReferenceData, documentReferenceData } from './reference-audit.mjs';

const sessionLockName = token => `${CLEANUP_LOCK}:session:${token}`;

async function requireActiveSession(token) {
  const { held } = await navigator.locks.query();
  const session = held.find(lock => lock.name === sessionLockName(token) && lock.mode === 'exclusive');
  if (!session || !held.some(lock => lock.name === CLEANUP_LOCK && lock.mode === 'exclusive' && lock.clientId === session.clientId)) {
    throw Error('清理会话已结束，已停止本次操作。请重新点击“清理删除缓存”。');
  }
}

export function installCleanupMessaging() {
  if (window.__canvasGuardMessageVersion === 2) return;
  const postMessage = window.postMessage.bind(window);
  window.postMessage = (message, ...args) => {
    // Old page-side coordinators keep their response contract. Requests use a
    // distinct type so invalidated pre-upgrade bridges cannot answer them.
    if (message?.type === 'canvas-guard-cleanup') message = { ...message, type: 'canvas-guard-cleanup-v2' };
    return postMessage(message, ...args);
  };
  window.__canvasGuardMessageVersion = 2;
}

export function installCleanupUpgradeNotice(guard, doc) {
  const disabled = async () => { throw Error('扩大范围的清理已停用，请使用“清理删除缓存”。'); };
  if (guard.cleanupCurrentOnly) guard.cleanupCurrentOnly = disabled;
  if (guard.cleanupUnused) guard.cleanupUnused = disabled;
  if (guard.cleanupUnreferenced) guard.cleanupUnreferenced = disabled;
  if (guard.cleanupEndpoint?.prepareCurrentOnly) guard.cleanupEndpoint.prepareCurrentOnly = disabled;
  if (guard.deletedOnlyVersion !== 1) {
    guard.cleanupDeleted = async () => { throw Error('请先保存完整 ZIP，重新打开画布后启用按删除记录清理。'); };
  }
  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow) return;
  shadow.querySelector('#cleanup-current')?.remove();
  shadow.querySelector('#cleanup-unused')?.remove();
  shadow.querySelector('#cleanup-unreferenced')?.remove();
  if (shadow.querySelector('#cleanup')) return;
  const button = doc.createElement('button');
  button.id = 'cleanup';
  button.textContent = '清理删除缓存';
  button.onclick = () => {
    shadow.querySelector('#status').textContent = '清理接口将在重新打开画布后启用。请先完成当前生成并保存完整 ZIP，保留临时生成图。';
  };
  shadow.querySelector('.buttons').append(button);
}

function requestCoordinator(action, data = {}) {
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    function receive(event) {
      if (event.source !== window || event.data?.type !== 'canvas-guard-cleanup-result' || event.data.id !== id) return;
      window.removeEventListener('message', receive);
      if (event.data.error) reject(Error(event.data.error));
      else resolve(event.data.result);
    }
    window.addEventListener('message', receive);
    window.postMessage({ type: 'canvas-guard-cleanup', id, action, data }, location.origin);
  });
}

export function installDeletedCleanup({ guard, getStore, getServices, flush, releaseSessionMedia, getDeletedObjects, getKnownMediaUrls, fetchBlob }) {
  guard.cleanupDetailedProgress = true;
  guard.deletedOnlyVersion = 1;
  let heldToken = null;
  let sessionWatcher = null;
  let removalSummary = { nodes: 0, connections: 0, candidateKeys: [] };
  let captureBlocker;
  function unblockEditing() {
    if (captureBlocker) for (const name of captureBlocker.events) document.removeEventListener(name, captureBlocker.block, true);
    captureBlocker=null;
    document.documentElement.removeAttribute('data-canvas-guard-cleaning');
  }
  function blockEditing() {
    if(captureBlocker)return;
    const events = ['pointerdown', 'mousedown', 'click', 'dblclick', 'contextmenu', 'keydown', 'paste', 'drop', 'wheel'];
    const block = event => {
      const target = event.target instanceof Element ? event.target : null;
      // Guard controls open independent ZIP files or display status. A native
      // delete confirmation only removes already-retained references, whose
      // files remain protected by this scan and the new deletion's grace timer.
      if (target?.closest('#canvas-save-guard')) return;
      const button = target?.closest('[role="dialog"] button');
      if (button?.textContent.replace(/\s/g, '') === '删除') return;
      event.preventDefault(); event.stopImmediatePropagation();
    };
    captureBlocker = { events, block };
    for (const name of events) document.addEventListener(name, block, { capture: true, passive: false });
    document.documentElement.setAttribute('data-canvas-guard-cleaning', '');
  }

  function historyHook() {
    const hook = globalThis.CanvasSaveGuardHistory;
    if (location.pathname.startsWith('/canvas/') && (!hook?.ready || hook.deletedOnlyVersion !== 1)) {
      throw Error('当前页面尚未加载缓存清理接口。请先保存完整 ZIP，更新扩展后重新打开画布。');
    }
    return hook;
  }
  function roots(includeAudit = false) {
    return readCleanupRoots(getStore(), historyHook(), document, includeAudit, getKnownMediaUrls);
  }
  function release(token) {
    if (heldToken !== token) return;
    unblockEditing();
    heldToken = null;
    sessionWatcher?.abort();
    sessionWatcher = null;
  }
  function watchSession(token) {
    sessionWatcher = new AbortController();
    // The owner holds an exclusive browser lock for this exact run. A queued
    // shared lock wakes once on completion or tab loss, even if the extension
    // worker forgot its session. It performs no polling or storage scan.
    navigator.locks.request(sessionLockName(token), { mode: 'shared', signal: sessionWatcher.signal }, () => release(token))
      .catch(error => { if (error.name !== 'AbortError') console.warn('Canvas cleanup session watch failed:', error.message); });
  }

  guard.cleanupEndpoint = {
    deletedOnlyVersion: 1,
    referenceAuditVersion: 1,
    interactiveAuditVersion: 1,
    cleanupSessionVersion: 1,
    roots,
    async prepare(token, prune, sessionVersion = 0) {
      if (sessionVersion === 1) {
        await requireActiveSession(token);
        // The incoming owner holds the existing global exclusive media lock.
        // A previous run therefore ended, and only its local marker is stale.
        if (heldToken && heldToken !== token) release(heldToken);
      } else if (heldToken && heldToken !== token) throw Error('另一个标签页正在清理缓存。');
      historyHook();
      heldToken = token;
      try {
        if (sessionVersion === 1) watchSession(token);
        const hook = historyHook();
        const projectsBefore = getStore().getState().projects;
        const before = hook?.snapshot();
        const deletions = prune ? await getDeletedObjects(hook?.projectId || '') : null;
        if (heldToken !== token) throw Error('清理会话已结束，已停止本次操作。');
        const after = historyHook()?.snapshot();
        if (getStore().getState().projects !== projectsBefore || before?.nodes !== after?.nodes || before?.connections !== after?.connections) {
          throw Error('画布正在编辑，本次缓存清理已暂缓。');
        }
        blockEditing();
        if (prune && hook) {
          if (deletions.nodeIds.length || deletions.connectionIds.length || deletions.images.length) removalSummary = hook.prune((current, retained) => pruneDeletedHistory(current, retained, deletions));
          removalSummary.waiting = deletions.waiting;
          removalSummary.projectId = hook.projectId;
          removalSummary.deletionRevision = deletions.revision;
          removalSummary.deletionRecords = {
            nodes: deletions.nodeIds.length, connections: deletions.connectionIds.length,
            images: deletions.images.length, media: deletions.mediaKeys.length,
          };
        }
        if (prune && !hook) {
          removalSummary = { nodes: 0, connections: 0, candidateKeys: [], waiting: deletions.waiting,
            projectId: '', deletionRevision: deletions.revision };
        }
        return { ...roots(), candidateKeys: prune ? removalSummary.candidateKeys : [] };
      } catch (error) {
        release(token);
        throw error;
      }
    },
    async prepareAudit(token, prune, sessionVersion = 0) {
      if (!getStore() || location.pathname.startsWith('/canvas/') && !historyHook()?.ready) throw Error('请保存并关闭本网站的非画布标签页，再核对删除缓存，以便完整保护正在使用的素材。');
      try {
        const prepared = await this.prepare(token, prune, sessionVersion);
        const result={ ...prepared, ...roots(true) };
        // The slow inventory/hash scan uses this immutable reference snapshot.
        // Re-check and briefly freeze edits again only when committing deletion.
        unblockEditing();
        return result;
      } catch (error) {
        release(token);
        throw error;
      }
    },
    auditRoots(token) {
      if (heldToken !== token) throw Error('缓存核对会话已结束，请重试。');
      return roots(true);
    },
    commitAudit(token) {
      if(heldToken!==token)throw Error('缓存核对会话已结束，请重试。');
      if(historyHook() && !historyHook().idle())throw Error('画布正在编辑，本次缓存清理已暂缓。');
      blockEditing();
      return roots(true);
    },
    async releaseMedia(token, keys, retainedKeys, candidateKeys) {
      if (heldToken !== token) throw Error('清理会话已结束，请重新检查。');
      const services = getServices();
      const imageKeys = keys.filter(key => key.startsWith('image:'));
      const otherKeys = keys.filter(key => !key.startsWith('image:'));
      if (imageKeys.length) await services.deleteStoredImages?.(imageKeys);
      if (otherKeys.length) await services.deleteStoredMedia?.(otherKeys);
      return releaseSessionMedia(new Set(retainedKeys), new Set(candidateKeys));
    },
    release,
  };
  window.addEventListener('pagehide', () => { if (heldToken) release(heldToken); });

  function runCleanup(mode) {
    removalSummary = { nodes: 0, connections: 0, candidateKeys: [] };
    return runMediaCleanup(guard, mode, { flush, fetchBlob, getSummary: () => removalSummary }).then(result=>{
      guard.deletedCleanupChecked?.(result.projectId,result.deletionRevision);
      return result;
    });
  }
  guard.referenceAuditVersion = 1;
  guard.cleanupDeleted = () => runCleanup('deleted-audited');
  guard.deletedCleanupState = async () => {
    await flush();
    const projectId = decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || '');
    return getDeletedObjects(projectId);
  };
}

export function installAutomaticDeletedCleanup(guard) {
  if (guard.automaticDeletedCleanupVersion === 4 || !guard.recordDeletedObjects || !guard.deletedCleanupState) return;
  guard.automaticDeletedCleanupVersion = 4;
  const record = guard.recordDeletedObjects.bind(guard);
  let timer;
  let revision = 0;
  let running = false;
  let lastEditAt = 0;
  const checked = new Map();
  guard.deletedCleanupChecked = (projectId,revision) => { if(typeof projectId==='string'&&revision)checked.set(projectId,revision); };
  const noteEdit = () => { lastEditAt=Date.now(); };
  for(const name of ['pointerdown','keydown','wheel','input'])document.addEventListener(name,noteEdit,{capture:true,passive:true});
  guard.scheduleDeletedCleanup = () => {
    revision += 1;
    schedule();
  };

  function schedule(delay = 250) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const current = decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || '');
      if (!/^\/canvas(?:\/|$)/.test(location.pathname)) return;
      const hook = globalThis.CanvasSaveGuardHistory;
      if (current ? !hook?.ready || typeof hook.idle !== 'function' : !guard.status?.().attached) { schedule(350); return; }
      if (running || hook && !hook.idle() || guard.cleanupProgress?.read().status === 'running') {
        schedule(350);
        return;
      }
      if(Date.now()-lastEditAt<800){schedule(800-(Date.now()-lastEditAt));return;}
      const started = revision;
      running = true;
      try {
        const state = await guard.deletedCleanupState();
        guard.cleanupProgress?.waiting(state.waiting);
        if ((state.nodeIds.length || state.connectionIds.length || state.images.length || state.projectDeletions?.length) && checked.get(current)!==state.revision) await guard.cleanupDeleted();
        const remaining = await guard.deletedCleanupState();
        guard.cleanupProgress?.waiting(remaining.waiting);
        if (remaining.waiting.nextAt) schedule(Math.max(50, remaining.waiting.nextAt - Date.now()));
      } catch(error) {
        // The receipt remains durable. The panel explains the failure and its
        // existing button retries the same explicitly deleted objects.
        if(/引用发生变化|正在编辑/.test(error.message))schedule(1200);
      } finally {
        running = false;
        if (revision !== started) schedule();
      }
    }, delay);
  }

  guard.recordDeletedObjects = (projectId, nodes, connections, images = []) => {
    const result = record(projectId, nodes, connections, images);
    if (nodes.length || connections.length || images.length) {
      guard.scheduleDeletedCleanup(projectId);
    }
    return result;
  };
  schedule(350);
}

export async function runMediaCleanup(guard, mode, { flush, fetchBlob, getSummary = () => ({ nodes: 0, connections: 0 }) }) {
  if (guard.cleanupProgress?.read().status === 'running') throw Error('清理正在进行，请等待完成。');
  const token = crypto.randomUUID();
  guard.cleanupProgress?.start(token, mode);
  try {
    await new Promise(resolve => setTimeout(resolve, 0));
    await flush();
    guard.cleanupProgress?.update({ step: 1, stage: '等待缓存写入结束', total: null });
    const result = await navigator.locks.request(CLEANUP_LOCK, () => navigator.locks.request(sessionLockName(token), async () => {
      let coordination;
      try {
        guard.cleanupProgress?.update({ step: 2, stage: '核对画布与撤销记录', total: null });
        const scan = await requestCoordinator('prepare', { token, mode, sessionVersion: 1 });
        coordination = scan.coordination;
        const fallback = {};
        for (const key of ['infinite-canvas:canvas_store', 'infinite-canvas:asset_store']) fallback[key] = localStorage.getItem(key);
        const progress = update => guard.cleanupProgress?.update(update);
        const cleaned = await cleanUnreferencedMedia(indexedDB, scan, fallback, progress, {
          fetchBlob,
          validateReferences: () => requestCoordinator('validateReferences', { token, coordination }),
        });
        guard.cleanupProgress?.update({ step: 6, stage: '释放页面缓存', total: null });
        const session = await requestCoordinator('releaseMedia', { token, coordination, keys: cleaned.keys, retainedKeys: cleaned.retainedKeys, candidateKeys: cleaned.preserveAllMedia ? [] : cleaned.candidateKeys });
        return { ...getSummary(), ...cleaned, sessionFiles: session.files, sessionBytes: session.bytes };
      } finally {
        guard.cleanupProgress?.update({ step: 7, stage: '恢复页面操作', total: null });
        try { await requestCoordinator('finish', { token, coordination }); }
        finally { guard.cleanupEndpoint?.release(token); }
      }
    }));
    guard.cleanupProgress?.complete(result);
    return result;
  } catch (error) {
    guard.cleanupProgress?.fail(error);
    throw error;
  }
}

export function readCleanupRoots(store, hook, doc, includeAudit = false, getKnownMediaUrls = () => []) {
  if (!store) throw Error('当前标签页尚未接入保护，请先点击浏览器工具栏的本扩展图标。');
  const current = hook?.snapshot();
  const project = store.getState().projects.find(project => project.id === hook?.projectId);
  const localRoots = { current: project ? { ...project, ...current } : null, retained: hook?.retained() };
  const keys = collectMedia(localRoots);
  const referenceData = includeAudit ? collectReferenceData(localRoots, '当前画布与历史') : undefined;
  if (referenceData) {
    referenceData.aliases.push(...getKnownMediaUrls().map(([url, key]) => [url, key, true]));
    appendReferenceData(referenceData, documentReferenceData(doc));
  }
  return {
    referenceData,
    keys: [...keys.keys()],
    projects: store.getState().projects.map(project => ({
      id: project.id, keys: [...collectMedia(project).keys()],
      referenceData: includeAudit ? collectReferenceData(project, `画布 ${project.title || project.id}`) : undefined,
    })),
    liveProjectIds: hook ? [hook.projectId] : [],
    preserveAllMedia: !/^\/canvas(?:\/|$)/.test(location.pathname) || hasUnkeyedBlob(localRoots),
  };
}
