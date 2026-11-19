#!/usr/bin/env node
import { CodeMap } from './index.js';
import path from 'node:path';
import { visualize } from './visualize.js';
import { serve } from './mcp.js';

async function main() {
  const [command='help',...args]=process.argv.slice(2);
  if(command==='help'||command==='--help') { console.log('Usage: kudu <build|export|visualize|check|report|callers|callees|dependencies|dependents|neighborhood|watch|mcp|search|detail|path> [arguments] [--root directory]\nexport [file] | search <query> | detail <id> | path <from-id> <to-id>'); return; }
  const rootIndex=args.indexOf('--root'); let root=process.cwd();
  if(rootIndex>=0) { if(!args[rootIndex+1]) throw new Error('--root requires a directory'); root=args[rootIndex+1]; args.splice(rootIndex,2); }
  const arity:Record<string,number>={build:0,export:1,visualize:1,check:0,report:0,callers:1,callees:1,dependencies:1,dependents:1,neighborhood:1,watch:0,mcp:0,search:1,detail:1,path:2};
  const required=command==='export'||command==='visualize'?0:arity[command];
  if(!Object.hasOwn(arity,command) || args.length<required || args.length>arity[command]) throw new Error('Unknown command or invalid arguments; use kudu help');
  if(command==='mcp') return serve(root);
  const map=new CodeMap(root);
  if(command==='visualize') { if(args.length>1) throw new Error('Usage: kudu visualize [file.html] [--root directory]'); await map.build(); const file=path.resolve(map.root,args[0]??'code-map.html'); await visualize(map.graph,file); console.log(file); return; }
  if(command==='watch') { await map.watch(); console.log(JSON.stringify({watching:map.root,nodes:map.graph.nodes.length,errors:map.graph.errors})); const stop=async()=>{await map.close(); process.exit(0);}; process.once('SIGINT',()=>void stop()); process.once('SIGTERM',()=>void stop()); return; }
  if(command==='export') { if(args.length>1) throw new Error('Usage: kudu export [file] [--root directory]'); await map.build(); await map.export(args[0]); console.log(JSON.stringify({file:args[0] ?? 'code-map.json',nodes:map.graph.nodes.length,edges:map.graph.edges.length,errors:map.graph.errors},null,2)); return; }
  if(command==='build') { const g=await map.build(); console.log(JSON.stringify({schemaVersion:g.schemaVersion,nodes:g.nodes.length,edges:g.edges.length,errors:g.errors},null,2)); return; }
  if(command==='check') { await map.build(); const fs=await import('node:fs/promises'); const {root,generatedAt,...portable}=map.graph; const actual=await fs.readFile(path.join(map.root,'code-map.json'),'utf8'); if(actual.replace(/\r\n/g,'\n')!==JSON.stringify(portable,null,2)+'\n') throw new Error('code-map.json is stale; run kudu export'); console.log('code-map.json is up to date'); return; }
  await map.load();
  let output:unknown;
  if(command==='report') output=map.report();
  else if(command==='callers'&&args[0]) output=map.related(args[0],'incoming','calls');
  else if(command==='callees'&&args[0]) output=map.related(args[0],'outgoing','calls');
  else if(command==='dependencies'&&args[0]) output=map.dependencies(args[0]);
  else if(command==='dependents'&&args[0]) output=map.dependencies(args[0],true);
  else if(command==='neighborhood'&&args[0]) output=map.neighborhood(args[0]);
  else if(command==='search' && args[0]) output=map.search(args[0]);
  else if(command==='detail' && args[0]) output=await map.detail(args[0]);
  else if(command==='path' && args[0] && args[1]) output=map.path(args[0],args[1]);
  else throw new Error('Unknown command or missing arguments; use kudu help');
  console.log(JSON.stringify(output,null,2));
}
main().catch(error=>{console.error(error instanceof Error?error.message:error); process.exitCode=1;});
