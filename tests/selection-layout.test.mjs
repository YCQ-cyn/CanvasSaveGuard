import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { alignedSelectionPositions, compactSelectionPositions, snapGridPoint, snapGridOffset, selectionToolbarPosition } from '../src/selection-layout.mjs';
import { arrangeSelectedNodes, selectedLayoutUnits, selectionLayoutState } from '../src/batch-layout.mjs';
import { materializeBatchImage, synchronizeBatchGraph } from '../src/batch-graph.mjs';
import { collectMedia } from '../src/core.mjs';

const node = (id, x, y, metadata = {}) => ({ id, type: 'image', title: id, position: { x, y }, width: 160, height: 120,
  metadata: { storageKey: `image:${id}`, prompt: `keep ${id}`, status: 'success', ...metadata } });

const sizedNode = (id, x, y, width, height) => ({ ...node(id, x, y), width, height });
const centerX = (node, positions) => positions.get(node.id).x + node.width / 2;
const centerY = (node, positions) => positions.get(node.id).y + node.height / 2;

function verifyStableLayout(nodes, positions) {
  const moved = nodes.map(node => ({ ...node, position: positions.get(node.id) }));
  assert.deepEqual(compactSelectionPositions(moved, { x: -90000, y: -90000 }), positions);
}

test('repeated layout keeps sparse mixed sizes stable when the nearest row radius changes after spacing', () => {
  const nodes = [sizedNode('3-2', 747.693, 1052.661, 206, 252), sizedNode('5-0', 163.438, 1846.067, 108, 130),
    sizedNode('5-3', 1048.922, 1736.101, 269, 252)];
  const original = JSON.stringify(nodes);
  verifyStableLayout(nodes, compactSelectionPositions(nodes, { x: 800, y: 600 }));
  assert.equal(JSON.stringify(nodes), original);
});

test('repeated layout retains an existing valid axis when another axis becomes easier to recognize', () => {
  const nodes = [sizedNode('1-2', 542.497, 267.379, 170, 96), sizedNode('5-4', 1088.102, 1096.929, 81, 134),
    sizedNode('5-7', 1787.389, 1123.992, 197, 87)];
  verifyStableLayout(nodes, compactSelectionPositions(nodes, { x: 800, y: 600 }));
});

test('a sparse result remains stable when the original loose-alignment confidence changes after layout', () => {
  const nodes = [sizedNode('3-0', 598, 693, 145, 120), sizedNode('4-1', 6357, 4051, 95, 144),
    sizedNode('4-2', 4140, -3266, 117, 140), sizedNode('5-0', 474, 3112, 177, 89), sizedNode('5-1', 4091, -9274, 133, 217)];
  verifyStableLayout(nodes, compactSelectionPositions(nodes, { x: 800, y: 600 }));
});

test('a near-aligned ten-ten-two strip retains its rows and the two lower middle columns', () => {
  const nodes = [];
  for (let row = 0; row < 2; row++) for (let column = 0; column < 10; column++) {
    nodes.push(sizedNode(`${row}-${column}`, 100 + column * 168 + (row ? 2 : 0), 200 + row * 100 + column % 3 - 1, 160, 90));
  }
  nodes.push(sizedNode('2-5', 942, 401, 160, 90), sizedNode('2-6', 1110, 399, 160, 90));
  const original = JSON.stringify(nodes);
  const positions = compactSelectionPositions(nodes, { x: -90000, y: -90000 });
  assert.equal(new Set([...positions.values()].map(position => position.y)).size, 3);
  for (let column = 0; column < 10; column++) {
    assert.equal(positions.get(`0-${column}`).x, positions.get(`1-${column}`).x);
    if (column) assert.equal(positions.get(`0-${column}`).x - positions.get(`0-${column - 1}`).x - 160, 24);
  }
  assert.equal(positions.get('2-5').x, positions.get('0-5').x);
  assert.equal(positions.get('2-6').x, positions.get('0-6').x);
  assert.equal(positions.get('1-0').y - positions.get('0-0').y - 90, 24);
  assert.equal(positions.get('2-5').y - positions.get('1-0').y - 90, 24);
  assert.ok(Math.abs(positions.get('0-0').x - 100) < 100);
  assert.equal(JSON.stringify(nodes), original);
  verifyStableLayout(nodes, positions);
});

