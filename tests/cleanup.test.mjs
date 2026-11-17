import test from 'node:test';
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { collectDeletedMedia, pruneDeletedHistory, recordedDeletionKeys } from '../src/deleted-history.mjs';
import { cleanUnreferencedMedia, hasUnkeyedBlob } from '../src/cleanup-storage.mjs';
import { Vault } from '../src/vault.mjs';
import { nodeMediaOwners } from '../src/media-ownership.mjs';

const node = (id, status = 'success', key = `image:${id}`) => ({
  id, type: 'image', title: id, position: { x: 10, y: 20 }, width: 100, height: 100,
  metadata: { status, storageKey: key, prompt: 'preserve this prompt', references: ['image:reference'] },
});
const link = (id, from, to) => ({ id, fromNodeId: from, toNodeId: to });

test('late generated files require a later explicit deletion of their exact node or inline image', () => {
  const records = [
    { source: 'user-delete', projectId: 'current', nodeIds: ['deleted'], images: [{ nodeId: 'batch', imageId: 'removed' }], keys: ['image:old'], deletedAt: 20 },
    { source: 'generated-media', projectId: 'current', nodeId: 'deleted', key: 'image:late', startedAt: 10 },
    { source: 'generated-media', projectId: 'current', nodeId: 'deleted', key: 'image:new-request', startedAt: 30 },
    { source: 'generated-media', projectId: 'current', nodeId: 'batch', imageId: 'removed', key: 'image:late-item', startedAt: 15 },
    { source: 'generated-media', projectId: 'current', nodeId: 'batch', imageId: 'kept', key: 'image:kept', startedAt: 15 },
    { source: 'generated-media', projectId: 'other', nodeId: 'deleted', key: 'image:other-project', startedAt: 10 },
    { source: 'generated-media', projectId: 'current', nodeId: 'unknown', key: 'image:untracked', startedAt: 10 },
  ];
  assert.deepEqual([...recordedDeletionKeys(records, 'current')], ['image:old', 'image:late', 'image:late-item']);
  assert.deepEqual([...recordedDeletionKeys(records.filter(record => record.source !== 'user-delete'), 'current')], []);
});

test('observed node media needs its later explicit deletion and never claims prompt text or another canvas', () => {
  const project = { id: 'current', nodes: [{ id: 'node', type: 'image', metadata: { storageKey: 'image:owned', content: 'blob:owned', prompt: 'image:unrelated', images: [{ id: 'child', storageKey: 'image:child' }] } }] };
  const owners = nodeMediaOwners(project, 10).map(owner => ({ ...owner, source: 'node-media' }));
  assert.ok(!owners.some(owner => owner.key === 'image:unrelated'));
  assert.deepEqual([...recordedDeletionKeys(owners, 'current')], []);
  const deletion = { source: 'user-delete', projectId: 'current', nodeIds: ['node'], images: [], keys: [], deletedAt: 20 };
  assert.deepEqual([...recordedDeletionKeys([...owners, deletion], 'current')].sort(), ['image:child', 'image:owned']);
  assert.deepEqual([...recordedDeletionKeys([...owners, { ...deletion, deletedAt: 5 }], 'current')], []);
  assert.deepEqual([...recordedDeletionKeys([...owners, { ...deletion, projectId: 'other' }], 'current')], []);
  const childDeletion = { ...deletion, nodeIds: [], images: [{ nodeId: 'node', imageId: 'child' }] };
  assert.deepEqual([...recordedDeletionKeys([...owners, childDeletion], 'current')], ['image:child']);
});

