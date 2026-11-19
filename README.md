# Kudu

Kudu is one project for AI coding assistants. Its `/kudu` skill combines local code navigation, project memory, and lean coding guidance. The package also exposes a JavaScript/TypeScript code-map CLI, library, and MCP server.

Install it in an existing project with Node.js 20 or later:

```sh
node kudu/install.js /path/to/your/project
```

Start a fresh Claude Code or GitHub Copilot session, then use:

| Command | Purpose |
| --- | --- |
| `/kudu <task>` | Find relevant memory and code, then make the smallest complete change. |
| `/kudu memorize <fact>` | Save a private project memory. |
| `/kudu remember <query>` | Retrieve relevant private and shared memories. |
| `/kudu share <exact fact>` | Move a private fact to shared memory for review and commit. |
| `/kudu review [change]` | Review a change without editing code. |
| `/kudu audit [path]` | Audit a repository or folder without editing code. |
| `/kudu lite|full|ultra <task>` | Choose the coding level. |
| `/codemap <query>` | Explore the code graph without editing files. |
| `/codesimplify <task>` | Focus on the smallest complete coding change. |
| `/codememorize <fact>` | Save a memory; use `remember <query>` or `share <fact>` after the command for those actions. |

The installer copies the main skill and three thin shortcuts into each assistant's project skills directory and builds the code-map CLI if needed. The shortcuts reuse the main skill's rules. It leaves existing files alone if they match and stops on local conflicts. Previously saved `.memorize/private.md` and `.memorize/shared.md` files continue to work. If an older version installed separate skills, remove those old skills from the target project when you no longer want their slash commands.

See [kudu/README.md](kudu/README.md) for the CLI, library, and MCP interfaces. Kudu draws on [Graphify](https://github.com/Graphify-Labs/graphify), [Mem0](https://github.com/mem0ai/mem0), and [Ponytail](https://github.com/DietrichGebert/ponytail); it is an independent, simplified implementation.
