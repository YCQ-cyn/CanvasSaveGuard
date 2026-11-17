import test from 'node:test';
import assert from 'node:assert/strict';
import { zipSync, strToU8 } from 'fflate';
import { prepareArchive, sha256 } from '../src/core.mjs';
import { makeZip, verifyZip, zip64CentralDirectory } from '../src/zip.mjs';

const project = files => ({ id: 'large', title: '完整画布', nodes: files.map((key, index) => ({ id: key, type: 'image', position: { x: index * 20, y: 0 - index * 8 }, width: 100, height: 80,
  metadata: { status: 'success', storageKey: key, prompt: `保留提示词 ${index}`, content: `blob:${key}` } })), connections: [], viewport: { x: -50, y: 80, k: 0.8 } });

test('large-archive verification and lazy extraction never read the whole archive into one buffer', async () => {
  const keys = Array.from({ length: 600 }, (_, index) => `image:${index}`);
  const body = new Blob([new Uint8Array(48 * 1024).fill(53)], { type: 'image/png' });
  const prepared = await prepareArchive([project(keys)], async () => body, async () => body);
  const zip = await makeZip(prepared);
  class LimitedArchive extends Blob {
    arrayBuffer() { throw Error('The archive must be read through bounded slices'); }
    slice(start, end, type) {
      const part = super.slice(start, end, type);
      assert.ok(part.size <= 256 * 1024, `Unexpected large archive read ${part.size}`);
      return part;
    }
  }
  const archive = new LimitedArchive([zip]);
  const progress = [];
  const checked = await verifyZip(archive, { retainEntries: false, onProgress: (done, total) => progress.push([done, total]) });
  assert.equal(checked.files, 600);
  assert.deepEqual(checked.entries, {});
  assert.deepEqual(progress.at(-1), [600, 600]);
  const restored = await checked.readEntry(checked.data.projects[0].files[417].path);
  assert.equal(await sha256(await restored.arrayBuffer()), await sha256(await body.arrayBuffer()));
  assert.deepEqual(checked.data.projects[0].project.nodes.map(node => [node.position, node.metadata.prompt]), project(keys).nodes.map(node => [node.position, node.metadata.prompt]));
});

test('compressed native entries, arbitrary binary ZIP signatures and extra files remain readable', async () => {
  const key = 'image:special', binary = new Uint8Array([80,75,3,4,80,75,7,8,80,75,1,2,13,54,29]);
  const data = { app: 'infinite-canvas', version: 3, projects: [{ project: project([key]), files: [{ storageKey: key, path: '图像/内容.png', bytes: binary.length, mimeType: 'image/png' }] }] };
  const zip = new Blob([zipSync({ 'projects.json': strToU8(JSON.stringify(data)), '图像/内容.png': binary, 'notes.txt': strToU8('keep extra entries') }, { level: 6 })]);
  const checked = await verifyZip(zip);
  assert.equal(checked.hashed, false);
  assert.deepEqual(checked.entries['图像/内容.png'], binary);
  assert.equal(new TextDecoder().decode(checked.entries['notes.txt']), 'keep extra entries');
  const lazy = await verifyZip(zip, { retainEntries: false });
  assert.deepEqual(new Uint8Array(await (await lazy.readEntry('图像/内容.png')).arrayBuffer()), binary);
});

test('truncated archives and checksum-corrupt native media fail before being treated as a complete backup', async () => {
  const key = 'image:raw', binary = new Uint8Array([10,20,30,40]);
  const data = { app: 'infinite-canvas', version: 3, projects: [{ project: project([key]), files: [{ storageKey: key, path: 'picture.bin', bytes: 4, mimeType: 'image/png' }] }] };
  const zip = zipSync({ 'projects.json': strToU8(JSON.stringify(data)), 'picture.bin': binary }, { level: 0 });
  await assert.rejects(verifyZip(new Blob([zip.slice(0, -10)]), { retainEntries: false }), /结尾不完整/);
  const needle = zip.findIndex((_, index) => zip[index] === 10 && zip[index + 1] === 20 && zip[index + 2] === 30 && zip[index + 3] === 40);
  assert.ok(needle > 0);
  zip[needle] ^= 255;
  await assert.rejects(verifyZip(new Blob([zip]), { retainEntries: false }), error => error.details.includes('文件损坏：picture.bin'));
});

