import { deletionWindow } from './deletion-grace.mjs';
import { pruneLegacyBatchNodes, removeBatchImage } from './batch-layout.mjs';

// Reconcile persisted copies against durable explicit deletions before opening
// the canvas. An actual undo cancels its receipt before its restored snapshot
// is protected. Imported archives receive a new project ID.
export function reconcileRecordedDeletions(project, records) {
  const active = deletionWindow(records, project.id, Infinity).ready;
  if (!active.length) return project;
  const originalNodes = project.nodes || [];
  const originalConnections = project.connections || [];

  const deletedNodes = new Set(active.flatMap(record => record.nodeIds || []));
  const deletedConnections = new Set(active.flatMap(record => record.connectionIds || []));
  const imagesByNode = new Map();
  for (const image of active.flatMap(record => record.images || [])) {
    if (!imagesByNode.has(image.nodeId)) imagesByNode.set(image.nodeId, new Set());
    imagesByNode.get(image.nodeId).add(image.imageId);
  }

  const nodes = pruneLegacyBatchNodes(originalNodes, deletedNodes).map(node => {
    const removed = imagesByNode.get(node.id);
    if (!removed) return node;
    let next = node;
    for (const image of node.metadata?.images || []) {
      if (removed.has(image.id)) next = removeBatchImage(next, image.id);
    }
    return next;
  });
  const connections = originalConnections.filter(link =>
    !deletedConnections.has(link.id) && !deletedNodes.has(link.fromNodeId) && !deletedNodes.has(link.toNodeId));
  const unchanged = nodes.length === originalNodes.length && nodes.every((node, index) => node === originalNodes[index])
    && connections.length === originalConnections.length;
  return unchanged ? project : { ...project, nodes, connections };
}

export function removedHistoryObjects(current, next) {
  const nextNodes = new Map(next.nodes.map(node => [node.id, node]));
  const nextConnections = new Set(next.connections.map(link => link.id));
  const images = [];
  for (const node of current.nodes) {
    const remaining = nextNodes.get(node.id);
    if (!remaining) continue;
    const nextImages = new Set((remaining.metadata?.images || []).map(image => image.id));
    for (const image of node.metadata?.images || []) {
      if (!nextImages.has(image.id)) images.push({ nodeId: node.id, image });
    }
  }
  return {
    nodes: current.nodes.filter(node => !nextNodes.has(node.id)),
    connections: current.connections.filter(link => !nextConnections.has(link.id)),
    images,
  };
}
