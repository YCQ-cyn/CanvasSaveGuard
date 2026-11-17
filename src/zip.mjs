import { Zip, ZipDeflate, ZipPassThrough, Inflate, strToU8, strFromU8 } from 'fflate';
import { sha256, collectMedia } from './core.mjs';
import { isMediaTextField } from './media-fields.mjs';

const CHUNK_BYTES = 256 * 1024;
const ZIP32_MAX = 0xffffffff;
const pause = () => new Promise(resolve => setTimeout(resolve, 0));

export async function makeZip(prepared, { onProgress = () => {}, filesOnly = false } = {}) {
  const parts=[]; let error, written=0;
  let chunks=[],chunkBytes=0;
  const offsets=[];
  const flush=()=>{if(chunks.length)parts.push(new Blob(chunks));chunks=[];chunkBytes=0;};
  const append=chunk=>{chunks.push(chunk);chunkBytes+=chunk.length;if(chunkBytes>=4*1024*1024)flush();};
  const total = prepared.data.projects.reduce((sum, project) => sum + project.files.length, 0);
  if(prepared.data.projects.some(project=>project.files.some(file=>file.bytes>=ZIP32_MAX)))throw Error('单个媒体文件超出当前 ZIP 单文件写入范围。');
  let completed = 0, yieldedAt = performance.now();
  const done=new Promise((resolve,reject)=>{
    const zip=new Zip((err,chunk,final)=>{if(err){error=err;reject(err);return;}
      if(final&&(written>=ZIP32_MAX||offsets.length>=0xffff))chunk=zip64CentralDirectory(chunk,offsets,written);
      written+=chunk.length;append(chunk);if(final){flush();resolve();}});
    (async()=>{
      if(!filesOnly){
        const json=strToU8(JSON.stringify(prepared.data,null,2));
        const manifest={app:'canvas-save-guard',version:1,projectsJsonSha256:await sha256(json),files:prepared.data.projects.flatMap(p=>p.files)};
        for (const [name,bytes] of [['projects.json',json],['guard-manifest.json',strToU8(JSON.stringify(manifest,null,2))]]) {
          const entry=new ZipDeflate(name,{level:6});offsets.push(written);zip.add(entry);
          for(let offset=0;offset<bytes.length;offset+=CHUNK_BYTES) {
            entry.push(bytes.subarray(offset,offset+CHUNK_BYTES),offset+CHUNK_BYTES>=bytes.length);
            if(performance.now()-yieldedAt>12){await pause();yieldedAt=performance.now();}
          }
        }
      }
      for (const p of prepared.data.projects) for (const file of p.files) {
        const entry=new ZipPassThrough(file.path);offsets.push(written);zip.add(entry);
        const reader=prepared.media.get(file.storageKey).stream().getReader();
        try {
          while(true){const next=await reader.read();if(next.done)break;entry.push(next.value,false);if(error)throw error;
            if(performance.now()-yieldedAt>12){await pause();yieldedAt=performance.now();}}
        } finally { reader.releaseLock(); }
        entry.push(new Uint8Array(),true);
        onProgress(++completed,total);
      }
      zip.end();
    })().catch(reason=>{zip.terminate();reject(reason);});
  });
  await done;
  return new Blob(parts,{type:'application/zip'});
}

// Keep fflate's proven local-file compression and CRC handling. Only upgrade
// the small final directory when offsets or entry counts exceed classic ZIP.
export function zip64CentralDirectory(original, offsets, directoryOffset) {
  const view=new DataView(original.buffer,original.byteOffset,original.byteLength),parts=[];
  let cursor=0,size=0;
  for(const offset of offsets){
    const nameLength=view.getUint16(cursor+28,true),extraLength=view.getUint16(cursor+30,true),commentLength=view.getUint16(cursor+32,true);
    const length=46+nameLength+extraLength+commentLength;
    let record=original.slice(cursor,cursor+length);
    if(offset>=ZIP32_MAX){
      const insert=46+nameLength+extraLength,next=new Uint8Array(length+12);next.set(record.subarray(0,insert));next.set(record.subarray(insert),insert+12);
      const fields=new DataView(next.buffer);fields.setUint16(6,45,true);fields.setUint16(30,extraLength+12,true);fields.setUint32(42,ZIP32_MAX,true);
      fields.setUint16(insert,1,true);fields.setUint16(insert+2,8,true);fields.setBigUint64(insert+4,BigInt(offset),true);record=next;
    }
    parts.push(record);size+=record.length;cursor+=length;
  }
  const footer=new Uint8Array(98),fields=new DataView(footer.buffer);
  fields.setUint32(0,0x06064b50,true);fields.setBigUint64(4,44n,true);fields.setUint16(12,45,true);fields.setUint16(14,45,true);
  fields.setBigUint64(24,BigInt(offsets.length),true);fields.setBigUint64(32,BigInt(offsets.length),true);
  fields.setBigUint64(40,BigInt(size),true);fields.setBigUint64(48,BigInt(directoryOffset),true);
  fields.setUint32(56,0x07064b50,true);fields.setBigUint64(64,BigInt(directoryOffset+size),true);fields.setUint32(72,1,true);
  fields.setUint32(76,0x06054b50,true);fields.setUint16(84,Math.min(offsets.length,0xffff),true);fields.setUint16(86,Math.min(offsets.length,0xffff),true);
  fields.setUint32(88,Math.min(size,ZIP32_MAX),true);fields.setUint32(92,Math.min(directoryOffset,ZIP32_MAX),true);
  const output=new Uint8Array(size+footer.length);let position=0;for(const part of parts){output.set(part,position);position+=part.length;}output.set(footer,position);
  return output;
}

