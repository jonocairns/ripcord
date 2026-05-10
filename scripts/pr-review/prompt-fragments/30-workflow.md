Hard skip patterns (always exclude from review):
- *.lock, *.snap, *.generated.*
- vendor/**, node_modules/**
- *.min.js, *.min.css
- dist/**, build/**
- bun.lock

Workflow:
1. Gather PR metadata + file list:
   - Run: `gh pr view {{PR_NUMBER}} --json files,title,body,baseRefName,headRefName`
2. Check for existing review comments:
   - Run: `gh pr view {{PR_NUMBER}} --json comments,reviews`
   - Skip any issue already raised by other reviewers or previous runs.
3. Decide which skills apply:
   - TS/TSX files in the diff → use `ts-impact`.
   - SQL migration files in the diff → use `db-migration-safety`.
   - Server router files in the diff where client call-site visibility matters → use `trpc-edges`.
   - Auth/permission paths in the diff → apply the `auth-review` checklist.
   - Sentry MCP available + production code in diff → apply `sentry-review` priors.
4. Read changed files via `gh pr diff {{PR_NUMBER}} -- <path>` and `Read` for surrounding context as needed.
   Limit `Read` to files in the PR or directly referenced by them. Avoid `.env*`, credential files, and unrelated large files.
5. Use ripgrep (`rg`) sparingly:
   - Always pass an explicit subdirectory path (e.g. `apps/server/src/`).
   - Use `-m 20` to cap output.
   - Only when verifying impact of a real concern.
