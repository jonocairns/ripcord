---
name: typecheck
description: Run the workspace typechecker (`bun run check-types`) and report errors, optionally scoped to files changed in a PR. Use this BEFORE asserting "this signature change is safe for callers" or "this refactor doesn't break anything" — the compiler is the authoritative answer to those questions, not your manual call-site enumeration.
---

# Typecheck

This skill runs `bun run check-types` against the workspace and parses the tsc output into a structured report. When invoked with `--pr N`, it filters errors to the files changed in that PR — turning a "did this PR break anything?" question into a yes/no with file:line evidence.

## When to use

Use this skill when:

- The PR changes the signature of an exported symbol (added/removed parameters, narrowed types, changed return types).
- The PR widens or narrows a type used in many places (e.g. `T` → `T | null`).
- You are about to manually enumerate call sites to verify a change is safe — let the compiler do it instead.
- You want a quick "is this PR green?" check before reading the diff in detail.

Skip this skill when:

- The PR only changes non-TS files.
- The PR is purely additive (new file, no exported-symbol changes elsewhere).

## How to invoke

```bash
bun run scripts/pr-review/typecheck.ts --pr <PR_NUMBER> --format markdown
```

Without `--pr`, runs the full workspace typecheck:

```bash
bun run scripts/pr-review/typecheck.ts --format markdown
```

To scope to a specific workspace:

```bash
bun run scripts/pr-review/typecheck.ts --scope @sharkord/server
```

The script:

- Runs `bun run check-types` (or `bun run --filter <scope> check-types` if `--scope` is given).
- Parses the standard tsc error format `file(line,col): error TSxxxx: message`.
- When `--pr N` is supplied, narrows the reported errors to files in that PR's diff.
- Caps rendered errors at 50 to keep output bounded; the JSON form contains the same set.

## How to use the output

1. **Treat `Result: PASS` as ground truth for type-level concerns.** If the compiler is happy, do not write review comments speculating about "callers might break" — they don't, by construction.
2. **Treat `Result: FAIL` as the most important signal in the review.** The PR doesn't compile; nothing else matters until that's resolved. Quote the first error with file:line and stop.
3. **`Errors in PR-changed files (#N)` separates "this PR broke X" from "X was already broken on main".** Pre-existing errors aren't this PR's responsibility — focus on `inScopeErrors`.
4. **Combine with `ts-impact` for behavioral concerns.** Typecheck answers "do callers still compile?". ts-impact answers "what are the callers?". Use both: typecheck rules out type breakage, ts-impact tells you who needs to be re-verified for runtime/behavior changes.

## What the output does NOT tell you

- Behavioral or semantic correctness — a typecheck pass means the types line up, not that the logic is right.
- Test failures — that's a separate concern.
- Errors masked by `// @ts-ignore` / `// @ts-expect-error` / `any` — the compiler will not flag them. Read the diff for those.
- Runtime errors that depend on values rather than types (e.g. null checks the type system can't prove).

## Output shape

```json
{
  "repoRoot": "/abs/path/to/repo",
  "generatedAt": "2026-05-09T...",
  "cmd": "bun run check-types",
  "exitCode": 0,
  "passed": true,
  "totalErrors": 0,
  "inScopeErrors": 0,
  "pr": 147,
  "changedFiles": ["apps/server/src/db/schema.ts", "..."],
  "errors": [],
  "truncated": false
}
```
