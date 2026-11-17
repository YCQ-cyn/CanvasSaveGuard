import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createCanvasRetryBridge, createBatchCanvasRetryBridge } from '../src/retry-bridge.mjs';
import { retryRegionIntersects } from '../src/retry-region.mjs';
import { createRetryFlight } from '../src/retry-flight.mjs';

test('a retry lease excludes repeated preparation and stays independent across images and canvases', () => {
  const begin = createRetryFlight(() => 'current');
  const release = begin('current', 'node', 'one');
  assert.equal(begin.has('current', 'node', 'one'), true);
  assert.equal(begin('current', 'node', 'one'), false);
  const sibling = begin('current', 'node', 'two'), other = begin('other', 'node', 'one');
  assert.equal(typeof sibling, 'function');
  assert.equal(typeof other, 'function');
  release();
  assert.equal(begin.has('current', 'node', 'one'), false);
  const next = begin(undefined, 'node', 'one');
  assert.equal(typeof next, 'function');
  release();
  assert.equal(begin('current', 'node', 'one'), false, 'an old release cannot unlock a newer attempt');
  next(); sibling(); other();
  assert.equal(typeof begin('current', 'node', 'one'), 'function');
});

test('pending preparation is excluded from the failure list until that exact attempt ends', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'CanvasSaveGuard');
  const begin = createRetryFlight(() => 'canvas');
  Object.defineProperty(globalThis, 'CanvasSaveGuard', { configurable: true, value: { isRetryPending: (nodeId,imageId) => begin.has('canvas',nodeId,imageId) } });
  try {
    const nodes = [failed('single'), failed('batch', { status:'success', images:[{id:'one',status:'error'},{id:'two',status:'error'}] })];
    const legacy = createCanvasRetryBridge('canvas',()=>nodes,()=>{});
    const modern = createBatchCanvasRetryBridge('canvas',()=>nodes,()=>{},()=>new Set(['batch']));
    const single = begin('canvas','single'), first = begin('canvas','batch','one');
    assert.deepEqual(legacy.list(),[]);
    assert.deepEqual(modern.list().map(JSON.parse),[['batch','two']]);
    assert.equal(modern.retry(JSON.stringify(['batch','one'])),false);
    single(); first();
    assert.deepEqual(legacy.list(),['single']);
    assert.deepEqual(modern.list().map(JSON.parse),[['single',null],['batch','one'],['batch','two']]);
  } finally {
    if(previous)Object.defineProperty(globalThis,'CanvasSaveGuard',previous);
    else delete globalThis.CanvasSaveGuard;
  }
});

const failed = (id, metadata = {}) => ({
  id, type: 'image', position: { x: 100000, y: -100000 },
  metadata: { status: 'error', ...metadata }
});

test('lists failures outside the viewport and skips collapsed batches', () => {
  const nodes = [
    failed('outside'),
    failed('collapsed', { isBatchRoot: true, batchChildIds: ['child-a', 'child-b'] }),
    failed('child-a', { batchRootId: 'collapsed' }),
    failed('child-b', { batchRootId: 'collapsed' }),
    failed('expanded', { isBatchRoot: true, batchChildIds: ['expanded-a', 'expanded-b'], imageBatchExpanded: true }),
    failed('expanded-a', { batchRootId: 'expanded' }),
    failed('expanded-b', { batchRootId: 'expanded' }),
    failed('loading', { status: 'loading' }),
    failed('success', { status: 'success' })
  ];
  const calls = [];
  const bridge = createCanvasRetryBridge('canvas', () => nodes, node => calls.push(node));
  assert.deepEqual(bridge.list(), ['outside', 'expanded', 'expanded-a', 'expanded-b']);
  assert.equal(bridge.retry('outside'), true);
  assert.equal(calls[0], nodes[0]);
  assert.equal(bridge.retry('collapsed'), false);
  assert.equal(bridge.retry('child-a'), false);
  assert.equal(bridge.retry('loading'), false);
  assert.equal(bridge.retry('missing'), false);
  assert.equal(calls.length, 1);
});

