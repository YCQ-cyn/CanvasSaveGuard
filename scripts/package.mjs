import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { zipSync } from 'fflate';
import path from 'node:path';
const root=fileURLToPath(new URL('../',import.meta.url)),files={};
async function collect(directory,relative='extension'){
  for(const entry of await readdir(directory,{withFileTypes:true})){
    if(entry.name==='_metadata')continue;
    const absolute=path.join(directory,entry.name),name=`${relative}/${entry.name}`;
    if(entry.isDirectory())await collect(absolute,name);
    else files[name]=new Uint8Array(await readFile(absolute));
  }
}
await collect(path.join(root,'extension'));
await writeFile(path.join(root,'CanvasSaveGuard-extension.zip'),zipSync(files,{level:6}));
console.log('已打包扩展，排除浏览器生成的元数据：'+path.join(root,'CanvasSaveGuard-extension.zip'));
