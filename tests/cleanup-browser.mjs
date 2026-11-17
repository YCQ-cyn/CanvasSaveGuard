// Browser plugin not available. Use the real v0.4.0 application in a disposable
// Chromium profile, including the extension's ordinary button/message path.
import { chromium } from 'playwright';
import { mkdtemp, mkdir, writeFile, readFile, cp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

const extension = path.resolve(import.meta.dirname, '../extension');
const legacyScript = process.env.GUARD_AUDIT_LEGACY_SCRIPT || process.env.GUARD_CLEANUP_LEGACY_SCRIPT;
let loadedExtension = extension;
if (legacyScript) {
  loadedExtension = await mkdtemp(path.join(tmpdir(), 'canvas-cleanup-legacy-extension-'));
  await cp(extension, loadedExtension, { recursive: true, filter: source => !source.includes('_metadata') });
  await writeFile(path.join(loadedExtension, 'guard.js'), await readFile(legacyScript));
  if (process.env.GUARD_AUDIT_LEGACY_SCRIPT) {
    await writeFile(path.join(loadedExtension, 'cleanup-bridge.js'), await readFile(path.join(path.dirname(legacyScript), 'legacy-bridge-115.js')));
  }
}
const profile = await mkdtemp(path.join(tmpdir(), 'canvas-cleanup-test-'));
const evidence = path.join(tmpdir(), process.env.GUARD_AUDIT_LEGACY_SCRIPT ? 'canvas-cleanup-evidence-audit-hot' : process.env.GUARD_CLEANUP_LEGACY_SCRIPT ? 'canvas-cleanup-evidence-hot' : 'canvas-cleanup-evidence');
await mkdir(evidence, { recursive: true });
const context = await chromium.launchPersistentContext(profile, {
  channel: 'chromium', headless: true, viewport: { width: 1600, height: 1050 },
  args: [`--disable-extensions-except=${loadedExtension}`, `--load-extension=${loadedExtension}`],
});
const errors = [];
const checks = [];
const page = await context.newPage();
page.on('pageerror', error => errors.push(error.stack));
function pass(name) { checks.push(name); console.log('PASS', name); }
let releaseGeneration;
const generationGate = new Promise(resolve => { releaseGeneration = resolve; });
let requestStarted = false;

try {
  async function runChecks() {
    await page.route('**/__cleanup_seed__', route => route.fulfill({ contentType: 'text/html', body: '<title>Cleanup fixture</title>' }));
    await page.goto('https://canvas.modelaryx.com/__cleanup_seed__');
    const png = await page.evaluate(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 32; canvas.height = 32;
      canvas.getContext('2d').fillRect(0, 0, 32, 32);
      const png = canvas.toDataURL('image/png');
      const blob = await new Promise(resolve => canvas.toBlob(resolve));
      canvas.getContext('2d').fillStyle = '#ee6500';
      canvas.getContext('2d').fillRect(0, 0, 32, 32);
      const unusedBlob = await new Promise(resolve => canvas.toBlob(resolve));
      const makeNode = (id, x, y, status = 'success', key = `image:${id}`) => ({
        id, type: 'image', title: id, position: { x, y }, width: 170, height: 170,
        metadata: { status, storageKey: key, content: `blob:https://canvas.modelaryx.com/expired-${id}`, mimeType: 'image/png', bytes: blob.size, naturalWidth: 32, naturalHeight: 32, prompt: 'a plain square', generationType: 'generation', model: 'default::gpt-image-2', size: '1024x1024', count: 1 },
      });
      const project = {
        id: 'cleanup-test', title: '删除缓存测试', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        nodes: [
          makeNode('visible', 130, 120), makeNode('deleted', 430, 120),
          { id: 'deleted-empty', type: 'image', title: 'deleted-empty', position: { x: 730, y: 120 }, width: 170, height: 170, metadata: { status: 'idle' } },
          makeNode('failed', 130, 430, 'error'),
          { ...makeNode('pending', 430, 430, 'error'), metadata: { status: 'error', errorDetails: 'test pending task', prompt: 'a plain square', generationType: 'generation', model: 'default::gpt-image-2', size: '1024x1024', count: 1 } },
          { id: 'live-empty', type: 'image', title: 'live-empty', position: { x: 730, y: 430 }, width: 170, height: 170, metadata: { status: 'idle' } },
          makeNode('full-pending', 1030, 430, 'error'),
          makeNode('button-deleted', 1030, 120),
          makeNode('offscreen-success', 20000, 20000),
          makeNode('offscreen-error', 20300, 20000, 'error'),
          { ...makeNode('kept-group', 130, 700), metadata: { ...makeNode('kept-group', 130, 700).metadata, isBatchRoot: true, batchChildIds: ['folded-a', 'folded-b'], imageBatchExpanded: false } },
          { ...makeNode('folded-a', 430, 700), metadata: { ...makeNode('folded-a', 430, 700).metadata, batchRootId: 'kept-group' } },
          { ...makeNode('folded-b', 730, 700), metadata: { ...makeNode('folded-b', 730, 700).metadata, batchRootId: 'kept-group' } },
        ],
        connections: [
          { id: 'deleted-connection', fromNodeId: 'visible', toNodeId: 'deleted' },
          { id: 'live-connection', fromNodeId: 'visible', toNodeId: 'failed' },
        ],
        chatSessions: [], activeChatId: null, backgroundMode: 'lines', showImageInfo: false, viewport: { x: 0, y: 0, k: 1 },
      };
      project.nodes[0].metadata.references = ['image:pinned-reference'];
      project.nodes[1].metadata.references = ['image:asset', 'image:workbench', 'image:other-tab', 'image:pinned-reference'];
      const other = { ...project, id: 'other-project', title: '其他画布', nodes: [makeNode('other-tab', 130, 120)], connections: [] };
      const request = indexedDB.open('infinite-canvas', 3);
      const db = await new Promise((resolve, reject) => {
        request.onupgradeneeded = () => { for (const name of ['app_state', 'image_files', 'media_files', 'image_generation_logs', 'video_generation_logs', 'local-forage-detect-blob-support']) request.result.createObjectStore(name); };
        request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const transaction = db.transaction(['app_state', 'image_files', 'image_generation_logs'], 'readwrite');
        transaction.objectStore('app_state').put(JSON.stringify({ state: { projects: [project, other] }, version: 0 }), 'infinite-canvas:canvas_store');
        transaction.objectStore('app_state').put(JSON.stringify({ state: { assets: [{ id: 'asset', kind: 'image', title: 'asset', coverUrl: '', data: { storageKey: 'image:asset', dataUrl: '', width: 32, height: 32, bytes: blob.size, mimeType: 'image/png' } }] }, version: 0 }), 'infinite-canvas:asset_store');
        transaction.objectStore('image_generation_logs').put({ id: 'log', references: ['image:workbench'] }, 'log');
        for (const key of ['image:visible', 'image:deleted', 'image:button-deleted', 'image:offscreen-success', 'image:offscreen-error', 'image:kept-group', 'image:folded-a', 'image:folded-b', 'image:failed', 'image:full-pending', 'image:asset', 'image:workbench', 'image:other-tab', 'image:pinned-reference', 'image:unknown-cache']) transaction.objectStore('image_files').put(key === 'image:unknown-cache' ? unusedBlob : blob, key);
        transaction.oncomplete = resolve; transaction.onabort = () => reject(transaction.error);
      });
      db.close(); return png;
    });

    await page.route('https://cleanup-fixture.invalid/**', async route => {
      const headers = { 'Access-Control-Allow-Origin': 'https://canvas.modelaryx.com', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ headers, status: 204 });
      requestStarted = true;
      await generationGate;
      await route.fulfill({ headers, contentType: 'application/json', body: JSON.stringify({ data: [{ b64_json: png.split(',')[1] }] }) });
    });
    await page.goto('https://canvas.modelaryx.com/canvas/cleanup-test');
    await page.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt);
    if (legacyScript) {
      await page.evaluate(() => { window.__guardBeforeUpgrade = window.CanvasSaveGuard; });
      if (process.env.GUARD_AUDIT_LEGACY_SCRIPT) {
        await page.evaluate(() => {
          window.__invalidatedBridgeCalls = 0;
          window.addEventListener('message', event => {
            if (event.source !== window || event.data?.type !== 'canvas-guard-cleanup') return;
            window.__invalidatedBridgeCalls += 1;
            window.postMessage({ type: 'canvas-guard-cleanup-result', id: event.data.id, error: 'Extension context invalidated.' }, location.origin);
          });
        });
        await writeFile(path.join(loadedExtension, 'guard.js'), await readFile(path.join(extension, 'guard.js')));
        await writeFile(path.join(loadedExtension, 'cleanup-bridge.js'), await readFile(path.join(extension, 'cleanup-bridge.js')));
        // Fresh paths avoid the script-file cache of the fixture's unpacked
        // extension while exercising the same isolated/main injection APIs.
        await writeFile(path.join(loadedExtension, 'audit-upgrade-guard.js'), await readFile(path.join(extension, 'guard.js')));
        await writeFile(path.join(loadedExtension, 'audit-upgrade-bridge.js'), await readFile(path.join(extension, 'cleanup-bridge.js')));
        const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js'));
        await worker.evaluate(async () => {
          for (const tab of await chrome.tabs.query({ url: 'https://canvas.modelaryx.com/*' })) {
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['audit-upgrade-bridge.js'] });
            await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['audit-upgrade-guard.js'] });
          }
        });
        await page.waitForFunction(() => window.CanvasSaveGuard?.referenceAuditVersion === 1);
      } else {
        await page.addScriptTag({ path: path.join(extension, 'guard.js') });
      }
      assert.equal(await page.evaluate(() => window.__guardBeforeUpgrade === window.CanvasSaveGuard), true);
      assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-progress').count(), 1);
      assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-current').count(), 0);
      if (process.env.GUARD_CLEANUP_LEGACY_SCRIPT) await assert.rejects(page.evaluate(() => window.CanvasSaveGuard.cleanupDeleted()), /重新打开画布/);
      if (await page.evaluate(() => typeof window.CanvasSaveGuard.cleanupCurrentOnly === 'function')) {
        await assert.rejects(page.evaluate(() => window.CanvasSaveGuard.cleanupCurrentOnly()), /扩大范围的清理已停用/);
      }
      if (process.env.GUARD_CLEANUP_LEGACY_SCRIPT) {
        pass('upgrading an old page disables broad cleanup and requires the native deletion record interface');
        await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks }, null, 2));
        return;
      }
      assert.equal(await page.evaluate(() => window.CanvasSaveGuard.referenceAuditVersion), 1);
      pass('script attachment replaces the bridge and adds audit to the existing writer without refreshing');
    }
    assert.equal(await page.title(), '无限画布');
    await page.evaluate(() => {
      const id = 'cleanup-test-modules';
      window.TURBOPACK.push(['static/chunks/cleanup-test-modules.js', id, c => {
        window.__cleanupModules = { config: c.i(56073).useConfigStore, images: c.i(7065), store: c.i(83629).useCanvasStore };
      }]);
      window.TURBOPACK.push(['static/chunks/cleanup-test-modules.js', { otherChunks: [], runtimeModuleIds: [id] }]);
    });
    await page.waitForFunction(() => !!window.__cleanupModules);
    await page.evaluate(() => {
      window.__cleanupModules.config.getState().updateConfig('channels', [{ id: 'default', name: 'Test', baseUrl: 'https://cleanup-fixture.invalid/v1', apiKey: 'fixture-only', models: ['gpt-image-2'] }]);
    });
    const other = await context.newPage();
    other.on('pageerror', error => errors.push(error.stack));
    await other.goto('https://canvas.modelaryx.com/canvas/other-project');
    await other.waitForFunction(() => window.CanvasSaveGuardHistory?.ready && window.CanvasSaveGuard?.status().protectedAt).catch(async error => {
      console.error('SECOND TAB', await other.evaluate(() => ({ url: location.href, ready: window.CanvasSaveGuardHistory?.ready, status: window.CanvasSaveGuard?.status(), body: document.body.innerText.slice(-1800) })));
      throw error;
    });
    if (process.env.GUARD_AUDIT_LEGACY_SCRIPT) {
      const worker = context.serviceWorkers().find(worker => worker.url().endsWith('/background.js'));
      await worker.evaluate(async () => {
        for (const tab of await chrome.tabs.query({ url: 'https://canvas.modelaryx.com/*' })) {
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', files: ['audit-upgrade-bridge.js'] });
          await chrome.scripting.executeScript({ target: { tabId: tab.id }, world: 'MAIN', files: ['audit-upgrade-guard.js'] });
        }
      });
    }
    const otherBefore = await other.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot()));
    await page.bringToFront();

    for (const id of ['deleted', 'deleted-empty']) {
      await page.locator(`[data-node-id="${id}"]`).click({ position: { x: 70, y: 60 } });
      await page.keyboard.press('Delete');
      await page.waitForSelector(`[data-node-id="${id}"]`, { state: 'detached' });
      await page.waitForFunction(id => window.CanvasSaveGuardHistory.retained().history.past.some(entry => entry.nodes.some(node => node.id === id)), id);
    }
    await page.locator('[data-node-id="button-deleted"]').click({ button: 'right', position: { x: 70, y: 60 } });
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await page.waitForSelector('[data-node-id="button-deleted"]', { state: 'detached' });
    await page.waitForFunction(() => window.CanvasSaveGuardHistory.retained().history.past.some(entry => entry.nodes.some(node => node.id === 'button-deleted')));
    assert.equal(await page.locator('[data-node-id="offscreen-success"]').count(), 0);
    assert.equal(await page.locator('[data-node-id="folded-a"]').count(), 0);
    await page.locator('[data-node-id="pending"]').getByRole('button', { name: '重试', exact: true }).click();
    await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.metadata?.status === 'loading'));
    await page.waitForTimeout(250);
    assert.equal(requestStarted, true);
    const before = await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot()));
    await page.evaluate(async () => {
      window.__cleanupProgressEvents = [];
      const root = document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup-progress');
      new MutationObserver(() => window.__cleanupProgressEvents.push(window.CanvasSaveGuard.cleanupProgress.read())).observe(root, { subtree: true, attributes: true, childList: true, characterData: true });
      await new Promise(resolve => {
        window.__cleanupWriter = navigator.locks.request('canvas-save-guard:media-cleanup', { mode: 'shared' }, async () => {
          resolve();
          await new Promise(release => { window.__releaseCleanupWriter = release; });
        });
      });
    });
    await page.locator('#canvas-save-guard').getByRole('button', { name: '清理删除缓存', exact: true }).click();
    await page.waitForFunction(() => window.CanvasSaveGuard.cleanupProgress.read().status === 'running');
    assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-progress').isVisible(), true);
    assert.equal(await page.locator('#canvas-save-guard').getByRole('progressbar', { name: '清理删除缓存进度' }).getAttribute('value'), null);
    await page.locator('#canvas-save-guard').screenshot({ path: path.join(evidence, 'cleanup-running-panel.png') });
    pass('cleanup displays a live waiting indicator immediately while another cache write holds the lock');
    await page.evaluate(async () => { window.__releaseCleanupWriter(); await window.__cleanupWriter; });
    await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
    const status = await page.locator('#canvas-save-guard').locator('#status').innerText();
    assert.match(status, process.env.GUARD_CLEANUP_LEGACY_SCRIPT ? /已清理|已保护/ : /已保护/);
    const progress = await page.evaluate(() => ({ state: window.CanvasSaveGuard.cleanupProgress.read(), events: window.__cleanupProgressEvents }));
    assert.equal(progress.state.status, 'complete');
    assert.equal(progress.state.percent, 100);
    assert.ok(progress.events.filter(event => event.status === 'running').every(event => event.percent !== 100));
    assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-progress-title').innerText(), '清理完成');
    assert.equal(await page.locator('#canvas-save-guard').getByRole('progressbar', { name: '清理删除缓存进度' }).getAttribute('value'), '100');
    if (!process.env.GUARD_CLEANUP_LEGACY_SCRIPT) {
      for (const step of [2, 3, 4, 5, 6, 7]) assert.ok(progress.events.some(event => event.step === step && Number.isFinite(event.total)), `missing real counters for step ${step}`);
      const resultText = await page.locator('#canvas-save-guard').locator('#cleanup-progress-result').innerText();
      assert.match(resultText, /扫描到全站浏览器媒体 \d+ 个，\d/);
      assert.match(resultText, /本次清理 2 个，\d/);
      assert.match(resultText, /仍被引用 \d+ 个，\d/);
      assert.match(resultText, /无明确删除记录 1 个，\d/);
      assert.match(resultText, /引用无法完整核对 0 个，0 B/);
      pass('cleanup displays measured file counts and bytes for scanned, removed and each retention reason');
    } else {
      assert.ok(progress.events.some(event => event.step === 3 && event.total === null));
      assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-result').innerText(), /旧版清理接口.*暂未提供数量和大小明细/);
    }
    await page.locator('#canvas-save-guard').screenshot({ path: path.join(evidence, 'cleanup-complete-panel.png') });
    pass('real stage counters reach 100% only after file commits and restoration of all pages');
    assert.equal(await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), before);
    assert.equal(await other.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), otherBefore);
    pass('cleanup button leaves all current nodes, links and other-tab scene bytes exactly unchanged');
    assert.equal(await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.id === 'failed' && node.metadata.status === 'error')), true);
    assert.equal(await page.evaluate(() => window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.metadata.status === 'loading')), true);
    assert.equal(await page.locator('[data-node-id="live-empty"]').count(), 1);
    pass('loading, failed and empty nodes remain on the canvas');

    const stored = await page.evaluate(async () => {
      async function values(name, store) {
        const db = await new Promise(resolve => { const request = indexedDB.open(name); request.onsuccess = () => resolve(request.result); });
        const result = await new Promise(resolve => { const request = db.transaction(store).objectStore(store).getAllKeys(); request.onsuccess = () => resolve(request.result); });
        db.close(); return result;
      }
      return { original: await values('infinite-canvas', 'image_files'), protected: await values('canvas-save-guard', 'media'), retained: JSON.stringify(window.CanvasSaveGuardHistory.retained()) };
    });
    assert.ok(!stored.original.includes('image:deleted'));
    assert.ok(!stored.original.includes('image:button-deleted'));
    assert.ok(!stored.protected.includes('image:deleted'));
    assert.ok(!stored.retained.includes('"id":"deleted"'));
    assert.ok(!stored.retained.includes('"id":"deleted-empty"'));
    assert.ok(!stored.retained.includes('deleted-connection'));
    for (const key of ['image:visible', 'image:failed', 'image:asset', 'image:workbench', 'image:other-tab', 'image:pinned-reference', 'image:unknown-cache']) assert.ok(stored.original.includes(key), key);
    for (const key of ['image:offscreen-success', 'image:offscreen-error', 'image:kept-group', 'image:folded-a', 'image:folded-b']) assert.ok(stored.original.includes(key), key);
    pass('offscreen nodes and folded group children retain their original files despite having no DOM elements');
    pass('deleted nodes and links leave undo history and only their unreferenced deleted image bytes are freed');
    pass('referenced media, assets, workbench records, another tab and unattributed caches remain');
    await page.keyboard.press('Control+z');
    await page.waitForTimeout(250);
    assert.equal(await page.locator('[data-node-id="deleted"]').count(), 0);
    assert.equal(await page.locator('[data-node-id="deleted-empty"]').count(), 0);
    pass('undo cannot restore purged deleted objects');
    releaseGeneration();
    await page.waitForFunction(() => window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.metadata?.prompt === 'a plain square' && node.metadata?.status === 'success' && node.id !== 'visible'));
    await page.waitForFunction(() => !window.CanvasSaveGuardHistory.snapshot().nodes.some(node => node.metadata?.status === 'loading'));
    pass('the request that was generating during cleanup still completes successfully');
    await other.evaluate(() => {
      const endpoint = window.CanvasSaveGuard.cleanupEndpoint;
      window.__originalPrepare = endpoint.prepareAudit;
      endpoint.prepareAudit = async () => { throw Error('测试用的页面核对失败'); };
    });
    await page.locator('#canvas-save-guard').getByRole('button', { name: '清理删除缓存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
    assert.equal(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().status), 'failed');
    assert.ok(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().percent < 100));
    assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-progress-title').innerText(), '清理未完成');
    await page.locator('#canvas-save-guard').screenshot({ path: path.join(evidence, 'cleanup-failed-panel.png') });
    pass('a cleanup error stops the indicator, reports failure and leaves the retry button available');
    await other.evaluate(() => { window.CanvasSaveGuard.cleanupEndpoint.prepareAudit = window.__originalPrepare; });
    await page.locator('#canvas-save-guard').getByRole('button', { name: '清理删除缓存', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
    assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-stage').innerText(), /已释放 0 个文件/);
    pass('repeated cleanup is safe and idempotent');
    assert.equal(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().status), 'complete');
    await page.screenshot({ path: path.join(evidence, 'cleanup-result.png') });
    await page.locator('#canvas-save-guard').screenshot({ path: path.join(evidence, 'cleanup-panel.png') });
    if (!process.env.GUARD_CLEANUP_LEGACY_SCRIPT) {
      // Reproduce the conservative retention signal from an unkeyed reference.
      // Use the fixture's unreferenced file as a deleted candidate; do not alter
      // any scene nodes to provoke the condition.
      const sceneBefore = await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot()));
      await other.evaluate(() => {
        const endpoint = window.CanvasSaveGuard.cleanupEndpoint;
        window.__retainedPrepareAudit = endpoint.prepareAudit;
        window.__retainedAuditRoots = endpoint.auditRoots;
        const inject = result => { result.candidateKeys = ['image:unknown-cache']; result.referenceData.urls.push({ url: 'blob:https://canvas.modelaryx.com/unknown-reference', path: '测试参考图' }); return result; };
        endpoint.prepareAudit = async (...args) => inject(await window.__retainedPrepareAudit.apply(endpoint, args));
        endpoint.auditRoots = (...args) => inject(window.__retainedAuditRoots.apply(endpoint, args));
      });
      await page.locator('#canvas-save-guard').getByRole('button', { name: '清理删除缓存', exact: true }).click();
      await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
      const text = await page.locator('#canvas-save-guard').locator('#cleanup-progress-result').innerText();
      assert.match(text, /引用无法完整核对 1 个，\d/);
      assert.match(text, /存在无法核对的临时引用，暂停删除待清理媒体/);
      assert.equal(await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), sceneBefore);
      assert.equal(await other.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), otherBefore);
      const preserved = await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open('infinite-canvas'); request.onsuccess = () => resolve(request.result); });
        const blob = await new Promise(resolve => { const request = db.transaction('image_files').objectStore('image_files').get('image:unknown-cache'); request.onsuccess = () => resolve(request.result); });
        db.close(); return blob.size;
      });
      assert.ok(preserved > 0);
      await page.locator('#canvas-save-guard').screenshot({ path: path.join(evidence, 'cleanup-retained-panel.png') });
      pass('unverifiable references show exact retained counts and bytes while leaving files and all scenes untouched');

      await other.evaluate(() => { const e = window.CanvasSaveGuard.cleanupEndpoint; e.prepareAudit = window.__retainedPrepareAudit; e.auditRoots = window.__retainedAuditRoots; });
      assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-current').count(), 0);
      const rejected = await page.evaluate(() => new Promise(resolve => {
        const id = crypto.randomUUID();
        const receive = event => {
          if (event.source !== window || event.data?.type !== 'canvas-guard-cleanup-result' || event.data.id !== id) return;
          window.removeEventListener('message', receive);
          resolve(event.data.error);
        };
        window.addEventListener('message', receive);
        window.postMessage({ type: 'canvas-guard-cleanup', id, action: 'prepare', data: { token: crypto.randomUUID(), mode: 'current-only' } }, location.origin);
      }));
      assert.match(rejected, /扩大范围的清理已停用/);
      assert.ok(await page.evaluate(() => window.__cleanupModules.store.getState().projects.some(project => project.id === 'other-project')));
      pass('the broad cleanup button is removed and stale broad cleanup requests are rejected');
      async function rectangleSelection(modifier) {
        await page.keyboard.press('Escape');
        const before = await page.evaluate(() => ({ scene: JSON.stringify(window.CanvasSaveGuardHistory.snapshot()), viewport: window.CanvasSaveGuardHistory.viewport() }));
        const visible = await page.locator('[data-node-id="visible"]').boundingBox();
        const failed = await page.locator('[data-node-id="failed"]').boundingBox();
        await page.keyboard.down(modifier);
        await page.mouse.move(Math.min(visible.x, failed.x) - 16, Math.min(visible.y, failed.y) - 16);
        await page.mouse.down();
        await page.mouse.move(Math.max(visible.x + visible.width, failed.x + failed.width) + 16, Math.max(visible.y + visible.height, failed.y + failed.height) + 16, { steps: 12 });
        await page.screenshot({ path: path.join(evidence, `rectangle-${modifier}.png`) });
        await page.mouse.up();
        await page.keyboard.up(modifier);
        await page.waitForFunction(() => ['visible', 'failed'].every(id => document.querySelector(`[data-node-id="${id}"]`).classList.contains('z-50')));
        assert.deepEqual(await page.evaluate(() => ({ scene: JSON.stringify(window.CanvasSaveGuardHistory.snapshot()), viewport: window.CanvasSaveGuardHistory.viewport() })), before);
      }
      await rectangleSelection('Shift');
      pass('Shift plus left drag selects multiple nodes using the native rectangle without moving nodes or panning');
      await page.keyboard.down('Shift');
      await page.locator('[data-node-id="live-empty"]').click({ position: { x: 65, y: 60 } });
      await page.keyboard.up('Shift');
      await page.waitForFunction(() => ['visible', 'failed', 'live-empty'].every(id => document.querySelector(`[data-node-id="${id}"]`).classList.contains('z-50')));
      pass('existing Shift-click still adds individual nodes to the selection');
      await page.keyboard.press('Escape');
      const previousScale = await page.evaluate(() => window.CanvasSaveGuardHistory.viewport().k);
      await page.mouse.move(950, 200);
      await page.mouse.wheel(0, 180);
      await page.waitForFunction(scale => window.CanvasSaveGuardHistory.viewport().k !== scale, previousScale);
      await rectangleSelection('Shift');
      await rectangleSelection('Control');
      pass('rectangle selection respects canvas zoom and retains the existing Ctrl shortcut');
      await page.keyboard.press('Escape');
      const unusedButton = page.locator('#canvas-save-guard').getByRole('button', { name: '清理删除缓存', exact: true });
      assert.equal(await page.locator('#canvas-save-guard').locator('#cleanup-unused').count(), 0);
      const currentBeforeAudit = await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot()));
      await unusedButton.click();
      await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
      assert.equal(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().status), 'complete');
      assert.equal(await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), currentBeforeAudit);
      assert.equal(await other.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), otherBefore);
      const unusedKeys = await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open('infinite-canvas'); request.onsuccess = () => resolve(request.result); });
        const result = await new Promise(resolve => { const request = db.transaction('image_files').objectStore('image_files').getAllKeys(); request.onsuccess = () => resolve(request.result); });
        db.close(); return result;
      });
      assert.ok(unusedKeys.includes('image:unknown-cache'));
      for (const key of ['image:offscreen-success', 'image:offscreen-error', 'image:kept-group', 'image:folded-a', 'image:folded-b', 'image:pinned-reference', 'image:asset', 'image:workbench', 'image:other-tab']) assert.ok(unusedKeys.includes(key), key);
      assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-stage').innerText(), /已释放 0 个文件/);
      await page.locator('#canvas-save-guard').screenshot({ path: path.join(evidence, 'deleted-audit-complete.png') });
      pass('audited cleanup preserves untracked media and all current, offscreen, folded, failed and referenced data');

      await page.evaluate(async () => {
        const db = await new Promise(resolve => { const request = indexedDB.open('infinite-canvas'); request.onsuccess = () => resolve(request.result); });
        await new Promise(resolve => { const tx = db.transaction('image_files', 'readwrite'); tx.objectStore('image_files').put(new Blob(['deleted race fixture']), 'image:audit-race'); tx.oncomplete = resolve; });
        db.close();
        const vault = await new Promise(resolve => { const req = indexedDB.open('canvas-save-guard'); req.onsuccess = () => resolve(req.result); });
        await new Promise(resolve => { const tx = vault.transaction('cleanup_candidates', 'readwrite'); tx.objectStore('cleanup_candidates').put({ source: 'user-delete', projectId: 'cleanup-test', keys: ['image:audit-race'], nodeIds: ['audit-race-removed'], connectionIds: [] }, 'fixture-race-delete'); tx.oncomplete = resolve; });
        vault.close();
        const endpoint = window.CanvasSaveGuard.cleanupEndpoint;
        window.__auditRoots = endpoint.auditRoots;
        endpoint.auditRoots = function (...args) { const result = window.__auditRoots.apply(this, args); result.keys.push('image:changed-reference'); return result; };
      });
      await unusedButton.click();
      await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
      assert.equal(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().status), 'failed');
      assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-stage').innerText(), /图片引用发生变化/);
      await page.evaluate(() => {
        const endpoint = window.CanvasSaveGuard.cleanupEndpoint;
        endpoint.auditRoots = window.__auditRoots;
        window.__prepareAudit = endpoint.prepareAudit;
        const inject = result => { result.referenceData.urls.push({ url: 'blob:https://canvas.modelaryx.com/missing-audit-reference', path: '测试参考图' }); return result; };
        endpoint.prepareAudit = async function (...args) { return inject(await window.__prepareAudit.apply(this, args)); };
        endpoint.auditRoots = function (...args) { return inject(window.__auditRoots.apply(this, args)); };
      });
      await unusedButton.click();
      await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
      assert.equal(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().status), 'complete');
      assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-result').innerText(), /测试参考图/);
      assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-stage').innerText(), /已释放 0 个文件/);
      await page.evaluate(() => { window.CanvasSaveGuard.cleanupEndpoint.prepareAudit = window.__prepareAudit; window.CanvasSaveGuard.cleanupEndpoint.auditRoots = window.__auditRoots; });
      await unusedButton.click();
      await page.waitForFunction(() => !document.querySelector('#canvas-save-guard').shadowRoot.querySelector('#cleanup').disabled);
      assert.equal(await page.evaluate(() => window.CanvasSaveGuard.cleanupProgress.read().status), 'complete');
      assert.match(await page.locator('#canvas-save-guard').locator('#cleanup-progress-stage').innerText(), /已释放 1 个文件/);
      assert.equal(await page.evaluate(() => JSON.stringify(window.CanvasSaveGuardHistory.snapshot())), currentBeforeAudit);
      assert.doesNotMatch(await page.locator('#canvas-save-guard').locator('#status').innerText(), /引用发生变化/);
      pass('changed references stop deletion, unreadable references display their location, and retry releases only the explicitly deleted file');
    }
    assert.deepEqual(errors, []);
    if (process.env.GUARD_AUDIT_LEGACY_SCRIPT) {
      assert.equal(await page.evaluate(() => window.__invalidatedBridgeCalls), 0);
      pass('fresh bridge capture prevents obsolete context-error responses from interfering with cleanup');
    }
    pass('no application runtime errors');
    await writeFile(path.join(evidence, 'results.json'), JSON.stringify({ checks, status }, null, 2));
    console.log('EVIDENCE', evidence);
  }
  await runChecks();
} catch (error) {
  console.error('CLEANUP CHECK FAILED', error);
  console.log(await page.evaluate(() => ({ status: window.CanvasSaveGuard?.status(), text: document.querySelector('#canvas-save-guard')?.shadowRoot?.querySelector('#status')?.textContent, snapshot: window.CanvasSaveGuardHistory?.snapshot() })).catch(() => ({ url: page.url() })));
  await page.screenshot({ path: path.join(evidence, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  releaseGeneration();
  await context.close();
}
