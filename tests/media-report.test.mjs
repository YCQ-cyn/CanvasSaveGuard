import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { copyImageNode } from '../src/batch-clipboard.mjs';
import { createMediaReport, currentMediaSources, formatMediaReport, inspectCurrentMedia } from '../src/media-report.mjs';
import { Vault } from '../src/vault.mjs';
import { cleanUnreferencedMedia } from '../src/cleanup-storage.mjs';

const picture = (id, metadata = {}) => ({ id, title: id, type: 'image', position: { x: 100000, y: -100000 }, metadata: { storageKey: `image:${id}`, ...metadata } });
const stored = (key, database = 'infinite-canvas', store = 'image_files') => ({ key, database, store, bytes: 100 });

test('media sources distinguish copied-image bodies from preserved input references and include offscreen/failed/group nodes', () => {
  const copied = copyImageNode(picture('output', { references: [{ name: 'Windows素材.png', storageKey: 'image:pasted' }] }));
  const current = { id: 'current', title: '当前画布', nodes: [copied,
    picture('failed', { status: 'error' }), picture('loading', { status: 'loading' }),
    picture('group', { imageBatchExpanded: false, images: [{ id: 'child', storageKey: 'image:child' }] }),
  ], connections: [] };
  const before = JSON.stringify(current);
  const keys = ['output', 'pasted', 'failed', 'loading', 'group', 'child', 'untracked'];
  const records = [{ source: 'user-delete', projectId: 'current', nodeIds: ['pasted'], connectionIds: [], keys: ['image:pasted'], deletedAt: Date.now() - 70000 }];
  const report = createMediaReport(current, keys.flatMap(key => [stored(`image:${key}`), stored(`image:${key}`, 'canvas-save-guard', 'media')]), records);
  assert.equal(report.nodes, 4);
  assert.equal(report.currentFiles, 6);
  assert.deepEqual(report.groups.display, { files: 5, bytes: 1000 });
  assert.deepEqual(report.groups.reference, { files: 1, bytes: 200 });
  assert.deepEqual(report.groups.outsideCurrent, { files: 1, bytes: 200 });
  const pasted = report.files.find(file => file.key === 'image:pasted');
  assert.equal(pasted.deletion, 'mature');
  assert.deepEqual(pasted.owners, [{ category: 'reference', nodeId: 'output', title: 'output', path: 'metadata.references[0].storageKey' }]);
  assert.match(formatMediaReport(report), /有当前画布删除记录；仍被下面的当前数据引用/);
  assert.equal(JSON.stringify(current), before);
});

test('same key in multiple bodies/inputs is counted once and blob aliases do not interpret prompt text as images', () => {
  const shared = { storageKey: 'image:shared', dataUrl: 'blob:shared' };
  const current = { id: 'current', nodes: [picture('shared'), picture('copy', { storageKey: 'image:shared', references: [shared] }),
    { id: 'unkeyed', type: 'image', metadata: { content: 'blob:existing' } },
    { id: 'text', type: 'text', metadata: { content: 'blob:shared', prompt: 'blob:ignored' } },
  ] };
  const { sources, unkeyedUrls } = currentMediaSources(current, [['blob:existing', 'image:alias']]);
  assert.equal(sources.size, 2);
  assert.equal(unkeyedUrls, 0);
  assert.ok(sources.get('image:shared').some(owner => owner.nodeId === 'copy' && owner.path.includes('references')));
  assert.ok(!sources.get('image:shared').some(owner => owner.nodeId === 'text'));
  const report = createMediaReport(current, [stored('image:shared'), stored('image:alias')], [], [['blob:existing', 'image:alias']]);
  assert.deepEqual(report.groups.display, { files: 2, bytes: 200 });
  assert.equal(report.groups.reference.files, 0);
});

test('an inventory-only file is not described as safe to delete, and missing files are reported separately', () => {
  const report = createMediaReport({ id: 'current', nodes: [picture('missing')] }, [stored('image:other-canvas')]);
  assert.deepEqual(report.missingKeys, ['image:missing']);
  assert.equal(report.groups.outsideCurrent.files, 1);
  assert.match(formatMediaReport(report), /当前画布未引用不等于可删除/);
});

