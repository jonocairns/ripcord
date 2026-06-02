---
name: import-graph
description: Use the generated TypeScript import graph to inspect direct importers/importees across workspaces. Use when a PR changes module boundaries, shared helpers, package exports, provider/context wiring, or architecture-sensitive imports where direct dependency topology matters.
---

# Import graph topology

This skill uses `scripts/pr-review/build-import-graph.ts` to build `.pr-review-cache/import-graph.json` from the checked-out review tree.

The graph is deterministic context, not a finding generator. Use it to answer targeted topology questions while reviewing.

## When to use

Use this skill when:

- A PR moves files, changes package/module boundaries, or rewires imports.
- A changed shared helper/provider/context/module may affect direct importers.
- You are evaluating an architectural boundary concern and need concrete import evidence.
- `ts-impact` is too symbol-focused and you need file-level dependency topology.

Skip this skill when:

- The PR is not TypeScript.
- The concern is about route call sites; use `trpc-edges` for tRPC reachability.
- You only need exported-symbol caller data; use `ts-impact`.

## How to invoke

Use the configured `import-graph` analyzer command for this repo:

```bash
<import-graph analyzer command>
```

The review workflow normally runs this once before Claude starts. Run the command manually only if the file is missing or you need to regenerate it after local changes.

## How to use the output

The JSON shape is:

```json
{
  "edges": {
    "importer.ts": ["imported.ts"]
  },
  "reverse": {
    "imported.ts": ["importer.ts"]
  }
}
```

Use `reverse[path]` to find direct importers of a changed file. Use `edges[path]` to see what a changed file imports.

Prefer targeted lookups. Do not read the whole graph into a review comment, and do not comment just because a dependency exists.

## Commenting rules

- Cite `import-graph` only when it supports a concrete finding.
- Include the exact changed file and the specific importer/importee path that proves the topology concern.
- Do not raise speculative architecture comments from graph shape alone. The graph must connect to a concrete production, compatibility, or maintainability failure path.
