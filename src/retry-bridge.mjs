// The canvas virtualizes distant nodes, so enumerate its current data directly.
// Keep requests in the website's original retry handler.
export function createCanvasRetryBridge(projectId, getNodes, retryNode) {
  function canRetry(node, nodesById) {
    if (node.metadata?.status !== 'error' || globalThis.CanvasSaveGuard?.isRetryPending?.(node.id)) return false;
    const visited = new Set();
    let current = node;
    while (current && !visited.has(current.id)) {
      visited.add(current.id);
      const metadata = current.metadata;
      if (metadata?.isBatchRoot && (metadata.batchChildIds?.length || 0) > 1 &&
          !metadata.imageBatchExpanded) return false;
      const parent = nodesById.get(metadata?.batchRootId);
      if (parent && !parent.metadata?.imageBatchExpanded) return false;
      current = parent;
    }
    return true;
  }

  return {
    projectId,
    regionVersion: 1,
    list(region) {
      const nodes = getNodes();
      const nodesById = new Map(nodes.map(node => [node.id, node]));
      return nodes.filter(node => canRetry(node, nodesById) && retryRegionIntersects(region, node)).map(node => node.id);
    },
    retry(nodeId, region) {
      if (globalThis.document?.documentElement.hasAttribute('data-canvas-guard-cleaning')) return false;
      const nodes = getNodes();
      const nodesById = new Map(nodes.map(node => [node.id, node]));
      const node = nodesById.get(nodeId);
      if (!node || !canRetry(node, nodesById) || !retryRegionIntersects(region, node)) return false;
      // Do not wait for generation. This matches clicking the site's retry button.
      void retryNode(node);
      return true;
    }
  };
}

// Vite releases store batch items inside one node. Preserve the existing panel's
// per-item queue and use the site's own retry callback for each failed image.
export function createBatchCanvasRetryBridge(projectId, getNodes, retryNode, getExpanded) {
  function targets(region) {
    const nodes = getNodes();
    const nodesById = new Map(nodes.map(node => [node.id, node]));
    return nodes.flatMap(node => {
      const visited = new Set();
      let parent = node;
      while (parent && !visited.has(parent.id)) {
        visited.add(parent.id);
        const metadata = parent.metadata;
        if (metadata?.isBatchRoot && (metadata.batchChildIds?.length || 0) > 1 && !metadata.imageBatchExpanded) return [];
        parent = nodesById.get(metadata?.batchRootId);
        if (parent && !parent.metadata?.imageBatchExpanded) return [];
      }
      const images = node.metadata?.images || [];
      const inlineBatch = images.length > 1 || node.metadata?.batchDisplayRoot;
      if (inlineBatch && !getExpanded().has(node.id)) return [];
      if (inlineBatch) {
        const primaryId = node.metadata.primaryImageId || images.find(image => image.status === 'success')?.id || images[0]?.id;
        return images.filter((image, index) => {
          if (image.status !== 'error' || node.metadata.guardBatchChildren?.[image.id] || globalThis.CanvasSaveGuard?.isRetryPending?.(node.id,image.id)) return false;
          const local = batchImagePosition(node, image.id, index);
          return retryRegionIntersects(region, node, { x: node.position.x + local.x, y: node.position.y + local.y })
            || image.id === primaryId && retryRegionIntersects(region, node);
        }).map(image => [node.id, image.id]);
      }
      return node.metadata?.status === 'error' && !globalThis.CanvasSaveGuard?.isRetryPending?.(node.id) && retryRegionIntersects(region, node) ? [[node.id, null]] : [];
    });
  }
  return {
    projectId,
    regionVersion: 1,
    list: region => targets(region).map(target => JSON.stringify(target)),
    retry(targetId, region) {
      if (globalThis.document?.documentElement.hasAttribute('data-canvas-guard-cleaning')) return false;
      const target = targets(region).find(item => JSON.stringify(item) === targetId);
      if (!target) return false;
      const node = getNodes().find(node => node.id === target[0]);
      void retryNode(node, target[1] || undefined);
      return true;
    },
  };
}
import { batchImagePosition } from './batch-layout.mjs';
import { retryRegionIntersects } from './retry-region.mjs';