async function openDatabase(factory, name, stores) {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => { for (const store of stores) request.result.createObjectStore(store); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

test('source inspection uses only readonly transactions, leaves blobs/receipts unchanged, and does not create absent databases', async () => {
  const factory = new IDBFactory();
  const current = { id: 'current', nodes: [picture('keep')] };
  assert.equal((await inspectCurrentMedia(factory, current)).files.length, 0);
  assert.deepEqual(await factory.databases(), []);
  const site = await openDatabase(factory, 'infinite-canvas', ['image_files', 'image_previews', 'app_state']);
  const vault = await openDatabase(factory, 'canvas-save-guard', ['media', 'cleanup_candidates']);
  const blob = new Blob(['do not alter these bytes'], { type: 'image/png' });
  const receipt = { source: 'user-delete', projectId: 'current', nodeIds: ['keep'], connectionIds: [], keys: ['image:keep'], deletedAt: Date.now() };
  for (const [db, entries] of [[site, [['image_files', 'image:keep', blob], ['image_previews', 'image:keep', { blob }], ['app_state', 'state', JSON.stringify(current)]]],
    [vault, [['media', 'image:keep', blob], ['cleanup_candidates', 'receipt', receipt]]]]) {
    await new Promise(resolve => {
      const tx = db.transaction([...new Set(entries.map(entry => entry[0]))], 'readwrite');
      for (const [store, key, value] of entries) tx.objectStore(store).put(value, key);
      tx.oncomplete = resolve;
    });
  }
  const readonlyFactory = {
    databases: () => factory.databases(),
    open(name) {
      const request = factory.open(name);
      request.addEventListener('success', () => {
        const db = request.result, transaction = db.transaction.bind(db);
        db.transaction = (stores, mode) => { assert.equal(mode, 'readonly'); return transaction(stores, mode); };
      });
      return request;
    },
  };
  const report = await inspectCurrentMedia(readonlyFactory, current);
  assert.equal(report.files.length, 1);
  assert.equal(report.files[0].bytes, blob.size * 3);
  assert.equal(report.files[0].deletion, 'waiting');
  for (const [db, store] of [[site, 'image_files'], [vault, 'media']]) {
    const value = await new Promise(resolve => { const request = db.transaction(store).objectStore(store).get('image:keep'); request.onsuccess = () => resolve(request.result); });
    assert.equal(await value.text(), 'do not alter these bytes');
  }
  const afterReceipt = await new Promise(resolve => { const request = vault.transaction('cleanup_candidates').objectStore('cleanup_candidates').get('receipt'); request.onsuccess = () => resolve(request.result); });
  assert.deepEqual(afterReceipt, receipt);
  site.close(); vault.close();
});

test('a deleted Windows paste is kept by a copied image reference, then all its copies are released after deleting that last owner and its full minute', async context => {
  let now = Date.now();
  context.mock.method(Date, 'now', () => now);
  const factory = new IDBFactory();
  const site = await openDatabase(factory, 'infinite-canvas', ['app_state', 'image_files', 'image_previews']);
  const vault = new Vault(factory);
  const bytes = new Blob(['retain exact pasted image bytes'], { type: 'image/png' });
  const copy = copyImageNode(picture('output', { references: [{ storageKey: 'image:pasted' }] }));
  const keep = picture('keep-offscreen', { status: 'error', prompt: 'must preserve' });
  const current = { id: 'current', nodes: [copy, keep], connections: [] };
  await vault.protect([current], new Map(['output', 'pasted', 'keep-offscreen'].map(id => [`image:${id}`, bytes])));
  await vault.recordDeletedObjects('current', [picture('pasted')], [], [], now - 70000);
  await new Promise(resolve => {
    const tx = site.transaction(['image_files', 'image_previews'], 'readwrite');
    for (const id of ['output', 'pasted', 'keep-offscreen']) {
      tx.objectStore('image_files').put(bytes, `image:${id}`);
      tx.objectStore('image_previews').put({ blob: bytes }, `image:${id}`);
    }
    tx.oncomplete = resolve;
  });
  const scan = keys => ({ projectId: 'current', liveProjectIds: ['current'], keys, candidateKeys: [], preserveAllMedia: false });
  const shared = await cleanUnreferencedMedia(factory, scan(['image:output', 'image:pasted', 'image:keep-offscreen']));
  assert.deepEqual(shared.keys, []);
  await vault.recordDeletedObjects('current', [copy], [], [], now);
  current.nodes = [keep];
  const duringGrace = await cleanUnreferencedMedia(factory, scan(['image:keep-offscreen']));
  assert.deepEqual(duringGrace.keys, []);
  now += 60001;
  const expired = await cleanUnreferencedMedia(factory, scan(['image:keep-offscreen']));
  assert.deepEqual(expired.keys.sort(), ['image:output', 'image:pasted']);
  const report = await inspectCurrentMedia(factory, current);
  assert.deepEqual(report.files.map(file => file.key), ['image:keep-offscreen']);
  assert.equal(report.files[0].copies.length, 3);
  assert.equal(await (await vault.get('media', 'image:keep-offscreen')).text(), 'retain exact pasted image bytes');
  assert.deepEqual(current.nodes, [keep]);
  site.close(); (await vault.open()).close();
});
