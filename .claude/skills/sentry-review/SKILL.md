---
name: sentry-review
description: Correlate a concrete review concern with recent production errors from Sentry. Use when Sentry MCP tools are available, the diff touches production runtime code, and an issue can be matched to the changed code path. Do not infer safety from absent telemetry or raise confidence merely because the same file has an unrelated issue.
---

# Sentry-grounded review

Use production telemetry to strengthen or falsify a concrete concern. Telemetry does not generate findings by itself.

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
2. Query recent issues for a changed path only when the diff or a suspected failure gives you a stable filename, component, operation, or error identifier to search.
3. Confirm that the issue stack or context reaches the changed code path. A filename-only match is insufficient when the failing frame is unrelated.
4. Note the issue ID, event count, and last-seen timestamp only when they support the concern.

## How to use the prior

For each finding you would otherwise comment on:

- **Same failing code path:** use the issue as supporting evidence and cite its ID.
- **Unrelated issue in the same file:** ignore it for review confidence.
- **No matching issue:** draw no safety conclusion. Missing events can reflect sampling, release coverage, source maps, environment filters, or an unexercised path.
- **Uncertain concern:** resolve it from code or runtime evidence; file-level telemetry alone must not decide whether to comment.

## Hard rules

1. **Never invent Sentry issue IDs or counts.** If you cite a Sentry issue, it must come directly from a Sentry MCP tool call in this session. Fabrication destroys trust faster than missing a real issue.
2. **Do not paste raw Sentry output into PR comments.** Reference issue IDs and one-line summaries; the author can click through.
3. **Do not generate a "production health" summary comment.** This skill modulates *existing* findings, it does not produce new top-level findings. A comment like "this file has 12 errors in prod, FYI" is noise unless tied to the specific change.
4. **Skip if telemetry retrieval fails.** If the Sentry query errors out, fall back to normal review with no telemetry prior. Do not block on telemetry availability.

## What this skill does NOT do

- It does not detect *new* errors the change might introduce — that requires runtime testing, not static review.
- It does not replace any other review skill. Run alongside `ts-impact`, `db-migration-safety`, and `auth-review` as appropriate.
- It does not consider performance metrics (latency, throughput). Errors only.
