import ts from 'typescript';
import fs from 'node:fs/promises';
import path from 'node:path';
import chokidar, { type FSWatcher } from 'chokidar';
import ignore from 'ignore';
import { z } from 'zod';

export const SCHEMA_VERSION = 1;
export type Kind = 'file' | 'function' | 'class' | 'method' | 'import' | 'export' | 'interface' | 'type' | 'enum' | 'property';
export interface MapNode { id:string; name:string; kind:Kind; file:string; startLine:number; endLine:number }
export interface MapEdge { source:string; target?:string; targetName?:string; kind:'contains'|'imports'|'inherits'|'calls'|'exports'|'references'|'implements'; resolution:'resolved'|'unresolved'; method?:'syntax'|'compiler-symbol'|'module-resolution'; reason?:string; file:string; line:number }
export interface Graph { schemaVersion:number; root:string; generatedAt:string; nodes:MapNode[]; edges:MapEdge[]; errors:string[] }
export interface Detail { node:MapNode; incoming:MapEdge[]; outgoing:MapEdge[]; snippet:string }
const extensions = /\.(?:[cm]?[jt]sx?)$/i;
const excluded = new Set(['node_modules','.git','.code-maps','dist','build','coverage','.next','.turbo']);
const slash = (s:string) => s.split(path.sep).join('/');
const id = (file:string, kind:Kind, start:number, name:string) => `${file}:${kind}:${start}:${name}`;
const clamp = (n:number, max:number) => Math.max(1, Math.min(max, Number.isFinite(n) ? Math.floor(n) : 1));
const lineNumber = z.number().int().positive();
const graphSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  root: z.string().optional(),
  generatedAt: z.string().optional(),
  nodes: z.array(z.object({
    id: z.string().min(1), name: z.string(),
    kind: z.enum(['file','function','class','method','import','export','interface','type','enum','property']),
    file: z.string().min(1), startLine: lineNumber, endLine: lineNumber,
  }).refine(node => node.endLine >= node.startLine)),
  edges: z.array(z.object({
    source: z.string(), target: z.string().optional(), targetName: z.string().optional(),
    kind: z.enum(['contains','imports','inherits','calls','exports','references','implements']),
    resolution: z.enum(['resolved','unresolved']),
    method: z.enum(['syntax','compiler-symbol','module-resolution']).optional(),
    reason: z.string().optional(), file: z.string(), line: lineNumber,
  })),
  errors: z.array(z.string()),
});

