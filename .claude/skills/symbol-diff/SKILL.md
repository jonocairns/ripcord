---
name: symbol-diff
description: Compare exported TypeScript symbols against the PR base and report added, removed, or modified public symbols, signature/member changes, and added/removed callees with coarse side-effect risk tags. Use when a PR changes TypeScript behavior, public module APIs, shared helpers, or review reasoning depends on what changed inside exported symbols.
---

# Symbol diff

This skill uses `scripts/pr-review/symbol-diff.ts` to compare changed TypeScript files against the PR base.

It complements:

- `ts-impact`, which answers "who calls this exported symbol?"
- `import-graph`, which answers "which files import which files?"
- `typecheck`, which answers "does this compile?"

`symbol-diff` answers "what exported symbols changed, and what calls/side effects changed inside them?"

## When to use

Use this skill when:

- A PR changes exported functions, classes, interfaces, type aliases, enums, or exported constants.
- A review concern depends on signature changes, required/optional property changes, or public class/interface member changes.
- A changed exported function now calls a new risky dependency such as DB, network, auth, filesystem, shell, logging, crypto, or timing APIs.
- You need a structured summary before deciding where to spend review attention.

Skip this skill when:

- The PR only changes tests, docs, SQL, generated files, or non-TypeScript assets.
- You only need direct caller counts; use `ts-impact`.
- You only need route call sites; use `trpc-edges`.

## How to invoke

Use the configured `symbol-diff` analyzer command for this repo:

```bash
<symbol-diff analyzer command>
```

For machine-readable output:

```bash
<symbol-diff analyzer command> --format json
```

## How to use the output

Treat this as review triage and evidence:

1. Signature/member changes identify potential API compatibility risks.
2. Added callees identify new side effects or dependencies to inspect in the diff.
3. Removed callees can reveal lost auth checks, cleanup, persistence, logging, or validation.
4. Risk tags are coarse hints, not findings. Read the code before commenting.

## Commenting rules

- Cite `symbol-diff` only when it supports a concrete issue.
- For compatibility findings, cite the old and new signature/member reported by the tool.
- For behavior findings, cite the added/removed callee and explain the realistic failure path.
- Do not comment just because a risk tag exists. The changed code must make the risk real.
