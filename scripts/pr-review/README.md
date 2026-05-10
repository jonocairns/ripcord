# PR Review Toolkit

This folder contains deterministic context tools for the AI PR reviewer.

The goal is not "AI reads a diff and gives opinions." The goal is to give the
model enough repo-aware evidence that it can review more like a strong teammate
than a smart outsider.

## Design goals

- High signal, low noise. The reviewer should bias hard toward silence unless it
  can explain a realistic production-impacting failure path from the diff.
- Deterministic context over generic prompting. The biggest review-quality gains
  come from topology, callers, contracts, migrations, and repo-specific
  invariants, not from making the prompt longer.
- Real-world findings over theoretical ones. Inline comments should focus on
  P0-P2 issues: correctness, security, reliability, compatibility, migrations,
  and meaningful architectural regressions.
- Repo-specific judgment. The reviewer should encode the scars of this codebase:
  known migration pitfalls, auth rules, tRPC reachability gaps, voice/desktop
  invariants, compatibility constraints, and subsystem-specific conventions.
- AI plus structured evidence. Humans review with context the diff does not
  contain. These tools should provide that context so the model can reason with
  more than surface-level code changes.

## Reviewer stance

- No inline comment unless the reviewer can point to:
  - an exact code location,
  - a concrete failure mode,
  - a realistic trigger path,
  - a clear severity (`P0`, `P1`, or `P2`),
  - why the issue matters in production or long-term maintenance,
  - and a specific fix.
- If the issue is uncertain, theoretical, low-severity, or likely already
  covered by CI/lint/typecheck/tests, it should be omitted or moved to a summary
  watch-out instead of becoming an inline finding.
- Findings should be traceable. When the reviewer states a conclusion, it should
  name the source materials used to reach it: the diff location, surrounding
  file context, a skill output (`ts-impact`, `trpc-edges`, `migration-check`,
  `typecheck`), Sentry issue IDs, or other concrete repo evidence.
- Architectural comments should be rare. "I would structure this differently" is
  not a finding. A comment is warranted only when the diff introduces or expands
  a risky pattern that conflicts with established subsystem boundaries or known
  repo invariants.

## Severity rubric

- `P0`: auth bypass, data loss/corruption, hard deploy break, major client/server
  compatibility break, or another incident-class regression.
- `P1`: likely user-visible bug, broken invariant on a real path, migration or
  runtime failure, or a reliability issue with clear blast radius.
- `P2`: important but non-catastrophic issue with a concrete production or
  architectural impact.
- Lower than `P2`: summary-only or silence.

## Current tools

- `pr-impact.ts`: resolves exported symbol callers and rough call-shape data so
  the reviewer can reason about blast radius instead of guessing.
- `trpc-edges.ts`: maps server tRPC route handlers to client call sites, closing
  a gap that normal TS reference analysis cannot see.
- `migration-check.ts`: codifies known migration failure modes, including a
  repo-specific duplicate-migration pitfall from Drizzle.
- `typecheck.ts`: optional compiler-grounded validation when the reviewer needs
  to confirm a claimed type break instead of speculating.
- `build-import-graph.ts`: builds cached import topology for future faster or
  richer context queries.

## Configuration seam

This toolkit now has a repo-local configuration file at
`.pr-review/review.config.json`.

That file is the first extraction seam. It holds the repo-specific parts that a
shared toolkit should not hardcode:

- TypeScript tsconfig discovery preferences
- migration directories
- tRPC entrypoints and client tsconfigs
- typecheck command templates
- prompt metadata such as repo label, invariants, analyzer runtime adapters, and
  Claude `allowedTools` policies

It also now distinguishes shared/core review assets from repo extensions:

- `coreSkills` / `repoSkills`
- `coreAnalyzers` / `repoAnalyzers`
- `coreAllowedTools` / `repoAllowedTools`
- `corePromptFragmentDirs` / `repoPromptFragmentDirs`

Keeping those details in config makes it possible to test the toolkit in-repo
while moving toward a reusable package or workflow later.

## Prompt layout

The reviewer prompt is no longer meant to live only inline in a workflow file.
Prompt fragments now live under `scripts/pr-review/prompt-fragments/`, and
`build-prompt.ts` assembles them with repo config into the final prompt used by
CI. The same builder also renders the config-driven Claude `allowedTools` string
so workflow runtime permissions come from the same adapter layer as the prompt.

This keeps the underlying review policy mostly capability-based while allowing a
thin runtime adapter layer to describe how a given repo actually runs analyzers.
It also makes the future extraction model explicit: ship a shared core, then let
repos layer on extra skills and analyzers such as `trpc-edges`.

## Scope guard

The toolkit now supports a simple context-protection guard via
`review.maxChangedFilesForFullReview` in `.pr-review/review.config.json`.

The workflow computes the PR's changed-file count and passes it to
`build-prompt.ts`. If the PR exceeds that configured limit, the prompt switches
the reviewer into scoped-review mode:

- run applicable deterministic analyzers,
- focus file reads and inline comments on the highest-risk areas,
- avoid pretending to provide full file-by-file coverage,
- and disclose the scoped review in the final summary comment.

This is intentionally a coarse admission-control check rather than a full
context-budget planner. It exists to prevent very large PRs from silently
blowing past the model's useful review context.

## Context strategy

To approach or beat Greptile-like usefulness, prioritize context primitives that
humans use implicitly:

- blast radius and callers,
- contract boundaries,
- schema/migration safety,
- production telemetry and hot-file priors,
- historical subsystem pitfalls,
- architectural invariants and compatibility rules,
- and change intent from PR metadata / prior review threads.

The model should do judgment; the toolkit should provide evidence.

That evidence should also be visible in the review output. A strong review does
not just say "this is wrong"; it makes the reasoning auditable by pointing back
to the exact materials that informed the conclusion.

## Future direction

The highest-value next step is to move important durable repo knowledge out of
general instructions and into targeted review skills. Likely areas:

- voice/reconnect/recovery review,
- desktop/electron review,
- API/backward-compat review,
- React/HMR/effects review,
- and other subsystem-specific invariant checklists.

This keeps the reviewer grounded in the real failure modes of this repository
instead of producing generic AI review output.
