import test from 'node:test';
import assert from 'node:assert/strict';
import { IDBFactory } from 'fake-indexeddb';
import { collectReferenceData, auditTemporaryReferences, documentReferenceData } from '../src/reference-audit.mjs';
import { cleanUnreferencedMedia } from '../src/cleanup-storage.mjs';
import { collectMedia, STORE_KEY } from '../src/core.mjs';

test('temporary reference collection excludes text literals and preserves exact aliases and UI attachment previews', () => {
  const value = { nodes: [
    { type: 'text', metadata: { content: 'blob:literal-text', prompt: 'blob:literal-prompt' } },
    { type: 'image', metadata: { storageKey: 'image:live', content: 'blob:live', references: ['blob:bare'] } },
  ] };
  const data = collectReferenceData(value, 'current');
  assert.deepEqual(data.aliases, [['blob:live', 'image:live']]);
  assert.deepEqual(data.urls.map(item => item.url), ['blob:live', 'blob:bare']);
  assert.equal(collectReferenceData(value, 'old', false).urls.length, 0);
  const doc = { querySelectorAll: () => [{ tagName: 'IMG', currentSrc: 'blob:draft', getAttribute: () => null }] };
  assert.deepEqual(documentReferenceData(doc).urls, [{ url: 'blob:draft', path: '画布界面/IMG' }]);
});

test('reference audit retains strong cache aliases and exact-byte matches, caches hashes, and reports unreadable references', async () => {
  const body = new Blob(['same-pixels']);
  const wrong = new Blob(['x'.repeat(body.size)]);
  const data = { aliases: [['blob:known', 'image:metadata'], ['blob:known', 'image:actual', true]], urls: [
    { url: 'blob:known', path: 'node' }, { url: 'blob:bare-a', path: 'reference' },
    { url: 'blob:bare-b', path: 'attachment' }, { url: 'blob:missing', path: 'failed-reference' },
  ] };
  const entries = ['image:matched', 'image:wrong'].map(key => ({ key, database: 'original', store: 'image_files', bytes: body.size }));
  let reads = 0;
  const result = await auditTemporaryReferences(data, entries, async entry => {
    reads += 1;
    return entry.key === 'image:matched' ? body : wrong;
  }, async url => {
    if (url === 'blob:missing') throw Error('expired');
    assert.notEqual(url, 'blob:known');
    return body;
  }, () => {});
  assert.deepEqual(result.keys.sort(), ['image:actual', 'image:matched', 'image:metadata']);
  assert.equal(result.contentMatched, 2);
  assert.equal(reads, 2);
  assert.deepEqual(result.unresolved, [{ url: 'blob:missing', path: 'failed-reference', reason: 'expired' }]);
});

test('a candidate read failure keeps an aliased live reference unresolved instead of permitting a partial comparison', async () => {
  const body = new Blob(['live image']);
  const result = await auditTemporaryReferences({ aliases: [['blob:live', 'image:metadata']], urls: [{ url: 'blob:live', path: 'current.content' }] },
    [{ key: 'image:actual', database: 'original', store: 'image_files', bytes: body.size }],
    async () => { throw Error('candidate read failed'); }, async () => body, () => {});
  assert.deepEqual(result.keys, ['image:metadata']);
  assert.deepEqual(result.unresolved, [{ url: 'blob:live', path: 'current.content', reason: 'candidate read failed' }]);
});

