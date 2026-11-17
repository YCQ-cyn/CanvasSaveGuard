import test from 'node:test';
import assert from 'node:assert/strict';
import { selectedEmptyImageIds, batchReferenceTargetIds, appendBatchReferenceConnections } from '../src/batch-reference.mjs';

const emptyImage = (id, metadata = {}) => ({ id, type: 'image', position: { x: 20, y: 30 }, width: 340, height: 240,
  metadata: { content: '', status: 'idle', ...metadata } });
const reference = { ...emptyImage('reference'), metadata: { content: 'blob:reference', storageKey: 'image:reference', status: 'success' } };

test('batch reference wiring targets only explicitly selected empty native images and preserves all node data', () => {
  const nodes = [reference, emptyImage('a', { prompt: '保留提示词', references: ['image:other'] }), emptyImage('b'),
    { ...emptyImage('offscreen'), position: { x: 90000, y: -90000 } }, emptyImage('unselected'),
    emptyImage('loading', { status: 'loading' }), emptyImage('failed', { status: 'error' }),
    emptyImage('ready', { content: 'blob:ready' }), emptyImage('keyed', { storageKey: 'image:ready' }),
    emptyImage('results', { images: [{ id: 'result', status: 'error' }] }), emptyImage('legacy', { isBatchRoot: true }),
    emptyImage('group', { batchDisplayRoot: true }), emptyImage('child', { batchRootId: 'group' }),
    emptyImage('mapped-child', { guardBatchImageId: 'result' }), { ...emptyImage('text'), type: 'text' }];
  const selection = nodes.filter(node => node.id !== 'unselected').map(node => node.id);
  const original = structuredClone(nodes);
  const targets = batchReferenceTargetIds(nodes, selection, { fromNodeId: 'reference', toNodeId: 'b' });
  assert.deepEqual(targets, ['a', 'b', 'offscreen']);
  assert.deepEqual(batchReferenceTargetIds(nodes, new Set(selection), { fromNodeId: 'reference', toNodeId: 'b' }), targets);
  assert.deepEqual(selectedEmptyImageIds(nodes, new Set(selection)), targets);
  assert.deepEqual(nodes, original);
});

test('ordinary wiring falls through for a single empty target, other destinations, missing scopes or nonimage sources', () => {
  const nodes = [reference, emptyImage('a'), emptyImage('b'), emptyImage('other'), { ...emptyImage('text'), type: 'text', metadata: { content: 'text' } }];
  for (const [scope, connection] of [
    [undefined, { fromNodeId: 'reference', toNodeId: 'a' }],
    [['a'], { fromNodeId: 'reference', toNodeId: 'a' }],
    [['a', 'b'], { fromNodeId: 'reference', toNodeId: 'other' }],
    [['a', 'b'], { fromNodeId: 'text', toNodeId: 'a' }],
    [['a', 'b'], { fromNodeId: 'a', toNodeId: 'b' }],
    [['a', 'b'], { fromNodeId: 'missing', toNodeId: 'a' }],
  ]) assert.deepEqual(batchReferenceTargetIds(nodes, scope, connection), []);
});

test('connection completion rechecks the original selection against deleted or newly generated nodes', () => {
  const scope = ['a', 'b', 'c', 'deleted'];
  const nodes = [reference, emptyImage('a'), emptyImage('b', { status: 'loading' }), emptyImage('c')];
  assert.deepEqual(batchReferenceTargetIds(nodes, scope, { fromNodeId: 'reference', toNodeId: 'a' }), ['a', 'c']);
  assert.deepEqual(batchReferenceTargetIds(nodes, scope, { fromNodeId: 'reference', toNodeId: 'b' }), []);
  nodes[0] = emptyImage('reference');
  assert.deepEqual(batchReferenceTargetIds(nodes, scope, { fromNodeId: 'reference', toNodeId: 'a' }), []);
});

test('batch wiring adds unique native connections, retains prior inputs and is safe to repeat against fresh connection state', () => {
  const existing = [
    { id: 'old-reference', fromNodeId: 'reference', toNodeId: 'a', custom: 'keep' },
    { id: 'other-input', fromNodeId: 'other', toNodeId: 'b' },
  ];
  const original = structuredClone(existing);
  const connected = appendBatchReferenceConnections(existing, 'reference', ['a', 'b', 'b', 'c', 'reference']);
  assert.equal(connected.length, 4);
  assert.equal(connected[0], existing[0]);
  assert.equal(connected[1], existing[1]);
  assert.deepEqual(connected.slice(2).map(link => [link.fromNodeId, link.toNodeId]), [['reference', 'b'], ['reference', 'c']]);
  assert.equal(new Set(connected.map(link => link.id)).size, 4);
  assert.equal(appendBatchReferenceConnections(connected, 'reference', ['a', 'b', 'c']), connected);
  assert.deepEqual(existing, original);
  const concurrentlyAdded = [...existing, { id: 'latest', fromNodeId: 'reference', toNodeId: 'c' }];
  assert.deepEqual(appendBatchReferenceConnections(concurrentlyAdded, 'reference', ['a', 'b', 'c']).slice(0, 3), concurrentlyAdded);
});

test('a large selected batch shares its single reference and preserves every target instead of creating media or nodes', () => {
  const nodes = [reference, ...Array.from({ length: 2000 }, (_, index) => emptyImage(`target-${index}`, { prompt: `prompt-${index}` }))];
  const before = structuredClone(nodes);
  const targets = batchReferenceTargetIds(nodes, nodes.map(node => node.id), { fromNodeId: 'reference', toNodeId: 'target-1999' });
  const connected = appendBatchReferenceConnections([], 'reference', targets);
  assert.equal(connected.length, 2000);
  assert.equal(new Set(connected.map(link => link.id)).size, 2000);
  assert.equal(new Set(connected.map(link => link.toNodeId)).size, 2000);
  assert.equal(appendBatchReferenceConnections(connected, 'reference', targets), connected);
  assert.deepEqual(nodes, before);
});
