import { copyImageNode } from './batch-clipboard.mjs';

export function batchMediaDescriptor(node) {
  const metadata = copyImageNode(node).metadata;
  if (node.metadata?.status === 'loading') metadata.status = 'loading';
  return metadata;
}

export function batchMediaEqual(first, second) {
  return ['content', 'storageKey', 'naturalWidth', 'naturalHeight', 'bytes', 'mimeType', 'status', 'errorDetails']
    .every(field => first?.[field] === second?.[field]);
}

export function copyBatchMedia(metadata, source) {
  const next = { ...metadata };
  for (const field of ['content', 'storageKey', 'naturalWidth', 'naturalHeight', 'bytes', 'mimeType', 'status', 'errorDetails']) {
    next[field] = source?.[field];
  }
  return next;
}

// A connected result becomes a real native node. Its file is shared with the
// original result entry, so all native generation/connection APIs can use it.
export function materializeBatchImage(nodes, nodeId, imageId, position, positions) {
  const root = nodes.find(node => node.id === nodeId);
  const image = root?.metadata?.images?.find(image => image.id === imageId);
  if (!image) return { nodes, childId: null };
  const existingId = root.metadata.guardBatchChildren?.[imageId];
  if (nodes.some(node => node.id === existingId)) return { nodes, childId: existingId };
  const childId = nodes.some(node => node.id === imageId) ? `image-${crypto.randomUUID()}` : imageId;
  const child = copyImageNode(root, image, position);
  child.id = childId;
  child.title = `${root.title || '图片'} ${root.metadata.images.indexOf(image) + 1}`;
  child.metadata = { ...child.metadata, batchRootId: nodeId, guardBatchImageId: imageId };
  const metadata = {
    ...root.metadata,
    imageBatchExpanded: root.metadata.imageBatchExpanded !== false,
    guardBatchChildren: { ...root.metadata.guardBatchChildren, [imageId]: childId },
  };
  if (positions) {
    metadata.batchImagePositions = positions;
    metadata.batchResultLayoutVersion = 2;
  }
  return { nodes: [...nodes.map(node => node.id === nodeId ? { ...node, metadata } : node), child], childId };
}

// This runs inside the existing React state updater. Whichever side the native
// operation changes supplies the media update, in the same state transaction.
export function synchronizeBatchGraph(previous, nodes) {
  const roots = nodes.filter(node => node.metadata?.guardBatchChildren && Object.keys(node.metadata.guardBatchChildren).length);
  if (!roots.length) return nodes;
  const before = new Map(previous.map(node => [node.id, node]));
  const current = new Map(nodes.map(node => [node.id, node]));
  const replacements = new Map();
  for (const root of roots) {
    const oldRoot = before.get(root.id);
    let metadata = root.metadata;
    let images = metadata.images || [];
    const mapping = { ...metadata.guardBatchChildren };
    const positions = { ...metadata.batchImagePositions };
    let mappingChanged = false;
    let positionsChanged = false;
    let imagesChanged = false;
    for (const [imageId, childId] of Object.entries(mapping)) {
      const child = replacements.get(childId) || current.get(childId);
      const imageIndex = images.findIndex(image => image.id === imageId);
      if (!child || imageIndex < 0 || child.type !== 'image') {
        delete mapping[imageId];
        mappingChanged = true;
        if (child) {
          const detached = { ...child.metadata };
          delete detached.batchRootId;
          delete detached.guardBatchImageId;
          replacements.set(childId, { ...child, metadata: detached });
        }
        continue;
      }
      let image = images[imageIndex];
      const oldImage = oldRoot?.metadata?.images?.find(item => item.id === imageId);
      const oldChild = before.get(childId);
      if (root === oldRoot && child === oldChild) continue;
      const childMedia = batchMediaDescriptor(child);
      if (oldImage && !batchMediaEqual(image, oldImage) && !batchMediaEqual(image, childMedia)) {
        const childMetadata = copyBatchMedia(child.metadata, image);
        if (childMetadata.images?.length) {
          const primaryId = childMetadata.primaryImageId || childMetadata.images[0].id;
          childMetadata.images = childMetadata.images.map(item => item.id === primaryId
            ? { ...item, ...copyBatchMedia({}, image), id: item.id } : item);
        }
        childMetadata.prompt = metadata.prompt;
        childMetadata.model = metadata.model;
        replacements.set(childId, { ...child, metadata: childMetadata });
      } else if (oldChild && !batchMediaEqual(childMedia, batchMediaDescriptor(oldChild)) && !batchMediaEqual(childMedia, image)) {
        image = { ...image, ...copyBatchMedia({}, childMedia), id: imageId };
        images = images.map((item,index) => index === imageIndex ? image : item);
        imagesChanged = true;
      }
      const position = { x: child.position.x - root.position.x, y: child.position.y - root.position.y };
      if (positions[imageId]?.x !== position.x || positions[imageId]?.y !== position.y) {
        positions[imageId] = position;
        positionsChanged = true;
      }
    }
    if (imagesChanged) {
      metadata = { ...metadata, images };
      const primary = images.find(image => image.id === metadata.primaryImageId) || images[0];
      if (primary) metadata = copyBatchMedia(metadata, primary);
      metadata.status = images.some(image => image.status === 'loading') ? 'loading'
        : images.some(image => image.status === 'success') ? 'success' : images.length ? 'error' : 'idle';
    }
    if (mappingChanged) metadata = { ...metadata, guardBatchChildren: mapping };
    if (positionsChanged) metadata = { ...metadata, batchImagePositions: positions, batchResultLayoutVersion: 2 };
    if (metadata !== root.metadata) replacements.set(root.id, { ...root, metadata });
  }
  return replacements.size ? nodes.map(node => replacements.get(node.id) || node) : nodes;
}
