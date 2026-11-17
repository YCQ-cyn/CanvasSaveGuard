import { collectMedia } from './core.mjs';
import { pruneLegacyBatchNodes } from './batch-layout.mjs';
import { deletionWindow } from './deletion-grace.mjs';

// Generation ownership alone never authorizes deletion. The user must have
// deleted that exact node or image after its request began.
export function recordedDeletionKeys(records, projectId, now = Date.now()) {
  const deletions = deletionWindow(records, projectId, now).ready;
  const keys = new Set(deletions.flatMap(record => record.keys || []));
  for (const record of records) {
    if (record.projectId !== projectId || !['generated-media', 'node-media'].includes(record.source)) continue;
    const observedAt = record.startedAt ?? record.observedAt;
    const deleted = deletions.some(deletion => deletion.deletedAt >= observedAt && (
      deletion.nodeIds?.includes(record.nodeId) || record.imageId && deletion.images?.some(image => image.nodeId === record.nodeId && image.imageId === record.imageId)
    ));
    if (deleted) keys.add(record.key);
  }
  return keys;
}

// Candidate authorization comes from the node's actual file/reference fields.
// Text or prompts that happen to look like a storage key do not own that file.
export function collectDeletedMedia(nodes, found = new Map()) {
  for (const node of nodes) {
    collectMedia({ storageKey: node.metadata?.storageKey, references: node.metadata?.references,
      images: node.metadata?.images?.map(image => ({ storageKey: image.storageKey })) }, found);
  }
  return found;
}

// Prune deleted objects from retained copies. Live scene data is only read.
export function pruneDeletedHistory(current, retained, deletions = { nodeIds: [], connectionIds: [] }) {
  const nodeIds = new Set(current.nodes.map(node => node.id));
  const connectionIds = new Set(current.connections.map(connection => connection.id));
  const deletedNodeIds = new Set(deletions.nodeIds);
  const deletedConnectionIds = new Set(deletions.connectionIds);
  const removedNodes = new Set();
  const removedConnections = new Set();
  const removedImages = new Set();
  const deletedImages = new Set((deletions.images || []).map(item => JSON.stringify([item.nodeId, item.imageId])));
  const liveImages = new Set(current.nodes.flatMap(node => (node.metadata?.images || []).map(image => JSON.stringify([node.id, image.id]))));
  const candidates = new Map();

  function pruneImages(node) {
    const removed = (node.metadata?.images || []).filter(image => {
      const id = JSON.stringify([node.id, image.id]);
      return deletedImages.has(id) && !liveImages.has(id);
    });
    if (!removed.length) return node;
    const removedIds = new Set(removed.map(image => image.id));
    const images = node.metadata.images.filter(image => !removedIds.has(image.id));
    const metadata = { ...node.metadata, images };
    for (const image of removed) removedImages.add(JSON.stringify([node.id, image.id]));
    collectDeletedMedia([{ metadata: { images: removed } }], candidates);
    if (removedIds.has(metadata.primaryImageId)) metadata.primaryImageId = images[0]?.id;
    if (removed.some(image => image.storageKey && image.storageKey === metadata.storageKey)) {
      const primary = images.find(image => image.id === metadata.primaryImageId) || images[0];
      for (const name of ['content', 'storageKey', 'naturalWidth', 'naturalHeight', 'bytes', 'mimeType']) {
        if (primary) metadata[name] = primary[name];
        else delete metadata[name];
      }
    }
    return { ...node, metadata };
  }

  function pruneEntry(entry, clipboard = false) {
    if (!entry) return entry;
    const removedIds = new Set();
    const copiedSources = new Map((clipboard ? entry.sources || [] : []).map(source => [source.id, source]));
    for (const node of entry.nodes || []) {
      const source = copiedSources.get(node.id);
      if (source && ((deletedNodeIds.has(source.nodeId) && !nodeIds.has(source.nodeId))
        || (source.displayNodeId && deletedNodeIds.has(source.displayNodeId) && !nodeIds.has(source.displayNodeId))
        || (source.imageId && deletedImages.has(JSON.stringify([source.nodeId,source.imageId])) && !liveImages.has(JSON.stringify([source.nodeId,source.imageId]))))) {
        removedIds.add(node.id);
        collectDeletedMedia([node], candidates);
        continue;
      }
      if (nodeIds.has(node.id) || !deletedNodeIds.has(node.id)) continue;
      removedNodes.add(node.id);
      removedIds.add(node.id);
      collectDeletedMedia([node], candidates);
    }
    const nodes = pruneLegacyBatchNodes(entry.nodes || [], removedIds).map(pruneImages);
    const connections = (entry.connections || []).filter(connection => {
      const deletedEndpoint = [connection.fromNodeId, connection.toNodeId]
        .some(id => removedIds.has(id) || deletedNodeIds.has(id) && !nodeIds.has(id));
      const deleted = deletedConnectionIds.has(connection.id) || deletedEndpoint;
      const keep = connectionIds.has(connection.id) || !deleted;
      if (!keep) removedConnections.add(connection.id);
      return keep;
    });
    const result = { ...entry, nodes, connections };
    if (clipboard && entry.sources) result.sources=entry.sources.filter(source=>!removedIds.has(source.id));
    if (entry.selectedNodeIds) {
      const remaining = new Set(nodes.map(node => node.id));
      result.selectedNodeIds = entry.selectedNodeIds.filter(id => remaining.has(id));
    }
    return result;
  }

  const history = {
    past: retained.history.past.map(entry => pruneEntry(entry)),
    future: retained.history.future.map(entry => pruneEntry(entry)),
  };
  const lastHistory = pruneEntry(retained.lastHistory);
  return {
    history,
    lastHistory,
    clipboard: pruneEntry(retained.clipboard, true),
    agent: pruneEntry(retained.agent),
    summary: { nodes: removedNodes.size, connections: removedConnections.size, images: removedImages.size, candidateKeys: [...candidates.keys()] },
  };
}