async function filesIn(root:string):Promise<string[]> {
  const result:string[]=[];
  async function walk(dir:string, rules:{base:string; matcher:ReturnType<typeof ignore>}[]) {
    let local=rules;
    try { const text=await fs.readFile(path.join(dir,'.gitignore'),'utf8'); local=[...rules,{base:slash(path.relative(root,dir)),matcher:ignore().add(text)}]; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    for (const ent of await fs.readdir(dir,{withFileTypes:true})) {
      if (excluded.has(ent.name) || ent.isSymbolicLink()) continue;
      const absolute=path.join(dir,ent.name), rel=slash(path.relative(root,absolute));
      let ignored = false;
      for (const {base, matcher} of local) {
        const match = matcher.test((base ? rel.slice(base.length+1) : rel)+(ent.isDirectory()?'/':''));
        if (match.ignored) ignored = true;
        else if (match.unignored) ignored = false;
      }
      if (ignored) continue;
      if (ent.isDirectory()) await walk(absolute,local); else if (ent.isFile() && extensions.test(ent.name) && !/\.d\.[cm]?ts$/i.test(ent.name)) result.push(absolute);
    }
  }
  await walk(root,[]); return result.sort();
}

export class CodeMap {
  readonly root:string;
  graph:Graph;
  private watcher?:FSWatcher;
  private timer?:NodeJS.Timeout;
  private queue:Promise<void>=Promise.resolve();
  constructor(root:string) { this.root=path.resolve(root); this.graph={schemaVersion:SCHEMA_VERSION,root:this.root,generatedAt:'',nodes:[],edges:[],errors:[]}; }
  async build():Promise<Graph> {
    const work=this.queue.then(()=>this.buildNow());
    this.queue=work.then(()=>{},()=>{});
    return work;
  }
  private async buildNow():Promise<Graph> {
    const files=await filesIn(this.root);
    const options:ts.CompilerOptions={allowJs:true,checkJs:false,noEmit:true,target:ts.ScriptTarget.Latest,module:ts.ModuleKind.NodeNext,moduleResolution:ts.ModuleResolutionKind.NodeNext,jsx:ts.JsxEmit.Preserve,skipLibCheck:true};
    const config = ['tsconfig.json', 'jsconfig.json'].map(name => slash(path.join(this.root,name))).find(ts.sys.fileExists);
    const configErrors:ts.Diagnostic[] = [];
    if (config) {
      const read = ts.readConfigFile(config,ts.sys.readFile);
      if (read.error) configErrors.push(read.error);
      else {
        const parsed = ts.parseJsonConfigFileContent(read.config,ts.sys,path.dirname(config),{allowJs:true},config);
        configErrors.push(...parsed.errors);
        Object.assign(options,parsed.options,{noEmit:true,allowJs:true});
      }
    }
    const program=ts.createProgram(files,options), checker=program.getTypeChecker();
    const graph:Graph={schemaVersion:SCHEMA_VERSION,root:this.root,generatedAt:new Date().toISOString(),nodes:[],edges:[],errors:[]};
    for (const error of configErrors) graph.errors.push(ts.flattenDiagnosticMessageText(error.messageText,' '));
    const symbols=new Map<ts.Symbol,string>();
    const pending:{node:ts.Node; source:string; kind:MapEdge['kind']; name:string; file:string; line:number}[]=[];
    const fileIds=new Map<string,string>();
    const fileSet=new Set(files.map(f=>path.resolve(f)));
    for (const f of files) { const rel=slash(path.relative(this.root,f)); const fileId=id(rel,'file',0,rel); fileIds.set(path.resolve(f),fileId); graph.nodes.push({id:fileId,name:rel,kind:'file',file:rel,startLine:1,endLine:1}); }
    for (const f of files) {
      const sf=program.getSourceFile(f); if (!sf) { graph.errors.push(`Could not parse ${f}`); continue; }
      const rel=slash(path.relative(this.root,f)), fileId=fileIds.get(path.resolve(f))!;
      graph.nodes.find(n=>n.id===fileId)!.endLine=sf.getLineAndCharacterOfPosition(sf.end).line+1;
      for (const d of (sf as ts.SourceFile & {parseDiagnostics:readonly ts.Diagnostic[]}).parseDiagnostics || []) graph.errors.push(`${rel}:${sf.getLineAndCharacterOfPosition(d.start??0).line+1}: ${ts.flattenDiagnosticMessageText(d.messageText,' ')}`);
      const line=(n:ts.Node)=>sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1;
      const add=(n:ts.Node,name:string,kind:Kind,parent:string):string=>{ const nodeId=id(rel,kind,n.getStart(sf),name); graph.nodes.push({id:nodeId,name,kind,file:rel,startLine:line(n),endLine:sf.getLineAndCharacterOfPosition(n.end).line+1}); graph.edges.push({source:parent,target:nodeId,kind:'contains',resolution:'resolved',file:rel,line:line(n)}); const named=(n as ts.NamedDeclaration).name; if(named) { const s=checker.getSymbolAtLocation(named); if(s) symbols.set(s,nodeId); } return nodeId; };
      function visit(n:ts.Node,parent:string) {
        let current=parent;
        if (ts.isInterfaceDeclaration(n)) current=add(n,n.name.text,'interface',parent);
        else if(ts.isTypeAliasDeclaration(n)) current=add(n,n.name.text,'type',parent);
        else if(ts.isEnumDeclaration(n)) current=add(n,n.name.text,'enum',parent);
        else if(ts.isPropertyDeclaration(n)||ts.isPropertySignature(n)||ts.isPropertyAssignment(n)) current=add(n,n.name.getText(sf),'property',parent);
        else if (ts.isFunctionDeclaration(n)) current=add(n,n.name?.text??'<anonymous function>','function',parent);
        else if (ts.isVariableDeclaration(n) && n.initializer && (ts.isArrowFunction(n.initializer)||ts.isFunctionExpression(n.initializer))) current=add(n,n.name.getText(sf),'function',parent);
        else if (ts.isClassDeclaration(n)||ts.isClassExpression(n)) current=add(n,n.name?.text??'<anonymous class>','class',parent);
        else if (ts.isMethodDeclaration(n)||ts.isMethodSignature(n)||ts.isConstructorDeclaration(n)||ts.isGetAccessorDeclaration(n)||ts.isSetAccessorDeclaration(n)) current=add(n,n.name?.getText(sf)??'constructor','method',parent);
        if (ts.isClassDeclaration(n)||ts.isClassExpression(n)||ts.isInterfaceDeclaration(n)) {
          for (const h of n.heritageClauses??[]) for (const t of h.types) pending.push({node:t.expression,source:current,kind:h.token===ts.SyntaxKind.ImplementsKeyword?'implements':'inherits',name:t.expression.getText(sf),file:rel,line:line(t)});
        }
        if (current!==parent && ts.canHaveModifiers(n) && ts.getModifiers(n)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) graph.edges.push({source:parent,target:current,kind:'exports',resolution:'resolved',file:rel,line:line(n)});
        if (ts.isVariableDeclaration(n) && current!==parent && ts.isVariableDeclarationList(n.parent) && ts.isVariableStatement(n.parent.parent) && ts.getModifiers(n.parent.parent)?.some(m=>m.kind===ts.SyntaxKind.ExportKeyword)) graph.edges.push({source:parent,target:current,kind:'exports',resolution:'resolved',file:rel,line:line(n)});
        if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) { const spec=n.moduleSpecifier.text; const importId=add(n,spec,'import',parent); const resolved=ts.resolveModuleName(spec,f,options,ts.sys).resolvedModule?.resolvedFileName; const target=resolved&&fileSet.has(path.resolve(resolved))?fileIds.get(path.resolve(resolved)):undefined; graph.edges.push({source:importId,target,targetName:target?undefined:spec,kind:'imports',resolution:target?'resolved':'unresolved',file:rel,line:line(n)}); }
        if (ts.isExportDeclaration(n)) { const exp=add(n,n.moduleSpecifier?.getText(sf)??n.exportClause?.getText(sf)??'export','export',parent); if(n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) { const spec=n.moduleSpecifier.text; const resolved=ts.resolveModuleName(spec,f,options,ts.sys).resolvedModule?.resolvedFileName; const target=resolved&&fileSet.has(path.resolve(resolved))?fileIds.get(path.resolve(resolved)):undefined; graph.edges.push({source:exp,target,targetName:target?undefined:spec,kind:'exports',resolution:target?'resolved':'unresolved',file:rel,line:line(n)}); } }
        if(ts.isTypeReferenceNode(n)) pending.push({node:n.typeName,source:current,kind:'references',name:n.typeName.getText(sf),file:rel,line:line(n)});
        if(ts.isExportAssignment(n) && !n.isExportEquals) pending.push({node:n.expression,source:fileId,kind:'exports',name:n.expression.getText(sf),file:rel,line:line(n)});
        if(ts.isExportSpecifier(n)) pending.push({node:n.propertyName??n.name,source:fileId,kind:'exports',name:n.getText(sf),file:rel,line:line(n)});
        if(ts.isCallExpression(n) && (n.expression.kind===ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression)&&n.expression.text==='require'))) {
          const arg=n.arguments[0]; const spec=arg&&ts.isStringLiteralLike(arg)?arg.text:undefined;
          const resolved=spec?ts.resolveModuleName(spec,f,options,ts.sys).resolvedModule?.resolvedFileName:undefined;
          const target=resolved?fileIds.get(path.resolve(resolved)):undefined;
          graph.edges.push({source:current,target,targetName:target?undefined:spec??n.getText(sf),kind:'imports',resolution:target?'resolved':'unresolved',method:'module-resolution',reason:target?undefined:spec?'External or unresolved module':'Non-literal module specifier is unsupported',file:rel,line:line(n)});
        }
        if (ts.isCallExpression(n)||ts.isNewExpression(n)) pending.push({node:n.expression,source:current,kind:'calls',name:n.expression.getText(sf),file:rel,line:line(n)});
        ts.forEachChild(n,c=>visit(c,current));
      }
      visit(sf,fileId);
    }
    for (const p of pending) { let symbol=checker.getSymbolAtLocation(p.node); if(symbol && symbol.flags & ts.SymbolFlags.Alias) { try {symbol=checker.getAliasedSymbol(symbol);} catch {} } const target=symbol&&symbols.get(symbol); graph.edges.push({source:p.source,target,targetName:target?undefined:p.name,kind:p.kind,resolution:target?'resolved':'unresolved',file:p.file,line:p.line}); }
    for(const edge of graph.edges) { edge.method??=edge.kind==='contains'?'syntax':edge.kind==='imports'?'module-resolution':'compiler-symbol'; if(edge.resolution==='unresolved') edge.reason??='No indexed target: external, dynamic, or unsupported relationship'; }
    await this.saveGraph(graph); this.graph=graph; return graph;
  }
  private async writeGraph(file:string, graph:unknown):Promise<void> {
    await fs.mkdir(path.dirname(file),{recursive:true});
    const temp=`${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try { await fs.writeFile(temp,JSON.stringify(graph,null,2)+'\n'); await fs.rename(temp,file); }
    finally { await fs.rm(temp,{force:true}); }
  }
  private async saveGraph(graph:Graph):Promise<void> { await this.writeGraph(path.join(this.root,'.code-maps','graph.json'),graph); }
  async save():Promise<void> { await this.saveGraph(this.graph); }
  /** Write a reproducible index that can be committed and loaded from another clone. */
  async export(file=path.join(this.root,'code-map.json')):Promise<void> {
    const {root: _root, generatedAt: _generatedAt, ...portable}=this.graph;
    await this.writeGraph(path.resolve(this.root,file),portable);
  }
  async load():Promise<Graph> {
    let data:string;
    try { data=await fs.readFile(path.join(this.root,'.code-maps','graph.json'),'utf8'); }
    catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; data=await fs.readFile(path.join(this.root,'code-map.json'),'utf8'); }
    let parsed:unknown;
    try { parsed=JSON.parse(data); } catch { throw new Error('Invalid index JSON; rebuild it.'); }
    const validated=graphSchema.safeParse(parsed);
    if(!validated.success) throw new Error('Incompatible index; rebuild it.');
    const g=validated.data;
    const ids=new Set(g.nodes.map(n=>n.id));
    if((g.root && path.resolve(g.root)!==this.root) || ids.size!==g.nodes.length || g.edges.some(e=>!ids.has(e.source) || (e.target!==undefined&&!ids.has(e.target)) || (e.resolution==='resolved')!==(e.target!==undefined))) throw new Error('Incompatible index; rebuild it.');
    if(g.nodes.some(n=>path.isAbsolute(n.file) || /^[A-Za-z]:|\\\\/.test(n.file) || n.file.split(/[\\/]/).includes('..'))) throw new Error('Incompatible index; rebuild it.');
    this.graph={...g,root:this.root,generatedAt:g.generatedAt??''}; return this.graph;
  }
  related(nodeId:string, direction:'incoming'|'outgoing', kind?:MapEdge['kind']):MapEdge[] { if(!this.graph.nodes.some(n=>n.id===nodeId)) throw new Error('Node not found'); return this.graph.edges.filter(e=>(direction==='incoming'?e.target===nodeId:e.source===nodeId)&&(!kind||e.kind===kind)); }
  neighborhood(nodeId:string,hops=2,limit=100) { const selected=new Set([nodeId]); if(!this.graph.nodes.some(n=>n.id===nodeId)) throw new Error('Node not found'); for(let i=0;i<clamp(hops,6);i++){ const before=new Set(selected); for(const e of this.graph.edges) if(e.target&&(before.has(e.source)||before.has(e.target))&&selected.size<clamp(limit,500)){selected.add(e.source); if(selected.size<clamp(limit,500))selected.add(e.target);} } return {nodes:this.graph.nodes.filter(n=>selected.has(n.id)),edges:this.graph.edges.filter(e=>e.target&&selected.has(e.source)&&selected.has(e.target))}; }
  dependencies(file:string,incoming=false) {
    const targets=incoming?new Set(this.graph.nodes.filter(n=>n.file===file).map(n=>n.id)):undefined;
    return this.graph.edges.filter(e=>e.kind==='imports' && (targets?e.target!==undefined&&targets.has(e.target):e.file===file));
  }
  report() { const degree=new Map<string,number>(); for(const e of this.graph.edges) if(e.target&&e.kind!=='contains'){degree.set(e.source,(degree.get(e.source)??0)+1);degree.set(e.target,(degree.get(e.target)??0)+1);} const ranked=this.graph.nodes.map(n=>({...n,degree:degree.get(n.id)??0})).sort((a,b)=>b.degree-a.degree||a.id.localeCompare(b.id)); return {nodes:this.graph.nodes.length,edges:this.graph.edges.length,unresolved:this.graph.edges.filter(e=>e.resolution==='unresolved').length,centralFiles:ranked.filter(n=>n.kind==='file').slice(0,10),centralSymbols:ranked.filter(n=>n.kind!=='file').slice(0,10),errors:this.graph.errors}; }
  search(query:string,limit=20):MapNode[] { const q=query.toLowerCase(); return this.graph.nodes.filter(n=>n.name.toLowerCase().includes(q)||n.file.toLowerCase().includes(q)).sort((a,b)=>Number(b.name.toLowerCase()===q)-Number(a.name.toLowerCase()===q)||a.name.localeCompare(b.name)).slice(0,clamp(limit,100)); }
  async detail(nodeId:string,maxLines=30):Promise<Detail> { const node=this.graph.nodes.find(n=>n.id===nodeId); if(!node) throw new Error(`Node not found: ${nodeId}`); const root=await fs.realpath(this.root), file=await fs.realpath(path.join(this.root,node.file)), relative=path.relative(root,file); if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative)) throw new Error('Indexed file is outside the repository'); const lines=(await fs.readFile(file,'utf8')).split(/\r?\n/); const end=Math.min(node.endLine,node.startLine+clamp(maxLines,100)-1); return {node,incoming:this.graph.edges.filter(e=>e.target===nodeId).slice(0,100),outgoing:this.graph.edges.filter(e=>e.source===nodeId).slice(0,100),snippet:lines.slice(node.startLine-1,end).map((s,i)=>`${node.startLine+i}: ${s.slice(0,500)}`).join('\n')}; }
  path(from:string,to:string,maxHops=6):MapEdge[]|null {
    if(!this.graph.nodes.some(n=>n.id===from)||!this.graph.nodes.some(n=>n.id===to)) throw new Error('Node not found');
    if(from===to) return [];
    const adjacent=new Map<string,{node:string;edge:MapEdge}[]>();
    for(const edge of this.graph.edges) {
      if(!edge.target) continue;
      for(const [source,target] of [[edge.source,edge.target],[edge.target,edge.source]]) {
        const neighbors=adjacent.get(source)??[];
        neighbors.push({node:target,edge});
        adjacent.set(source,neighbors);
      }
    }
    const queue=[{node:from,depth:0}], seen=new Set([from]);
    const previous=new Map<string,{node:string;edge:MapEdge}>();
    for(let i=0;i<queue.length;i++) {
      const current=queue[i];
      if(current.depth>=clamp(maxHops,12)) continue;
      for(const next of adjacent.get(current.node)??[]) {
        if(seen.has(next.node)) continue;
        seen.add(next.node);
        previous.set(next.node,{node:current.node,edge:next.edge});
        if(next.node===to) {
          const edges:MapEdge[]=[];
          for(let node=to;node!==from;) {
            const step=previous.get(node)!;
            edges.push(step.edge);
            node=step.node;
          }
          return edges.reverse();
        }
        queue.push({node:next.node,depth:current.depth+1});
      }
    }
    return null;
  }
  async watch():Promise<void> {
    if(this.watcher) return;
    const watcher=chokidar.watch(this.root,{
      ignoreInitial:true, followSymlinks:false,
      ignored:(p,stats)=>p!==this.root && (excluded.has(path.basename(p))||!!stats?.isSymbolicLink()),
      awaitWriteFinish:{stabilityThreshold:150,pollInterval:50},
    });
    this.watcher=watcher;
    watcher.on('all',(event,p)=>{
      if(event!=='addDir' && event!=='unlinkDir' && !extensions.test(p) && !['.gitignore','tsconfig.json','jsconfig.json'].includes(path.basename(p))) return;
      clearTimeout(this.timer);
      this.timer=setTimeout(()=>{void this.build().catch(e=>console.error('Code map refresh failed:',e));},200);
    });
    watcher.on('error',error=>console.error('Code map watcher failed:',error));
    try {
      await new Promise<void>((resolve,reject)=>{
        const ready=()=>{watcher.off('error',failed); resolve();};
        const failed=(error:unknown)=>{watcher.off('ready',ready); reject(error);};
        watcher.once('ready',ready).once('error',failed);
      });
      await this.build();
    } catch(error) {
      await this.close();
      throw error;
    }
  }
  async close():Promise<void> { clearTimeout(this.timer); await this.watcher?.close(); this.watcher=undefined; await this.queue; }
}
