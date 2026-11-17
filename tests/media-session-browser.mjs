// Browser plugin not available. Synthetic files and an isolated Chromium profile.
// Concurrent image/preview reads -> native Delete -> undo -> full grace -> cleanup -> refresh/ZIP.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const profile = await mkdtemp(path.join(tmpdir(), 'canvas-media-lifetime-'));
const evidence = path.join(tmpdir(), 'canvas-media-lifetime-evidence');
await mkdir(evidence, { recursive: true });
const extension = path.resolve(import.meta.dirname, '../extension');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true,
  viewport: { width: 1600, height: 1050 }, acceptDownloads: true,
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const page = await context.newPage(), errors = [], checks = [];
page.setDefaultTimeout(25000);
page.on('pageerror', error => errors.push(error.message));
const pass = message => { checks.push(message); console.log('PASS', message); };
try {
  await page.route('https://canvas.best/__media_lifetime_seed__', route => route.fulfill({ contentType: 'text/html', body: '<title>Isolated media lifetime fixture</title>' }));
  await context.route('https://image.yydsapi.uno/**', route => route.abort());
  await page.goto('https://canvas.best/__media_lifetime_seed__');
  const concurrency = await page.evaluate(async () => {
    const blob = new Blob(['fixture'], { type: 'image/png' });
    let reads = 0, previewReads = 0, created = 0, failNext = false;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => { created++; return create(blob); };
    const media = window.CanvasSaveGuard.connectMedia({
      getImageBlob: async key => { reads++; await new Promise(resolve => setTimeout(resolve, 10)); if (failNext) { failNext = false; throw Error('Interrupted fixture read'); } return key === 'image:missing' ? null : blob; },
      setImageBlob: async () => undefined,
      ensureImagePreview: async () => { previewReads++; await new Promise(resolve => setTimeout(resolve, 10)); return URL.createObjectURL(blob); },
    }, true);
    const urls = await Promise.all(Array.from({ length: 200 }, () => media.resolveImageUrl('image:concurrent')));
    const previews = await Promise.all(Array.from({ length: 200 }, () => media.ensureImagePreview('image:concurrent')));
    const initialReads = reads;
    const fallbacks = await Promise.all(['first', 'second'].map(fallback => media.resolveImageUrl('image:missing', fallback)));
    failNext = true;
    const interrupted = await media.resolveImageUrl('image:retry').catch(error => error.message);
    const retry = await media.resolveImageUrl('image:retry');
    URL.createObjectURL = create;
    return { uniqueUrls: new Set(urls).size, uniquePreviews: new Set(previews).size, initialReads, previewReads,
      created, fallbacks, interrupted, retry: retry.startsWith('blob:') };
  });
  assert.equal(concurrency.uniqueUrls, 1);
  assert.equal(concurrency.uniquePreviews, 1);
  assert.equal(concurrency.initialReads, 1);
  assert.equal(concurrency.previewReads, 1);
  assert.deepEqual(concurrency.fallbacks, ['first', 'second']);
  assert.equal(concurrency.retry, true);
  pass('200 concurrent full-image and preview requests share one read and one URL per kind, with missing-file fallbacks and retry preserved');

  await page.goto('https://canvas.best/__media_lifetime_seed__');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 1024; canvas.height = 1024;
    canvas.getContext('2d').fillStyle = '#37a7c6'; canvas.getContext('2d').fillRect(0, 0, 1024, 1024);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const metadata = key => ({ storageKey: key, content: '', status: 'success', naturalWidth: 1024, naturalHeight: 1024, bytes: blob.size, mimeType: 'image/png', prompt: 'Keep exact prompt' });
    const make = (id, x, key) => ({ id, type: 'image', title: id, position: { x, y: 140 }, width: 180, height: 180, metadata: metadata(key) });
    const project = { id: 'media-lifetime', title: 'Media lifetime fixture', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [make('target', 160, 'image:target'), make('survivor', 600, 'image:survivor'),
        { ...make('offscreen', 50000, 'image:survivor'), metadata: { status: 'error', prompt: 'Keep failed offscreen node', references: ['image:shared'] } }],
      connections: [{ id: 'original-link', fromNodeId: 'target', toNodeId: 'survivor', fromSide: 'right', toSide: 'left' }],
      chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const db = await new Promise((resolve, reject) => { const request = indexedDB.open('infinite-canvas', 8);
      request.onupgradeneeded = () => { for (const name of ['app_state', 'image_files', 'image_previews', 'media_files', 'image_generation_logs', 'video_generation_logs']) request.result.createObjectStore(name); };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    await new Promise((resolve, reject) => { const tx = db.transaction(['app_state', 'image_files'], 'readwrite');
      tx.objectStore('app_state').put(JSON.stringify({ state: { projects: [project], deletedProjects: [] }, version: 0 }), 'infinite-canvas:canvas_store');
      for (const key of ['image:target', 'image:survivor', 'image:shared']) tx.objectStore('image_files').put(blob, key);
      tx.oncomplete = resolve; tx.onabort = () => reject(tx.error); }); db.close();
  });
  await page.goto('https://canvas.best/canvas/media-lifetime');
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  assert.equal(await page.title(), '无限画布');
  await page.locator('[data-node-id="target"]').waitFor();
  await page.locator('[data-node-id="target"]').click({ position: { x: 90, y: 90 } });
  await page.keyboard.press('Control+a');
  const selectedDownload = page.waitForEvent('download');
  await page.locator('[data-guard-arrange-toolbar]').getByRole('button', {name:'批量下载',exact:true}).click();
  const selectedPath = path.join(evidence,'selected-with-failure.zip');
  await (await selectedDownload).saveAs(selectedPath);
  assert.equal(Object.keys(unzipSync(new Uint8Array(await readFile(selectedPath)))).length,2);
  await page.waitForFunction(() => document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#status').textContent.includes('跳过 1'));
  pass('selection download includes two ready images and reports the offscreen failed image without changing its node');
  await page.keyboard.press('Escape');
  const targetUrls = await page.evaluate(async () => {
    const images = window.CanvasSaveGuardNative.images;
    const blob = await images.getImageBlob('image:target');
    const urls = [await images.resolveImageUrl('image:target')];
    for (let index = 0; index < 12; index++) {
      urls.push(await images.setImageBlob('image:target', blob));
      await images.ensureImagePreview('image:target');
    }
    await window.CanvasSaveGuard.flush();
    window.CanvasSaveGuardHistory.commitPending();
    return urls;
  });
  const before = await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot());
  await page.evaluate(() => {
    window.__releaseCalls = [];
    const endpoint = window.CanvasSaveGuard.cleanupEndpoint, release = endpoint.releaseMedia;
    endpoint.releaseMedia = async function(...args) {
      const result = await release.apply(this,args);
      window.__releaseCalls.push({ keys: args[1], retained: args[2], candidates: args[3] });
      return result;
    };
  });
  async function deleteTarget() {
    await page.locator('[data-node-id="target"]').click({ position: { x: 90, y: 90 } });
    await page.keyboard.press('Delete');
    await page.waitForFunction(() => !window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.id === 'target'));
    await page.evaluate(() => window.CanvasSaveGuard.flush());
  }
  async function targetPresent() {
    return page.evaluate(async () => {
      const native = await window.CanvasSaveGuardNative.images.getImageBlob('image:target');
      return !!native;
    });
  }
  await deleteTarget();
  await page.evaluate(() => window.CanvasSaveGuard.cleanupDeleted());
  assert.equal(await targetPresent(), true);
  await page.keyboard.press('Control+z');
  await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.id === 'target'));
  const undone = await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot());
  assert.deepEqual(undone.nodes, before.nodes);
  assert.deepEqual(undone.connections, before.connections);
  assert.equal(await page.evaluate(async urls => (await Promise.all(urls.map(url => fetch(url).then(response => response.ok)))).every(Boolean), targetUrls), true);
  pass('native Delete preserves every issued image URL during the grace period and Ctrl+Z restores exact nodes, positions and connections');

  await deleteTarget();
  await page.waitForTimeout(31000);
  await page.waitForTimeout(31000);
  await page.waitForFunction(async () => {
    const db = await new Promise(resolve => { const request = indexedDB.open('canvas-save-guard'); request.onsuccess = () => resolve(request.result); });
    try { return await new Promise(resolve => { const request = db.transaction('media').objectStore('media').get('image:target'); request.onsuccess = () => resolve(!request.result); }); }
    finally { db.close(); }
  }, undefined, { timeout: 95000, polling: 500 });
  await page.evaluate(() => window.CanvasSaveGuard.cleanupDeleted());
  const remaining = await page.evaluate(async urls => {
    const targetUrlReads = await Promise.all(urls.map(url => fetch(url).then(() => true, () => false)));
    const media = window.CanvasSaveGuardNative.images;
    const hashes = [];
    for (const key of ['image:survivor', 'image:shared']) {
      const blob = await media.getImageBlob(key);
      hashes.push([key, blob.size, [...new Uint8Array(await crypto.subtle.digest('SHA-256', await blob.arrayBuffer()))]]);
    }
    return { targetUrlReads, hashes, releaseCalls: window.__releaseCalls, nodes: window.CanvasSaveGuardHistory.snapshot().nodes, links: window.CanvasSaveGuardHistory.snapshot().connections };
  }, targetUrls);
  await writeFile(path.join(evidence, 'release-trace.json'), JSON.stringify({ targetUrls, remaining },null,2));
  assert.ok(remaining.targetUrlReads.every(value => !value));
  assert.equal(remaining.nodes.length, 2);
  assert.equal(remaining.links.length, 0);
  assert.deepEqual(remaining.hashes[0].slice(1), remaining.hashes[1].slice(1));
  pass('after the real sixty-second grace all thirteen superseded target URLs become unreadable, while live and offscreen referenced files remain exact');
  await page.reload();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  assert.deepEqual(await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot().nodes), remaining.nodes);
  const download = page.waitForEvent('download');
  await page.locator('#canvas-save-guard').getByRole('button', { name: '保存完整 ZIP', exact: true }).click();
  await (await download).saveAs(path.join(evidence, 'verified.zip'));
  await page.screenshot({ path: path.join(evidence, 'complete.png') });
  assert.deepEqual(errors, []);
  pass('refresh and normal ZIP export retain the surviving canvas after exact deletion cleanup');
  await writeFile(path.join(evidence, 'verified.json'), JSON.stringify({ checks, concurrency, issuedTargetUrls: targetUrls.length, errors }, null, 2));
} catch (error) {
  console.error(await page.evaluate(() => ({ url: location.href, guard: window.CanvasSaveGuard?.status(), body: document.body.innerText.slice(-1500) })).catch(() => null));
  await page.screenshot({ path: path.join(evidence, 'failed.png') }).catch(() => {});
  throw error;
} finally {
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