function safeInteger(value) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw Error('ZIP 文件大小或偏移无效。');
  return number;
}

function crc32(bytes) {
  const entry=new ZipPassThrough('');entry.ondata=()=>{};entry.push(bytes,true);
  return entry.crc>>>0;
}

// Read only the end record and central directory. Media entries are then read
// independently, so large archives never require one contiguous archive buffer.
async function zipDirectory(blob) {
  const tailStart = Math.max(0, blob.size - 65557);
  const bytes = new Uint8Array(await blob.slice(tailStart).arrayBuffer());
  const tail = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && (tail.getUint32(end, true) !== 0x06054b50 || end + 22 + tail.getUint16(end + 20, true) !== bytes.length)) end--;
  if (end < 0) throw Error('ZIP 文件结尾不完整或格式无效。');
  if (tail.getUint16(end + 4, true) || tail.getUint16(end + 6, true)) throw Error('暂不支持分卷 ZIP。');
  let count = tail.getUint16(end + 10, true), size = tail.getUint32(end + 12, true), offset = tail.getUint32(end + 16, true);
  const zip64 = end >= 20 && tail.getUint32(end - 20, true) === 0x07064b50;
  if (zip64) {
    const position = safeInteger(tail.getBigUint64(end - 12, true));
    const record = new DataView(await blob.slice(position, position + 56).arrayBuffer());
    if (record.byteLength < 56 || record.getUint32(0, true) !== 0x06064b50) throw Error('ZIP64 目录记录无效。');
    count = safeInteger(record.getBigUint64(32, true));
    size = safeInteger(record.getBigUint64(40, true));
    offset = safeInteger(record.getBigUint64(48, true));
  }
  if(!zip64&&(size===ZIP32_MAX||offset===ZIP32_MAX))throw Error('ZIP64 目录位置缺失。');
  if (offset + size > tailStart + end) throw Error('ZIP 目录超出文件范围。');
  const directoryBytes = new Uint8Array(await blob.slice(offset, offset + size).arrayBuffer());
  const directory = new DataView(directoryBytes.buffer, directoryBytes.byteOffset, directoryBytes.byteLength);
  const records = new Map();
  let cursor = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > size || directory.getUint32(cursor, true) !== 0x02014b50) throw Error('ZIP 文件目录不完整。');
    const flags = directory.getUint16(cursor + 8, true), compression = directory.getUint16(cursor + 10, true);
    const crc = directory.getUint32(cursor + 16, true);
    let compressed = directory.getUint32(cursor + 20, true), original = directory.getUint32(cursor + 24, true), local = directory.getUint32(cursor + 42, true);
    const nameLength = directory.getUint16(cursor + 28, true), extraLength = directory.getUint16(cursor + 30, true), commentLength = directory.getUint16(cursor + 32, true);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > size) throw Error('ZIP 文件目录字段不完整。');
    const name = strFromU8(directoryBytes.subarray(cursor + 46, cursor + 46 + nameLength), !(flags & 2048));
    if (flags & 1) throw Error('请先解密压缩包，再导入画布。');
    if (compressed === ZIP32_MAX || original === ZIP32_MAX || local === ZIP32_MAX) {
      let extra = cursor + 46 + nameLength, found = false;
      const extraEnd = extra + extraLength;
      while (extra + 4 <= extraEnd) {
        const type = directory.getUint16(extra, true), length = directory.getUint16(extra + 2, true);
        if (extra + 4 + length > extraEnd) throw Error('ZIP 扩展字段不完整。');
        if (type === 1) {
          let position = extra + 4;
          const read = () => { if (position + 8 > extra + 4 + length) throw Error('ZIP64 文件字段缺失。'); const value = safeInteger(directory.getBigUint64(position, true)); position += 8; return value; };
          if (original === ZIP32_MAX) original = read();
          if (compressed === ZIP32_MAX) compressed = read();
          if (local === ZIP32_MAX) local = read();
          found = true; break;
        }
        extra += 4 + length;
      }
      if (!found) throw Error('ZIP64 文件字段缺失。');
    }
    records.set(name, { name, compression, crc, compressed, original, local });
    cursor = next;
  }
  return records;
}

