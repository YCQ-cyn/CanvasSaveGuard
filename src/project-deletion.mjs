import { mediaKey } from './core.mjs';
import { DELETION_GRACE_MS } from './deletion-grace.mjs';

// Only media/reference fields establish ownership. A prompt or text node may
// contain a literal storage key without owning that file.
export function projectMediaKeys(project) {
  const keys = new Set();
  const visited = new WeakSet();
  function visit(value, nodeType) {
    if (mediaKey(value)) { keys.add(value); return; }
    if (!value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) { value.forEach(item => visit(item, nodeType)); return; }
    if (['image', 'video', 'audio', 'text', 'config'].includes(value.type)) nodeType = value.type;
    for (const [field, child] of Object.entries(value)) {
      if (['prompt', 'composerContent', 'text', 'title', 'errorDetails'].includes(field)) continue;
      if (field === 'content' && ['text', 'config'].includes(nodeType)) continue;
      visit(child, nodeType);
    }
  }
  visit(project);
  return keys;
}

// Native deletedProjects rows and new explicit receipts prove a whole-canvas
// deletion. Older inferred "missing project" backup markers do not authorize it.
export function projectDeletionWindow({ nativeTombstones = [], tombstones = [], projects = [], liveProjects = [], liveProjectIds = [], records = [] }, now = Date.now()) {
  const deletions = new Map();
  for (const row of [...nativeTombstones, ...tombstones.filter(row => row.source === 'user-delete-project')]) {
    const deletedAt = Date.parse(row.at || row.deletedAt);
    if (!row.id || !Number.isFinite(deletedAt) || row.cancelled) continue;
    const previous = deletions.get(row.id);
    if (!previous) deletions.set(row.id, { id: row.id, deletedAt, keys: new Set() });
    else previous.deletedAt = Math.max(previous.deletedAt, deletedAt);
    for (const key of row.keys || []) if (mediaKey(key)) deletions.get(row.id).keys.add(key);
  }
  const liveIds = new Set([...liveProjectIds, ...liveProjects.map(project => project.id)]);
  for (const project of projects) {
    const deletion = deletions.get(project.id);
    if (!deletion) continue;
    if (Date.parse(project.updatedAt) > deletion.deletedAt) { liveIds.add(project.id); continue; }
    for (const key of projectMediaKeys(project)) deletion.keys.add(key);
  }
  for (const record of records) {
    const deletion = deletions.get(record.projectId);
    if (!deletion) continue;
    if (['node-media', 'generated-media'].includes(record.source)) {
      const observedAt = record.startedAt ?? record.observedAt;
      if (Number.isFinite(observedAt) && observedAt <= deletion.deletedAt && mediaKey(record.key)) deletion.keys.add(record.key);
    } else if (record.source === 'user-delete' && record.deletedAt <= deletion.deletedAt) {
      for (const key of record.keys || []) if (mediaKey(key)) deletion.keys.add(key);
    }
  }
  const ready = [], pending = [];
  for (const deletion of deletions.values()) {
    if (liveIds.has(deletion.id)) continue;
    const entry = { ...deletion, keys: [...deletion.keys].sort(), cleanupAfter: deletion.deletedAt + DELETION_GRACE_MS };
    if (entry.cleanupAfter <= now) ready.push(entry);
    else pending.push(entry);
  }
  return { ready, pending, waiting: { total: pending.length, nextAt: pending.length ? Math.min(...pending.map(entry => entry.cleanupAfter)) : null } };
}
