import { isMediaTextField } from './media-fields.mjs';

export const STORE_KEY = 'infinite-canvas:canvas_store';
export const mediaKey = value => typeof value === 'string' && /^(image|video|audio|file|video-reference|audio-reference):[^\s]+$/.test(value);
export const clone = value => JSON.parse(JSON.stringify(value));
export const signature = value => JSON.stringify(value);

export function collectMedia(value, found = new Map(), visited = new WeakSet(), nodeType) {
  if (mediaKey(value)) {
    if (!found.has(value)) found.set(value, []);
  } else if (Array.isArray(value)) {
    if (visited.has(value)) return found;
    visited.add(value);
    value.forEach(item => collectMedia(item, found, visited, nodeType));
  } else if (value && typeof value === 'object') {
    if (visited.has(value)) return found;
    visited.add(value);
    if (['image', 'video', 'audio', 'text', 'config'].includes(value.type || value.kind)) nodeType = value.type || value.kind;
    if (mediaKey(value.storageKey)) {
      const sources = found.get(value.storageKey) || [];
      for (const field of ['content', 'dataUrl', 'url']) {
        if (typeof value[field] === 'string' && /^(blob:|data:|https?:)/.test(value[field])) sources.push(value[field]);
      }
      found.set(value.storageKey, [...new Set(sources)]);
    }
    for (const name of Object.keys(value)) {
      const item = value[name];
      if (!isMediaTextField(name,item,nodeType)) collectMedia(item, found, visited, nodeType);
    }
  }
  return found;
}

export function pendingNodes(project) {
  return project.nodes.filter(node => node.metadata?.status === 'loading');
}

export function mergeProjects(disk, changed, deleted = new Set()) {
  const merged = new Map(disk.filter(p => !deleted.has(p.id)).map(p => [p.id, p]));
  for (const p of changed) if (!deleted.has(p.id)) merged.set(p.id, p);
  return [...merged.values()];
}

export function newerProjects(disk, protectedProjects, tombstones = []) {
  const deleted = new Map();
  for (const tombstone of tombstones) {
    const at = tombstone.at || tombstone.deletedAt;
    if (at && (!deleted.has(tombstone.id) || at > deleted.get(tombstone.id))) deleted.set(tombstone.id, at);
  }
  const map = new Map();
  for (const p of [...disk, ...protectedProjects]) {
    const deletedAt = deleted.get(p.id);
    if (deletedAt && deletedAt >= (p.updatedAt || '')) continue;
    const prev = map.get(p.id);
    if (!prev || (p.updatedAt || '') >= (prev.updatedAt || '')) map.set(p.id, p);
  }
  return [...map.values()];
}

export function safeName(name) { return String(name).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 140) || '画布'; }
export function extension(type, key) {
  const types = {'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif','image/svg+xml':'svg','video/mp4':'mp4','video/webm':'webm','audio/mpeg':'mp3','audio/wav':'wav','audio/ogg':'ogg'};
  return types[type] || (key.startsWith('image:') ? 'png' : 'bin');
}
export async function sha256(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function prepareArchive(projects, readBlob, fetchBlob, validate = async()=>{}) {
  const snapshots = clone(projects);
  const media = new Map();
  const missing = [];
  const urlKeys = new Map();
  const external = new Map();
  function index(value, nodeType) {
    if (!value || typeof value !== 'object') return;
    if (['image','video','audio','text','config'].includes(value.type)) nodeType=value.type;
    if (mediaKey(value.storageKey)) {
      for (const field of ['content', 'dataUrl', 'url']) if (typeof value[field] === 'string') urlKeys.set(value[field], value.storageKey);
    } else {
      for (const field of ['content', 'dataUrl', 'url']) {
        if (typeof value[field] === 'string' && /^(blob:|data:image\/|data:video\/|data:audio\/|https?:)/.test(value[field])) {
          // Text nodes and prompts are text, even when their text happens to be a URL.
          if (field === 'content' && (['text','config'].includes(nodeType) || !('status' in value || 'naturalWidth' in value || 'mimeType' in value))) continue;
          external.set(value[field], value);
        }
      }
    }
    for (const [name,item] of Object.entries(value)) if (!isMediaTextField(name,item,nodeType)) {
      Array.isArray(item) ? item.forEach(child=>index(child,nodeType)) : index(item,nodeType);
    }
  }
  snapshots.forEach(item=>index(item));
  for (const [url, owner] of external) {
    if (!urlKeys.has(url)) {
      try {
        const blob = await fetchBlob(url);
        if (!blob || !blob.size) throw Error('空文件');
        const key = `${blob.type.startsWith('image/') ? 'image' : 'file'}:guard-${await sha256(await blob.arrayBuffer())}`;
        media.set(key, blob); urlKeys.set(url, key);
      } catch { missing.push({key: url.slice(0, 150), reason:'原地址无法读取'}); }
    }
    if (urlKeys.has(url)) owner.storageKey = urlKeys.get(url);
  }
  // Turn every bare blob reference into a real file reference; never write a session-only URL into a portable package.
  function rewrite(value, nodeType) {
    if (Array.isArray(value)) return value.map(item=>rewrite(item,nodeType));
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && value.startsWith('blob:')) {
        if (urlKeys.has(value)) return urlKeys.get(value);
        missing.push({key:value,reason:'临时地址没有对应的文件'});
      }
      return value;
    }
    if (['image', 'video', 'audio', 'text', 'config'].includes(value.type || value.kind)) nodeType = value.type || value.kind;
    const out = {};
    for (const [k,v] of Object.entries(value)) out[k] = isMediaTextField(k,v,nodeType) ? v : rewrite(v,nodeType);
    if (mediaKey(out.storageKey)) for (const field of ['content','dataUrl','url']) {
      if (!isMediaTextField(field,value[field],nodeType) && typeof value[field] === 'string' && /^(blob:|data:|https?:)/.test(value[field])) out[field] = `guard-file:${out.storageKey}`;
    }
    return out;
  }
  // Known content URLs are handled by their owner, so rewriting them is safe.
  const normalized = snapshots.map(project=>rewrite(project));
  const exported = [];
  for (const project of normalized) {
    if (pendingNodes(project).length) throw Error(`“${project.title}”还有 ${pendingNodes(project).length} 项正在生成，请完成后再导出。`);
    const files = [];
    for (const [key, sources] of collectMedia(project)) {
      let blob = media.get(key) || await readBlob(key);
      if (!blob) {
        const originals = collectMedia(snapshots.find(p => p.id === project.id)).get(key) || sources;
        for (const url of originals) {
          try { blob = await fetchBlob(url); if (blob?.size) break; } catch {}
        }
      }
      if (!blob?.size) { missing.push({key,reason:'图片或媒体文件缺失'}); continue; }
      await validate(blob,key);
      media.set(key,blob);
      files.push({storageKey:key,path:`projects/${safeName(project.id)}/files/${safeName(key)}.${extension(blob.type,key)}`,mimeType:blob.type||'application/octet-stream',bytes:blob.size,sha256:await sha256(await blob.arrayBuffer())});
    }
    exported.push({project,files});
  }
  if (missing.length) {
    const error = Error(`无法完整导出：缺少 ${new Set(missing.map(m=>m.key)).size} 个文件。未生成有缺图的压缩包。`);
    error.missing = missing; throw error;
  }
  return {data:{app:'infinite-canvas',version:3,exportedAt:new Date().toISOString(),projects:exported}, media};
}