test('mixed image sizes use shared row and column center lines with largest track sizes and a fixed largest-image reference', () => {
  const nodes = [sizedNode('a', 100, 100, 120, 220), sizedNode('b', 240, 105, 260, 80), sizedNode('c', 518, 97, 180, 140),
    sizedNode('d', 102, 350, 210, 90), sizedNode('e', 330, 353, 100, 260), sizedNode('f', 450, 349, 330, 110)];
  const before = JSON.stringify(nodes);
  const positions = compactSelectionPositions(nodes, { x: -90000, y: -90000 });
  for (const row of [nodes.slice(0, 3), nodes.slice(3)]) {
    assert.equal(new Set(row.map(node => centerY(node, positions))).size, 1);
  }
  for (let index = 0; index < 3; index++) assert.equal(centerX(nodes[index], positions), centerX(nodes[index + 3], positions));
  assert.equal(centerY(nodes[3], positions) - centerY(nodes[0], positions), (220 + 260) / 2 + 24);
  assert.equal(centerX(nodes[1], positions) - centerX(nodes[0], positions), (210 + 260) / 2 + 24);
  assert.equal(centerX(nodes[2], positions) - centerX(nodes[1], positions), (260 + 330) / 2 + 24);
  assert.deepEqual(positions.get('f'), nodes[5].position);
  assert.equal(JSON.stringify(nodes), before);
  verifyStableLayout(nodes, positions);
});

test('an existing column layout aligns both center lines using maximum widths and heights', () => {
  const columns = [
    [sizedNode('a1', 100, 100, 120, 90), sizedNode('a2', 102, 220, 150, 160), sizedNode('a3', 99, 410, 110, 110)],
    [sizedNode('b1', 300, 104, 190, 150), sizedNode('b2', 301, 280, 80, 90), sizedNode('b3', 298, 405, 140, 200)],
    [sizedNode('c1', 530, 103, 100, 120), sizedNode('c2', 531, 300, 210, 80), sizedNode('c3', 529, 430, 130, 130)],
  ];
  const nodes = columns.flat(), original = JSON.stringify(nodes);
  const positions = compactSelectionPositions(nodes, { x: 0, y: 0 });
  for (const column of columns) {
    assert.equal(new Set(column.map(node => centerX(node, positions))).size, 1);
  }
  for (let row = 0; row < 3; row++) assert.equal(new Set(columns.map(column => centerY(column[row], positions))).size, 1);
  assert.equal(centerX(columns[1][0], positions) - centerX(columns[0][0], positions), (150 + 190) / 2 + 24);
  assert.equal(centerX(columns[2][0], positions) - centerX(columns[1][0], positions), (190 + 210) / 2 + 24);
  assert.equal(centerY(columns[0][1], positions) - centerY(columns[0][0], positions), (150 + 160) / 2 + 24);
  assert.deepEqual(positions.get('b1'), columns[1][0].position);
  assert.equal(JSON.stringify(nodes), original);
  verifyStableLayout(nodes, positions);
});

test('a sparse third row preserves its fourth and sixth columns including the interior empty fifth column', () => {
  const nodes = [];
  for (let row = 0; row < 2; row++) for (let column = 0; column < 6; column++) nodes.push(sizedNode(`${row}-${column}`, 100 + column * 168, 100 + row * 100, 160, 90));
  nodes.push(sizedNode('lower-fourth', 606, 301, 160, 90), sizedNode('lower-sixth', 944, 303, 160, 90));
  const positions = compactSelectionPositions(nodes, { x: 0, y: 0 });
  assert.equal(positions.get('lower-fourth').x, positions.get('0-3').x);
  assert.equal(positions.get('lower-sixth').x, positions.get('0-5').x);
  assert.equal(positions.get('lower-sixth').x - positions.get('lower-fourth').x, 2 * (160 + 24));
  assert.ok(positions.get('lower-sixth').x > nodes.at(-1).position.x);
  verifyStableLayout(nodes, positions);
});

