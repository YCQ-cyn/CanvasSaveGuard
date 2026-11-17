const canvasOrigins = ['https://canvas.modelaryx.com', 'https://canvas.best'];
function supportedCanvas(url) {
  try { return canvasOrigins.includes(new URL(url).origin); }
  catch { return false; }
}
async function attach(tab) {
  if(!tab.id||!supportedCanvas(tab.url))return;
  try {
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',files:['cleanup-bridge.js']});
    await chrome.scripting.executeScript({target:{tabId:tab.id},world:'MAIN',files:['guard.js']});
  }
  catch(error) { console.warn('Canvas Save Guard could not attach:',error.message); }
}
chrome.action.onClicked.addListener(attach);
chrome.runtime.onInstalled.addListener(async()=>{
  for(const tab of await chrome.tabs.query({url:canvasOrigins.map(origin=>origin+'/*')}))await attach(tab);
});

const cleanupSessions = new Map();

function mergeSnapshots(snapshots) {
  const liveProjectIds = new Set(snapshots.flatMap(snapshot => snapshot.liveProjectIds));
  const keys = new Set(snapshots.flatMap(snapshot => snapshot.keys));
  const referenceData = { aliases: [], urls: [] };
  for (const snapshot of snapshots) {
    if (snapshot.referenceData) {
      referenceData.aliases.push(...snapshot.referenceData.aliases);
      referenceData.urls.push(...snapshot.referenceData.urls);
    }
    for (const project of snapshot.projects) {
      if (liveProjectIds.has(project.id)) continue;
      for (const key of project.keys) keys.add(key);
      if (project.referenceData) {
        referenceData.aliases.push(...project.referenceData.aliases);
        referenceData.urls.push(...project.referenceData.urls);
      }
    }
  }
  return {
    keys: [...keys], referenceData,
    candidateKeys: [...new Set(snapshots.flatMap(snapshot => snapshot.candidateKeys || []))],
    liveProjectIds: [...liveProjectIds],
    preserveAllMedia: snapshots.some(snapshot => snapshot.preserveAllMedia),
  };
}

function referenceSignature(scan) {
  return JSON.stringify({
    keys: [...scan.keys].sort(),
    urls: [...new Set(scan.referenceData.urls.map(item => item.url))].sort(),
    aliases: [...new Set(scan.referenceData.aliases.map(pair => JSON.stringify(pair)))].sort(),
  });
}

async function reportCleanupProgress(session, update) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId: session.owner }, world: 'MAIN',
      func: (token, progress) => globalThis.CanvasSaveGuard?.cleanupProgress?.receive(token, progress),
      args: [session.token, update],
    });
  } catch {
    // A closed owner page cannot display progress. Cleanup/release still follows
    // its existing error handling independently of this display update.
  }
}

async function callCleanup(tabId, method, args = []) {
  const results = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: async (method, args) => {
      try {
        const endpoint = globalThis.CanvasSaveGuard?.cleanupEndpoint;
        if (!endpoint) throw Error('有画布标签页仍在使用旧版扩展，请保存后更新并重新打开该页。');
        if (method === 'prepare' && endpoint.deletedOnlyVersion !== 1) throw Error('请先保存完整 ZIP，重新打开旧画布标签页后启用按删除记录清理。');
        if (['prepareAudit', 'auditRoots'].includes(method) && endpoint.referenceAuditVersion !== 1) throw Error('请先点击旧画布标签页的扩展图标接入完整引用核对。');
        if (['prepare', 'prepareAudit'].includes(method) && args[2] === 1 && endpoint.cleanupSessionVersion !== 1) {
          throw Error('有画布标签页的清理接口仍是旧版。请保存并刷新本网站的画布标签页，再重试清理。');
        }
        if(method==='commitAudit'&&endpoint.interactiveAuditVersion!==1)method='auditRoots';
        return { ok: true, data: await endpoint[method](...args) };
      } catch (error) {
        return { ok: false, error: error.message || String(error) };
      }
    },
    args: [method, args],
  });
  if (!results.length || results[0].error) throw Error(results[0]?.error?.message || '无法读取画布标签页。');
  const response = results[0].result;
  if (!response?.ok) throw Error(response?.error || '画布标签页没有返回核对结果。');
  const data = response.data;
  if (['prepare', 'prepareAudit', 'auditRoots', 'commitAudit'].includes(method) && (!Array.isArray(data?.keys) || !Array.isArray(data?.projects) || !Array.isArray(data?.liveProjectIds))) {
    throw Error('画布引用数据不完整，已停止清理。');
  }
  return data;
}

async function releaseCleanup(session) {
  let completed = 0;
  await reportCleanupProgress(session, { step: 7, stage: '正在恢复页面操作', current: 0, total: session.tabs.length });
  await Promise.allSettled(session.tabs.map(async tabId => {
    try { await callCleanup(tabId, 'release', [session.token]); }
    finally {
      completed += 1;
      await reportCleanupProgress(session, { step: 7, stage: '正在恢复页面操作', current: completed, total: session.tabs.length });
    }
  }));
  cleanupSessions.delete(session.token);
}

