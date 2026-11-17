import { materializeBatchImage } from './batch-graph.mjs';
import { compactSelectionPositions, snapGridOffset } from './selection-layout.mjs';
import { copyImageNode } from './batch-clipboard.mjs';

export function selectedDownloadNodes(nodes, selectedIds, selectedImages = []) {
  const index = canvasNodeIndex(nodes), children = new Map();
  for (const node of nodes) {
    const parent = legacyBatchRoot(node, nodes);
    if (!parent || parent.id === node.id || node.type !== 'image') continue;
    if (!children.has(parent.id)) children.set(parent.id, []);
    children.get(parent.id).push(node);
  }
  const result = [], included = new Set(), visited = new Set();
  const itemKey = (nodeId, imageId) => JSON.stringify([nodeId, imageId || null]);
  const mediaId = metadata => metadata?.storageKey || (/^(blob:|data:|https?:)/.test(metadata?.content || '') ? metadata.content : null);
  function append(node, image, groupFiles) {
    const key = itemKey(node.id, image?.id);
    if (included.has(key)) return;
    included.add(key);
    const copy = copyImageNode(node, image), file = mediaId(copy.metadata);
    if (groupFiles && file) {
      if (groupFiles.has(file)) return;
      groupFiles.add(file);
    }
    result.push(image ? { ...copy, id: key } : copy);
  }
  // Read group ownership from the complete scene. The traversal is iterative
  // and operates only when downloading, including hidden and offscreen children.
  for (const root of nodes.filter(node => selectedIds.has(node.id) && isExpandableImageGroup(node) && !isImageGroupExpanded(node))) {
    const pending = [root], groupFiles = new Set();
    while (pending.length) {
      const node = pending.pop();
      if (visited.has(node.id)) continue;
      visited.add(node.id);
      const images = node.metadata?.images || [], owned = children.get(node.id) || [];
      if (mediaId(copyImageNode(node).metadata) || !images.length && !owned.length) append(node, undefined, groupFiles);
      else included.add(itemKey(node.id));
      for (const image of images) {
        const mapped = index.get(node.metadata.guardBatchChildren?.[image.id]);
        if (mapped?.type === 'image' && legacyBatchRoot(mapped, nodes)?.id === node.id) included.add(itemKey(node.id, image.id));
        else append(node, image, groupFiles);
      }
      for (let index = owned.length - 1; index >= 0; index--) pending.push(owned[index]);
    }
  }
  for (const node of nodes) if (selectedIds.has(node.id) && node.type === 'image') append(node);
  for (const { nodeId, imageId } of selectedImages) {
    const node = index.get(nodeId), image = node?.metadata?.images?.find(item => item.id === imageId);
    if (image) append(node, image);
  }
  return result;
}

export function isExpandableImageGroup(node) {
  return node.type === 'image' && ((node.metadata?.images?.length || 0) > 1
    || !!node.metadata?.isBatchRoot && !!node.metadata?.batchChildIds?.length
    || !!node.metadata?.batchDisplayRoot && !!node.metadata?.images?.length);
}

export function isImageGroupExpanded(node) {
  return isExpandableImageGroup(node) && (node.metadata.isBatchRoot
    ? !!node.metadata.imageBatchExpanded : node.metadata.imageBatchExpanded !== false);
}

export function selectionLayoutState(nodes, selectedIds) {
  const index = canvasNodeIndex(nodes);
  const groups = [...selectedIds].map(id => index.get(id)).filter(node => node && isExpandableImageGroup(node));
  return {
    groupCount: groups.length,
    allCollapsed: groups.every(node => !isImageGroupExpanded(node)),
    rootCount: selectedLayoutRoots(nodes, selectedIds).length,
  };
}

export function selectedLayoutUnits(nodes, selectedIds) {
  const index = canvasNodeIndex(nodes), children = new Map();
  for (const node of nodes) {
    const batch = legacyBatchRoot(node, nodes);
    const group = index.get(node.metadata?.groupId);
    const parentId = batch?.id || (group?.type === 'group' ? group.id : null);
    if (!parentId || parentId === node.id) continue;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(node.id);
  }
  return { roots: selectedLayoutRoots(nodes, selectedIds), children };
}

export function selectedLayoutRoots(nodes, selectedIds) {
  const index = canvasNodeIndex(nodes);
  return [...selectedIds].map(id => index.get(id)).filter(node => {
    if (!node) return false;
    const parentOf = child => {
      const batch = legacyBatchRoot(child, nodes), group = index.get(child.metadata?.groupId);
      return batch || (group?.type === 'group' ? group : null);
    };
    let parent = parentOf(node);
    const visited = new Set([node.id]);
    while (parent && !visited.has(parent.id)) {
      if (selectedIds.has(parent.id)) return false;
      visited.add(parent.id);
      parent = parentOf(parent);
    }
    return true;
  });
}

