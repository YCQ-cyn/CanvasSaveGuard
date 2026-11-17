export function describeMediaReferences(project, key) {
  const found=[];
  function visit(value,path) {
    if(value===key)found.push(path);
    else if(Array.isArray(value))value.forEach((item,i)=>visit(item,`${path}[${i+1}]`));
    else if(value&&typeof value==='object')for(const [name,item] of Object.entries(value))visit(item,`${path}.${name}`);
  }
  for(const [i,node] of (project.nodes||[]).entries()) {
    const label=`节点 ${i+1}${node.title?`「${node.title.slice(0,24)}」`:''}（${node.id}）`;
    visit(node,label);
  }
  visit(project.chatSessions||[],'聊天记录');
  return found.map(path=>path.replace('.metadata.storageKey',' → 图片/媒体本体').replace('.metadata.references',' → 生成参考图').replace('.metadata.',' → '));
}

export function missingMediaDetails(project, missing) {
  return missing.flatMap(item=>{
    const key=typeof item==='string'?item:item.key;
    const refs=describeMediaReferences(project,key);
    return [`文件：${key}${item.reason?`（${item.reason}）`:''}`,...(refs.length?refs.map(ref=>`仍被引用：${ref}`):['当前画布未找到这个引用，请重新检查。'])];
  });
}