test('deleted legacy representative is removed from old root copies while a shared live reference remains byte-identical', () => {
  const root = { ...node('root', 'success', 'image:removed'), metadata: { ...node('root').metadata, storageKey: 'image:removed', isBatchRoot: true, primaryImageId: 'removed', batchChildIds: ['removed','kept'] } };
  const removed = { ...node('removed'), metadata: { ...node('removed').metadata, batchRootId: 'root' } };
  const kept = { ...node('kept'), metadata: { ...node('kept').metadata, batchRootId: 'root' } };
  const liveRoot = { ...root, metadata: { ...root.metadata, storageKey: 'image:kept', primaryImageId: 'kept', batchChildIds: ['kept'] } };
  const current = { nodes: [liveRoot,kept,node('shared', 'success','image:removed')], connections: [] };
  const before = JSON.stringify(current);
  const entry = { nodes: [root,removed,kept], connections: [] };
  const retained = { history: { past: [entry], future: [] }, clipboard: entry };
  const cleaned = pruneDeletedHistory(current, retained, { nodeIds: ['removed'], connectionIds: [] });
  assert.equal(cleaned.history.past[0].nodes[0].metadata.storageKey, 'image:kept');
  assert.equal(cleaned.history.past[0].nodes[0].metadata.primaryImageId, 'kept');
  assert.equal(JSON.stringify(current), before);
  assert.ok(cleaned.summary.candidateKeys.includes('image:removed'));
});

test('deleted-node file authorization excludes storage-key-looking text and prompts', () => {
  const deleted = { id: 'deleted', type: 'text', metadata: { prompt: 'image:unrelated-prompt', content: 'image:unrelated-content', storageKey: 'image:owned', references: ['image:reference'] } };
  assert.deepEqual([...collectDeletedMedia([deleted]).keys()], ['image:owned', 'image:reference']);
});

test('unidentifiable live blob references keep media while normally keyed pictures allow scoped cleanup', () => {
  assert.equal(hasUnkeyedBlob({ nodes: [{ metadata: { content: 'blob:live', storageKey: 'image:live' } }] }), false);
  assert.equal(hasUnkeyedBlob({ nodes: [{ metadata: { content: 'blob:live' } }] }), true);
  assert.equal(hasUnkeyedBlob({ metadata: { references: ['blob:reference'] } }), true);
});

test('deleted-history pruning preserves every byte of current nodes, including empty/loading/error nodes', () => {
  const current = { nodes: [node('visible'), node('loading', 'loading'), node('failed', 'error'), { id: 'empty', type: 'image', metadata: {} }], connections: [link('kept', 'visible', 'loading')] };
  const before = JSON.stringify(current);
  const old = { nodes: [...current.nodes, node('deleted'), { id: 'deleted-empty', type: 'image', metadata: { status: 'idle' } }], connections: [...current.connections, link('deleted-link', 'loading', 'failed')] };
  const retained = { history: { past: [old], future: [old] }, clipboard: old, agent: { ...old, selectedNodeIds: ['visible', 'deleted'] } };
  const retainedBefore = JSON.stringify(retained);
  const result = pruneDeletedHistory(current, retained, { nodeIds: ['deleted', 'deleted-empty'], connectionIds: ['deleted-link'] });
  assert.equal(JSON.stringify(current), before);
  assert.equal(JSON.stringify(retained), retainedBefore);
  assert.deepEqual(result.history.past[0].nodes, current.nodes);
  assert.deepEqual(result.history.future[0].connections, current.connections);
  assert.deepEqual(result.agent.selectedNodeIds, ['visible']);
  assert.equal(result.summary.nodes, 2);
  assert.equal(result.summary.connections, 1);
  assert.ok(result.summary.candidateKeys.includes('image:deleted'));
  assert.ok(!result.summary.candidateKeys.includes('image:visible'));
});