test('checks live data for nodes that were deleted, completed, or collapsed after enumeration', () => {
  let nodes = [failed('a'), failed('b'), failed('root', {
    isBatchRoot: true, imageBatchExpanded: true, batchChildIds: ['c', 'd']
  }), failed('c', { batchRootId: 'root' })];
  const calls = [];
  const bridge = createCanvasRetryBridge('canvas', () => nodes, node => calls.push(node.id));
  assert.deepEqual(bridge.list(), ['a', 'b', 'root', 'c']);
  nodes = nodes.filter(node => node.id !== 'a');
  nodes[0].metadata.status = 'success';
  nodes[1].metadata.imageBatchExpanded = false;
  for (const id of ['a', 'b', 'root', 'c']) assert.equal(bridge.retry(id), false);
  nodes.push(failed('later'));
  assert.deepEqual(bridge.list(), ['later']);
  assert.equal(bridge.retry('later'), true);
  assert.deepEqual(calls, ['later']);
});

test('submits through the original handler without waiting for generation', async () => {
  let finish;
  const request = new Promise(resolve => { finish = resolve; });
  const calls = [];
  const bridge = createCanvasRetryBridge('canvas', () => [failed('a'), failed('b')], node => {
    calls.push(node.id);
    return request;
  });
  assert.equal(bridge.retry('a'), true);
  assert.equal(bridge.retry('b'), true);
  assert.deepEqual(calls, ['a', 'b']);
  finish();
  await request;
});

test('retry waits while cleanup freezes editing and resumes through the same handler afterward', () => {
  const previousDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  let cleaning = true;
  const calls = [];
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { documentElement: { hasAttribute: () => cleaning } } });
  try {
    const bridge = createCanvasRetryBridge('canvas', () => [failed('a')], node => calls.push(node.id));
    assert.equal(bridge.retry('a'), false);
    assert.deepEqual(calls, []);
    cleaning = false;
    assert.equal(bridge.retry('a'), true);
    assert.deepEqual(calls, ['a']);
  } finally {
    if (previousDocument) Object.defineProperty(globalThis, 'document', previousDocument);
    else delete globalThis.document;
  }
});

test('the built website effect installs and removes the offscreen adapter', async () => {
  const source = await readFile(new URL('../extension/patches/canvas-client-v040.js', import.meta.url), 'utf8');
  const anchor = source.indexOf('globalThis.CanvasSaveGuardRetry = adapter;');
  assert.ok(anchor > 0);
  const start = source.lastIndexOf('(0,l.useEffect)(() => {', anchor);
  const endToken = '}, [i, is, eU]);';
  const end = source.indexOf(endToken, anchor) + endToken.length;
  const nodes = [failed('offscreen')];
  const calls = [];
  let dispose;
  const context = {
    l: { useEffect: callback => { dispose = callback(); } },
    i: 'canvas', eU: true, tB: { current: nodes }, is: node => calls.push(node.id), retryRegionIntersects
  };
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.CanvasSaveGuardRetry.projectId, 'canvas');
  assert.deepEqual(Array.from(context.CanvasSaveGuardRetry.list()), ['offscreen']);
  assert.equal(context.CanvasSaveGuardRetry.retry('offscreen'), true);
  assert.deepEqual(calls, ['offscreen']);
  dispose();
  assert.equal(context.CanvasSaveGuardRetry, undefined);
  context.eU = false;
  vm.runInNewContext(source.slice(start, end), context);
  assert.equal(context.CanvasSaveGuardRetry, undefined);
});


test('v0.20 retries each failed expanded batch item and offscreen node without waiting for other generation', () => {
  const image = id => ({ id, status: 'error' });
  const nodes = [failed('offscreen'), failed('collapsed', { images: [image('c1'), image('c2')] }),
    failed('expanded', { status: 'success', images: [image('e1'), image('e2'), { id: 'e3', status: 'loading' }] }),
    failed('ongoing', { status: 'loading' })];
  const expanded = new Set(['expanded']);
  const calls = [];
  const bridge = createBatchCanvasRetryBridge('project', () => nodes, (node, id) => {
    calls.push([node.id, id]);
    if (id) node.metadata.images.find(image => image.id === id).status = 'loading';
    node.metadata.status = 'loading';
    return new Promise(() => {});
  }, () => expanded);
  assert.deepEqual(bridge.list().map(JSON.parse), [['offscreen', null], ['expanded', 'e1'], ['expanded', 'e2']]);
  for (const id of bridge.list()) assert.equal(bridge.retry(id), true);
  assert.deepEqual(calls, [['offscreen', undefined], ['expanded', 'e1'], ['expanded', 'e2']]);
  assert.deepEqual(bridge.list(), []);
  nodes[2].metadata.images[0].status = 'error';
  expanded.clear();
  assert.equal(bridge.retry(JSON.stringify(['expanded', 'e1'])), false);
});


