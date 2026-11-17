import { collectDeletedMedia } from './deleted-history.mjs';
import { mediaKey } from './core.mjs';

// Store provenance for actual node media fields. Text that resembles a file
// key does not establish ownership or authorize a later deletion.
export function nodeMediaOwners(project, observedAt, knownUrls = []) {
  const aliases = new Map(knownUrls);
  const owners = [];
  for (const node of project.nodes || []) {
    for (const key of collectDeletedMedia([node]).keys()) owners.push({ projectId: project.id, nodeId: node.id, key, observedAt });
    for (const image of node.metadata?.images || []) {
      const key = image.storageKey || aliases.get(image.content);
      if (mediaKey(key)) owners.push({ projectId: project.id, nodeId: node.id, imageId: image.id, key, observedAt });
    }
    if (!node.metadata?.storageKey) {
      const key = aliases.get(node.metadata?.content);
      if (mediaKey(key)) owners.push({ projectId: project.id, nodeId: node.id, key, observedAt });
    }
  }
  return owners;
}
