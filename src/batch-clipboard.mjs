export function copyImageNode(node, image, position = node.position) {
  if (node.type !== 'image') return { ...node, position: { ...position }, metadata: node.metadata ? { ...node.metadata } : undefined };
  const metadata = { ...node.metadata };
  const displayed = image || metadata.images?.find(item => item.id === metadata.primaryImageId) || metadata.images?.find(item => item.status === 'success');
  if (displayed) for (const field of ['content','storageKey','naturalWidth','naturalHeight','bytes','mimeType','status','errorDetails']) metadata[field] = displayed[field];
  for (const field of ['images','primaryImageId','isBatchRoot','batchChildIds','batchRootId','imageBatchExpanded','batchUsesReferenceImages','batchImagePositions','batchResultLayoutVersion','batchDisplayRoot','groupId','guardBatchChildren','guardBatchImageId']) delete metadata[field];
  metadata.count = 1;
  return { ...node, position: { ...position }, metadata };
}