export function arrangeSelectedNodes(nodes, selectedIds, center) {
  const { roots, children } = selectedLayoutUnits(nodes, selectedIds);
  if (!roots.length) return nodes;
  const positions = compactSelectionPositions(roots, center);
  const offsets = new Map();
  for (const root of roots) {
    const target = positions.get(root.id);
    const offset = { x: target.x - root.position.x, y: target.y - root.position.y };
    const stack = [root.id];
    while (stack.length) {
      const id = stack.pop();
      if (offsets.has(id)) continue;
      offsets.set(id, offset);
      stack.push(...(children.get(id) || []));
    }
  }
  let changed = false;
  const arranged = nodes.map(node => {
    const offset = offsets.get(node.id);
    if (!offset || !offset.x && !offset.y) return node;
    changed = true;
    return { ...node, position: { x: node.position.x + offset.x, y: node.position.y + offset.y } };
  });
  return changed ? arranged : nodes;
}

export function batchImagePosition(node, imageId, index) {
  const saved = node.metadata?.batchImagePositions?.[imageId];
  if (Number.isFinite(saved?.x) && Number.isFinite(saved?.y)) return saved;
  const primary = node.metadata?.primaryImageId || node.metadata?.images?.[0]?.id;
  let slot = index;
  if (imageId === primary && node.metadata?.batchResultLayoutVersion !== 2 && Object.keys(node.metadata?.batchImagePositions || {}).length) {
    slot = Math.max(index, (node.metadata?.images?.length || 1) - 1);
  }
  return { x: node.width + 120 + (slot % 2) * (node.width + 36), y: Math.floor(slot / 2) * (node.height + 60) };
}

export function batchConnectionPath(node, position) {
  const startX = node.width, startY = node.height / 2;
  const endX = position.x, endY = position.y + node.height / 2;
  const bend = Math.max(50, Math.abs(endX - startX) / 2);
  return `M ${startX} ${startY} C ${startX + bend} ${startY}, ${endX - bend} ${endY}, ${endX} ${endY}`;
}

export function batchIntersectsViewport(node, bounds) {
  let left = node.position.x, top = node.position.y;
  let right = left + node.width, bottom = top + node.height;
  if (node.type === 'image' && node.metadata?.imageBatchExpanded !== false && (node.metadata?.images?.length > 1 || node.metadata?.batchDisplayRoot)) {
    for (const [index, image] of (node.metadata?.images || []).entries()) {
      const position = batchImagePosition(node, image.id, index);
      left = Math.min(left, node.position.x + position.x);
      top = Math.min(top, node.position.y + position.y);
      right = Math.max(right, node.position.x + position.x + node.width);
      bottom = Math.max(bottom, node.position.y + position.y + node.height);
    }
  }
  return right > bounds.left && left < bounds.right && bottom > bounds.top && top < bounds.bottom;
}

export function canvasNodeIndex(nodes) {
  canvasNodeIndex.cache ||= new WeakMap();
  let index = canvasNodeIndex.cache.get(nodes);
  if (!index) { index = new Map(nodes.map(node => [node.id,node])); canvasNodeIndex.cache.set(nodes,index); }
  return index;
}

export function legacyBatchRoot(node, nodes) {
  if (!node.metadata?.batchRootId) return null;
  const root = canvasNodeIndex(nodes).get(node.metadata.batchRootId);
  const mapped = root?.metadata?.guardBatchChildren?.[node.metadata?.guardBatchImageId] === node.id;
  return mapped || root?.metadata?.isBatchRoot && root.metadata.batchChildIds?.includes(node.id) ? root : null;
}

export function legacyBatchMembers(ids, nodes) {
  const members = new Set(ids);
  for (const node of nodes) {
    const root = legacyBatchRoot(node, nodes);
    if (root && ids.has(root.id)) members.add(node.id);
  }
  return members;
}

