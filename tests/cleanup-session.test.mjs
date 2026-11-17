import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { installDeletedCleanup } from '../src/cleanup.mjs';
import { CLEANUP_LOCK } from '../src/cleanup-storage.mjs';

const leaseName = token => `${CLEANUP_LOCK}:session:${token}`;
const emptySnapshot = () => ({ keys: [], projects: [], liveProjectIds: [], candidateKeys: [], referenceData: { urls: [], aliases: [] }, preserveAllMedia: false });

function endpointFixture(context, getDeletedObjects = async () => ({ nodeIds: [], connectionIds: [], images: [], mediaKeys: [], waiting: {}, revision: 'none' })) {
  const originals = Object.fromEntries(['document', 'window', 'location', 'navigator', 'CanvasSaveGuardHistory'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  context.after(() => {
    for (const [name, descriptor] of Object.entries(originals)) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else delete globalThis[name];
    }
  });
  const attributes = new Set(), blockedEvents = new Set(), watchers = [];
  const locks = {
    held: [],
    query: async () => ({ held: locks.held, pending: [] }),
    request(name, { signal }, callback) {
      return new Promise((resolve, reject) => {
        const watcher = { name, callback, resolve, signal };
        watchers.push(watcher);
        signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      });
    },
    hold(token, owner = 'owner') {
      locks.held = [{ name: CLEANUP_LOCK, mode: 'exclusive', clientId: owner }, { name: leaseName(token), mode: 'exclusive', clientId: owner }];
    },
    async end(token) {
      locks.held = locks.held.filter(lock => lock.name !== leaseName(token));
      for (const watcher of watchers.filter(watcher => watcher.name === leaseName(token) && !watcher.signal.aborted)) {
        watcher.resolve(watcher.callback());
      }
      await Promise.resolve();
    },
  };
  globalThis.document = {
    addEventListener: name => blockedEvents.add(name), removeEventListener: name => blockedEvents.delete(name),
    querySelectorAll: () => [], documentElement: { setAttribute: name => attributes.add(name), removeAttribute: name => attributes.delete(name) },
  };
  globalThis.window = { addEventListener() {} };
  globalThis.location = { pathname: '/canvas/current' };
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks } });
  const current = { id: 'current', title: 'current', nodes: [{ id: 'keep', type: 'image', position: { x: 1, y: 2 }, metadata: { storageKey: 'image:keep', status: 'error', prompt: 'keep' } }], connections: [] };
  let pruned = 0;
  globalThis.CanvasSaveGuardHistory = { projectId: 'current', ready: true, deletedOnlyVersion: 1, idle: () => true,
    snapshot: () => current, retained: () => ({}), prune: () => { pruned += 1; } };
  const store = { getState: () => ({ projects: [current] }) };
  const state = store.getState();
  store.getState = () => state;
  const guard = {};
  installDeletedCleanup({ guard, getStore: () => store, getServices: () => ({}), flush: async () => {},
    releaseSessionMedia: () => ({}), getDeletedObjects, getKnownMediaUrls: () => [], fetchBlob: async () => {} });
  return { endpoint: guard.cleanupEndpoint, locks, attributes, blockedEvents, current, pruned: () => pruned };
}

test('a new run reclaims only a stale marker while it holds both browser locks, and old release messages cannot cancel it', async context => {
  const fixture = endpointFixture(context);
  const { endpoint, locks, attributes, current } = fixture;
  const original = JSON.stringify(current);
  await endpoint.prepare('old-worker-session', false);
  assert.ok(attributes.has('data-canvas-guard-cleaning'));
  locks.hold('new-session');
  await endpoint.prepareAudit('new-session', false, 1);
  assert.ok(!attributes.has('data-canvas-guard-cleaning'));
  endpoint.release('old-worker-session');
  assert.ok(endpoint.auditRoots('new-session').keys.includes('image:keep'));
  await assert.rejects(endpoint.prepare('intruder', false, 1), /清理会话已结束/);
  assert.ok(endpoint.auditRoots('new-session').keys.includes('image:keep'));
  assert.equal(JSON.stringify(current), original);
  endpoint.release('new-session');
});

test('ending the actual owner lock releases every local input blocker without polling or a coordinator finish', async context => {
  const { endpoint, locks, attributes, blockedEvents } = endpointFixture(context);
  locks.hold('lost-owner');
  await endpoint.prepare('lost-owner', false, 1);
  assert.ok(attributes.has('data-canvas-guard-cleaning'));
  assert.ok(blockedEvents.size > 0);
  await locks.end('lost-owner');
  assert.ok(!attributes.has('data-canvas-guard-cleaning'));
  assert.equal(blockedEvents.size, 0);
  assert.throws(() => endpoint.auditRoots('lost-owner'), /清理会话已结束|缓存核对会话已结束/);
  locks.hold('retry');
  await endpoint.prepareAudit('retry', false, 1);
  endpoint.release('retry');
});

test('a failed or cancelled preparation releases its token and a delayed read never re-freezes an ended run', async context => {
  let finishRead;
  const { endpoint, locks, attributes, pruned } = endpointFixture(context, () => new Promise(resolve => { finishRead = resolve; }));
  locks.hold('slow');
  const preparing = endpoint.prepareAudit('slow', true, 1);
  while (!finishRead) await Promise.resolve();
  assert.ok(!attributes.has('data-canvas-guard-cleaning'));
  await locks.end('slow');
  finishRead({ nodeIds: ['deleted'], connectionIds: [], images: [] });
  await assert.rejects(preparing, /清理会话已结束/);
  assert.equal(pruned(), 0);
  assert.ok(!attributes.has('data-canvas-guard-cleaning'));
  locks.hold('retry');
  await endpoint.prepareAudit('retry', false, 1);
  endpoint.release('retry');
});

