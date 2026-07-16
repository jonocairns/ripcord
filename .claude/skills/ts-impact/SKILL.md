---
name: ts-impact
description: Map external TypeScript references and direct call sites for exported symbols changed by a PR, including first-argument object-literal shapes. Use for behavioral changes, exported API changes, renamed or removed symbols, and blast-radius analysis. Do not treat references as calls or zero results as proof that no dynamic, tRPC, or non-TypeScript consumer exists.
---

# TypeScript impact analysis

Run the configured `ts-impact` analyzer command from the review prompt:

```bash
<ts-impact analyzer command> --pr <PR_NUMBER> --format json
<ts-impact analyzer command> path/to/file.ts path/to/file.tsx
```

The report distinguishes:

- `references`: external imports and other symbol references.
- `calls`: references used directly as a call expression.
- `shape`: first-argument object-literal key frequencies for direct calls.
- `resolutionError`: incomplete reference resolution; fall back to `rg` for that symbol.

Location lists are capped, while counts cover all resolved locations.

## Use the evidence

- Use reference counts to prioritize widely shared symbols.
- Read affected call sites before asserting a behavioral or contract break.
- Use the shape histogram to locate direct calls that omit a changed object property; spreads and variable arguments still require manual inspection.
- Treat zero references as "none resolved by this TypeScript project," not proof that the symbol is unused. Check tRPC proxy consumers with `trpc-edges` and search for dynamic or non-TypeScript consumers when relevant.
- Cite exact locations only when they support a concrete failure path.

This analyzer does not establish behavioral correctness, test coverage, side-effect ordering, or compatibility with external consumers.
