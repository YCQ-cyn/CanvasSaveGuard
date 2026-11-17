import test from 'node:test';
import assert from 'node:assert/strict';
import { materializeBatchImage, synchronizeBatchGraph } from '../src/batch-graph.mjs';
import { copyImageNode } from '../src/batch-clipboard.mjs';
import { legacyBatchMembers, dragNodeMembers, pruneLegacyBatchNodes } from '../src/batch-layout.mjs';
import { pruneDeletedHistory } from '../src/deleted-history.mjs';
import { createBatchCanvasRetryBridge } from '../src/retry-bridge.mjs';

const image = id => ({ id, storageKey:`image:${id}`, content:`blob:${id}`, status:'success' });
const root = () => ({ id:'root', type:'image', title:'results', position:{x:20,y:30}, width:120, height:120,
  metadata:{...image('a'),images:[image('a'),image('b')],primaryImageId:'a',prompt:'prompt',model:'model',imageBatchExpanded:true} });

test('optional descendant dragging follows all generations and group ownership without changing deletion membership', () => {
  const nodes = [root(), { id: 'batch', metadata: { batchRootId: 'root', guardBatchImageId: 'a' } },
    { id: 'next', metadata: {} }, { id: 'last', metadata: {} }, { id: 'unrelated', metadata: {} }];
  nodes[0].metadata.guardBatchChildren = { a: 'batch' };
  const links = [{ fromNodeId: 'batch', toNodeId: 'next' }, { fromNodeId: 'next', toNodeId: 'last' }];
  const before = JSON.stringify([nodes, links]);
  assert.deepEqual([...dragNodeMembers(new Set(['root']), nodes, links, false)], ['root', 'batch']);
  assert.deepEqual([...dragNodeMembers(new Set(['root']), nodes, links, true)], ['root', 'batch', 'next', 'last']);
  assert.deepEqual([...dragNodeMembers(new Set(['batch']), nodes, links, true)], ['batch', 'next', 'last']);
  assert.deepEqual([...legacyBatchMembers(new Set(['root']), nodes)], ['root', 'batch']);
  assert.equal(JSON.stringify([nodes, links]), before);
});

test('descendant dragging deduplicates overlapping selections, shared branches and cycles', () => {
  const nodes = ['a', 'b', 'c', 'd', 'e'].map(id => ({ id, metadata: {} }));
  const links = [['a', 'b'], ['a', 'c'], ['b', 'd'], ['c', 'd'], ['d', 'b'], ['missing', 'e']]
    .map(([fromNodeId, toNodeId]) => ({ fromNodeId, toNodeId }));
  const members = dragNodeMembers(new Set(['a', 'b']), nodes, links, true);
  assert.deepEqual([...members].sort(), ['a', 'b', 'c', 'd']);
  assert.equal(members.size, 4);
});

test('deep descendant chains are resolved iteratively once without mutating the original graph', () => {
  const nodes = Array.from({ length: 12000 }, (_, index) => ({ id: String(index), metadata: {} }));
  const links = nodes.slice(1).map((node, index) => ({ fromNodeId: String(index), toNodeId: node.id }));
  const members = dragNodeMembers(new Set(['0']), nodes, links, true);
  assert.equal(members.size, nodes.length);
  assert.equal(members.has('11999'), true);
  assert.equal(nodes[11999].metadata.batchRootId, undefined);
});

test('connecting an inline result creates one native child sharing exact media and preserves all source entries', () => {
  const original=root(),nodes=[original],position={x:300,y:40};
  const result=materializeBatchImage(nodes,'root','b',position);
  assert.equal(result.childId,'b');
  assert.equal(nodes.length,1);
  assert.equal(result.nodes[0].metadata.images,original.metadata.images);
  assert.deepEqual(result.nodes[0].metadata.guardBatchChildren,{b:'b'});
  assert.equal(result.nodes[1].metadata.storageKey,'image:b');
  assert.equal(result.nodes[1].metadata.batchRootId,'root');
  assert.equal(result.nodes[1].metadata.guardBatchImageId,'b');
  assert.deepEqual(result.nodes[1].position,position);
  assert.equal(result.nodes[1].metadata.images,undefined);
  assert.equal(materializeBatchImage(result.nodes,'root','b',position).nodes,result.nodes);
  const collision=materializeBatchImage([...nodes,{id:'b',type:'text'}],'root','b',position);
  assert.notEqual(collision.childId,'b');
  assert.equal(collision.nodes[1].type,'text');
});

