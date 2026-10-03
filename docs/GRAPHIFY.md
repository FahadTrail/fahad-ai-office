# Graphify local code-map pilot

Graphify is an optional, read-only navigation aid for Coding and Continuity work. The official upstream is [Graphify-Labs/graphify](https://github.com/Graphify-Labs/graphify); its official PyPI package is **`graphifyy`** (double `y`), which installs the `graphify` CLI. This pilot pins `graphifyy[sql]==0.9.73`. No Graphify package is added to the Office runtime, Docker image or `package-lock.json`.

## Install and use

In a local checkout with Python 3.10+ (the pilot used isolated Python 3.12.14 on Windows):

```powershell
python -m venv .graphify-venv
.\.graphify-venv\Scripts\python.exe -m pip install uv==0.12.22
.\.graphify-venv\Scripts\uv.exe pip install --python .\.graphify-venv\Scripts\python.exe 'graphifyy[sql]==0.9.73'
npm run graphify:build
npm run graphify:query -- "selectWorker"
npm run graphify:update
```

If Python is not on `PATH`, use an installed Python 3.10+ executable for the first line. On Unix, substitute `.graphify-venv/bin/` for `Scripts/`. If `npm` is unavailable, use `node tools/graphify-query.mjs build|update|query <question>` directly. `GRAPHIFY_BIN` may point to an absolute official Graphify executable when using an isolated `uv tool install 'graphifyy[sql]==0.9.73'` instead. The wrapper always uses `extract . --code-only` and `cluster-only . --no-label` for the full build; update uses the official local code update command and reclusters without model labeling. It passes only local process settings (not model/API keys) and disables Graphify's local query log. It does not install Graphify's agent hooks.

The pilot indexed about 276 code files (including 32 SQL migrations) into roughly 3.5k nodes and 9.3k edges. Local outputs were `graphify-out/graph.json` (about 4.8 MB), `GRAPH_REPORT.md` (33 KB) and `graph.html` (3.6 MB). All are ignored by Git: they may expose source details and go stale across commits. Regenerate after code changes. The `graphify-out/` directory and `.graphify-venv/` can be removed to uninstall this pilot without changing runtime behavior.

The `.graphifyignore` allowlists `src/`, `supabase/migrations/` and `test/` and excludes credentials, `.env*`, Hermes-related paths, dependencies, caches, generated files, logs and backups. Graphify also honors `.gitignore`; never pass `--no-gitignore`. Technical docs are deliberately **not** indexed in this code-only pilot: upstream says semantic extraction of docs/media can use an assistant model/API. Read the relevant docs directly when needed. Graphify's upstream states that code AST parsing stays local and that it has no telemetry; this pilot does not claim an independent network audit. A local scan found no sensitive source paths or secret-detector match in the generated graph.

## How agents use it

Ask a narrow symbol/path question before broad exploration, then open the cited source files and verify. For example, `npm run graphify:query -- "CodexContinuityAdapter"` maps the adapter to `src/continuity/runtime.js`; `node tools/graphify-query.mjs path ContinuitySupervisor CodexContinuityAdapter` shows an undirected two-hop import path through runtime. Broad natural-language questions can return hundreds of nodes, and dynamic URL imports in the UI produced a few ambiguous node warnings. Graphify is **not** authority for runtime state, test results, database contents, security policy, production state or proof of a directed call path.

`src/continuity/code-intelligence.js` offers `queryArchitecture`, `getRelatedFiles`, `traceDependency` and `getContextForTask`. It queries only a prebuilt local graph, returns bounded file hints, and returns `available: false` on any missing/unsafe graph or CLI failure. The Coding Agent consumes at most eight suggested paths before its first model turn only if `CODING_GRAPHIFY_ENABLED=true` and a local graph plus CLI already exist inside that session's checkout; it never builds or downloads a graph automatically. `CODING_GRAPHIFY_BIN` optionally selects an executable. The flag defaults OFF. Continuity's supervisor and worker selection do not depend on this provider.

## Optional MCP

Upstream supports `graphifyy[mcp]` with a **stdio** server (`python -m graphify.serve graphify-out/graph.json`). If a developer wants this, install `graphifyy[mcp,sql]==0.9.73` in the same local venv and configure the MCP client with the absolute venv Python executable and absolute local graph path. A generic local-only example (replace both placeholders) is:

```json
{"mcpServers":{"graphify":{"command":"ABSOLUTE_VENV_PYTHON","args":["-m","graphify.serve","ABSOLUTE_GRAPH_JSON"]}}}
```

MCP is not installed, started or required by this pilot. Do not use HTTP transport or a public bind.

## Later measurement, not a savings claim

`tools/graphify-benchmark.mjs` writes metadata only under ignored `graphify-out/benchmarks/`. For a comparable task, begin one `without` run and one `with` run, manually record each file read (`file RUN_ID src/path.js [bytes-read]`), record every Graphify query (`query RUN_ID`), then `finish RUN_ID`. It records files opened, bytes read, estimated context tokens (`ceil(bytes/4)`), query count and elapsed time to identify relevant files. The estimate is **not** model billing data. No token or time savings are claimed until a later controlled comparison.