test('v0.20 adapter preserves collapsed legacy batches imported from an old canvas ZIP', () => {
  const nodes = [failed('root', { isBatchRoot: true, batchChildIds: ['one', 'two'] }), failed('one', { batchRootId: 'root' }), failed('two', { batchRootId: 'root' })];
  const bridge = createBatchCanvasRetryBridge('project', () => nodes, () => {}, () => new Set());
  assert.deepEqual(bridge.list(), []);
  nodes[0].metadata.imageBatchExpanded = true;
  assert.deepEqual(bridge.list().map(JSON.parse), [['root', null], ['one', null], ['two', null]]);
});

test('region retry rechecks live bounds and includes later failures without changing the global list', () => {
  const box = { left: 100, right: 400, top: 100, bottom: 400 };
  const make = (id, x, y) => ({ ...failed(id), position: { x, y }, width: 80, height: 60 });
  for (const factory of [createCanvasRetryBridge, createBatchCanvasRetryBridge]) {
    let nodes = [make('inside', 150, 150), make('partial', 70, 370), make('outside', 500, 200), make('touching', 400, 200)];
    const calls = [];
    const bridge = factory('p', () => nodes, node => calls.push(node.id), () => new Set());
    const read = region => bridge.list(region).map(id => id.startsWith('[') ? JSON.parse(id)[0] : id);
    assert.deepEqual(read(), ['inside', 'partial', 'outside', 'touching']);
    assert.deepEqual(read(box), ['inside', 'partial']);
    const id = bridge.list(box)[0];
    nodes = nodes.map(node => node.id === 'inside' ? { ...node, position: { x: 900, y: 900 } } : node);
    assert.equal(bridge.retry(id, box), false);
    nodes.push(make('new-failure', 180, 180));
    assert.deepEqual(read(box), ['partial', 'new-failure']);
    assert.equal(bridge.retry(bridge.list(box)[1], box), true);
    assert.deepEqual(calls, ['new-failure']);
    assert.deepEqual(read({ left: NaN, top: 0, right: 10, bottom: 10 }), []);
  }
});

test('region retry selects each expanded inline image by its own world bounds and skips collapsed ancestors', () => {
  const node = { ...failed('batch'), position: { x: 100, y: 100 }, width: 80, height: 60,
    metadata: { status: 'error', primaryImageId: 'a', imageBatchExpanded: true,
      images: ['a', 'b', 'c'].map(id => ({ id, status: 'error' })),
      batchImagePositions: { a: { x: 300, y: 0 }, b: { x: 500, y: 0 }, c: { x: 300, y: 150 } } } };
  const child = { ...failed('native-child'), position: { x: 600, y: 300 }, width: 80, height: 60,
    metadata: { status: 'error', batchRootId: 'batch', guardBatchImageId: 'c' } };
  node.metadata.guardBatchChildren = { c: child.id };
  const nodes = [node, child], expanded = new Set(['batch']), calls = [];
  const bridge = createBatchCanvasRetryBridge('p', () => nodes, (n, imageId) => calls.push([n.id, imageId]), () => expanded);
  const region = { left: 590, right: 700, top: 80, bottom: 380 };
  assert.deepEqual(bridge.list(region).map(JSON.parse), [['batch', 'b'], ['native-child', null]]);
  assert.deepEqual(bridge.list({ left: 90, right: 190, top: 90, bottom: 170 }).map(JSON.parse), [['batch', 'a']]);
  assert.deepEqual(bridge.list({ left: 390, right: 490, top: 90, bottom: 170 }).map(JSON.parse), [['batch', 'a']]);
  for (const id of bridge.list(region)) assert.equal(bridge.retry(id, region), true);
  assert.deepEqual(calls, [['batch', 'b'], ['native-child', undefined]]);
  expanded.clear(); node.metadata.imageBatchExpanded = false;
  assert.deepEqual(bridge.list(region), []);
});
