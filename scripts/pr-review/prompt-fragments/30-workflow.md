Hard skip patterns (always exclude from review):
- *.lock, *.snap, *.generated.*
- vendor/**, node_modules/**
- *.min.js, *.min.css
- dist/**, build/**
- bun.lock

Workflow:
1. Gather PR metadata + file list:
   - Run: `gh pr view {{PR_NUMBER}} --json files,changedFiles,title,body,baseRefName,headRefName`
   - If the changed-file count exceeds {{FULL_REVIEW_FILE_LIMIT}}, switch to scoped review mode and do not attempt full diff coverage.
   - Before deciding on findings, form a concise PR synopsis:
     - what the PR changes overall,
     - the 2-4 main change areas,
     - and which 3-10 files are most important to understanding it.
   - Prefer grouping the synopsis by behavior or subsystem, not by directory only.
2. Check for existing review comments:
   - Run: `gh pr view {{PR_NUMBER}} --json comments,reviews`
   - Skip any issue already raised by other reviewers or previous runs.
3. Decide which skills apply:
   - TS/TSX files in the diff → use `ts-impact`.
   - Exported TypeScript APIs, public members, or side-effectful behavior in exported symbols changed → use `symbol-diff`.
   - Signature, exported type, route contract, or cross-workspace API changes → use `typecheck`.
   - Module moves, shared helper/provider rewiring, package boundary changes, or architecture-sensitive imports → use `import-graph`.
   - SQL migration files in the diff → use `db-migration-safety`.
   - Server router files in the diff where client call-site visibility matters → use `trpc-edges`.
   - Auth/permission paths in the diff → apply the `auth-review` checklist.
   - Sentry MCP available + production code in diff → apply `sentry-review` priors.
4. Read changed files via `gh pr diff {{PR_NUMBER}} -- <path>` and `Read` for surrounding context as needed.
   Limit `Read` to files in the PR or directly referenced by them. Avoid `.env*`, credential files, and unrelated large files.
   In scoped review mode, spend most reads on the highest-risk files and use the rest of the diff mainly for topology/context.
5. Use ripgrep (`rg`) sparingly:
   - Always pass an explicit subdirectory path (e.g. `apps/server/src/`).
   - Use `-m 20` to cap output.
   - Only when verifying impact of a real concern.
   - For import graph lookups, target `.pr-review-cache/import-graph.json` directly and keep output capped.