test('history cleanup preserves offscreen, folded and undone-created objects without an explicit deletion record', () => {
  const current = { nodes: [node('visible'), { ...node('offscreen'), position: { x: 100000, y: 100000 } }, { ...node('folded'), metadata: { ...node('folded').metadata, batchRootId: 'visible' } }], connections: [] };
  const entry = { nodes: [...current.nodes, node('deleted'), node('undo-created')], connections: [link('deleted-link', 'visible', 'deleted'), link('older-deleted-link', 'visible', 'deleted'), link('undo-link', 'visible', 'undo-created')] };
  const retained = { history: { past: [entry], future: [entry] }, clipboard: entry, agent: entry };
  const unchanged = pruneDeletedHistory(current, retained);
  assert.deepEqual(unchanged.history.past[0], entry);
  const result = pruneDeletedHistory(current, retained, { nodeIds: ['deleted'], connectionIds: ['deleted-link'] });
  assert.deepEqual(result.history.future[0].nodes.map(node => node.id), ['visible', 'offscreen', 'folded', 'undo-created']);
  assert.deepEqual(result.clipboard.connections.map(connection => connection.id), ['undo-link']);
  assert.ok(!result.summary.candidateKeys.includes('image:undo-created'));
  assert.ok(!result.summary.candidateKeys.includes('image:offscreen'));
});

