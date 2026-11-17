export function retainedCanvasHistory(entries, limit = 50, now = Date.now()) {
  const firstRetained = entries.findIndex(entry => entry?.[Symbol.for('canvas-save-guard:undo-until')] > now);
  const normalStart = Math.max(0, entries.length - limit);
  const start = firstRetained < 0 ? normalStart : Math.min(normalStart, firstRetained);
  return entries.slice(start);
}

export function commitCanvasHistory(history, previous, current) {
  if (!previous) return { history, current, changed: false };
  const fields = Object.keys(current);
  const same = fields.length === Object.keys(previous).length
    && fields.every(field => current[field] === previous[field]);
  if (same) return { history, current: previous, changed: false };
  return {
    history: { past: [...retainedCanvasHistory(history.past,49), previous], future: [] },
    current,
    changed: true,
  };
}