test('increased alignment tolerance accepts a sixty-percent row offset while preserving distinct neighboring rows', () => {
  const nodes = [sizedNode('a', 100, 100, 160, 100), sizedNode('b', 300, 160, 160, 100),
    sizedNode('c', 100, 340, 160, 100), sizedNode('d', 300, 400, 160, 100)];
  const positions = compactSelectionPositions(nodes, { x: -90000, y: -90000 });
  assert.equal(centerY(nodes[0], positions), centerY(nodes[1], positions));
  assert.equal(centerY(nodes[2], positions), centerY(nodes[3], positions));
  assert.equal(centerY(nodes[2], positions) - centerY(nodes[0], positions), 124);
  assert.equal(centerX(nodes[0], positions), centerX(nodes[2], positions));
  verifyStableLayout(nodes, positions);
});

test('an occupied column beyond the longest row retains its relative track and finite coordinates', () => {
  const nodes = [sizedNode('a', 100, 100, 160, 90), sizedNode('b', 300, 100, 160, 90),
    sizedNode('c', 500, 100, 160, 90), sizedNode('outside', 900, 300, 160, 90)];
  const positions = compactSelectionPositions(nodes, { x: 0, y: 0 });
  assert.equal(positions.get('outside').x - positions.get('c').x, 2 * (160 + 24));
  for (const position of positions.values()) assert.ok(Number.isFinite(position.x) && Number.isFinite(position.y));
  verifyStableLayout(nodes, positions);
});

test('scattered mixed-size rectangles also center within their largest row and column slots', () => {
  const nodes = [sizedNode('a', -80000, -90000, 120, 240), sizedNode('b', 90000, -80000, 300, 80),
    sizedNode('c', -90000, 80000, 180, 100), sizedNode('d', 80000, 90000, 140, 220)];
  const positions = compactSelectionPositions(nodes, { x: 1000, y: 2000 });
  assert.equal(centerX(nodes[0], positions), centerX(nodes[2], positions));
  assert.equal(centerX(nodes[1], positions), centerX(nodes[3], positions));
  assert.equal(centerY(nodes[0], positions), centerY(nodes[1], positions));
  assert.equal(centerY(nodes[2], positions), centerY(nodes[3], positions));
  assert.equal(centerX(nodes[1], positions) - centerX(nodes[0], positions), (180 + 300) / 2 + 24);
  verifyStableLayout(nodes, positions);
});

test('a centered short row preserves its centering even when it starts between the upper row columns', () => {
  const upper = Array.from({ length: 5 }, (_, column) => sizedNode(`top-${column}`, 100 + column * 168, 100, 160, 90));
  const nodes = [...upper, sizedNode('lower-a', 352, 205, 160, 90), sizedNode('lower-b', 520, 207, 160, 90)];
  const positions = compactSelectionPositions(nodes, { x: 0, y: 0 });
  assert.equal((positions.get('lower-a').x + positions.get('lower-b').x + 160) / 2,
    (positions.get('top-0').x + positions.get('top-4').x + 160) / 2);
  assert.equal(positions.get('lower-b').x - positions.get('lower-a').x - 160, 24);
  verifyStableLayout(nodes, positions);
});

test('a partial row with a single centered item retains its open shape while scattered items use compact placement', () => {
  const nodes = [sizedNode('left', 100, 100, 160, 90), sizedNode('right', 280, 102, 160, 90), sizedNode('middle', 190, 210, 160, 90)];
  const positions = compactSelectionPositions(nodes, { x: -90000, y: -90000 });
  assert.equal(positions.get('middle').x + 80, (positions.get('left').x + positions.get('right').x + 160) / 2);
  assert.ok(positions.get('middle').y > positions.get('left').y);
  assert.equal(alignedSelectionPositions([node('one', 1000, 2000), node('two', -9000, -8000)]), null);
  verifyStableLayout(nodes, positions);
});

