// Browser plugin is unavailable. Use a disposable Chromium profile for mouse regression checks.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const profile = await mkdtemp(path.join(tmpdir(), 'canvas-v020-pointer-'));
const evidence = path.join(tmpdir(), 'canvas-v020-evidence');
await mkdir(evidence, { recursive: true });
const extension = path.resolve(import.meta.dirname, '../extension');
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1600, height: 1050 },
  args: [`--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
});
const page = await context.newPage();
const errors = [], results = [];
page.on('pageerror', error => errors.push(error.message));
const pass = name => { results.push(name); console.log('PASS', name); };
const snapshot = () => page.evaluate(() => window.CanvasSaveGuardHistory.snapshot());
const viewport = () => page.evaluate(() => window.CanvasSaveGuardHistory.viewport());

try {
  await page.route('**/__pointer_seed__', route => route.fulfill({ contentType: 'text/html', body: '<title>Pointer fixture</title>' }));
  await page.goto('https://canvas.best/__pointer_seed__');
  await page.evaluate(async () => {
    const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 96;
    canvas.getContext('2d').fillRect(0, 0, 96, 96);
    const blob = await new Promise(resolve => canvas.toBlob(resolve));
    const metadata = id => ({ status: 'success', content: `blob:https://canvas.best/expired-${id}`, storageKey: `image:${id}`, naturalWidth: 96, naturalHeight: 96, bytes: blob.size, mimeType: 'image/png' });
    const node = (id, x) => ({ id, type: 'image', title: id, position: { x, y: 170 }, width: 180, height: 180, metadata: metadata(id) });
    const batch = node('batch', 520);
    batch.metadata.images = [{ id: 'batch', ...metadata('batch') }, { id: 'batch-child', ...metadata('batch-child') }];
    batch.metadata.primaryImageId = 'batch';
    const project = { id: 'pointer-test', title: '新版鼠标兼容检查', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      nodes: [node('image', 160), batch], connections: [], chatSessions: [], activeChatId: null,
      backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 } };
    const db = await new Promise(resolve => {
      const req = indexedDB.open('infinite-canvas', 3);
      req.onupgradeneeded = () => { for (const name of ['app_state', 'image_files', 'media_files', 'image_generation_logs', 'video_generation_logs']) req.result.createObjectStore(name); };
      req.onsuccess = () => resolve(req.result);
    });
    await new Promise(resolve => {
      const tx = db.transaction(['app_state', 'image_files'], 'readwrite');
      tx.objectStore('app_state').put(JSON.stringify({ state: { projects: [project], deletedProjects: [] }, version: 0 }), 'infinite-canvas:canvas_store');
      for (const id of ['image', 'batch', 'batch-child']) tx.objectStore('image_files').put(blob, `image:${id}`);
      tx.oncomplete = resolve;
    });
    db.close();
  });
  await page.goto('https://canvas.best/canvas/pointer-test');
  await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
  const image = page.locator('[data-node-id="image"]');
  const batch = page.locator('[data-node-id="batch"]');
  const guard = page.locator('#canvas-save-guard');
  const retry = page.locator('#local-canvas-retry-panel');
  await page.waitForFunction(() => [...document.querySelectorAll('[data-node-id] img')].every(img => img.naturalWidth === 96));
  await image.click({ position: { x: 90, y: 90 } });
  await page.waitForSelector('[data-node-panel="image"]');
  await batch.click({ position: { x: 90, y: 90 } });
  await page.waitForSelector('[data-node-panel="batch"]');
  pass('ordinary images and collapsed batch roots open their native operation panels');

  const retryBefore = await retry.locator('section').boundingBox();
  assert.equal(retryBefore.height, 302);
  assert.equal((await guard.locator('section').boundingBox()).height, 333);
  await page.screenshot({ path: path.join(evidence, 'compact-panels.png') });
  const retryBody = retry.locator('.body');
  assert.equal(await retryBody.evaluate(el => getComputedStyle(el).overflowY), 'auto');
  await retry.getByRole('button', { name: '收起批量重试工具', exact: true }).click();
  assert.ok((await retry.locator('section').boundingBox()).height < 100);
  assert.equal(await page.evaluate(point => !!document.elementFromPoint(point.x + 10, point.y + 10)?.closest('#local-canvas-retry-panel'), retryBefore), false);
  await retry.getByRole('button', { name: '展开批量重试设置', exact: true }).click();
  await guard.getByRole('button', { name: '收起重试工具', exact: true }).click();
  assert.equal(await retry.isVisible(), false);
  pass('folding and hiding the retry panel releases its former canvas area');

  const bounds = await image.boundingBox();
  await page.evaluate(bounds => {
    document.querySelector('#canvas-save-guard-pointer-style').disabled = true;
    const root = document.createElement('div'); root.id = 'guard-message-fixture'; root.className = 'ant-message';
    root.style.cssText = 'position:fixed;inset:0;z-index:2147483000;pointer-events:none';
    const notice = document.createElement('div'); notice.className = 'ant-message-notice';
    notice.style.cssText = `position:absolute;left:${bounds.x - 25}px;top:${bounds.y - 25}px;width:300px;height:290px;pointer-events:auto;cursor:default;background:#eee;color:#252831`;
    const title = document.createElement('div'); title.textContent = '可见测试提示';
    const button = document.createElement('button'); button.textContent = '提示关闭测试'; button.style.cssText = 'position:absolute;left:10px;bottom:10px';
    button.onclick = () => { root.dataset.action = 'clicked'; };
    notice.append(title, button); root.append(notice); document.body.append(root);
  }, bounds);
  assert.equal(await page.evaluate(bounds => !!document.elementFromPoint(bounds.x + 90, bounds.y + 90)?.closest('#guard-message-fixture'), bounds), true);
  await page.evaluate(() => { document.querySelector('#canvas-save-guard-pointer-style').disabled = false; });
  assert.equal(await page.evaluate(bounds => !!document.elementFromPoint(bounds.x + 90, bounds.y + 90)?.closest('#guard-message-fixture'), bounds), false);
  assert.equal(await page.getByText('可见测试提示', { exact: true }).isVisible(), true);
  await image.click({ position: { x: 90, y: 90 } });
  await page.waitForSelector('[data-node-panel="image"]');
  const beforeDrag = (await snapshot()).nodes.find(node => node.id === 'image').position;
  await page.mouse.move(bounds.x + 90, bounds.y + 90); await page.mouse.down();
  await page.mouse.move(bounds.x + 125, bounds.y + 115, { steps: 5 }); await page.mouse.up();
  assert.deepEqual((await snapshot()).nodes.find(node => node.id === 'image').position, { x: beforeDrag.x + 35, y: beforeDrag.y + 25 });
  await page.getByRole('button', { name: '提示关闭测试', exact: true }).click();
  assert.equal(await page.locator('#guard-message-fixture').getAttribute('data-action'), 'clicked');
  await page.evaluate(() => document.querySelector('#guard-message-fixture').remove());
  pass('default-cursor message rectangles pass image selection and dragging through while explicit buttons remain clickable');

  await page.mouse.move(900, 650); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(930, 680, { steps: 5 });
  assert.equal(await page.evaluate(() => getComputedStyle(document.elementFromPoint(900, 650)).cursor), 'grabbing');
  await page.evaluate(() => document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#pointer').click());
  await page.mouse.up({ button: 'middle' });
  assert.equal(await page.evaluate(() => document.body.style.cursor), '');
  assert.equal(await page.evaluate(() => getComputedStyle(document.elementFromPoint(900, 650)).cursor), 'grab');
  const cancelledViewport = await viewport();
  await page.mouse.move(970, 720, { steps: 5 });
  assert.deepEqual(await viewport(), cancelledViewport);
  await image.click({ position: { x: 90, y: 90 } });
  await page.waitForSelector('[data-node-panel="image"]');
  pass('restore-mouse button cancels a captured pan and restores normal image clicks');

  const dragBounds = await image.boundingBox();
  await page.mouse.move(dragBounds.x + 90, dragBounds.y + 90); await page.mouse.down();
  await page.mouse.move(dragBounds.x + 100, dragBounds.y + 100, { steps: 5 });
  assert.equal(await page.evaluate(() => window.CanvasSaveGuardHistory.idle()), false);
  await page.evaluate(() => document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#pointer').click());
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.CanvasSaveGuardHistory.idle()), true);
  const restoredNodes = (await snapshot()).nodes;
  await page.mouse.move(dragBounds.x + 150, dragBounds.y + 150, { steps: 5 });
  assert.deepEqual((await snapshot()).nodes, restoredNodes);
  pass('restore-mouse button ends a residual node drag without further movement');

  await page.mouse.move(950, 700); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(960, 710, { steps: 5 });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up({ button: 'middle' });
  assert.equal(await page.evaluate(() => document.body.style.cursor), '');
  assert.equal(await page.evaluate(() => getComputedStyle(document.elementFromPoint(950, 700)).cursor), 'grab');
  const blurredViewport = await viewport();
  await page.mouse.move(990, 740, { steps: 5 });
  assert.deepEqual(await viewport(), blurredViewport);
  pass('native lost-focus handling cancels panning and releases the grabbing cursor');

  await page.mouse.click(1150, 450);
  await page.waitForFunction(() => !document.querySelector('[data-node-panel]'));
  const a = await image.boundingBox(), b = await batch.boundingBox();
  const beforeSelection = await snapshot(), beforeSelectionViewport = await viewport();
  await page.keyboard.down('Shift'); await page.mouse.move(Math.min(a.x, b.x) - 20, Math.min(a.y, b.y) - 20); await page.mouse.down();
  await page.mouse.move(Math.max(a.x + a.width, b.x + b.width) + 20, Math.max(a.y + a.height, b.y + b.height) + 20, { steps: 10 });
  await page.mouse.up(); await page.keyboard.up('Shift');
  assert.equal(await image.evaluate(el => el.classList.contains('z-50')), true);
  assert.equal(await batch.evaluate(el => el.classList.contains('z-50')), true);
  assert.deepEqual(await snapshot(), beforeSelection);
  assert.deepEqual(await viewport(), beforeSelectionViewport);
  pass('Shift-left rectangle selection remains functional after overlay and interruption recovery');

  assert.deepEqual(errors, []);
  await page.screenshot({ path: path.join(evidence, 'pointer-checks.png') });
  await writeFile(path.join(evidence, 'pointer-results.json'), JSON.stringify({ version: '1.0.19', results, errors }, null, 2));
} catch (error) {
  console.log(await page.evaluate(() => ({ cursor: document.body.style.cursor, viewport: window.CanvasSaveGuardHistory?.viewport(), target: document.elementFromPoint(900, 650)?.outerHTML.slice(0, 1200) })));
  await page.screenshot({ path: path.join(evidence, 'pointer-failure.png') });
  throw error;
} finally {
  await context.close();
  assert.ok(path.resolve(profile).startsWith(path.resolve(tmpdir()) + path.sep));
  await rm(profile, { recursive: true, force: true });
}
