// Browser plugin not available. Validate the native per-image deletion entry point.
import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(path.join(tmpdir(), 'canvas-batch-delete-'));
const extension = path.resolve(import.meta.dirname, '../extension');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1440, height: 1000 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const page = await context.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.route('**/__batch_seed__', route => route.fulfill({ contentType: 'text/html', body: '<title>Batch fixture</title>' }));
  await page.goto('https://canvas.best/__batch_seed__');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const image = (id, status) => ({ id, status, content: `blob:https://canvas.best/expired-${id}`, storageKey: `image:${id}`, naturalWidth: 96, naturalHeight: 96, bytes: blob.size, mimeType: 'image/png' });
    const images = [image('primary', 'success'), image('delete-me', 'error'), image('keep', 'success')];
    const project = { id: 'batch-test', title: '组内删除检查', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [{ id: 'batch', type: 'image', title: '三张图片', position: { x: 150, y: 140 }, width: 170, height: 170, metadata: { status: 'success', prompt: 'keep prompt', storageKey: 'image:primary', content: 'blob:https://canvas.best/expired-primary', primaryImageId: 'primary', images } }],
      connections: [], chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const db = await new Promise(resolve => { const req = indexedDB.open('infinite-canvas', 3); req.onupgradeneeded = () => { for (const name of ['app_state', 'image_files', 'media_files', 'image_generation_logs', 'video_generation_logs']) req.result.createObjectStore(name); }; req.onsuccess = () => resolve(req.result); });
    await new Promise(resolve => { const tx = db.transaction(['app_state', 'image_files'], 'readwrite'); tx.objectStore('app_state').put(JSON.stringify({ state: { projects: [project], deletedProjects: [] }, version: 0 }), 'infinite-canvas:canvas_store'); for (const item of images) tx.objectStore('image_files').put(blob, item.storageKey); tx.oncomplete = resolve; }); db.close();
  });
  await page.goto('https://canvas.best/canvas/batch-test');
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  const node = page.locator('[data-node-id="batch"]');
  await node.getByRole('button', { name: '图片组已收起', exact: true }).click();
  await node.hover();
  await node.getByRole('button', { name: '删除', exact: true }).click();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes[0].metadata.images.length === 2);
  const afterNativeDelete = await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot()));
  await page.waitForFunction(() => window.CanvasSaveGuard.cleanupProgress.read().status === 'complete');
  assert.equal(await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), afterNativeDelete);
  const cached = await page.evaluate(async () => {
    const result = {};
    for (const [database, stores] of [['infinite-canvas', ['image_files', 'image_previews']], ['canvas-save-guard', ['media']]]) {
      const db = await new Promise(resolve => { const req = indexedDB.open(database); req.onsuccess = () => resolve(req.result); });
      for (const store of stores) if (db.objectStoreNames.contains(store)) result[store] = await new Promise(resolve => { const req = db.transaction(store).objectStore(store).getAllKeys(); req.onsuccess = () => resolve(req.result); });
      db.close();
    } return result;
  });
  for (const [store, keys] of Object.entries(cached)) {
    assert.ok(!keys.includes('image:delete-me'));
    if (store !== 'image_previews') { assert.ok(keys.includes('image:primary')); assert.ok(keys.includes('image:keep')); }
  }
  assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-result').innerText(), /另清理 1 个已删除组内图片/);
  assert.equal(await page.locator('[data-node-id="batch"]').count(), 1);
  await page.waitForFunction(() => [...document.querySelectorAll('[data-node-id="batch"] img')].every(img => img.naturalWidth === 96));
  assert.equal(await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot().nodes[0].metadata.prompt), 'keep prompt');
  assert.deepEqual(errors, []);
  console.log('PASS native batch-image Delete removes only that image from original, preview and protection caches while retaining the node and remaining images');
} catch (error) {
  console.log(await page.evaluate(() => ({ progress: window.CanvasSaveGuard?.cleanupProgress?.read(), nodes: window.CanvasSaveGuardHistory?.snapshot().nodes })));
  throw error;
} finally {
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