test('compact layout collects arbitrarily distant selections with half-grid gaps and preserves dimensions and ordering', () => {
  const nodes = [node('a', -80000, -90000), node('b', 90000, -80000), node('c', -90000, 80000), node('d', 80000, 90000)];
  const original = JSON.stringify(nodes);
  const positions = compactSelectionPositions(nodes, { x: 1000, y: 2000 });
  assert.equal(positions.get('b').x - positions.get('a').x - 160, 24);
  assert.equal(positions.get('c').y - positions.get('a').y - 120, 24);
  assert.equal(positions.get('c').x, positions.get('a').x);
  assert.equal(positions.get('d').y, positions.get('c').y);
  assert.equal((positions.get('a').x + positions.get('b').x + 160) / 2, 1000);
  assert.equal(JSON.stringify(nodes), original);
  assert.equal(compactSelectionPositions([], { x: 0, y: 0 }).size, 0);
});

test('layout moves only selected units and their actual group members while preserving every media, reference and graph identity', () => {
  const root = node('root', 10000, 10000, { isBatchRoot: true, batchChildIds: ['legacy'], imageBatchExpanded: false });
  const legacy = node('legacy', 10500, 11000, { batchRootId: 'root' });
  const nativeGroup = { ...node('group', -20000, -20000), type: 'group' };
  const grouped = node('grouped', -19900, -19900, { groupId: 'group' });
  const unselected = node('offscreen-failed', 90000, 90000, { status: 'error', references: ['image:reference'] });
  const before = [root, legacy, nativeGroup, grouped, node('selected', 70000, 0), unselected];
  const selected = new Set(['root', 'legacy', 'group', 'grouped', 'selected']);
  assert.deepEqual(selectedLayoutUnits(before, selected).roots.map(node => node.id), ['root', 'group', 'selected']);
  const after = arrangeSelectedNodes(before, selected, { x: 0, y: 0 });
  assert.equal(after.find(node => node.id === unselected.id), unselected);
  for (const [first, second] of [['root', 'legacy'], ['group', 'grouped']]) {
    const a = before.find(node => node.id === first), b = before.find(node => node.id === second);
    const movedA = after.find(node => node.id === first), movedB = after.find(node => node.id === second);
    assert.deepEqual({ x: movedB.position.x - movedA.position.x, y: movedB.position.y - movedA.position.y }, { x: b.position.x - a.position.x, y: b.position.y - a.position.y });
  }
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].metadata, before[i].metadata);
    assert.equal(after[i].id, before[i].id);
  }
  assert.deepEqual([...collectMedia(after).keys()], [...collectMedia(before).keys()]);
  const single = arrangeSelectedNodes(before, new Set(['selected']), { x: 0, y: 0 });
  assert.deepEqual(single.find(node => node.id === 'selected').position, { x: -80, y: -60 });
  assert.equal(single.find(node => node.id === 'offscreen-failed'), unselected);
});

test('a materialized result follows an arranged representative exactly once and keeps native linking metadata', () => {
  const root = node('root', 10000, 10000, { images: [{ id: 'a', storageKey: 'image:a', status: 'success' }, { id: 'b', storageKey: 'image:b', status: 'error' }], primaryImageId: 'a' });
  const before = materializeBatchImage([root, node('other', -10000, -10000)], 'root', 'b', { x: 10400, y: 10400 }).nodes;
  const after = synchronizeBatchGraph(before, arrangeSelectedNodes(before, new Set(['root', 'b', 'other']), { x: 500, y: 500 }));
  assert.deepEqual(after.find(node => node.id === 'root').metadata.batchImagePositions.b, { x: 400, y: 400 });
  assert.equal(after.find(node => node.id === 'b').metadata.storageKey, 'image:b');
  assert.equal(after.find(node => node.id === 'b').metadata.batchRootId, 'root');
  assert.deepEqual(after.find(node => node.id === 'root').metadata.images, before[0].metadata.images);
});

