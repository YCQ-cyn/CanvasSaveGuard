// Browser plugin not available. Exercise canvas.best in a disposable Chromium profile.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(path.join(tmpdir(), 'canvas-v020-retry-'));
const evidence = path.join(tmpdir(), 'canvas-v020-evidence');
await mkdir(evidence, { recursive: true });
const extension = path.resolve(import.meta.dirname, '../extension');
const context = await chromium.launchPersistentContext(profile, { channel: 'chromium', headless: true, viewport: { width: 1600, height: 1050 }, args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const page = await context.newPage();
const errors = [], requests = [], failed = [];
page.on('pageerror', error => errors.push(error.message));
page.on('requestfailed', request => { if (request.url().startsWith('https://retry-fixture.invalid/')) failed.push(request.failure()?.errorText); });
let phase = 'setup', releaseBatch, releaseUnrelated;
const batchGate = new Promise(resolve => { releaseBatch = resolve; });
const unrelatedGate = new Promise(resolve => { releaseUnrelated = resolve; });
try {
  await page.route('**/__retry_seed__', route => route.fulfill({ contentType: 'text/html', body: '<title>Retry fixture</title>' }));
  await page.goto('https://canvas.best/__retry_seed__');
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    canvas.getContext('2d').fillRect(0, 0, 96, 96);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const data = canvas.toDataURL();
    const node = (id, x, y) => ({ id, type: 'image', title: id, position: { x, y }, width: 170, height: 170,
      metadata: { status: 'error', prompt: id, generationType: 'generation', model: 'default::gpt-image-2', size: '1024x1024', count: 1 } });
    const batch = (id, x, y) => ({ ...node(id, x, y), metadata: { ...node(id, x, y).metadata, imageBatchExpanded: id === 'collapsed-batch' ? false : undefined, status: 'success', storageKey: 'image:primary', content: '', primaryImageId: id + '-primary', images: [
      { id: id + '-primary', status: 'success', storageKey: 'image:primary', content: '', naturalWidth: 96, naturalHeight: 96, bytes: blob.size, mimeType: 'image/png' },
      { id: id + '-a', status: 'error', content: '' }, { id: id + '-b', status: 'error', content: '' },
    ] } });
    const project = { id: 'retry-test', title: '新版重试兼容检查', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [node('visible-a', 130, 110), node('visible-b', 130, 410), node('offscreen', 20000, 20000), node('unrelated', 430, 410), batch('collapsed-batch', 550, 110), batch('expanded-batch', 850, 110)],
      connections: [], chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const db = await new Promise((resolve, reject) => { const req = indexedDB.open('infinite-canvas', 3); req.onupgradeneeded = () => { for (const name of ['app_state', 'image_files', 'media_files', 'image_generation_logs', 'video_generation_logs']) req.result.createObjectStore(name); }; req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });
    await new Promise(resolve => { const tx = db.transaction(['app_state', 'image_files'], 'readwrite'); tx.objectStore('app_state').put(JSON.stringify({ state: { projects: [project], deletedProjects: [] }, version: 0 }), 'infinite-canvas:canvas_store'); tx.objectStore('image_files').put(blob, 'image:primary'); tx.oncomplete = resolve; });
    db.close(); return data.split(',')[1];
  });
  await page.route('https://retry-fixture.invalid/**', async route => {
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': '*' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const prompt = route.request().postDataJSON()?.prompt;
    requests.push({ prompt, phase, at: Date.now() });
    if (prompt === 'unrelated') await unrelatedGate;
    if (prompt === 'expanded-batch') await batchGate;
    try {
      if (prompt === 'unrelated' || prompt === 'expanded-batch') await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png }] }) });
      else await route.fulfill({ headers, status: 500, contentType: 'application/json', body: JSON.stringify({ error: { message: 'Expected retry fixture failure' } }) });
    } catch { /* A cancelled fixture request is asserted below. */ }
  });
  await page.goto('https://canvas.best/canvas/retry-test');
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  await page.evaluate(() => window.CanvasSaveGuardNative.config.getState().updateConfig('channels', [{ id: 'default', name: 'Test', baseUrl: 'https://retry-fixture.invalid/v1', apiKey: 'fixture-only', apiFormat: 'openai', models: [{ name: 'gpt-image-2', capability: 'image' }] }]));
  assert.equal(await page.title(), '无限画布');
  assert.equal(await page.locator('[data-node-id="offscreen"]').count(), 0);
  const expandButton = page.locator('[data-node-id="expanded-batch"]').getByRole('button', { name: '图片组已收起', exact: true });
  if (await expandButton.count()) await expandButton.click();
  await page.waitForFunction(() => window.CanvasSaveGuardRetry.list().length === 6);
  const beforeSelection = await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot()));
  const viewportBefore = await page.evaluate(() => window.CanvasSaveGuardHistory.viewport());
  const a = await page.locator('[data-node-id="visible-a"]').boundingBox();
  const b = await page.locator('[data-node-id="visible-b"]').boundingBox();
  await page.keyboard.down('Shift'); await page.mouse.move(Math.min(a.x, b.x) - 18, Math.min(a.y, b.y) - 18); await page.mouse.down();
  await page.mouse.move(Math.max(a.x + a.width, b.x + b.width) + 18, Math.max(a.y + a.height, b.y + b.height) + 18, { steps: 10 }); await page.mouse.up(); await page.keyboard.up('Shift');
  assert.equal(await page.locator('[data-node-id="visible-a"]').evaluate(el => el.classList.contains('z-50')), true);
  assert.equal(await page.locator('[data-node-id="visible-b"]').evaluate(el => el.classList.contains('z-50')), true);
  assert.equal(await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), beforeSelection);
  assert.deepEqual(await page.evaluate(() => window.CanvasSaveGuardHistory.viewport()), viewportBefore);
  console.log('PASS v0.20 Shift rectangle selection retains node positions and viewport');
  await page.keyboard.press('Escape');
  await page.locator('[data-node-id="unrelated"]').getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.find(n => n.id === 'unrelated').metadata.status === 'loading');
  const panel = page.locator('#local-canvas-retry-panel');
  await panel.getByLabel('逐项提交间隔（秒）', { exact: true }).fill('0.2');
  phase = 'manual';
  await panel.getByRole('button', { name: /^重试当前失败项/ }).click();
  await page.waitForFunction(() => document.querySelector('#local-canvas-retry-panel').shadowRoot.querySelector('#status').textContent.includes('本轮提交结束'));
  const manual = requests.filter(item => item.phase === 'manual');
  assert.equal(manual.length, 5);
  assert.equal(manual.filter(item => item.prompt === 'expanded-batch').length, 2);
  assert.equal(manual.filter(item => item.prompt === 'offscreen').length, 1);
  assert.ok(!manual.some(item => item.prompt === 'collapsed-batch'));
  for (let i = 1; i < manual.length; i++) assert.ok(manual[i].at - manual[i - 1].at >= 170);
  assert.equal(await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot().nodes.find(n => n.id === 'unrelated').metadata.status), 'loading');
  assert.equal(failed.length, 0);
  releaseBatch();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.find(n => n.id === 'expanded-batch').metadata.images.every(image => image.status === 'success' && image.storageKey));
  console.log('PASS manual retry submits offscreen failures and each expanded batch failure at the configured interval while unrelated generation continues');
  console.log('PASS two retries in the same batch both complete through the native handler');
  releaseUnrelated();
  await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.find(n => n.id === 'unrelated').metadata.status === 'success');
  phase = 'auto';
  await panel.getByLabel('自动重试间隔（秒）', { exact: true }).fill('60');
  await panel.getByRole('button', { name: '自动重试', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('#local-canvas-retry-panel').shadowRoot.querySelector('#auto-status').textContent.startsWith('下次检查时间'));
  console.log('PASS automatic retry starts through the same per-item queue, awaiting the next 60-second round');
  const firstAuto = requests.find(item => item.phase === 'auto').at;
  while (requests.filter(item => item.phase === 'auto').length < 6 && Date.now() - firstAuto < 70000) await page.waitForTimeout(500);
  await panel.getByRole('button', { name: '取消重试', exact: true }).click();
  const automatic = requests.filter(item => item.phase === 'auto');
  assert.equal(automatic.length, 6);
  assert.ok(automatic[3].at - automatic[0].at >= 59000);
  assert.ok(automatic[3].at - automatic[0].at < 65000);
  for (const offset of [0, 3]) assert.deepEqual(automatic.slice(offset, offset + 3).map(item => item.prompt), ['visible-a', 'visible-b', 'offscreen']);
  assert.equal(await panel.getByRole('button', { name: '自动重试', exact: true }).getAttribute('aria-pressed'), 'false');
  assert.equal(failed.length, 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(evidence, 'retry-rounds.png') });
  await writeFile(path.join(evidence, 'retry-results.json'), JSON.stringify({ manual, automatic, failed, errors }, null, 2));
  console.log('PASS second automatic round keeps the 60-second start-to-start schedule and skips the collapsed batch');
} catch (error) {
  console.log('RETRY STATE', await page.evaluate(() => ({ status: window.CanvasSaveGuard?.status(), targets: window.CanvasSaveGuardRetry?.list(), text: document.querySelector('#local-canvas-retry-panel')?.shadowRoot?.textContent.slice(-700) })));
  console.log('REQUESTS', requests);
  await page.screenshot({ path: path.join(evidence, 'retry-failure.png') }).catch(() => {});
  throw error;
} finally {
  releaseBatch(); releaseUnrelated();
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
