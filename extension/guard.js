(() => {
  // src/media-fields.mjs
  var textFields = /* @__PURE__ */ new Set(["prompt", "composerContent", "text", "title", "errorDetails"]);
  function isMediaTextField(name, value, nodeType) {
    return typeof value === "string" && (textFields.has(name) || name === "content" && ["text", "config"].includes(nodeType));
  }

  // src/core.mjs
  var STORE_KEY = "infinite-canvas:canvas_store";
  var mediaKey = (value) => typeof value === "string" && /^(image|video|audio|file|video-reference|audio-reference):[^\s]+$/.test(value);
  var clone = (value) => JSON.parse(JSON.stringify(value));
  var signature = (value) => JSON.stringify(value);
  function collectMedia(value, found = /* @__PURE__ */ new Map(), visited = /* @__PURE__ */ new WeakSet(), nodeType) {
    if (mediaKey(value)) {
      if (!found.has(value)) found.set(value, []);
    } else if (Array.isArray(value)) {
      if (visited.has(value)) return found;
      visited.add(value);
      value.forEach((item) => collectMedia(item, found, visited, nodeType));
    } else if (value && typeof value === "object") {
      if (visited.has(value)) return found;
      visited.add(value);
      if (["image", "video", "audio", "text", "config"].includes(value.type || value.kind)) nodeType = value.type || value.kind;
      if (mediaKey(value.storageKey)) {
        const sources = found.get(value.storageKey) || [];
        for (const field of ["content", "dataUrl", "url"]) {
          if (typeof value[field] === "string" && /^(blob:|data:|https?:)/.test(value[field])) sources.push(value[field]);
        }
        found.set(value.storageKey, [...new Set(sources)]);
      }
      for (const name of Object.keys(value)) {
        const item = value[name];
        if (!isMediaTextField(name, item, nodeType)) collectMedia(item, found, visited, nodeType);
      }
    }
    return found;
  }
  function pendingNodes(project) {
    return project.nodes.filter((node) => node.metadata?.status === "loading");
  }
  function mergeProjects(disk, changed, deleted = /* @__PURE__ */ new Set()) {
    const merged = new Map(disk.filter((p) => !deleted.has(p.id)).map((p) => [p.id, p]));
    for (const p of changed) if (!deleted.has(p.id)) merged.set(p.id, p);
    return [...merged.values()];
  }
  function newerProjects(disk, protectedProjects, tombstones = []) {
    const deleted = /* @__PURE__ */ new Map();
    for (const tombstone of tombstones) {
      const at = tombstone.at || tombstone.deletedAt;
      if (at && (!deleted.has(tombstone.id) || at > deleted.get(tombstone.id))) deleted.set(tombstone.id, at);
    }
    const map = /* @__PURE__ */ new Map();
    for (const p of [...disk, ...protectedProjects]) {
      const deletedAt = deleted.get(p.id);
      if (deletedAt && deletedAt >= (p.updatedAt || "")) continue;
      const prev = map.get(p.id);
      if (!prev || (p.updatedAt || "") >= (prev.updatedAt || "")) map.set(p.id, p);
    }
    return [...map.values()];
  }
  function safeName(name) {
    return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").slice(0, 140) || "\u753B\u5E03";
  }
  function extension(type, key) {
    const types = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif", "image/svg+xml": "svg", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg" };
    return types[type] || (key.startsWith("image:") ? "png" : "bin");
  }
  async function sha256(bytes) {
    return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  async function prepareArchive(projects, readBlob, fetchBlob, validate = async () => {
  }) {
    const snapshots = clone(projects);
    const media = /* @__PURE__ */ new Map();
    const missing = [];
    const urlKeys = /* @__PURE__ */ new Map();
    const external = /* @__PURE__ */ new Map();
    function index(value, nodeType) {
      if (!value || typeof value !== "object") return;
      if (["image", "video", "audio", "text", "config"].includes(value.type)) nodeType = value.type;
      if (mediaKey(value.storageKey)) {
        for (const field of ["content", "dataUrl", "url"]) if (typeof value[field] === "string") urlKeys.set(value[field], value.storageKey);
      } else {
        for (const field of ["content", "dataUrl", "url"]) {
          if (typeof value[field] === "string" && /^(blob:|data:image\/|data:video\/|data:audio\/|https?:)/.test(value[field])) {
            if (field === "content" && (["text", "config"].includes(nodeType) || !("status" in value || "naturalWidth" in value || "mimeType" in value))) continue;
            external.set(value[field], value);
          }
        }
      }
      for (const [name, item] of Object.entries(value)) if (!isMediaTextField(name, item, nodeType)) {
        Array.isArray(item) ? item.forEach((child) => index(child, nodeType)) : index(item, nodeType);
      }
    }
    snapshots.forEach((item) => index(item));
    for (const [url, owner] of external) {
      if (!urlKeys.has(url)) {
        try {
          const blob = await fetchBlob(url);
          if (!blob || !blob.size) throw Error("\u7A7A\u6587\u4EF6");
          const key = `${blob.type.startsWith("image/") ? "image" : "file"}:guard-${await sha256(await blob.arrayBuffer())}`;
          media.set(key, blob);
          urlKeys.set(url, key);
        } catch {
          missing.push({ key: url.slice(0, 150), reason: "\u539F\u5730\u5740\u65E0\u6CD5\u8BFB\u53D6" });
        }
      }
      if (urlKeys.has(url)) owner.storageKey = urlKeys.get(url);
    }
    function rewrite(value, nodeType) {
      if (Array.isArray(value)) return value.map((item) => rewrite(item, nodeType));
      if (!value || typeof value !== "object") {
        if (typeof value === "string" && value.startsWith("blob:")) {
          if (urlKeys.has(value)) return urlKeys.get(value);
          missing.push({ key: value, reason: "\u4E34\u65F6\u5730\u5740\u6CA1\u6709\u5BF9\u5E94\u7684\u6587\u4EF6" });
        }
        return value;
      }
      if (["image", "video", "audio", "text", "config"].includes(value.type || value.kind)) nodeType = value.type || value.kind;
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = isMediaTextField(k, v, nodeType) ? v : rewrite(v, nodeType);
      if (mediaKey(out.storageKey)) for (const field of ["content", "dataUrl", "url"]) {
        if (!isMediaTextField(field, value[field], nodeType) && typeof value[field] === "string" && /^(blob:|data:|https?:)/.test(value[field])) out[field] = `guard-file:${out.storageKey}`;
      }
      return out;
    }
    const normalized = snapshots.map((project) => rewrite(project));
    const exported = [];
    for (const project of normalized) {
      if (pendingNodes(project).length) throw Error(`\u201C${project.title}\u201D\u8FD8\u6709 ${pendingNodes(project).length} \u9879\u6B63\u5728\u751F\u6210\uFF0C\u8BF7\u5B8C\u6210\u540E\u518D\u5BFC\u51FA\u3002`);
      const files = [];
      for (const [key, sources] of collectMedia(project)) {
        let blob = media.get(key) || await readBlob(key);
        if (!blob) {
          const originals = collectMedia(snapshots.find((p) => p.id === project.id)).get(key) || sources;
          for (const url of originals) {
            try {
              blob = await fetchBlob(url);
              if (blob?.size) break;
            } catch {
            }
          }
        }
        if (!blob?.size) {
          missing.push({ key, reason: "\u56FE\u7247\u6216\u5A92\u4F53\u6587\u4EF6\u7F3A\u5931" });
          continue;
        }
        await validate(blob, key);
        media.set(key, blob);
        files.push({ storageKey: key, path: `projects/${safeName(project.id)}/files/${safeName(key)}.${extension(blob.type, key)}`, mimeType: blob.type || "application/octet-stream", bytes: blob.size, sha256: await sha256(await blob.arrayBuffer()) });
      }
      exported.push({ project, files });
    }
    if (missing.length) {
      const error = Error(`\u65E0\u6CD5\u5B8C\u6574\u5BFC\u51FA\uFF1A\u7F3A\u5C11 ${new Set(missing.map((m) => m.key)).size} \u4E2A\u6587\u4EF6\u3002\u672A\u751F\u6210\u6709\u7F3A\u56FE\u7684\u538B\u7F29\u5305\u3002`);
      error.missing = missing;
      throw error;
    }
    return { data: { app: "infinite-canvas", version: 3, exportedAt: (/* @__PURE__ */ new Date()).toISOString(), projects: exported }, media };
  }

  // src/batch-layout.mjs
  function removeBatchImage(node, imageId) {
    const images = (node.metadata?.images || []).filter((image) => image.id !== imageId);
    const metadata = { ...node.metadata, images, count: images.length, batchDisplayRoot: true };
    const primary = images.find((image) => image.id === metadata.primaryImageId) || images.find((image) => image.status === "success") || images[0];
    metadata.primaryImageId = primary?.id;
    for (const field of ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType"]) {
      if (primary) metadata[field] = primary[field];
      else delete metadata[field];
    }
    metadata.status = images.some((image) => image.status === "loading") ? "loading" : images.some((image) => image.status === "success") ? "success" : images.length ? "error" : "idle";
    return { ...node, metadata };
  }
  function pruneLegacyBatchNodes(nodes, removed) {
    return nodes.filter((node) => !removed.has(node.id)).map((node) => {
      const mapping = node.metadata?.guardBatchChildren;
      if (mapping && Object.values(mapping).some((id) => removed.has(id))) {
        let updated = node;
        const kept = { ...mapping };
        for (const [imageId, childId] of Object.entries(mapping)) if (removed.has(childId)) {
          updated = removeBatchImage(updated, imageId);
          delete kept[imageId];
        }
        return { ...updated, metadata: { ...updated.metadata, guardBatchChildren: kept } };
      }
      if (!node.metadata?.isBatchRoot || !node.metadata.batchChildIds?.some((id) => removed.has(id))) return node;
      const childIds = node.metadata.batchChildIds.filter((id) => !removed.has(id));
      const metadata = { ...node.metadata, batchChildIds: childIds };
      const removedPrimary = removed.has(metadata.primaryImageId) || nodes.some((child) => {
        if (!removed.has(child.id) || child.metadata?.batchRootId !== node.id) return false;
        const sameKey = child.metadata?.storageKey && child.metadata.storageKey === metadata.storageKey;
        const sameContent = child.metadata?.content && child.metadata.content === metadata.content;
        return sameKey || sameContent;
      });
      if (removedPrimary) {
        const primary = nodes.find((child) => childIds.includes(child.id) && child.metadata?.status === "success") || nodes.find((child) => childIds.includes(child.id));
        metadata.primaryImageId = primary?.id;
        for (const field of ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType"]) {
          if (primary) metadata[field] = primary.metadata?.[field];
          else delete metadata[field];
        }
        metadata.status = primary?.metadata?.status || "idle";
      }
      return { ...node, metadata };
    });
  }

  // src/deletion-grace.mjs
  var DELETION_GRACE_MS = 6e4;
  function deletionObjectIds(record) {
    return [
      ...(record.nodeIds || []).map((id) => JSON.stringify(["node", id])),
      ...(record.connectionIds || []).map((id) => JSON.stringify(["connection", id])),
      ...(record.images || []).map((image) => JSON.stringify(["image", image.nodeId, image.imageId]))
    ];
  }
  function projectObjectIds(project) {
    return new Set(deletionObjectIds({
      nodeIds: (project.nodes || []).map((node) => node.id),
      connectionIds: (project.connections || []).map((link) => link.id),
      images: (project.nodes || []).flatMap((node) => (node.metadata?.images || []).map((image) => ({ nodeId: node.id, imageId: image.id })))
    }));
  }
  function deletionWindow(records, projectId, now = Date.now()) {
    const active = records.filter((record) => record.projectId === projectId && record.source === "user-delete" && !record.cancelled).map((record) => {
      if (!record.cancelledObjects?.length) return record;
      const cancelled = new Set(record.cancelledObjects);
      return {
        ...record,
        nodeIds: (record.nodeIds || []).filter((id) => !cancelled.has(JSON.stringify(["node", id]))),
        connectionIds: (record.connectionIds || []).filter((id) => !cancelled.has(JSON.stringify(["connection", id]))),
        images: (record.images || []).filter((image) => !cancelled.has(JSON.stringify(["image", image.nodeId, image.imageId]))),
        keys: []
      };
    }).filter((record) => deletionObjectIds(record).length);
    const deadlines = /* @__PURE__ */ new Map();
    for (const record of active) {
      const deadline = record.cleanupAfter ?? (record.deletedAt ? record.deletedAt + DELETION_GRACE_MS : 0);
      for (const id of deletionObjectIds(record)) deadlines.set(id, Math.max(deadlines.get(id) || 0, deadline));
    }
    const ready = [], pending = [];
    let nextAt = Infinity;
    for (const record of active) {
      const deadline = Math.max(0, ...deletionObjectIds(record).map((id) => deadlines.get(id)));
      if (deadline <= now) ready.push(record);
      else {
        pending.push(record);
        nextAt = Math.min(nextAt, deadline);
      }
    }
    const waiting = new Set(pending.flatMap(deletionObjectIds));
    return { ready, pending, waiting: { total: waiting.size, nextAt: Number.isFinite(nextAt) ? nextAt : null } };
  }

  // src/deleted-history.mjs
  function recordedDeletionKeys(records, projectId, now = Date.now()) {
    const deletions = deletionWindow(records, projectId, now).ready;
    const keys = new Set(deletions.flatMap((record) => record.keys || []));
    for (const record of records) {
      if (record.projectId !== projectId || !["generated-media", "node-media"].includes(record.source)) continue;
      const observedAt = record.startedAt ?? record.observedAt;
      const deleted = deletions.some((deletion) => deletion.deletedAt >= observedAt && (deletion.nodeIds?.includes(record.nodeId) || record.imageId && deletion.images?.some((image) => image.nodeId === record.nodeId && image.imageId === record.imageId)));
      if (deleted) keys.add(record.key);
    }
    return keys;
  }
  function collectDeletedMedia(nodes, found = /* @__PURE__ */ new Map()) {
    for (const node of nodes) {
      collectMedia({
        storageKey: node.metadata?.storageKey,
        references: node.metadata?.references,
        images: node.metadata?.images?.map((image) => ({ storageKey: image.storageKey }))
      }, found);
    }
    return found;
  }
  function pruneDeletedHistory(current, retained, deletions = { nodeIds: [], connectionIds: [] }) {
    const nodeIds = new Set(current.nodes.map((node) => node.id));
    const connectionIds = new Set(current.connections.map((connection) => connection.id));
    const deletedNodeIds = new Set(deletions.nodeIds);
    const deletedConnectionIds = new Set(deletions.connectionIds);
    const removedNodes = /* @__PURE__ */ new Set();
    const removedConnections = /* @__PURE__ */ new Set();
    const removedImages = /* @__PURE__ */ new Set();
    const deletedImages = new Set((deletions.images || []).map((item) => JSON.stringify([item.nodeId, item.imageId])));
    const liveImages = new Set(current.nodes.flatMap((node) => (node.metadata?.images || []).map((image) => JSON.stringify([node.id, image.id]))));
    const candidates = /* @__PURE__ */ new Map();
    function pruneImages(node) {
      const removed = (node.metadata?.images || []).filter((image) => {
        const id = JSON.stringify([node.id, image.id]);
        return deletedImages.has(id) && !liveImages.has(id);
      });
      if (!removed.length) return node;
      const removedIds = new Set(removed.map((image) => image.id));
      const images = node.metadata.images.filter((image) => !removedIds.has(image.id));
      const metadata = { ...node.metadata, images };
      for (const image of removed) removedImages.add(JSON.stringify([node.id, image.id]));
      collectDeletedMedia([{ metadata: { images: removed } }], candidates);
      if (removedIds.has(metadata.primaryImageId)) metadata.primaryImageId = images[0]?.id;
      if (removed.some((image) => image.storageKey && image.storageKey === metadata.storageKey)) {
        const primary = images.find((image) => image.id === metadata.primaryImageId) || images[0];
        for (const name of ["content", "storageKey", "naturalWidth", "naturalHeight", "bytes", "mimeType"]) {
          if (primary) metadata[name] = primary[name];
          else delete metadata[name];
        }
      }
      return { ...node, metadata };
    }
    function pruneEntry(entry, clipboard = false) {
      if (!entry) return entry;
      const removedIds = /* @__PURE__ */ new Set();
      const copiedSources = new Map((clipboard ? entry.sources || [] : []).map((source) => [source.id, source]));
      for (const node of entry.nodes || []) {
        const source = copiedSources.get(node.id);
        if (source && (deletedNodeIds.has(source.nodeId) && !nodeIds.has(source.nodeId) || source.displayNodeId && deletedNodeIds.has(source.displayNodeId) && !nodeIds.has(source.displayNodeId) || source.imageId && deletedImages.has(JSON.stringify([source.nodeId, source.imageId])) && !liveImages.has(JSON.stringify([source.nodeId, source.imageId])))) {
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
      const connections = (entry.connections || []).filter((connection) => {
        const deletedEndpoint = [connection.fromNodeId, connection.toNodeId].some((id) => removedIds.has(id) || deletedNodeIds.has(id) && !nodeIds.has(id));
        const deleted = deletedConnectionIds.has(connection.id) || deletedEndpoint;
        const keep = connectionIds.has(connection.id) || !deleted;
        if (!keep) removedConnections.add(connection.id);
        return keep;
      });
      const result = { ...entry, nodes, connections };
      if (clipboard && entry.sources) result.sources = entry.sources.filter((source) => !removedIds.has(source.id));
      if (entry.selectedNodeIds) {
        const remaining = new Set(nodes.map((node) => node.id));
        result.selectedNodeIds = entry.selectedNodeIds.filter((id) => remaining.has(id));
      }
      return result;
    }
    const history = {
      past: retained.history.past.map((entry) => pruneEntry(entry)),
      future: retained.history.future.map((entry) => pruneEntry(entry))
    };
    const lastHistory = pruneEntry(retained.lastHistory);
    return {
      history,
      lastHistory,
      clipboard: pruneEntry(retained.clipboard, true),
      agent: pruneEntry(retained.agent),
      summary: { nodes: removedNodes.size, connections: removedConnections.size, images: removedImages.size, candidateKeys: [...candidates.keys()] }
    };
  }

  // src/project-deletion.mjs
  function projectMediaKeys(project) {
    const keys = /* @__PURE__ */ new Set();
    const visited = /* @__PURE__ */ new WeakSet();
    function visit(value, nodeType) {
      if (mediaKey(value)) {
        keys.add(value);
        return;
      }
      if (!value || typeof value !== "object" || visited.has(value)) return;
      visited.add(value);
      if (Array.isArray(value)) {
        value.forEach((item) => visit(item, nodeType));
        return;
      }
      if (["image", "video", "audio", "text", "config"].includes(value.type)) nodeType = value.type;
      for (const [field, child] of Object.entries(value)) {
        if (["prompt", "composerContent", "text", "title", "errorDetails"].includes(field)) continue;
        if (field === "content" && ["text", "config"].includes(nodeType)) continue;
        visit(child, nodeType);
      }
    }
    visit(project);
    return keys;
  }
  function projectDeletionWindow({ nativeTombstones = [], tombstones = [], projects = [], liveProjects = [], liveProjectIds = [], records = [] }, now = Date.now()) {
    const deletions = /* @__PURE__ */ new Map();
    for (const row of [...nativeTombstones, ...tombstones.filter((row2) => row2.source === "user-delete-project")]) {
      const deletedAt = Date.parse(row.at || row.deletedAt);
      if (!row.id || !Number.isFinite(deletedAt) || row.cancelled) continue;
      const previous = deletions.get(row.id);
      if (!previous) deletions.set(row.id, { id: row.id, deletedAt, keys: /* @__PURE__ */ new Set() });
      else previous.deletedAt = Math.max(previous.deletedAt, deletedAt);
      for (const key of row.keys || []) if (mediaKey(key)) deletions.get(row.id).keys.add(key);
    }
    const liveIds = /* @__PURE__ */ new Set([...liveProjectIds, ...liveProjects.map((project) => project.id)]);
    for (const project of projects) {
      const deletion = deletions.get(project.id);
      if (!deletion) continue;
      if (Date.parse(project.updatedAt) > deletion.deletedAt) {
        liveIds.add(project.id);
        continue;
      }
      for (const key of projectMediaKeys(project)) deletion.keys.add(key);
    }
    for (const record of records) {
      const deletion = deletions.get(record.projectId);
      if (!deletion) continue;
      if (["node-media", "generated-media"].includes(record.source)) {
        const observedAt = record.startedAt ?? record.observedAt;
        if (Number.isFinite(observedAt) && observedAt <= deletion.deletedAt && mediaKey(record.key)) deletion.keys.add(record.key);
      } else if (record.source === "user-delete" && record.deletedAt <= deletion.deletedAt) {
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
    return { ready, pending, waiting: { total: pending.length, nextAt: pending.length ? Math.min(...pending.map((entry) => entry.cleanupAfter)) : null } };
  }

  // src/vault.mjs
  var Vault = class {
    constructor(indexedDB2, name = "canvas-save-guard") {
      this.indexedDB = indexedDB2;
      this.name = name;
      this.opened = null;
    }
    open() {
      if (!this.opened) this.opened = new Promise((resolve, reject) => {
        const request = this.indexedDB.open(this.name, 2);
        request.onupgradeneeded = () => {
          for (const name of ["projects", "media", "deleted", "cleanup_candidates"]) {
            if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
          }
        };
        request.onsuccess = () => {
          const db = request.result;
          db.onversionchange = () => {
            db.close();
            this.opened = null;
          };
          resolve(db);
        };
        request.onerror = () => {
          this.opened = null;
          reject(request.error);
        };
        request.onblocked = () => reject(Error("\u672C\u5730\u4FDD\u62A4\u6570\u636E\u5E93\u88AB\u5176\u4ED6\u9875\u9762\u963B\u585E\u3002"));
      });
      return this.opened;
    }
    async transaction(store, mode, action) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const tx = db.transaction(store, mode);
        let result;
        const request = action(tx.objectStore(store));
        if (request) request.onsuccess = () => {
          result = request.result;
        };
        tx.oncomplete = () => resolve(result);
        tx.onabort = () => reject(tx.error || Error("\u672C\u5730\u4FDD\u62A4\u5199\u5165\u5DF2\u4E2D\u65AD"));
        tx.onerror = () => {
        };
      });
    }
    get(store, key) {
      return this.transaction(store, "readonly", (s) => s.get(key));
    }
    all(store) {
      return this.transaction(store, "readonly", (s) => s.getAll());
    }
    keys(store) {
      return this.transaction(store, "readonly", (s) => s.getAllKeys());
    }
    put(store, key, value) {
      return this.transaction(store, "readwrite", (s) => s.put(value, key));
    }
    async recordDeletedMedia(projectId, keys) {
      if (!keys.length) return;
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("cleanup_candidates", "readwrite");
        for (const key of keys) transaction.objectStore("cleanup_candidates").put({ projectId, key }, `${projectId}/${key}`);
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error("\u5220\u9664\u7F13\u5B58\u8BB0\u5F55\u5199\u5165\u4E2D\u65AD\u3002"));
        transaction.onerror = () => {
        };
      });
    }
    async recordDeletedObjects(projectId, nodes, connections, images = [], deletedAt = Date.now()) {
      if (!nodes.length && !connections.length && !images.length) return Promise.resolve();
      const entries = [
        ...nodes.map((node) => ({ nodeIds: [node.id], keys: [...collectDeletedMedia([node]).keys()] })),
        ...connections.map((link) => ({ connectionIds: [link.id], keys: [] })),
        ...images.map((item) => ({ images: [{ nodeId: item.nodeId, imageId: item.image.id }], keys: [...collectDeletedMedia([{ metadata: { images: [item.image] } }]).keys()] }))
      ];
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("cleanup_candidates", "readwrite");
        for (const entry of entries) {
          const record = { nodeIds: [], connectionIds: [], images: [], ...entry, source: "user-delete", projectId, deletedAt, cleanupAfter: deletedAt + DELETION_GRACE_MS };
          transaction.objectStore("cleanup_candidates").put(record, `user-delete:${projectId}/${deletionObjectIds(record)[0]}`);
        }
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error("\u5220\u9664\u7F13\u5B58\u8BB0\u5F55\u5199\u5165\u4E2D\u65AD\u3002"));
        transaction.onerror = () => {
        };
      });
    }
    async recordDeletedProjects(projects, deletedAt = Date.now()) {
      if (!projects.length) return;
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const transaction = db.transaction("deleted", "readwrite");
        for (const project of projects) {
          const store = transaction.objectStore("deleted");
          const request = store.get(project.id);
          request.onsuccess = () => {
            const previous = request.result;
            if (Date.parse(previous?.at) > deletedAt) return;
            store.put({ id: project.id, at: new Date(deletedAt).toISOString(), source: "user-delete-project", keys: [...projectMediaKeys(project)] }, project.id);
          };
        }
        transaction.oncomplete = resolve;
        transaction.onabort = () => reject(transaction.error || Error("\u753B\u5E03\u5220\u9664\u8BB0\u5F55\u5199\u5165\u4E2D\u65AD\u3002"));
        transaction.onerror = () => {
        };
      });
    }
    async cancelRestoredDeletedObjects(projectId, restored, observedAt) {
      if (!restored.size) return 0;
      const db = await this.open();
      return new Promise((resolve, reject) => {
        let cancelled = 0;
        const transaction = db.transaction("cleanup_candidates", "readwrite");
        const request = transaction.objectStore("cleanup_candidates").openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          const record = cursor.value;
          if (record.source === "user-delete" && record.projectId === projectId && !record.cancelled && (record.deletedAt || 0) <= observedAt && deletionObjectIds(record).some((id) => restored.has(id))) {
            const objectIds = deletionObjectIds(record);
            const cancelledObjects = new Set(record.cancelledObjects || []);
            for (const id of objectIds) if (restored.has(id)) cancelledObjects.add(id);
            cursor.update({ ...record, cancelled: objectIds.every((id) => cancelledObjects.has(id)), cancelledObjects: [...cancelledObjects], cancelledAt: observedAt });
            cancelled += 1;
          }
          cursor.continue();
        };
        transaction.oncomplete = () => resolve(cancelled);
        transaction.onabort = () => reject(transaction.error || Error("\u64A4\u9500\u5220\u9664\u8BB0\u5F55\u66F4\u65B0\u4E2D\u65AD\u3002"));
        transaction.onerror = () => {
        };
      });
    }
    recordGeneratedMedia(owner, key) {
      return this.put("cleanup_candidates", `generated-media:${owner.projectId}/${key}`, {
        ...owner,
        key,
        source: "generated-media"
      });
    }
    async recordRedoneDeletedObjects(projectId, objects, deletedAt) {
      const records = await this.all("cleanup_candidates");
      const authorized = new Set(records.filter((record) => record.projectId === projectId && record.source === "user-delete").flatMap(deletionObjectIds));
      const nodes = objects.nodes.filter((node) => authorized.has(JSON.stringify(["node", node.id])));
      const connections = objects.connections.filter((link) => authorized.has(JSON.stringify(["connection", link.id])));
      const images = objects.images.filter((item) => authorized.has(JSON.stringify(["image", item.nodeId, item.image.id])));
      if (!nodes.length && !connections.length && !images.length) return 0;
      await this.recordDeletedObjects(projectId, nodes, connections, images, deletedAt);
      return nodes.length + connections.length + images.length;
    }
    async deletedObjects(projectId, liveProjects = [], nativeTombstones = []) {
      const [all, projects, tombstones] = await Promise.all([this.all("cleanup_candidates"), this.all("projects"), this.all("deleted")]);
      const window2 = deletionWindow(all, projectId);
      const projectWindow = projectDeletionWindow({ nativeTombstones, tombstones, projects, liveProjects, records: all });
      const nextAt = [window2.waiting.nextAt, projectWindow.waiting.nextAt].filter(Number.isFinite);
      const records = window2.ready;
      const mediaKeys = [...recordedDeletionKeys(all, projectId)];
      return {
        nodeIds: [...new Set(records.flatMap((record) => record.nodeIds))],
        connectionIds: [...new Set(records.flatMap((record) => record.connectionIds))],
        images: records.flatMap((record) => record.images || []),
        mediaKeys,
        projectDeletions: projectWindow.ready,
        revision: JSON.stringify([records.map((record) => [deletionObjectIds(record), record.deletedAt, record.cleanupAfter]), mediaKeys, projectWindow.ready]),
        waiting: {
          total: window2.waiting.total + projectWindow.waiting.total,
          objects: window2.waiting.total,
          projects: projectWindow.waiting.total,
          nextAt: nextAt.length ? Math.min(...nextAt) : null
        }
      };
    }
    async protect(projects, files = /* @__PURE__ */ new Map(), owners = []) {
      const db = await this.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(owners.length ? ["projects", "media", "cleanup_candidates"] : ["projects", "media"], "readwrite");
        tx.oncomplete = resolve;
        tx.onabort = () => reject(tx.error || Error("\u672C\u5730\u4FDD\u62A4\u5199\u5165\u5DF2\u4E2D\u65AD"));
        tx.onerror = () => {
        };
        try {
          for (const project of projects) tx.objectStore("projects").put(project, project.id);
          for (const [key, blob] of files) tx.objectStore("media").put(blob, key);
          for (const owner of owners) tx.objectStore("cleanup_candidates").put({ ...owner, source: "node-media" }, `node-media:${JSON.stringify([owner.projectId, owner.nodeId, owner.imageId || null, owner.key])}`);
        } catch (error) {
          tx.abort();
          reject(error);
        }
      });
    }
  };

  // node_modules/fflate/esm/browser.js
  var u8 = Uint8Array;
  var u16 = Uint16Array;
  var i32 = Int32Array;
  var fleb = new u8([
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    1,
    1,
    2,
    2,
    2,
    2,
    3,
    3,
    3,
    3,
    4,
    4,
    4,
    4,
    5,
    5,
    5,
    5,
    0,
    /* unused */
    0,
    0,
    /* impossible */
    0
  ]);
  var fdeb = new u8([
    0,
    0,
    0,
    0,
    1,
    1,
    2,
    2,
    3,
    3,
    4,
    4,
    5,
    5,
    6,
    6,
    7,
    7,
    8,
    8,
    9,
    9,
    10,
    10,
    11,
    11,
    12,
    12,
    13,
    13,
    /* unused */
    0,
    0
  ]);
  var clim = new u8([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]);
  var freb = function(eb, start2) {
    var b = new u16(31);
    for (var i = 0; i < 31; ++i) {
      b[i] = start2 += 1 << eb[i - 1];
    }
    var r = new i32(b[30]);
    for (var i = 1; i < 30; ++i) {
      for (var j = b[i]; j < b[i + 1]; ++j) {
        r[j] = j - b[i] << 5 | i;
      }
    }
    return { b, r };
  };
  var _a = freb(fleb, 2);
  var fl = _a.b;
  var revfl = _a.r;
  fl[28] = 258, revfl[258] = 28;
  var _b = freb(fdeb, 0);
  var fd = _b.b;
  var revfd = _b.r;
  var rev = new u16(32768);
  for (i = 0; i < 32768; ++i) {
    x = (i & 43690) >> 1 | (i & 21845) << 1;
    x = (x & 52428) >> 2 | (x & 13107) << 2;
    x = (x & 61680) >> 4 | (x & 3855) << 4;
    rev[i] = ((x & 65280) >> 8 | (x & 255) << 8) >> 1;
  }
  var x;
  var i;
  var hMap = (function(cd, mb, r) {
    var s = cd.length;
    var i = 0;
    var l = new u16(mb);
    for (; i < s; ++i) {
      if (cd[i])
        ++l[cd[i] - 1];
    }
    var le = new u16(mb);
    for (i = 1; i < mb; ++i) {
      le[i] = le[i - 1] + l[i - 1] << 1;
    }
    var co;
    if (r) {
      co = new u16(1 << mb);
      var rvb = 15 - mb;
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          var sv = i << 4 | cd[i];
          var r_1 = mb - cd[i];
          var v = le[cd[i] - 1]++ << r_1;
          for (var m = v | (1 << r_1) - 1; v <= m; ++v) {
            co[rev[v] >> rvb] = sv;
          }
        }
      }
    } else {
      co = new u16(s);
      for (i = 0; i < s; ++i) {
        if (cd[i]) {
          co[i] = rev[le[cd[i] - 1]++] >> 15 - cd[i];
        }
      }
    }
    return co;
  });
  var flt = new u8(288);
  for (i = 0; i < 144; ++i)
    flt[i] = 8;
  var i;
  for (i = 144; i < 256; ++i)
    flt[i] = 9;
  var i;
  for (i = 256; i < 280; ++i)
    flt[i] = 7;
  var i;
  for (i = 280; i < 288; ++i)
    flt[i] = 8;
  var i;
  var fdt = new u8(32);
  for (i = 0; i < 32; ++i)
    fdt[i] = 5;
  var i;
  var flm = /* @__PURE__ */ hMap(flt, 9, 0);
  var flrm = /* @__PURE__ */ hMap(flt, 9, 1);
  var fdm = /* @__PURE__ */ hMap(fdt, 5, 0);
  var fdrm = /* @__PURE__ */ hMap(fdt, 5, 1);
  var max = function(a) {
    var m = a[0];
    for (var i = 1; i < a.length; ++i) {
      if (a[i] > m)
        m = a[i];
    }
    return m;
  };
  var bits = function(d, p, m) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8) >> (p & 7) & m;
  };
  var bits16 = function(d, p) {
    var o = p / 8 | 0;
    return (d[o] | d[o + 1] << 8 | d[o + 2] << 16) >> (p & 7);
  };
  var shft = function(p) {
    return (p + 7) / 8 | 0;
  };
  var slc = function(v, s, e) {
    if (s == null || s < 0)
      s = 0;
    if (e == null || e > v.length)
      e = v.length;
    return new u8(v.subarray(s, e));
  };
  var ec = [
    "unexpected EOF",
    "invalid block type",
    "invalid length/literal",
    "invalid distance",
    "stream finished",
    "no stream handler",
    ,
    // determined by compression function
    "no callback",
    "invalid UTF-8 data",
    "extra field too long",
    "date not in range 1980-2099",
    "filename too long",
    "stream finishing",
    "invalid zip data"
    // determined by unknown compression method
  ];
  var err = function(ind, msg, nt) {
    var e = new Error(msg || ec[ind]);
    e.code = ind;
    if (Error.captureStackTrace)
      Error.captureStackTrace(e, err);
    if (!nt)
      throw e;
    return e;
  };
  var inflt = function(dat, st, buf, dict) {
    var sl = dat.length, dl = dict ? dict.length : 0;
    if (!sl || st.f && !st.l)
      return buf || new u8(0);
    var noBuf = !buf;
    var resize = noBuf || st.i != 2;
    var noSt = st.i;
    if (noBuf)
      buf = new u8(sl * 3);
    var cbuf = function(l2) {
      var bl = buf.length;
      if (l2 > bl) {
        var nbuf = new u8(Math.max(bl * 2, l2));
        nbuf.set(buf);
        buf = nbuf;
      }
    };
    var final = st.f || 0, pos = st.p || 0, bt = st.b || 0, lm = st.l, dm = st.d, lbt = st.m, dbt = st.n;
    var tbts = sl * 8;
    do {
      if (!lm) {
        final = bits(dat, pos, 1);
        var type = bits(dat, pos + 1, 3);
        pos += 3;
        if (!type) {
          var s = shft(pos) + 4, l = dat[s - 4] | dat[s - 3] << 8, t = s + l;
          if (t > sl) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + l);
          buf.set(dat.subarray(s, t), bt);
          st.b = bt += l, st.p = pos = t * 8, st.f = final;
          continue;
        } else if (type == 1)
          lm = flrm, dm = fdrm, lbt = 9, dbt = 5;
        else if (type == 2) {
          var hLit = bits(dat, pos, 31) + 257, hcLen = bits(dat, pos + 10, 15) + 4;
          var tl = hLit + bits(dat, pos + 5, 31) + 1;
          pos += 14;
          var ldt = new u8(tl);
          var clt = new u8(19);
          for (var i = 0; i < hcLen; ++i) {
            clt[clim[i]] = bits(dat, pos + i * 3, 7);
          }
          pos += hcLen * 3;
          var clb = max(clt), clbmsk = (1 << clb) - 1;
          var clm = hMap(clt, clb, 1);
          for (var i = 0; i < tl; ) {
            var r = clm[bits(dat, pos, clbmsk)];
            pos += r & 15;
            var s = r >> 4;
            if (s < 16) {
              ldt[i++] = s;
            } else {
              var c = 0, n = 0;
              if (s == 16)
                n = 3 + bits(dat, pos, 3), pos += 2, c = ldt[i - 1];
              else if (s == 17)
                n = 3 + bits(dat, pos, 7), pos += 3;
              else if (s == 18)
                n = 11 + bits(dat, pos, 127), pos += 7;
              while (n--)
                ldt[i++] = c;
            }
          }
          var lt = ldt.subarray(0, hLit), dt = ldt.subarray(hLit);
          lbt = max(lt);
          dbt = max(dt);
          lm = hMap(lt, lbt, 1);
          dm = hMap(dt, dbt, 1);
        } else
          err(1);
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
      }
      if (resize)
        cbuf(bt + 131072);
      var lms = (1 << lbt) - 1, dms = (1 << dbt) - 1;
      var lpos = pos;
      for (; ; lpos = pos) {
        var c = lm[bits16(dat, pos) & lms], sym = c >> 4;
        pos += c & 15;
        if (pos > tbts) {
          if (noSt)
            err(0);
          break;
        }
        if (!c)
          err(2);
        if (sym < 256)
          buf[bt++] = sym;
        else if (sym == 256) {
          lpos = pos, lm = null;
          break;
        } else {
          var add = sym - 254;
          if (sym > 264) {
            var i = sym - 257, b = fleb[i];
            add = bits(dat, pos, (1 << b) - 1) + fl[i];
            pos += b;
          }
          var d = dm[bits16(dat, pos) & dms], dsym = d >> 4;
          if (!d)
            err(3);
          pos += d & 15;
          var dt = fd[dsym];
          if (dsym > 3) {
            var b = fdeb[dsym];
            dt += bits16(dat, pos) & (1 << b) - 1, pos += b;
          }
          if (pos > tbts) {
            if (noSt)
              err(0);
            break;
          }
          if (resize)
            cbuf(bt + 131072);
          var end = bt + add;
          if (bt < dt) {
            var shift = dl - dt, dend = Math.min(dt, end);
            if (shift + bt < 0)
              err(3);
            for (; bt < dend; ++bt)
              buf[bt] = dict[shift + bt];
          }
          for (; bt < end; ++bt)
            buf[bt] = buf[bt - dt];
        }
      }
      st.l = lm, st.p = lpos, st.b = bt, st.f = final;
      if (lm)
        final = 1, st.m = lbt, st.d = dm, st.n = dbt;
    } while (!final);
    return bt != buf.length && noBuf ? slc(buf, 0, bt) : buf.subarray(0, bt);
  };
  var wbits = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
  };
  var wbits16 = function(d, p, v) {
    v <<= p & 7;
    var o = p / 8 | 0;
    d[o] |= v;
    d[o + 1] |= v >> 8;
    d[o + 2] |= v >> 16;
  };
  var hTree = function(d, mb) {
    var t = [];
    for (var i = 0; i < d.length; ++i) {
      if (d[i])
        t.push({ s: i, f: d[i] });
    }
    var s = t.length;
    var t2 = t.slice();
    if (!s)
      return { t: et, l: 0 };
    if (s == 1) {
      var v = new u8(t[0].s + 1);
      v[t[0].s] = 1;
      return { t: v, l: 1 };
    }
    t.sort(function(a, b) {
      return a.f - b.f;
    });
    t.push({ s: -1, f: 25001 });
    var l = t[0], r = t[1], i0 = 0, i1 = 1, i2 = 2;
    t[0] = { s: -1, f: l.f + r.f, l, r };
    while (i1 != s - 1) {
      l = t[t[i0].f < t[i2].f ? i0++ : i2++];
      r = t[i0 != i1 && t[i0].f < t[i2].f ? i0++ : i2++];
      t[i1++] = { s: -1, f: l.f + r.f, l, r };
    }
    var maxSym = t2[0].s;
    for (var i = 1; i < s; ++i) {
      if (t2[i].s > maxSym)
        maxSym = t2[i].s;
    }
    var tr = new u16(maxSym + 1);
    var mbt = ln(t[i1 - 1], tr, 0);
    if (mbt > mb) {
      var i = 0, dt = 0;
      var lft = mbt - mb, cst = 1 << lft;
      t2.sort(function(a, b) {
        return tr[b.s] - tr[a.s] || a.f - b.f;
      });
      for (; i < s; ++i) {
        var i2_1 = t2[i].s;
        if (tr[i2_1] > mb) {
          dt += cst - (1 << mbt - tr[i2_1]);
          tr[i2_1] = mb;
        } else
          break;
      }
      dt >>= lft;
      while (dt > 0) {
        var i2_2 = t2[i].s;
        if (tr[i2_2] < mb)
          dt -= 1 << mb - tr[i2_2]++ - 1;
        else
          ++i;
      }
      for (; i >= 0 && dt; --i) {
        var i2_3 = t2[i].s;
        if (tr[i2_3] == mb) {
          --tr[i2_3];
          ++dt;
        }
      }
      mbt = mb;
    }
    return { t: new u8(tr), l: mbt };
  };
  var ln = function(n, l, d) {
    return n.s == -1 ? Math.max(ln(n.l, l, d + 1), ln(n.r, l, d + 1)) : l[n.s] = d;
  };
  var lc = function(c) {
    var s = c.length;
    while (s && !c[--s])
      ;
    var cl = new u16(++s);
    var cli = 0, cln = c[0], cls = 1;
    var w = function(v) {
      cl[cli++] = v;
    };
    for (var i = 1; i <= s; ++i) {
      if (c[i] == cln && i != s)
        ++cls;
      else {
        if (!cln && cls > 2) {
          for (; cls > 138; cls -= 138)
            w(32754);
          if (cls > 2) {
            w(cls > 10 ? cls - 11 << 5 | 28690 : cls - 3 << 5 | 12305);
            cls = 0;
          }
        } else if (cls > 3) {
          w(cln), --cls;
          for (; cls > 6; cls -= 6)
            w(8304);
          if (cls > 2)
            w(cls - 3 << 5 | 8208), cls = 0;
        }
        while (cls--)
          w(cln);
        cls = 1;
        cln = c[i];
      }
    }
    return { c: cl.subarray(0, cli), n: s };
  };
  var clen = function(cf, cl) {
    var l = 0;
    for (var i = 0; i < cl.length; ++i)
      l += cf[i] * cl[i];
    return l;
  };
  var wfblk = function(out, pos, dat) {
    var s = dat.length;
    var o = shft(pos + 2);
    out[o] = s & 255;
    out[o + 1] = s >> 8;
    out[o + 2] = out[o] ^ 255;
    out[o + 3] = out[o + 1] ^ 255;
    for (var i = 0; i < s; ++i)
      out[o + i + 4] = dat[i];
    return (o + 4 + s) * 8;
  };
  var wblk = function(dat, out, final, syms, lf, df, eb, li, bs, bl, p) {
    wbits(out, p++, final);
    ++lf[256];
    var _a2 = hTree(lf, 15), dlt = _a2.t, mlb = _a2.l;
    var _b2 = hTree(df, 15), ddt = _b2.t, mdb = _b2.l;
    var _c = lc(dlt), lclt = _c.c, nlc = _c.n;
    var _d = lc(ddt), lcdt = _d.c, ndc = _d.n;
    var lcfreq = new u16(19);
    for (var i = 0; i < lclt.length; ++i)
      ++lcfreq[lclt[i] & 31];
    for (var i = 0; i < lcdt.length; ++i)
      ++lcfreq[lcdt[i] & 31];
    var _e = hTree(lcfreq, 7), lct = _e.t, mlcb = _e.l;
    var nlcc = 19;
    for (; nlcc > 4 && !lct[clim[nlcc - 1]]; --nlcc)
      ;
    var flen = bl + 5 << 3;
    var ftlen = clen(lf, flt) + clen(df, fdt) + eb;
    var dtlen = clen(lf, dlt) + clen(df, ddt) + eb + 14 + 3 * nlcc + clen(lcfreq, lct) + 2 * lcfreq[16] + 3 * lcfreq[17] + 7 * lcfreq[18];
    if (bs >= 0 && flen <= ftlen && flen <= dtlen)
      return wfblk(out, p, dat.subarray(bs, bs + bl));
    var lm, ll, dm, dl;
    wbits(out, p, 1 + (dtlen < ftlen)), p += 2;
    if (dtlen < ftlen) {
      lm = hMap(dlt, mlb, 0), ll = dlt, dm = hMap(ddt, mdb, 0), dl = ddt;
      var llm = hMap(lct, mlcb, 0);
      wbits(out, p, nlc - 257);
      wbits(out, p + 5, ndc - 1);
      wbits(out, p + 10, nlcc - 4);
      p += 14;
      for (var i = 0; i < nlcc; ++i)
        wbits(out, p + 3 * i, lct[clim[i]]);
      p += 3 * nlcc;
      var lcts = [lclt, lcdt];
      for (var it = 0; it < 2; ++it) {
        var clct = lcts[it];
        for (var i = 0; i < clct.length; ++i) {
          var len = clct[i] & 31;
          wbits(out, p, llm[len]), p += lct[len];
          if (len > 15)
            wbits(out, p, clct[i] >> 5 & 127), p += clct[i] >> 12;
        }
      }
    } else {
      lm = flm, ll = flt, dm = fdm, dl = fdt;
    }
    for (var i = 0; i < li; ++i) {
      var sym = syms[i];
      if (sym > 255) {
        var len = sym >> 18 & 31;
        wbits16(out, p, lm[len + 257]), p += ll[len + 257];
        if (len > 7)
          wbits(out, p, sym >> 23 & 31), p += fleb[len];
        var dst = sym & 31;
        wbits16(out, p, dm[dst]), p += dl[dst];
        if (dst > 3)
          wbits16(out, p, sym >> 5 & 8191), p += fdeb[dst];
      } else {
        wbits16(out, p, lm[sym]), p += ll[sym];
      }
    }
    wbits16(out, p, lm[256]);
    return p + ll[256];
  };
  var deo = /* @__PURE__ */ new i32([65540, 131080, 131088, 131104, 262176, 1048704, 1048832, 2114560, 2117632]);
  var et = /* @__PURE__ */ new u8(0);
  var dflt = function(dat, lvl, plvl, pre, post, st) {
    var s = st.z || dat.length;
    var o = new u8(pre + s + 5 * (1 + Math.ceil(s / 7e3)) + post);
    var w = o.subarray(pre, o.length - post);
    var lst = st.l;
    var pos = (st.r || 0) & 7;
    if (lvl) {
      if (pos)
        w[0] = st.r >> 3;
      var opt = deo[lvl - 1];
      var n = opt >> 13, c = opt & 8191;
      var msk_1 = (1 << plvl) - 1;
      var prev = st.p || new u16(32768), head = st.h || new u16(msk_1 + 1);
      var bs1_1 = Math.ceil(plvl / 3), bs2_1 = 2 * bs1_1;
      var hsh = function(i2) {
        return (dat[i2] ^ dat[i2 + 1] << bs1_1 ^ dat[i2 + 2] << bs2_1) & msk_1;
      };
      var syms = new i32(25e3);
      var lf = new u16(288), df = new u16(32);
      var lc_1 = 0, eb = 0, i = st.i || 0, li = 0, wi = st.w || 0, bs = 0;
      for (; i + 2 < s; ++i) {
        var hv = hsh(i);
        var imod = i & 32767, pimod = head[hv];
        prev[imod] = pimod;
        head[hv] = imod;
        if (wi <= i) {
          var rem = s - i;
          if ((lc_1 > 7e3 || li > 24576) && (rem > 423 || !lst)) {
            pos = wblk(dat, w, 0, syms, lf, df, eb, li, bs, i - bs, pos);
            li = lc_1 = eb = 0, bs = i;
            for (var j = 0; j < 286; ++j)
              lf[j] = 0;
            for (var j = 0; j < 30; ++j)
              df[j] = 0;
          }
          var l = 2, d = 0, ch_1 = c, dif = imod - pimod & 32767;
          if (rem > 2 && hv == hsh(i - dif)) {
            var maxn = Math.min(n, rem) - 1;
            var maxd = Math.min(32767, i);
            var ml = Math.min(258, rem);
            while (dif <= maxd && --ch_1 && imod != pimod) {
              if (dat[i + l] == dat[i + l - dif]) {
                var nl = 0;
                for (; nl < ml && dat[i + nl] == dat[i + nl - dif]; ++nl)
                  ;
                if (nl > l) {
                  l = nl, d = dif;
                  if (nl > maxn)
                    break;
                  var mmd = Math.min(dif, nl - 2);
                  var md = 0;
                  for (var j = 0; j < mmd; ++j) {
                    var ti = i - dif + j & 32767;
                    var pti = prev[ti];
                    var cd = ti - pti & 32767;
                    if (cd > md)
                      md = cd, pimod = ti;
                  }
                }
              }
              imod = pimod, pimod = prev[imod];
              dif += imod - pimod & 32767;
            }
          }
          if (d) {
            syms[li++] = 268435456 | revfl[l] << 18 | revfd[d];
            var lin = revfl[l] & 31, din = revfd[d] & 31;
            eb += fleb[lin] + fdeb[din];
            ++lf[257 + lin];
            ++df[din];
            wi = i + l;
            ++lc_1;
          } else {
            syms[li++] = dat[i];
            ++lf[dat[i]];
          }
        }
      }
      for (i = Math.max(i, wi); i < s; ++i) {
        syms[li++] = dat[i];
        ++lf[dat[i]];
      }
      pos = wblk(dat, w, lst, syms, lf, df, eb, li, bs, i - bs, pos);
      if (!lst) {
        st.r = pos & 7 | w[pos / 8 | 0] << 3;
        pos -= 7;
        st.h = head, st.p = prev, st.i = i, st.w = wi;
      }
    } else {
      for (var i = st.w || 0; i < s + lst; i += 65535) {
        var e = i + 65535;
        if (e >= s) {
          w[pos / 8 | 0] = lst;
          e = s;
        }
        pos = wfblk(w, pos + 1, dat.subarray(i, e));
      }
      st.i = s;
    }
    return slc(o, 0, pre + shft(pos) + post);
  };
  var crct = /* @__PURE__ */ (function() {
    var t = new Int32Array(256);
    for (var i = 0; i < 256; ++i) {
      var c = i, k = 9;
      while (--k)
        c = (c & 1 && -306674912) ^ c >>> 1;
      t[i] = c;
    }
    return t;
  })();
  var crc = function() {
    var c = -1;
    return {
      p: function(d) {
        var cr = c;
        for (var i = 0; i < d.length; ++i)
          cr = crct[cr & 255 ^ d[i]] ^ cr >>> 8;
        c = cr;
      },
      d: function() {
        return ~c;
      }
    };
  };
  var dopt = function(dat, opt, pre, post, st) {
    if (!st) {
      st = { l: 1 };
      if (opt.dictionary) {
        var dict = opt.dictionary.subarray(-32768);
        var newDat = new u8(dict.length + dat.length);
        newDat.set(dict);
        newDat.set(dat, dict.length);
        dat = newDat;
        st.w = dict.length;
      }
    }
    return dflt(dat, opt.level == null ? 6 : opt.level, opt.mem == null ? st.l ? Math.ceil(Math.max(8, Math.min(13, Math.log(dat.length))) * 1.5) : 20 : 12 + opt.mem, pre, post, st);
  };
  var mrg = function(a, b) {
    var o = {};
    for (var k in a)
      o[k] = a[k];
    for (var k in b)
      o[k] = b[k];
    return o;
  };
  var wbytes = function(d, b, v) {
    for (; v; ++b)
      d[b] = v, v >>>= 8;
  };
  var Deflate = /* @__PURE__ */ (function() {
    function Deflate2(opts, cb) {
      if (typeof opts == "function")
        cb = opts, opts = {};
      this.ondata = cb;
      this.o = opts || {};
      this.s = { l: 0, i: 32768, w: 32768, z: 32768 };
      this.b = new u8(98304);
      if (this.o.dictionary) {
        var dict = this.o.dictionary.subarray(-32768);
        this.b.set(dict, 32768 - dict.length);
        this.s.i = 32768 - dict.length;
      }
    }
    Deflate2.prototype.p = function(c, f) {
      this.ondata(dopt(c, this.o, 0, 0, this.s), f);
    };
    Deflate2.prototype.push = function(chunk, final) {
      if (!this.ondata)
        err(5);
      if (this.s.l)
        err(4);
      var endLen = chunk.length + this.s.z;
      if (endLen > this.b.length) {
        if (endLen > 2 * this.b.length - 32768) {
          var newBuf = new u8(endLen & -32768);
          newBuf.set(this.b.subarray(0, this.s.z));
          this.b = newBuf;
        }
        var split = this.b.length - this.s.z;
        this.b.set(chunk.subarray(0, split), this.s.z);
        this.s.z = this.b.length;
        this.p(this.b, false);
        this.b.set(this.b.subarray(-32768));
        this.b.set(chunk.subarray(split), 32768);
        this.s.z = chunk.length - split + 32768;
        this.s.i = 32766, this.s.w = 32768;
      } else {
        this.b.set(chunk, this.s.z);
        this.s.z += chunk.length;
      }
      this.s.l = final & 1;
      if (this.s.z > this.s.w + 8191 || final) {
        this.p(this.b, final || false);
        this.s.w = this.s.i, this.s.i -= 2;
      }
      if (final) {
        this.s = this.o = {};
        this.b = et;
      }
    };
    Deflate2.prototype.flush = function(sync) {
      if (!this.ondata)
        err(5);
      if (this.s.l)
        err(4);
      this.p(this.b, false);
      this.s.w = this.s.i, this.s.i -= 2;
      if (sync) {
        var c = new u8(6);
        c[0] = this.s.r >> 3;
        var ep = wfblk(c, this.s.r, et);
        this.s.r = 0;
        this.ondata(c.subarray(0, ep >> 3), false);
      }
    };
    return Deflate2;
  })();
  var Inflate = /* @__PURE__ */ (function() {
    function Inflate2(opts, cb) {
      if (typeof opts == "function")
        cb = opts, opts = {};
      this.ondata = cb;
      var dict = opts && opts.dictionary && opts.dictionary.subarray(-32768);
      this.s = { i: 0, b: dict ? dict.length : 0 };
      this.o = new u8(32768);
      this.p = new u8(0);
      if (dict)
        this.o.set(dict);
    }
    Inflate2.prototype.e = function(c) {
      if (!this.ondata)
        err(5);
      if (this.d)
        err(4);
      if (!this.p.length)
        this.p = c;
      else if (c.length) {
        var n = new u8(this.p.length + c.length);
        n.set(this.p), n.set(c, this.p.length), this.p = n;
      }
    };
    Inflate2.prototype.c = function(final) {
      this.s.i = +(this.d = final || false);
      var bts = this.s.b;
      var dt = inflt(this.p, this.s, this.o);
      this.ondata(slc(dt, bts, this.s.b), this.d);
      this.o = slc(dt, this.s.b - 32768), this.s.b = this.o.length;
      this.p = slc(this.p, this.s.p / 8 | 0), this.s.p &= 7;
    };
    Inflate2.prototype.push = function(chunk, final) {
      this.e(chunk), this.c(final);
    };
    return Inflate2;
  })();
  var te = typeof TextEncoder != "undefined" && /* @__PURE__ */ new TextEncoder();
  var td = typeof TextDecoder != "undefined" && /* @__PURE__ */ new TextDecoder();
  var tds = 0;
  try {
    td.decode(et, { stream: true });
    tds = 1;
  } catch (e) {
  }
  var dutf8 = function(d) {
    for (var r = "", i = 0; ; ) {
      var c = d[i++];
      var eb = (c > 127) + (c > 223) + (c > 239);
      if (i + eb > d.length)
        return { s: r, r: slc(d, i - 1) };
      if (!eb)
        r += String.fromCharCode(c);
      else if (eb == 3) {
        c = ((c & 15) << 18 | (d[i++] & 63) << 12 | (d[i++] & 63) << 6 | d[i++] & 63) - 65536, r += String.fromCharCode(55296 | c >> 10, 56320 | c & 1023);
      } else if (eb & 1)
        r += String.fromCharCode((c & 31) << 6 | d[i++] & 63);
      else
        r += String.fromCharCode((c & 15) << 12 | (d[i++] & 63) << 6 | d[i++] & 63);
    }
  };
  function strToU8(str, latin1) {
    if (latin1) {
      var ar_1 = new u8(str.length);
      for (var i = 0; i < str.length; ++i)
        ar_1[i] = str.charCodeAt(i);
      return ar_1;
    }
    if (te)
      return te.encode(str);
    var l = str.length;
    var ar = new u8(str.length + (str.length >> 1));
    var ai = 0;
    var w = function(v) {
      ar[ai++] = v;
    };
    for (var i = 0; i < l; ++i) {
      if (ai + 5 > ar.length) {
        var n = new u8(ai + 8 + (l - i << 1));
        n.set(ar);
        ar = n;
      }
      var c = str.charCodeAt(i);
      if (c < 128 || latin1)
        w(c);
      else if (c < 2048)
        w(192 | c >> 6), w(128 | c & 63);
      else if (c > 55295 && c < 57344)
        c = 65536 + (c & 1023 << 10) | str.charCodeAt(++i) & 1023, w(240 | c >> 18), w(128 | c >> 12 & 63), w(128 | c >> 6 & 63), w(128 | c & 63);
      else
        w(224 | c >> 12), w(128 | c >> 6 & 63), w(128 | c & 63);
    }
    return slc(ar, 0, ai);
  }
  function strFromU8(dat, latin1) {
    if (latin1) {
      var r = "";
      for (var i = 0; i < dat.length; i += 16384)
        r += String.fromCharCode.apply(null, dat.subarray(i, i + 16384));
      return r;
    } else if (td) {
      return td.decode(dat);
    } else {
      var _a2 = dutf8(dat), s = _a2.s, r = _a2.r;
      if (r.length)
        err(8);
      return s;
    }
  }
  var dbf = function(l) {
    return l == 1 ? 3 : l < 6 ? 2 : l == 9 ? 1 : 0;
  };
  var exfl = function(ex) {
    var le = 0;
    if (ex) {
      for (var k in ex) {
        var l = ex[k].length;
        if (l > 65535)
          err(9);
        le += l + 4;
      }
    }
    return le;
  };
  var wzh = function(d, b, f, fn, u, c, ce, co) {
    var fl2 = fn.length, ex = f.extra, col = co && co.length;
    var exl = exfl(ex);
    wbytes(d, b, ce != null ? 33639248 : 67324752), b += 4;
    if (ce != null)
      d[b++] = 20, d[b++] = f.os;
    d[b] = 20, b += 2;
    d[b++] = f.flag << 1 | (c < 0 && 8), d[b++] = u && 8;
    d[b++] = f.compression & 255, d[b++] = f.compression >> 8;
    var dt = new Date(f.mtime == null ? Date.now() : f.mtime), y = dt.getFullYear() - 1980;
    if (y < 0 || y > 119)
      err(10);
    wbytes(d, b, y << 25 | dt.getMonth() + 1 << 21 | dt.getDate() << 16 | dt.getHours() << 11 | dt.getMinutes() << 5 | dt.getSeconds() >> 1), b += 4;
    if (c != -1) {
      wbytes(d, b, f.crc);
      wbytes(d, b + 4, c < 0 ? -c - 2 : c);
      wbytes(d, b + 8, f.size);
    }
    wbytes(d, b + 12, fl2);
    wbytes(d, b + 14, exl), b += 16;
    if (ce != null) {
      wbytes(d, b, col);
      wbytes(d, b + 6, f.attrs);
      wbytes(d, b + 10, ce), b += 14;
    }
    d.set(fn, b);
    b += fl2;
    if (exl) {
      for (var k in ex) {
        var exf = ex[k], l = exf.length;
        wbytes(d, b, +k);
        wbytes(d, b + 2, l);
        d.set(exf, b + 4), b += 4 + l;
      }
    }
    if (col)
      d.set(co, b), b += col;
    return b;
  };
  var wzf = function(o, b, c, d, e) {
    wbytes(o, b, 101010256);
    wbytes(o, b + 8, c);
    wbytes(o, b + 10, c);
    wbytes(o, b + 12, d);
    wbytes(o, b + 16, e);
  };
  var ZipPassThrough = /* @__PURE__ */ (function() {
    function ZipPassThrough2(filename) {
      this.filename = filename;
      this.c = crc();
      this.size = 0;
      this.compression = 0;
    }
    ZipPassThrough2.prototype.process = function(chunk, final) {
      this.ondata(null, chunk, final);
    };
    ZipPassThrough2.prototype.push = function(chunk, final) {
      if (!this.ondata)
        err(5);
      this.c.p(chunk);
      this.size += chunk.length;
      if (final)
        this.crc = this.c.d();
      this.process(chunk, final || false);
    };
    return ZipPassThrough2;
  })();
  var ZipDeflate = /* @__PURE__ */ (function() {
    function ZipDeflate2(filename, opts) {
      var _this = this;
      if (!opts)
        opts = {};
      ZipPassThrough.call(this, filename);
      this.d = new Deflate(opts, function(dat, final) {
        _this.ondata(null, dat, final);
      });
      this.compression = 8;
      this.flag = dbf(opts.level);
    }
    ZipDeflate2.prototype.process = function(chunk, final) {
      try {
        this.d.push(chunk, final);
      } catch (e) {
        this.ondata(e, null, final);
      }
    };
    ZipDeflate2.prototype.push = function(chunk, final) {
      ZipPassThrough.prototype.push.call(this, chunk, final);
    };
    return ZipDeflate2;
  })();
  var Zip = /* @__PURE__ */ (function() {
    function Zip2(cb) {
      this.ondata = cb;
      this.u = [];
      this.d = 1;
    }
    Zip2.prototype.add = function(file) {
      var _this = this;
      if (!this.ondata)
        err(5);
      if (this.d & 2)
        this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, false);
      else {
        var f = strToU8(file.filename), fl_1 = f.length;
        var com = file.comment, o = com && strToU8(com);
        var u = fl_1 != file.filename.length || o && com.length != o.length;
        var hl_1 = fl_1 + exfl(file.extra) + 30;
        if (fl_1 > 65535)
          this.ondata(err(11, 0, 1), null, false);
        var header = new u8(hl_1);
        wzh(header, 0, file, f, u, -1);
        var chks_1 = [header];
        var pAll_1 = function() {
          for (var _i = 0, chks_2 = chks_1; _i < chks_2.length; _i++) {
            var chk = chks_2[_i];
            _this.ondata(null, chk, false);
          }
          chks_1 = [];
        };
        var tr_1 = this.d;
        this.d = 0;
        var ind_1 = this.u.length;
        var uf_1 = mrg(file, {
          f,
          u,
          o,
          t: function() {
            if (file.terminate)
              file.terminate();
          },
          r: function() {
            pAll_1();
            if (tr_1) {
              var nxt = _this.u[ind_1 + 1];
              if (nxt)
                nxt.r();
              else
                _this.d = 1;
            }
            tr_1 = 1;
          }
        });
        var cl_1 = 0;
        file.ondata = function(err2, dat, final) {
          if (err2) {
            _this.ondata(err2, dat, final);
            _this.terminate();
          } else {
            cl_1 += dat.length;
            chks_1.push(dat);
            if (final) {
              var dd = new u8(16);
              wbytes(dd, 0, 134695760);
              wbytes(dd, 4, file.crc);
              wbytes(dd, 8, cl_1);
              wbytes(dd, 12, file.size);
              chks_1.push(dd);
              uf_1.c = cl_1, uf_1.b = hl_1 + cl_1 + 16, uf_1.crc = file.crc, uf_1.size = file.size;
              if (tr_1)
                uf_1.r();
              tr_1 = 1;
            } else if (tr_1)
              pAll_1();
          }
        };
        this.u.push(uf_1);
      }
    };
    Zip2.prototype.end = function() {
      var _this = this;
      if (this.d & 2) {
        this.ondata(err(4 + (this.d & 1) * 8, 0, 1), null, true);
        return;
      }
      if (this.d)
        this.e();
      else
        this.u.push({
          r: function() {
            if (!(_this.d & 1))
              return;
            _this.u.splice(-1, 1);
            _this.e();
          },
          t: function() {
          }
        });
      this.d = 3;
    };
    Zip2.prototype.e = function() {
      var bt = 0, l = 0, tl = 0;
      for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
        var f = _a2[_i];
        tl += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0);
      }
      var out = new u8(tl + 22);
      for (var _b2 = 0, _c = this.u; _b2 < _c.length; _b2++) {
        var f = _c[_b2];
        wzh(out, bt, f, f.f, f.u, -f.c - 2, l, f.o);
        bt += 46 + f.f.length + exfl(f.extra) + (f.o ? f.o.length : 0), l += f.b;
      }
      wzf(out, bt, this.u.length, tl, l);
      this.ondata(null, out, true);
      this.d = 2;
    };
    Zip2.prototype.terminate = function() {
      for (var _i = 0, _a2 = this.u; _i < _a2.length; _i++) {
        var f = _a2[_i];
        f.t();
      }
      this.d = 2;
    };
    return Zip2;
  })();

  // src/zip.mjs
  var CHUNK_BYTES = 256 * 1024;
  var ZIP32_MAX = 4294967295;
  var pause = () => new Promise((resolve) => setTimeout(resolve, 0));
  async function makeZip(prepared, { onProgress = () => {
  }, filesOnly = false } = {}) {
    const parts = [];
    let error, written = 0;
    let chunks = [], chunkBytes = 0;
    const offsets = [];
    const flush = () => {
      if (chunks.length) parts.push(new Blob(chunks));
      chunks = [];
      chunkBytes = 0;
    };
    const append = (chunk) => {
      chunks.push(chunk);
      chunkBytes += chunk.length;
      if (chunkBytes >= 4 * 1024 * 1024) flush();
    };
    const total = prepared.data.projects.reduce((sum, project) => sum + project.files.length, 0);
    if (prepared.data.projects.some((project) => project.files.some((file) => file.bytes >= ZIP32_MAX))) throw Error("\u5355\u4E2A\u5A92\u4F53\u6587\u4EF6\u8D85\u51FA\u5F53\u524D ZIP \u5355\u6587\u4EF6\u5199\u5165\u8303\u56F4\u3002");
    let completed = 0, yieldedAt = performance.now();
    const done = new Promise((resolve, reject) => {
      const zip = new Zip((err2, chunk, final) => {
        if (err2) {
          error = err2;
          reject(err2);
          return;
        }
        if (final && (written >= ZIP32_MAX || offsets.length >= 65535)) chunk = zip64CentralDirectory(chunk, offsets, written);
        written += chunk.length;
        append(chunk);
        if (final) {
          flush();
          resolve();
        }
      });
      (async () => {
        if (!filesOnly) {
          const json = strToU8(JSON.stringify(prepared.data, null, 2));
          const manifest = { app: "canvas-save-guard", version: 1, projectsJsonSha256: await sha256(json), files: prepared.data.projects.flatMap((p) => p.files) };
          for (const [name, bytes] of [["projects.json", json], ["guard-manifest.json", strToU8(JSON.stringify(manifest, null, 2))]]) {
            const entry = new ZipDeflate(name, { level: 6 });
            offsets.push(written);
            zip.add(entry);
            for (let offset = 0; offset < bytes.length; offset += CHUNK_BYTES) {
              entry.push(bytes.subarray(offset, offset + CHUNK_BYTES), offset + CHUNK_BYTES >= bytes.length);
              if (performance.now() - yieldedAt > 12) {
                await pause();
                yieldedAt = performance.now();
              }
            }
          }
        }
        for (const p of prepared.data.projects) for (const file of p.files) {
          const entry = new ZipPassThrough(file.path);
          offsets.push(written);
          zip.add(entry);
          const reader = prepared.media.get(file.storageKey).stream().getReader();
          try {
            while (true) {
              const next = await reader.read();
              if (next.done) break;
              entry.push(next.value, false);
              if (error) throw error;
              if (performance.now() - yieldedAt > 12) {
                await pause();
                yieldedAt = performance.now();
              }
            }
          } finally {
            reader.releaseLock();
          }
          entry.push(new Uint8Array(), true);
          onProgress(++completed, total);
        }
        zip.end();
      })().catch((reason) => {
        zip.terminate();
        reject(reason);
      });
    });
    await done;
    return new Blob(parts, { type: "application/zip" });
  }
  function zip64CentralDirectory(original, offsets, directoryOffset) {
    const view = new DataView(original.buffer, original.byteOffset, original.byteLength), parts = [];
    let cursor = 0, size2 = 0;
    for (const offset of offsets) {
      const nameLength = view.getUint16(cursor + 28, true), extraLength = view.getUint16(cursor + 30, true), commentLength = view.getUint16(cursor + 32, true);
      const length = 46 + nameLength + extraLength + commentLength;
      let record = original.slice(cursor, cursor + length);
      if (offset >= ZIP32_MAX) {
        const insert = 46 + nameLength + extraLength, next = new Uint8Array(length + 12);
        next.set(record.subarray(0, insert));
        next.set(record.subarray(insert), insert + 12);
        const fields2 = new DataView(next.buffer);
        fields2.setUint16(6, 45, true);
        fields2.setUint16(30, extraLength + 12, true);
        fields2.setUint32(42, ZIP32_MAX, true);
        fields2.setUint16(insert, 1, true);
        fields2.setUint16(insert + 2, 8, true);
        fields2.setBigUint64(insert + 4, BigInt(offset), true);
        record = next;
      }
      parts.push(record);
      size2 += record.length;
      cursor += length;
    }
    const footer = new Uint8Array(98), fields = new DataView(footer.buffer);
    fields.setUint32(0, 101075792, true);
    fields.setBigUint64(4, 44n, true);
    fields.setUint16(12, 45, true);
    fields.setUint16(14, 45, true);
    fields.setBigUint64(24, BigInt(offsets.length), true);
    fields.setBigUint64(32, BigInt(offsets.length), true);
    fields.setBigUint64(40, BigInt(size2), true);
    fields.setBigUint64(48, BigInt(directoryOffset), true);
    fields.setUint32(56, 117853008, true);
    fields.setBigUint64(64, BigInt(directoryOffset + size2), true);
    fields.setUint32(72, 1, true);
    fields.setUint32(76, 101010256, true);
    fields.setUint16(84, Math.min(offsets.length, 65535), true);
    fields.setUint16(86, Math.min(offsets.length, 65535), true);
    fields.setUint32(88, Math.min(size2, ZIP32_MAX), true);
    fields.setUint32(92, Math.min(directoryOffset, ZIP32_MAX), true);
    const output = new Uint8Array(size2 + footer.length);
    let position = 0;
    for (const part of parts) {
      output.set(part, position);
      position += part.length;
    }
    output.set(footer, position);
    return output;
  }
  function safeInteger(value) {
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < 0) throw Error("ZIP \u6587\u4EF6\u5927\u5C0F\u6216\u504F\u79FB\u65E0\u6548\u3002");
    return number;
  }
  function crc32(bytes) {
    const entry = new ZipPassThrough("");
    entry.ondata = () => {
    };
    entry.push(bytes, true);
    return entry.crc >>> 0;
  }
  async function zipDirectory(blob) {
    const tailStart = Math.max(0, blob.size - 65557);
    const bytes = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
    const tail = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let end = bytes.length - 22;
    while (end >= 0 && (tail.getUint32(end, true) !== 101010256 || end + 22 + tail.getUint16(end + 20, true) !== bytes.length)) end--;
    if (end < 0) throw Error("ZIP \u6587\u4EF6\u7ED3\u5C3E\u4E0D\u5B8C\u6574\u6216\u683C\u5F0F\u65E0\u6548\u3002");
    if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) throw Error("\u6682\u4E0D\u652F\u6301\u5206\u5377 ZIP\u3002");
    let count = tail.getUint16(end + 10, true), size2 = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
    const zip64 = end >= 20 && tail.getUint32(end - 20, true) === 117853008;
    if (zip64) {
      const position = safeInteger(tail.getBigUint64(end - 12, true));
      const record = new DataView(await blob.slice(position, position + 56).arrayBuffer());
      if (record.byteLength < 56 || record.getUint32(0, true) !== 101075792) throw Error("ZIP64 \u76EE\u5F55\u8BB0\u5F55\u65E0\u6548\u3002");
      count = safeInteger(record.getBigUint64(32, true));
      size2 = safeInteger(record.getBigUint64(40, true));
      offset = safeInteger(record.getBigUint64(48, true));
    }
    if (!zip64 && (size2 === ZIP32_MAX || offset === ZIP32_MAX)) throw Error("ZIP64 \u76EE\u5F55\u4F4D\u7F6E\u7F3A\u5931\u3002");
    if (offset + size2 > tailStart + end) throw Error("ZIP \u76EE\u5F55\u8D85\u51FA\u6587\u4EF6\u8303\u56F4\u3002");
    const directoryBytes = new Uint8Array(await blob.slice(offset, offset + size2).arrayBuffer());
    const directory = new DataView(directoryBytes.buffer, directoryBytes.byteOffset, directoryBytes.byteLength);
    const records = /* @__PURE__ */ new Map();
    let cursor = 0;
    for (let index = 0; index < count; index++) {
      if (cursor + 46 > size2 || directory.getUint32(cursor, true) !== 33639248) throw Error("ZIP \u6587\u4EF6\u76EE\u5F55\u4E0D\u5B8C\u6574\u3002");
      const flags = directory.getUint16(cursor + 8, true), compression = directory.getUint16(cursor + 10, true);
      const crc2 = directory.getUint32(cursor + 16, true);
      let compressed = directory.getUint32(cursor + 20, true), original = directory.getUint32(cursor + 24, true), local = directory.getUint32(cursor + 42, true);
      const nameLength = directory.getUint16(cursor + 28, true), extraLength = directory.getUint16(cursor + 30, true), commentLength = directory.getUint16(cursor + 32, true);
      const next = cursor + 46 + nameLength + extraLength + commentLength;
      if (next > size2) throw Error("ZIP \u6587\u4EF6\u76EE\u5F55\u5B57\u6BB5\u4E0D\u5B8C\u6574\u3002");
      const name = strFromU8(directoryBytes.subarray(cursor + 46, cursor + 46 + nameLength), !(flags & 2048));
      if (flags & 1) throw Error("\u8BF7\u5148\u89E3\u5BC6\u538B\u7F29\u5305\uFF0C\u518D\u5BFC\u5165\u753B\u5E03\u3002");
      if (compressed === ZIP32_MAX || original === ZIP32_MAX || local === ZIP32_MAX) {
        let extra = cursor + 46 + nameLength, found = false;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
          const type = directory.getUint16(extra, true), length = directory.getUint16(extra + 2, true);
          if (extra + 4 + length > extraEnd) throw Error("ZIP \u6269\u5C55\u5B57\u6BB5\u4E0D\u5B8C\u6574\u3002");
          if (type === 1) {
            let position = extra + 4;
            const read = () => {
              if (position + 8 > extra + 4 + length) throw Error("ZIP64 \u6587\u4EF6\u5B57\u6BB5\u7F3A\u5931\u3002");
              const value = safeInteger(directory.getBigUint64(position, true));
              position += 8;
              return value;
            };
            if (original === ZIP32_MAX) original = read();
            if (compressed === ZIP32_MAX) compressed = read();
            if (local === ZIP32_MAX) local = read();
            found = true;
            break;
          }
          extra += 4 + length;
        }
        if (!found) throw Error("ZIP64 \u6587\u4EF6\u5B57\u6BB5\u7F3A\u5931\u3002");
      }
      records.set(name, { name, compression, crc: crc2, compressed, original, local });
      cursor = next;
    }
    return records;
  }
  async function zipEntry(blob, record) {
    if (!record) throw Error("\u538B\u7F29\u5305\u4E2D\u7F3A\u5C11\u6307\u5B9A\u6587\u4EF6\u3002");
    const header = new DataView(await blob.slice(record.local, record.local + 30).arrayBuffer());
    if (header.byteLength < 30 || header.getUint32(0, true) !== 67324752) throw Error(`\u6587\u4EF6\u5934\u635F\u574F\uFF1A${record.name}`);
    const start2 = record.local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
    if (start2 + record.compressed > blob.size) throw Error(`\u6587\u4EF6\u5185\u5BB9\u4E0D\u5B8C\u6574\uFF1A${record.name}`);
    const packed = blob.slice(start2, start2 + record.compressed);
    if (record.compression === 0) return packed;
    if (record.compression !== 8) throw Error(`\u4E0D\u652F\u6301\u7684 ZIP \u538B\u7F29\u65B9\u5F0F\uFF1A${record.compression}`);
    const parts = [];
    const inflate = new Inflate((bytes) => parts.push(bytes));
    let yieldedAt = performance.now();
    for (let offset = 0; offset < packed.size; offset += CHUNK_BYTES) {
      inflate.push(new Uint8Array(await packed.slice(offset, offset + CHUNK_BYTES).arrayBuffer()), offset + CHUNK_BYTES >= packed.size);
      if (performance.now() - yieldedAt > 12) {
        await pause();
        yieldedAt = performance.now();
      }
    }
    return new Blob(parts);
  }
  async function verifyZip(blob, { retainEntries = true, onProgress = () => {
  } } = {}) {
    const records = await zipDirectory(blob), entries = {};
    if (!records.has("projects.json")) throw Error("\u538B\u7F29\u5305\u91CC\u6CA1\u6709 projects.json\u3002");
    const projectBytes = new Uint8Array(await (await zipEntry(blob, records.get("projects.json"))).arrayBuffer());
    const data = JSON.parse(new TextDecoder().decode(projectBytes));
    if (data.app !== "infinite-canvas" || data.version !== 3 || !Array.isArray(data.projects) || !data.projects.length) throw Error("\u8FD9\u4E0D\u662F\u652F\u6301\u7684\u753B\u5E03\u538B\u7F29\u5305\u3002");
    const errors = [];
    let fileCount = 0;
    const manifestBytes = records.has("guard-manifest.json") ? new Uint8Array(await (await zipEntry(blob, records.get("guard-manifest.json"))).arrayBuffer()) : null;
    const guard = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) : null;
    if (crc32(projectBytes) !== records.get("projects.json").crc) errors.push("\u753B\u5E03\u8BF4\u660E\u6587\u4EF6\u7684 ZIP \u6821\u9A8C\u503C\u4E0D\u4E00\u81F4\u3002");
    if (manifestBytes && crc32(manifestBytes) !== records.get("guard-manifest.json").crc) errors.push("\u6587\u4EF6\u6E05\u5355\u7684 ZIP \u6821\u9A8C\u503C\u4E0D\u4E00\u81F4\u3002");
    if (retainEntries) {
      entries["projects.json"] = projectBytes;
      if (manifestBytes) entries["guard-manifest.json"] = manifestBytes;
    }
    if (guard && await sha256(projectBytes) !== guard.projectsJsonSha256) errors.push("\u753B\u5E03\u8BF4\u660E\u6587\u4EF6\u7684\u6821\u9A8C\u503C\u4E0D\u4E00\u81F4\u3002");
    const manifestFiles = new Map((guard?.files || []).map((file) => [file.path, file]));
    const inspected = /* @__PURE__ */ new Map();
    const total = data.projects.reduce((sum, project) => sum + (project.files?.length || 0), 0);
    let yieldedAt = performance.now();
    for (const p of data.projects) {
      let checkUrls = function(value, parentKey, nodeType) {
        if (Array.isArray(value)) return value.forEach((v) => checkUrls(v, parentKey, nodeType));
        if (!value || typeof value !== "object") {
          if (typeof value === "string" && value.startsWith("blob:") && !parentKey) errors.push(`\u201C${p.project.title}\u201D\u5305\u542B\u672A\u6253\u5305\u7684\u4E34\u65F6\u56FE\u7247\u5730\u5740\u3002`);
          return;
        }
        if (["image", "video", "audio", "text", "config"].includes(value.type || value.kind)) nodeType = value.type || value.kind;
        const ownKey = listed.has(value.storageKey) ? value.storageKey : void 0;
        for (const [key, item] of Object.entries(value)) if (!isMediaTextField(key, item, nodeType)) checkUrls(item, ["content", "url", "dataUrl"].includes(key) ? ownKey : void 0, nodeType);
      };
      if (!p.project || !Array.isArray(p.project.nodes) || !Array.isArray(p.files)) throw Error("\u753B\u5E03\u7ED3\u6784\u4E0D\u5B8C\u6574\u3002");
      const listed = new Map(p.files.map((f) => [f.storageKey, f]));
      for (const key of collectMedia(p.project).keys()) if (!listed.has(key)) errors.push(`\u672A\u6253\u5305\uFF1A${key}`);
      checkUrls(p.project);
      for (const f of p.files) {
        const record = records.get(f.path);
        if (!record) {
          errors.push(`\u7F3A\u6587\u4EF6\uFF1A${f.path}`);
          continue;
        }
        let actual = inspected.get(f.path);
        if (!actual) {
          const bytes = new Uint8Array(await (await zipEntry(blob, record)).arrayBuffer());
          actual = { bytes: bytes.byteLength, sha256: await sha256(bytes), crc: crc32(bytes) };
          inspected.set(f.path, actual);
          if (retainEntries) entries[f.path] = bytes;
        }
        if (actual.bytes !== f.bytes || actual.bytes !== record.original) errors.push(`\u6587\u4EF6\u5927\u5C0F\u4E0D\u7B26\uFF1A${f.path}`);
        const expected = f.sha256 || manifestFiles.get(f.path)?.sha256;
        if (expected && actual.sha256 !== expected || actual.crc !== record.crc) errors.push(`\u6587\u4EF6\u635F\u574F\uFF1A${f.path}`);
        fileCount++;
        onProgress(fileCount, total);
        if (performance.now() - yieldedAt > 12) {
          await pause();
          yieldedAt = performance.now();
        }
      }
    }
    if (errors.length) {
      const error = Error(`\u538B\u7F29\u5305\u6821\u9A8C\u5931\u8D25\uFF1A${errors.length} \u9879\u95EE\u9898\u3002`);
      error.details = errors;
      throw error;
    }
    if (retainEntries) {
      for (const [name, record] of records) if (!Object.hasOwn(entries, name)) entries[name] = new Uint8Array(await (await zipEntry(blob, record)).arrayBuffer());
    }
    return {
      projects: data.projects.length,
      files: fileCount,
      hashed: !!guard,
      data,
      entries,
      readEntry: (name) => zipEntry(blob, records.get(name))
    };
  }

  // src/pointer-surfaces.mjs
  var POINTER_PATCH_VERSION = "1.0.1";
  function installPointerPassthrough(doc) {
    const id = "canvas-save-guard-pointer-style";
    const style = doc.getElementById(id) || doc.createElement("style");
    style.id = id;
    style.dataset.version = POINTER_PATCH_VERSION;
    style.textContent = `
    .ant-message, .ant-message * { pointer-events: none !important; }
    .ant-message :is(button, a, input, select, textarea, [role="button"], .ant-message-notice-close, .ant-message-close),
    .ant-message :is(button, a, input, select, textarea, [role="button"], .ant-message-notice-close, .ant-message-close) * {
      pointer-events: auto !important;
    }
  `;
    if (!style.isConnected) {
      const target = doc.head || doc.documentElement;
      if (target) target.append(style);
      else doc.addEventListener("DOMContentLoaded", () => installPointerPassthrough(doc), { once: true });
    }
    return style;
  }

  // src/media-locations.mjs
  function describeMediaReferences(project, key) {
    const found = [];
    function visit(value, path) {
      if (value === key) found.push(path);
      else if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${i + 1}]`));
      else if (value && typeof value === "object") for (const [name, item] of Object.entries(value)) visit(item, `${path}.${name}`);
    }
    for (const [i, node] of (project.nodes || []).entries()) {
      const label = `\u8282\u70B9 ${i + 1}${node.title ? `\u300C${node.title.slice(0, 24)}\u300D` : ""}\uFF08${node.id}\uFF09`;
      visit(node, label);
    }
    visit(project.chatSessions || [], "\u804A\u5929\u8BB0\u5F55");
    return found.map((path) => path.replace(".metadata.storageKey", " \u2192 \u56FE\u7247/\u5A92\u4F53\u672C\u4F53").replace(".metadata.references", " \u2192 \u751F\u6210\u53C2\u8003\u56FE").replace(".metadata.", " \u2192 "));
  }
  function missingMediaDetails(project, missing) {
    return missing.flatMap((item) => {
      const key = typeof item === "string" ? item : item.key;
      const refs = describeMediaReferences(project, key);
      return [`\u6587\u4EF6\uFF1A${key}${item.reason ? `\uFF08${item.reason}\uFF09` : ""}`, ...refs.length ? refs.map((ref) => `\u4ECD\u88AB\u5F15\u7528\uFF1A${ref}`) : ["\u5F53\u524D\u753B\u5E03\u672A\u627E\u5230\u8FD9\u4E2A\u5F15\u7528\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u3002"]];
    });
  }

  // src/status-upgrade.mjs
  var BUILD_VERSION = "1.0.43";
  function installLegacyRecheck(guard, doc) {
    if (guard.recheckCurrent || guard.statusPatchVersion === BUILD_VERSION) return;
    guard.statusPatchVersion = BUILD_VERSION;
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow) return;
    const buttons = shadow.querySelector(".buttons");
    if (!buttons) return;
    const button = doc.createElement("button");
    button.id = "recheck";
    button.textContent = "\u91CD\u65B0\u68C0\u67E5";
    buttons.prepend(button);
    button.onclick = async () => {
      button.disabled = true;
      try {
        const store = await new Promise((resolve, reject) => {
          if (globalThis.CanvasSaveGuardNative) return resolve(globalThis.CanvasSaveGuardNative.store);
          if (![...doc.scripts].some((s) => s.src.includes("/10u8p1p4fll6y.js"))) return reject(Error("\u7F51\u7AD9\u8D44\u6E90\u7248\u672C\u672A\u5339\u914D\uFF0C\u65E0\u6CD5\u91CD\u65B0\u68C0\u67E5\u3002"));
          const id2 = `canvas-guard-recheck-${crypto.randomUUID()}`;
          globalThis.TURBOPACK.push(["static/chunks/canvas-save-guard-recheck.js", id2, (context) => {
            try {
              resolve(context.i(83629).useCanvasStore);
            } catch (error) {
              reject(error);
            }
          }]);
          globalThis.TURBOPACK.push(["static/chunks/canvas-save-guard-recheck.js", { otherChunks: [], runtimeModuleIds: [id2] }]);
        });
        const id = decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
        const project = store.getState().projects.find((p) => p.id === id);
        if (!project) throw Error("\u8BF7\u5148\u6253\u5F00\u5177\u4F53\u753B\u5E03\u3002");
        store.getState().updateProject(id, { nodes: project.nodes });
        try {
          await guard.flush();
        } catch (error) {
          const detail = shadow.querySelector("#detail");
          const keys = (detail?.textContent || "").split("\n").map((s) => s.trim()).filter((s) => /^(image|video|audio|file|video-reference|audio-reference):/.test(s));
          if (detail && keys.length) {
            detail.textContent = missingMediaDetails(store.getState().projects.find((p) => p.id === id), keys).join("\n");
            detail.hidden = false;
          }
          throw error;
        }
      } catch (error) {
        const status = shadow.querySelector("#status");
        if (status) {
          status.textContent = error.message;
          status.className = "bad";
        }
      } finally {
        button.disabled = false;
      }
    };
    button.click();
  }

  // src/panel-shortcuts.mjs
  function installPanelShortcutBoundary(host, doc) {
    host.dataset.canvasShortcutsIgnore = "";
    if (host.dataset.guardShortcutBoundary) return;
    host.dataset.guardShortcutBoundary = "1";
    host.addEventListener("keydown", (event) => event.stopPropagation());
    const leavePanel = (event) => {
      if (doc.activeElement !== host || event.composedPath().includes(host)) return;
      host.shadowRoot?.activeElement?.blur();
      host.blur();
    };
    doc.addEventListener("pointerdown", leavePanel, true);
  }

  // src/retry-region.mjs
  function normalizeRetryRectangle(rectangle) {
    if (!rectangle) return null;
    const left = Math.min(rectangle.startWorldX, rectangle.currentWorldX);
    const right = Math.max(rectangle.startWorldX, rectangle.currentWorldX);
    const top = Math.min(rectangle.startWorldY, rectangle.currentWorldY);
    const bottom = Math.max(rectangle.startWorldY, rectangle.currentWorldY);
    return [left, right, top, bottom].every(Number.isFinite) && right > left && bottom > top ? { left, right, top, bottom } : null;
  }
  function installRetryRegion(doc) {
    const win = doc.defaultView;
    if (win.CanvasSaveGuardRetryRegion?.version === 1) return win.CanvasSaveGuardRetryRegion;
    const listeners = /* @__PURE__ */ new Set();
    let projectId = null, enabled = false, rectangle = null, candidate = null, drawing = false, revision = 0;
    let overlay = null, frame = null;
    const storageKey = (id) => `canvas-retry-region-v1:${id}`;
    const currentId = () => /^\/canvas\/[^/]+\/?$/.test(win.location.pathname) ? decodeURIComponent(win.location.pathname.split("/")[2]) : "";
    function publish(scopeChanged) {
      if (scopeChanged) revision++;
      for (const listener of listeners) listener({ scopeChanged });
      paint();
    }
    function syncProject() {
      const id = currentId();
      if (id === projectId) return;
      projectId = id;
      enabled = false;
      rectangle = null;
      candidate = null;
      drawing = false;
      try {
        const saved = JSON.parse(win.localStorage.getItem(storageKey(id)) || "{}");
        enabled = saved.enabled === true;
        rectangle = normalizeRetryRectangle(saved.rectangle && {
          startWorldX: saved.rectangle.left,
          currentWorldX: saved.rectangle.right,
          startWorldY: saved.rectangle.top,
          currentWorldY: saved.rectangle.bottom
        });
      } catch {
      }
      publish(true);
    }
    function persist() {
      if (!projectId) return;
      try {
        win.localStorage.setItem(storageKey(projectId), JSON.stringify({ enabled, rectangle }));
      } catch {
      }
    }
    function bridge() {
      const value = win.CanvasSaveGuardRetry;
      return value?.projectId === projectId && value.regionVersion === 1 ? value : null;
    }
    function snapshot() {
      syncProject();
      return { projectId, enabled, rectangle: rectangle && { ...rectangle }, drawing, revision, available: !!bridge() };
    }
    function paint(viewport) {
      if (!doc.body) return;
      const native = bridge();
      if (!enabled || drawing || !rectangle || !native) {
        if (overlay) overlay.hidden = true;
        return;
      }
      const canvas = native.getCanvasRect?.();
      const view = viewport || native.getViewport?.();
      if (!canvas || !view || ![canvas.left, canvas.top, canvas.width, canvas.height, view.x, view.y, view.k].every(Number.isFinite)) return;
      if (!overlay) {
        overlay = doc.createElement("div");
        overlay.id = "canvas-retry-region-outline";
        overlay.setAttribute("aria-hidden", "true");
        overlay.style.cssText = "position:fixed;pointer-events:none;overflow:hidden;z-index:70;";
        frame = doc.createElement("div");
        frame.style.cssText = "position:absolute;box-sizing:border-box;border:2px dashed #3b82f6;border-radius:3px;pointer-events:none;";
        const label = doc.createElement("span");
        label.textContent = "\u91CD\u8BD5\u533A\u57DF";
        label.style.cssText = "position:absolute;top:2px;left:3px;padding:1px 5px;border-radius:3px;background:#2563eb;color:#fff;font:11px/1.5 system-ui;white-space:nowrap;";
        frame.append(label);
        overlay.append(frame);
        doc.body.append(overlay);
      }
      overlay.hidden = false;
      Object.assign(overlay.style, { left: `${canvas.left}px`, top: `${canvas.top}px`, width: `${canvas.width}px`, height: `${canvas.height}px` });
      Object.assign(frame.style, {
        left: `${view.x + rectangle.left * view.k}px`,
        top: `${view.y + rectangle.top * view.k}px`,
        width: `${(rectangle.right - rectangle.left) * view.k}px`,
        height: `${(rectangle.bottom - rectangle.top) * view.k}px`
      });
    }
    const control = {
      version: 1,
      snapshot,
      paint,
      refresh() {
        syncProject();
        publish(false);
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      setEnabled(value) {
        syncProject();
        if (enabled === !!value) return;
        enabled = !!value;
        if (enabled && candidate) rectangle = { ...candidate };
        persist();
        publish(true);
      },
      begin(id) {
        syncProject();
        if (id !== projectId || drawing) return;
        drawing = true;
        if (enabled) publish(true);
      },
      capture(id, selection) {
        syncProject();
        if (id !== projectId) return;
        const next = normalizeRetryRectangle(selection);
        const wasDrawing = drawing;
        drawing = false;
        if (next) {
          candidate = next;
          if (enabled) {
            rectangle = next;
            persist();
          }
        }
        if (enabled && (wasDrawing || next)) publish(true);
      },
      cancel(id) {
        syncProject();
        if (id !== projectId || !drawing) return;
        drawing = false;
        if (enabled) publish(true);
      }
    };
    win.CanvasSaveGuardRetryRegion = control;
    win.addEventListener("resize", () => paint());
    syncProject();
    return control;
  }

  // src/retry-panel.mjs
  var RETRY_PANEL_VERSION = "1.6.0";
  function installRetryPanel(document2 = globalThis.document) {
    const panelId = "local-canvas-retry-panel";
    const existing = document2.getElementById(panelId);
    if (existing?.dataset.version === RETRY_PANEL_VERSION && existing.shadowRoot?.getElementById("auto-start")) {
      installPanelShortcutBoundary(existing, document2);
      return existing;
    }
    if (!document2.body) {
      document2.addEventListener("DOMContentLoaded", () => installRetryPanel(document2), { once: true });
      return;
    }
    const previousInterval = existing?.shadowRoot?.getElementById("interval")?.value;
    const previousAutoInterval = existing?.shadowRoot?.getElementById("auto-interval")?.value;
    if (existing) {
      existing.shadowRoot?.getElementById("auto-cancel")?.click();
      existing.shadowRoot?.getElementById("stop")?.click();
      existing.dispatchEvent(new document2.defaultView.Event("canvas-retry-upgrade"));
    }
    const panel = existing || document2.createElement("aside");
    panel.id = panelId;
    installPanelShortcutBoundary(panel, document2);
    panel.dataset.version = RETRY_PANEL_VERSION;
    Object.assign(panel.style, {
      position: "fixed",
      right: "16px",
      bottom: "84px",
      zIndex: "2147483647",
      pointerEvents: "none"
    });
    const root = panel.shadowRoot || panel.attachShadow({ mode: "open" });
    root.innerHTML = `
  <style>
    :host { color-scheme: dark; }
    section { pointer-events:auto;width:260px;height:302px;max-height:calc(100dvh - var(--guard-retry-bottom,84px) - 18px);display:flex;flex-direction:column;overflow:hidden;box-sizing:border-box;padding:14px;border:1px solid #57534e;
      border-radius:14px;background:#242320;color:#fafaf9;box-shadow:0 6px 24px #0006;
      font:13px/1.6 system-ui,sans-serif; }
    strong { display:block;font-size:14px; }
    header { display:flex;flex:0 0 auto;align-items:center;justify-content:space-between;gap:12px; }
    #fold { padding:2px 6px;background:transparent;color:inherit; }
    section.closed { width:auto;height:auto;padding:0;border:0;background:transparent;box-shadow:none; }
    .closed header, .closed .body > :not(.manual-actions) { display:none; }
    .closed .body, .closed .manual-actions { margin:0; }
    #expand { display:none;background:#57534e;color:white; }
    .closed #expand { display:block; }
    .body { margin-top:8px;flex:1;min-height:0;overflow-y:auto;scrollbar-width:thin;scrollbar-color:#78716c88 transparent;overscroll-behavior:contain; }
    ::-webkit-scrollbar { width:6px; }
    ::-webkit-scrollbar-thumb { background:#78716c88;border-radius:6px; }
    ::-webkit-scrollbar-track { background:transparent; }
    details { margin-top:6px;color:#d6d3d1;font-size:12px; }
    summary { cursor:pointer; }
    p { margin:6px 0 0;color:#d6d3d1;font-size:12px;line-height:1.4; }
    label { display:flex;gap:6px;align-items:center;margin-bottom:6px;font-size:12px; }
    input { width:66px;padding:3px 6px;border:1px solid #78716c;border-radius:5px;
      background:#1c1917;color:#fafaf9;font:inherit; }
    .actions { display:flex;gap:8px;margin-bottom:6px; }
    button { padding:6px 8px;border:0;border-radius:7px;cursor:pointer;font:inherit; }
      #start { flex:1;background:#2563eb;color:white; }
      #auto-start { flex:1;background:#57534e;color:white; }
      #auto-cancel { background:#57534e;color:white; }
    button:disabled { opacity:.45;cursor:default; }
    #status { min-height:20px;white-space:pre-line; }
    #auto-status { white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .scope { display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:3px; }
    #region-toggle { flex:0 0 auto;width:34px;height:20px;padding:2px;border-radius:12px;background:#57534e; }
    #region-toggle span { display:block;width:16px;height:16px;border-radius:50%;background:white;transition:transform .15s; }
    #region-toggle[aria-checked="true"] { background:#2563eb; }
    #region-toggle[aria-checked="true"] span { transform:translateX(14px); }
    #region-status { margin:0 0 8px;font-size:11px;overflow-wrap:anywhere; }
  </style>
  <section aria-label="\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177">
      <header><strong>\u6279\u91CF\u91CD\u8BD5 ${RETRY_PANEL_VERSION}</strong><button id="fold" type="button" aria-label="\u6536\u8D77\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177">\u6536\u8D77</button></header>
    <div class="body">
    <div class="scope"><span>\u533A\u57DF\u91CD\u8BD5</span><button id="region-toggle" type="button" role="switch" aria-label="\u533A\u57DF\u91CD\u8BD5" aria-checked="false"><span></span></button></div>
    <p id="region-status" role="status"></p>
    <label>\u9010\u9879\u63D0\u4EA4\u95F4\u9694\uFF08\u79D2\uFF09<input id="interval" type="number" required min="0.2" max="60"
      step="0.1" value="1" aria-label="\u9010\u9879\u63D0\u4EA4\u95F4\u9694\uFF08\u79D2\uFF09"></label>
    <div class="actions manual-actions">
      <button id="start" type="button">\u91CD\u8BD5\u5F53\u524D\u5931\u8D25\u9879</button>
      <button id="expand" type="button" aria-label="\u5C55\u5F00\u6279\u91CF\u91CD\u8BD5\u8BBE\u7F6E">\u5C55\u5F00</button>
    </div>
    <label>\u81EA\u52A8\u95F4\u9694\uFF08\u79D2\uFF09<input id="auto-interval" type="number" required min="60"
      step="1" value="60" aria-label="\u81EA\u52A8\u91CD\u8BD5\u95F4\u9694\uFF08\u79D2\uFF09"></label>
    <div class="actions">
        <button id="auto-start" type="button" aria-pressed="false">\u81EA\u52A8\u91CD\u8BD5</button>
      <button id="auto-cancel" type="button" disabled>\u53D6\u6D88\u91CD\u8BD5</button>
    </div>
    <p id="auto-status" role="status" aria-live="polite">\u81EA\u52A8\u91CD\u8BD5\u5F85\u5F00\u542F</p>
    <p id="status" role="status" aria-live="polite">\u5C31\u7EEA</p>
    <details><summary>\u4F7F\u7528\u8BF4\u660E</summary>
    <p>\u81EA\u52A8\u6309\u5468\u671F\u63D0\u4EA4\u5F53\u524D\u5931\u8D25\u9879\uFF0C\u9010\u9879\u4F7F\u7528\u4E0A\u65B9\u63D0\u4EA4\u95F4\u9694\u3002\u4ECE\u6BCF\u8F6E\u7B2C\u4E00\u9879\u63D0\u4EA4\u65F6\u8BA1\u65F6\u3002</p>
    <p>\u5904\u7406\u72EC\u7ACB\u5931\u8D25\u9879\u548C\u5DF2\u5C55\u5F00\u56FE\u7247\u7EC4\u4E2D\u7684\u5931\u8D25\u9879\uFF0C\u6536\u8D77\u7EC4\u81EA\u52A8\u8DF3\u8FC7\uFF0C\u6BCF\u9879\u6BCF\u8F6E\u63D0\u4EA4\u4E00\u6B21\u3002\u91CD\u8BD5\u4F7F\u7528\u7F51\u7AD9\u73B0\u6709\u914D\u7F6E\uFF0C\u53EF\u80FD\u6D88\u8017\u989D\u5EA6\u3002</p>
    <p>\u624B\u52A8\u6309\u8BBE\u5B9A\u95F4\u9694\u63D0\u4EA4\u5F53\u524D\u5931\u8D25\u9879\u4E00\u8F6E\uFF0C\u751F\u6210\u7ED3\u679C\u8BF7\u67E5\u770B\u753B\u5E03\u3002</p>
    <p>\u5F00\u542F\u533A\u57DF\u91CD\u8BD5\u540E\uFF0CShift\uFF0B\u5DE6\u952E\u6846\u9009\u56FA\u5B9A\u753B\u5E03\u533A\u57DF\u3002\u624B\u52A8\u4E0E\u81EA\u52A8\u91CD\u8BD5\u90FD\u4F7F\u7528\u8BE5\u533A\u57DF\uFF0C\u533A\u57DF\u5185\u540E\u6765\u51FA\u73B0\u7684\u5931\u8D25\u9879\u4E5F\u4F1A\u53C2\u4E0E\u3002\u91CD\u65B0\u6846\u9009\u53EF\u66FF\u6362\u8303\u56F4\uFF0C\u6536\u8D77\u7684\u56FE\u7247\u7EC4\u8DF3\u8FC7\u3002</p>
    </details>
    </div>
  </section>`;
    document2.body.append(panel);
    const regionControl = installRetryRegion(document2);
    const foldButton = root.getElementById("fold");
    foldButton.addEventListener("click", () => {
      const closed = root.querySelector("section").classList.toggle("closed");
      foldButton.textContent = closed ? "\u5C55\u5F00" : "\u6536\u8D77";
      foldButton.setAttribute("aria-label", closed ? "\u5C55\u5F00\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177" : "\u6536\u8D77\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177");
      refreshCount();
      startButton.title = closed ? "\u70B9\u51FB\u91CD\u8BD5\uFF0C\u53F3\u952E\u5C55\u5F00\u8BBE\u7F6E" : "";
    });
    const startButton = root.getElementById("start");
    root.getElementById("expand").addEventListener("click", () => foldButton.click());
    const intervalInput = root.getElementById("interval");
    const status = root.getElementById("status");
    const autoStartButton = root.getElementById("auto-start");
    const autoCancelButton = root.getElementById("auto-cancel");
    const autoIntervalInput = root.getElementById("auto-interval");
    const autoStatus = root.getElementById("auto-status");
    const regionToggle = root.getElementById("region-toggle");
    const regionStatus = root.getElementById("region-status");
    let manualController = null;
    let autoSession = null;
    const attempts = /* @__PURE__ */ new Map();
    const settingsKey = "canvas-retry-settings-v1";
    try {
      const settings = JSON.parse(localStorage.getItem(settingsKey) || "{}");
      intervalInput.value = previousInterval || settings.manualInterval || "1";
      autoIntervalInput.value = previousAutoInterval || settings.autoInterval || "60";
      if (!intervalInput.checkValidity()) intervalInput.value = "1";
      if (!autoIntervalInput.checkValidity()) autoIntervalInput.value = "60";
    } catch {
    }
    function saveSettings() {
      if (!intervalInput.checkValidity() || !autoIntervalInput.checkValidity()) return;
      try {
        localStorage.setItem(settingsKey, JSON.stringify({
          manualInterval: intervalInput.value,
          autoInterval: autoIntervalInput.value
        }));
      } catch {
      }
    }
    intervalInput.addEventListener("change", saveSettings);
    autoIntervalInput.addEventListener("change", saveSettings);
    function updateControls() {
      startButton.disabled = Boolean(manualController);
      autoStartButton.setAttribute("aria-pressed", String(Boolean(autoSession)));
      autoStartButton.style.backgroundColor = autoSession ? "#2563eb" : "#57534e";
      intervalInput.disabled = Boolean(manualController);
      autoIntervalInput.disabled = Boolean(autoSession);
      autoCancelButton.disabled = !autoSession;
    }
    function cancelAutoRetry(message = "\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002") {
      if (autoSession) {
        clearTimeout(autoSession.timer);
        autoSession.cancelMessage = message;
        autoSession.controller?.abort();
      }
      autoSession = null;
      autoStatus.textContent = message;
      updateControls();
    }
    function updateAutoStatus() {
      if (autoSession?.nextAt && !autoSession.controller) {
        const time = new Date(autoSession.nextAt).toLocaleTimeString("zh-CN", { hour12: false });
        autoStatus.textContent = `\u4E0B\u6B21\u68C0\u67E5\u65F6\u95F4 ${time}`;
      }
    }
    async function runAutoRetry(session) {
      if (autoSession !== session) return;
      if (location.href !== session.url || !isCanvas()) {
        cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
        return;
      }
      session.nextAt = 0;
      session.startedAt = null;
      autoStatus.textContent = "\u81EA\u52A8\u91CD\u8BD5\u6B63\u5728\u68C0\u67E5\u5E76\u63D0\u4EA4\u5931\u8D25\u9879\u2026";
      await run(session);
      if (autoSession !== session) return;
      if (location.href !== session.url) {
        cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
        return;
      }
      session.nextAt = (session.startedAt ?? Date.now()) + session.delay;
      const waitUntilNextRound = () => {
        if (autoSession !== session) return;
        const remaining = session.nextAt - Date.now();
        if (remaining <= 0) {
          void runAutoRetry(session);
          return;
        }
        session.timer = setTimeout(waitUntilNextRound, Math.min(remaining, 2147483647));
      };
      waitUntilNextRound();
      updateAutoStatus();
    }
    function startAutoRetry() {
      if (autoSession) return;
      if (!isCanvas()) {
        autoStatus.textContent = "\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u753B\u5E03\u3002";
        return;
      }
      if (!autoIntervalInput.reportValidity() || !intervalInput.reportValidity()) return;
      const seconds = Number(autoIntervalInput.value);
      if (!Number.isSafeInteger(seconds) || seconds < 60 || !Number.isSafeInteger(Date.now() + seconds * 1e3)) {
        autoStatus.textContent = "\u8BF7\u8F93\u5165\u6709\u6548\u7684\u6574\u6570\u79D2\u6570\uFF0C\u6700\u5C1160\u79D2\u3002";
        return;
      }
      autoSession = {
        url: location.href,
        delay: seconds * 1e3,
        timer: null,
        nextAt: 0,
        startedAt: null,
        controller: null
      };
      updateControls();
      void runAutoRetry(autoSession);
    }
    function isCanvas() {
      return /^\/canvas\/[^/]+\/?$/.test(location.pathname);
    }
    function isInCollapsedGroup(button) {
      let node = button.closest("[data-node-id]");
      while (node) {
        if (node.getAttribute("data-batch-collapsed") === "true") return true;
        const toggles = node.querySelectorAll('button[aria-label="\u56FE\u7247\u7EC4\u5DF2\u6536\u8D77"]');
        if (Array.from(toggles).some((toggle) => toggle.closest("[data-node-id]") === node)) {
          return true;
        }
        node = node.parentElement?.closest("[data-node-id]");
      }
      return false;
    }
    function isRetry(button) {
      return button.textContent.trim() === "\u91CD\u8BD5" && !button.disabled && button.getAttribute("aria-disabled") !== "true" && !button.closest('[hidden], [aria-hidden="true"]') && !isInCollapsedGroup(button) && button.getClientRects().length > 0;
    }
    function retryButtons() {
      return Array.from(document2.querySelectorAll("[data-node-id] button")).filter(isRetry);
    }
    function currentRetryBridge() {
      const bridge = globalThis.CanvasSaveGuardRetry;
      const projectId = decodeURIComponent(location.pathname.split("/")[2] || "");
      return bridge?.projectId === projectId && typeof bridge.list === "function" && typeof bridge.retry === "function" ? bridge : null;
    }
    function retryTargets() {
      const scope = regionControl.snapshot();
      const bridge = currentRetryBridge();
      if (scope.enabled && (!scope.available || !scope.rectangle || scope.drawing)) return [];
      if (bridge) return bridge.list(scope.enabled ? scope.rectangle : void 0).map((nodeId) => ({ nodeId, bridge }));
      return retryButtons().map((button) => ({
        nodeId: button.closest("[data-node-id]").getAttribute("data-node-id"),
        button
      }));
    }
    function pause2(milliseconds, signal) {
      return new Promise((resolve) => {
        if (signal.aborted) return resolve();
        const timer = setTimeout(finish, milliseconds);
        function finish() {
          clearTimeout(timer);
          signal.removeEventListener("abort", finish);
          resolve();
        }
        signal.addEventListener("abort", finish, { once: true });
      });
    }
    function stillOnCanvas(url, controller) {
      if (location.href !== url) {
        controller.abort();
        if (autoSession?.url === url) cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
      }
      return !controller.signal.aborted;
    }
    function takeSnapshot() {
      const scope = regionControl.snapshot();
      const targets = retryTargets();
      const counts = /* @__PURE__ */ new Map();
      for (const { nodeId } of targets) {
        counts.set(nodeId, (counts.get(nodeId) || 0) + 1);
      }
      return targets.map((target) => {
        return { ...target, scope, exclusive: counts.get(target.nodeId) === 1, attempt: attempts.get(target.nodeId) || 0 };
      });
    }
    function resolveButton(item) {
      if (item.button.isConnected && isRetry(item.button) && item.button.closest("[data-node-id]")?.getAttribute("data-node-id") === item.nodeId) {
        return item.button;
      }
      if (!item.exclusive) return null;
      const matches = retryButtons().filter((button) => button.closest("[data-node-id]").getAttribute("data-node-id") === item.nodeId);
      return matches.length === 1 ? matches[0] : null;
    }
    function submitRetry(item) {
      const scope = regionControl.snapshot();
      if (scope.projectId !== item.scope.projectId || scope.revision !== item.scope.revision) return false;
      if (scope.enabled && (!scope.available || !scope.rectangle || scope.drawing)) return false;
      if (item.bridge) {
        const bridge = currentRetryBridge();
        return bridge ? bridge.retry(item.nodeId, scope.enabled ? scope.rectangle : void 0) : false;
      }
      const button = resolveButton(item);
      if (!button) return false;
      button.click();
      return true;
    }
    async function run(session = null) {
      if (session ? session.controller : manualController) return;
      const runStatus = session ? autoStatus : status;
      function setRunStatus(message) {
        if (!session || autoSession === session) runStatus.textContent = message;
      }
      if (!isCanvas()) {
        setRunStatus("\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u753B\u5E03\u3002");
        return;
      }
      if (!intervalInput.reportValidity()) {
        setRunStatus("\u8BF7\u586B\u5199\u6709\u6548\u7684\u9010\u9879\u63D0\u4EA4\u95F4\u9694\uFF0C\u8303\u56F4\u4E3A0.2\u81F360\u79D2\u3002");
        return;
      }
      saveSettings();
      const interval = Number(intervalInput.value) * 1e3;
      if (!Number.isFinite(interval) || interval < 200 || interval > 6e4) return;
      const url = location.href;
      const controller = new AbortController();
      if (session) session.controller = controller;
      else manualController = controller;
      const { signal } = controller;
      updateControls();
      let submitted = 0;
      let skipped = 0;
      let total = 0;
      let lastSubmission = null;
      const navigationCheck = setInterval(() => stillOnCanvas(url, controller), 200);
      try {
        if (!stillOnCanvas(url, controller)) return;
        setRunStatus("\u6B63\u5728\u68C0\u67E5\u5F53\u524D\u5931\u8D25\u9879\u2026");
        const items = takeSnapshot();
        total = items.length;
        if (!total) {
          const scope = regionControl.snapshot();
          setRunStatus(scope.enabled && (!scope.available || !scope.rectangle || scope.drawing) ? "\u8BF7\u7ED3\u675F\u6846\u9009\u5E76\u56FA\u5B9A\u91CD\u8BD5\u533A\u57DF\u3002\u533A\u57DF\u91CD\u8BD5\u9700\u8981\u65B0\u7248\u753B\u5E03\u52A9\u624B\u63A5\u53E3\u3002" : `${scope.enabled ? "\u5F53\u524D\u533A\u57DF" : "\u5F53\u524D\u753B\u5E03"}\u6CA1\u6709\u53EF\u91CD\u8BD5\u7684\u5931\u8D25\u9879\uFF0C\u6536\u8D77\u7684\u56FE\u7247\u7EC4\u5DF2\u8DF3\u8FC7\u3002`);
          return;
        }
        for (const item of items) {
          if (!stillOnCanvas(url, controller)) break;
          if (lastSubmission !== null) {
            let remaining = interval - (performance.now() - lastSubmission);
            while (remaining > 0 && stillOnCanvas(url, controller)) {
              setRunStatus(`\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\uFF0C\u6309 ${interval / 1e3} \u79D2\u95F4\u9694\u7B49\u5F85\u4E0B\u4E00\u9879\u3002`);
              await pause2(Math.min(remaining, 1e3), signal);
              remaining = interval - (performance.now() - lastSubmission);
            }
          }
          if (!stillOnCanvas(url, controller)) break;
          const submittedAt = Date.now();
          const submittedMonotonic = performance.now();
          if ((attempts.get(item.nodeId) || 0) === item.attempt && submitRetry(item)) {
            if (session && session.startedAt === null) {
              session.startedAt = submittedAt;
              session.nextAt = session.startedAt + session.delay;
            }
            attempts.set(item.nodeId, item.attempt + 1);
            lastSubmission = submittedMonotonic;
            submitted += 1;
          } else {
            skipped += 1;
          }
          setRunStatus(`\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\uFF0C\u8DF3\u8FC7 ${skipped} \u9879\u3002`);
          await pause2(0, signal);
        }
        const result = controller.scopeChanged ? "\u91CD\u8BD5\u8303\u56F4\u5DF2\u66F4\u65B0\uFF0C\u672C\u8F6E\u5DF2\u505C\u6B62" : signal.aborted ? "\u5DF2\u505C\u6B62" : "\u672C\u8F6E\u63D0\u4EA4\u7ED3\u675F";
        setRunStatus(`${result}\u3002\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\uFF0C\u8DF3\u8FC7 ${skipped} \u9879\u3002
\u751F\u6210\u7ED3\u679C\u8BF7\u67E5\u770B\u753B\u5E03\u3002`);
      } catch (error) {
        console.error("[Canvas Retry]", error);
        setRunStatus(`\u64CD\u4F5C\u4E2D\u65AD\u3002\u5DF2\u63D0\u4EA4 ${submitted} \u9879\u3002
${error.message}`);
      } finally {
        clearInterval(navigationCheck);
        if (session) {
          session.controller = null;
          if (session.cancelMessage && !autoSession) runStatus.textContent = session.cancelMessage;
        } else {
          manualController = null;
          if (signal.aborted) status.textContent = `${controller.scopeChanged ? "\u91CD\u8BD5\u8303\u56F4\u5DF2\u66F4\u65B0\uFF0C\u672C\u8F6E\u5DF2\u505C\u6B62" : "\u5DF2\u505C\u6B62"}\u3002\u5DF2\u63D0\u4EA4 ${submitted} / ${total} \u9879\u3002`;
        }
        updateControls();
        refreshCount();
      }
    }
    function refreshCount() {
      if (autoSession && location.href !== autoSession.url) {
        cancelAutoRetry("\u5DF2\u5207\u6362\u753B\u5E03\uFF0C\u81EA\u52A8\u91CD\u8BD5\u5DF2\u53D6\u6D88\u3002");
      }
      updateAutoStatus();
      const scope = regionControl.snapshot();
      regionToggle.disabled = !scope.available && !scope.enabled;
      regionToggle.setAttribute("aria-checked", String(scope.enabled));
      regionToggle.title = scope.available ? "\u5F00\u542F\u540E\u4F7F\u7528\u56FA\u5B9A\u6846\u9009\u533A\u57DF\uFF0C\u5173\u95ED\u540E\u6062\u590D\u5168\u753B\u5E03\u91CD\u8BD5" : "\u8BF7\u91CD\u65B0\u52A0\u8F7D\u753B\u5E03\u52A9\u624B\u6269\u5C55\u5E76\u5237\u65B0\u753B\u5E03\uFF0C\u542F\u7528\u533A\u57DF\u63A5\u53E3";
      regionStatus.textContent = scope.enabled ? !scope.available ? "\u7B49\u5F85\u65B0\u7248\u753B\u5E03\u63A5\u53E3\uFF0C\u8BF7\u4FDD\u5B58\u540E\u5237\u65B0\u753B\u5E03" : scope.drawing ? "\u6B63\u5728\u6846\u9009\u533A\u57DF\u2026" : scope.rectangle ? `\u533A\u57DF\u5DF2\u56FA\u5B9A \xB7 ${Math.round(scope.rectangle.right - scope.rectangle.left)} \xD7 ${Math.round(scope.rectangle.bottom - scope.rectangle.top)} \xB7 Shift\uFF0B\u5DE6\u952E\u91CD\u65B0\u6846\u9009` : "Shift\uFF0B\u5DE6\u952E\u6846\u9009\u91CD\u8BD5\u533A\u57DF" : "\u5168\u753B\u5E03\u91CD\u8BD5";
      autoStartButton.textContent = scope.enabled ? "\u533A\u57DF\u81EA\u52A8\u91CD\u8BD5" : "\u81EA\u52A8\u91CD\u8BD5";
      regionControl.paint();
      panel.hidden = !isCanvas();
      if (!panel.isConnected && document2.body) document2.body.append(panel);
      const guard = document2.getElementById("canvas-save-guard");
      panel.style.bottom = guard && getComputedStyle(guard).display !== "none" ? Math.max(18, window.innerHeight - guard.getBoundingClientRect().top + 10) + "px" : "18px";
      if (root.querySelector("section").classList.contains("closed")) {
        startButton.textContent = scope.enabled ? "\u533A\u57DF\u91CD\u8BD5" : "\u91CD\u8BD5";
      } else if (!manualController) {
        startButton.textContent = `${scope.enabled ? "\u91CD\u8BD5\u533A\u57DF\u5931\u8D25\u9879" : "\u91CD\u8BD5\u5F53\u524D\u5931\u8D25\u9879"}\uFF08${retryTargets().length}\uFF09`;
      }
    }
    startButton.addEventListener("click", () => run());
    startButton.addEventListener("contextmenu", (event) => {
      if (!root.querySelector("section").classList.contains("closed")) return;
      event.preventDefault();
      foldButton.click();
    });
    autoStartButton.addEventListener("click", startAutoRetry);
    autoCancelButton.addEventListener("click", () => cancelAutoRetry());
    regionToggle.addEventListener("click", () => regionControl.setEnabled(!regionControl.snapshot().enabled));
    const unsubscribeRegion = regionControl.subscribe(({ scopeChanged }) => {
      if (scopeChanged) {
        for (const controller of [manualController, autoSession?.controller]) {
          if (!controller) continue;
          controller.scopeChanged = true;
          controller.abort();
        }
      }
      refreshCount();
    });
    function dispose() {
      manualController?.abort();
      cancelAutoRetry();
      clearInterval(refreshTimer);
      unsubscribeRegion();
      window.removeEventListener("pagehide", dispose);
      panel.removeEventListener("canvas-retry-upgrade", dispose);
    }
    refreshCount();
    updateControls();
    const refreshTimer = setInterval(refreshCount, 1500);
    window.addEventListener("pagehide", dispose, { once: true });
    panel.addEventListener("canvas-retry-upgrade", dispose, { once: true });
    return panel;
  }

  // src/reference-audit.mjs
  function collectReferenceData(value, label, includeUrls = true) {
    const data = { aliases: [], urls: [] };
    const visited = /* @__PURE__ */ new WeakSet();
    function visit(item, path, nodeType) {
      if (typeof item === "string") {
        if (includeUrls && item.startsWith("blob:")) data.urls.push({ url: item, path });
        return;
      }
      if (!item || typeof item !== "object") return;
      if (visited.has(item)) return;
      visited.add(item);
      if (Array.isArray(item)) {
        item.forEach((child, index) => visit(child, `${path}[${index}]`, nodeType));
        return;
      }
      const type = item.type || item.kind;
      if (["image", "video", "audio", "text", "config"].includes(type)) nodeType = type;
      const key = item.storageKey || item.data?.storageKey || item.metadata?.storageKey;
      if (mediaKey(key)) {
        for (const name of ["content", "url", "dataUrl", "coverUrl"]) {
          if (typeof item[name] === "string" && item[name].startsWith("blob:")) data.aliases.push([item[name], key]);
        }
      }
      for (const [name, child] of Object.entries(item)) {
        if (isMediaTextField(name, child, nodeType)) continue;
        visit(child, `${path}.${name}`, nodeType);
      }
    }
    visit(value, label);
    return data;
  }
  function appendReferenceData(target, data) {
    target.aliases.push(...data.aliases);
    target.urls.push(...data.urls);
  }
  function documentReferenceData(doc) {
    const data = { aliases: [], urls: [] };
    for (const element of doc.querySelectorAll('img, video, audio, source, object, embed, [href^="blob:"], [style*="blob:"]')) {
      const values = [element.currentSrc, element.getAttribute("src"), element.getAttribute("poster"), element.getAttribute("data"), element.getAttribute("href"), element.getAttribute("srcset"), element.getAttribute("style")];
      for (const value of values) {
        if (typeof value !== "string") continue;
        for (const match of value.matchAll(/blob:[^\s"'),]+/g)) data.urls.push({ url: match[0], path: `\u753B\u5E03\u754C\u9762/${element.tagName}` });
      }
    }
    return data;
  }
  async function auditTemporaryReferences(data, entries, readBlob, fetchBlob, progress) {
    const aliases = /* @__PURE__ */ new Map();
    const cached = /* @__PURE__ */ new Set();
    for (const [url, key, fromCache] of data.aliases) {
      if (!mediaKey(key)) continue;
      if (!aliases.has(url)) aliases.set(url, /* @__PURE__ */ new Set());
      aliases.get(url).add(key);
      if (fromCache) cached.add(url);
    }
    const urls = /* @__PURE__ */ new Map();
    for (const item of data.urls) if (!urls.has(item.url)) urls.set(item.url, item.path);
    const keys = /* @__PURE__ */ new Set();
    const unresolved = [];
    const hashes = /* @__PURE__ */ new Map();
    let checked = 0;
    let contentMatched = 0;
    progress({ step: 4, stage: "\u6B63\u5728\u6838\u5BF9\u4E34\u65F6\u5A92\u4F53\u5F15\u7528", current: 0, total: urls.size });
    for (const [url, path] of urls) {
      if (aliases.has(url)) for (const key of aliases.get(url)) keys.add(key);
      if (!cached.has(url)) {
        let fetched = false;
        try {
          const blob = await fetchBlob(url);
          fetched = true;
          if (!blob?.size) throw Error("\u4E34\u65F6\u6587\u4EF6\u4E3A\u7A7A");
          const hash = await sha256(await blob.arrayBuffer());
          let matched = false;
          const matchingSize = entries.filter((entry) => entry.bytes === blob.size);
          let compared = 0;
          for (const entry of matchingSize) {
            const identity = `${entry.database}/${entry.store}/${entry.key}`;
            if (!hashes.has(identity)) {
              const candidate = await readBlob(entry);
              if (!candidate?.arrayBuffer) throw Error("\u7F13\u5B58\u6587\u4EF6\u683C\u5F0F\u65E0\u6CD5\u6838\u5BF9");
              hashes.set(identity, await sha256(await candidate.arrayBuffer()));
            }
            if (hashes.get(identity) === hash) {
              keys.add(entry.key);
              matched = true;
            }
            compared += 1;
            if (compared % 16 === 0 || compared === matchingSize.length) progress({
              step: 4,
              stage: `\u4E34\u65F6\u5730\u5740 ${checked + 1}/${urls.size}\uFF0C\u5019\u9009\u6587\u4EF6 ${compared}/${matchingSize.length}`,
              current: checked,
              total: urls.size
            });
          }
          if (matched) contentMatched += 1;
        } catch (error) {
          if (fetched || !aliases.has(url)) unresolved.push({ url, path, reason: error.message || String(error) });
        }
      }
      checked += 1;
      progress({ step: 4, stage: "\u6B63\u5728\u6838\u5BF9\u4E34\u65F6\u5A92\u4F53\u5F15\u7528", current: checked, total: urls.size });
    }
    return { keys: [...keys], unresolved, checked, contentMatched };
  }

  // src/cleanup-storage.mjs
  var CLEANUP_LOCK = "canvas-save-guard:media-cleanup";
  function withMediaAccess(action) {
    return navigator.locks.request(CLEANUP_LOCK, { mode: "shared" }, action);
  }
  function parseState(value) {
    if (typeof value === "string") return JSON.parse(value);
    return value;
  }
  function hasUnkeyedBlob(value, keyedContent = false, nodeType) {
    if (typeof value === "string") return value.startsWith("blob:") && !keyedContent;
    if (Array.isArray(value)) return value.some((item) => hasUnkeyedBlob(item, false, nodeType));
    if (!value || typeof value !== "object") return false;
    if (["image", "video", "audio", "text", "config"].includes(value.type || value.kind)) nodeType = value.type || value.kind;
    const keyed = mediaKey(value.storageKey);
    return Object.entries(value).some(([name, item]) => !isMediaTextField(name, item, nodeType) && hasUnkeyedBlob(item, keyed && ["content", "url", "dataUrl", "coverUrl"].includes(name), nodeType));
  }
  async function openExisting(indexedDB2, name) {
    const databases = await indexedDB2.databases();
    if (!databases.some((database) => database.name === name)) return null;
    return new Promise((resolve, reject) => {
      const request = indexedDB2.open(name);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }
  function readRoots(db, storeNames, retainedKeys, safety, recordRead, audit, projectRoots, tombstones, nativeTombstones) {
    if (!db || !storeNames.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(storeNames, "readonly");
      for (const name of storeNames) {
        const request = transaction.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          try {
            recordRead();
            if (name === "app_state" && cursor.key !== STORE_KEY && cursor.key !== "infinite-canvas:asset_store") {
              cursor.continue();
              return;
            }
            const value = parseState(cursor.value);
            if (name === "projects") {
              projectRoots.push({ project: value, label: `\u4FDD\u62A4\u526F\u672C/\u753B\u5E03 ${value.title || value.id}` });
            } else if (name === "deleted") {
              tombstones.push(value);
            } else if (name === "app_state" && cursor.key === STORE_KEY) {
              for (const project of value?.state?.projects || []) projectRoots.push({ project, label: `\u753B\u5E03 ${project.title || project.id}` });
              tombstones.push(...value?.state?.deletedProjects || []);
              nativeTombstones.push(...value?.state?.deletedProjects || []);
            } else {
              if (audit) appendReferenceData(audit, collectReferenceData(value, `${name}/${cursor.key}`));
              collectMedia(value, retainedKeys);
              safety.preserveAllMedia ||= hasUnkeyedBlob(value);
            }
            cursor.continue();
          } catch (error) {
            transaction.abort();
            reject(Error(`\u7F13\u5B58\u5F15\u7528\u8BFB\u53D6\u5931\u8D25\uFF0C\u5DF2\u505C\u6B62\u6E05\u7406\u3002${error.message}`));
          }
        };
      }
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || Error("\u7F13\u5B58\u5F15\u7528\u8BFB\u53D6\u4E2D\u65AD\uFF0C\u5DF2\u505C\u6B62\u6E05\u7406\u3002"));
      transaction.onerror = () => {
      };
    });
  }
  function inventory(db, names, recordRead) {
    if (!db || !names.length) return Promise.resolve([]);
    return new Promise((resolve, reject) => {
      const entries = [];
      const transaction = db.transaction(names, "readonly");
      for (const name of names) {
        const request = transaction.objectStore(name).openCursor();
        request.onsuccess = () => {
          const cursor = request.result;
          if (!cursor) return;
          entries.push({ store: name, key: cursor.key, bytes: cursor.value?.size || cursor.value?.blob?.size || 0 });
          recordRead();
          cursor.continue();
        };
      }
      transaction.oncomplete = () => resolve(entries);
      transaction.onabort = () => reject(transaction.error || Error("\u7F13\u5B58\u626B\u63CF\u4E2D\u65AD\u3002"));
      transaction.onerror = () => {
      };
    });
  }
  function removeEntries(db, entries, committed) {
    if (!db || !entries.length) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([...new Set(entries.map((entry) => entry.store))], "readwrite");
      for (const entry of entries) transaction.objectStore(entry.store).delete(entry.key);
      transaction.oncomplete = () => {
        committed(entries.length);
        resolve();
      };
      transaction.onabort = () => reject(transaction.error || Error("\u7F13\u5B58\u6E05\u7406\u5199\u5165\u4E2D\u65AD\uFF0C\u53EF\u4EE5\u91CD\u65B0\u70B9\u51FB\u6E05\u7406\u3002"));
      transaction.onerror = () => {
      };
    });
  }
  function countEntries(db, names) {
    if (!db || !names.length) return Promise.resolve(0);
    return new Promise((resolve, reject) => {
      let count = 0;
      const transaction = db.transaction(names, "readonly");
      for (const name of names) {
        const request = transaction.objectStore(name).count();
        request.onsuccess = () => {
          count += request.result;
        };
      }
      transaction.oncomplete = () => resolve(count);
      transaction.onabort = () => reject(transaction.error || Error("\u7F13\u5B58\u6570\u91CF\u8BFB\u53D6\u4E2D\u65AD\u3002"));
      transaction.onerror = () => {
      };
    });
  }
  function summarizeEntries(entries) {
    return {
      files: new Set(entries.map((entry) => entry.key)).size,
      copies: entries.length,
      bytes: entries.reduce((total, entry) => total + entry.bytes, 0)
    };
  }
  function summarizeInventory(entries, candidates, retained, preserveAllMedia) {
    const groups = { inUse: [], untracked: [], unverifiable: [], removed: [] };
    for (const entry of entries) {
      const group = retained.has(entry.key) ? "inUse" : !candidates.has(entry.key) ? "untracked" : preserveAllMedia ? "unverifiable" : "removed";
      groups[group].push(entry);
    }
    return {
      scanned: summarizeEntries(entries),
      retained: summarizeEntries([...groups.inUse, ...groups.untracked, ...groups.unverifiable]),
      ...Object.fromEntries(Object.entries(groups).map(([name, items]) => [name, summarizeEntries(items)]))
    };
  }
  async function cleanUnreferencedMedia(indexedDB2, scan, localFallback = {}, progress = () => {
  }, options = {}) {
    if (scan.mode && !["deleted", "deleted-audited"].includes(scan.mode)) throw Error("\u6B64\u65E7\u6E05\u7406\u63A5\u53E3\u5DF2\u505C\u7528\uFF0C\u8BF7\u4F7F\u7528\u9762\u677F\u4E2D\u7684\u6E05\u7406\u6309\u94AE\u3002");
    progress({ step: 3, stage: "\u6B63\u5728\u6838\u5BF9\u56FE\u7247\u5F15\u7528", total: null });
    const retained = new Map(scan.keys.map((key) => [key, []]));
    const candidates = new Set(scan.candidateKeys);
    const safety = { preserveAllMedia: scan.preserveAllMedia };
    const auditing = scan.mode === "deleted-audited";
    const audit = auditing ? { aliases: [...scan.referenceData.aliases], urls: [...scan.referenceData.urls] } : null;
    const liveProjectIds = new Set(scan.liveProjectIds);
    const original = await openExisting(indexedDB2, "infinite-canvas");
    const vault = await openExisting(indexedDB2, "canvas-save-guard");
    try {
      const projectRoots = [], tombstones = [], nativeTombstones = [];
      const originalRoots = ["app_state", "image_generation_logs", "video_generation_logs", "agent_chat_messages"].filter((name) => original?.objectStoreNames.contains(name));
      const protectedRoots = ["projects", "deleted"].filter((name) => vault?.objectStoreNames.contains(name));
      const candidateStores = vault?.objectStoreNames.contains("cleanup_candidates") ? ["cleanup_candidates"] : [];
      const fallbackEntries = Object.entries(localFallback).filter(([, raw]) => raw);
      const rootCounts = await Promise.all([
        countEntries(original, originalRoots),
        countEntries(vault, protectedRoots),
        countEntries(vault, candidateStores)
      ]);
      const rootTotal = rootCounts.reduce((total, count) => total + count, fallbackEntries.length);
      let referencesRead = 0;
      const referenceProgress = () => progress({ step: 3, stage: "\u6B63\u5728\u6838\u5BF9\u56FE\u7247\u5F15\u7528", current: referencesRead, total: rootTotal });
      const recordRead = () => {
        referencesRead += 1;
        referenceProgress();
      };
      referenceProgress();
      await readRoots(original, originalRoots, retained, safety, recordRead, audit, projectRoots, tombstones, nativeTombstones);
      await readRoots(vault, protectedRoots, retained, safety, recordRead, audit, projectRoots, tombstones, nativeTombstones);
      const deletionRecords = [];
      if (vault?.objectStoreNames.contains("cleanup_candidates")) {
        await new Promise((resolve, reject) => {
          const transaction = vault.transaction("cleanup_candidates", "readonly");
          const request = transaction.objectStore("cleanup_candidates").openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            deletionRecords.push(cursor.value);
            recordRead();
            cursor.continue();
          };
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error || Error("\u5220\u9664\u7F13\u5B58\u8BB0\u5F55\u8BFB\u53D6\u4E2D\u65AD\u3002"));
        });
        for (const key of recordedDeletionKeys(deletionRecords, scan.projectId)) candidates.add(key);
        const pending = deletionWindow(deletionRecords, scan.projectId).pending;
        const pendingRecords = [...deletionRecords.filter((record) => record.source !== "user-delete"), ...pending];
        for (const key of recordedDeletionKeys(pendingRecords, scan.projectId, Infinity)) {
          candidates.delete(key);
          retained.set(key, []);
        }
      }
      for (const [key, raw] of fallbackEntries) {
        const value = parseState(raw);
        if (key === STORE_KEY) {
          for (const project of value.state?.projects || []) {
            projectRoots.push({ project, label: `\u672C\u5730\u753B\u5E03 ${project.title || project.id}` });
          }
          tombstones.push(...value.state?.deletedProjects || []);
          nativeTombstones.push(...value.state?.deletedProjects || []);
        } else {
          if (audit) appendReferenceData(audit, collectReferenceData(value, key));
          collectMedia(value, retained);
          safety.preserveAllMedia ||= hasUnkeyedBlob(value);
        }
        recordRead();
      }
      const latest = new Map(newerProjects([], projectRoots.map((root) => root.project), tombstones).map((project) => [project.id, project]));
      const projectWindow = projectDeletionWindow({
        nativeTombstones,
        tombstones,
        projects: projectRoots.map((root) => root.project),
        liveProjects: [...latest.values()],
        liveProjectIds: [...liveProjectIds],
        records: deletionRecords
      });
      for (const project of projectWindow.ready) for (const key of project.keys) candidates.add(key);
      for (const project of projectWindow.pending) for (const key of project.keys) {
        candidates.delete(key);
        retained.set(key, []);
      }
      for (const { project, label } of projectRoots) {
        const chosen = latest.get(project.id);
        const keep = !liveProjectIds.has(project.id) && chosen && (project.updatedAt || "") >= (chosen.updatedAt || "");
        if (audit) appendReferenceData(audit, collectReferenceData(project, label, !!keep));
        if (keep) {
          collectMedia(project, retained);
          safety.preserveAllMedia ||= hasUnkeyedBlob(project);
        }
      }
      const originalStores = ["image_files", "media_files", "image_previews"].filter((name) => original?.objectStoreNames.contains(name));
      const protectedStores = vault?.objectStoreNames.contains("media") ? ["media"] : [];
      progress({ step: 4, stage: "\u6B63\u5728\u626B\u63CF\u7F13\u5B58\u6587\u4EF6", total: null });
      const mediaCounts = await Promise.all([countEntries(original, originalStores), countEntries(vault, protectedStores)]);
      const mediaTotal = mediaCounts[0] + mediaCounts[1];
      let mediaRead = 0;
      const mediaProgress = () => progress({ step: 4, stage: "\u6B63\u5728\u626B\u63CF\u7F13\u5B58\u6587\u4EF6", current: mediaRead, total: mediaTotal });
      mediaProgress();
      const mediaRecordRead = () => {
        mediaRead += 1;
        mediaProgress();
      };
      const originalEntries = await inventory(original, originalStores, mediaRecordRead);
      const protectedEntries = await inventory(vault, protectedStores, mediaRecordRead);
      let auditResult;
      if (auditing) {
        const entries = [...originalEntries.map((entry) => ({ ...entry, database: "original" })), ...protectedEntries.map((entry) => ({ ...entry, database: "vault" }))];
        const candidateEntries = entries.filter((entry) => candidates.has(entry.key));
        const databases = { original, vault };
        const readBlob = (entry) => new Promise((resolve, reject) => {
          const request = databases[entry.database].transaction(entry.store).objectStore(entry.store).get(entry.key);
          request.onsuccess = () => resolve(request.result?.blob || request.result);
          request.onerror = () => reject(request.error);
        });
        auditResult = await auditTemporaryReferences(audit, candidateEntries, readBlob, options.fetchBlob, progress);
        for (const key of auditResult.keys) retained.set(key, []);
        safety.preserveAllMedia = auditResult.unresolved.length > 0;
        await options.validateReferences();
      }
      const canRemove = (entry) => candidates.has(entry.key) && !safety.preserveAllMedia && !retained.has(entry.key);
      const removingOriginal = originalEntries.filter(canRemove);
      const removingProtected = protectedEntries.filter(canRemove);
      const removalTotal = removingOriginal.length + removingProtected.length;
      let committed = 0;
      const removalProgress = () => progress({ step: 5, stage: "\u6B63\u5728\u6E05\u7406\u5DF2\u5220\u9664\u6587\u4EF6", current: committed, total: removalTotal });
      removalProgress();
      const deletionCommitted = (count) => {
        committed += count;
        removalProgress();
      };
      await removeEntries(original, removingOriginal, deletionCommitted);
      await removeEntries(vault, removingProtected, deletionCommitted);
      let projectBackups = 0;
      if (!safety.preserveAllMedia && vault?.objectStoreNames.contains("projects")) {
        const backups = projectWindow.ready.filter((project) => projectRoots.some((root) => root.project.id === project.id));
        if (vault.objectStoreNames.contains("deleted") && projectWindow.ready.length) await new Promise((resolve, reject) => {
          const transaction = vault.transaction("deleted", "readwrite");
          for (const project of projectWindow.ready) transaction.objectStore("deleted").put({
            id: project.id,
            at: new Date(project.deletedAt).toISOString(),
            source: "user-delete-project",
            keys: project.keys
          }, project.id);
          transaction.oncomplete = resolve;
          transaction.onabort = () => reject(transaction.error || Error("\u5DF2\u5220\u9664\u753B\u5E03\u7684\u6587\u4EF6\u5F52\u5C5E\u4FDD\u5B58\u5931\u8D25\u3002"));
        });
        await removeEntries(vault, backups.map((project) => ({ store: "projects", key: project.id })), (count) => {
          projectBackups += count;
        });
      }
      const removed = [...removingOriginal, ...removingProtected];
      const untracked = /* @__PURE__ */ new Map();
      for (const entry of [...originalEntries, ...protectedEntries]) {
        if (candidates.has(entry.key) || retained.has(entry.key)) continue;
        const detail = untracked.get(entry.key) || { key: entry.key, bytes: 0, owners: deletionRecords.filter((record) => ["node-media", "generated-media"].includes(record.source) && record.key === entry.key).map((record) => ({ projectId: record.projectId, nodeId: record.nodeId, imageId: record.imageId })) };
        detail.bytes += entry.bytes;
        untracked.set(entry.key, detail);
      }
      return {
        mode: scan.mode || "deleted",
        audit: auditResult,
        statistics: summarizeInventory([...originalEntries, ...protectedEntries], candidates, retained, safety.preserveAllMedia),
        keys: [...new Set(removed.map((entry) => entry.key))],
        bytes: removed.reduce((total, entry) => total + entry.bytes, 0),
        retainedKeys: [...retained.keys()],
        candidateKeys: [...candidates],
        preserveAllMedia: safety.preserveAllMedia,
        untrackedMedia: [...untracked.values()],
        deletedProjects: { total: projectWindow.ready.length, media: new Set(projectWindow.ready.flatMap((project) => project.keys)).size, backups: projectBackups }
      };
    } finally {
      original?.close();
      vault?.close();
    }
  }

  // src/cleanup.mjs
  var sessionLockName = (token) => `${CLEANUP_LOCK}:session:${token}`;
  async function requireActiveSession(token) {
    const { held } = await navigator.locks.query();
    const session = held.find((lock) => lock.name === sessionLockName(token) && lock.mode === "exclusive");
    if (!session || !held.some((lock) => lock.name === CLEANUP_LOCK && lock.mode === "exclusive" && lock.clientId === session.clientId)) {
      throw Error("\u6E05\u7406\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u5DF2\u505C\u6B62\u672C\u6B21\u64CD\u4F5C\u3002\u8BF7\u91CD\u65B0\u70B9\u51FB\u201C\u6E05\u7406\u5220\u9664\u7F13\u5B58\u201D\u3002");
    }
  }
  function installCleanupMessaging() {
    if (window.__canvasGuardMessageVersion === 2) return;
    const postMessage2 = window.postMessage.bind(window);
    window.postMessage = (message, ...args) => {
      if (message?.type === "canvas-guard-cleanup") message = { ...message, type: "canvas-guard-cleanup-v2" };
      return postMessage2(message, ...args);
    };
    window.__canvasGuardMessageVersion = 2;
  }
  function installCleanupUpgradeNotice(guard, doc) {
    const disabled = async () => {
      throw Error("\u6269\u5927\u8303\u56F4\u7684\u6E05\u7406\u5DF2\u505C\u7528\uFF0C\u8BF7\u4F7F\u7528\u201C\u6E05\u7406\u5220\u9664\u7F13\u5B58\u201D\u3002");
    };
    if (guard.cleanupCurrentOnly) guard.cleanupCurrentOnly = disabled;
    if (guard.cleanupUnused) guard.cleanupUnused = disabled;
    if (guard.cleanupUnreferenced) guard.cleanupUnreferenced = disabled;
    if (guard.cleanupEndpoint?.prepareCurrentOnly) guard.cleanupEndpoint.prepareCurrentOnly = disabled;
    if (guard.deletedOnlyVersion !== 1) {
      guard.cleanupDeleted = async () => {
        throw Error("\u8BF7\u5148\u4FDD\u5B58\u5B8C\u6574 ZIP\uFF0C\u91CD\u65B0\u6253\u5F00\u753B\u5E03\u540E\u542F\u7528\u6309\u5220\u9664\u8BB0\u5F55\u6E05\u7406\u3002");
      };
    }
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow) return;
    shadow.querySelector("#cleanup-current")?.remove();
    shadow.querySelector("#cleanup-unused")?.remove();
    shadow.querySelector("#cleanup-unreferenced")?.remove();
    if (shadow.querySelector("#cleanup")) return;
    const button = doc.createElement("button");
    button.id = "cleanup";
    button.textContent = "\u6E05\u7406\u5220\u9664\u7F13\u5B58";
    button.onclick = () => {
      shadow.querySelector("#status").textContent = "\u6E05\u7406\u63A5\u53E3\u5C06\u5728\u91CD\u65B0\u6253\u5F00\u753B\u5E03\u540E\u542F\u7528\u3002\u8BF7\u5148\u5B8C\u6210\u5F53\u524D\u751F\u6210\u5E76\u4FDD\u5B58\u5B8C\u6574 ZIP\uFF0C\u4FDD\u7559\u4E34\u65F6\u751F\u6210\u56FE\u3002";
    };
    shadow.querySelector(".buttons").append(button);
  }
  function requestCoordinator(action, data = {}) {
    return new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      function receive(event) {
        if (event.source !== window || event.data?.type !== "canvas-guard-cleanup-result" || event.data.id !== id) return;
        window.removeEventListener("message", receive);
        if (event.data.error) reject(Error(event.data.error));
        else resolve(event.data.result);
      }
      window.addEventListener("message", receive);
      window.postMessage({ type: "canvas-guard-cleanup", id, action, data }, location.origin);
    });
  }
  function installDeletedCleanup({ guard, getStore, getServices, flush, releaseSessionMedia, getDeletedObjects, getKnownMediaUrls, fetchBlob }) {
    guard.cleanupDetailedProgress = true;
    guard.deletedOnlyVersion = 1;
    let heldToken = null;
    let sessionWatcher = null;
    let removalSummary = { nodes: 0, connections: 0, candidateKeys: [] };
    let captureBlocker;
    function unblockEditing() {
      if (captureBlocker) for (const name of captureBlocker.events) document.removeEventListener(name, captureBlocker.block, true);
      captureBlocker = null;
      document.documentElement.removeAttribute("data-canvas-guard-cleaning");
    }
    function blockEditing() {
      if (captureBlocker) return;
      const events = ["pointerdown", "mousedown", "click", "dblclick", "contextmenu", "keydown", "paste", "drop", "wheel"];
      const block = (event) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("#canvas-save-guard")) return;
        const button = target?.closest('[role="dialog"] button');
        if (button?.textContent.replace(/\s/g, "") === "\u5220\u9664") return;
        event.preventDefault();
        event.stopImmediatePropagation();
      };
      captureBlocker = { events, block };
      for (const name of events) document.addEventListener(name, block, { capture: true, passive: false });
      document.documentElement.setAttribute("data-canvas-guard-cleaning", "");
    }
    function historyHook() {
      const hook = globalThis.CanvasSaveGuardHistory;
      if (location.pathname.startsWith("/canvas/") && (!hook?.ready || hook.deletedOnlyVersion !== 1)) {
        throw Error("\u5F53\u524D\u9875\u9762\u5C1A\u672A\u52A0\u8F7D\u7F13\u5B58\u6E05\u7406\u63A5\u53E3\u3002\u8BF7\u5148\u4FDD\u5B58\u5B8C\u6574 ZIP\uFF0C\u66F4\u65B0\u6269\u5C55\u540E\u91CD\u65B0\u6253\u5F00\u753B\u5E03\u3002");
      }
      return hook;
    }
    function roots(includeAudit = false) {
      return readCleanupRoots(getStore(), historyHook(), document, includeAudit, getKnownMediaUrls);
    }
    function release(token) {
      if (heldToken !== token) return;
      unblockEditing();
      heldToken = null;
      sessionWatcher?.abort();
      sessionWatcher = null;
    }
    function watchSession(token) {
      sessionWatcher = new AbortController();
      navigator.locks.request(sessionLockName(token), { mode: "shared", signal: sessionWatcher.signal }, () => release(token)).catch((error) => {
        if (error.name !== "AbortError") console.warn("Canvas cleanup session watch failed:", error.message);
      });
    }
    guard.cleanupEndpoint = {
      deletedOnlyVersion: 1,
      referenceAuditVersion: 1,
      interactiveAuditVersion: 1,
      cleanupSessionVersion: 1,
      roots,
      async prepare(token, prune, sessionVersion = 0) {
        if (sessionVersion === 1) {
          await requireActiveSession(token);
          if (heldToken && heldToken !== token) release(heldToken);
        } else if (heldToken && heldToken !== token) throw Error("\u53E6\u4E00\u4E2A\u6807\u7B7E\u9875\u6B63\u5728\u6E05\u7406\u7F13\u5B58\u3002");
        historyHook();
        heldToken = token;
        try {
          if (sessionVersion === 1) watchSession(token);
          const hook = historyHook();
          const projectsBefore = getStore().getState().projects;
          const before = hook?.snapshot();
          const deletions = prune ? await getDeletedObjects(hook?.projectId || "") : null;
          if (heldToken !== token) throw Error("\u6E05\u7406\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u5DF2\u505C\u6B62\u672C\u6B21\u64CD\u4F5C\u3002");
          const after = historyHook()?.snapshot();
          if (getStore().getState().projects !== projectsBefore || before?.nodes !== after?.nodes || before?.connections !== after?.connections) {
            throw Error("\u753B\u5E03\u6B63\u5728\u7F16\u8F91\uFF0C\u672C\u6B21\u7F13\u5B58\u6E05\u7406\u5DF2\u6682\u7F13\u3002");
          }
          blockEditing();
          if (prune && hook) {
            if (deletions.nodeIds.length || deletions.connectionIds.length || deletions.images.length) removalSummary = hook.prune((current, retained) => pruneDeletedHistory(current, retained, deletions));
            removalSummary.waiting = deletions.waiting;
            removalSummary.projectId = hook.projectId;
            removalSummary.deletionRevision = deletions.revision;
            removalSummary.deletionRecords = {
              nodes: deletions.nodeIds.length,
              connections: deletions.connectionIds.length,
              images: deletions.images.length,
              media: deletions.mediaKeys.length
            };
          }
          if (prune && !hook) {
            removalSummary = {
              nodes: 0,
              connections: 0,
              candidateKeys: [],
              waiting: deletions.waiting,
              projectId: "",
              deletionRevision: deletions.revision
            };
          }
          return { ...roots(), candidateKeys: prune ? removalSummary.candidateKeys : [] };
        } catch (error) {
          release(token);
          throw error;
        }
      },
      async prepareAudit(token, prune, sessionVersion = 0) {
        if (!getStore() || location.pathname.startsWith("/canvas/") && !historyHook()?.ready) throw Error("\u8BF7\u4FDD\u5B58\u5E76\u5173\u95ED\u672C\u7F51\u7AD9\u7684\u975E\u753B\u5E03\u6807\u7B7E\u9875\uFF0C\u518D\u6838\u5BF9\u5220\u9664\u7F13\u5B58\uFF0C\u4EE5\u4FBF\u5B8C\u6574\u4FDD\u62A4\u6B63\u5728\u4F7F\u7528\u7684\u7D20\u6750\u3002");
        try {
          const prepared = await this.prepare(token, prune, sessionVersion);
          const result = { ...prepared, ...roots(true) };
          unblockEditing();
          return result;
        } catch (error) {
          release(token);
          throw error;
        }
      },
      auditRoots(token) {
        if (heldToken !== token) throw Error("\u7F13\u5B58\u6838\u5BF9\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u91CD\u8BD5\u3002");
        return roots(true);
      },
      commitAudit(token) {
        if (heldToken !== token) throw Error("\u7F13\u5B58\u6838\u5BF9\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u91CD\u8BD5\u3002");
        if (historyHook() && !historyHook().idle()) throw Error("\u753B\u5E03\u6B63\u5728\u7F16\u8F91\uFF0C\u672C\u6B21\u7F13\u5B58\u6E05\u7406\u5DF2\u6682\u7F13\u3002");
        blockEditing();
        return roots(true);
      },
      async releaseMedia(token, keys, retainedKeys, candidateKeys) {
        if (heldToken !== token) throw Error("\u6E05\u7406\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u91CD\u65B0\u68C0\u67E5\u3002");
        const services = getServices();
        const imageKeys = keys.filter((key) => key.startsWith("image:"));
        const otherKeys = keys.filter((key) => !key.startsWith("image:"));
        if (imageKeys.length) await services.deleteStoredImages?.(imageKeys);
        if (otherKeys.length) await services.deleteStoredMedia?.(otherKeys);
        return releaseSessionMedia(new Set(retainedKeys), new Set(candidateKeys));
      },
      release
    };
    window.addEventListener("pagehide", () => {
      if (heldToken) release(heldToken);
    });
    function runCleanup(mode) {
      removalSummary = { nodes: 0, connections: 0, candidateKeys: [] };
      return runMediaCleanup(guard, mode, { flush, fetchBlob, getSummary: () => removalSummary }).then((result) => {
        guard.deletedCleanupChecked?.(result.projectId, result.deletionRevision);
        return result;
      });
    }
    guard.referenceAuditVersion = 1;
    guard.cleanupDeleted = () => runCleanup("deleted-audited");
    guard.deletedCleanupState = async () => {
      await flush();
      const projectId = decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
      return getDeletedObjects(projectId);
    };
  }
  function installAutomaticDeletedCleanup(guard) {
    if (guard.automaticDeletedCleanupVersion === 4 || !guard.recordDeletedObjects || !guard.deletedCleanupState) return;
    guard.automaticDeletedCleanupVersion = 4;
    const record = guard.recordDeletedObjects.bind(guard);
    let timer;
    let revision = 0;
    let running = false;
    let lastEditAt = 0;
    const checked = /* @__PURE__ */ new Map();
    guard.deletedCleanupChecked = (projectId, revision2) => {
      if (typeof projectId === "string" && revision2) checked.set(projectId, revision2);
    };
    const noteEdit = () => {
      lastEditAt = Date.now();
    };
    for (const name of ["pointerdown", "keydown", "wheel", "input"]) document.addEventListener(name, noteEdit, { capture: true, passive: true });
    guard.scheduleDeletedCleanup = () => {
      revision += 1;
      schedule();
    };
    function schedule(delay = 250) {
      clearTimeout(timer);
      timer = setTimeout(async () => {
        const current = decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
        if (!/^\/canvas(?:\/|$)/.test(location.pathname)) return;
        const hook = globalThis.CanvasSaveGuardHistory;
        if (current ? !hook?.ready || typeof hook.idle !== "function" : !guard.status?.().attached) {
          schedule(350);
          return;
        }
        if (running || hook && !hook.idle() || guard.cleanupProgress?.read().status === "running") {
          schedule(350);
          return;
        }
        if (Date.now() - lastEditAt < 800) {
          schedule(800 - (Date.now() - lastEditAt));
          return;
        }
        const started = revision;
        running = true;
        try {
          const state = await guard.deletedCleanupState();
          guard.cleanupProgress?.waiting(state.waiting);
          if ((state.nodeIds.length || state.connectionIds.length || state.images.length || state.projectDeletions?.length) && checked.get(current) !== state.revision) await guard.cleanupDeleted();
          const remaining = await guard.deletedCleanupState();
          guard.cleanupProgress?.waiting(remaining.waiting);
          if (remaining.waiting.nextAt) schedule(Math.max(50, remaining.waiting.nextAt - Date.now()));
        } catch (error) {
          if (/引用发生变化|正在编辑/.test(error.message)) schedule(1200);
        } finally {
          running = false;
          if (revision !== started) schedule();
        }
      }, delay);
    }
    guard.recordDeletedObjects = (projectId, nodes, connections, images = []) => {
      const result = record(projectId, nodes, connections, images);
      if (nodes.length || connections.length || images.length) {
        guard.scheduleDeletedCleanup(projectId);
      }
      return result;
    };
    schedule(350);
  }
  async function runMediaCleanup(guard, mode, { flush, fetchBlob, getSummary = () => ({ nodes: 0, connections: 0 }) }) {
    if (guard.cleanupProgress?.read().status === "running") throw Error("\u6E05\u7406\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u3002");
    const token = crypto.randomUUID();
    guard.cleanupProgress?.start(token, mode);
    try {
      await new Promise((resolve) => setTimeout(resolve, 0));
      await flush();
      guard.cleanupProgress?.update({ step: 1, stage: "\u7B49\u5F85\u7F13\u5B58\u5199\u5165\u7ED3\u675F", total: null });
      const result = await navigator.locks.request(CLEANUP_LOCK, () => navigator.locks.request(sessionLockName(token), async () => {
        let coordination;
        try {
          guard.cleanupProgress?.update({ step: 2, stage: "\u6838\u5BF9\u753B\u5E03\u4E0E\u64A4\u9500\u8BB0\u5F55", total: null });
          const scan = await requestCoordinator("prepare", { token, mode, sessionVersion: 1 });
          coordination = scan.coordination;
          const fallback = {};
          for (const key of ["infinite-canvas:canvas_store", "infinite-canvas:asset_store"]) fallback[key] = localStorage.getItem(key);
          const progress = (update) => guard.cleanupProgress?.update(update);
          const cleaned = await cleanUnreferencedMedia(indexedDB, scan, fallback, progress, {
            fetchBlob,
            validateReferences: () => requestCoordinator("validateReferences", { token, coordination })
          });
          guard.cleanupProgress?.update({ step: 6, stage: "\u91CA\u653E\u9875\u9762\u7F13\u5B58", total: null });
          const session = await requestCoordinator("releaseMedia", { token, coordination, keys: cleaned.keys, retainedKeys: cleaned.retainedKeys, candidateKeys: cleaned.preserveAllMedia ? [] : cleaned.candidateKeys });
          return { ...getSummary(), ...cleaned, sessionFiles: session.files, sessionBytes: session.bytes };
        } finally {
          guard.cleanupProgress?.update({ step: 7, stage: "\u6062\u590D\u9875\u9762\u64CD\u4F5C", total: null });
          try {
            await requestCoordinator("finish", { token, coordination });
          } finally {
            guard.cleanupEndpoint?.release(token);
          }
        }
      }));
      guard.cleanupProgress?.complete(result);
      return result;
    } catch (error) {
      guard.cleanupProgress?.fail(error);
      throw error;
    }
  }
  function readCleanupRoots(store, hook, doc, includeAudit = false, getKnownMediaUrls = () => []) {
    if (!store) throw Error("\u5F53\u524D\u6807\u7B7E\u9875\u5C1A\u672A\u63A5\u5165\u4FDD\u62A4\uFF0C\u8BF7\u5148\u70B9\u51FB\u6D4F\u89C8\u5668\u5DE5\u5177\u680F\u7684\u672C\u6269\u5C55\u56FE\u6807\u3002");
    const current = hook?.snapshot();
    const project = store.getState().projects.find((project2) => project2.id === hook?.projectId);
    const localRoots = { current: project ? { ...project, ...current } : null, retained: hook?.retained() };
    const keys = collectMedia(localRoots);
    const referenceData = includeAudit ? collectReferenceData(localRoots, "\u5F53\u524D\u753B\u5E03\u4E0E\u5386\u53F2") : void 0;
    if (referenceData) {
      referenceData.aliases.push(...getKnownMediaUrls().map(([url, key]) => [url, key, true]));
      appendReferenceData(referenceData, documentReferenceData(doc));
    }
    return {
      referenceData,
      keys: [...keys.keys()],
      projects: store.getState().projects.map((project2) => ({
        id: project2.id,
        keys: [...collectMedia(project2).keys()],
        referenceData: includeAudit ? collectReferenceData(project2, `\u753B\u5E03 ${project2.title || project2.id}`) : void 0
      })),
      liveProjectIds: hook ? [hook.projectId] : [],
      preserveAllMedia: !/^\/canvas(?:\/|$)/.test(location.pathname) || hasUnkeyedBlob(localRoots)
    };
  }

  // src/cleanup-progress.mjs
  var STEP_COUNT = 7;
  function releasedSpace(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  function installCleanupProgress(guard, doc) {
    const previousProgress = guard.cleanupProgress;
    if (previousProgress?.statisticsVersion !== 12 && previousProgress?.read().status !== "running") {
      let paint = function() {
        clearTimeout(paintTimer);
        paintTimer = null;
        const root2 = doc.querySelector("#canvas-save-guard")?.shadowRoot?.querySelector("#cleanup-progress");
        if (!root2) return;
        root2.hidden = state.status === "idle";
        if (state.status === "idle") return;
        root2.dataset.status = state.status;
        const title = root2.querySelector("#cleanup-progress-title");
        const stage = root2.querySelector("#cleanup-progress-stage");
        const bar = root2.querySelector("progress");
        const count = root2.querySelector("#cleanup-progress-count");
        const result = root2.querySelector("#cleanup-progress-result");
        const running = state.status === "running";
        title.textContent = running ? `\u6E05\u7406\u4E2D \xB7 \u7B2C ${state.step}/${STEP_COUNT} \u6B65` : state.status === "report" ? "\u5A92\u4F53\u6765\u6E90\u6838\u5BF9" : state.status === "complete" ? state.title || "\u6E05\u7406\u5B8C\u6210" : "\u6E05\u7406\u672A\u5B8C\u6210";
        stage.textContent = state.stage || "";
        if (state.percent === null) bar.removeAttribute("value");
        else bar.value = state.percent;
        bar.setAttribute("aria-valuetext", `${title.textContent}\uFF0C${stage.textContent}`);
        bar.hidden = state.status === "report";
        count.textContent = running && state.total !== null ? `${state.current}/${state.total} \u9879` : state.status === "complete" ? "100%" : "";
        result.textContent = state.result || "";
        result.style.whiteSpace = "pre-line";
        result.hidden = !state.result;
      }, update = function(progress) {
        if (state.status !== "running") return;
        const step = progress.step;
        if (step < state.step) return;
        const total = Number.isFinite(progress.total) ? progress.total : null;
        const current = total === null ? 0 : Math.min(progress.current || 0, total);
        if (step === state.step && progress.stage === state.stage && total === state.total && current < state.current) return;
        const fraction = total === null ? null : total === 0 ? 1 : current / total;
        state = {
          status: "running",
          step,
          stage: progress.stage,
          current,
          total,
          percent: fraction === null ? null : Math.min(99, Math.floor((step - 1 + fraction) / STEP_COUNT * 100))
        };
        if (paintTimer === null) paintTimer = setTimeout(paint, 80);
      };
      let state = previousProgress?.read() || { status: "idle" };
      let activeToken = null;
      let paintTimer = null;
      guard.cleanupProgress = {
        statisticsVersion: 12,
        read: () => ({ ...state }),
        paint,
        showReport(result) {
          if (state.status === "running") return;
          activeToken = null;
          state = { status: "report", stage: "\u53EA\u8BFB\u68C0\u67E5 \xB7 \u6CA1\u6709\u5220\u9664\u6587\u4EF6", result, percent: 100 };
          paint();
        },
        waiting(pending) {
          const shadow2 = doc.querySelector("#canvas-save-guard")?.shadowRoot;
          if (!shadow2) return;
          let notice = shadow2.getElementById("deletion-grace");
          if (!notice) {
            notice = doc.createElement("div");
            notice.id = "deletion-grace";
            notice.setAttribute("role", "status");
            shadow2.getElementById("status").after(notice);
          }
          notice.hidden = !pending?.total;
          if (pending?.total) {
            const messages = [];
            const objects = pending.objects ?? pending.total;
            if (objects) messages.push(`${objects} \u4E2A\u8282\u70B9\u3001\u5B50\u56FE\u6216\u8FDE\u7EBF\u5220\u9664\u9879\u4FDD\u7559\u4E00\u5206\u949F\uFF0C\u53EF\u6309 Ctrl\uFF0BZ \u64A4\u9500\u3002`);
            if (pending.projects) messages.push(`${pending.projects} \u5F20\u5DF2\u5220\u9664\u753B\u5E03\u7684\u6587\u4EF6\u4FDD\u7559\u4E00\u5206\u949F\u3002`);
            messages.push(`\u6700\u65E9\u4E8E ${new Date(pending.nextAt).toLocaleTimeString("zh-CN", { hour12: false })} \u540E\u6E05\u7406\u3002`);
            notice.textContent = messages.join("");
          }
        },
        start(token = null) {
          activeToken = token;
          state = { status: "running", step: 1, stage: "\u7B49\u5F85\u5F53\u524D\u4FDD\u5B58\u5B8C\u6210", current: 0, total: null, percent: null };
          paint();
        },
        update,
        receive(token, progress) {
          if (token === activeToken) update(progress);
        },
        complete(result) {
          guard.cleanupProgress.waiting(result.waiting);
          const files = result.keys.length + (result.sessionFiles || 0);
          const bytes = result.bytes + (result.sessionBytes || 0);
          const stats = result.statistics;
          const describe = (label, group) => `${label} ${group.files} \u4E2A\uFF0C${releasedSpace(group.bytes)}`;
          const lines = stats ? [
            describe("\u626B\u63CF\u5230\u5168\u7AD9\u6D4F\u89C8\u5668\u5A92\u4F53", stats.scanned),
            describe("\u672C\u6B21\u6E05\u7406", stats.removed),
            describe("\u6E05\u7406\u540E\u4FDD\u7559", stats.retained),
            describe("  \u4ECD\u88AB\u5F15\u7528", stats.inUse),
            describe("  \u65E0\u660E\u786E\u5220\u9664\u8BB0\u5F55", stats.untracked),
            describe("  \u5F15\u7528\u65E0\u6CD5\u5B8C\u6574\u6838\u5BF9", stats.unverifiable),
            "\u5A92\u4F53\u6309\u7F16\u53F7\u8BA1\u6570\uFF0C\u5927\u5C0F\u542B\u539F\u7AD9\u3001\u4FDD\u62A4\u526F\u672C\u53CA\u7F29\u7565\u56FE\uFF0C\u6570\u636E\u5E93\u989D\u5916\u5360\u7528\u53E6\u8BA1\u3002",
            "\u8FD9\u4E0D\u662F\u5F53\u524D\u5C4F\u5E55\u7684\u56FE\u7247\u6570\uFF1B\u70B9\u51FB\u201C\u7F13\u5B58\u6765\u6E90\u201D\u53EF\u67E5\u770B\u5F53\u524D\u753B\u5E03\u7684\u672C\u4F53\u3001\u53C2\u8003\u7D20\u6750\u53CA\u5177\u4F53\u5F15\u7528\u3002"
          ] : ["\u5F53\u524D\u9875\u9762\u4F7F\u7528\u65E7\u7248\u6E05\u7406\u63A5\u53E3\uFF0C\u6682\u672A\u63D0\u4F9B\u6570\u91CF\u548C\u5927\u5C0F\u660E\u7EC6\uFF1B\u8BF7\u5148\u4FDD\u5B58\u5B8C\u6574 ZIP\uFF0C\u518D\u91CD\u65B0\u6253\u5F00\u753B\u5E03\u542F\u7528\u7EDF\u8BA1\u3002"];
          if (result.deletionRecords) {
            const recorded = result.deletionRecords;
            lines.push(`\u5F53\u524D\u753B\u5E03\u7D2F\u8BA1\u8BB0\u5F55\u624B\u52A8\u5220\u9664 ${recorded.nodes} \u4E2A\u8282\u70B9\u3001${recorded.connections} \u6761\u8FDE\u7EBF\u3001${recorded.images} \u5F20\u7EC4\u5185\u56FE\u7247\uFF0C\u5BF9\u5E94 ${recorded.media} \u4E2A\u5A92\u4F53\u7F16\u53F7\u3002`);
          }
          if (result.deletedProjects?.total) lines.push(`\u53E6\u6838\u5BF9 ${result.deletedProjects.total} \u5F20\u5DF2\u660E\u786E\u5220\u9664\u7684\u753B\u5E03\uFF0C\u6D89\u53CA ${result.deletedProjects.media} \u4E2A\u5A92\u4F53\u7F16\u53F7\uFF0C\u5DF2\u79FB\u9664 ${result.deletedProjects.backups} \u4EFD\u753B\u5E03\u4FDD\u62A4\u526F\u672C\u3002`);
          if (stats?.untracked.files) lines.push("\u201C\u65E0\u660E\u786E\u5220\u9664\u8BB0\u5F55\u201D\u7EDF\u8BA1\u672C\u7F51\u7AD9\u4E2D\u5C1A\u672A\u5339\u914D\u5230\u5220\u9664\u6765\u6E90\u7684\u5A92\u4F53\uFF0C\u7EE7\u7EED\u4FDD\u7559\u3002");
          const waitingObjects = result.waiting?.objects ?? result.waiting?.total;
          if (waitingObjects) lines.push(`${waitingObjects} \u4E2A\u8282\u70B9\u3001\u5B50\u56FE\u6216\u8FDE\u7EBF\u5220\u9664\u9879\u4ECD\u5728\u4E00\u5206\u949F\u64A4\u9500\u4FDD\u7559\u671F\uFF0C\u6587\u4EF6\u4E0E\u64A4\u9500\u8BB0\u5F55\u7EE7\u7EED\u4FDD\u7559\u3002`);
          if (result.waiting?.projects) lines.push(`${result.waiting.projects} \u5F20\u5DF2\u5220\u9664\u753B\u5E03\u4ECD\u5728\u4E00\u5206\u949F\u6587\u4EF6\u4FDD\u7559\u671F\u3002`);
          if (result.untrackedMedia?.length) {
            for (const item of result.untrackedMedia.slice(0, 5)) {
              const owner = item.owners[0];
              lines.push(`${item.key} \xB7 ${releasedSpace(item.bytes)} \xB7 ${owner ? `\u6765\u6E90\u753B\u5E03 ${owner.projectId}\uFF0C\u8282\u70B9 ${owner.nodeId}` : "\u6B64\u524D\u672A\u8BB0\u5F55\u6587\u4EF6\u5F52\u5C5E"}`);
            }
            if (result.untrackedMedia.length > 5) lines.push(`\u53E6\u5916 ${result.untrackedMedia.length - 5} \u4E2A\u672A\u5339\u914D\u5220\u9664\u6765\u6E90\u7684\u5A92\u4F53\u7EE7\u7EED\u4FDD\u7559\u3002`);
          }
          if (result.audit) {
            lines.push(`\u5DF2\u6838\u5BF9\u4E34\u65F6\u5730\u5740 ${result.audit.checked} \u4E2A\uFF0C\u6309\u6587\u4EF6\u5185\u5BB9\u5339\u914D ${result.audit.contentMatched} \u4E2A\u3002`);
            if (result.audit.unresolved.length) {
              lines.push(`\u4ECD\u6709 ${result.audit.unresolved.length} \u5904\u5F15\u7528\u65E0\u6CD5\u5B8C\u6574\u6838\u5BF9\u3002`);
              for (const item of result.audit.unresolved.slice(0, 3)) lines.push(`${item.path}\uFF1A${item.reason}`);
            }
          }
          if (!files) lines.push(result.audit?.unresolved.length || stats?.unverifiable.files ? "\u672C\u6B21\u672A\u91CA\u653E\u6587\u4EF6\uFF1A\u5B58\u5728\u65E0\u6CD5\u6838\u5BF9\u7684\u4E34\u65F6\u5F15\u7528\uFF0C\u6682\u505C\u5220\u9664\u5F85\u6E05\u7406\u5A92\u4F53\u3002" : stats ? "\u672C\u6B21\u672A\u627E\u5230\u53EF\u6E05\u7406\u7684\u660E\u786E\u5220\u9664\u5A92\u4F53\u6587\u4EF6\u3002" : "\u672C\u6B21\u6CA1\u6709\u91CA\u653E\u5A92\u4F53\u6587\u4EF6\u3002");
          if (result.sessionFiles) lines.push(`\u53E6\u91CA\u653E\u4E34\u65F6\u4F1A\u8BDD\u6587\u4EF6 ${result.sessionFiles} \u4E2A\uFF0C${releasedSpace(result.sessionBytes || 0)}\u3002`);
          lines.push(`\u5DF2\u6E05\u7406 ${result.nodes} \u4E2A\u660E\u786E\u5220\u9664\u8282\u70B9\u3001${result.connections} \u6761\u660E\u786E\u5220\u9664\u8FDE\u7EBF\u7684\u5386\u53F2\u526F\u672C\u3002\u6E05\u7406\u8FC7\u7684\u5220\u9664\u64CD\u4F5C\u65E0\u6CD5\u64A4\u9500\u3002`);
          if (result.images) lines.push(`\u53E6\u6E05\u7406 ${result.images} \u4E2A\u5DF2\u5220\u9664\u7EC4\u5185\u56FE\u7247\u7684\u5386\u53F2\u526F\u672C\u3002`);
          state = {
            status: "complete",
            title: result.audit?.unresolved.length ? "\u6838\u5BF9\u5B8C\u6210 \xB7 \u7F13\u5B58\u6682\u7559" : "\u6E05\u7406\u5B8C\u6210",
            step: STEP_COUNT,
            stage: `\u5DF2\u91CA\u653E ${files} \u4E2A\u6587\u4EF6\uFF0C${releasedSpace(bytes)}`,
            current: 1,
            total: 1,
            percent: 100,
            result: lines.join("\n")
          };
          activeToken = null;
          paint();
        },
        fail(error) {
          const button = "\u6E05\u7406\u5220\u9664\u7F13\u5B58";
          state = { ...state, status: "failed", percent: state.percent ?? 0, stage: error.message || String(error), result: `\u53EF\u4EE5\u91CD\u65B0\u70B9\u51FB\u201C${button}\u201D\u68C0\u67E5\u5E76\u91CD\u8BD5\u3002` };
          activeToken = null;
          paint();
        }
      };
      if (!previousProgress && guard.cleanupDeleted && !guard.cleanupDetailedProgress) {
        const original = guard.cleanupDeleted;
        guard.cleanupDeleted = async (...args) => {
          if (state.status === "running") throw Error("\u6E05\u7406\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210\u3002");
          guard.cleanupProgress.start();
          try {
            const result = await original(...args);
            guard.cleanupProgress.complete(result);
            return result;
          } catch (error) {
            guard.cleanupProgress.fail(error);
            throw error;
          }
        };
        const requests = /* @__PURE__ */ new Map();
        window.addEventListener("message", (event) => {
          if (event.source !== window || state.status !== "running") return;
          const message = event.data;
          if (["canvas-guard-cleanup", "canvas-guard-cleanup-v2"].includes(message?.type)) {
            activeToken ||= message.data.token;
            if (activeToken !== message.data.token) return;
            requests.set(message.id, message.action);
            if (message.action === "prepare") update({ step: 2, stage: "\u6838\u5BF9\u753B\u5E03\u4E0E\u64A4\u9500\u8BB0\u5F55", total: null });
            if (message.action === "releaseMedia") update({ step: 6, stage: "\u91CA\u653E\u9875\u9762\u7F13\u5B58", total: null });
            if (message.action === "finish") update({ step: 7, stage: "\u6062\u590D\u9875\u9762\u64CD\u4F5C", total: null });
          } else if (message?.type === "canvas-guard-cleanup-result") {
            const action = requests.get(message.id);
            requests.delete(message.id);
            if (action === "prepare" && !message.error) update({ step: 3, stage: "\u6B63\u5728\u6838\u5BF9\u5F15\u7528\u5E76\u6E05\u7406\u7F13\u5B58", total: null });
          }
        });
      }
    }
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow || shadow.querySelector("#cleanup-progress")) return;
    const root = doc.createElement("div");
    root.id = "cleanup-progress";
    root.hidden = true;
    root.setAttribute("role", "status");
    root.setAttribute("aria-live", "polite");
    root.innerHTML = `<style>
    #cleanup-progress { margin-top: 9px; padding-top: 8px; border-top: 1px solid #7f87914d; font-size: 12px; }
    #cleanup-progress[hidden] { display: none; }
    #cleanup-progress-title { font-weight: 600; }
    #cleanup-progress-stage, #cleanup-progress-result { margin-top: 4px; overflow-wrap: anywhere; }
    #cleanup-progress progress { display: block; width: 100%; height: 8px; margin-top: 7px; accent-color: #2563eb; }
    #cleanup-progress progress[hidden] { display: none; }
    #cleanup-progress-count { text-align: right; font-variant-numeric: tabular-nums; }
    #cleanup-progress[data-status="failed"] { color: light-dark(#b52525, #ffb2ac); }
    #cleanup-progress[data-status="complete"] progress { accent-color: #248445; }
  </style>
  <div id="cleanup-progress-title"></div>
  <div id="cleanup-progress-stage"></div>
  <progress max="100" aria-label="\u6E05\u7406\u5220\u9664\u7F13\u5B58\u8FDB\u5EA6"></progress>
  <div id="cleanup-progress-count"></div>
  <div id="cleanup-progress-result" hidden></div>`;
    shadow.querySelector("#status").after(root);
    guard.cleanupProgress.paint();
  }

  // src/audit-upgrade.mjs
  function nativeModules(doc) {
    if (globalThis.CanvasSaveGuardNative) return Promise.resolve(globalThis.CanvasSaveGuardNative);
    if (![...doc.scripts].some((script) => script.src.includes("/10u8p1p4fll6y.js"))) {
      return Promise.reject(Error("\u7F51\u7AD9\u8D44\u6E90\u7248\u672C\u672A\u5339\u914D\uFF0C\u8BF7\u5148\u4FDD\u5B58\u5B8C\u6574 ZIP\u3002"));
    }
    return new Promise((resolve, reject) => {
      const id = `canvas-guard-audit-${crypto.randomUUID()}`;
      globalThis.TURBOPACK.push(["static/chunks/canvas-guard-audit.js", id, (context) => {
        try {
          resolve({ store: context.i(83629).useCanvasStore, images: context.i(7065), media: context.i(23241) });
        } catch (error) {
          reject(error);
        }
      }]);
      globalThis.TURBOPACK.push(["static/chunks/canvas-guard-audit.js", { otherChunks: [], runtimeModuleIds: [id] }]);
    });
  }
  async function persistedReferenceKeys() {
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB.open("infinite-canvas");
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = ["app_state", "image_generation_logs", "video_generation_logs"].filter((name) => db.objectStoreNames.contains(name));
      if (!names.length) return [];
      const transaction = db.transaction(names, "readonly");
      const values = await Promise.all(names.map((name) => new Promise((resolve, reject) => {
        const store = transaction.objectStore(name);
        const request = name === "app_state" ? store.get("infinite-canvas:asset_store") : store.getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      })));
      const keys = /* @__PURE__ */ new Map();
      for (const value of values) if (value) collectMedia(typeof value === "string" ? JSON.parse(value) : value, keys);
      return [...keys.keys()];
    } finally {
      db.close();
    }
  }
  function installAuditUpgrade(guard, doc) {
    if (guard.referenceAuditVersion === 1 || guard.deletedOnlyVersion !== 1 || !guard.cleanupEndpoint || !globalThis.CanvasSaveGuardHistory?.ready) return;
    const endpoint = guard.cleanupEndpoint;
    const originalPrepare = endpoint.prepare.bind(endpoint);
    const modulesReady = nativeModules(doc);
    modulesReady.catch(() => {
    });
    let modules;
    let summary = { nodes: 0, connections: 0 };
    let knownUrls = [];
    function roots() {
      if (!globalThis.CanvasSaveGuardHistory?.ready) throw Error("\u753B\u5E03\u5C1A\u672A\u8BFB\u53D6\u5B8C\u6210\uFF0C\u8BF7\u7B49\u5F85\u540E\u91CD\u8BD5\u3002");
      return readCleanupRoots(modules.store, globalThis.CanvasSaveGuardHistory, doc, true, () => knownUrls);
    }
    const leased = /* @__PURE__ */ new Set();
    const originalRelease = endpoint.release.bind(endpoint);
    endpoint.release = (token) => {
      leased.delete(token);
      return originalRelease(token);
    };
    endpoint.referenceAuditVersion = 1;
    endpoint.prepareAudit = async (token, prune) => {
      modules = await modulesReady;
      const hook = globalThis.CanvasSaveGuardHistory;
      const originalPrune = hook.prune;
      hook.prune = (...args) => {
        summary = originalPrune(...args);
        return summary;
      };
      let prepared;
      try {
        prepared = await originalPrepare(token, prune);
      } finally {
        hook.prune = originalPrune;
      }
      leased.add(token);
      await new Promise((resolve) => setTimeout(resolve, 0));
      knownUrls = await resolveKeys([...roots().keys, ...await persistedReferenceKeys()]);
      return { ...prepared, ...roots() };
    };
    endpoint.auditRoots = (token) => {
      if (!leased.has(token)) throw Error("\u7F13\u5B58\u6838\u5BF9\u4F1A\u8BDD\u5DF2\u7ED3\u675F\uFF0C\u8BF7\u91CD\u8BD5\u3002");
      return roots();
    };
    const fetchBlob = async (url) => {
      const response = await fetch(url);
      if (!response.ok) throw Error(`\u8BFB\u53D6\u4E34\u65F6\u56FE\u7247\u5931\u8D25\uFF1AHTTP ${response.status}`);
      return response.blob();
    };
    const resolveKeys = async (requestedKeys) => {
      const keys = [...new Set(requestedKeys.filter(mediaKey))];
      const aliases = [];
      for (let offset = 0; offset < keys.length; offset += 16) {
        const batch = keys.slice(offset, offset + 16);
        await Promise.all(batch.map(async (key) => {
          try {
            const resolve = key.startsWith("image:") ? modules.images.resolveImageUrl : modules.media.resolveMediaUrl;
            const url = await resolve(key, "");
            if (url?.startsWith("blob:")) aliases.push([url, key, true]);
          } catch {
          }
        }));
        guard.cleanupProgress?.update({ step: 2, stage: "\u6B63\u5728\u6838\u5BF9\u539F\u9875\u9762\u5A92\u4F53\u5730\u5740", current: Math.min(offset + batch.length, keys.length), total: keys.length });
      }
      return aliases;
    };
    guard.referenceAuditVersion = 1;
    guard.cleanupDeleted = async () => {
      modules = await modulesReady;
      summary = { nodes: 0, connections: 0 };
      return runMediaCleanup(guard, "deleted-audited", {
        flush: async () => {
          try {
            await guard.flush();
          } catch {
          }
        },
        fetchBlob,
        getSummary: () => summary
      });
    };
    installAutomaticDeletedCleanup(guard);
  }

  // src/panel-layout.mjs
  function installPanelLayout(doc) {
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow) return;
    installPanelShortcutBoundary(shadow.host, doc);
    const body = shadow.querySelector(".body");
    let information = shadow.querySelector("#panel-information");
    if (!information) {
      information = doc.createElement("div");
      information.id = "panel-information";
      body.prepend(information);
    }
    for (const id of ["status", "cleanup-progress", "detail"]) {
      const element = shadow.getElementById(id);
      if (element) information.append(element);
    }
    const style = shadow.querySelector("#fixed-panel-layout") || doc.createElement("style");
    style.id = "fixed-panel-layout";
    style.textContent = `
    section { height: 333px; max-height: calc(100dvh - 36px); display: flex; flex-direction: column; overflow: hidden; }
    section.closed { height: auto; }
    header { flex: 0 0 auto; }
    .body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
    #panel-information { flex: 1; min-height: 0; overflow-y: auto; padding-right: 2px; }
    #status { min-height: 18px; margin-top: 3px; font-size: 11px; }
    #deletion-grace { font-size: 11px; margin-top: 4px; color: light-dark(#775411,#dfc68b); line-height: 1.4; }
    #cleanup-progress:not([hidden]) { display: grid; grid-template-columns: 1fr auto; margin-top: 4px; padding-top: 4px; }
    #cleanup-progress-title { grid-column: 1; }
    #cleanup-progress-count { grid-column: 2; grid-row: 1; }
    #cleanup-progress-stage { grid-column: 1 / -1; min-height: 16px; margin-top: 2px; }
    #cleanup-progress progress { grid-column: 1 / -1; height: 6px; margin-top: 3px; }
    #cleanup-progress-result { height: 140px; max-height: 140px; overflow-y: auto; scrollbar-gutter: stable; }
    #cleanup-progress-result { grid-column: 1 / -1; margin-top: 3px; }
    #cleanup-progress-result[hidden] { display: none; }
    .buttons { flex: 0 0 auto; display: grid; grid-template-columns: repeat(3,minmax(0,1fr)); gap: 4px; margin-top: 6px; padding-top: 0; }
    .buttons button { padding: 3px 4px; font-size: 11px; line-height: 1.4; white-space: nowrap; }
    #compat { flex: 0 0 auto; margin-top: 5px; font-size: 10px; }
    section:has(#cleanup-progress:not([hidden])) #compat { display: none; }
    #detail { max-height: 72px; overflow-y: auto; }
    #panel-information, #cleanup-progress-result, #detail { scrollbar-width: thin; scrollbar-color: #8888 transparent; overscroll-behavior: contain; }
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-thumb { background: #8888; border-radius: 6px; }
    ::-webkit-scrollbar-track { background: transparent; }
  `;
    shadow.append(style);
    function placeRetryPanel() {
      const retry = doc.querySelector("#local-canvas-retry-panel");
      if (!retry) return;
      const bottom = Math.round(shadow.querySelector("section").getBoundingClientRect().height + 30);
      retry.style.bottom = `${bottom}px`;
      retry.style.setProperty("--guard-retry-bottom", `${bottom}px`);
    }
    if (!shadow.__guardPanelObserver) {
      shadow.__guardPanelObserver = new ResizeObserver(placeRetryPanel);
      shadow.__guardPanelObserver.observe(shadow.querySelector("section"));
    }
    placeRetryPanel();
  }

  // src/media-ownership.mjs
  function nodeMediaOwners(project, observedAt, knownUrls = []) {
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

  // src/native-compatibility.mjs
  var BATCH_VISUAL_VERSION = 21;
  function installNativeCompatibility(guard, doc, expectedVersion) {
    if (doc.location.hostname !== "canvas.best") return;
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow) return;
    let notice = shadow.getElementById("native-compatibility");
    if (!notice) {
      notice = doc.createElement("div");
      notice.id = "native-compatibility";
      notice.setAttribute("role", "status");
      notice.style.cssText = "font-size:11px;color:#c56827;line-height:1.5;margin-top:4px;overflow-wrap:anywhere";
      (shadow.getElementById("panel-information") || shadow.querySelector(".body")).prepend(notice);
    }
    const site = doc.defaultView.CanvasSaveGuardNative;
    const outdated = guard.version !== expectedVersion || site && site.batchVisualVersion !== BATCH_VISUAL_VERSION;
    notice.hidden = !outdated;
    notice.textContent = outdated ? `\u5F53\u524D\u9875\u9762\u4ECD\u4F7F\u7528\u65E7\u7248\u63D2\u4EF6\u63A5\u53E3\u3002\u8BF7\u4FDD\u5B58\u5F53\u524D\u753B\u5E03\uFF0C\u91CD\u65B0\u52A0\u8F7D\u6269\u5C55\u540E\u5237\u65B0\u753B\u5E03\uFF0C\u542F\u7528 ${expectedVersion} \u7684\u6700\u65B0\u4FDD\u62A4\u53CA\u7F13\u5B58\u6838\u5BF9\u3002` : "";
    notice.dataset.writerVersion = guard.version || "";
    notice.dataset.nativeVersion = site?.patchVersion || "";
    notice.dataset.batchVisualVersion = String(site?.batchVisualVersion || 0);
    const heading = shadow.querySelector("strong");
    if (heading) heading.textContent = `\u753B\u5E03\u52A9\u624B \xB7 ${guard.version || expectedVersion}`;
  }

  // src/project-recovery.mjs
  function reconcileRecordedDeletions(project, records) {
    const active = deletionWindow(records, project.id, Infinity).ready;
    if (!active.length) return project;
    const originalNodes = project.nodes || [];
    const originalConnections = project.connections || [];
    const deletedNodes = new Set(active.flatMap((record) => record.nodeIds || []));
    const deletedConnections = new Set(active.flatMap((record) => record.connectionIds || []));
    const imagesByNode = /* @__PURE__ */ new Map();
    for (const image of active.flatMap((record) => record.images || [])) {
      if (!imagesByNode.has(image.nodeId)) imagesByNode.set(image.nodeId, /* @__PURE__ */ new Set());
      imagesByNode.get(image.nodeId).add(image.imageId);
    }
    const nodes = pruneLegacyBatchNodes(originalNodes, deletedNodes).map((node) => {
      const removed = imagesByNode.get(node.id);
      if (!removed) return node;
      let next = node;
      for (const image of node.metadata?.images || []) {
        if (removed.has(image.id)) next = removeBatchImage(next, image.id);
      }
      return next;
    });
    const connections = originalConnections.filter((link) => !deletedConnections.has(link.id) && !deletedNodes.has(link.fromNodeId) && !deletedNodes.has(link.toNodeId));
    const unchanged = nodes.length === originalNodes.length && nodes.every((node, index) => node === originalNodes[index]) && connections.length === originalConnections.length;
    return unchanged ? project : { ...project, nodes, connections };
  }
  function removedHistoryObjects(current, next) {
    const nextNodes = new Map(next.nodes.map((node) => [node.id, node]));
    const nextConnections = new Set(next.connections.map((link) => link.id));
    const images = [];
    for (const node of current.nodes) {
      const remaining = nextNodes.get(node.id);
      if (!remaining) continue;
      const nextImages = new Set((remaining.metadata?.images || []).map((image) => image.id));
      for (const image of node.metadata?.images || []) {
        if (!nextImages.has(image.id)) images.push({ nodeId: node.id, image });
      }
    }
    return {
      nodes: current.nodes.filter((node) => !nextNodes.has(node.id)),
      connections: current.connections.filter((link) => !nextConnections.has(link.id)),
      images
    };
  }

  // src/media-report.mjs
  var categoryNames = { display: "\u56FE\u7247/\u5A92\u4F53\u672C\u4F53\u53CA\u7EC4\u5185\u7ED3\u679C", reference: "\u751F\u6210\u53C2\u8003\u7D20\u6750", other: "\u5176\u4ED6\u5F53\u524D\u753B\u5E03\u6570\u636E" };
  var size = (bytes) => bytes < 1024 ? `${bytes} B` : bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(2)} MB`;
  function currentMediaSources(project, knownUrls = []) {
    const aliases = new Map([...knownUrls, ...collectReferenceData(project, "").aliases]);
    const sources = /* @__PURE__ */ new Map(), unkeyedUrls = /* @__PURE__ */ new Set();
    const active = /* @__PURE__ */ new WeakSet();
    function visit(value, path, node) {
      if (typeof value === "string") {
        const textField = /(?:^|\.)(?:prompt|title|text|composerContent|errorDetails)$/.test(path) || path === "metadata.content" && ["text", "config"].includes(node?.type);
        const key = mediaKey(value) ? value : !textField && value.startsWith("blob:") ? aliases.get(value) : null;
        if (mediaKey(key)) {
          const category = /(?:^|\.)(?:references|referenceImages|referenceVideos|referenceAudios)(?:\.|\[|$)/.test(path) ? "reference" : node && /^metadata\.(?:storageKey|content|images\[\d+\]\.(?:storageKey|content))$/.test(path) ? "display" : "other";
          const owner = { category, nodeId: node?.id, title: node?.title, path };
          if (!sources.has(key)) sources.set(key, []);
          const list = sources.get(key);
          if (!list.some((item) => item.nodeId === owner.nodeId && item.path === path)) list.push(owner);
        } else if (!textField && value.startsWith("blob:")) unkeyedUrls.add(value);
        return;
      }
      if (!value || typeof value !== "object" || active.has(value)) return;
      active.add(value);
      if (Array.isArray(value)) value.forEach((item, i) => visit(item, `${path}[${i}]`, node));
      else for (const [name, item] of Object.entries(value)) visit(item, path ? `${path}.${name}` : name, node);
      active.delete(value);
    }
    for (const node of project.nodes || []) visit(node, "", node);
    for (const [field, value] of Object.entries(project)) if (field !== "nodes") visit(value, field);
    return { sources, unkeyedUrls: unkeyedUrls.size };
  }
  function createMediaReport(project, entries, records = [], knownUrls = []) {
    const { sources, unkeyedUrls } = currentMediaSources(project, knownUrls);
    const inventory2 = /* @__PURE__ */ new Map();
    for (const entry of entries) {
      if (!mediaKey(entry.key)) continue;
      if (!inventory2.has(entry.key)) inventory2.set(entry.key, { key: entry.key, bytes: 0, copies: [] });
      const file = inventory2.get(entry.key);
      file.bytes += entry.bytes;
      file.copies.push({ database: entry.database, store: entry.store, bytes: entry.bytes });
    }
    const mature = recordedDeletionKeys(records, project.id);
    const deleted = recordedDeletionKeys(records, project.id, Infinity);
    const groups = Object.fromEntries(["display", "reference", "other", "outsideCurrent"].map((name) => [name, { files: 0, bytes: 0 }]));
    const files = [];
    for (const file of inventory2.values()) {
      const owners = sources.get(file.key) || [];
      const category = ["display", "reference", "other"].find((name) => owners.some((owner) => owner.category === name)) || "outsideCurrent";
      groups[category].files += 1;
      groups[category].bytes += file.bytes;
      files.push({ ...file, owners, category, deletion: mature.has(file.key) ? "mature" : deleted.has(file.key) ? "waiting" : "none" });
    }
    return {
      projectId: project.id,
      title: project.title,
      nodes: project.nodes?.length || 0,
      at: (/* @__PURE__ */ new Date()).toISOString(),
      groups,
      files,
      currentFiles: sources.size,
      missingKeys: [...sources.keys()].filter((key) => !inventory2.has(key)),
      unkeyedUrls
    };
  }
  function formatMediaReport(report) {
    const describe = (name, group) => `${name} ${group.files} \u4E2A\uFF0C${size(group.bytes)}`;
    const original = report.files.flatMap((file) => file.copies).filter((copy) => copy.database === "infinite-canvas");
    const protectedCopies = report.files.flatMap((file) => file.copies).filter((copy) => copy.database === "canvas-save-guard");
    const bytes = report.files.reduce((total, file) => total + file.bytes, 0);
    const lines = [
      `\u5F53\u524D\u753B\u5E03\u300C${report.title || report.projectId}\u300D\u5171 ${report.nodes} \u4E2A\u8282\u70B9\uFF0C\u542B\u5C4F\u5E55\u5916\u3001\u6298\u53E0\u3001\u6B63\u5728\u751F\u6210\u548C\u5931\u8D25\u8282\u70B9\u3002`,
      `\u5F53\u524D\u753B\u5E03\u5171\u5F15\u7528 ${report.currentFiles} \u4E2A\u5A92\u4F53\u7F16\u53F7\uFF1A`,
      ...Object.entries(categoryNames).map(([name, label]) => describe(label, report.groups[name])),
      describe("\u5F53\u524D\u753B\u5E03\u672A\u5F15\u7528\u7684\u6D4F\u89C8\u5668\u5A92\u4F53", report.groups.outsideCurrent),
      `\u5168\u7AD9\u5A92\u4F53\u5E93\u5B58 ${report.files.length} \u4E2A\uFF0C${size(bytes)}\uFF1B\u4E0D\u662F\u5F53\u524D\u5C4F\u5E55\u56FE\u7247\u6570\u3002`,
      `\u539F\u7AD9\u6587\u4EF6/\u7F29\u7565\u56FE ${size(original.reduce((sum, copy) => sum + copy.bytes, 0))}\uFF1B\u4FDD\u62A4\u526F\u672C ${size(protectedCopies.reduce((sum, copy) => sum + copy.bytes, 0))}\u3002`,
      "\u5404\u5206\u7C7B\u6309\u7F16\u53F7\u53BB\u91CD\uFF1B\u540C\u4E00\u6587\u4EF6\u517C\u4F5C\u672C\u4F53\u548C\u53C2\u8003\u65F6\u8BA1\u5165\u672C\u4F53\u3002\u5927\u5C0F\u5305\u542B\u5404\u4EFD\u526F\u672C\u3002",
      "Windows \u7C98\u8D34/\u4E0A\u4F20\u7684\u56FE\u7247\u4F1A\u53E6\u5B58\u5230\u6D4F\u89C8\u5668\uFF1B\u8FD9\u91CC\u4E0D\u4F1A\u626B\u63CF\u6216\u6E05\u7406 Windows \u539F\u6587\u4EF6\u3001\u4E0B\u8F7D\u7684 ZIP\u3002",
      "\u5F53\u524D\u753B\u5E03\u672A\u5F15\u7528\u4E0D\u7B49\u4E8E\u53EF\u5220\u9664\uFF1A\u5176\u4ED6\u753B\u5E03\u3001\u8D44\u4EA7\u3001\u64A4\u9500\u8BB0\u5F55\u4E5F\u53EF\u80FD\u4F7F\u7528\u3002"
    ];
    if (report.missingKeys.length) lines.push(`\u6709 ${report.missingKeys.length} \u4E2A\u5F53\u524D\u5F15\u7528\u5728\u8FD9\u6B21\u5E93\u5B58\u5FEB\u7167\u4E2D\u6CA1\u6709\u6587\u4EF6\uFF1A${report.missingKeys.join("\u3001")}`);
    if (report.unkeyedUrls) lines.push(`\u53E6\u6709 ${report.unkeyedUrls} \u4E2A\u4E34\u65F6\u5730\u5740\u6CA1\u6709\u5DF2\u77E5\u7F16\u53F7\uFF0C\u672C\u62A5\u544A\u672A\u505A\u5185\u5BB9\u5339\u914D\uFF0C\u4E0D\u80FD\u636E\u6B64\u5224\u65AD\u53EF\u5220\u9664\u3002`);
    lines.push("\u4EE5\u4E0B\u662F\u68C0\u67E5\u65F6\u7684\u5F15\u7528\u6765\u6E90\uFF0C\u53EA\u8BFB\u68C0\u67E5\u6CA1\u6709\u5220\u9664\u4EFB\u4F55\u6587\u4EF6\uFF1A");
    for (const file of report.files.slice(0, 500)) {
      lines.push(`${file.key} \xB7 ${size(file.bytes)} \xB7 ${categoryNames[file.category] || "\u5F53\u524D\u753B\u5E03\u672A\u5F15\u7528"}`);
      if (file.deletion !== "none") lines.push(`  \u6709\u5F53\u524D\u753B\u5E03\u5220\u9664\u8BB0\u5F55${file.deletion === "waiting" ? "\uFF0C\u4ECD\u5728\u4E00\u5206\u949F\u4FDD\u7559\u671F" : ""}${file.owners.length ? "\uFF1B\u4ECD\u88AB\u4E0B\u9762\u7684\u5F53\u524D\u6570\u636E\u5F15\u7528" : ""}\u3002`);
      for (const owner of file.owners.slice(0, 8)) lines.push(`  ${owner.nodeId ? `\u8282\u70B9\u300C${(owner.title || owner.nodeId).slice(0, 36)}\u300D(${owner.nodeId})` : "\u753B\u5E03\u6570\u636E"} \u2192 ${owner.path}`);
      if (file.owners.length > 8) lines.push(`  \u53E6\u6709 ${file.owners.length - 8} \u5904\u5F53\u524D\u5F15\u7528\u3002`);
    }
    if (report.files.length > 500) lines.push(`\u4E3A\u4FDD\u6301\u754C\u9762\u6D41\u7545\uFF0C\u4EC5\u5C55\u5F00\u524D 500 \u4E2A\u7F16\u53F7\u7684\u6765\u6E90\uFF1B\u7EDF\u8BA1\u5305\u542B\u5168\u90E8 ${report.files.length} \u4E2A\u3002`);
    return lines.join("\n");
  }
  async function readDatabase(indexedDB2, name, stores, projectId) {
    if (!(await indexedDB2.databases()).some((database) => database.name === name)) return { entries: [], records: [] };
    const db = await new Promise((resolve, reject) => {
      const request = indexedDB2.open(name);
      request.onupgradeneeded = () => request.transaction.abort();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    try {
      const names = [...stores, ...name === "canvas-save-guard" ? ["cleanup_candidates"] : []].filter((store) => db.objectStoreNames.contains(store));
      if (!names.length) return { entries: [], records: [] };
      return await new Promise((resolve, reject) => {
        const result = { entries: [], records: [] };
        const transaction = db.transaction(names, "readonly");
        for (const store of names) {
          const request = transaction.objectStore(store).openCursor();
          request.onsuccess = () => {
            const cursor = request.result;
            if (!cursor) return;
            if (store === "cleanup_candidates") {
              if (cursor.value?.projectId === projectId) result.records.push(cursor.value);
            } else result.entries.push({ database: name, store, key: cursor.key, bytes: cursor.value?.size || cursor.value?.blob?.size || 0 });
            cursor.continue();
          };
        }
        transaction.oncomplete = () => resolve(result);
        transaction.onabort = () => reject(transaction.error || Error("\u5A92\u4F53\u6765\u6E90\u8BFB\u53D6\u4E2D\u65AD\u3002"));
        transaction.onerror = () => {
        };
      });
    } finally {
      db.close();
    }
  }
  async function inspectCurrentMedia(indexedDB2, project, knownUrls = []) {
    const results = await Promise.all([
      readDatabase(indexedDB2, "infinite-canvas", ["image_files", "media_files", "image_previews"], project.id),
      readDatabase(indexedDB2, "canvas-save-guard", ["media"], project.id)
    ]);
    return createMediaReport(project, results.flatMap((result) => result.entries), results.flatMap((result) => result.records), knownUrls);
  }
  function installMediaReport(guard, doc, getProject, getKnownUrls = () => []) {
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow) return;
    if (!getProject) getProject = () => {
      const id = decodeURIComponent(doc.location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
      return doc.defaultView.CanvasSaveGuardNative?.store?.getState().projects.find((project) => project.id === id);
    };
    if (!guard.inspectCurrentMedia) guard.inspectCurrentMedia = async () => {
      const project = getProject();
      if (!project) throw Error("\u8BF7\u5148\u6253\u5F00\u5177\u4F53\u753B\u5E03\uFF1B\u66F4\u65B0\u6269\u5C55\u540E\u53EF\u5237\u65B0\u753B\u5E03\u542F\u7528\u6765\u6E90\u68C0\u67E5\u3002");
      const hook = doc.defaultView.CanvasSaveGuardHistory;
      const snapshot = hook?.ready && hook.projectId === project.id ? { ...project, ...hook.snapshot() } : project;
      return inspectCurrentMedia(doc.defaultView.indexedDB, snapshot, getKnownUrls());
    };
    if (shadow.querySelector("#media-report")) return;
    const button = doc.createElement("button");
    button.id = "media-report";
    button.textContent = "\u7F13\u5B58\u6765\u6E90";
    button.title = "\u53EA\u8BFB\u6838\u5BF9\u5F53\u524D\u753B\u5E03\u7684\u5A92\u4F53\u7F16\u53F7\u3001\u5927\u5C0F\u548C\u5F15\u7528\u4F4D\u7F6E\uFF0C\u4E0D\u6267\u884C\u6E05\u7406\u3002";
    let busy = false;
    button.onclick = async () => {
      if (busy) return;
      busy = true;
      button.disabled = true;
      button.textContent = "\u6838\u5BF9\u4E2D\u2026";
      try {
        if (guard.cleanupProgress?.read().status === "running") throw Error("\u6E05\u7406\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u5B8C\u6210\u540E\u518D\u67E5\u770B\u6765\u6E90\u3002");
        const report = await guard.inspectCurrentMedia();
        if (guard.cleanupProgress?.read().status === "running") throw Error("\u6E05\u7406\u5DF2\u5F00\u59CB\uFF0C\u8BF7\u5B8C\u6210\u540E\u518D\u67E5\u770B\u6765\u6E90\u3002");
        guard.cleanupProgress.showReport(formatMediaReport(report));
      } catch (error) {
        shadow.querySelector("#status").textContent = error.message || String(error);
      } finally {
        busy = false;
        button.disabled = false;
        button.textContent = "\u7F13\u5B58\u6765\u6E90";
      }
    };
    shadow.querySelector(".buttons").append(button);
  }

  // src/grid-preference.mjs
  var STORAGE_KEY = "canvas-save-guard:grid-snap";
  function installGridSnapControl(guard, doc) {
    const win = doc.defaultView;
    if (!guard.gridPreferenceVersion) {
      let enabled = false;
      try {
        enabled = win.localStorage.getItem(STORAGE_KEY) === "1";
      } catch {
      }
      const paint = () => {
        const button2 = doc.querySelector("#canvas-save-guard")?.shadowRoot?.querySelector("#grid-snap");
        if (!button2) return;
        button2.textContent = `\u7F51\u683C\u5438\u9644 \xB7 ${enabled ? "\u5F00" : "\u5173"}`;
        button2.setAttribute("aria-checked", String(enabled));
        button2.style.background = enabled ? "#2563eb" : "";
        button2.style.color = enabled ? "#fff" : "";
      };
      guard.gridPreferenceVersion = 1;
      guard.getGridSnap = () => enabled;
      guard.setGridSnap = (value) => {
        enabled = !!value;
        try {
          win.localStorage.setItem(STORAGE_KEY, enabled ? "1" : "0");
        } catch {
        }
        paint();
      };
      guard.paintGridSnap = paint;
      win.addEventListener("storage", (event) => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        enabled = event.key === null ? false : event.newValue === "1";
        paint();
      });
    }
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow || shadow.querySelector("#grid-snap")) return;
    const button = doc.createElement("button");
    button.id = "grid-snap";
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", "\u7F51\u683C\u5438\u9644");
    button.title = "\u5168\u5C40\u534A\u683C\u5438\u9644\uFF0C\u6B65\u957F\u4E3A 24 \u753B\u5E03\u5355\u4F4D\uFF0C\u4E0E\u6574\u7406\u95F4\u8DDD\u4E00\u81F4\u3002\u9002\u7528\u4E8E\u6240\u6709\u753B\u5E03\u7684\u8282\u70B9\u548C\u5B50\u56FE\u62D6\u52A8\uFF0C\u6309\u4F4F Alt \u53EF\u4E34\u65F6\u81EA\u7531\u79FB\u52A8\u3002";
    button.onclick = () => guard.setGridSnap(!guard.getGridSnap());
    shadow.querySelector(".buttons").append(button);
    guard.paintGridSnap();
  }

  // src/descendant-preference.mjs
  var STORAGE_KEY2 = "canvas-save-guard:move-descendants";
  function installDescendantControl(guard, doc) {
    const win = doc.defaultView;
    if (!guard.descendantPreferenceVersion) {
      let enabled = false;
      try {
        enabled = win.localStorage.getItem(STORAGE_KEY2) === "1";
      } catch {
      }
      const paint = () => {
        const button2 = doc.querySelector("#canvas-save-guard")?.shadowRoot?.querySelector("#move-descendants");
        if (!button2) return;
        button2.textContent = `\u5E26\u52A8\u540E\u4EE3 \xB7 ${enabled ? "\u5F00" : "\u5173"}`;
        button2.setAttribute("aria-checked", String(enabled));
        button2.style.background = enabled ? "#2563eb" : "";
        button2.style.color = enabled ? "#fff" : "";
      };
      guard.descendantPreferenceVersion = 1;
      guard.getMoveDescendants = () => enabled;
      guard.setMoveDescendants = (value) => {
        enabled = !!value;
        try {
          win.localStorage.setItem(STORAGE_KEY2, enabled ? "1" : "0");
        } catch {
        }
        paint();
      };
      guard.paintMoveDescendants = paint;
      win.addEventListener("storage", (event) => {
        if (event.key !== STORAGE_KEY2 && event.key !== null) return;
        enabled = event.key !== null && event.newValue === "1";
        paint();
      });
    }
    const shadow = doc.querySelector("#canvas-save-guard")?.shadowRoot;
    if (!shadow || shadow.querySelector("#move-descendants")) return;
    const button = doc.createElement("button");
    button.id = "move-descendants";
    button.type = "button";
    button.setAttribute("role", "switch");
    button.setAttribute("aria-label", "\u79FB\u52A8\u65F6\u5E26\u52A8\u540E\u4EE3");
    button.title = "\u5F00\u542F\u540E\uFF0C\u62D6\u52A8\u8282\u70B9\u4F1A\u6CBF\u5411\u5916\u8FDE\u7EBF\u548C\u56FE\u7247\u7EC4\u5F52\u5C5E\u5E26\u52A8\u6240\u6709\u5C42\u7EA7\u7684\u540E\u4EE3\uFF0C\u4FDD\u6301\u76F8\u5BF9\u4F4D\u7F6E\u3002\u591A\u9009\u6216\u591A\u6761\u8DEF\u5F84\u5230\u8FBE\u540C\u4E00\u8282\u70B9\u65F6\u53EA\u79FB\u52A8\u4E00\u6B21\u3002";
    button.onclick = () => guard.setMoveDescendants(!guard.getMoveDescendants());
    shadow.querySelector(".buttons").append(button);
    guard.paintMoveDescendants();
  }

  // src/retry-flight.mjs
  function createRetryFlight(currentProjectId) {
    const active = /* @__PURE__ */ new Set();
    const keyFor = (projectId, nodeId, imageId) => JSON.stringify([projectId || currentProjectId(), nodeId, imageId || null]);
    const begin = (projectId, nodeId, imageId) => {
      const key = keyFor(projectId, nodeId, imageId);
      if (active.has(key)) return false;
      active.add(key);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active.delete(key);
      };
    };
    begin.has = (projectId, nodeId, imageId) => active.has(keyFor(projectId, nodeId, imageId));
    return begin;
  }

  // src/image-download.mjs
  async function prepareImageDownload(nodes, readBlob, fetchBlob, validate) {
    const media = /* @__PURE__ */ new Map(), files = [];
    let skipped = 0, temporaryIndex = 0;
    const images = nodes.filter((node) => node.type === "image");
    const storedKeys = new Set(images.map((node) => node.metadata?.storageKey).filter(Boolean));
    for (const [index, node] of images.entries()) {
      const metadata = node.metadata || {}, source = metadata.content;
      if (!metadata.storageKey && !/^(blob:|data:|https?:)/.test(source || "")) {
        skipped++;
        continue;
      }
      let key = metadata.storageKey;
      if (!key) {
        do {
          key = `image:download-${temporaryIndex++}`;
        } while (storedKeys.has(key));
      }
      let blob = media.get(key) || (metadata.storageKey ? await readBlob(key) : null);
      if (!blob && source) blob = await fetchBlob(source);
      if (!blob?.size) throw Error(`\u6240\u9009\u56FE\u7247\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\u300C${node.title || node.id}\u300D\u3002`);
      await validate(blob, key, { cache: !!metadata.storageKey });
      media.set(key, blob);
      const title = safeName(node.title || node.id || "\u56FE\u7247").slice(0, 100);
      files.push({ storageKey: key, path: `${String(index + 1).padStart(3, "0")}-${title}.${extension(blob.type, key)}`, bytes: blob.size });
    }
    if (!files.length) throw Error("\u9009\u4E2D\u7684\u5185\u5BB9\u4E2D\u8FD8\u6CA1\u6709\u53EF\u4E0B\u8F7D\u7684\u56FE\u7247\u6587\u4EF6\u3002");
    return { data: { projects: [{ files }] }, media, skipped };
  }

  // src/main.mjs
  installPointerPassthrough(document);
  installCleanupMessaging();
  installRetryPanel(document);
  if (globalThis.CanvasSaveGuard) {
    globalThis.CanvasSaveGuard.pointerPatchVersion = POINTER_PATCH_VERSION;
    const heading = document.querySelector("#canvas-save-guard")?.shadowRoot?.querySelector("strong");
    if (heading) heading.textContent = `\u753B\u5E03\u52A9\u624B \xB7 ${globalThis.CanvasSaveGuard.version || BUILD_VERSION}`;
    installLegacyRecheck(globalThis.CanvasSaveGuard, document);
    installCleanupUpgradeNotice(globalThis.CanvasSaveGuard, document);
    installCleanupProgress(globalThis.CanvasSaveGuard, document);
    installMediaReport(globalThis.CanvasSaveGuard, document);
    installGridSnapControl(globalThis.CanvasSaveGuard, document);
    installDescendantControl(globalThis.CanvasSaveGuard, document);
    installAuditUpgrade(globalThis.CanvasSaveGuard, document);
    installPanelLayout(document);
    installNativeCompatibility(globalThis.CanvasSaveGuard, document, BUILD_VERSION);
  }
  if (!globalThis.CanvasSaveGuard) start();
  function start() {
    const vault = new Vault(indexedDB);
    const services = {};
    const jobs = /* @__PURE__ */ new Set();
    const urls = /* @__PURE__ */ new Map();
    const sessionUrls = /* @__PURE__ */ new Map();
    const resolvingUrls = /* @__PURE__ */ new Map();
    const resolvingPreviews = /* @__PURE__ */ new Map();
    const protectionErrors = /* @__PURE__ */ new Map();
    const protectedSnapshots = /* @__PURE__ */ new Map();
    const pendingProjects = /* @__PURE__ */ new Map();
    const queuedProtection = /* @__PURE__ */ new Map();
    const validatedMedia = /* @__PURE__ */ new Set();
    const generationOwners = /* @__PURE__ */ new WeakMap();
    const recordedMediaOwners = /* @__PURE__ */ new Set();
    const observedObjects = /* @__PURE__ */ new Map();
    const projectSignatures = /* @__PURE__ */ new WeakMap();
    let pendingProjectDeletionWrites = 0;
    let canvasStore, rawStorage, previous = /* @__PURE__ */ new Map(), baseline = /* @__PURE__ */ new Map();
    let tail = Promise.resolve(), lastError = "", lastErrorProject = "", lastErrorSignature = null, deleted = /* @__PURE__ */ new Set(), bootedLate = document.readyState !== "loading";
    let ui, details = [], locked = false;
    let archiveActive = false;
    const retryFlight = createRetryFlight(currentId);
    const guard = globalThis.CanvasSaveGuard = {
      version: BUILD_VERSION,
      pointerPatchVersion: POINTER_PATCH_VERSION,
      clickPatched: false,
      status: () => ({ attached: !!canvasStore, pending: currentPending(), error: currentError(), protectedAt: currentProtection()?.at || "", clickPatched: guard.clickPatched, late: bootedLate, nativePatchVersion: globalThis.CanvasSaveGuardNative?.patchVersion || "", batchVisualVersion: globalThis.CanvasSaveGuardNative?.batchVisualVersion || 0 }),
      exportCurrent: () => exportProjects([currentProject()]),
      downloadSelectedImages,
      verify: verifyZip,
      flush: async () => {
        await flushJobs();
        const error = currentError();
        if (error) throw Error(error);
      },
      recheckCurrent: () => recheckCurrent(),
      attachCurrent: () => attachExisting(),
      persistentMediaVersion: 1,
      deletionGraceVersion: 1,
      withMediaAccess,
      beginRetry: retryFlight,
      isRetryPending: (nodeId, imageId) => retryFlight.has(currentId(), nodeId, imageId),
      connectStorage: (storage) => wrapStorage(storage),
      connectMedia: (exports, image) => wrapMedia(exports, image),
      connectSite: (site) => {
        globalThis.CanvasSaveGuardNative = site;
        attachStore(site.store);
        guard.clickPatched = true;
        installNativeCompatibility(guard, document, BUILD_VERSION);
      },
      exportProjects: (projects, name) => exportProjects(projects, name),
      copyImageToClipboard: (metadata) => {
        if (!navigator.clipboard?.write || !globalThis.ClipboardItem) return Promise.resolve();
        const png = (async () => {
          const blob = metadata.storageKey ? await readBlob(metadata.storageKey) : await fetchBlob(metadata.content);
          if (blob.type === "image/png") return blob;
          const bitmap = await createImageBitmap(blob), canvas = document.createElement("canvas");
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          canvas.getContext("2d").drawImage(bitmap, 0, 0);
          bitmap.close();
          return new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
        })();
        return navigator.clipboard.write([new ClipboardItem({ "image/png": png })]);
      },
      registerGenerationOwner: (signal, nodeId, requestKey) => {
        const imageId = requestKey !== nodeId ? JSON.parse(requestKey)[1] : void 0;
        generationOwners.set(signal, { projectId: currentId(), nodeId, imageId, startedAt: Date.now() });
      },
      protectGeneratedMedia: async (signal, action) => {
        const item = await action();
        const owner = generationOwners.get(signal);
        if (owner && item.storageKey) {
          await withMediaAccess(() => vault.recordGeneratedMedia(owner, item.storageKey));
          const node = canvasStore?.getState().projects.find((project) => project.id === owner.projectId)?.nodes.find((node2) => node2.id === owner.nodeId);
          if (!node) guard.scheduleDeletedCleanup?.(owner.projectId);
        }
        return item;
      },
      recordDeletedObjects: (projectId, nodes, connections, images = []) => {
        const snapshot = clone({ nodes, connections, images });
        const deletedAt = Date.now();
        job(() => withMediaAccess(() => vault.recordDeletedObjects(projectId, snapshot.nodes, snapshot.connections, snapshot.images, deletedAt))).catch(() => {
        });
      },
      recordDeletedProjects: (projects) => {
        if (!projects.length) return;
        const deletedAt = Date.now();
        pendingProjectDeletionWrites += 1;
        job(() => withMediaAccess(() => vault.recordDeletedProjects(projects, deletedAt))).then(() => guard.scheduleDeletedCleanup?.(currentId())).catch(() => {
        }).finally(() => {
          pendingProjectDeletionWrites -= 1;
        });
      },
      recordHistoryRedo: (projectId, current, next) => {
        const objects = removedHistoryObjects(current, next);
        if (!objects.nodes.length && !objects.connections.length && !objects.images.length) return;
        const snapshot = clone(objects);
        const deletedAt = Date.now();
        current[/* @__PURE__ */ Symbol.for("canvas-save-guard:undo-until")] = deletedAt + DELETION_GRACE_MS;
        job(() => withMediaAccess(() => vault.recordRedoneDeletedObjects(projectId, snapshot, deletedAt))).then((count) => {
          if (count) guard.scheduleDeletedCleanup?.(projectId);
        }).catch(() => {
        });
      }
    };
    const fail = (error) => {
      if (error?.code === "ZIP_BUSY") {
        render(error.message);
        return;
      }
      lastError = error?.message || String(error);
      lastErrorProject = currentId();
      lastErrorSignature = latestSignature(currentId());
      details = error?.missing?.map((m) => `${m.key}\uFF1A${m.reason}`) || error?.details || [];
      render();
    };
    function currentId() {
      return decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
    }
    function projectSignature(project) {
      if (!projectSignatures.has(project)) projectSignatures.set(project, signature(project));
      return projectSignatures.get(project);
    }
    function latestSignature(id) {
      const project = canvasStore?.getState().projects.find((p) => p.id === id);
      return project ? projectSignature(project) : null;
    }
    function currentPending() {
      return pendingProjects.get(currentId()) || 0;
    }
    function currentProtection() {
      const entry = protectedSnapshots.get(currentId());
      return entry?.signature === latestSignature(currentId()) ? entry : null;
    }
    function currentFailure() {
      const entry = protectionErrors.get(currentId());
      return entry?.signature === latestSignature(currentId()) ? entry : null;
    }
    function currentError() {
      return currentFailure()?.message || (lastErrorProject === currentId() && lastErrorSignature === latestSignature(currentId()) ? lastError : "");
    }
    function job(action, projectId) {
      if (projectId) pendingProjects.set(projectId, (pendingProjects.get(projectId) || 0) + 1);
      const promise = tail.then(action);
      jobs.add(promise);
      tail = promise.catch((error) => {
        if (!projectId) fail(error);
      });
      promise.finally(() => {
        jobs.delete(promise);
        if (projectId) pendingProjects.set(projectId, Math.max(0, (pendingProjects.get(projectId) || 0) - 1));
        render();
      }).catch(() => {
      });
      render();
      return promise;
    }
    async function flushJobs() {
      let pending;
      do {
        pending = tail;
        await pending;
      } while (pending !== tail);
    }
    async function withLock(action) {
      if (!navigator.locks) throw Error("\u5F53\u524D\u6D4F\u89C8\u5668\u4E0D\u652F\u6301\u4FDD\u5B58\u9501\uFF0C\u8BF7\u4F7F\u7528\u65B0\u7248 Edge \u6216 Chrome\u3002");
      return navigator.locks.request("canvas-save-guard:persist", action);
    }
    async function fetchBlob(url) {
      if (!/^(blob:|data:|https?:)/.test(url)) throw Error("\u65E0\u6548\u5A92\u4F53\u5730\u5740");
      const response = await fetch(url);
      if (!response.ok) throw Error(`\u8BFB\u53D6\u56FE\u7247\u5931\u8D25\uFF1AHTTP ${response.status}`);
      const blob = await response.blob();
      if (!blob.size) throw Error("\u56FE\u7247\u6587\u4EF6\u4E3A\u7A7A");
      return blob;
    }
    async function readBlob(key) {
      const protectedBlob = await vault.get("media", key);
      if (protectedBlob) return protectedBlob;
      const getter = key.startsWith("image:") ? services.getImageBlob : services.getMediaBlob;
      const blob = getter ? await getter(key) : null;
      return blob;
    }
    function rememberMediaUrl(key, url) {
      if (typeof url !== "string" || !url.startsWith("blob:")) return;
      urls.set(key, url);
      sessionUrls.set(url, key);
    }
    async function validateMedia(blob, key, { cache = true } = {}) {
      if (cache && validatedMedia.has(key)) return;
      if (!blob?.size) throw Error("\u5A92\u4F53\u6587\u4EF6\u4E3A\u7A7A");
      if (!key.startsWith("image:")) {
        if (cache) validatedMedia.add(key);
        return;
      }
      const image = new Image(), url = URL.createObjectURL(blob);
      try {
        image.src = url;
        await image.decode();
        if (!image.naturalWidth || !image.naturalHeight) throw Error("empty image");
        if (cache) validatedMedia.add(key);
      } catch {
        throw Error(`\u56FE\u7247\u6587\u4EF6\u65E0\u6CD5\u6B63\u5E38\u89E3\u7801\uFF1A${key}`);
      } finally {
        image.src = "";
        URL.revokeObjectURL(url);
      }
    }
    async function saveProject(project, force = false, observedAt = Date.now()) {
      const snapshotSignature = projectSignature(project);
      if (latestSignature(project.id) !== snapshotSignature) return;
      const persistentProject = project;
      const storedKeys = new Set(await vault.keys("media"));
      const files = /* @__PURE__ */ new Map(), missing = [];
      for (const [key, sources] of collectMedia(persistentProject)) {
        if (!force && storedKeys.has(key) && validatedMedia.has(key)) continue;
        let blob = await readBlob(key);
        if (!blob) for (const source of sources) {
          try {
            blob = await fetchBlob(source);
            if (blob) break;
          } catch {
          }
        }
        if (blob?.size) {
          try {
            if (force) validatedMedia.delete(key);
            await validateMedia(blob, key);
            if (!storedKeys.has(key)) files.set(key, blob);
          } catch {
            missing.push({ key, reason: "\u56FE\u7247\u65E0\u6CD5\u89E3\u7801" });
          }
        } else missing.push(key);
      }
      if (latestSignature(project.id) !== snapshotSignature) return;
      const owners = nodeMediaOwners(project, observedAt, [...urls].map(([key, url]) => [url, key])).filter((owner) => !recordedMediaOwners.has(JSON.stringify([owner.projectId, owner.nodeId, owner.imageId || null, owner.key])));
      await vault.protect([persistentProject], files, owners);
      for (const owner of owners) recordedMediaOwners.add(JSON.stringify([owner.projectId, owner.nodeId, owner.imageId || null, owner.key]));
      if (latestSignature(project.id) !== snapshotSignature) return;
      if (missing.length) throw Object.assign(Error(`\u672C\u5730\u4FDD\u62A4\u672A\u5B8C\u6210\uFF1A${missing.length} \u4E2A\u5A92\u4F53\u6587\u4EF6\u65E0\u6CD5\u8BFB\u53D6\u3002`), { details: missingMediaDetails(project, missing) });
      protectionErrors.delete(project.id);
      protectedSnapshots.set(project.id, { signature: snapshotSignature, at: (/* @__PURE__ */ new Date()).toLocaleTimeString("zh-CN", { hour12: false }) });
      if (lastErrorProject === project.id) {
        lastError = "";
        details = [];
      }
    }
    function protectProject(project, force = false) {
      const queued = queuedProtection.get(project.id);
      if (queued) {
        queued.project = project;
        queued.force ||= force;
        queued.observedAt = Date.now();
        return queued.promise;
      }
      const entry = { project, force, observedAt: Date.now(), promise: null };
      queuedProtection.set(project.id, entry);
      entry.promise = job(async () => {
        queuedProtection.delete(project.id);
        const snapshotSignature = projectSignature(entry.project), snapshot = JSON.parse(snapshotSignature);
        projectSignatures.set(snapshot, snapshotSignature);
        try {
          await withMediaAccess(() => saveProject(snapshot, entry.force, entry.observedAt));
        } catch (error) {
          if (latestSignature(snapshot.id) === snapshotSignature) protectionErrors.set(snapshot.id, { signature: snapshotSignature, message: error.message, details: error.details || [] });
          throw error;
        }
      }, project.id);
      return entry.promise;
    }
    async function recheckCurrent() {
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const project = currentProject();
      notice = "";
      lastError = "";
      details = [];
      protectionErrors.delete(project.id);
      await protectProject(project, true);
      render();
    }
    function attachStore(store) {
      if (canvasStore === store) return;
      canvasStore = store;
      const nativeDelete = store.getState().deleteProjects;
      if (nativeDelete) store.getState().deleteProjects = function(ids) {
        const removing = new Set(ids);
        guard.recordDeletedProjects(store.getState().projects.filter((project) => removing.has(project.id)));
        return nativeDelete.apply(this, arguments);
      };
      const observe = (state) => {
        const next = new Map(state.projects.map((p) => [p.id, projectSignature(p)]));
        for (const p of state.projects) if (previous.get(p.id) !== next.get(p.id)) {
          deleted.delete(p.id);
          notice = "";
          const objects = projectObjectIds(p), priorObjects = observedObjects.get(p.id);
          const restored = new Set([...objects].filter((id) => !priorObjects?.has(id)));
          observedObjects.set(p.id, objects);
          if (restored.size) {
            const observedAt = Date.now();
            job(() => withMediaAccess(() => vault.cancelRestoredDeletedObjects(p.id, restored, observedAt))).then((cancelled) => {
              if (cancelled) guard.scheduleDeletedCleanup?.(p.id);
            }).catch(() => {
            });
          }
          protectProject(p).catch(() => {
          });
        }
        for (const id of previous.keys()) if (!next.has(id)) {
          protectionErrors.delete(id);
          protectedSnapshots.delete(id);
          deleted.add(id);
          job(async () => {
            if ((await vault.get("deleted", id))?.source !== "user-delete-project") await vault.put("deleted", id, { id, at: (/* @__PURE__ */ new Date()).toISOString() });
          }).catch(() => {
          });
        }
        previous = next;
        render();
      };
      store.subscribe(observe);
      observe(store.getState());
    }
    function wrapStorage(storage) {
      if (storage.__canvasGuard) return storage;
      const get = storage.getItem.bind(storage), set = storage.setItem.bind(storage);
      rawStorage = { get, set };
      storage.getItem = async (key) => {
        const raw = await get(key);
        if (key !== STORE_KEY) return raw;
        const data = raw ? JSON.parse(raw) : { state: { projects: [] }, version: 0 };
        const [protectedProjects, tombstones, deletions] = await Promise.all([
          vault.all("projects"),
          vault.all("deleted"),
          vault.all("cleanup_candidates")
        ]);
        const loadingState = canvasStore?.getState();
        const loadingProjects = canvasStore?.persist?.hasHydrated() ? [] : loadingState?.projects || [];
        data.state.projects = newerProjects(
          data.state.projects || [],
          [...protectedProjects, ...loadingProjects],
          [...tombstones, ...data.state.deletedProjects || [], ...loadingState?.deletedProjects || []]
        ).filter((project) => !deleted.has(project.id)).map((project) => reconcileRecordedDeletions(project, deletions));
        baseline = new Map(data.state.projects.map((p) => [p.id, projectSignature(p)]));
        return JSON.stringify(data);
      };
      storage.setItem = (key, value) => withMediaAccess(async () => {
        if (key !== STORE_KEY) return set(key, value);
        const incoming = JSON.parse(value);
        const incomingSignatures = new Map(incoming.state.projects.map((p) => [p.id, projectSignature(p)]));
        const changed = incoming.state.projects.filter((p) => baseline.get(p.id) !== incomingSignatures.get(p.id));
        baseline = incomingSignatures;
        return withLock(async () => {
          const raw = await get(key), disk = raw ? JSON.parse(raw) : { state: { projects: [] }, version: 0 };
          const protectedProjects = await vault.all("projects"), tombstones = await vault.all("deleted");
          const merged = newerProjects(disk.state.projects || [], protectedProjects, [...tombstones, ...disk.state.deletedProjects || [], ...incoming.state.deletedProjects || []]);
          disk.state = { ...disk.state, ...incoming.state, projects: mergeProjects(merged, changed, deleted) };
          await set(key, JSON.stringify(disk));
        }).catch((error) => {
          fail(error);
          throw error;
        });
      });
      storage.__canvasGuard = true;
      return storage;
    }
    function wrapMedia(exports, image) {
      const getName = image ? "getImageBlob" : "getMediaBlob", setName = image ? "setImageBlob" : "setMediaBlob", uploadName = image ? "uploadImage" : "uploadMediaFile", resolveName = image ? "resolveImageUrl" : "resolveMediaUrl";
      for (const name of [getName, setName, image ? "deleteStoredImages" : "deleteStoredMedia"]) if (exports[name]) services[name] ||= exports[name];
      const get = exports[getName], set = exports[setName], upload = exports[uploadName];
      if (!get || !set) return exports;
      const result = { ...exports };
      result[getName] = async (key) => {
        const existing = await get(key);
        if (existing) return existing;
        const backup = await vault.get("media", key);
        if (backup) {
          rememberMediaUrl(key, await set(key, backup));
          const preview = image && exports.previewUrlFor?.(key);
          if (preview) sessionUrls.set(preview, key);
        }
        return backup;
      };
      result[setName] = (key, blob) => withMediaAccess(async () => {
        validatedMedia.delete(key);
        await validateMedia(blob, key);
        await vault.put("media", key, blob);
        const url = await set(key, blob);
        rememberMediaUrl(key, url);
        const preview = image && exports.previewUrlFor?.(key);
        if (preview) sessionUrls.set(preview, key);
        return url;
      });
      if (upload) result[uploadName] = (...args) => withMediaAccess(async () => {
        const requestOwner = generationOwners.get(args[1]?.signal);
        const owner = requestOwner && { ...requestOwner, imageId: args[1]?.guardImageId || requestOwner.imageId };
        const item = await upload(...args);
        if (item.storageKey && item.url) rememberMediaUrl(item.storageKey, item.url);
        const preview = image && exports.previewUrlFor?.(item.storageKey);
        if (preview) sessionUrls.set(preview, item.storageKey);
        if (item.storageKey) {
          const blob = await get(item.storageKey);
          if (!blob?.size) throw Error("\u56FE\u7247\u5165\u5E93\u5931\u8D25\uFF0C\u672A\u6807\u8BB0\u4E3A\u4FDD\u5B58\u6210\u529F\u3002");
          await validateMedia(blob, item.storageKey);
          await vault.put("media", item.storageKey, blob);
        }
        if (owner && item.storageKey) {
          await vault.recordGeneratedMedia(owner, item.storageKey);
          const node = canvasStore?.getState().projects.find((project) => project.id === owner.projectId)?.nodes.find((node2) => node2.id === owner.nodeId);
          if (!node || owner.imageId && !node.metadata?.images?.some((image2) => image2.id === owner.imageId)) guard.scheduleDeletedCleanup?.(owner.projectId);
        }
        return item;
      });
      result[resolveName] = async (key, fallback = "") => {
        if (!key) return fallback;
        if (urls.has(key)) return urls.get(key);
        let pending = resolvingUrls.get(key);
        if (!pending) {
          pending = (async () => {
            const blob = await result[getName](key);
            if (urls.has(key)) return urls.get(key);
            if (!blob) return null;
            const url = URL.createObjectURL(blob);
            rememberMediaUrl(key, url);
            return url;
          })().finally(() => resolvingUrls.delete(key));
          resolvingUrls.set(key, pending);
        }
        return await pending || fallback;
      };
      if (image) {
        for (const name of ["getImageBlob", "setImageBlob"]) services[name] = result[name];
        if (exports.ensureImagePreview) result.ensureImagePreview = (key) => {
          let pending = resolvingPreviews.get(key);
          if (!pending) {
            pending = Promise.resolve().then(() => exports.ensureImagePreview(key)).then((url) => {
              if (url) sessionUrls.set(url, key);
              return url;
            }).finally(() => resolvingPreviews.delete(key));
            resolvingPreviews.set(key, pending);
          }
          return pending;
        };
        if (exports.previewUrlFor) result.previewUrlFor = (key) => {
          const url = exports.previewUrlFor(key);
          if (url) sessionUrls.set(url, key);
          return url;
        };
      }
      result[image ? "cleanupUnusedImages" : "cleanupUnusedMedia"] = async () => {
      };
      return result;
    }
    function adaptExports(entries) {
      if (!Array.isArray(entries)) return entries;
      const values = {};
      for (let i = 0; i < entries.length; ) {
        const name = entries[i++], kind = entries[i++];
        if (kind === 0) values[name] = entries[i++];
        else if (typeof entries[i] === "function") i++;
      }
      let patched = { ...values };
      if (values.localForageStorage) patched.localForageStorage = wrapStorage(values.localForageStorage);
      if (values.getImageBlob) patched = wrapMedia(patched, true);
      if (values.getMediaBlob) patched = wrapMedia(patched, false);
      if (values.exportCanvasProjects) patched.exportCanvasProjects = exportProjects;
      if (values.useCanvasStore) attachStore(values.useCanvasStore);
      const out = entries.slice();
      for (let i = 0; i < out.length; ) {
        const name = out[i++], kind = out[i++];
        if (kind === 0) {
          out[i] = patched[name];
          i++;
        } else if (typeof out[i] === "function") i++;
      }
      return out;
    }
    const wrapped = /* @__PURE__ */ new WeakSet();
    function wrapChunk(chunk) {
      if (!Array.isArray(chunk)) return chunk;
      const out = chunk.slice();
      for (let i = 1; i < out.length; i++) if (typeof out[i] === "function" && !wrapped.has(out[i])) {
        const original = out[i];
        const factory = function(context, ...args) {
          const proxy = new Proxy(context, { get(target, key) {
            if (key === "s") return (entries, ...args2) => target.s(adaptExports(entries), ...args2);
            return Reflect.get(target, key);
          } });
          return original(proxy, ...args);
        };
        wrapped.add(factory);
        out[i] = factory;
      }
      return out;
    }
    function wrapRuntime(runtime) {
      if (!runtime || typeof runtime.push !== "function" || runtime.__canvasGuard) return runtime;
      if (Array.isArray(runtime)) for (let i = 0; i < runtime.length; i++) runtime[i] = wrapChunk(runtime[i]);
      const push = runtime.push;
      runtime.push = function(...chunks) {
        return push.apply(this, chunks.map(wrapChunk));
      };
      Object.defineProperty(runtime, "__canvasGuard", { value: true });
      return runtime;
    }
    if (location.hostname === "canvas.modelaryx.com") {
      let runtime = wrapRuntime(globalThis.TURBOPACK || []);
      Object.defineProperty(globalThis, "TURBOPACK", { configurable: true, get: () => runtime, set: (value) => {
        runtime = wrapRuntime(value);
      } });
    }
    function currentProject() {
      if (!canvasStore) throw Error("\u5C1A\u672A\u63A5\u5165\u753B\u5E03\u3002\u8BF7\u786E\u8BA4\u7F51\u7AD9\u7248\u672C\u53D7\u652F\u6301\u3002");
      const id = decodeURIComponent(location.pathname.match(/^\/canvas\/([^/]+)/)?.[1] || "");
      const project = canvasStore.getState().projects.find((p) => p.id === id);
      if (!project) throw Error("\u8BF7\u5728\u5177\u4F53\u753B\u5E03\u9875\u9762\u4F7F\u7528\u201C\u4FDD\u5B58\u5B8C\u6574 ZIP\u201D\u3002");
      return project;
    }
    function downloadSelectedImages(nodes) {
      return withArchive(async () => {
        const title = currentProject().title;
        render("\u6B63\u5728\u8BFB\u53D6\u6240\u9009\u56FE\u7247\u7684\u539F\u6587\u4EF6\u2026");
        const prepared = await withMediaAccess(() => prepareImageDownload(nodes, readBlob, fetchBlob, validateMedia));
        let updatedAt = 0;
        const zip = await makeZip(prepared, { filesOnly: true, onProgress: (done, total) => {
          if (done !== total && performance.now() - updatedAt < 120) return;
          updatedAt = performance.now();
          render(`\u6B63\u5728\u6253\u5305\u6240\u9009\u56FE\u7247 ${done} / ${total}`);
        } });
        const url = URL.createObjectURL(zip), anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `${safeName(title)}-\u6240\u9009\u56FE\u7247.zip`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(url), 6e4);
        lastError = "";
        details = [];
        render(`\u5DF2\u4E0B\u8F7D ${prepared.data.projects[0].files.length} \u5F20\u6240\u9009\u539F\u56FE${prepared.skipped ? `\uFF0C\u8DF3\u8FC7 ${prepared.skipped} \u4E2A\u5C1A\u65E0\u56FE\u7247\u6587\u4EF6\u7684\u9009\u4E2D\u9879` : ""}`);
        return true;
      }).catch((error) => {
        fail(error);
        return false;
      });
    }
    async function withArchive(action) {
      if (archiveActive) {
        const error = Error("\u5DF2\u6709 ZIP \u64CD\u4F5C\u6B63\u5728\u8FDB\u884C\uFF0C\u8BF7\u5B8C\u6210\u540E\u518D\u64CD\u4F5C\u3002");
        error.code = "ZIP_BUSY";
        throw error;
      }
      archiveActive = true;
      try {
        render();
        return await action();
      } finally {
        archiveActive = false;
        render();
      }
    }
    function exportProjects(projects, fileName) {
      return withArchive(async () => {
        if (!projects.length) throw Error("\u6CA1\u6709\u9009\u4E2D\u753B\u5E03\u3002");
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        await flushJobs();
        const fresh = projects.map((p) => canvasStore?.getState().projects.find((x) => x.id === p.id) || p);
        render("\u6B63\u5728\u6838\u5BF9\u5E76\u51C6\u5907\u5B8C\u6574\u753B\u5E03\u5907\u4EFD\u2026");
        const prepared = await withMediaAccess(() => prepareArchive(fresh, readBlob, fetchBlob, validateMedia));
        let lastProgress = 0;
        const progress = (label) => (current, total) => {
          if (current !== total && performance.now() - lastProgress < 120) return;
          lastProgress = performance.now();
          render(`${label} ${current} / ${total}`);
        };
        const zip = await makeZip(prepared, { onProgress: progress("\u6B63\u5728\u6253\u5305\u5A92\u4F53") });
        await verifyZip(zip, { retainEntries: false, onProgress: progress("\u6B63\u5728\u6821\u9A8C\u5A92\u4F53") });
        const anchor = document.createElement("a");
        anchor.href = URL.createObjectURL(zip);
        anchor.download = `${safeName(fileName || fresh[0].title)}-\u5B8C\u6574\u5907\u4EFD-${(/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-")}.zip`;
        anchor.click();
        setTimeout(() => URL.revokeObjectURL(anchor.href), 6e4);
        lastError = "";
        details = [];
        render(`\u5DF2\u6821\u9A8C\u5E76\u5BFC\u51FA ${prepared.data.projects.flatMap((p) => p.files).length} \u4E2A\u5A92\u4F53\u6587\u4EF6`);
        return zip;
      }).catch((error) => {
        fail(error);
        throw error;
      });
    }
    function importArchive(file) {
      return withArchive(async () => {
        if (!canvasStore) throw Error("\u5C1A\u672A\u63A5\u5165\u753B\u5E03");
        const checked = await verifyZip(file, { retainEntries: false });
        const remap = /* @__PURE__ */ new Map();
        for (const p of checked.data.projects) for (const f of p.files) {
          if (!remap.has(f.storageKey)) remap.set(f.storageKey, `${f.storageKey.split(":")[0]}:guard-${crypto.randomUUID()}`);
          const key = remap.get(f.storageKey), blob = new Blob([await checked.readEntry(f.path)], { type: f.mimeType });
          const setter = key.startsWith("image:") ? services.setImageBlob : services.setMediaBlob;
          if (!setter) throw Error("\u5A92\u4F53\u5B58\u50A8\u670D\u52A1\u5C1A\u672A\u52A0\u8F7D\uFF0C\u8BF7\u5148\u6253\u5F00\u4E00\u4E2A\u753B\u5E03\u3002");
          await validateMedia(blob, key);
          await vault.put("media", key, blob);
          await setter(key, blob);
        }
        const translate = (value, nodeType) => {
          if (typeof value === "string") return remap.get(value) || (value.startsWith("guard-file:") ? `guard-file:${remap.get(value.slice(11)) || value.slice(11)}` : value);
          if (Array.isArray(value)) return value.map((item) => translate(item, nodeType));
          if (value && typeof value === "object") {
            if (["image", "video", "audio", "text", "config"].includes(value.type || value.kind)) nodeType = value.type || value.kind;
            return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isMediaTextField(k, v, nodeType) ? v : translate(v, nodeType)]));
          }
          return value;
        };
        let id;
        const importedIds = [];
        for (const p of checked.data.projects) {
          id = canvasStore.getState().importProject({ ...translate(p.project), title: `${p.project.title}\uFF08\u6062\u590D\uFF09` });
          importedIds.push(id);
        }
        await flushJobs();
        for (const importedId of importedIds) {
          const failure = protectionErrors.get(importedId);
          if (failure?.signature === latestSignature(importedId)) throw Object.assign(Error(failure.message), { details: failure.details });
        }
        render(`\u5DF2\u6062\u590D ${checked.projects} \u5F20\u753B\u5E03\uFF0C\u53EF\u5728\u201C\u6211\u7684\u753B\u5E03\u201D\u6253\u5F00`);
        return id;
      });
    }
    function repairPointer() {
      window.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true }));
      window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keyup", { code: "Space", key: " ", bubbles: true }));
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      render("\u5DF2\u7ED3\u675F\u6B8B\u7559\u62D6\u52A8\uFF1B\u82E5\u53F3\u4E0B\u89D2\u6321\u4F4F\u56FE\u7247\uFF0C\u8BF7\u6536\u8D77\u91CD\u8BD5\u5DE5\u5177");
    }
    function attachExisting() {
      if (canvasStore) return;
      if (globalThis.CanvasSaveGuardNative) {
        guard.connectSite(globalThis.CanvasSaveGuardNative);
        return;
      }
      if (location.hostname === "canvas.best") {
        const supported = [...document.scripts].some((script) => script.src.includes("/assets/index-BcbSchFn.js"));
        render(supported ? "\u8BF7\u5148\u7528\u7F51\u7AD9\u5BFC\u51FA\u5F53\u524D\u753B\u5E03\uFF0C\u518D\u5237\u65B0\u4E00\u6B21\uFF0C\u52A0\u8F7D\u65B0\u7248\u753B\u5E03\u4FDD\u62A4\u63A5\u53E3\u3002" : "\u7AD9\u70B9\u8D44\u6E90\u5DF2\u66F4\u65B0\uFF0C\u8BF7\u66F4\u65B0\u6269\u5C55\u4EE5\u63A5\u5165\u8FD9\u4E2A\u7248\u672C\u3002");
        return;
      }
      if (!globalThis.TURBOPACK || Array.isArray(globalThis.TURBOPACK)) return;
      if (![...document.scripts].some((script) => script.src.includes("/10u8p1p4fll6y.js"))) {
        fail(Error("\u7F51\u7AD9\u8D44\u6E90\u7248\u672C\u672A\u5339\u914D\uFF0C\u672A\u63A5\u5165\u81EA\u52A8\u4FDD\u62A4\u3002"));
        return;
      }
      const id = `canvas-guard-attach-${crypto.randomUUID()}`;
      globalThis.TURBOPACK.push(["static/chunks/canvas-save-guard-attach.js", id, (context) => {
        try {
          wrapStorage(context.i(48566).localForageStorage);
          const images = context.i(7065), media = context.i(23241);
          for (const name of ["getImageBlob", "setImageBlob", "deleteStoredImages"]) services[name] ||= images[name];
          for (const name of ["getMediaBlob", "setMediaBlob", "deleteStoredMedia"]) services[name] ||= media[name];
          attachStore(context.i(83629).useCanvasStore);
        } catch (error) {
          fail(Error("\u7F51\u7AD9\u7248\u672C\u672A\u5339\u914D\uFF0C\u672A\u542F\u7528\u81EA\u52A8\u4FDD\u62A4\u3002" + error.message));
        }
      }]);
      globalThis.TURBOPACK.push(["static/chunks/canvas-save-guard-attach.js", { otherChunks: [], runtimeModuleIds: [id] }]);
    }
    function mount() {
      if (ui || !document.body) return;
      const host = document.createElement("aside");
      host.id = "canvas-save-guard";
      host.dataset.canvasShortcutsIgnore = "";
      host.style.cssText = "position:fixed;right:16px;bottom:18px;z-index:2147483647;max-width:350px;pointer-events:none";
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = `<style>:host{font:13px/1.5 system-ui,sans-serif;color-scheme:light dark}section{pointer-events:auto;background:light-dark(#fff,#24262b);color:light-dark(#252831,#f2f3f5);border:1px solid #7f87914d;border-radius:12px;padding:10px 12px;box-shadow:0 4px 24px #0002;width:310px;box-sizing:border-box}header{display:flex;align-items:center;justify-content:space-between;gap:12px}strong{font-size:13px}button{font:inherit;cursor:pointer;border:1px solid #7f879160;border-radius:7px;padding:5px 8px;background:transparent;color:inherit}button:hover{background:#7f879118}button:disabled{opacity:.5;cursor:wait}.buttons{display:flex;gap:6px;flex-wrap:wrap;margin-top:9px}#status{font-size:12px;margin-top:5px;word-break:break-word}#detail{white-space:pre-wrap;max-height:160px;overflow:auto;word-break:break-all;font-size:11px;margin:8px 0 0}small{display:block;color:light-dark(#646c79,#b4bbc6);font-size:11px;margin-top:7px}.bad{color:light-dark(#b52525,#ffb2ac)}section.closed{width:auto}.closed .body{display:none}#fold{padding:0 6px;border:0}</style><section><header><strong>\u753B\u5E03\u4FDD\u5B58\u4FDD\u62A4</strong><button id="fold" aria-label="\u6536\u8D77\u4FDD\u5B58\u5DE5\u5177">\u6536\u8D77</button></header><div class="body"><div id="status">\u6B63\u5728\u63A5\u5165\u753B\u5E03\u2026</div><div class="buttons"><button id="save">\u4FDD\u5B58\u5B8C\u6574 ZIP</button><button id="check">\u68C0\u67E5 ZIP</button><button id="restore">\u6062\u590D ZIP</button><button id="pointer">\u6062\u590D\u9F20\u6807</button><button id="retry">\u6536\u8D77\u91CD\u8BD5\u5DE5\u5177</button></div><small id="compat"></small><pre id="detail" hidden></pre></div></section>`;
      shadow.querySelector("strong").textContent = `\u753B\u5E03\u52A9\u624B \xB7 ${BUILD_VERSION}`;
      document.body.append(host);
      ui = shadow;
      shadow.querySelector("#fold").onclick = () => {
        const closed = shadow.querySelector("section").classList.toggle("closed");
        shadow.querySelector("#fold").textContent = closed ? "\u5C55\u5F00" : "\u6536\u8D77";
      };
      const run = (action) => async () => {
        if (locked) return;
        locked = true;
        render("\u6B63\u5728\u5904\u7406\u2026");
        try {
          await action();
        } catch (e) {
          fail(e);
        } finally {
          locked = false;
          render();
        }
      };
      const recheck = document.createElement("button");
      recheck.id = "recheck";
      recheck.textContent = "\u91CD\u65B0\u68C0\u67E5";
      shadow.querySelector(".buttons").prepend(recheck);
      recheck.onclick = run(() => guard.recheckCurrent());
      const cleanup = document.createElement("button");
      cleanup.id = "cleanup";
      cleanup.textContent = "\u6E05\u7406\u5220\u9664\u7F13\u5B58";
      cleanup.title = "\u5220\u9664\u9879\u4FDD\u7559\u4E00\u5206\u949F\u4F9B Ctrl\uFF0BZ \u64A4\u9500\uFF0C\u671F\u6EE1\u540E\u53EA\u6E05\u7406\u65E0\u4EBA\u5F15\u7528\u7684\u5BF9\u5E94\u7F13\u5B58\u3002";
      shadow.querySelector(".buttons").append(cleanup);
      cleanup.onclick = run(async () => {
        await guard.cleanupDeleted();
        lastError = "";
        details = [];
        notice = "";
        render();
      });
      shadow.querySelector("#save").onclick = run(() => guard.exportCurrent());
      function choose(action) {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".zip,application/zip";
        input.onchange = () => {
          if (input.files[0]) run(() => action(input.files[0]))();
        };
        input.click();
      }
      shadow.querySelector("#check").onclick = () => choose((file) => withArchive(async () => {
        const result = await verifyZip(file, { retainEntries: false });
        lastError = "";
        details = [];
        render(`\u68C0\u67E5\u901A\u8FC7\uFF1A${result.projects} \u5F20\u753B\u5E03\uFF0C${result.files} \u4E2A\u6587\u4EF6${result.hashed ? "\uFF0CSHA-256 \u6821\u9A8C\u901A\u8FC7" : "\uFF08\u65E7\u5305\u65E0\u6587\u4EF6\u6821\u9A8C\u503C\uFF09"}`);
      }));
      shadow.querySelector("#restore").onclick = () => choose(importArchive);
      shadow.querySelector("#pointer").onclick = repairPointer;
      shadow.querySelector("#retry").onclick = () => {
        const panel = document.querySelector("#local-canvas-retry-panel");
        if (!panel) {
          render("\u5F53\u524D\u9875\u9762\u6CA1\u6709\u6279\u91CF\u91CD\u8BD5\u5DE5\u5177");
          return;
        }
        const hidden = panel.style.display !== "none";
        panel.style.display = hidden ? "none" : "";
        shadow.querySelector("#retry").textContent = hidden ? "\u663E\u793A\u91CD\u8BD5\u5DE5\u5177" : "\u6536\u8D77\u91CD\u8BD5\u5DE5\u5177";
      };
      installCleanupProgress(guard, document);
      installMediaReport(guard, document, currentProject, () => [...sessionUrls]);
      installGridSnapControl(guard, document);
      installDescendantControl(guard, document);
      installPanelLayout(document);
      installNativeCompatibility(guard, document, BUILD_VERSION);
      render();
      attachExisting();
    }
    let notice = "";
    function render(message) {
      if (message) notice = message;
      if (!ui) return;
      const status = ui.querySelector("#status");
      const error = currentError();
      status.className = error ? "bad" : "";
      status.textContent = error || (currentPending() ? `\u6B63\u5728\u4FDD\u62A4\u5F53\u524D\u753B\u5E03\u7684 ${currentPending()} \u9879\u66F4\u65B0\uFF0C\u8BF7\u7B49\u5F85\u5B8C\u6210` : notice || (currentProtection() ? `\u5DF2\u4FDD\u62A4 \xB7 ${currentProtection().at}` : "\u6B63\u5728\u8BFB\u53D6\u5F53\u524D\u753B\u5E03\u2026"));
      const currentDetails = currentFailure()?.details || (lastErrorProject === currentId() ? details : []);
      ui.querySelector("#detail").hidden = !currentDetails.length;
      ui.querySelector("#detail").textContent = currentDetails.join("\n");
      ui.querySelector("#compat").textContent = "\u56FE\u7247\u5165\u5E93\u540E\u81EA\u52A8\u4FDD\u62A4\u3002\u5220\u9664\u9879\u4FDD\u7559\u4E00\u5206\u949F\uFF0C\u53EF Ctrl\uFF0BZ \u64A4\u9500\uFF1B\u671F\u6EE1\u540E\u6E05\u7406\u65E0\u4EBA\u5F15\u7528\u7684\u5BF9\u5E94\u7F13\u5B58\u3002";
      for (const button of ui.querySelectorAll("#save,#restore,#recheck,#cleanup")) button.disabled = locked || !canvasStore;
      for (const button of ui.querySelectorAll("#save,#restore")) button.disabled ||= archiveActive;
      ui.querySelector("#check").disabled = locked || archiveActive;
    }
    window.addEventListener("beforeunload", (event) => {
      if (locked || archiveActive || currentPending() || pendingProjectDeletionWrites || currentError()) {
        event.preventDefault();
        event.returnValue = "";
      }
    });
    installDeletedCleanup({
      guard,
      getStore: () => canvasStore,
      getServices: () => services,
      flush: flushJobs,
      getDeletedObjects: (projectId) => vault.deletedObjects(projectId, canvasStore?.getState().projects || [], canvasStore?.getState().deletedProjects || []),
      getKnownMediaUrls: () => [...sessionUrls],
      fetchBlob,
      releaseSessionMedia: (retained, candidates) => {
        for (const key of candidates) if (!retained.has(key)) {
          urls.delete(key);
          validatedMedia.delete(key);
        }
        for (const [url, key] of sessionUrls) if (candidates.has(key) && !retained.has(key)) {
          URL.revokeObjectURL(url);
          sessionUrls.delete(url);
        }
        return { files: 0, bytes: 0 };
      }
    });
    installAutomaticDeletedCleanup(guard);
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", mount, { once: true });
    else mount();
  }
})();
