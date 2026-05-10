---
name: sentry-review
description: Ground the review in production telemetry. For each TypeScript file changed in the PR, query Sentry for recent errors and use the result to set scrutiny priors. Files with active production errors get a stricter pass; files with no recent errors get a normal pass. Use whenever Sentry MCP tools are available and the diff touches production server or client code (excluding tests, types, and docs).
---

# Sentry-grounded review

This skill fuses production telemetry into the review. It does not generate comments by itself — it changes *how* you review the diff by surfacing which files are currently failing in production.

## When to use

Apply this skill when ALL of:

- The Sentry MCP tools are available in the session (`mcp__sentry__*`).
- The PR touches at least one source file that runs in production (for example server or client runtime code, excluding tests, fixtures, types, build scripts, docs, and generated code).
- The repo has a Sentry project configured (the server uses `@sentry/node`, the client captures render-time and global errors per recent commits).

Skip this skill if:

- Sentry MCP is not available in the session.
- The PR is documentation-only, configuration-only, or test-only.

## How to invoke

1. Authenticate with Sentry via the MCP if not already authenticated.
2. For each changed production file:
   - Query Sentry for recent issues mentioning the file path or its stable module/component identifier.
   - Note the issue count, frequency, and last-seen timestamp.
3. Build a per-file "production prior" mental model:
   - **Hot file**: ≥1 active issue in the last 7 days. Apply *stricter* scrutiny.
   - **Quiet file**: no recent issues. Apply *normal* scrutiny.
4. Use the prior to modulate review behavior, not to generate findings on its own.

## How to use the prior

For each finding you would otherwise comment on:

- **Hot file + finding touches the failing code path**: comment with elevated confidence. Cite the Sentry issue ID in the comment so the author can verify. Example: "This change rewrites a session/token recovery path. Sentry issue SHRK-1234 (47 events in last 7d) currently throws from this exact path — verify the existing recovery behavior is preserved."
- **Hot file + finding is unrelated to the failing path**: comment normally; do not mention Sentry.
- **Quiet file**: comment normally with no telemetry context.

For findings you are *uncertain about*:

- **Hot file**: lean toward commenting (the file is fragile; uncertainty is more costly here).
- **Quiet file**: lean toward staying silent (the file is stable; uncertainty is more costly the other way — you'll add noise).

## Hard rules

1. **Never invent Sentry issue IDs or counts.** If you cite a Sentry issue, it must come directly from a Sentry MCP tool call in this session. Fabrication destroys trust faster than missing a real issue.
2. **Do not paste raw Sentry output into PR comments.** Reference issue IDs and one-line summaries; the author can click through.
3. **Do not generate a "production health" summary comment.** This skill modulates *existing* findings, it does not produce new top-level findings. A comment like "this file has 12 errors in prod, FYI" is noise unless tied to the specific change.
4. **Skip if telemetry retrieval fails.** If the Sentry query errors out, fall back to normal review with no telemetry prior. Do not block on telemetry availability.

## What this skill does NOT do

- It does not detect *new* errors the change might introduce — that requires runtime testing, not static review.
- It does not replace any other review skill. Run alongside `ts-impact`, `db-migration-safety`, and `auth-review` as appropriate.
- It does not consider performance metrics (latency, throughput). Errors only.
