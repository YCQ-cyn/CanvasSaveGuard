import { collectMedia, mediaKey, newerProjects, STORE_KEY } from './core.mjs';
import { collectReferenceData, appendReferenceData, auditTemporaryReferences } from './reference-audit.mjs';
import { recordedDeletionKeys } from './deleted-history.mjs';
import { deletionWindow } from './deletion-grace.mjs';
import { projectDeletionWindow } from './project-deletion.mjs';
import { isMediaTextField } from './media-fields.mjs';

export const CLEANUP_LOCK = 'canvas-save-guard:media-cleanup';

export function withMediaAccess(action) {
  return navigator.locks.request(CLEANUP_LOCK, { mode: 'shared' }, action);
}

function parseState(value) {
  if (typeof value === 'string') return JSON.parse(value);
  return value;
}

export function hasUnkeyedBlob(value, keyedContent = false, nodeType) {
  if (typeof value === 'string') return value.startsWith('blob:') && !keyedContent;
  if (Array.isArray(value)) return value.some(item => hasUnkeyedBlob(item, false, nodeType));
  if (!value || typeof value !== 'object') return false;
  if (['image','video','audio','text','config'].includes(value.type||value.kind))nodeType=value.type||value.kind;
  const keyed = mediaKey(value.storageKey);
  return Object.entries(value).some(([name, item]) => !isMediaTextField(name,item,nodeType) && hasUnkeyedBlob(item, keyed && ['content', 'url', 'dataUrl', 'coverUrl'].includes(name),nodeType));
}

async function openExisting(indexedDB, name) {
  const databases = await indexedDB.databases();
  if (!databases.some(database => database.name === name)) return null;
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function readRoots(db, storeNames, retainedKeys, safety, recordRead, audit, projectRoots, tombstones, nativeTombstones) {
  if (!db || !storeNames.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(storeNames, 'readonly');
    for (const name of storeNames) {
      const request = transaction.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        try {
          recordRead();
          if (name === 'app_state' && cursor.key !== STORE_KEY && cursor.key !== 'infinite-canvas:asset_store') {
            cursor.continue();
            return;
          }
          const value = parseState(cursor.value);
          if (name === 'projects') {
            projectRoots.push({ project: value, label: `保护副本/画布 ${value.title || value.id}` });
          } else if (name === 'deleted') {
            tombstones.push(value);
          } else if (name === 'app_state' && cursor.key === STORE_KEY) {
            for (const project of value?.state?.projects || []) projectRoots.push({ project, label: `画布 ${project.title || project.id}` });
            tombstones.push(...value?.state?.deletedProjects || []);
            nativeTombstones.push(...value?.state?.deletedProjects || []);
          } else {
            if (audit) appendReferenceData(audit, collectReferenceData(value, `${name}/${cursor.key}`));
            collectMedia(value, retainedKeys);
            safety.preserveAllMedia ||= hasUnkeyedBlob(value);
          }
          cursor.continue();
        } catch (error) {
          transaction.abort();
          reject(Error(`缓存引用读取失败，已停止清理。${error.message}`));
        }
      };
    }
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error || Error('缓存引用读取中断，已停止清理。'));
    transaction.onerror = () => {};
  });
}

function inventory(db, names, recordRead) {
  if (!db || !names.length) return Promise.resolve([]);
  return new Promise((resolve, reject) => {
    const entries = [];
    const transaction = db.transaction(names, 'readonly');
    for (const name of names) {
      const request = transaction.objectStore(name).openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        entries.push({ store: name, key: cursor.key, bytes: cursor.value?.size || cursor.value?.blob?.size || 0 });
        recordRead();
        cursor.continue();
      };
    }
    transaction.oncomplete = () => resolve(entries);
    transaction.onabort = () => reject(transaction.error || Error('缓存扫描中断。'));
    transaction.onerror = () => {};
  });
}

function removeEntries(db, entries, committed) {
  if (!db || !entries.length) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([...new Set(entries.map(entry => entry.store))], 'readwrite');
    for (const entry of entries) transaction.objectStore(entry.store).delete(entry.key);
    transaction.oncomplete = () => { committed(entries.length); resolve(); };
    transaction.onabort = () => reject(transaction.error || Error('缓存清理写入中断，可以重新点击清理。'));
    transaction.onerror = () => {};
  });
}

function countEntries(db, names) {
  if (!db || !names.length) return Promise.resolve(0);
  return new Promise((resolve, reject) => {
    let count = 0;
    const transaction = db.transaction(names, 'readonly');
    for (const name of names) {
      const request = transaction.objectStore(name).count();
      request.onsuccess = () => { count += request.result; };
    }
    transaction.oncomplete = () => resolve(count);
    transaction.onabort = () => reject(transaction.error || Error('缓存数量读取中断。'));
    transaction.onerror = () => {};
  });
}

function summarizeEntries(entries) {
  return {
    files: new Set(entries.map(entry => entry.key)).size,
    copies: entries.length,
    bytes: entries.reduce((total, entry) => total + entry.bytes, 0),
  };
}

