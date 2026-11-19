# Kudu

The `/kudu` skill combines code navigation, project memory, and lean coding, review, and audit workflows. Shortcuts `/codemap`, `/codesimplify`, and `/codememorize` invoke the corresponding part of the same skill. Install them with `node kudu/install.js /path/to/your/project` from the parent repository. The installer fills in the local CLI path for both Claude Code and GitHub Copilot.

The underlying JavaScript and TypeScript code index uses the TypeScript compiler API. It requires no model or hosted service and exposes a library, CLI, and MCP server. Source code stays on the machine unless another application sends it elsewhere.

## Install and run

Requires Node.js 20 or later. From this project directory:

```sh
npm install
npm run build
node dist/cli.js build --root /path/to/repository
node dist/cli.js export --root /path/to/repository
node dist/cli.js search "symbolName" --root /path/to/repository
node dist/cli.js detail "NODE_ID" --root /path/to/repository
node dist/cli.js path "NODE_ID_1" "NODE_ID_2" --root /path/to/repository
node dist/cli.js watch --root /path/to/repository
```

`npm link` makes the `kudu` command available locally. The local index remains at `.code-maps/graph.json` under the target root for compatibility with earlier versions. CLI searches read the saved index; rebuild or run the watcher to refresh it. The graph has `schemaVersion: 1`; node IDs can change when source positions change.

Run `kudu export --root /path/to/repository` to build and write `code-map.json` at the repository root, then commit that file to Git. The export omits the machine-specific root and generation time and uses repository-relative paths. Run it again after source changes; unchanged source produces the same file. An optional filename can be supplied after `export`. The default file is loaded when the local cache is absent; custom export paths are not loaded automatically. Remove or rebuild an existing local cache to pick up a newer committed export. Review the mapping before sharing: it contains source names and relationships.

## MCP setup

The MCP server builds the index at startup and watches for changes. Use an absolute path to this package's `kudu/dist/cli.js` and to the repository being indexed. For Claude Code, add this to project `.mcp.json`; for VS Code GitHub Copilot, add the equivalent server under `servers` in `.vscode/mcp.json` (or use your client's MCP configuration UI):

```json
{
  "mcpServers": {
    "kudu": {
      "command": "node",
      "args": ["/absolute/path/to/toolkit/kudu/dist/cli.js", "mcp", "--root", "/absolute/path/to/repository"]
    }
  }
}
```

For VS Code use `"servers"` instead of `"mcpServers"`. On Windows use JSON escaped backslashes or forward slashes. The tools are `search`, `detail`, `path`, `status`, and `rebuild`. Search first, then pass a result ID to detail or path. Detail includes incoming and outgoing edges and a bounded snippet. Paths traverse resolved edges in either direction. Assistants should consult source before making changes; unresolved edges are named but do not assert a target.

## Library

```ts
import { CodeMap } from 'kudu';
const map = new CodeMap('/path/to/repository');
await map.build(); // or await map.load() for an existing index
await map.export(); // write portable code-map.json for Git
const matches = map.search('handleRequest');
if (matches[0]) console.log(await map.detail(matches[0].id));
await map.watch(); // builds and refreshes on changes
// await map.close() when finished
```

Nodes cover files, functions, classes, methods, imports, and explicit export declarations. Edges describe containment, exports, imports, inheritance, and calls. Calls and inheritance use compiler symbol resolution; dynamic behavior, overloads, unresolved imports, and external dependencies can remain unresolved. A resolved edge is a static compiler association, not proof of runtime behavior. Syntax errors are reported in the graph and indexing continues. `.gitignore` rules are applied, and common dependency and build directories are excluded. Symlinks and TypeScript declaration files are skipped. Refreshes currently rebuild the complete graph, so large repositories may take time; during a refresh queries see the last completed graph. Snippets are read from current source, so they can briefly differ from an index while files change.

## Measuring token savings

No savings are claimed without measurement. Pick representative tasks and run each with the same assistant, model, repository revision, and prompt, once using ordinary exploration and once with the MCP tools available. Record input and output tokens, task success, lookup latency, and total elapsed time; repeat and compare. Include tasks requiring cross-file navigation and tasks where the graph is unlikely to help. Do not compare runs with different models or cached conversation histories.

Run `npm run build` to check TypeScript compilation, or `npm test` to build and run regression tests for indexing, ignore rules, configuration, saved graphs, CLI checks, and watcher/MCP cleanup. Tests use Node's built-in runner and temporary repositories.

The index uses `tsconfig.json`, or `jsconfig.json` when no TypeScript config is present, in the selected repository root. Invalid configuration is reported in `errors`. Nested `.gitignore` files can override parent patterns for files in directories Git permits traversing. Exported arrow functions, default function declarations, interface methods, and interface inheritance are included.

## Graph exploration and CI

If a repository commits a generated `code-map.json`, run `kudu check --root .` in CI after building to fail when it differs from a fresh build. Regenerate it with `kudu export`.

Additional commands: `report`, `callers <id>`, `callees <id>`, `dependencies <relative-file>`, `dependents <relative-file>`, and `neighborhood <id>`. These queries are also exposed through MCP. Neighborhoods default to two hops and 100 nodes. Edges include a resolution method and an unresolved reason where applicable.

Interfaces, type aliases, enums, properties, type references, implementations, named exports, CommonJS require calls and dynamic imports are indexed. Non-literal module specifiers are reported as unsupported. Compiler associations remain static approximations.

## Visualization

Run `kudu visualize --root .` to build a self-contained `code-map.html`, then open it in a browser. An optional output filename can follow `visualize`. The viewer works offline with no external scripts. Search by symbol or file, filter kinds and relationships, and select a node to see its neighborhood and edge evidence. The display is capped at 150 nodes; search narrows larger graphs.
