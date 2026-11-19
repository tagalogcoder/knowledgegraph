import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { CodeMap } from '../dist/index.js';

const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

async function fixture(t, files) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kudu-test-'));
  const map = new CodeMap(root);
  t.after(async () => {
    await map.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const [name, source] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), source);
  }
  return map;
}

function runCli(args, { endInput = false } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { stdio: 'pipe' });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('CLI timed out')); }, 15000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (endInput) child.stdin.end();
  });
}

test('indexes exported functions, interface methods and inheritance', async t => {
  const map = await fixture(t, {
    'api.ts': `
      export interface Base { run(): void; }
      export interface Child extends Base { stop(): void; }
      export const start = () => 1;
      const finish = () => 2;
      export default finish;
    `,
    'anonymous.ts': 'export default function () { return 1; }',
    'caller.ts': "import finish, { start } from './api.js'; start(); finish();",
  });
  const graph = await map.build();
  const named = name => graph.nodes.find(n => n.name === name);
  for (const name of ['start', 'finish', '<anonymous function>']) {
    assert.ok(graph.edges.some(e => e.kind === 'exports' && e.target === named(name)?.id), name);
  }
  assert.equal(named('run')?.kind, 'method');
  assert.ok(graph.edges.some(e => e.kind === 'inherits' && e.source === named('Child').id && e.target === named('Base').id));
  assert.ok(map.related(named('start').id, 'incoming', 'calls').length);
  assert.ok(map.related(named('finish').id, 'incoming', 'calls').length);
  assert.equal(graph.errors.length, 0);
});

test('nested gitignore negation overrides parent rules without entering ignored directories', async t => {
  const map = await fixture(t, {
    '.gitignore': '*.ts\nblocked/\n',
    'src/.gitignore': '!keep.ts\n',
    'src/keep.ts': 'export const keep = () => 1;',
    'src/drop.ts': 'export const drop = () => 1;',
    'blocked/.gitignore': '!keep.ts\n',
    'blocked/keep.ts': 'export const blocked = () => 1;',
  });
  const graph = await map.build();
  assert.deepEqual(graph.nodes.filter(n => n.kind === 'file').map(n => n.file), ['src/keep.ts']);
});

test('paths use the shortest route in either direction and respect hop bounds', () => {
  const map = new CodeMap('.');
  map.graph.nodes = ['a', 'b', 'c', 'd', 'isolated'].map(id => ({
    id, name: id, kind: 'function', file: 'main.ts', startLine: 1, endLine: 1,
  }));
  const edge = (source, target) => ({ source, target, kind: 'calls', resolution: 'resolved', file: 'main.ts', line: 1 });
  map.graph.edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('a', 'c')];
  assert.deepEqual(map.path('a', 'd', 2), [map.graph.edges[3], map.graph.edges[2]]);
  assert.deepEqual(map.path('d', 'a', 2), [map.graph.edges[2], map.graph.edges[3]]);
  assert.equal(map.path('a', 'd', 1), null);
  assert.equal(map.path('a', 'isolated'), null);
  assert.deepEqual(map.path('a', 'a'), []);
  assert.throws(() => map.path('a', 'missing'), /Node not found/);
});

test('uses jsconfig aliases and reports invalid configuration', async t => {
  const map = await fixture(t, {
    'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
    'src/helper.js': 'export function helper() {}',
    'main.js': "import { helper } from '@/helper'; helper();",
  });
  await map.build();
  assert.equal(map.dependencies('main.js')[0]?.resolution, 'resolved');
  assert.deepEqual(map.dependencies('src/helper.js', true), map.dependencies('main.js'));
  assert.equal(map.graph.errors.length, 0);
  await fs.writeFile(path.join(map.root, 'jsconfig.json'), '{ invalid JSON');
  await map.build();
  assert.ok(map.graph.errors.length > 0);
});

test('portable export is reproducible and rejects malformed graphs before replacing state', async t => {
  const map = await fixture(t, { 'main.ts': 'export function main() {}' });
  await map.build();
  await map.export();
  const file = path.join(map.root, 'code-map.json');
  const first = await fs.readFile(file, 'utf8');
  await map.build();
  await map.export();
  assert.equal(await fs.readFile(file, 'utf8'), first);
  await fs.rm(path.join(map.root, '.code-maps'), { recursive: true });
  const loaded = new CodeMap(map.root);
  await loaded.load();
  assert.equal(loaded.graph.root, map.root);
  const previous = loaded.graph;
  const valid = JSON.parse(first);
  const malformed = [
    null,
    { ...valid, nodes: [null] },
    { ...valid, nodes: [{ ...valid.nodes[0], startLine: -1 }] },
    { ...valid, nodes: [{ ...valid.nodes[0], name: 123 }] },
    { ...valid, nodes: [{ ...valid.nodes[0], file: '../outside.ts' }] },
    { ...valid, nodes: [{ ...valid.nodes[0], file: 'C:\\outside.ts' }] },
    { ...valid, nodes: [...valid.nodes, valid.nodes[0]] },
    { ...valid, edges: [{ ...valid.edges[0], source: 'missing' }] },
    { ...valid, edges: [{ ...valid.edges[0], target: undefined }] },
  ];
  for (const graph of malformed) {
    await fs.writeFile(file, JSON.stringify(graph));
    await assert.rejects(loaded.load(), /Incompatible index/);
    assert.equal(loaded.graph, previous);
  }
});

test('check accepts Windows line endings and still detects stale source', async t => {
  const map = await fixture(t, { 'main.ts': 'export function main() {}' });
  await map.build();
  await map.export();
  const file = path.join(map.root, 'code-map.json');
  await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace(/\n/g, '\r\n'));
  assert.equal((await runCli(['check', '--root', map.root])).code, 0);
  await fs.writeFile(path.join(map.root, 'main.ts'), 'export function changed() {}');
  const stale = await runCli(['check', '--root', map.root]);
  assert.equal(stale.code, 1);
  assert.match(stale.stderr, /stale/);
});

test('CLI validates arguments before attempting to load a cache', async t => {
  const map = await fixture(t, {});
  for (const args of [['unknown'], ['toString'], ['search'], ['path', 'one'], ['report', 'extra'], ['mcp', 'extra']]) {
    const result = await runCli([...args, '--root', map.root]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /invalid arguments/);
    assert.doesNotMatch(result.stderr, /ENOENT/);
  }
});

test('MCP exits cleanly when its client closes stdin', async t => {
  const map = await fixture(t, { 'main.ts': 'export function main() {}' });
  const result = await runCli(['mcp', '--root', map.root], { endInput: true });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('watch refreshes after a source directory is removed', async t => {
  const map = await fixture(t, { 'src/main.ts': 'export function main() {}' });
  await map.watch();
  assert.ok(map.graph.nodes.length > 0);
  await fs.rm(path.join(map.root, 'src'), { recursive: true });
  const deadline = Date.now() + 10000;
  while (map.graph.nodes.length && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.equal(map.graph.nodes.length, 0);
});