// Resolve the drag set once, before pointer movement. Deletion continues to use
// its existing group-only membership and never consumes this traversal.
export function dragNodeMembers(ids, nodes, connections, includeDescendants) {
  if (!includeDescendants) return legacyBatchMembers(ids, nodes);
  const index = canvasNodeIndex(nodes), children = new Map();
  function add(parentId, childId) {
    if (!index.has(parentId) || !index.has(childId) || parentId === childId) return;
    if (!children.has(parentId)) children.set(parentId, []);
    children.get(parentId).push(childId);
  }
  for (const node of nodes) {
    const parent = legacyBatchRoot(node, nodes);
    if (parent) add(parent.id, node.id);
    if (index.get(node.metadata?.groupId)?.type === 'group') add(node.metadata.groupId, node.id);
  }
  for (const connection of connections) add(connection.fromNodeId, connection.toNodeId);
  const members = new Set(ids), pending = [...ids];
  while (pending.length) {
    for (const id of children.get(pending.pop()) || []) {
      if (members.has(id)) continue;
      members.add(id); pending.push(id);
    }
  }
  return members;
}

export function removeBatchImage(node, imageId) {
  const images = (node.metadata?.images || []).filter(image => image.id !== imageId);
  const metadata = { ...node.metadata, images, count: images.length, batchDisplayRoot: true };
  const primary = images.find(image => image.id === metadata.primaryImageId) || images.find(image => image.status === 'success') || images[0];
  metadata.primaryImageId = primary?.id;
  for (const field of ['content', 'storageKey', 'naturalWidth', 'naturalHeight', 'bytes', 'mimeType']) {
    if (primary) metadata[field] = primary[field];
    else delete metadata[field];
  }
  metadata.status = images.some(image => image.status === 'loading') ? 'loading' : images.some(image => image.status === 'success') ? 'success' : images.length ? 'error' : 'idle';
  return { ...node, metadata };
}

export function pruneLegacyBatchNodes(nodes, removed) {
  return nodes.filter(node => !removed.has(node.id)).map(node => {
    const mapping = node.metadata?.guardBatchChildren;
    if (mapping && Object.values(mapping).some(id => removed.has(id))) {
      let updated = node;
      const kept = { ...mapping };
      for (const [imageId,childId] of Object.entries(mapping)) if (removed.has(childId)) {
        updated = removeBatchImage(updated,imageId); delete kept[imageId];
      }
      return { ...updated,metadata:{...updated.metadata,guardBatchChildren:kept} };
    }
    if (!node.metadata?.isBatchRoot || !node.metadata.batchChildIds?.some(id => removed.has(id))) return node;
    const childIds = node.metadata.batchChildIds.filter(id => !removed.has(id));
    const metadata = { ...node.metadata, batchChildIds: childIds };
    const removedPrimary = removed.has(metadata.primaryImageId) || nodes.some(child => {
      if (!removed.has(child.id) || child.metadata?.batchRootId !== node.id) return false;
      const sameKey = child.metadata?.storageKey && child.metadata.storageKey === metadata.storageKey;
      const sameContent = child.metadata?.content && child.metadata.content === metadata.content;
      return sameKey || sameContent;
    });
    if (removedPrimary) {
      const primary = nodes.find(child => childIds.includes(child.id) && child.metadata?.status === 'success') || nodes.find(child => childIds.includes(child.id));
      metadata.primaryImageId = primary?.id;
      for (const field of ['content', 'storageKey', 'naturalWidth', 'naturalHeight', 'bytes', 'mimeType']) {
        if (primary) metadata[field] = primary.metadata?.[field];
        else delete metadata[field];
      }
      metadata.status = primary?.metadata?.status || 'idle';
    }
    return { ...node, metadata };
  });
}

export function batchPanelTop(node, expanded, nodes) {
  if (!expanded || node.type !== 'image') return node.height;
  const inline = (node.metadata?.images || []).map((image, index) => batchImagePosition(node, image.id, index).y + node.height);
  const legacy = nodes.filter(child => child.metadata?.batchRootId === node.id && node.metadata?.batchChildIds?.includes(child.id)).map(child => child.position.y - node.position.y + child.height);
  return Math.max(node.height, ...inline, ...legacy);
}

