import { mediaKey } from './core.mjs';
import { collectReferenceData } from './reference-audit.mjs';
import { recordedDeletionKeys } from './deleted-history.mjs';

const categoryNames = { display: '图片/媒体本体及组内结果', reference: '生成参考素材', other: '其他当前画布数据' };
const size = bytes => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;

// One traversal records the actual fields, including offscreen/collapsed nodes.
// It mirrors conservative key retention; a report never authorizes deletion.
export function currentMediaSources(project, knownUrls = []) {
  const aliases = new Map([...knownUrls, ...collectReferenceData(project, '').aliases]);
  const sources = new Map(), unkeyedUrls = new Set();
  const active = new WeakSet();
  function visit(value, path, node) {
    if (typeof value === 'string') {
      const textField = /(?:^|\.)(?:prompt|title|text|composerContent|errorDetails)$/.test(path)
        || path === 'metadata.content' && ['text', 'config'].includes(node?.type);
      const key = mediaKey(value) ? value : !textField && value.startsWith('blob:') ? aliases.get(value) : null;
      if (mediaKey(key)) {
        const category = /(?:^|\.)(?:references|referenceImages|referenceVideos|referenceAudios)(?:\.|\[|$)/.test(path) ? 'reference'
          : node && /^metadata\.(?:storageKey|content|images\[\d+\]\.(?:storageKey|content))$/.test(path) ? 'display' : 'other';
        const owner = { category, nodeId: node?.id, title: node?.title, path };
        if (!sources.has(key)) sources.set(key, []);
        const list = sources.get(key);
        if (!list.some(item => item.nodeId === owner.nodeId && item.path === path)) list.push(owner);
      } else if (!textField && value.startsWith('blob:')) unkeyedUrls.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || active.has(value)) return;
    active.add(value);
    if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${i}]`, node));
    else for (const [name, item] of Object.entries(value)) visit(item, path ? `${path}.${name}` : name, node);
    active.delete(value);
  }
  for (const node of project.nodes || []) visit(node, '', node);
  for (const [field, value] of Object.entries(project)) if (field !== 'nodes') visit(value, field);
  return { sources, unkeyedUrls: unkeyedUrls.size };
}

export function createMediaReport(project, entries, records = [], knownUrls = []) {
  const { sources, unkeyedUrls } = currentMediaSources(project, knownUrls);
  const inventory = new Map();
  for (const entry of entries) {
    if (!mediaKey(entry.key)) continue;
    if (!inventory.has(entry.key)) inventory.set(entry.key, { key: entry.key, bytes: 0, copies: [] });
    const file = inventory.get(entry.key);
    file.bytes += entry.bytes;
    file.copies.push({ database: entry.database, store: entry.store, bytes: entry.bytes });
  }
  const mature = recordedDeletionKeys(records, project.id);
  const deleted = recordedDeletionKeys(records, project.id, Infinity);
  const groups = Object.fromEntries(['display', 'reference', 'other', 'outsideCurrent'].map(name => [name, { files: 0, bytes: 0 }]));
  const files = [];
  for (const file of inventory.values()) {
    const owners = sources.get(file.key) || [];
    const category = ['display', 'reference', 'other'].find(name => owners.some(owner => owner.category === name)) || 'outsideCurrent';
    groups[category].files += 1;
    groups[category].bytes += file.bytes;
    files.push({ ...file, owners, category, deletion: mature.has(file.key) ? 'mature' : deleted.has(file.key) ? 'waiting' : 'none' });
  }
  return {
    projectId: project.id, title: project.title, nodes: project.nodes?.length || 0,
    at: new Date().toISOString(), groups, files,
    currentFiles: sources.size,
    missingKeys: [...sources.keys()].filter(key => !inventory.has(key)),
    unkeyedUrls,
  };
}

export function formatMediaReport(report) {
  const describe = (name, group) => `${name} ${group.files} 个，${size(group.bytes)}`;
  const original = report.files.flatMap(file => file.copies).filter(copy => copy.database === 'infinite-canvas');
  const protectedCopies = report.files.flatMap(file => file.copies).filter(copy => copy.database === 'canvas-save-guard');
  const bytes = report.files.reduce((total, file) => total + file.bytes, 0);
  const lines = [
    `当前画布「${report.title || report.projectId}」共 ${report.nodes} 个节点，含屏幕外、折叠、正在生成和失败节点。`,
    `当前画布共引用 ${report.currentFiles} 个媒体编号：`,
    ...Object.entries(categoryNames).map(([name, label]) => describe(label, report.groups[name])),
    describe('当前画布未引用的浏览器媒体', report.groups.outsideCurrent),
    `全站媒体库存 ${report.files.length} 个，${size(bytes)}；不是当前屏幕图片数。`,
    `原站文件/缩略图 ${size(original.reduce((sum, copy) => sum + copy.bytes, 0))}；保护副本 ${size(protectedCopies.reduce((sum, copy) => sum + copy.bytes, 0))}。`,
    '各分类按编号去重；同一文件兼作本体和参考时计入本体。大小包含各份副本。',
    'Windows 粘贴/上传的图片会另存到浏览器；这里不会扫描或清理 Windows 原文件、下载的 ZIP。',
    '当前画布未引用不等于可删除：其他画布、资产、撤销记录也可能使用。',
  ];
  if (report.missingKeys.length) lines.push(`有 ${report.missingKeys.length} 个当前引用在这次库存快照中没有文件：${report.missingKeys.join('、')}`);
  if (report.unkeyedUrls) lines.push(`另有 ${report.unkeyedUrls} 个临时地址没有已知编号，本报告未做内容匹配，不能据此判断可删除。`);
  lines.push('以下是检查时的引用来源，只读检查没有删除任何文件：');
  for (const file of report.files.slice(0, 500)) {
    lines.push(`${file.key} · ${size(file.bytes)} · ${categoryNames[file.category] || '当前画布未引用'}`);
    if (file.deletion !== 'none') lines.push(`  有当前画布删除记录${file.deletion === 'waiting' ? '，仍在一分钟保留期' : ''}${file.owners.length ? '；仍被下面的当前数据引用' : ''}。`);
    for (const owner of file.owners.slice(0, 8)) lines.push(`  ${owner.nodeId ? `节点「${(owner.title || owner.nodeId).slice(0, 36)}」(${owner.nodeId})` : '画布数据'} → ${owner.path}`);
    if (file.owners.length > 8) lines.push(`  另有 ${file.owners.length - 8} 处当前引用。`);
  }
  if (report.files.length > 500) lines.push(`为保持界面流畅，仅展开前 500 个编号的来源；统计包含全部 ${report.files.length} 个。`);
  return lines.join('\n');
}

async function readDatabase(indexedDB, name, stores, projectId) {
  if (!(await indexedDB.databases()).some(database => database.name === name)) return { entries: [], records: [] };
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open(name);
    request.onupgradeneeded = () => request.transaction.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  try {
    const names = [...stores, ...(name === 'canvas-save-guard' ? ['cleanup_candidates'] : [])].filter(store => db.objectStoreNames.contains(store));
    if (!names.length) return { entries: [], records: [] };
    return await new Promise((resolve, reject) => {
      const result = { entries: [], records: [] };
      const transaction = db.transaction(names, 'readonly');
      for (const store of names) {
        const request = transaction.objectStore(store).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          if (store === 'cleanup_candidates') {
            if (cursor.value?.projectId === projectId) result.records.push(cursor.value);
          } else result.entries.push({ database: name, store, key: cursor.key, bytes: cursor.value?.size || cursor.value?.blob?.size || 0 });
          cursor.continue();
        };
      }
      transaction.oncomplete = () => resolve(result);
      transaction.onabort = () => reject(transaction.error || Error('媒体来源读取中断。'));
      transaction.onerror = () => {};
    });
  } finally { db.close(); }
}

export async function inspectCurrentMedia(indexedDB, project, knownUrls = []) {
  // No flush, save, pruning, fetch, hashing, readwrite transaction or cleanup.
  const results = await Promise.all([
    readDatabase(indexedDB, 'infinite-canvas', ['image_files', 'media_files', 'image_previews'], project.id),
    readDatabase(indexedDB, 'canvas-save-guard', ['media'], project.id),
  ]);
  return createMediaReport(project, results.flatMap(result => result.entries), results.flatMap(result => result.records), knownUrls);
}

export function installMediaReport(guard, doc, getProject, getKnownUrls = () => []) {
  const shadow = doc.querySelector('#canvas-save-guard')?.shadowRoot;
  if (!shadow) return;
  if (!getProject) getProject = () => {
    const id = decodeURIComponent(doc.location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || '');
    return doc.defaultView.CanvasSaveGuardNative?.store?.getState().projects.find(project => project.id === id);
  };
  if (!guard.inspectCurrentMedia) guard.inspectCurrentMedia = async () => {
    const project = getProject();
    if (!project) throw Error('请先打开具体画布；更新扩展后可刷新画布启用来源检查。');
    const hook = doc.defaultView.CanvasSaveGuardHistory;
    const snapshot = hook?.ready && hook.projectId === project.id ? { ...project, ...hook.snapshot() } : project;
    return inspectCurrentMedia(doc.defaultView.indexedDB, snapshot, getKnownUrls());
  };
  if (shadow.querySelector('#media-report')) return;
  const button = doc.createElement('button');
  button.id = 'media-report'; button.textContent = '缓存来源';
  button.title = '只读核对当前画布的媒体编号、大小和引用位置，不执行清理。';
  let busy = false;
  button.onclick = async () => {
    if (busy) return;
    busy = true; button.disabled = true; button.textContent = '核对中…';
    try {
      if (guard.cleanupProgress?.read().status === 'running') throw Error('清理正在进行，请完成后再查看来源。');
      const report = await guard.inspectCurrentMedia();
      if (guard.cleanupProgress?.read().status === 'running') throw Error('清理已开始，请完成后再查看来源。');
      guard.cleanupProgress.showReport(formatMediaReport(report));
    } catch (error) {
      // A report failure must not interrupt the cleanup controller or saving.
      shadow.querySelector('#status').textContent = error.message || String(error);
    } finally { busy = false; button.disabled = false; button.textContent = '缓存来源'; }
  };
  shadow.querySelector('.buttons').append(button);
}
