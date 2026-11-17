import { mediaKey, sha256 } from './core.mjs';
import { isMediaTextField } from './media-fields.mjs';

// Keep actual media fields separate from prompt/text literals when resolving
// temporary URLs. Keys collected elsewhere still provide conservative roots.
export function collectReferenceData(value, label, includeUrls = true) {
  const data = { aliases: [], urls: [] };
  const visited = new WeakSet();
  function visit(item, path, nodeType) {
    if (typeof item === 'string') {
      if (includeUrls && item.startsWith('blob:')) data.urls.push({ url: item, path });
      return;
    }
    if (!item || typeof item !== 'object') return;
    if (visited.has(item)) return;
    visited.add(item);
    if (Array.isArray(item)) {
      item.forEach((child, index) => visit(child, `${path}[${index}]`, nodeType));
      return;
    }
    const type = item.type || item.kind;
    if (['image', 'video', 'audio', 'text', 'config'].includes(type)) nodeType = type;
    const key = item.storageKey || item.data?.storageKey || item.metadata?.storageKey;
    if (mediaKey(key)) {
      for (const name of ['content', 'url', 'dataUrl', 'coverUrl']) {
        if (typeof item[name] === 'string' && item[name].startsWith('blob:')) data.aliases.push([item[name], key]);
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

export function appendReferenceData(target, data) {
  target.aliases.push(...data.aliases);
  target.urls.push(...data.urls);
}

export function documentReferenceData(doc) {
  const data = { aliases: [], urls: [] };
  for (const element of doc.querySelectorAll('img, video, audio, source, object, embed, [href^="blob:"], [style*="blob:"]')) {
    const values = [element.currentSrc, element.getAttribute('src'), element.getAttribute('poster'), element.getAttribute('data'), element.getAttribute('href'), element.getAttribute('srcset'), element.getAttribute('style')];
    for (const value of values) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(/blob:[^\s"'),]+/g)) data.urls.push({ url: match[0], path: `画布界面/${element.tagName}` });
    }
  }
  return data;
}

export async function auditTemporaryReferences(data, entries, readBlob, fetchBlob, progress) {
  const aliases = new Map();
  const cached = new Set();
  for (const [url, key, fromCache] of data.aliases) {
    if (!mediaKey(key)) continue;
    if (!aliases.has(url)) aliases.set(url, new Set());
    aliases.get(url).add(key);
    if (fromCache) cached.add(url);
  }
  const urls = new Map();
  for (const item of data.urls) if (!urls.has(item.url)) urls.set(item.url, item.path);
  const keys = new Set();
  const unresolved = [];
  const hashes = new Map();
  let checked = 0;
  let contentMatched = 0;
  progress({ step: 4, stage: '正在核对临时媒体引用', current: 0, total: urls.size });
  for (const [url, path] of urls) {
    if (aliases.has(url)) for (const key of aliases.get(url)) keys.add(key);
    if (!cached.has(url)) {
      let fetched = false;
      try {
        const blob = await fetchBlob(url);
        fetched = true;
        if (!blob?.size) throw Error('临时文件为空');
        const hash = await sha256(await blob.arrayBuffer());
        let matched = false;
        const matchingSize = entries.filter(entry => entry.bytes === blob.size);
        let compared = 0;
        for (const entry of matchingSize) {
          const identity = `${entry.database}/${entry.store}/${entry.key}`;
          if (!hashes.has(identity)) {
            const candidate = await readBlob(entry);
            if (!candidate?.arrayBuffer) throw Error('缓存文件格式无法核对');
            hashes.set(identity, await sha256(await candidate.arrayBuffer()));
          }
          if (hashes.get(identity) === hash) { keys.add(entry.key); matched = true; }
          compared += 1;
          if (compared % 16 === 0 || compared === matchingSize.length) progress({
            step: 4, stage: `临时地址 ${checked + 1}/${urls.size}，候选文件 ${compared}/${matchingSize.length}`,
            current: checked, total: urls.size,
          });
        }
        if (matched) contentMatched += 1;
        // A readable blob without a disk copy stays in its existing live owner.
        // The sweep never revokes arbitrary URLs or modifies scene metadata.
      } catch (error) {
        if (fetched || !aliases.has(url)) unresolved.push({ url, path, reason: error.message || String(error) });
      }
    }
    checked += 1;
    progress({ step: 4, stage: '正在核对临时媒体引用', current: checked, total: urls.size });
  }
  return { keys: [...keys], unresolved, checked, contentMatched };
}
