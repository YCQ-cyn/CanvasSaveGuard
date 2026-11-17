export const DELETION_GRACE_MS = 60000;

export function deletionObjectIds(record) {
  return [
    ...(record.nodeIds || []).map(id => JSON.stringify(['node', id])),
    ...(record.connectionIds || []).map(id => JSON.stringify(['connection', id])),
    ...(record.images || []).map(image => JSON.stringify(['image', image.nodeId, image.imageId])),
  ];
}

export function projectObjectIds(project) {
  return new Set(deletionObjectIds({ nodeIds: (project.nodes || []).map(node => node.id),
    connectionIds: (project.connections || []).map(link => link.id),
    images: (project.nodes || []).flatMap(node => (node.metadata?.images || []).map(image => ({ nodeId: node.id, imageId: image.id }))),
  }));
}

// Use the latest deadline for an object even when older extension versions
// stored the same deletion in several receipts. Recent re-deletion wins.
export function deletionWindow(records, projectId, now = Date.now()) {
  const active = records.filter(record => record.projectId === projectId && record.source === 'user-delete' && !record.cancelled)
    .map(record => {
      if (!record.cancelledObjects?.length) return record;
      const cancelled = new Set(record.cancelledObjects);
      // Older receipts grouped several deleted objects without mapping each
      // media key to its owner. After a partial undo, only exact ownership or
      // the remaining deleted history may authorize those media files.
      return {
        ...record,
        nodeIds: (record.nodeIds || []).filter(id => !cancelled.has(JSON.stringify(['node', id]))),
        connectionIds: (record.connectionIds || []).filter(id => !cancelled.has(JSON.stringify(['connection', id]))),
        images: (record.images || []).filter(image => !cancelled.has(JSON.stringify(['image', image.nodeId, image.imageId]))),
        keys: [],
      };
    }).filter(record => deletionObjectIds(record).length);
  const deadlines = new Map();
  for (const record of active) {
    const deadline = record.cleanupAfter ?? (record.deletedAt ? record.deletedAt + DELETION_GRACE_MS : 0);
    for (const id of deletionObjectIds(record)) deadlines.set(id, Math.max(deadlines.get(id) || 0, deadline));
  }
  const ready = [], pending = [];
  let nextAt = Infinity;
  for (const record of active) {
    const deadline = Math.max(0, ...deletionObjectIds(record).map(id => deadlines.get(id)));
    if (deadline <= now) ready.push(record);
    else { pending.push(record); nextAt = Math.min(nextAt, deadline); }
  }
  const waiting = new Set(pending.flatMap(deletionObjectIds));
  return { ready, pending, waiting: { total: waiting.size, nextAt: Number.isFinite(nextAt) ? nextAt : null } };
}
