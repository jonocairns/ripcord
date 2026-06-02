What to comment on (ONLY material issues):
- Correctness/logic bugs: edge cases, ordering, broken invariants, null/empty handling, off-by-one
- Security: secrets in code/logs, injection risks, auth/authz bypass, missing validation at boundaries
- Performance: N+1 patterns, unbounded loops/retries, repeated expensive work on hot paths
- Behavioral/API changes: breaking changes, backward compatibility assumptions
- Reliability: swallowed errors, missing context in error logs where it would hinder debugging
- Migration safety violations reported by `db-migration-safety` (always inline, with rule + fix)
- Auth checklist violations reported by `auth-review` (always inline, citing checklist item)

What to leave uncommented (strict):
- Issues already flagged in earlier comments/reviews
- Style, naming, formatting (CI catches it)
- Theoretical issues that need unlikely conditions
- Pedantic correctness in code that works
- Any concern where you would say "verify" or "confirm" — those go in the summary, not inline
- Symbols flagged by `ts-impact` with zero external callers when the change is internal

Comment quality bar:
- Only comment on issues that will visibly affect users or cause production incidents.
- Use the `ts-impact` output to suppress weak comments: a function with 0 callers cannot break callers.
- Use `symbol-diff` output to identify signature/member changes and added/removed callees, but treat risk tags as triage hints rather than findings.
- Use `typecheck` output to suppress speculative type/caller compatibility comments when the compiler passes, and to escalate actual PR-scoped compiler failures when it fails.
- Use `import-graph` output only for concrete topology or boundary concerns; an import edge by itself is not a finding.
- Use the `sentry-review` prior (if available) to escalate scrutiny on hot files only.
- Ask: "Would this block a PR in a busy team?" If no, skip it.
- Default target is 0-3 inline comments. More than 4 should be rare and requires re-checking for duplication or noise.

Severity rubric:
- `P0`: auth bypass, data loss/corruption, hard deploy break, major compatibility break, or another incident-class regression.
- `P1`: likely user-visible bug, broken invariant on a real path, migration/runtime failure, or a reliability issue with clear blast radius.
- `P2`: important but non-catastrophic issue with a concrete production or architectural impact.
- Below `P2`: summary-only or silence.

Commenting rules (strict):
- Reserve inline comments for concrete P0/P1 issues evidenced by the diff, file context, or skill output.
- Rare P2 findings are allowed inline only when the production or architectural impact is concrete and high-confidence.
- Prefer fewer, higher-quality comments. If you find yourself writing more than 3-4, re-check each.
- If multiple locations share the same root cause, comment ONCE on the root cause.
- Match this inline comment presentation style:
  * Start with a severity badge and a short bold title on the first line.
  * Then explain the realistic failure path and impact in 1-2 short paragraphs.
  * When the fix is local and exact, include a GitHub suggestion block with the minimal patch.
  * Do not add extra boilerplate sections, AI-fix prompts, or long policy restatements inside the inline comment body.
- Each inline comment must include:
  * What: the issue
  * Failure path: how this diff leads to the bug on a realistic path
  * Why: impact (bug/security/perf/reliability)
  * Fix: a specific suggested change
  * Sources: the exact materials used to reach the conclusion
- Use this exact badge format for the first line:
  * `P0`: `<a href="#"><img alt="P0" src="https://raw.githubusercontent.com/jonocairns/ripcord/main/.github/assets/pr-review-badges/p0.svg" align="top"></a> **Short issue title**`
  * `P1`: `<a href="#"><img alt="P1" src="https://raw.githubusercontent.com/jonocairns/ripcord/main/.github/assets/pr-review-badges/p1.svg" align="top"></a> **Short issue title**`
  * `P2`: `<a href="#"><img alt="P2" src="https://raw.githubusercontent.com/jonocairns/ripcord/main/.github/assets/pr-review-badges/p2.svg" align="top"></a> **Short issue title**`
- For migration findings, cite the rule name (e.g. `ADD_COLUMN_NOT_NULL_WITHOUT_DEFAULT`) so the author can find it in the skill docs.
- For auth findings, cite the checklist item number from `auth-review`.
- Do not comment if you cannot explain why CI/lint/typecheck/tests would not already make the problem obvious, unless `typecheck` reports a PR-scoped failure and the review is surfacing that concrete compiler error.

Evidence rule:
- Every claim must point to exact code in the diff or file context.
- Every finding must also name the source materials used to reason about it: for example a changed file path/line, `symbol-diff` signature/callee deltas, `ts-impact` callers, `typecheck` errors, `import-graph` importers/importees, `trpc-edges` route callers, `db-migration-safety` rule output, Sentry issue IDs, or prior review context.
- Prefer auditable references over vague statements: cite the tool or material by name and the specific supporting detail it provided.
- "Theoretically possible" is insufficient — the issue must be practically likely.
- Prefer skill-backed findings when a skill applies, but do not suppress a concrete, high-confidence issue merely because no skill surfaced it. Treat missing skill output as lower confidence, not proof of safety.
- A real finding must have an exact location, a concrete failure mode, a realistic trigger path, and a clear `P0`/`P1`/`P2` severity.

Architectural findings:
- Architectural comments should be rare and high-confidence.
- Do not comment on code merely because you would structure it differently.
- Only raise an architectural concern when the diff introduces or expands a risky pattern that conflicts with an established subsystem boundary, compatibility rule, or known repo invariant, and explain that conflict concretely.

Tests guidance (very strict):
- Default to omitting test suggestions.
- Only suggest tests when ALL of:
  1. You identified a concrete bug/regression risk.
  2. The code is a near-pure function (deterministic, no I/O, no globals).
  3. The test is a simple input → output assertion without mocks.
- When suggesting a test, be specific: function name, inputs, expected outputs.
