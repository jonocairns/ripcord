---
name: ts-impact
description: Resolve the precise blast radius of a TypeScript change. Use whenever a PR modifies one or more `.ts`/`.tsx` files to find every caller/importer of changed exported symbols across the workspace, with file and line numbers. Use this BEFORE asserting "this change is safe" or commenting on behavioral changes — the tool gives you a deterministic caller list rather than guessing from the diff.
---

# TypeScript impact analysis

This skill runs a compiler-backed impact analysis (via ts-morph) over the TypeScript files changed in the current PR. It returns, per exported symbol, the exact list of callers (file + line) elsewhere in the workspace.

## When to use

Use this skill when:

- The PR touches at least one `.ts`/`.tsx` file (excluding tests, declarations, and build output).
- You are about to comment on a behavioral change, an API/contract change, or a renamed/removed symbol.
- You want to decide whether a change is "internal-only" (zero external callers) or "fans out across the codebase".

Skip this skill when:

- The PR only changes non-TS files (SQL, config, docs, Rust, etc.).
- The PR only changes test files.

## How to invoke

From the repository root, run:

```bash
bun run scripts/pr-review/pr-impact.ts --pr <PR_NUMBER> --format markdown
```

Or, if you already have a list of changed files:

```bash
bun run scripts/pr-review/pr-impact.ts apps/server/src/foo.ts apps/client/src/bar.tsx
```

For machine-readable output (recommended when piping into further analysis):

```bash
bun run scripts/pr-review/pr-impact.ts --pr <PR_NUMBER> --format json
```

The script:

- Filters out test files (`*.test.ts`, `*.spec.ts`), declaration files (`*.d.ts`), `node_modules`, and build output.
- Detects the nearest `tsconfig.json` for each changed file (per-app, not just the root).
- Emits a JSON or markdown report with per-symbol caller lists, capped at 25 callers each.
- For each callable export, also reports a **first-arg shape histogram**: out of all references in callee position, how many pass an object literal as their first argument, and how often each property key appears across those calls. This answers "how many callers pass `userId`?" without an ad-hoc grep — useful when judging the safety of removing a default parameter, tightening required keys, or renaming a property.

## How to use the output

The output is a deterministic fact, not an opinion. Use it to:

1. **Suppress weak comments.** If a function has zero external callers and the change is internal, do not comment on "potential behavioral changes for callers" — there are none.
2. **Escalate scrutiny on high-impact symbols.** Symbols flagged in `summary.highImpactSymbols` (>= 10 callers) deserve careful review — a behavior change there ripples widely.
3. **Cite specific call sites in comments.** When you do raise a concern, reference the exact `file:line` of the most-affected callers so the author can verify quickly.
4. **Ground the "is this a breaking change?" question.** If the diff narrows a return type or changes an error path, the caller list tells you which files need to be checked.
5. **Use the shape histogram to verify "does removing default X break callers?".** If the diff removes a default value for property `userId` and the histogram shows `userId: 38/39 callers`, you know exactly one caller relies on the default — go read that one rather than enumerating all 39 manually.

## What the output does NOT tell you

- It does not detect implicit contract changes (e.g. log format, side-effect ordering) — read the diff for those.
- It does not cover non-TS consumers (a Rust sidecar, an external service). Use `rg` for those.
- It does not analyze test coverage of the changed symbols — that is a separate concern.
- Reference resolution can fail for malformed code; if `error` is set on a file in the report, fall back to grep-based reasoning for that file only.

## Output shape

```json
{
  "repoRoot": "/abs/path/to/repo",
  "generatedAt": "2026-05-09T...",
  "files": [
    {
      "file": "apps/server/src/foo.ts",
      "tsconfig": "apps/server/tsconfig.json",
      "exportedSymbolCount": 3,
      "symbols": [
        {
          "name": "createSession",
          "kind": "function",
          "callerCount": 14,
          "callers": [{ "file": "...", "line": 42 }, ...],
          "truncated": false,
          "shape": {
            "calleeCount": 39,
            "objectLiteralCount": 39,
            "keyCounts": { "type": 39, "userId": 38, "details": 33, "ip": 2 }
          }
        }
      ]
    }
  ],
  "summary": {
    "totalFiles": 4,
    "totalSymbols": 12,
    "totalCallers": 87,
    "highImpactSymbols": [
      { "file": "apps/server/src/foo.ts", "symbol": "createSession", "callers": 14 }
    ]
  }
}
```
