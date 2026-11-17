export function normalizeRetryRectangle(rectangle) {
  if (!rectangle) return null;
  const left = Math.min(rectangle.startWorldX, rectangle.currentWorldX);
  const right = Math.max(rectangle.startWorldX, rectangle.currentWorldX);
  const top = Math.min(rectangle.startWorldY, rectangle.currentWorldY);
  const bottom = Math.max(rectangle.startWorldY, rectangle.currentWorldY);
  return [left, right, top, bottom].every(Number.isFinite) && right > left && bottom > top
    ? { left, right, top, bottom } : null;
}

export function retryRegionIntersects(region, node, position = node.position) {
  if (region == null) return true;
  const values = [region.left, region.right, region.top, region.bottom, position?.x, position?.y, node.width, node.height];
  return values.every(Number.isFinite) && region.right > region.left && region.bottom > region.top
    && node.width > 0 && node.height > 0 && position.x < region.right && position.x + node.width > region.left
    && position.y < region.bottom && position.y + node.height > region.top;
}

// The region is small UI state. Capture once on mouseup and repaint from native
// viewport changes, without reading media, history or IndexedDB during dragging.
export function installRetryRegion(doc) {
  const win = doc.defaultView;
  if (win.CanvasSaveGuardRetryRegion?.version === 1) return win.CanvasSaveGuardRetryRegion;
  const listeners = new Set();
  let projectId = null, enabled = false, rectangle = null, candidate = null, drawing = false, revision = 0;
  let overlay = null, frame = null;
  const storageKey = id => `canvas-retry-region-v1:${id}`;
  const currentId = () => /^\/canvas\/[^/]+\/?$/.test(win.location.pathname)
    ? decodeURIComponent(win.location.pathname.split('/')[2]) : '';
  function publish(scopeChanged) {
    if (scopeChanged) revision++;
    for (const listener of listeners) listener({ scopeChanged });
    paint();
  }
  function syncProject() {
    const id = currentId();
    if (id === projectId) return;
    projectId = id;
    enabled = false; rectangle = null; candidate = null; drawing = false;
    try {
      const saved = JSON.parse(win.localStorage.getItem(storageKey(id)) || '{}');
      enabled = saved.enabled === true;
      rectangle = normalizeRetryRectangle(saved.rectangle && {
        startWorldX: saved.rectangle.left, currentWorldX: saved.rectangle.right,
        startWorldY: saved.rectangle.top, currentWorldY: saved.rectangle.bottom,
      });
    } catch {}
    publish(true);
  }
  function persist() {
    if (!projectId) return;
    try { win.localStorage.setItem(storageKey(projectId), JSON.stringify({ enabled, rectangle })); } catch {}
  }
  function bridge() {
    const value = win.CanvasSaveGuardRetry;
    return value?.projectId === projectId && value.regionVersion === 1 ? value : null;
  }
  function snapshot() {
    syncProject();
    return { projectId, enabled, rectangle: rectangle && { ...rectangle }, drawing, revision, available: !!bridge() };
  }
  function paint(viewport) {
    if (!doc.body) return;
    const native = bridge();
    if (!enabled || drawing || !rectangle || !native) {
      if (overlay) overlay.hidden = true;
      return;
    }
    const canvas = native.getCanvasRect?.();
    const view = viewport || native.getViewport?.();
    if (!canvas || !view || ![canvas.left, canvas.top, canvas.width, canvas.height, view.x, view.y, view.k].every(Number.isFinite)) return;
    if (!overlay) {
      overlay = doc.createElement('div');
      overlay.id = 'canvas-retry-region-outline';
      overlay.setAttribute('aria-hidden', 'true');
      overlay.style.cssText = 'position:fixed;pointer-events:none;overflow:hidden;z-index:70;';
      frame = doc.createElement('div');
      frame.style.cssText = 'position:absolute;box-sizing:border-box;border:2px dashed #3b82f6;border-radius:3px;pointer-events:none;';
      const label = doc.createElement('span');
      label.textContent = '重试区域';
      label.style.cssText = 'position:absolute;top:2px;left:3px;padding:1px 5px;border-radius:3px;background:#2563eb;color:#fff;font:11px/1.5 system-ui;white-space:nowrap;';
      frame.append(label); overlay.append(frame); doc.body.append(overlay);
    }
    overlay.hidden = false;
    Object.assign(overlay.style, { left: `${canvas.left}px`, top: `${canvas.top}px`, width: `${canvas.width}px`, height: `${canvas.height}px` });
    Object.assign(frame.style, {
      left: `${view.x + rectangle.left * view.k}px`, top: `${view.y + rectangle.top * view.k}px`,
      width: `${(rectangle.right - rectangle.left) * view.k}px`, height: `${(rectangle.bottom - rectangle.top) * view.k}px`,
    });
  }
  const control = {
    version: 1, snapshot, paint,
    refresh() { syncProject(); publish(false); },
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    setEnabled(value) {
      syncProject();
      if (enabled === !!value) return;
      enabled = !!value;
      if (enabled && candidate) rectangle = { ...candidate };
      persist(); publish(true);
    },
    begin(id) {
      syncProject();
      if (id !== projectId || drawing) return;
      drawing = true;
      if (enabled) publish(true);
    },
    capture(id, selection) {
      syncProject();
      if (id !== projectId) return;
      const next = normalizeRetryRectangle(selection);
      const wasDrawing = drawing;
      drawing = false;
      if (next) {
        candidate = next;
        if (enabled) { rectangle = next; persist(); }
      }
      if (enabled && (wasDrawing || next)) publish(true);
    },
    cancel(id) {
      syncProject();
      if (id !== projectId || !drawing) return;
      drawing = false;
      if (enabled) publish(true);
    },
  };
  win.CanvasSaveGuardRetryRegion = control;
  win.addEventListener('resize', () => paint());
  syncProject();
  return control;
}