test('half-grid snapping uses the 24-unit arrangement step and preserves multi-selection offsets', () => {
  assert.deepEqual(snapGridPoint({ x: 55, y: -103 }), { x: 48, y: -96 });
  assert.deepEqual(snapGridPoint({ x: 33, y: -63 }), { x: 24, y: -72 });
  assert.deepEqual(snapGridPoint({ x: 33, y: -63 }, 48), { x: 48, y: -48 });
  const first = { x: 101, y: -101 }, second = { x: 257, y: 503 };
  const offset = snapGridOffset(first, { x: 27, y: 31 });
  assert.deepEqual({ x: first.x + offset.x, y: first.y + offset.y }, { x: 120, y: -72 });
  assert.deepEqual({ x: second.x + offset.x - (first.x + offset.x), y: second.y + offset.y - (first.y + offset.y) }, { x: second.x - first.x, y: second.y - first.y });
});

test('arrangement requires every selected modern and migrated image group to be collapsed', () => {
  const modern = node('modern', 0, 0, { images: [{ id: 'a' }, { id: 'b' }] });
  const migrated = node('migrated', 10000, 10000, { isBatchRoot: true, batchChildIds: ['child'] });
  const standalone = node('standalone', 50000, 50000);
  const selected = new Set(['modern', 'migrated', 'standalone']);
  assert.deepEqual(selectionLayoutState([modern, migrated, standalone], selected), { groupCount: 2, allCollapsed: false, rootCount: 3 });
  const folded = { ...modern, metadata: { ...modern.metadata, imageBatchExpanded: false } };
  assert.deepEqual(selectionLayoutState([folded, migrated, standalone], selected), { groupCount: 2, allCollapsed: true, rootCount: 3 });
  const expanded = { ...migrated, metadata: { ...migrated.metadata, imageBatchExpanded: true } };
  assert.equal(selectionLayoutState([folded, expanded, standalone], selected).allCollapsed, false);
  assert.deepEqual(selectionLayoutState([modern, migrated, standalone], new Set(['standalone'])), { groupCount: 0, allCollapsed: true, rootCount: 1 });
});

test('large selection layout is one bounded calculation and leaves unselected data references intact', () => {
  const nodes = Array.from({ length: 1500 }, (_, index) => node(`n${index}`, index * 10000, -index * 10000));
  const selected = new Set(nodes.slice(0, 1000).map(node => node.id));
  const started = performance.now();
  const after = arrangeSelectedNodes(nodes, selected, { x: 0, y: 0 });
  assert.ok(performance.now() - started < 500, 'single layout should not perform storage work or repeated scans');
  for (let index = 1000; index < nodes.length; index++) assert.equal(after[index], nodes[index]);
  assert.equal(after.length, nodes.length);
  const aligned = Array.from({ length: 1000 }, (_, index) => node(`grid${index}`, index % 50 * 200, Math.floor(index / 50) * 150));
  const alignedStart = performance.now();
  const positions = compactSelectionPositions(aligned, { x: 0, y: 0 });
  assert.equal(positions.size, 1000);
  assert.ok(performance.now() - alignedStart < 500);
});

test('contextual buttons stay near the selected frame and avoid its native toolbar and fixed protection panels', () => {
  const canvas = { left: 280, top: 0, right: 1780, bottom: 1200 };
  const selection = { left: 600, top: 300, right: 1000, bottom: 700 };
  const size = { width: 350, height: 46 };
  const above = selectionToolbarPosition(selection, canvas, size);
  assert.equal(above.top + size.height, selection.top - 12);
  const below = selectionToolbarPosition(selection, canvas, size, [{ left: 600, top: 230, right: 1000, bottom: 299 }]);
  assert.equal(below.top, selection.bottom + 12);
  const smallCanvas = { left: 280, top: 0, right: 760, bottom: 900 };
  const placed = selectionToolbarPosition({ left: 500, top: 700, right: 700, bottom: 850 }, smallCanvas, size,
    [{ left: 434, top: 550, right: 744, bottom: 884 }]);
  assert.ok(placed.left >= 292 && placed.left + size.width <= 748);
  assert.ok(placed.top >= 72 && placed.top + size.height <= 820);
  assert.ok(placed.top + size.height <= 550);
  assert.deepEqual(selectionToolbarPosition(null, smallCanvas, { width: 120, height: 46 }), { left: 292, top: 72 });
});