export function animateBatchCard(element, position, index, closing = false) {
  if (!element || element.ownerDocument.defaultView.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  for (const animation of element.getAnimations()) animation.cancel();
  const stacked = { transform: `translate(${34 + index * 14 - position.x}px, ${14 + index * 8 - position.y}px) rotate(${4 + index * 2}deg) scale(.96)`, opacity: 0 };
  const expanded = { transform: 'translate(0, 0) rotate(0deg) scale(1)', opacity: 1 };
  return element.animate(closing ? [expanded, stacked] : [stacked, expanded], {
    duration: closing ? 260 : 340, delay: closing ? 0 : Math.min(index * 24, 120),
    easing: closing ? 'cubic-bezier(.4,0,.2,1)' : 'cubic-bezier(.2,.85,.18,1)', fill: closing ? 'forwards' : 'backwards',
  });
}

// Keep the site's inline image objects and native retry/delete handlers. Only
// positions changed by an actual drag become part of the saved node metadata.
export function createBatchInteraction({ projectId, getNodes, updateNodes, commitNodes, applyMaterialized, getViewport, setViewport, getCanvasRect, setDragging, deleteImage, deleteNodes, getSelectedIds, selectNodes, getConnections, setClipboard, startConnection, document: doc = globalThis.document }) {
  const selected = new Map();
  let drag = null;
  let rectangleStart = null, rectangleSelection = new Map();
  let retryRectangle = null;
  let contextImage = null;
  const gridSnapEnabled = () => !!globalThis.CanvasSaveGuard?.getGridSnap?.();
  const styleId = 'canvas-save-guard-batch-style';
  if (!doc.getElementById(styleId)) {
    const style = doc.createElement('style');
    style.id = styleId;
    style.textContent = '[data-guard-batch-selected="true"]{outline:2px solid #3b82f6;outline-offset:3px}[data-guard-batch-closing="true"]{pointer-events:none!important}';
    doc.head.append(style);
  }
  function paintSelection() {
    for (const element of doc.querySelectorAll('[data-guard-batch-image]')) {
      const key = JSON.stringify([element.dataset.guardBatchNode, element.dataset.guardBatchImage]);
      element.dataset.guardBatchSelected = String(selected.has(key));
    }
    doc.defaultView.dispatchEvent(new doc.defaultView.CustomEvent('canvas-guard-batch-selection',{detail:selected.size}));
  }
  function clearSelection(event) {
    if (event.target instanceof Element && event.target.closest('[data-guard-batch-image],[data-guard-batch-toolbar],[data-guard-batch-port]')) return;
    if (event.shiftKey || event.ctrlKey || event.metaKey) return;
    selected.clear(); paintSelection();
  }
  function copySnapshot() {
    const nodes = getNodes(), ids = getSelectedIds();
    if (!selected.size && !nodes.some(node => ids.has(node.id) && node.type === 'image')) return null;
    const copied = nodes.filter(node => ids.has(node.id)).map(node => copyImageNode(node));
    // Keep provenance on the internal clipboard, outside pasted node metadata.
    // A flattened child has a synthetic clipboard ID, but still belongs to the
    // exact original image's deletion/undo window.
    const sources = copied.map(copy => {
      const node = nodes.find(node => node.id === copy.id);
      const image = node.metadata?.images?.find(image => image.storageKey === copy.metadata?.storageKey && image.id === node.metadata?.primaryImageId)
        || node.metadata?.images?.find(image => image.storageKey === copy.metadata?.storageKey);
      return { id: copy.id, nodeId: node.id, imageId: image?.id,
        displayNodeId: node.metadata?.isBatchRoot ? node.metadata.primaryImageId : undefined };
    });
    for (const { nodeId, imageId } of selected.values()) {
      const node = nodes.find(node => node.id === nodeId), image = node?.metadata?.images?.find(image => image.id === imageId);
      if (!image) continue;
      const index = node.metadata.images.indexOf(image), position = batchImagePosition(node,imageId,index);
      const id = JSON.stringify([nodeId,imageId]);
      copied.push({ ...copyImageNode(node,image,{ x:node.position.x+position.x,y:node.position.y+position.y }), id });
      sources.push({ id, nodeId, imageId });
    }
    const copiedIds = new Set(copied.map(node => node.id));
    return { nodes: copied, sources, connections: getConnections().filter(link => {
      const target = canvasNodeIndex(nodes).get(link.toNodeId);
      const root = target && legacyBatchRoot(target,nodes);
      const groupLink = root?.metadata?.isBatchRoot && root.id === link.fromNodeId;
      return copiedIds.has(link.fromNodeId) && copiedIds.has(link.toNodeId) && !groupLink;
    }).map(link => ({ ...link })) };
  }
  function publish(snapshot) {
    if (!snapshot?.nodes.length) return false;
    setClipboard(snapshot);
    if (snapshot.nodes.length === 1 && snapshot.nodes[0].type === 'image') globalThis.CanvasSaveGuard?.copyImageToClipboard?.(snapshot.nodes[0].metadata)?.catch(() => {});
    return true;
  }
  function deleteSelection() {
    if (!selected.size) return false;
    finish();
    const deleting = [...selected.values()]; selected.clear(); contextImage=null;
    const nativeIds = getSelectedIds();
    if (nativeIds.size) deleteNodes(new Set(nativeIds));
    for (const { nodeId, imageId } of deleting) if(!nativeIds.has(nodeId))deleteImage(nodeId, imageId);
    paintSelection();
    return true;
  }
  function cards() {
    return [...doc.querySelectorAll('[data-guard-batch-image]')];
  }
  function move(event) {
    if (!drag) return;
    const dx = (event.clientX - drag.startX) / drag.scale;
    const dy = (event.clientY - drag.startY) / drag.scale;
    if (Math.abs(dx) + Math.abs(dy) <= 3 && !drag.moved) return;
    drag.moved = true;
    const anchor = drag.items[0];
    const offset = gridSnapEnabled() && !event.altKey ? snapGridOffset({ x: anchor.node.position.x + anchor.initial.x, y: anchor.node.position.y + anchor.initial.y }, { x: dx, y: dy }) : { x: dx, y: dy };
    for (const entry of drag.items) entry.position = { x: entry.initial.x + offset.x, y: entry.initial.y + offset.y };
    for (const element of cards()) {
      const entry = drag.items.find(item => item.nodeId === element.dataset.guardBatchNode && item.imageId === element.dataset.guardBatchImage);
      if (entry) { element.style.left = `${entry.position.x}px`; element.style.top = `${entry.position.y}px`; }
    }
    for (const element of doc.querySelectorAll('[data-guard-batch-port]')) {
      const entry = drag.items.find(item => item.nodeId === element.dataset.guardBatchNode && item.imageId === element.dataset.guardBatchImageId);
      if (!entry) continue;
      element.style.left = `${entry.position.x + (element.dataset.guardBatchPort === 'source' ? entry.node.width : 0) - 24}px`;
      element.style.top = `${entry.position.y + entry.node.height / 2 - 24}px`;
    }
    for (const path of doc.querySelectorAll('[data-guard-batch-line]')) {
      const entry = drag.items.find(item => item.nodeId === path.dataset.guardBatchNode && item.imageId === path.dataset.guardBatchLine);
      if (entry) path.setAttribute('d', batchConnectionPath(entry.node, entry.position));
    }
  }
  function finish() {
    if (!drag) return;
    const completed = drag; drag = null;
    setDragging(false);
    if (!completed.moved) return;
    updateNodes(nodes => nodes.map(node => {
      const items = completed.items.filter(item => item.nodeId === node.id);
      if (!items.length) return node;
      const positions = { ...node.metadata?.batchImagePositions };
      if (node.metadata?.batchResultLayoutVersion !== 2) {
        (node.metadata?.images || []).forEach((image, index) => { positions[image.id] ||= batchImagePosition(node, image.id, index); });
      }
      for (const item of items) if (node.metadata?.images?.some(image => image.id === item.imageId)) positions[item.imageId] = item.position;
      return { ...node, metadata: { ...node.metadata, batchImagePositions: positions, batchResultLayoutVersion: 2 } };
    }));
    requestAnimationFrame(paintSelection);
  }
  function beginDrag(event, nodeId, imageId) {
    event.stopPropagation();
    if (event.button !== 0 || event.target.closest('button,input,textarea,select,[contenteditable="true"]')) return;
    if (doc.documentElement.hasAttribute('data-canvas-guard-cleaning')) return;
    event.preventDefault();
    contextImage = null;
    const key = JSON.stringify([nodeId, imageId]);
    if (event.shiftKey || event.ctrlKey || event.metaKey) {
      if (selected.has(key)) { selected.delete(key); paintSelection(); return; }
    } else if (!selected.has(key)) { selected.clear(); selectNodes(new Set()); }
    selected.set(key, { nodeId, imageId });
    paintSelection();
    const items = [];
    for (const item of selected.values()) {
      const node = getNodes().find(node => node.id === item.nodeId);
      const index = (node?.metadata?.images || []).findIndex(image => image.id === item.imageId);
      if (index >= 0) items.push({ ...item, node, initial: batchImagePosition(node, item.imageId, index) });
    }
    if (!items.length) return;
    for (const element of cards()) for (const animation of element.getAnimations()) animation.cancel();
    drag = { startX: event.clientX, startY: event.clientY, scale: getViewport().k, moved: false, items };
    setDragging(true);
  }
  function keyDown(event) {
    if (doc.documentElement.hasAttribute('data-canvas-guard-cleaning')) return;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest('input,textarea,select,[contenteditable="true"],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]')) return;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'c' && selected.size && !doc.defaultView.getSelection()?.toString()) {
      event.preventDefault();event.stopImmediatePropagation();publish(copySnapshot());return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') { selected.clear();paintSelection();return; }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape') { finish(); contextImage=null; selected.clear(); paintSelection(); return; }
    if (!['Delete', 'Backspace'].includes(event.key) || !selected.size) return;
    event.preventDefault(); event.stopImmediatePropagation();
    deleteSelection();
  }
  doc.addEventListener('pointerdown', clearSelection, true);
  const clearContext = () => { contextImage=null; };
  function cancelRectangle() {
    rectangleStart = null; retryRectangle = null;
    globalThis.CanvasSaveGuardRetryRegion?.cancel(projectId);
  }
  doc.addEventListener('contextmenu', clearContext, true);
  doc.defaultView.addEventListener('mousemove', move);
  doc.defaultView.addEventListener('mouseup', finish);
  doc.defaultView.addEventListener('pointercancel', finish);
  doc.defaultView.addEventListener('blur', finish);
  doc.defaultView.addEventListener('pointercancel', cancelRectangle);
  doc.defaultView.addEventListener('blur', cancelRectangle);
  doc.defaultView.addEventListener('keydown', keyDown, true);
  function materialize(nodeId,imageId) {
    const node = canvasNodeIndex(getNodes()).get(nodeId);
    const index = node?.metadata?.images?.findIndex(image => image.id === imageId);
    if (!node || index < 0) return null;
    globalThis.CanvasSaveGuardHistory?.commitPending();
    const positions = Object.fromEntries(node.metadata.images.map((image, index) => [image.id, batchImagePosition(node, image.id, index)]));
    const local = positions[imageId];
    const result = materializeBatchImage(getNodes(), nodeId, imageId,
      { x: node.position.x + local.x, y: node.position.y + local.y }, positions);
    if (result.childId) applyMaterialized(result.nodes);
    return result.childId;
  }
  function selectionStatus(ids = getSelectedIds(), nodes = getNodes()) {
    const status = selectionLayoutState(nodes, ids);
    const index = canvasNodeIndex(nodes);
    const imageCount = selected.size + [...ids].filter(id => index.get(id)?.type === 'image').length;
    return { ...status, imageCount, canArrange: status.allCollapsed && status.rootCount > 0 && !selected.size };
  }
  function setSelectionExpanded(expanded) {
    if (doc.documentElement.hasAttribute('data-canvas-guard-cleaning') || !globalThis.CanvasSaveGuardHistory?.idle()) return;
    const ids = new Set(getSelectedIds());
    if (!selectionStatus(ids).groupCount) return;
    commitNodes(nodes => {
      let changed = false;
      const updated = nodes.map(node => {
        if (!ids.has(node.id) || !isExpandableImageGroup(node) || isImageGroupExpanded(node) === expanded) return node;
        changed = true;
        return { ...node, metadata: { ...node.metadata, imageBatchExpanded: expanded } };
      });
      return changed ? updated : nodes;
    }, nodes => {
      if (expanded) return;
      // Remove selections of hidden children, keeping their data and positions.
      const groups = new Set(nodes.filter(node => ids.has(node.id) && isExpandableImageGroup(node) && !isImageGroupExpanded(node)).map(node => node.id));
      for (const { nodeId, imageId } of selected.values()) if (groups.has(nodeId)) selected.delete(JSON.stringify([nodeId, imageId]));
      const currentIds = getSelectedIds();
      const visibleIds = new Set(currentIds);
      for (const node of nodes) if (groups.has(legacyBatchRoot(node, nodes)?.id)) visibleIds.delete(node.id);
      if (visibleIds.size !== currentIds.size) selectNodes(visibleIds);
    });
  }
  function arrangeSelection() {
    if (doc.documentElement.hasAttribute('data-canvas-guard-cleaning') || !globalThis.CanvasSaveGuardHistory?.idle()) return;
    const ids = new Set(getSelectedIds());
    if (!selectionStatus(ids).canArrange) return;
    const viewport = getViewport();
    const bounds = getCanvasRect?.() || { width: doc.defaultView.innerWidth, height: doc.defaultView.innerHeight };
    const center = { x: (bounds.width / 2 - viewport.x) / viewport.k, y: (bounds.height / 2 - viewport.y) / viewport.k };
    commitNodes(nodes => selectionStatus(ids, nodes).canArrange ? arrangeSelectedNodes(nodes, ids, center) : nodes, arranged => {
      if (!setViewport || !selectionStatus(ids, arranged).canArrange) return;
      const roots = selectedLayoutRoots(arranged, ids);
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      for (const node of roots) {
        left = Math.min(left, node.position.x); right = Math.max(right, node.position.x + node.width);
        top = Math.min(top, node.position.y); bottom = Math.max(bottom, node.position.y + node.height);
      }
      if (viewport.x + left * viewport.k >= 0 && viewport.x + right * viewport.k <= bounds.width
        && viewport.y + top * viewport.k >= 64 && viewport.y + bottom * viewport.k <= bounds.height - 64) return;
      const scale = Math.max(0.05, Math.min(viewport.k, Math.max(48, bounds.width - 96) / (right - left), Math.max(48, bounds.height - 220) / (bottom - top)));
      setViewport({ x: bounds.width / 2 - (left + right) / 2 * scale, y: bounds.height / 2 - (top + bottom) / 2 * scale, k: scale });
    });
  }
  return {
    projectId, beginDrag, isDragging: () => !!drag, deleteSelection, selectionCount: () => selected.size,
    refreshControls: paintSelection,
    downloadSelection: () => globalThis.CanvasSaveGuard?.downloadSelectedImages?.(selectedDownloadNodes(getNodes(),getSelectedIds(),selected.values())),
    setSelectionExpanded, arrangeSelection, selectionStatus,
    selectionGroups: (ids = getSelectedIds(), nodes = getNodes()) => {
      const index = canvasNodeIndex(nodes);
      return [...ids].filter(id => index.has(id) && isExpandableImageGroup(index.get(id))).length;
    },
    selectionScreenBounds(viewport = getViewport(), ids = getSelectedIds(), nodes = getNodes()) {
      const canvas = getCanvasRect?.() || { left: 0, top: 0, width: doc.defaultView.innerWidth, height: doc.defaultView.innerHeight };
      const bounds = { left: canvas.left, top: canvas.top, right: canvas.left + canvas.width, bottom: canvas.top + canvas.height };
      const index = canvasNodeIndex(nodes);
      let left = Infinity, right = -Infinity, top = Infinity, bottom = -Infinity;
      function include(node, position = node.position) {
        left = Math.min(left, position.x); right = Math.max(right, position.x + node.width);
        top = Math.min(top, position.y); bottom = Math.max(bottom, position.y + node.height);
      }
      for (const id of ids) {
        const node = index.get(id);
        if (node) include(node);
      }
      for (const { nodeId, imageId } of selected.values()) {
        const node = index.get(nodeId);
        const imageIndex = node?.metadata?.images?.findIndex(image => image.id === imageId);
        if (!node || imageIndex < 0) continue;
        const position = batchImagePosition(node, imageId, imageIndex);
        include(node, { x: node.position.x + position.x, y: node.position.y + position.y });
      }
      return { canvas: bounds, selection: Number.isFinite(left) ? {
        left: canvas.left + viewport.x + left * viewport.k, right: canvas.left + viewport.x + right * viewport.k,
        top: canvas.top + viewport.y + top * viewport.k, bottom: canvas.top + viewport.y + bottom * viewport.k,
      } : null };
    },
    getGridSnap: gridSnapEnabled,
    setGridSnap: enabled => globalThis.CanvasSaveGuard?.setGridSnap?.(enabled),
    snapOffset(initial, anchorId, dx, dy, bypass = false) {
      if (!gridSnapEnabled() || bypass) return { x: dx, y: dy };
      const anchor = initial.get(anchorId) || initial.values().next().value;
      return anchor ? snapGridOffset(anchor, { x: dx, y: dy }) : { x: dx, y: dy };
    },
    beginConnection(event, nodeId, imageId, side) {
      event.preventDefault();
      event.stopPropagation();
      if (event.button !== 0) return;
      if (doc.documentElement.hasAttribute('data-canvas-guard-cleaning')) return;
      const childId = materialize(nodeId, imageId);
      if (!childId) return;
      selected.clear();
      paintSelection();
      selectNodes(new Set([childId]));
      let released = false;
      const cancel = () => { released = true; };
      doc.defaultView.addEventListener('mouseup', cancel, { once: true });
      requestAnimationFrame(() => {
        doc.defaultView.removeEventListener('mouseup', cancel);
        if (!released) startConnection(event, childId, side);
      });
    },
    resolveConnectionTarget(world, handle, commit) {
      for (const element of cards().reverse()) {
        if (element.dataset.guardBatchClosing === 'true') continue;
        const node = canvasNodeIndex(getNodes()).get(element.dataset.guardBatchNode);
        const imageId = element.dataset.guardBatchImage;
        const index = node?.metadata?.images?.findIndex(image => image.id === imageId);
        if (!node || index < 0) continue;
        const local = batchImagePosition(node, imageId, index);
        const x = node.position.x + local.x, y = node.position.y + local.y;
        if (world.x < x - 12 || world.x > x + node.width + 12 || world.y < y || world.y > y + node.height) continue;
        if (!commit) return { nodeId: null, isNearNode: true };
        const childId = materialize(node.id, imageId);
        if (childId && childId !== handle.nodeId) return { nodeId: childId, isNearNode: true };
      }
      return null;
    },
    copySnapshot,
    setContextImage: (nodeId,imageId) => {
      contextImage = {nodeId,imageId};
      selected.clear();selected.set(JSON.stringify([nodeId,imageId]),{nodeId,imageId});paintSelection();
      queueMicrotask(()=>selectNodes(new Set()));
    },
    deleteContextImage(nodeId) {
      if(contextImage?.nodeId!==nodeId)return false;
      const target=contextImage;contextImage=null;selected.clear();paintSelection();
      deleteImage(target.nodeId,target.imageId);return true;
    },
    contextCopyTarget(nodeId) {
      if(contextImage?.nodeId!==nodeId)return null;
      const node=getNodes().find(node=>node.id===nodeId),image=node?.metadata?.images?.find(image=>image.id===contextImage.imageId);
      contextImage=null;
      selected.clear();paintSelection();
      return image?copyImageNode(node,image):null;
    },
    copySelection: () => publish(copySnapshot()),
    copyImage(nodeId,imageId) {
      const node = getNodes().find(node => node.id === nodeId), image = node?.metadata?.images?.find(image => image.id === imageId);
      if (image) publish({nodes:[copyImageNode(node,image)],sources:[{id:nodeId,nodeId,imageId}],connections:[]});
    },
    beginRectangle(rectangle) {
      retryRectangle = rectangle;
      globalThis.CanvasSaveGuardRetryRegion?.begin(projectId);
    },
    selectRectangle(rectangle) {
      const start = JSON.stringify([rectangle.startWorldX,rectangle.startWorldY]);
      if (start !== rectangleStart) { rectangleStart=start;rectangleSelection=rectangle.additive?new Map(selected):new Map(); }
      globalThis.CanvasSaveGuardRetryRegion?.begin(projectId);
      retryRectangle = rectangle;
      selected.clear();for (const [key,value] of rectangleSelection) selected.set(key,value);
      const left=Math.min(rectangle.startWorldX,rectangle.currentWorldX),right=Math.max(rectangle.startWorldX,rectangle.currentWorldX);
      const top=Math.min(rectangle.startWorldY,rectangle.currentWorldY),bottom=Math.max(rectangle.startWorldY,rectangle.currentWorldY);
      for (const element of cards()) {
        if (element.dataset.guardBatchClosing === 'true') continue;
        const node=getNodes().find(node=>node.id===element.dataset.guardBatchNode);
        const imageId=element.dataset.guardBatchImage,index=node?.metadata?.images?.findIndex(image=>image.id===imageId);
        if (!node || index<0) continue;
        const position=batchImagePosition(node,imageId,index),x=node.position.x+position.x,y=node.position.y+position.y;
        if (x+node.width>=left&&x<=right&&y+node.height>=top&&y<=bottom) selected.set(JSON.stringify([node.id,imageId]),{nodeId:node.id,imageId});
      }
      paintSelection();
    },
    endRectangle() {
      rectangleStart = null;
      if (retryRectangle) globalThis.CanvasSaveGuardRetryRegion?.capture(projectId, retryRectangle);
      retryRectangle = null;
    },
    cancelRectangle,
    panelTop: (node, expanded) => batchPanelTop(node, expanded, getNodes()),
    setLegacyPrimary(childId) {
      updateNodes(nodes => {
        const child = nodes.find(node => node.id === childId), root = child && legacyBatchRoot(child, nodes);
        if (!root || !child.metadata?.content) return nodes;
        return nodes.map(node => {
          if (node.id !== root.id) return node;
          const metadata = { ...node.metadata, primaryImageId: child.metadata.guardBatchImageId || child.id, status: child.metadata.status };
          for (const field of ['content', 'storageKey', 'naturalWidth', 'naturalHeight', 'bytes', 'mimeType']) metadata[field] = child.metadata[field];
          return { ...node, width: child.width, height: child.height, metadata };
        });
      });
    },
    dispose() {
      cancelRectangle();
      finish(); selected.clear(); paintSelection();
      doc.removeEventListener('pointerdown', clearSelection, true);
      doc.removeEventListener('contextmenu', clearContext, true);
      doc.defaultView.removeEventListener('mousemove', move);
      doc.defaultView.removeEventListener('mouseup', finish);
      doc.defaultView.removeEventListener('pointercancel', finish);
      doc.defaultView.removeEventListener('blur', finish);
      doc.defaultView.removeEventListener('pointercancel', cancelRectangle);
      doc.defaultView.removeEventListener('blur', cancelRectangle);
      doc.defaultView.removeEventListener('keydown', keyDown, true);
    },
  };
}

