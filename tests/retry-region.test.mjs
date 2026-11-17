import test from 'node:test';
import assert from 'node:assert/strict';
import { installRetryRegion, normalizeRetryRectangle, retryRegionIntersects } from '../src/retry-region.mjs';

function fixture() {
  const storage = new Map(), events = [];
  const win = { location: { pathname: '/canvas/a' }, localStorage: {
    getItem: key => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  }, addEventListener: (...args) => events.push(args) };
  const control = installRetryRegion({ defaultView: win });
  return { win, control, storage, events };
}

test('world rectangle normalization accepts reversed gestures and rejects invalid or empty regions', () => {
  assert.deepEqual(normalizeRetryRectangle({ startWorldX: 30, currentWorldX: -20, startWorldY: 90, currentWorldY: 10 }),
    { left: -20, right: 30, top: 10, bottom: 90 });
  assert.equal(normalizeRetryRectangle({ startWorldX: 0, currentWorldX: 0, startWorldY: 0, currentWorldY: 10 }), null);
  assert.equal(normalizeRetryRectangle({ startWorldX: 0, currentWorldX: NaN, startWorldY: 0, currentWorldY: 10 }), null);
  assert.equal(retryRegionIntersects({ left: 0, right: 20, top: 0, bottom: 20 }, { position: { x: 0, y: 0 } }), false);
});

test('the latest completed rectangle becomes a persistent fixed scope for the current canvas only', () => {
  const { win, control, storage } = fixture();
  const changes = [];
  control.subscribe(event => changes.push(event));
  const initial = control.snapshot().revision;
  control.begin('a');
  control.capture('a', { startWorldX: 10, currentWorldX: 150, startWorldY: 20, currentWorldY: 100 });
  assert.equal(control.snapshot().revision, initial, 'global retries continue during ordinary selection');
  assert.equal(changes.length, 0);
  control.setEnabled(true);
  assert.deepEqual(control.snapshot().rectangle, { left: 10, right: 150, top: 20, bottom: 100 });
  assert.equal(storage.size, 1);
  const copy = control.snapshot(); copy.rectangle.left = -500;
  assert.equal(control.snapshot().rectangle.left, 10);
  const saved = JSON.parse(storage.values().next().value);
  assert.equal(saved.enabled, true);
  win.location.pathname = '/canvas/b';
  assert.equal(control.snapshot().enabled, false);
  assert.equal(control.snapshot().rectangle, null);
  control.capture('a', { startWorldX: 1, currentWorldX: 9, startWorldY: 1, currentWorldY: 9 });
  assert.equal(control.snapshot().rectangle, null);
  win.location.pathname = '/canvas/a';
  assert.deepEqual(control.snapshot().rectangle, saved.rectangle);
  assert.equal(control.snapshot().enabled, true);
});

test('scope changes invalidate queues immediately, cancelled gestures retain the locked region', () => {
  const { win, control } = fixture();
  win.CanvasSaveGuardRetry = { projectId: 'a', regionVersion: 1 };
  control.setEnabled(true);
  assert.equal(control.snapshot().available, true);
  control.capture('a', { startWorldX: 0, currentWorldX: 200, startWorldY: 0, currentWorldY: 200 });
  const locked = control.snapshot();
  control.begin('a');
  const drafting = control.snapshot();
  assert.equal(drafting.drawing, true);
  assert.ok(drafting.revision > locked.revision);
  control.begin('a');
  assert.equal(control.snapshot().revision, drafting.revision);
  control.cancel('a');
  assert.equal(control.snapshot().drawing, false);
  assert.deepEqual(control.snapshot().rectangle, locked.rectangle);
  control.capture('a', { startWorldX: 700, currentWorldX: 900, startWorldY: 0, currentWorldY: 300 });
  assert.deepEqual(control.snapshot().rectangle, { left: 700, right: 900, top: 0, bottom: 300 });
  const revision = control.snapshot().revision;
  control.setEnabled(false);
  assert.ok(control.snapshot().revision > revision);
});
