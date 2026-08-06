# Knowledge Graph

A lightweight, language-agnostic map of a repository so an agent can understand
the codebase and find the right file **without reading every file**. A compact
graph costs far fewer tokens than raw source, which is the whole point.

## What it captures

- **File nodes** — every code file (by extension), with its language.
- **Symbol nodes** — functions, classes, interfaces, types, enums, structs,
  traits, etc., with the line where they are defined.
- **Import edges** — who imports what. JS/TS relative imports are resolved to the
  concrete file (`./util.js` → `util.ts`); everything else is recorded as an
  external module edge (`ext:react`).

Extraction is **heuristic** (regex/line-scan), not a full parser: ~80% accurate,
zero extra dependencies, runs on any repo. Supported with symbols: JS/TS, Python,
Go, Rust, Java/Kotlin. C/C++ is captured at the `#include` level. Other code
extensions get a file node only.

Ignored paths come from `config.json` `security.ignorePaths` plus built-in
defaults (`node_modules/`, `dist/`, `.git/`, `.agent-memory/`, …). Files larger
than 512 KB are recorded as a node but not scanned for symbols/imports.

## Build it

```bash
agent-bridge graph build            # scan cwd and (re)build the graph
agent-bridge graph build --root ../other-repo
```

The graph is a derived index stored in `memories.db` (tables `graph_nodes` /
`graph_edges`, schema v7). `build` replaces it wholesale, so re-run it after
significant code changes.

## Query it

```bash
agent-bridge graph stats                       # sizes
agent-bridge graph map [--limit 40] [--focus src/auth,src/db]
agent-bridge graph neighbors <path>            # imports (out) + used-by (in)
agent-bridge graph dependents <path>           # who imports this file
agent-bridge graph symbols <path>              # symbols defined in a file
agent-bridge graph search <text> [--kind file|symbol] [--limit 30]
```

`graph map` ranks files by fan-in (most depended-on first) — the natural reading
order for understanding a repo. `--focus` narrows to path substrings.

### File briefs

```bash
agent-bridge graph brief-auto <path...> [--task-edited]   # generate sparse briefs
agent-bridge graph brief-auto --all                        # refresh every indexed file's brief
agent-bridge graph brief <path> "<summary>"               # hand-write a brief
```

`graph build` rebuilds the graph but leaves briefs untouched, so run
`brief-auto --all` after a build (or after upgrading the brief generator) to
regenerate them. `--all` preserves each file's existing importance and only
rewrites the brief text.

`brief-auto` builds a brief without an LLM, from the highest-signal static
sources: the file's own **leading header/doc comment** (read from the top of the
file, including the common layout where the comment follows the imports) and a
**role label** inferred from path/name conventions (`Test suite for <subject>`,
`CLI command module`, `module entry point (barrel)`, `Type definitions`,
`Configuration`, `UI component`, …). When a file has no usable comment it falls
back to the role plus its primary symbol. License headers and pragma-only
comments are ignored. The brief carries the file's *intent* — the repo map
already shows its symbols, imports, and fan-in, so the brief deliberately does
not restate them.

## Token savings in compiled context

When a graph exists, `agent-bridge context compile` injects a compact
**`## Repo Map`** section (most depended-on files first, with their symbols and
imports). This gives the next agent a repo overview up front instead of spending
tokens reading files to rediscover structure.

```bash
agent-bridge context compile --agent claude          # auto-injects repo map
agent-bridge context compile --no-repo-map           # opt out
agent-bridge context compile --repo-map-limit 50     # more files in the map
```

The repo map sits in the dynamic suffix of the prompt pack (after the stable,
cacheable prefix), so it does not break prompt caching.

### Measuring the savings

`optimize baseline` quantifies the claim above instead of just reporting the
compiled-context size. It compares the cost of an agent reading the repo-map
files' raw source against the cost of the compact repo map that replaces that
reading, and reports tokens saved and a percentage.

```bash
agent-bridge optimize baseline                 # uses graph.repoMapLimit (or 40) files
agent-bridge optimize baseline --limit 10      # only the 10 most-relevant files
agent-bridge optimize baseline --focus src/auth
agent-bridge optimize baseline --precise       # real tokenizer if AGENT_BRIDGE_TOKENIZER_MODULE is set
agent-bridge optimize baseline --json          # machine-readable
agent-bridge optimize baseline --record        # log it as a run for `optimize report`
```

This models orientation cost (reading files to rediscover structure); it does
not claim the agent would never open a file. On this repo it reports ~96% saved
across the top 30 files.

`--record` logs the measurement to the `runs` table. View the trend with:

```bash
agent-bridge optimize report --baseline      # recorded baseline savings over time
agent-bridge optimize report                  # compiled-context size trend (excludes baseline runs)
```

### Dashboard (UI)

`agent-bridge ui` has an **Optimize** tab:

- Stat tiles for latest saved %, tokens saved, files compared, and the compiled
  brief average.
- **Run Baseline Measurement** — a button (with optional file limit and focus
  paths) that runs the comparison live, records it, and shows the raw-vs-index
  breakdown.
- **Savings History** — recorded baseline runs, most recent first.
- **Most Expensive Files If Read Raw** — per-file token costs the repo map lets
  an agent skip.

Backing endpoints: `POST /api/optimize/baseline` (live measure + record) and an
`optimizeStats` block in `GET /api/state` (cheap, DB-only trend for live
refresh).

`injectRepoMap` and `repoMapLimit` are persisted in `config.json` under `graph`,
and are also editable from the dashboard (see below). CLI flags
(`--no-repo-map`, `--repo-map-limit`) override the config per run.

## Dashboard (UI)

`agent-bridge ui` has a **Graph** tab:

- **Graph Settings** — a "Build / Rebuild Graph" button (scans the repo), a
  "Refresh All Briefs" button (regenerates every file's auto-brief, since a
  build leaves briefs untouched), a toggle for repo-map injection, and the
  repo-map file limit. Settings save to `config.json`.
- **Repo Map** — the exact compact text injected into compiled context.
- **Dependency Graph** — an interactive force-directed visualization: each node
  is a file, arrows point from importer to imported, and node size/colour
  reflects fan-in (how many files import it). Drag nodes to rearrange; hover for
  details. Use the focus box (e.g. `src,auth`) and limit to scope large repos.

Backing HTTP endpoints: `POST /api/graph/build`, `POST /api/graph/brief-auto-all`,
`GET /api/graph?limit=&focus=`, `POST /api/config/graph`. Graph stats are also
included in `GET /api/state`.
