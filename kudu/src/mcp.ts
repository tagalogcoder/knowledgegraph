import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { CodeMap } from './index.js';

export async function serve(root:string):Promise<void> {
  const map=new CodeMap(root); await map.watch();
  const server=new McpServer({name:'kudu',version:'0.1.0'});
  const result=(data:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(data)}]});
  server.registerTool('search',{description:'Search indexed symbols and files by name; returns IDs for other tools.',inputSchema:{query:z.string().min(1),limit:z.number().int().min(1).max(100).optional()}},async ({query,limit})=>result(map.search(query,limit)));
  server.registerTool('detail',{description:'Get a symbol, incoming and outgoing edges, and a bounded source snippet.',inputSchema:{id:z.string(),maxLines:z.number().int().min(1).max(100).optional()}},async ({id,maxLines})=>result(await map.detail(id,maxLines)));
  server.registerTool('path',{description:'Find a shortest undirected path through resolved graph edges.',inputSchema:{from:z.string(),to:z.string(),maxHops:z.number().int().min(1).max(12).optional()}},async ({from,to,maxHops})=>result(map.path(from,to,maxHops)));
  server.registerTool('rebuild',{description:'Rebuild the local code map.',inputSchema:{}},async ()=>result({nodes:(await map.build()).nodes.length,errors:map.graph.errors}));
  server.registerTool('status',{description:'Get index status and parsing errors.',inputSchema:{}},async ()=>result({schemaVersion:map.graph.schemaVersion,root:map.root,generatedAt:map.graph.generatedAt,nodes:map.graph.nodes.length,edges:map.graph.edges.length,errors:map.graph.errors}));
  for(const name of ['callers','callees','neighborhood'] as const) server.registerTool(name,{description:name+' for an indexed symbol',inputSchema:{id:z.string()}},async({id})=>result(name==='neighborhood'?map.neighborhood(id):map.related(id,name==='callers'?'incoming':'outgoing','calls')));
  for(const name of ['dependencies','dependents'] as const) server.registerTool(name,{description:name+' for a repository-relative file',inputSchema:{file:z.string()}},async({file})=>result(map.dependencies(file,name==='dependents')));
  server.registerTool('report',{description:'Central files, symbols, and unresolved relationship counts',inputSchema:{}},async()=>result(map.report()));
  let closing:Promise<void>|undefined;
  const close=()=>closing??=Promise.resolve().then(async()=>{
    process.stdin.off('end',stop);
    process.off('SIGINT',stop);
    process.off('SIGTERM',stop);
    try { await server.close(); } finally { await map.close(); }
  });
  const stop=()=>{void close().catch(error=>{console.error(error); process.exitCode=1;});};
  server.server.onclose=stop;
  process.stdin.once('end',stop);
  process.once('SIGINT',stop);
  process.once('SIGTERM',stop);
  try { await server.connect(new StdioServerTransport()); }
  catch(error) { await close(); throw error; }
}