// Counts identify media by storage key; bytes include every stored copy and
// preview. This reports payload sizes, not the browser's database overhead.
function summarizeInventory(entries, candidates, retained, preserveAllMedia) {
  const groups = { inUse: [], untracked: [], unverifiable: [], removed: [] };
  for (const entry of entries) {
    const group = retained.has(entry.key) ? 'inUse'
      : !candidates.has(entry.key) ? 'untracked'
      : preserveAllMedia ? 'unverifiable' : 'removed';
    groups[group].push(entry);
  }
  return {
    scanned: summarizeEntries(entries),
    retained: summarizeEntries([...groups.inUse, ...groups.untracked, ...groups.unverifiable]),
    ...Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, summarizeEntries(items)])),
  };
}

export async function cleanUnreferencedMedia(indexedDB, scan, localFallback = {}, progress = () => {}, options = {}) {
  if (scan.mode && !['deleted', 'deleted-audited'].includes(scan.mode)) throw Error('此旧清理接口已停用，请使用面板中的清理按钮。');
  progress({ step: 3, stage: '正在核对图片引用', total: null });
  const retained = new Map(scan.keys.map(key => [key, []]));
  const candidates = new Set(scan.candidateKeys);
  const safety = { preserveAllMedia: scan.preserveAllMedia };
  const auditing = scan.mode === 'deleted-audited';
  const audit = auditing ? { aliases: [...scan.referenceData.aliases], urls: [...scan.referenceData.urls] } : null;
  const liveProjectIds = new Set(scan.liveProjectIds);
  const original = await openExisting(indexedDB, 'infinite-canvas');
  const vault = await openExisting(indexedDB, 'canvas-save-guard');
  try {
    const projectRoots = [], tombstones = [], nativeTombstones = [];
    const originalRoots = ['app_state', 'image_generation_logs', 'video_generation_logs', 'agent_chat_messages']
      .filter(name => original?.objectStoreNames.contains(name));
    const protectedRoots = ['projects', 'deleted'].filter(name => vault?.objectStoreNames.contains(name));
    const candidateStores = vault?.objectStoreNames.contains('cleanup_candidates') ? ['cleanup_candidates'] : [];
    const fallbackEntries = Object.entries(localFallback).filter(([, raw]) => raw);
    const rootCounts = await Promise.all([
      countEntries(original, originalRoots), countEntries(vault, protectedRoots), countEntries(vault, candidateStores),
    ]);
    const rootTotal = rootCounts.reduce((total, count) => total + count, fallbackEntries.length);
    let referencesRead = 0;
    const referenceProgress = () => progress({ step: 3, stage: '正在核对图片引用', current: referencesRead, total: rootTotal });
    const recordRead = () => { referencesRead += 1; referenceProgress(); };
    referenceProgress();
    await readRoots(original, originalRoots, retained, safety, recordRead, audit, projectRoots, tombstones, nativeTombstones);
    await readRoots(vault, protectedRoots, retained, safety, recordRead, audit, projectRoots, tombstones, nativeTombstones);
    const deletionRecords = [];
    if (vault?.objectStoreNames.contains('cleanup_candidates')) {
      await new Promise((resolve, reject) => {
        const transaction = vault.transaction('cleanup_candidates', 'readonly');
        const request = transaction.objectStore('cleanup_candidates').openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          deletionRecords.push(cursor.value);
          recordRead();
          cursor.continue();
        };
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error('删除缓存记录读取中断。'));
      });
      for (const key of recordedDeletionKeys(deletionRecords, scan.projectId)) candidates.add(key);
      const pending = deletionWindow(deletionRecords, scan.projectId).pending;
      const pendingRecords = [...deletionRecords.filter(record => record.source !== 'user-delete'), ...pending];
      for (const key of recordedDeletionKeys(pendingRecords, scan.projectId, Infinity)) { candidates.delete(key); retained.set(key, []); }
    }
    for (const [key, raw] of fallbackEntries) {
      const value = parseState(raw);
      if (key === STORE_KEY) {
        for (const project of value.state?.projects || []) {
          projectRoots.push({ project, label: `本地画布 ${project.title || project.id}` });
        }
        tombstones.push(...value.state?.deletedProjects || []);
        nativeTombstones.push(...value.state?.deletedProjects || []);
      } else {
        if (audit) appendReferenceData(audit, collectReferenceData(value, key));
        collectMedia(value, retained);
        safety.preserveAllMedia ||= hasUnkeyedBlob(value);
      }
      recordRead();
    }

    const latest = new Map(newerProjects([], projectRoots.map(root => root.project), tombstones).map(project => [project.id, project]));
    const projectWindow = projectDeletionWindow({ nativeTombstones, tombstones, projects: projectRoots.map(root => root.project),
      liveProjects: [...latest.values()], liveProjectIds: [...liveProjectIds], records: deletionRecords });
    for (const project of projectWindow.ready) for (const key of project.keys) candidates.add(key);
    for (const project of projectWindow.pending) for (const key of project.keys) { candidates.delete(key); retained.set(key, []); }
    for (const { project, label } of projectRoots) {
      const chosen = latest.get(project.id);
      const keep = !liveProjectIds.has(project.id) && chosen && (project.updatedAt || '') >= (chosen.updatedAt || '');
      if (audit) appendReferenceData(audit, collectReferenceData(project, label, !!keep));
      if (keep) {
        collectMedia(project, retained);
        safety.preserveAllMedia ||= hasUnkeyedBlob(project);
      }
    }

    const originalStores = ['image_files', 'media_files', 'image_previews']
      .filter(name => original?.objectStoreNames.contains(name));
    const protectedStores = vault?.objectStoreNames.contains('media') ? ['media'] : [];
    progress({ step: 4, stage: '正在扫描缓存文件', total: null });
    const mediaCounts = await Promise.all([countEntries(original, originalStores), countEntries(vault, protectedStores)]);
    const mediaTotal = mediaCounts[0] + mediaCounts[1];
    let mediaRead = 0;
    const mediaProgress = () => progress({ step: 4, stage: '正在扫描缓存文件', current: mediaRead, total: mediaTotal });
    mediaProgress();
    const mediaRecordRead = () => { mediaRead += 1; mediaProgress(); };
    const originalEntries = await inventory(original, originalStores, mediaRecordRead);
    const protectedEntries = await inventory(vault, protectedStores, mediaRecordRead);
    let auditResult;
    if (auditing) {
      const entries = [...originalEntries.map(entry => ({ ...entry, database: 'original' })), ...protectedEntries.map(entry => ({ ...entry, database: 'vault' }))];
      const candidateEntries = entries.filter(entry => candidates.has(entry.key));
      const databases = { original, vault };
      const readBlob = entry => new Promise((resolve, reject) => {
        const request = databases[entry.database].transaction(entry.store).objectStore(entry.store).get(entry.key);
        request.onsuccess = () => resolve(request.result?.blob || request.result);
        request.onerror = () => reject(request.error);
      });
      auditResult = await auditTemporaryReferences(audit, candidateEntries, readBlob, options.fetchBlob, progress);
      for (const key of auditResult.keys) retained.set(key, []);
      safety.preserveAllMedia = auditResult.unresolved.length > 0;
      await options.validateReferences();
    }
    const canRemove = entry => candidates.has(entry.key) && !safety.preserveAllMedia && !retained.has(entry.key);
    const removingOriginal = originalEntries.filter(canRemove);
    const removingProtected = protectedEntries.filter(canRemove);
    const removalTotal = removingOriginal.length + removingProtected.length;
    let committed = 0;
    const removalProgress = () => progress({ step: 5, stage: '正在清理已删除文件', current: committed, total: removalTotal });
    removalProgress();
    const deletionCommitted = count => { committed += count; removalProgress(); };
    await removeEntries(original, removingOriginal, deletionCommitted);
    await removeEntries(vault, removingProtected, deletionCommitted);
    let projectBackups = 0;
    if (!safety.preserveAllMedia && vault?.objectStoreNames.contains('projects')) {
      const backups = projectWindow.ready.filter(project => projectRoots.some(root => root.project.id === project.id));
      // Retain the exact authorization after dropping a deleted backup, so
      // shared files can be retried later and old copies cannot resurrect it.
      if (vault.objectStoreNames.contains('deleted') && projectWindow.ready.length) await new Promise((resolve, reject) => {
        const transaction = vault.transaction('deleted', 'readwrite');
        for (const project of projectWindow.ready) transaction.objectStore('deleted').put({
          id: project.id, at: new Date(project.deletedAt).toISOString(), source: 'user-delete-project', keys: project.keys,
        }, project.id);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error('已删除画布的文件归属保存失败。'));
      });
      await removeEntries(vault, backups.map(project => ({ store: 'projects', key: project.id })), count => { projectBackups += count; });
    }
    const removed = [...removingOriginal, ...removingProtected];
    const untracked = new Map();
    for (const entry of [...originalEntries, ...protectedEntries]) {
      if (candidates.has(entry.key) || retained.has(entry.key)) continue;
      const detail = untracked.get(entry.key) || { key: entry.key, bytes: 0, owners: deletionRecords.filter(record => ['node-media','generated-media'].includes(record.source) && record.key === entry.key).map(record => ({ projectId: record.projectId, nodeId: record.nodeId, imageId: record.imageId })) };
      detail.bytes += entry.bytes;
      untracked.set(entry.key, detail);
    }
    return {
      mode: scan.mode || 'deleted',
      audit: auditResult,
      statistics: summarizeInventory([...originalEntries, ...protectedEntries], candidates, retained, safety.preserveAllMedia),
      keys: [...new Set(removed.map(entry => entry.key))],
      bytes: removed.reduce((total, entry) => total + entry.bytes, 0),
      retainedKeys: [...retained.keys()],
      candidateKeys: [...candidates],
      preserveAllMedia: safety.preserveAllMedia,
      untrackedMedia: [...untracked.values()],
      deletedProjects: { total: projectWindow.ready.length, media: new Set(projectWindow.ready.flatMap(project => project.keys)).size, backups: projectBackups },
    };
  } finally {
    original?.close();
    vault?.close();
  }
}
