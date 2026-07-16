# PR Review Toolkit

This folder contains deterministic context tools for the AI PR reviewer.

The goal is not "AI reads a diff and gives opinions." The goal is to give the
model enough repo-aware evidence that it can review more like a strong teammate
than a smart outsider.

## CI usage

The GitHub workflow in `.github/workflows/claude-review.yml` is label-gated.

- Add the `ai-review` label to a pull request to run the Claude review job.
- Once the label is present, later pushes to that PR will rerun the review on
  `synchronize` events.
- `workflow_dispatch` remains available for manual runs once the workflow exists
  on the default branch.

This keeps the trigger self-serve for repos that do not use GitHub teams for
review routing.

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
- Inline comments should use this presentation style:
  - first line is a severity badge (`P0`/`P1`/`P2`) plus a short bold title,
  - then a concise explanation of the failure path and impact,
  - then an optional GitHub suggestion block when the fix is local and exact,
  - and no extra AI-helper boilerplate in the comment body.
  - badge assets are repo-owned under `.github/assets/pr-review-badges/` and should be referenced via stable raw GitHub URLs, not third-party buckets.

## Severity rubric

- `P0`: auth bypass, data loss/corruption, hard deploy break, major client/server
  compatibility break, or another incident-class regression.
- `P1`: likely user-visible bug, broken invariant on a real path, migration or
  runtime failure, or a reliability issue with clear blast radius.
- `P2`: important but non-catastrophic issue with a concrete production or
  architectural impact.
- Lower than `P2`: summary-only or silence.

## Current tools

- `pr-impact.ts`: resolves exported symbol references, direct calls, and rough
  call-shape data so the reviewer can reason about blast radius without
  conflating imports with invocations.
- `symbol-diff.ts`: compares changed exported TypeScript symbols against the PR
  base, including signatures, public members, and added/removed callees.
- `trpc-edges.ts`: maps server tRPC route handlers to client call sites, closing
  a gap that normal TS reference analysis cannot see.
- `migration-check.ts`: codifies known migration failure modes, including a
  repo-specific duplicate-migration pitfall from Drizzle.
- `typecheck.ts`: compiler-grounded validation that reports all current errors.
  Changed-file counts describe error location only; they do not attribute an
  error to the PR.
- `build-import-graph.ts`: builds import topology for richer context queries.

## Configuration seam

This toolkit now has a repo-local configuration file at
`.pr-review/review.config.json`.

That file is the first extraction seam. It holds the repo-specific parts that a
shared toolkit should not hardcode:

- TypeScript tsconfig discovery preferences
- migration directories, dialect, and statement-break markers
- tRPC entrypoints, route adapter settings, and client tsconfigs
- typecheck command templates and output parsers
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

## Adapter seams

The toolkit is moving toward a smaller generic core plus repo-local adapters.

- `typecheck.ts` is config-driven on both command shape and error parsing.
- `migration-check.ts` keeps generic SQL safety rules in code, while
  dialect/framework details such as SQLite-only checks and statement-break
  markers live in config.
- `trpc-edges.ts` exposes its route-discovery assumptions via config
  (`routeAdapter`, `routerFactoryNames`) and now reports degraded or unsupported
  coverage explicitly when a repo falls outside the supported adapter.

That means "less specific" does not mean "less strict." It means the strict
parts should be declared at the config/adapter layer rather than hidden in the
core scripts.

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

The highest-value next step is to keep separating **tools** from **review
methods**.

- Tools are deterministic analyzers in `scripts/pr-review/`. They should produce
  concrete evidence such as changed symbols, reference and call lists, import edges, compiler
  errors, migration findings, previous review comments, or config surface
  changes.
- Review methods are skills in `.claude/skills/`. They tell the reviewer how to
  use evidence, when to stay silent, and how to connect facts to realistic
  failure paths.