test('native child movement and generation synchronize with the original result in the same state update', () => {
  const before=materializeBatchImage([root()],'root','b',{x:300,y:40}).nodes;
  const moved=before.map(node=>node.id==='b'?{...node,position:{x:340,y:100},metadata:{...node.metadata,...image('replacement'),id:undefined}}:node);
  const synced=synchronizeBatchGraph(before,moved);
  assert.equal(synced[0].metadata.images[1].id,'b');
  assert.equal(synced[0].metadata.images[1].storageKey,'image:replacement');
  assert.deepEqual(synced[0].metadata.batchImagePositions.b,{x:320,y:70});
  const next=synced.map(node=>node.id==='root'?{...node,metadata:{...node.metadata,images:node.metadata.images.map(item=>item.id==='b'?{...item,...image('retry'),id:'b'}:item)}}:node);
  const retried=synchronizeBatchGraph(synced,next);
  assert.equal(retried.find(node=>node.id==='b').metadata.storageKey,'image:retry');
  assert.equal(synchronizeBatchGraph(retried,retried),retried);
});

test('a converted text child preserves its new content and the original image result without copying text into image media', () => {
  const before=materializeBatchImage([root()],'root','b',{x:300,y:40}).nodes;
  const original=JSON.stringify(before);
  const next=before.map(node=>node.id==='b'?{...node,type:'text',metadata:{...node.metadata,content:'Keep this text',storageKey:undefined}}:node);
  const synced=synchronizeBatchGraph(before,next);
  assert.deepEqual(synced[0].metadata.images,before[0].metadata.images);
  assert.deepEqual(synced[0].metadata.guardBatchChildren,{});
  assert.equal(synced[1].type,'text');
  assert.equal(synced[1].metadata.content,'Keep this text');
  assert.equal(synced[1].metadata.batchRootId,undefined);
  assert.deepEqual(synced[1].position,before[1].position);
  assert.equal(synced.length,before.length);
  assert.equal(JSON.stringify(before),original);
});

test('regenerating a root detaches an existing connected child when its old result ID is replaced', () => {
  const before=materializeBatchImage([root()],'root','b',{x:300,y:40}).nodes;
  const next=before.map(node=>node.id==='root'?{...node,metadata:{...node.metadata,images:[image('new')]}}:node);
  const synced=synchronizeBatchGraph(before,next);
  assert.deepEqual(synced[0].metadata.guardBatchChildren,{});
  assert.equal(synced[1].metadata.batchRootId,undefined);
  assert.equal(synced[1].metadata.storageKey,'image:b');
});

test('exact mapped child deletion removes its canonical reference and prunes only its authorized history', () => {
  const keep={id:'offscreen',type:'text',position:{x:90000,y:90000},metadata:{content:'keep'}};
  const before=materializeBatchImage([root(),keep],'root','a',{x:300,y:40}).nodes;
  const removed=new Set(['a']),live=pruneLegacyBatchNodes(before,removed);
  assert.equal(live[1],keep);
  assert.deepEqual(live[0].metadata.images.map(item=>item.id),['b']);
  assert.equal(live[0].metadata.storageKey,'image:b');
  assert.deepEqual(live[0].metadata.guardBatchChildren,{});
  const old={nodes:before,connections:[{id:'link',fromNodeId:'a',toNodeId:'offscreen'}]};
  const current={nodes:live,connections:[]},bytes=JSON.stringify(current);
  const pruned=pruneDeletedHistory(current,{history:{past:[old],future:[old]}},{nodeIds:['a'],connectionIds:['link']});
  assert.equal(JSON.stringify(current),bytes);
  assert.deepEqual(pruned.history.past[0].nodes,live);
  assert.deepEqual(pruned.history.past[0].connections,[]);
  assert.ok(pruned.summary.candidateKeys.includes('image:a'));
  assert.deepEqual([...legacyBatchMembers(new Set(['root']),before)].sort(),['a','root']);
  const earlier={nodes:[root(),keep],connections:[]};
  const prunedEarlier=pruneDeletedHistory(current,{history:{past:[earlier],future:[]}},{nodeIds:['a'],connectionIds:[],images:[{nodeId:'root',imageId:'a'}]});
  assert.deepEqual(prunedEarlier.history.past[0].nodes[0].metadata.images.map(image=>image.id),['b']);
  assert.equal(prunedEarlier.history.past[0].nodes[0].metadata.storageKey,'image:b');
});

test('connected child copy is one independent image and retries enumerate each actual failure once', () => {
  const nodes=materializeBatchImage([root()],'root','b',{x:300,y:40}).nodes;
  const copied=copyImageNode(nodes[1]);
  assert.equal(copied.metadata.guardBatchImageId,undefined);
  assert.equal(copied.metadata.batchRootId,undefined);
  assert.equal(copyImageNode(nodes[0]).metadata.guardBatchChildren,undefined);
  nodes[0].metadata.images.forEach(image=>image.status='error');
  nodes[1].metadata.status='error';
  const calls=[],expanded=new Set(['root']);
  const bridge=createBatchCanvasRetryBridge('p',()=>nodes,(node,id)=>calls.push([node.id,id]),()=>expanded);
  assert.deepEqual(bridge.list().map(JSON.parse),[['root','a'],['b',null]]);
  for(const id of bridge.list())bridge.retry(id);
  assert.deepEqual(calls,[['root','a'],['b',undefined]]);
  nodes[0].metadata.imageBatchExpanded=false;expanded.clear();
  assert.deepEqual(bridge.list(),[]);
});
