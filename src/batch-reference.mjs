export function selectedEmptyImageIds(nodes, selectedIds) {
  const ids = new Set(selectedIds);
  return nodes.filter(node => {
    if (!ids.has(node.id) || node.type !== 'image') return false;
    const metadata = node.metadata || {};
    return !metadata.content && !metadata.storageKey
      && (!metadata.status || metadata.status === 'idle')
      && !metadata.images?.length && !metadata.isBatchRoot && !metadata.batchDisplayRoot
      && !metadata.batchRootId && !metadata.guardBatchImageId && !metadata.batchChildIds?.length;
  }).map(node => node.id);
}

export function batchReferenceTargetIds(nodes, selectedIds, connection) {
  if (!selectedIds) return [];
  const source = nodes.find(node => node.id === connection.fromNodeId);
  if (source?.type !== 'image' || !(source.metadata?.content || source.metadata?.storageKey)) return [];
  const targets = selectedEmptyImageIds(nodes, selectedIds);
  return targets.length > 1 && targets.includes(connection.toNodeId) ? targets : [];
}

export function appendBatchReferenceConnections(connections, sourceId, targetIds) {
  const connected = new Set(connections.filter(link => link.fromNodeId === sourceId).map(link => link.toNodeId));
  const added = [];
  for (const targetId of targetIds) {
    if (targetId === sourceId || connected.has(targetId)) continue;
    connected.add(targetId);
    added.push({ id: `conn-${crypto.randomUUID()}`, fromNodeId: sourceId, toNodeId: targetId });
  }
  return added.length ? [...connections, ...added] : connections;
}