test('ZIP64 end records resolve their real directory while legacy file entries stay compatible', async () => {
  const key = 'image:zip64', body = strToU8('native zip64 data');
  const data = { app: 'infinite-canvas', version: 3, projects: [{ project: project([key]), files: [{ storageKey: key, path: 'item.png', bytes: body.length, mimeType: 'image/png' }] }] };
  const source = zipSync({ 'projects.json': strToU8(JSON.stringify(data)), 'item.png': body });
  const originalEnd = source.length - 22, original = new DataView(source.buffer);
  const output = new Uint8Array(source.length + 76); output.set(source.subarray(0, originalEnd));
  const view = new DataView(output.buffer);
  view.setUint32(originalEnd, 0x06064b50, true); view.setBigUint64(originalEnd + 4, 44n, true);
  view.setBigUint64(originalEnd + 24, BigInt(original.getUint16(originalEnd + 10, true)), true);
  view.setBigUint64(originalEnd + 32, BigInt(original.getUint16(originalEnd + 10, true)), true);
  view.setBigUint64(originalEnd + 40, BigInt(original.getUint32(originalEnd + 12, true)), true);
  view.setBigUint64(originalEnd + 48, BigInt(original.getUint32(originalEnd + 16, true)), true);
  view.setUint32(originalEnd + 56, 0x07064b50, true); view.setBigUint64(originalEnd + 64, BigInt(originalEnd), true); view.setUint32(originalEnd + 72, 1, true);
  view.setUint32(originalEnd + 76, 0x06054b50, true); view.setUint16(originalEnd + 84, 0xffff, true); view.setUint16(originalEnd + 86, 0xffff, true);
  view.setUint32(originalEnd + 88, 0xffffffff, true); view.setUint32(originalEnd + 92, 0xffffffff, true);
  const checked = await verifyZip(new Blob([output]), { retainEntries: false });
  assert.equal(checked.files, 1);
  assert.deepEqual(new Uint8Array(await (await checked.readEntry('item.png')).arrayBuffer()), body);
});

test('the streaming ZIP directory upgrades large offsets without truncating filenames, CRC or file lengths', async () => {
  const source=zipSync({'picture.png':new Uint8Array([1,2,3])},{level:0}),view=new DataView(source.buffer);
  const central=view.getUint32(source.length-6,true),offset=0x100000123;
  const upgraded=zip64CentralDirectory(source.subarray(central),[offset],offset+100);
  const fields=new DataView(upgraded.buffer),nameLength=fields.getUint16(28,true),extra=46+nameLength;
  assert.equal(fields.getUint32(42,true),0xffffffff);
  assert.equal(fields.getUint16(30,true),12);
  assert.equal(fields.getBigUint64(extra+4,true),BigInt(offset));
  assert.equal(fields.getUint32(16,true),view.getUint32(central+16,true));
  assert.equal(fields.getUint32(24,true),3);
  const footer=upgraded.length-98;
  assert.equal(fields.getBigUint64(footer+48,true),BigInt(offset+100));
});

test('a real ZIP64 directory may begin exactly at the classic offset sentinel', async () => {
  const key='image:boundary',body=strToU8('boundary bytes');
  const data={app:'infinite-canvas',version:3,projects:[{project:project([key]),files:[{storageKey:key,path:'boundary.png',bytes:body.length,mimeType:'image/png'}]}]};
  const source=zipSync({'projects.json':strToU8(JSON.stringify(data)),'boundary.png':body},{level:0}),view=new DataView(source.buffer);
  const central=view.getUint32(source.length-6,true);
  const next=central+46+view.getUint16(central+28,true)+view.getUint16(central+30,true)+view.getUint16(central+32,true);
  const mediaOffset=view.getUint32(next+42,true),largeOffset=0xffffffff;
  const directory=zip64CentralDirectory(source.subarray(central),[0,mediaOffset],largeOffset);
  const sections=[[0,source.subarray(0,central)],[largeOffset,directory]];
  const virtual={size:largeOffset+directory.length,slice(start=0,end=this.size){
    const output=new Uint8Array(end-start);
    for(const [offset,bytes] of sections){
      const first=Math.max(start,offset),last=Math.min(end,offset+bytes.length);
      if(last>first)output.set(bytes.subarray(first-offset,last-offset),first-start);
    }
    return new Blob([output]);
  }};
  const checked=await verifyZip(virtual,{retainEntries:false});
  assert.equal(checked.files,1);
  assert.deepEqual(new Uint8Array(await (await checked.readEntry('boundary.png')).arrayBuffer()),body);
});
