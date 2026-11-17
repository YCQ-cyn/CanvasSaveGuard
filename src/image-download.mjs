import { safeName, extension } from './core.mjs';

export async function prepareImageDownload(nodes, readBlob, fetchBlob, validate) {
  const media = new Map(), files = [];
  let skipped = 0, temporaryIndex = 0;
  const images = nodes.filter(node => node.type === 'image');
  const storedKeys = new Set(images.map(node=>node.metadata?.storageKey).filter(Boolean));
  for (const [index, node] of images.entries()) {
    const metadata = node.metadata || {}, source = metadata.content;
    if (!metadata.storageKey && !/^(blob:|data:|https?:)/.test(source || '')) { skipped++; continue; }
    let key = metadata.storageKey;
    if (!key) {
      do { key = `image:download-${temporaryIndex++}`; } while (storedKeys.has(key));
    }
    let blob = media.get(key) || (metadata.storageKey ? await readBlob(key) : null);
    if (!blob && source) blob = await fetchBlob(source);
    if (!blob?.size) throw Error(`所选图片文件无法读取「${node.title || node.id}」。`);
    await validate(blob, key, { cache: !!metadata.storageKey });
    media.set(key, blob);
    const title = safeName(node.title || node.id || '图片').slice(0, 100);
    files.push({ storageKey: key, path: `${String(index + 1).padStart(3, '0')}-${title}.${extension(blob.type, key)}`, bytes: blob.size });
  }
  if (!files.length) throw Error('选中的内容中还没有可下载的图片文件。');
  return { data: { projects: [{ files }] }, media, skipped };
}