test('a failed deletion-record read releases its token immediately and the next valid attempt succeeds', async context => {
  const { endpoint, locks, attributes } = endpointFixture(context, async () => { throw Error('simulated interrupted IndexedDB read'); });
  locks.hold('failed');
  await assert.rejects(endpoint.prepareAudit('failed', true, 1), /interrupted IndexedDB read/);
  assert.ok(!attributes.has('data-canvas-guard-cleaning'));
  assert.throws(() => endpoint.auditRoots('failed'), /缓存核对会话已结束/);
  locks.hold('retry');
  await endpoint.prepareAudit('retry', false, 1);
  endpoint.release('retry');
});

async function coordinatorFixture() {
  const releases = [], prepared = [], activeTokens = new Set(['active']);
  const tabs = [{ id: 1, url: 'https://canvas.best/canvas/one' }, { id: 2, url: 'https://canvas.best/canvas/two' }];
  let listener;
  const endpoint = {
    deletedOnlyVersion: 1, referenceAuditVersion: 1, interactiveAuditVersion: 1, cleanupSessionVersion: 1,
    prepareAudit: async (...args) => { prepared.push(args); return emptySnapshot(); },
    commitAudit: () => emptySnapshot(),
    release: token => { releases.push(token); },
    releaseMedia: () => ({ files: 0, bytes: 0 }),
  };
  const chrome = {
    action: { onClicked: { addListener() {} } }, runtime: { onInstalled: { addListener() {} }, onMessage: { addListener(fn) { listener = fn; } } },
    tabs: { query: async () => tabs, onRemoved: { addListener() {} } },
    scripting: { executeScript: async ({ func, args }) => [{ result: await vm.runInNewContext(`(${func.toString()})(...args)`, {
      args, CanvasSaveGuard: { cleanupEndpoint: endpoint, cleanupProgress: { receive() {} } },
      navigator: { locks: { query: async () => ({ held: [...activeTokens].flatMap(token => [
        { name: CLEANUP_LOCK, mode: 'exclusive', clientId: 'owner' }, { name: leaseName(token), mode: 'exclusive', clientId: 'owner' },
      ]) }) } },
    }) }] },
  };
  const worker = vm.createContext({ chrome, console, URL });
  vm.runInContext(await readFile(new URL('../src/background.js', import.meta.url), 'utf8'), worker);
  const send = (action, data = {}, sender = { tab: tabs[0] }) => new Promise(resolve => listener({ type: 'canvas-guard-cleanup', action, data }, sender, resolve));
  return { send, releases, prepared, activeTokens, tabs, endpoint, restart: () => vm.runInContext('cleanupSessions.clear()', worker) };
}

test('a restarted coordinator still releases matching tokens in all canvas tabs when finishing', async () => {
  const fixture = await coordinatorFixture();
  const response = await fixture.send('finish', { token: 'forgotten' });
  assert.equal(response.error, undefined);
  assert.deepEqual(fixture.releases, ['forgotten', 'forgotten']);
});

test('a restarted coordinator recovers its original reference signature only while the exact owner locks are active', async () => {
  const fixture = await coordinatorFixture();
  const started = await fixture.send('prepare', { token: 'active', mode: 'deleted-audited', sessionVersion: 1 });
  assert.equal(started.error, undefined);
  assert.deepEqual(fixture.prepared.map(args => args[2]), [1, 1]);
  const coordination = structuredClone(started.result.coordination);
  fixture.restart();
  assert.match((await fixture.send('validateReferences', { token: 'active', coordination }, { tab: fixture.tabs[1] })).error, /清理会话已失效/);
  assert.equal((await fixture.send('validateReferences', { token: 'active', coordination })).error, undefined);
  fixture.restart();
  fixture.activeTokens.clear();
  assert.match((await fixture.send('validateReferences', { token: 'active', coordination })).error, /清理会话已结束/);
  await fixture.send('finish', { token: 'active', coordination });
  assert.equal(fixture.releases.length, 2);
});

test('coordinator recovery still rejects changed references, added tabs and obsolete tab interfaces before deletion', async () => {
  const fixture = await coordinatorFixture();
  let started = await fixture.send('prepare', { token: 'active', mode: 'deleted-audited', sessionVersion: 1 });
  fixture.restart();
  fixture.endpoint.commitAudit = () => ({ ...emptySnapshot(), keys: ['image:new-live-reference'] });
  assert.match((await fixture.send('validateReferences', { token: 'active', coordination: started.result.coordination })).error, /引用发生变化/);
  fixture.endpoint.commitAudit = () => emptySnapshot();
  fixture.restart();
  fixture.tabs.push({ id: 3, url: 'https://canvas.best/canvas/new' });
  assert.match((await fixture.send('validateReferences', { token: 'active', coordination: started.result.coordination })).error, /新画布/);
  await fixture.send('finish', { token: 'active' });
  fixture.endpoint.cleanupSessionVersion = 0;
  started = await fixture.send('prepare', { token: 'active', mode: 'deleted-audited', sessionVersion: 1 });
  assert.match(started.error, /清理接口仍是旧版/);
});
