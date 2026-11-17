import { collectDeletedMedia, recordedDeletionKeys } from './deleted-history.mjs';
import { DELETION_GRACE_MS, deletionObjectIds, deletionWindow } from './deletion-grace.mjs';
import { projectMediaKeys, projectDeletionWindow } from './project-deletion.mjs';

export class Vault {
  constructor(indexedDB, name = 'canvas-save-guard') { this.indexedDB=indexedDB; this.name=name; this.opened=null; }
  open() {
    if (!this.opened) this.opened = new Promise((resolve,reject)=>{
      const request=this.indexedDB.open(this.name,2);
      request.onupgradeneeded=()=>{
        for (const name of ['projects','media','deleted','cleanup_candidates']) {
          if (!request.result.objectStoreNames.contains(name)) request.result.createObjectStore(name);
        }
      };
      request.onsuccess=()=>{ const db=request.result; db.onversionchange=()=>{db.close();this.opened=null;};resolve(db); };
      request.onerror=()=>{this.opened=null;reject(request.error);};
      request.onblocked=()=>reject(Error('本地保护数据库被其他页面阻塞。'));
    });
    return this.opened;
  }
  async transaction(store, mode, action) {
    const db=await this.open();
    return new Promise((resolve,reject)=>{
      const tx=db.transaction(store,mode); let result;
      const request=action(tx.objectStore(store));
      if (request) request.onsuccess=()=>{result=request.result;};
      tx.oncomplete=()=>resolve(result); tx.onabort=()=>reject(tx.error||Error('本地保护写入已中断')); tx.onerror=()=>{};
    });
  }
  get(store,key) { return this.transaction(store,'readonly',s=>s.get(key)); }
  all(store) { return this.transaction(store,'readonly',s=>s.getAll()); }
  keys(store) { return this.transaction(store,'readonly',s=>s.getAllKeys()); }
  put(store,key,value) { return this.transaction(store,'readwrite',s=>s.put(value,key)); }
  async recordDeletedMedia(projectId, keys) {
    if (!keys.length) return;
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('cleanup_candidates', 'readwrite');
      for (const key of keys) transaction.objectStore('cleanup_candidates').put({ projectId, key }, `${projectId}/${key}`);
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || Error('删除缓存记录写入中断。'));
      transaction.onerror = () => {};
    });
  }
  async recordDeletedObjects(projectId, nodes, connections, images = [], deletedAt = Date.now()) {
    if (!nodes.length && !connections.length && !images.length) return Promise.resolve();
    const entries = [
      ...nodes.map(node => ({ nodeIds: [node.id], keys: [...collectDeletedMedia([node]).keys()] })),
      ...connections.map(link => ({ connectionIds: [link.id], keys: [] })),
      ...images.map(item => ({ images: [{ nodeId: item.nodeId, imageId: item.image.id }], keys: [...collectDeletedMedia([{ metadata: { images: [item.image] } }]).keys()] })),
    ];
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('cleanup_candidates', 'readwrite');
      for (const entry of entries) {
        const record = { nodeIds: [], connectionIds: [], images: [], ...entry, source: 'user-delete', projectId, deletedAt, cleanupAfter: deletedAt + DELETION_GRACE_MS };
        transaction.objectStore('cleanup_candidates').put(record, `user-delete:${projectId}/${deletionObjectIds(record)[0]}`);
      }
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || Error('删除缓存记录写入中断。'));
      transaction.onerror = () => {};
    });
  }
  async recordDeletedProjects(projects, deletedAt = Date.now()) {
    if (!projects.length) return;
    const db = await this.open();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction('deleted', 'readwrite');
      for (const project of projects) {
        const store = transaction.objectStore('deleted');
        const request = store.get(project.id);
        request.onsuccess = () => {
          const previous = request.result;
          if (Date.parse(previous?.at) > deletedAt) return;
          store.put({ id: project.id, at: new Date(deletedAt).toISOString(), source: 'user-delete-project', keys: [...projectMediaKeys(project)] }, project.id);
        };
      }
      transaction.oncomplete = resolve;
      transaction.onabort = () => reject(transaction.error || Error('画布删除记录写入中断。'));
      transaction.onerror = () => {};
    });
  }
  async cancelRestoredDeletedObjects(projectId, restored, observedAt) {
    if (!restored.size) return 0;
    const db = await this.open();
    return new Promise((resolve, reject) => {
      let cancelled = 0;
      const transaction = db.transaction('cleanup_candidates', 'readwrite');
      const request = transaction.objectStore('cleanup_candidates').openCursor();
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) return;
        const record = cursor.value;
        if (record.source === 'user-delete' && record.projectId === projectId && !record.cancelled && (record.deletedAt || 0) <= observedAt && deletionObjectIds(record).some(id => restored.has(id))) {
          const objectIds = deletionObjectIds(record);
          const cancelledObjects = new Set(record.cancelledObjects || []);
          for (const id of objectIds) if (restored.has(id)) cancelledObjects.add(id);
          cursor.update({ ...record, cancelled: objectIds.every(id => cancelledObjects.has(id)), cancelledObjects: [...cancelledObjects], cancelledAt: observedAt });
          cancelled += 1;
        }
        cursor.continue();
      };
      transaction.oncomplete = () => resolve(cancelled);
      transaction.onabort = () => reject(transaction.error || Error('撤销删除记录更新中断。'));
      transaction.onerror = () => {};
    });
  }
  recordGeneratedMedia(owner, key) {
    return this.put('cleanup_candidates', `generated-media:${owner.projectId}/${key}`, {
      ...owner, key, source: 'generated-media',
    });
  }
  async recordRedoneDeletedObjects(projectId, objects, deletedAt) {
    const records = await this.all('cleanup_candidates');
    const authorized = new Set(records
      .filter(record => record.projectId === projectId && record.source === 'user-delete')
      .flatMap(deletionObjectIds));
    const nodes = objects.nodes.filter(node => authorized.has(JSON.stringify(['node', node.id])));
    const connections = objects.connections.filter(link => authorized.has(JSON.stringify(['connection', link.id])));
    const images = objects.images.filter(item => authorized.has(JSON.stringify(['image', item.nodeId, item.image.id])));
    if (!nodes.length && !connections.length && !images.length) return 0;
    await this.recordDeletedObjects(projectId, nodes, connections, images, deletedAt);
    return nodes.length + connections.length + images.length;
  }
  async deletedObjects(projectId, liveProjects = [], nativeTombstones = []) {
    const [all, projects, tombstones] = await Promise.all([this.all('cleanup_candidates'), this.all('projects'), this.all('deleted')]);
    const window = deletionWindow(all, projectId);
    const projectWindow = projectDeletionWindow({ nativeTombstones, tombstones, projects, liveProjects, records: all });
    const nextAt = [window.waiting.nextAt, projectWindow.waiting.nextAt].filter(Number.isFinite);
    const records = window.ready;
    const mediaKeys = [...recordedDeletionKeys(all, projectId)];
    return {
      nodeIds: [...new Set(records.flatMap(record => record.nodeIds))],
      connectionIds: [...new Set(records.flatMap(record => record.connectionIds))],
      images: records.flatMap(record => record.images || []),
      mediaKeys,
      projectDeletions: projectWindow.ready,
      revision: JSON.stringify([records.map(record=>[deletionObjectIds(record),record.deletedAt,record.cleanupAfter]),mediaKeys,projectWindow.ready]),
      waiting: { total: window.waiting.total + projectWindow.waiting.total,
        objects: window.waiting.total, projects: projectWindow.waiting.total,
        nextAt: nextAt.length ? Math.min(...nextAt) : null },
    };
  }
  async protect(projects, files = new Map(), owners = []) {
    const db=await this.open();
    await new Promise((resolve,reject)=>{
      const tx=db.transaction(owners.length?['projects','media','cleanup_candidates']:['projects','media'],'readwrite');
      tx.oncomplete=resolve;tx.onabort=()=>reject(tx.error||Error('本地保护写入已中断'));tx.onerror=()=>{};
      try {
        for (const project of projects) tx.objectStore('projects').put(project,project.id);
        for (const [key,blob] of files) tx.objectStore('media').put(blob,key);
        for (const owner of owners) tx.objectStore('cleanup_candidates').put({ ...owner, source: 'node-media' }, `node-media:${JSON.stringify([owner.projectId,owner.nodeId,owner.imageId||null,owner.key])}`);
      } catch(error) { tx.abort();reject(error); }
    });
  }
}
