// Run the real v0.4.0 application in a disposable profile with mocked generation.
import { chromium } from 'playwright';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(path.join(tmpdir(), 'canvas-persistence-check-'));
const canvasOrigin = process.env.GUARD_TEST_ORIGIN || 'https://canvas.modelaryx.com';
const extension = path.resolve(import.meta.dirname, '../extension');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
async function modules() {
  await page.evaluate(() => {
    if (window.CanvasSaveGuardNative) { window.__testModules = window.CanvasSaveGuardNative; return; }
    const id = `persistence-test-${crypto.randomUUID()}`;
    window.TURBOPACK.push(['static/chunks/persistence-test.js', id, c => {
      window.__testModules = { images: c.i(7065), store: c.i(83629).useCanvasStore, config: c.i(56073).useConfigStore };
    }]);
    window.TURBOPACK.push(['static/chunks/persistence-test.js', { otherChunks: [], runtimeModuleIds: [id] }]);
  });
}
async function mediaKeys() {
  return page.evaluate(async () => {
    async function read(name, store) {
      const db = await new Promise(resolve => { const req = indexedDB.open(name); req.onsuccess = () => resolve(req.result); });
      const keys = await new Promise(resolve => { const req = db.transaction(store).objectStore(store).getAllKeys(); req.onsuccess = () => resolve(req.result); });
      db.close(); return keys;
    }
    return { app: await read('infinite-canvas', 'image_files'), vault: await read('canvas-save-guard', 'media') };
  });
}
try {
  await page.route('**/__persistence_seed__', route => route.fulfill({ contentType: 'text/html', body: '<title>Persistence fixture</title>' }));
  await page.goto(canvasOrigin + '/__persistence_seed__');
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 160; canvas.height = 160;
    canvas.getContext('2d').fillRect(0, 0, 160, 160);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const data = canvas.toDataURL();
    const project = {
      id: 'persistence-test', title: '图片持久保护测试', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [
        { id: 'generated-target', type: 'image', title: '生成图', position: { x: 150, y: 130 }, width: 240, height: 240,
          metadata: { status: 'error', prompt: 'a square, retain this exact prompt', errorDetails: 'fixture', generationType: 'generation', model: 'default::gpt-image-2', size: '1024x1024', count: 1 } },
        { id: 'legacy-session', type: 'image', title: '旧编号图片', position: { x: 500, y: 130 }, width: 200, height: 200,
          metadata: { status: 'success', storageKey: 'image:session-seeded', content: '', prompt: 'legacy prompt', naturalWidth: 160, naturalHeight: 160, bytes: blob.size, mimeType: 'image/png' } },
        { id: 'offscreen-failed', type: 'image', title: '屏幕外失败节点', position: { x: 20000, y: 20000 }, width: 200, height: 200,
          metadata: { status: 'error', errorDetails: 'retain failure detail', prompt: 'retain offscreen prompt', references: ['image:session-seeded'] } },
      ], connections: [{ id: 'kept-link', fromNodeId: 'legacy-session', toNodeId: 'offscreen-failed' }],
      chatSessions: [{ id: 'chat-one', title: '保留聊天', messages: [] }], activeChatId: 'chat-one', backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
    };
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open('infinite-canvas', 3);
      req.onupgradeneeded = () => { for (const name of ['app_state', 'image_files', 'media_files', 'image_generation_logs', 'video_generation_logs', 'local-forage-detect-blob-support']) req.result.createObjectStore(name); };
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['app_state', 'image_files'], 'readwrite');
      tx.objectStore('app_state').put(JSON.stringify({ state: { projects: [project, { ...project, id: 'other-canvas', title: '保留的其他画布', nodes: [{ ...project.nodes[1], id: 'other-image', metadata: { ...project.nodes[1].metadata, storageKey: 'image:other-canvas' } }], connections: [], chatSessions: [] }] }, version: 0 }), 'infinite-canvas:canvas_store');
      tx.objectStore('image_files').put(blob, 'image:session-seeded');
      tx.objectStore('image_files').put(blob, 'image:other-canvas');
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error);
    }); db.close(); return data.split(',')[1];
  });
  const imageUrl = 'https://localhost:18443/canvas/media/' + 'b'.repeat(160) + '/0/' + 'c'.repeat(64);
  await page.route('https://localhost:18443/canvas/media/**', route => route.fulfill({ contentType: 'image/png', body: Buffer.from(png, 'base64'), headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } }));
  await page.route('https://persistence-fixture.invalid/**', route => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' };
    return route.fulfill(route.request().method() === 'OPTIONS' ? { headers, status: 204 } : { headers, contentType: 'application/json', body: JSON.stringify({ data: [{ url: imageUrl }] }) });
  });
  await page.goto(canvasOrigin + '/canvas/persistence-test');
  await page.waitForFunction(() => window.CanvasSaveGuard?.persistentMediaVersion === 1 && window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard.status().protectedAt);
  await modules();
  await page.evaluate(() => window.__testModules.config.getState().updateConfig('channels', [{ id: 'default', name: 'Test', baseUrl: 'https://persistence-fixture.invalid/v1', apiKey: 'fixture-only', apiFormat: 'openai', models: window.CanvasSaveGuardNative ? [{ name: 'gpt-image-2', capability: 'image' }] : ['gpt-image-2'] }]));
  const panel = page.locator('#canvas-save-guard');
  const initialHeight = (await panel.boundingBox()).height;
  assert.equal(initialHeight, 333);
  await page.locator('[data-node-id="generated-target"]').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.some(n => n.id === 'generated-target' && n.metadata.status === 'success' && n.metadata.storageKey));
  await page.waitForFunction(() => window.CanvasSaveGuard.status().pending === 0 && !!window.CanvasSaveGuard.status().protectedAt);
  const saved = await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot());
  const generated = saved.nodes.find(n => n.id === 'generated-target');
  const keys = await mediaKeys();
  for (const storeKeys of Object.values(keys)) {
    assert.ok(storeKeys.includes(generated.metadata.storageKey));
    assert.ok(storeKeys.includes('image:session-seeded'));
    assert.ok(storeKeys.includes('image:other-canvas'));
  }
  assert.equal(await page.evaluate(async key => {
    const blob = await window.__testModules.images.getImageBlob(key);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    return btoa(String.fromCharCode(...bytes));
  }, generated.metadata.storageKey), png);
  console.log('PASS WAI generation through the native retry UI persists exact image bytes in both databases before reporting protection');

  await page.evaluate(() => window.CanvasSaveGuard.flush());
  const otherCanvasBefore = await page.evaluate(() => JSON.stringify(window.__testModules.store.getState().projects.find(project => project.id === 'other-canvas')));
  const optimized = await page.evaluate(async () => {
    const put = IDBObjectStore.prototype.put;
    let mediaWrites = 0, projectWrites = 0;
    IDBObjectStore.prototype.put = function (...args) {
      if (this.transaction.db.name === 'canvas-save-guard') {
        if (this.name === 'media') mediaWrites += 1;
        if (this.name === 'projects') projectWrites += 1;
      }
      return put.apply(this, args);
    };
    try {
      for (let i = 0; i < 50; i++) window.__testModules.store.getState().updateProject('persistence-test', { title: `autosave-${i}` });
      const pending = window.CanvasSaveGuard.status().pending;
      await window.CanvasSaveGuard.flush();
      return { mediaWrites, projectWrites, pending, title: window.__testModules.store.getState().projects.find(p => p.id === 'persistence-test').title };
    } finally { IDBObjectStore.prototype.put = put; }
  });
  assert.equal(optimized.mediaWrites, 0);
  assert.ok(optimized.projectWrites <= 2);
  assert.ok(optimized.pending <= 2);
  assert.equal(optimized.title, 'autosave-49');
  console.log('PASS 50 rapid updates coalesce to the latest snapshot without rewriting protected image bytes');

  const downloadPromise = page.waitForEvent('download');
  await panel.getByRole('button', { name: '保存完整 ZIP', exact: true }).click();
  const download = await downloadPromise;
  await download.saveAs(path.join(profile, 'verified.zip'));
  const verification = await page.evaluate(async () => {
    const zip = await window.CanvasSaveGuard.exportCurrent();
    return window.CanvasSaveGuard.verify(zip);
  });
  assert.equal(verification.files, 2);
  console.log('PASS ZIP contains both generated and legacy-key images with verified hashes');
  const downloadedZip = await readFile(path.join(profile, 'verified.zip'));
  await page.reload();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  await modules();
  const restored = await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot());
  for (const before of saved.nodes) {
    const after = restored.nodes.find(n => n.id === before.id);
    assert.ok(after, before.id);
    for (const field of ['prompt', 'storageKey', 'references', 'errorDetails', 'status']) assert.deepEqual(after.metadata[field], before.metadata[field]);
    assert.deepEqual(after.position, before.position);
  }
  assert.deepEqual(restored.connections, saved.connections);
  assert.deepEqual(restored.chatSessions, saved.chatSessions);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-node-id="generated-target"] img')].some(img => img.naturalWidth === 160));
  console.log('PASS refresh retains generated images, legacy keys, prompts, links, chat data and offscreen failed nodes');
  const foreign = await context.newPage();
  const foreignOrigin = canvasOrigin === 'https://canvas.best' ? 'https://canvas.modelaryx.com' : 'https://canvas.best';
  await foreign.route('**/__foreign_cache__', route => route.fulfill({ contentType: 'text/html', body: '<title>Other origin</title>' }));
  await foreign.goto(foreignOrigin + '/__foreign_cache__');
  await foreign.evaluate(async () => {
    const db = await new Promise(resolve => { const req = indexedDB.open('infinite-canvas', 1); req.onupgradeneeded = () => req.result.createObjectStore('image_files'); req.onsuccess = () => resolve(req.result); });
    await new Promise(resolve => { const tx = db.transaction('image_files', 'readwrite'); tx.objectStore('image_files').put(new Blob(['foreign origin bytes']), 'image:foreign'); tx.oncomplete = resolve; }); db.close();
  });
  await page.bringToFront();
  const keptBefore = restored.nodes.filter(n => n.id !== 'generated-target');
  await page.locator('[data-node-id="generated-target"]').click({ position: { x: 70, y: 60 } });
  await page.keyboard.press('Delete');
  await page.waitForFunction(() => window.CanvasSaveGuard.cleanupProgress.read().status === 'complete');
  const afterDelete = await mediaKeys();
  assert.deepEqual(await readFile(path.join(profile, 'verified.zip')), downloadedZip);
  console.log('PASS the downloaded ZIP remains byte-for-byte intact after browser cache cleanup');
  for (const storeKeys of Object.values(afterDelete)) {
    assert.ok(!storeKeys.includes(generated.metadata.storageKey));
    assert.ok(storeKeys.includes('image:session-seeded'));
    assert.ok(storeKeys.includes('image:other-canvas'));
  }
  assert.deepEqual(await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot().nodes), keptBefore);
  assert.equal(await page.evaluate(() => JSON.stringify(window.__testModules.store.getState().projects.find(project => project.id === 'other-canvas'))), otherCanvasBefore);
  assert.equal(await foreign.evaluate(async () => {
    const db = await new Promise(resolve => { const req = indexedDB.open('infinite-canvas'); req.onsuccess = () => resolve(req.result); });
    const value = await new Promise(resolve => { const req = db.transaction('image_files').objectStore('image_files').get('image:foreign'); req.onsuccess = () => resolve(req.result); }); db.close(); return value.text();
  }), 'foreign origin bytes');
  console.log('PASS cleanup keeps other canvases and the other website origin intact');
  await foreign.close();
  assert.equal((await panel.boundingBox()).height, initialHeight);
  assert.equal(await panel.locator('#cleanup-progress-result').evaluate(el => el.getBoundingClientRect().height), 140);
  await panel.screenshot({ path: path.join(tmpdir(), 'canvas-persistence-panel.png') });
  console.log('PASS native Delete automatically clears only its unreferenced image caches and retains every remaining node');
  console.log('PASS panel stays 333 px high and result text stays 140 px high');
  await page.reload();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  assert.equal(await page.locator('[data-node-id="generated-target"]').count(), 0);
  assert.equal(await page.locator('[data-node-id="legacy-session"]').count(), 1);
  assert.deepEqual(errors, []);
  console.log('PASS second refresh keeps the deletion and remaining images without runtime errors');
} catch (error) {
  console.log(await page.evaluate(() => ({ status: window.CanvasSaveGuard?.status(), progress: window.CanvasSaveGuard?.cleanupProgress?.read(), nodes: window.CanvasSaveGuardHistory?.snapshot().nodes })));
  throw error;
} finally {
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