function open(indexedDB, name, stores) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.onupgradeneeded = () => stores.forEach(store => request.result.createObjectStore(store));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
function write(db, records) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction([...new Set(records.map(item => item.store))], 'readwrite');
    for (const item of records) tx.objectStore(item.store).put(item.value, item.key);
    tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
  });
}
function read(db, store, key) {
  return new Promise((resolve, reject) => {
    const request = db.transaction(store).objectStore(store).get(key);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}

async function fixture() {
  const indexedDB = new IDBFactory();
  const original = await open(indexedDB, 'infinite-canvas', ['app_state', 'image_files', 'image_previews', 'image_generation_logs', 'agent_chat_messages']);
  const vault = await open(indexedDB, 'canvas-save-guard', ['projects', 'media', 'cleanup_candidates', 'deleted']);
  const node = (id, status = 'success') => ({ id, type: 'image', position: { x: 20000, y: 20000 }, metadata: { status, storageKey: `image:${id}`, content: `blob:${id}` } });
  const project = { id: 'current', nodes: [node('visible'), node('offscreen'), node('folded'), node('loading', 'loading'), node('failed', 'error')], connections: [], chatSessions: [{ references: [{ dataUrl: 'blob:bare' }] }] };
  project.nodes[2].metadata.batchRootId = 'visible';
  const keys = ['visible', 'offscreen', 'folded', 'loading', 'failed', 'bare', 'draft', 'asset', 'log', 'other', 'orphan', 'legacy'];
  const bodies = new Map(keys.map(id => [`image:${id}`, new Blob([`file:${id}`], { type: 'image/png' })]));
  const other = { id: 'other', nodes: [node('other')] };
  const canvasState = JSON.stringify({ state: { projects: [project, other] } });
  const assets = JSON.stringify({ state: { assets: [{ kind: 'image', coverUrl: 'blob:expired-asset', data: { storageKey: 'image:asset', dataUrl: 'blob:expired-asset' } }] } });
  const log = { thumbnails: ['blob:expired-log'], images: [{ storageKey: 'image:log', dataUrl: 'blob:expired-log' }] };
  await write(original, [
    ...[...bodies].map(([key, value]) => ({ store: 'image_files', key, value })),
    { store: 'app_state', key: STORE_KEY, value: canvasState },
    { store: 'app_state', key: 'infinite-canvas:asset_store', value: assets },
    { store: 'image_generation_logs', key: 'log', value: log },
  ]);
  await write(vault, [
    ...[...bodies].map(([key, value]) => ({ store: 'media', key, value })),
    { store: 'projects', key: 'current', value: { ...project, nodes: [...project.nodes, node('legacy')] } },
    { store: 'cleanup_candidates', key: 'old', value: { projectId: 'current', key: 'image:legacy' } },
  ]);
  const referenceData = collectReferenceData(project, 'current');
  referenceData.urls.push({ url: 'blob:draft-preview', path: '画布界面/IMG' });
  const scan = { mode: 'deleted-audited', projectId: 'current', liveProjectIds: ['current'], keys: [...collectMedia(project).keys()], candidateKeys: ['image:orphan', 'image:bare', 'image:draft'], preserveAllMedia: true, referenceData };
  const fetchBlob = async url => {
    if (url === 'blob:bare') return bodies.get('image:bare');
    if (url === 'blob:draft-preview') return bodies.get('image:draft');
    throw Error('unreadable');
  };
  return { indexedDB, original, vault, scan, fetchBlob, canvasState, assets, log };
}

test('audited cleanup removes only explicit deletion candidates and preserves untracked and legacy media', async () => {
  const { indexedDB, original, vault, scan, fetchBlob, canvasState, assets, log } = await fixture();
  let validated = false;
  const result = await cleanUnreferencedMedia(indexedDB, scan, {}, () => {}, { fetchBlob, validateReferences: async () => {
    validated = true;
    assert.ok(await read(original, 'image_files', 'image:orphan'));
  } });
  assert.equal(validated, true);
  assert.deepEqual(result.keys, ['image:orphan']);
  assert.equal(result.preserveAllMedia, false);
  assert.equal(result.audit.unresolved.length, 0);
  assert.equal(result.audit.contentMatched, 2);
  for (const id of ['visible', 'offscreen', 'folded', 'loading', 'failed', 'bare', 'draft', 'asset', 'log', 'other', 'legacy']) {
    assert.ok(await read(original, 'image_files', `image:${id}`), id);
    assert.ok(await read(vault, 'media', `image:${id}`), id);
  }
  assert.equal(await read(original, 'image_files', 'image:orphan'), undefined);
  assert.ok(await read(vault, 'media', 'image:legacy'));
  await assert.rejects(cleanUnreferencedMedia(indexedDB, { ...scan, mode: 'unused' }), /旧清理接口已停用/);
  assert.equal(await read(original, 'app_state', STORE_KEY), canvasState);
  assert.equal(await read(original, 'app_state', 'infinite-canvas:asset_store'), assets);
  assert.deepEqual(await read(original, 'image_generation_logs', 'log'), log);
  original.close(); vault.close();
});

test('media embedded as structured text content keeps its file after another node explicitly deletes that key', async () => {
  const {indexedDB,original,vault,scan,fetchBlob,canvasState}=await fixture();
  const state=JSON.parse(canvasState),project=state.state.projects[0];
  project.updatedAt='2026-11-16T12:00:00.000Z';
  project.nodes.push({id:'structured-text',type:'text',metadata:{content:'blob:literal-text',text:{type:'image',content:'blob:embedded-live'}}});
  await write(original,[{store:'app_state',key:STORE_KEY,value:JSON.stringify(state)}]);
  scan.referenceData=collectReferenceData(project,'current');
  scan.referenceData.urls.push({url:'blob:draft-preview',path:'画布界面/IMG'});
  const result=await cleanUnreferencedMedia(indexedDB,scan,{},()=>{},{
    fetchBlob:async url=>url==='blob:embedded-live'?read(original,'image_files','image:orphan'):fetchBlob(url),validateReferences:async()=>{},
  });
  assert.deepEqual(result.keys,[]);
  assert.ok(await read(original,'image_files','image:orphan'));
  assert.ok(await read(vault,'media','image:orphan'));
  assert.equal(result.audit.unresolved.length,0);
  original.close();vault.close();
});

test('unreadable references and a changed reference snapshot each prevent deleted-file cleanup', async () => {
  const { indexedDB, original, vault, scan, fetchBlob } = await fixture();
  scan.referenceData.urls.push({ url: 'blob:missing', path: 'current.reference' });
  const result = await cleanUnreferencedMedia(indexedDB, scan, {}, () => {}, { fetchBlob, validateReferences: async () => {} });
  assert.deepEqual(result.keys, []);
  assert.equal(result.audit.unresolved[0].path, 'current.reference');
  assert.ok(await read(original, 'image_files', 'image:orphan'));
  scan.referenceData.urls.pop();
  await assert.rejects(cleanUnreferencedMedia(indexedDB, scan, {}, () => {}, { fetchBlob, validateReferences: async () => { throw Error('references changed'); } }), /references changed/);
  assert.ok(await read(original, 'image_files', 'image:orphan'));
  original.close(); vault.close();
});


test('deleted-cache cleanup ignores superseded and deleted canvas backups without authorizing untracked files', async () => {
  const { indexedDB, original, vault, scan, fetchBlob } = await fixture();
  const state = JSON.parse(await read(original, 'app_state', STORE_KEY));
  state.state.projects.find(project => project.id === 'other').updatedAt = '2026-11-12T10:00:00Z';
  await write(original, [{ store: 'app_state', key: STORE_KEY, value: JSON.stringify(state) }]);
  await write(vault, [
    { store: 'projects', key: 'other', value: { id: 'other', updatedAt: '2026-10-01T10:00:00Z', nodes: [{ id: 'old', metadata: { content: 'blob:superseded-unkeyed' } }] } },
    { store: 'projects', key: 'removed-project', value: { id: 'removed-project', updatedAt: '2026-10-01T10:00:00Z', nodes: [{ id: 'old', metadata: { content: 'blob:deleted-unkeyed' } }] } },
    { store: 'deleted', key: 'removed-project', value: { id: 'removed-project', at: '2026-11-01T10:00:00Z' } },
  ]);
  const before = await read(original, 'app_state', STORE_KEY);
  const fetched = [];
  const result = await cleanUnreferencedMedia(indexedDB, { ...scan, mode: 'deleted-audited', candidateKeys: ['image:orphan'] }, {}, () => {}, {
    fetchBlob: url => { fetched.push(url); return fetchBlob(url); }, validateReferences: async () => {},
  });
  assert.deepEqual(result.keys, ['image:orphan']);
  assert.ok(await read(original, 'image_files', 'image:legacy'));
  assert.equal(result.audit.unresolved.length, 0);
  assert.ok(!fetched.includes('blob:superseded-unkeyed'));
  assert.ok(!fetched.includes('blob:deleted-unkeyed'));
  assert.equal(await read(original, 'app_state', STORE_KEY), before);
  assert.ok(await read(vault, 'projects', 'removed-project'));
  for (const id of ['visible', 'offscreen', 'folded', 'loading', 'failed', 'bare', 'draft', 'asset', 'log', 'other']) assert.ok(await read(original, 'image_files', `image:${id}`));
  original.close(); vault.close();
});

test('deleted-cache cleanup retains media owned by agent messages and pauses for unreadable references', async () => {
  const { indexedDB, original, vault, scan, fetchBlob } = await fixture();
  await write(original, [{ store: 'agent_chat_messages', key: 'message', value: { attachments: [{ storageKey: 'image:legacy' }] } }]);
  const result = await cleanUnreferencedMedia(indexedDB, { ...scan, mode: 'deleted-audited', candidateKeys: ['image:legacy', 'image:orphan'] }, {}, () => {}, { fetchBlob, validateReferences: async () => {} });
  assert.deepEqual(result.keys, ['image:orphan']);
  assert.ok(await read(original, 'image_files', 'image:legacy'));
  scan.referenceData.urls.push({ url: 'blob:still-needed', path: 'current.image' });
  const blocked = await cleanUnreferencedMedia(indexedDB, { ...scan, mode: 'deleted-audited', candidateKeys: ['image:legacy', 'image:orphan'] }, {}, () => {}, { fetchBlob, validateReferences: async () => {} });
  assert.deepEqual(blocked.keys, []);
  assert.equal(blocked.audit.unresolved[0].path, 'current.image');
  original.close(); vault.close();
});