async function recoverCleanupSession(token, coordination, sender) {
  const origin = new URL(sender.tab.url).origin;
  if (coordination?.sessionVersion !== 1 || coordination.origin !== origin || coordination.owner !== sender.tab.id
    || !['deleted', 'deleted-audited'].includes(coordination.mode)
    || !Array.isArray(coordination.tabs) || !coordination.tabs.every(Number.isInteger)
    || !coordination.tabs.includes(sender.tab.id)
    || coordination.mode !== 'deleted' && typeof coordination.referenceSignature !== 'string') {
    throw Error('清理会话已失效，请重新点击清理。');
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: sender.tab.id }, world: 'MAIN',
    func: async token => {
      const { held } = await navigator.locks.query();
      const session = held.find(lock => lock.name === `canvas-save-guard:media-cleanup:session:${token}` && lock.mode === 'exclusive');
      return !!session && held.some(lock => lock.name === 'canvas-save-guard:media-cleanup'
        && lock.mode === 'exclusive' && lock.clientId === session.clientId);
    },
    args: [token],
  });
  if (results[0]?.result !== true) throw Error('清理会话已结束，请重新点击清理。');
  const tabs = await chrome.tabs.query({ url: origin + '/*' });
  const currentIds = new Set(tabs.map(tab => tab.id));
  if (coordination.tabs.some(tabId => !currentIds.has(tabId))) throw Error('核对期间画布标签页发生变化，请重新清理。');
  const session = { ...coordination, token, owner: sender.tab.id, tabs: [...new Set(coordination.tabs)] };
  cleanupSessions.set(token, session);
  return session;
}

async function coordinateCleanup(message, sender) {
  if (!supportedCanvas(sender.tab?.url)) throw Error('清理只能从画布网站发起。');
  const { token } = message.data;
  if (message.action === 'prepare') {
    const mode = message.data.mode || 'deleted';
    if (!['deleted', 'deleted-audited'].includes(mode)) throw Error('扩大范围的清理已停用，请使用面板中的清理按钮。');
    const tabs = await chrome.tabs.query({ url: new URL(sender.tab.url).origin + '/*' });
    const session = { token, mode, owner: sender.tab.id, origin: new URL(sender.tab.url).origin,
      sessionVersion: message.data.sessionVersion === 1 ? 1 : 0, tabs: tabs.map(tab => tab.id) };
    cleanupSessions.set(token, session);
    try {
      let completed = 0;
      await reportCleanupProgress(session, { step: 2, stage: '正在核对画布与撤销记录', current: 0, total: session.tabs.length });
      const prepared = await Promise.allSettled(session.tabs.map(async tabId => {
        const snapshot = await callCleanup(tabId, mode === 'deleted' ? 'prepare' : 'prepareAudit', [token, tabId === session.owner, session.sessionVersion]);
        completed += 1;
        await reportCleanupProgress(session, { step: 2, stage: '正在核对画布与撤销记录', current: completed, total: session.tabs.length });
        return snapshot;
      }));
      const failed = prepared.find(result => result.status === 'rejected');
      if (failed) throw failed.reason;
      const snapshots = prepared.map(result => result.value);
      const latestTabs = await chrome.tabs.query({ url: new URL(sender.tab.url).origin + '/*' });
      if (latestTabs.some(tab => !session.tabs.includes(tab.id))) throw Error('清理时打开了新画布，请再点击一次清理。');
      const scan = mergeSnapshots(snapshots);
      if (mode !== 'deleted') session.referenceSignature = referenceSignature(scan);
      return {
        ...scan, mode,
        coordination: { origin: session.origin, owner: session.owner, mode, tabs: session.tabs, sessionVersion: session.sessionVersion,
          referenceSignature: session.referenceSignature },
        projectId: decodeURIComponent(new URL(sender.tab.url).pathname.split('/')[2] || ''),
      };
    } catch (error) {
      await releaseCleanup(session);
      throw error;
    }
  }
  let session = cleanupSessions.get(token);
  if (message.action === 'finish') {
    if (session && session.owner !== sender.tab.id) throw Error('只能由发起清理的标签页继续。');
    if (!session) {
      // A restarted worker has an empty Map. Release this exact token in all
      // same-origin tabs rather than reporting success without contacting them.
      const tabs = await chrome.tabs.query({ url: new URL(sender.tab.url).origin + '/*' });
      session = { token, owner: sender.tab.id, tabs: tabs.map(tab => tab.id) };
    }
    await releaseCleanup(session);
    return {};
  }
  if (!session) session = await recoverCleanupSession(token, message.data.coordination, sender);
  if (session.owner !== sender.tab.id) throw Error('只能由发起清理的标签页继续。');
  if (message.action === 'validateReferences') {
    if (session.mode === 'deleted') throw Error('当前会话尚未启用完整引用核对。');
    const tabs = await chrome.tabs.query({ url: new URL(sender.tab.url).origin + '/*' });
    if (tabs.some(tab => !session.tabs.includes(tab.id))) throw Error('核对期间打开了新画布，请重新清理。');
    const snapshots = await Promise.all(session.tabs.map(tabId => callCleanup(tabId, 'commitAudit', [token])));
    if (referenceSignature(mergeSnapshots(snapshots)) !== session.referenceSignature) throw Error('核对期间图片引用发生变化，请重新点击清理。');
    return {};
  }
  if (message.action === 'releaseMedia') {
    const { keys, retainedKeys, candidateKeys } = message.data;
    let completed = 0;
    await reportCleanupProgress(session, { step: 6, stage: '正在释放页面缓存', current: 0, total: session.tabs.length });
    const results = await Promise.all(session.tabs.map(async tabId => {
      const result = await callCleanup(tabId, 'releaseMedia', [token, keys, retainedKeys, candidateKeys]);
      completed += 1;
      await reportCleanupProgress(session, { step: 6, stage: '正在释放页面缓存', current: completed, total: session.tabs.length });
      return result;
    }));
    return results.reduce((total, result) => ({ files: total.files + result.files, bytes: total.bytes + result.bytes }), { files: 0, bytes: 0 });
  }
  throw Error('未知的缓存清理操作。');
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.type !== 'canvas-guard-cleanup') return;
  coordinateCleanup(message, sender).then(result => respond({ result }), error => respond({ error: error.message }));
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  for (const session of cleanupSessions.values()) if (session.owner === tabId) void releaseCleanup(session);
});