The toolkit should avoid adding prompt-only "smart-sounding" skills unless they
have concrete evidence behind them or a tightly scoped checklist. The model does
judgment; tools provide auditable facts.

### Implemented evidence tools

- `pr-impact.ts`: exported-symbol reference, direct-call, and call-shape evidence.
- `symbol-diff.ts`: exported-symbol signature/member/callee deltas and coarse
  side-effect risk tags.
- `build-import-graph.ts`: file-level import topology.
- `typecheck.ts`: compiler-grounded type safety evidence.
- `migration-check.ts`: SQL migration safety checks.
- `trpc-edges.ts`: tRPC route-to-client call-site mapping.

### Generic analyzer roadmap

These are broadly useful across repositories and should be implemented as
deterministic tools before being promoted heavily in the prompt.

- `review-memory`: fetch prior review comments, unresolved threads, previous AI
  summaries, and author replies. Output already-raised issues, fixed/rejected
  issues, and open threads so the reviewer does not duplicate comments across
  pushes.
- `test-impact`: map changed source files to likely tests using import graph
  reverse edges, naming conventions, package boundaries, and existing test
  imports. Output likely relevant tests and whether test files changed.
- `public-api-diff`: compare exported package/module APIs against the base ref.
  Output removed exports, narrowed types, required parameter additions, and
  public class/interface member changes.
- `dependency-boundary`: check new imports against configured layer/package
  boundaries. Output concrete offending import edges, not broad architecture
  opinions.
- `cycle-detect`: detect new import cycles introduced by the PR.
- `config-surface-diff`: summarize changed environment variables, feature flags,
  workflow permissions, package scripts, dependency versions, exposed ports, and
  build config. These changes often have large effects but are easy to miss.
- `security-diff-scan`: diff-only scan for secrets, dangerous sinks, token/cookie
  handling, auth/logging changes, shell execution, path traversal, and SQL/string
  construction.
- `error-handling-diff`: detect newly swallowed errors, empty catches, removed
  awaits, fire-and-forget promises, broad fallback defaults, and removed logging
  context.
- `db-schema-diff`: compare ORM/schema changes to migration SQL so the reviewer
  can catch missing migrations or generated migrations that include unrelated
  old deltas.

Recommended generic build order:

1. `review-memory`
2. `test-impact`
3. `public-api-diff`
4. `dependency-boundary` and `cycle-detect`
5. `config-surface-diff`
6. `error-handling-diff`
7. `security-diff-scan`

### High-value review methods

These are review lenses that may use one or more tools underneath. Add them as
skills only when the instructions are concrete enough to reduce noise.

- `behavior-diff`: summarize semantic behavior changes, not just file changes.
  Example: "session refresh changed from fail-closed to retry-and-reuse-old-token
  on network failure."
- `negative-space-review`: identify files or artifacts that probably should have
  changed but did not, such as tests, clients, docs, migrations, compatibility
  shims, or call sites.
- `missing-case-finder`: look for newly introduced states, enum members, null
  branches, permission modes, or transport states that lack handling.
- `concurrency-race-review`: inspect stale async responses, overlapping
  mutations, cleanup ordering, lost retries, stale closures, and operation
  ordering bugs.
- `data-lifecycle-review`: follow creation, mutation, persistence, deletion,
  migration, and cleanup for important domain objects.
- `change-intent-checker`: compare PR title/body/linked issue intent to the
  actual diff and flag accidental scope creep.
- `risk-calibrated-test-advisor`: suggest tests only when there is a concrete
  behavior risk, naming the existing test location, input, and expected output.

### Repo-specific review skills

Move important durable repo knowledge out of general instructions and into
targeted review skills. Likely areas:

- voice/reconnect/recovery review,
- desktop/electron review,
- API/backward-compat review,
- React/HMR/effects review,
- auth/session/token lifecycle review,
- and other subsystem-specific invariant checklists.

This keeps the reviewer grounded in the real failure modes of this repository
instead of producing generic AI review output.
