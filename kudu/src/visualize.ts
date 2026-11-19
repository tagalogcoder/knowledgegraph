import fs from 'node:fs/promises';
import type { Graph } from './index.js';

/** Self-contained, offline viewer. Graph strings are data, never HTML. */
export async function visualize(graph:Graph,file:string):Promise<void> {
  const data=JSON.stringify({nodes:graph.nodes,edges:graph.edges}).replace(/</g,'\\u003c');
  await fs.writeFile(file,`<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Code map</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#101721;color:#e2eaf3;font:14px system-ui}header{padding:20px 24px;border-bottom:1px solid #334155}h1{margin:0 0 8px;font-size:24px}input,select,button{background:#202d3e;color:inherit;border:1px solid #52657c;border-radius:6px;padding:9px;margin:4px}main{display:grid;grid-template-columns:minmax(0,1fr) 320px;height:calc(100vh - 150px);min-height:500px}svg{width:100%;height:100%;background:#131e2c}aside{padding:20px;overflow:auto}line{stroke:#64748b;stroke-opacity:.35}circle{stroke:#101721;stroke-width:2;cursor:pointer}text{fill:#e2eaf3;font-size:11px;pointer-events:none}.item{display:block;width:100%;text-align:left;overflow-wrap:anywhere}small{color:#a7b8cc}#list{max-height:240px;overflow:auto}@media(max-width:700px){main{grid-template-columns:1fr;height:auto}svg{height:65vh}aside{min-height:250px}}
</style>
<header><h1>Code map</h1><small>Search symbols, filter relationships, then select a node to inspect its connections.</small><div><input id="search" aria-label="Search symbols" placeholder="Search name or file"><select id="kind" aria-label="Symbol kind"><option value="">All symbols</option></select><select id="edge" aria-label="Relationship"><option value="">All relationships</option></select><button id="reset">Reset</button><small id="count" role="status"></small></div></header>
<main><svg id="graph" viewBox="0 0 1000 750" role="img" aria-label="Interactive code relationship graph"></svg><aside><h2 id="title">Explore the repository</h2><p id="meta">Select a circle or a search result. Arrows point from source to target. Unresolved links appear in node details.</p><div id="list"></div><h3>Connections</h3><div id="details"></div></aside></main>
<script type="application/json" id="data">${data}</script>
<script>
const data=JSON.parse(document.getElementById('data').textContent),byId=new Map(data.nodes.map(n=>[n.id,n])),svg=document.getElementById('graph'),search=document.getElementById('search'),kind=document.getElementById('kind'),edge=document.getElementById('edge');
let selected=null;
for(const [select,values] of [[kind,data.nodes.map(n=>n.kind)],[edge,data.edges.map(e=>e.kind)]]) for(const value of [...new Set(values)].sort()){const option=document.createElement('option');option.value=value;option.textContent=value;select.append(option)}
const palette=['#67e8f9','#a78bfa','#fbbf24','#6ee7b7','#fda4af','#93c5fd'];const kinds=[...new Set(data.nodes.map(n=>n.kind))];
function el(tag,attrs){const e=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [k,v]of Object.entries(attrs))e.setAttribute(k,v);return e}
function pick(n){selected=n.id;document.getElementById('title').textContent=n.name;document.getElementById('meta').textContent=n.kind+' · '+n.file+':'+n.startLine+'–'+n.endLine;const details=document.getElementById('details');details.replaceChildren();for(const e of data.edges.filter(e=>e.source===n.id||e.target===n.id)){const p=document.createElement('p');const other=byId.get(e.source===n.id?e.target:e.source);p.textContent=(e.source===n.id?'\u2192 ':'\u2190 ')+e.kind+' · '+(other?other.name:e.targetName||'unknown')+' · '+e.file+':'+e.line+' · '+(e.method||e.resolution)+(e.reason?' · '+e.reason:'');details.append(p)}render()}
function render(){
 const q=search.value.toLowerCase();let nodes=data.nodes.filter(n=>(!kind.value||n.kind===kind.value)&&(!q||(n.name+' '+n.file).toLowerCase().includes(q)));
 if(selected&&!q&&!kind.value){const ids=new Set([selected]);for(const e of data.edges)if((!edge.value||edge.value===e.kind)&&(e.source===selected||e.target===selected)){ids.add(e.source);if(e.target)ids.add(e.target)}nodes=nodes.filter(n=>ids.has(n.id))}
 const total=nodes.length;nodes=nodes.slice(0,150);document.getElementById('count').textContent='Showing '+nodes.length+' of '+total+' matching nodes (150 node display limit)';
 const list=document.getElementById('list');list.replaceChildren();for(const n of nodes){const b=document.createElement('button');b.className='item';b.textContent=n.name+' · '+n.kind;b.onclick=()=>pick(n);list.append(b)}
 svg.replaceChildren();const defs=el('defs',{}),marker=el('marker',{id:'arrow',viewBox:'0 0 10 10',refX:18,refY:5,markerWidth:5,markerHeight:5,orient:'auto-start-reverse'});marker.append(el('path',{d:'M 0 0 L 10 5 L 0 10 z',fill:'#94a3b8'}));defs.append(marker);svg.append(defs);
 const positions=new Map(nodes.map((n,i)=>{const angle=i*2.399963,r=nodes.length===1?0:320*Math.sqrt((i+.5)/nodes.length);return[n.id,{x:500+r*Math.cos(angle),y:375+r*Math.sin(angle)}]}));
 for(const e of data.edges){const a=positions.get(e.source),b=positions.get(e.target);if(a&&b&&(!edge.value||edge.value===e.kind))svg.append(el('line',{x1:a.x,y1:a.y,x2:b.x,y2:b.y,'marker-end':'url(#arrow)'}))}
 for(const n of nodes){const p=positions.get(n.id),g=el('g',{}),c=el('circle',{cx:p.x,cy:p.y,r:n.id===selected?10:6,fill:palette[kinds.indexOf(n.kind)%palette.length]});const title=el('title',{});title.textContent=n.name+' · '+n.file;c.append(title);g.append(c);if(nodes.length<40||n.id===selected){const t=el('text',{x:p.x+12,y:p.y+4});t.textContent=n.name.slice(0,45);g.append(t)}g.onclick=()=>pick(n);svg.append(g)}
}
for(const control of [search,kind,edge])control.addEventListener('input',render);document.getElementById('reset').onclick=()=>{selected=null;search.value='';kind.value='';edge.value='';document.getElementById('title').textContent='Explore the repository';document.getElementById('details').replaceChildren();render()};render();
</script></html>`,'utf8');
}