function openDatabase(name, version, stores) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, version);
    request.onupgradeneeded = () => { for (const store of stores) request.result.createObjectStore(store); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function write(db, records) {
  return new Promise((resolve, reject) => {
    const transaction = db.transaction([...new Set(records.map(item => item.store))], 'readwrite');
    for (const item of records) transaction.objectStore(item.store).put(item.value, item.key);
    transaction.oncomplete = resolve;
    transaction.onabort = () => reject(transaction.error);
  });
}
function read(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test('physical cleanup deletes only tracked deleted files and preserves all live/referenced/unattributed bytes', async () => {
  const original = await openDatabase('infinite-canvas', 1, ['app_state', 'image_files', 'media_files', 'image_previews', 'image_generation_logs', 'video_generation_logs']);
  const vault = new Vault(indexedDB);
  const bytes = new Blob(['original media bytes'], { type: 'image/png' });
  const keep = ['image:visible', 'image:loading', 'image:failed', 'image:reference', 'image:asset', 'image:workbench', 'image:other-project', 'image:other-tab', 'image:unattributed'];
  const entries = [...keep, 'image:deleted'];
  const current = { id: 'current', nodes: [node('visible'), node('loading', 'loading'), node('failed', 'error')] };
  const oldCurrent = { id: 'current', nodes: [...current.nodes, node('deleted')] };
  await vault.protect([oldCurrent], new Map(entries.map(key => [key, bytes])));
  await vault.recordDeletedObjects('current', ['image:deleted', ...keep.filter(key => key !== 'image:unattributed')].map(key => ({ id: key, metadata: { storageKey: key } })), [], [], Date.now()-60001);
  // Legacy inferred candidates do not prove a native Delete action.
  await vault.recordDeletedMedia('current', ['image:unattributed']);
  const records = entries.map(key => ({ store: 'image_files', key, value: bytes }));
  records.push(
    { store: 'image_previews', key: 'image:deleted', value: { blob: bytes } },
    { store: 'app_state', key: 'infinite-canvas:canvas_store', value: JSON.stringify({ state: { projects: [oldCurrent, { id: 'other', nodes: [node('other-project')] }] } }) },
    { store: 'app_state', key: 'infinite-canvas:asset_store', value: JSON.stringify({ state: { assets: [{ data: { storageKey: 'image:asset' } }] } }) },
    { store: 'image_generation_logs', key: 'log', value: { references: ['image:workbench'] } },
  );
  await write(original, records);
  const progress = [];
  const result = await cleanUnreferencedMedia(indexedDB, {
    projectId: 'current', liveProjectIds: ['current'],
    keys: ['image:visible', 'image:loading', 'image:failed', 'image:reference', 'image:other-tab'],
    candidateKeys: ['image:deleted'], preserveAllMedia: false,
  }, {}, update => progress.push(update));
  for (const step of [3, 4, 5]) {
    const updates = progress.filter(update => update.step === step);
    const last = updates.at(-1);
    assert.ok(updates.length > 0);
    assert.equal(last.current, last.total);
    assert.ok(last.total > 0);
  }
  assert.equal(progress.filter(update => update.step === 5).at(-1).current, 3);
  assert.deepEqual(result.keys, ['image:deleted']);
  assert.deepEqual(result.statistics, {
    scanned: { files: 10, copies: 21, bytes: bytes.size * 21 },
    retained: { files: 9, copies: 18, bytes: bytes.size * 18 },
    inUse: { files: 8, copies: 16, bytes: bytes.size * 16 },
    untracked: { files: 1, copies: 2, bytes: bytes.size * 2 },
    unverifiable: { files: 0, copies: 0, bytes: 0 },
    removed: { files: 1, copies: 3, bytes: bytes.size * 3 },
  });
  assert.equal(result.bytes, result.statistics.removed.bytes);
  assert.equal(await read(original, 'image_files', 'image:deleted'), undefined);
  assert.equal(await read(original, 'image_previews', 'image:deleted'), undefined);
  assert.equal(await vault.get('media', 'image:deleted'), undefined);
  for (const key of keep) {
    assert.equal(await (await read(original, 'image_files', key)).text(), 'original media bytes');
    assert.equal(await (await vault.get('media', key)).text(), 'original media bytes');
  }
  assert.deepEqual(JSON.parse(await read(original, 'app_state', 'infinite-canvas:canvas_store')).state.projects[0], oldCurrent);

  // A bare blob reference blocks physical deletion. Report the retained
  // deleted files and their actual copies/bytes rather than a vague warning.
  await write(original, [{ store: 'image_files', key: 'image:blocked', value: bytes }]);
  await vault.protect([], new Map([['image:blocked', bytes]]));
  await vault.recordDeletedObjects('current', [{ id: 'blocked', metadata: { storageKey: 'image:blocked' } }], [], [], Date.now()-60001);
  const blocked = await cleanUnreferencedMedia(indexedDB, {
    projectId: 'current', liveProjectIds: ['current'],
    keys: ['image:visible', 'image:loading', 'image:failed', 'image:reference', 'image:other-tab'],
    candidateKeys: [], preserveAllMedia: false,
  }, { 'infinite-canvas:asset_store': JSON.stringify({ references: ['blob:unknown-reference'] }) });
  assert.equal(blocked.preserveAllMedia, true);
  assert.deepEqual(blocked.keys, []);
  assert.equal(blocked.bytes, 0);
  assert.deepEqual(blocked.statistics.unverifiable, { files: 1, copies: 2, bytes: bytes.size * 2 });
  assert.equal(blocked.statistics.scanned.files, 10);
  assert.equal(blocked.statistics.scanned.bytes, bytes.size * 20);
  assert.deepEqual(blocked.statistics.retained, blocked.statistics.scanned);
  assert.equal(await (await read(original, 'image_files', 'image:blocked')).text(), 'original media bytes');
  assert.equal(await (await vault.get('media', 'image:blocked')).text(), 'original media bytes');
  original.close();
});



test('v0.20 batch-image deletion prunes that image from history while every current node stays byte-identical', () => {
  const kept = { id: 'kept', storageKey: 'image:kept', content: 'blob:kept' };
  const removed = { id: 'removed', storageKey: 'image:removed', content: 'blob:removed' };
  const current = { nodes: [{ id: 'batch', metadata: { images: [kept], primaryImageId: 'kept', storageKey: 'image:kept' } }], connections: [] };
  const old = { nodes: [{ id: 'batch', metadata: { images: [kept, removed], primaryImageId: 'removed', storageKey: 'image:removed', content: 'blob:removed' } }], connections: [] };
  const before = JSON.stringify(current);
  const result = pruneDeletedHistory(current, { history: { past: [old], future: [old] } }, { nodeIds: [], connectionIds: [], images: [{ nodeId: 'batch', imageId: 'removed' }] });
  assert.equal(JSON.stringify(current), before);
  assert.equal(result.summary.nodes, 0);
  assert.equal(result.summary.images, 1);
  assert.deepEqual(result.summary.candidateKeys, ['image:removed']);
  assert.deepEqual(result.history.past[0].nodes[0].metadata.images, [kept]);
  assert.equal(result.history.past[0].nodes[0].metadata.storageKey, 'image:kept');
});
