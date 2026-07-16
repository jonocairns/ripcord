---
name: typecheck
description: Run the configured workspace typechecker and report all current compiler errors, with an auxiliary count of errors located in PR-changed files. Use when a PR changes exported signatures, shared types, route contracts, or cross-workspace TypeScript APIs. Treat the compiler as evidence of type compatibility, not proof of behavioral correctness or PR causality.
---

# Typecheck

Run the configured `typecheck` analyzer command from the review prompt. Common forms are:

```bash
<typecheck analyzer command> --pr <PR_NUMBER> --format markdown
<typecheck analyzer command> --format markdown
<typecheck analyzer command> --scope <workspace-scope>
```

## Interpret the report

- `passed: true` means the current checked-out tree compiles under the configured command.
- `errors` contains errors from the entire typecheck, including unchanged callers that a changed API may have broken.
- `errorsInChangedFiles` is only a location count. It does not prove those errors were introduced by the PR.
- The analyzer does not compare against `main`; establish causality from the diff or a separate base-branch run.
- A passing typecheck rules out compiler-visible incompatibilities only. It does not cover behavior, tests, non-TypeScript consumers, `any`, or suppressed errors.

Use `ts-impact` for reference and call locations when a compiler-visible change still needs behavioral review.

## Review behavior

- Cite a compiler error only when its relationship to the change is concrete.
- Do not stop the rest of the review after finding one type error; CI may already report it, while independent correctness issues can remain.
- Do not speculate that callers fail when the complete typecheck passes, unless the concern is outside TypeScript's coverage.

The JSON report includes `repoRoot`, `cmd`, `exitCode`, `passed`, `totalErrors`, `errorsInChangedFiles`, `changedFiles`, `errors`, and `truncated`.