async function zipEntry(blob, record) {
  if (!record) throw Error('压缩包中缺少指定文件。');
  const header = new DataView(await blob.slice(record.local, record.local + 30).arrayBuffer());
  if (header.byteLength < 30 || header.getUint32(0, true) !== 0x04034b50) throw Error(`文件头损坏：${record.name}`);
  const start = record.local + 30 + header.getUint16(26, true) + header.getUint16(28, true);
  if (start + record.compressed > blob.size) throw Error(`文件内容不完整：${record.name}`);
  const packed = blob.slice(start, start + record.compressed);
  if (record.compression === 0) return packed;
  if (record.compression !== 8) throw Error(`不支持的 ZIP 压缩方式：${record.compression}`);
  const parts = [];
  const inflate = new Inflate((bytes) => parts.push(bytes));
  let yieldedAt = performance.now();
  for (let offset = 0; offset < packed.size; offset += CHUNK_BYTES) {
    inflate.push(new Uint8Array(await packed.slice(offset, offset + CHUNK_BYTES).arrayBuffer()), offset + CHUNK_BYTES >= packed.size);
    if (performance.now() - yieldedAt > 12) { await pause(); yieldedAt = performance.now(); }
  }
  return new Blob(parts);
}

export async function verifyZip(blob, { retainEntries = true, onProgress = () => {} } = {}) {
  const records = await zipDirectory(blob), entries = {};
  if (!records.has('projects.json')) throw Error('压缩包里没有 projects.json。');
  const projectBytes = new Uint8Array(await (await zipEntry(blob, records.get('projects.json'))).arrayBuffer());
  const data=JSON.parse(new TextDecoder().decode(projectBytes));
  if(data.app!=='infinite-canvas'||data.version!==3||!Array.isArray(data.projects)||!data.projects.length)throw Error('这不是支持的画布压缩包。');
  const errors=[];let fileCount=0;
  const manifestBytes=records.has('guard-manifest.json')?new Uint8Array(await (await zipEntry(blob,records.get('guard-manifest.json'))).arrayBuffer()):null;
  const guard=manifestBytes?JSON.parse(new TextDecoder().decode(manifestBytes)):null;
  if(crc32(projectBytes)!==records.get('projects.json').crc)errors.push('画布说明文件的 ZIP 校验值不一致。');
  if(manifestBytes&&crc32(manifestBytes)!==records.get('guard-manifest.json').crc)errors.push('文件清单的 ZIP 校验值不一致。');
  if(retainEntries){entries['projects.json']=projectBytes;if(manifestBytes)entries['guard-manifest.json']=manifestBytes;}
  if(guard&&await sha256(projectBytes)!==guard.projectsJsonSha256) errors.push('画布说明文件的校验值不一致。');
  const manifestFiles=new Map((guard?.files||[]).map(file=>[file.path,file]));
  const inspected=new Map();
  const total=data.projects.reduce((sum,project)=>sum+(project.files?.length||0),0);
  let yieldedAt=performance.now();
  for(const p of data.projects){
    if(!p.project||!Array.isArray(p.project.nodes)||!Array.isArray(p.files))throw Error('画布结构不完整。');
    const listed=new Map(p.files.map(f=>[f.storageKey,f]));
    for(const key of collectMedia(p.project).keys())if(!listed.has(key))errors.push(`未打包：${key}`);
    function checkUrls(value, parentKey, nodeType) {
      if(Array.isArray(value))return value.forEach(v=>checkUrls(v,parentKey,nodeType));
      if(!value||typeof value!=='object'){
        if(typeof value==='string'&&value.startsWith('blob:')&&!parentKey)errors.push(`“${p.project.title}”包含未打包的临时图片地址。`);
        return;
      }
      if(['image','video','audio','text','config'].includes(value.type||value.kind))nodeType=value.type||value.kind;
      const ownKey=listed.has(value.storageKey)?value.storageKey:undefined;
      for(const [key,item] of Object.entries(value))if(!isMediaTextField(key,item,nodeType))checkUrls(item,['content','url','dataUrl'].includes(key)?ownKey:undefined,nodeType);
    }
    checkUrls(p.project);
    for(const f of p.files){
      const record=records.get(f.path);if(!record){errors.push(`缺文件：${f.path}`);continue;}
      let actual=inspected.get(f.path);
      if(!actual){
        const bytes=new Uint8Array(await (await zipEntry(blob,record)).arrayBuffer());
        actual={bytes:bytes.byteLength,sha256:await sha256(bytes),crc:crc32(bytes)};
        inspected.set(f.path,actual);
        if(retainEntries)entries[f.path]=bytes;
      }
      if(actual.bytes!==f.bytes||actual.bytes!==record.original)errors.push(`文件大小不符：${f.path}`);
      const expected=f.sha256||manifestFiles.get(f.path)?.sha256;
      if(expected&&actual.sha256!==expected||actual.crc!==record.crc)errors.push(`文件损坏：${f.path}`);
      fileCount++;
      onProgress(fileCount,total);
      if(performance.now()-yieldedAt>12){await pause();yieldedAt=performance.now();}
    }
  }
  if(errors.length){const error=Error(`压缩包校验失败：${errors.length} 项问题。`);error.details=errors;throw error;}
  if(retainEntries)for(const [name,record] of records)if(!Object.hasOwn(entries,name))entries[name]=new Uint8Array(await (await zipEntry(blob,record)).arrayBuffer());
  return {projects:data.projects.length,files:fileCount,hashed:!!guard,data,entries,
    readEntry:name=>zipEntry(blob,records.get(name))};
}
