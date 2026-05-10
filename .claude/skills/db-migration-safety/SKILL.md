---
name: db-migration-safety
description: Audit Drizzle/SQLite migration files in a PR for production-unsafe patterns (NOT NULL ADD COLUMN without DEFAULT, table drops, DELETE without WHERE, statements duplicated from earlier migrations, etc). Use whenever the PR adds or modifies a `.sql` file under `apps/server/data/drizzle/` or any `migrations/` directory. Migration bugs are one of the highest-incident-rate classes of bug — run this skill before approving any migration change.
---

# DB migration safety

This skill runs a static check over migration SQL files in the PR and reports unsafe patterns with severity, line numbers, and suggested fixes.

## When to use

Use this skill whenever the PR contains changes (added or modified) to:

- `apps/server/data/drizzle/*.sql`
- `apps/server/src/db/migrations/*.sql`
- Any file matching `**/migrations/*.sql`

Run it BEFORE commenting on the migration. The output is the source of truth for safety concerns — do not invent migration concerns the tool didn't flag, and do not dismiss concerns the tool did flag without explicit reasoning.

## How to invoke

From the repo root:

```bash
bun run scripts/pr-review/migration-check.ts --pr <PR_NUMBER> --format markdown
```

Or with a direct file list:

```bash
bun run scripts/pr-review/migration-check.ts apps/server/data/drizzle/0010_new_thing.sql
```

## Rules checked

| Rule | Severity | What it catches |
|---|---|---|
| `ADD_COLUMN_NOT_NULL_WITHOUT_DEFAULT` | error | `ALTER TABLE ... ADD COLUMN ... NOT NULL` with no `DEFAULT` — fails on tables that already have rows. |
| `ADD_COLUMN_UNIQUE` | error | SQLite forbids adding a `UNIQUE` column via `ALTER TABLE`. The migration will fail at runtime. |
| `DROP_TABLE` | warning | Irreversible. Requires confirming no live reads/writes target the table. |
| `DROP_COLUMN` | warning | Verify no code references the column before merging. |
| `DELETE_WITHOUT_WHERE` | error | Wipes the entire table. Almost always a bug. |
| `UPDATE_WITHOUT_WHERE` | warning | Applies to every row — may be intentional for backfills, but must be confirmed. |
| `TRUNCATE` | error | Wipes the table. Confirm intent. |
| `DUPLICATE_OF_OLDER_MIGRATION` | error | Statement appears verbatim in an earlier migration. Drizzle's `db:gen` can re-emit older statements, producing migrations that fail to apply. |
| `DROP_TABLE_IN_RECREATE_IDIOM` | info | DROP_TABLE statements inside the SQLite recreate-table idiom (`CREATE __new_X` → `INSERT…SELECT` → `DROP X` → `RENAME __new_X`) are auto-downgraded to info. Drizzle emits this for column constraint changes (nullability, FK ON DELETE, defaults) and the DROP is data-preserving by construction. |

The `DUPLICATE_OF_OLDER_MIGRATION` rule is repo-specific and codifies a known pitfall recorded in `AGENTS.md`. The `DROP_TABLE_IN_RECREATE_IDIOM` reclassification suppresses what would otherwise be a noisy false-positive on every nullability/constraint change.

## How to use the output

1. **Errors must be addressed in the PR.** If the tool reports an error, leave a single inline comment on the offending line citing the rule, the message, and the suggested fix.
2. **Warnings need confirmation, not necessarily a change.** For each warning, either confirm the intent in the PR description was clear, or ask the author to confirm in a single summary comment.
3. **Do not duplicate the tool's output.** The tool already cites line, statement, rule, and fix. Reference these once per finding; do not re-explain.
4. **Do not generate migration concerns the tool did not flag.** If the tool reports zero findings on a migration, do not speculate about edge cases. The tool's rule list is curated for real production failure modes; speculative concerns are noise.

## What this skill does NOT cover

- It does not check whether the schema change is semantically correct (e.g. type compatibility with the application code). Verify by reading the schema and surrounding code.
- It does not catch performance issues (lock contention, large rewrites). For SQLite this is rarely a concern; for Postgres migrations it would matter.
- It does not catch deploy-ordering issues (code shipped before migration applied). That belongs in the operational-readiness check, not this skill.
- It does not check if a `DROP COLUMN` is safe in the running schema — it just flags it for human verification.

## Output shape

```json
{
  "files": [
    {
      "file": "apps/server/data/drizzle/0010_new_thing.sql",
      "statementCount": 4,
      "findings": [
        {
          "rule": "ADD_COLUMN_NOT_NULL_WITHOUT_DEFAULT",
          "severity": "error",
          "line": 3,
          "snippet": "ALTER TABLE `users` ADD COLUMN `must_change_password` integer NOT NULL",
          "message": "ADD COLUMN with NOT NULL but no DEFAULT will fail on tables that already contain rows.",
          "fix": "Add a sensible DEFAULT, or split into: (1) add column nullable, (2) backfill, (3) tighten constraint."
        }
      ]
    }
  ],
  "summary": { "totalFiles": 1, "totalFindings": 1, "errorCount": 1, "warningCount": 0 }
}
```
