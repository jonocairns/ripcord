---
name: trpc-edges
description: Map tRPC route handler files (server) to their client call sites by walking the t.router({...}) wiring and matching `<client>.<group>.<route>.{mutate,query,...}` chains across the workspace. Use this whenever a PR modifies a file under `apps/server/src/routers/` — `ts-impact` cannot follow tRPC's type-only proxy edges, so client callers of a changed route would otherwise be invisible to the review.
---

# tRPC edge resolver

This skill closes the client/server gap that exists in tRPC reviews. ts-impact resolves direct TypeScript references — but `trpc.users.setStatus.mutate(...)` on the client is a type-only proxy access, not a real import edge, so ts-impact reports zero callers for `setStatusRoute` (the actual handler). This script:

1. Parses the root `appRouter` and each sub-router's `t.router({ ... })` literal to build a `trpcPath → handler-file` map.
2. Walks the client (and any other configured workspace) for `CallExpression`s whose callee chain ends in a tRPC method (`mutate`, `query`, `subscribe`, `useMutation`, etc.) and matches a known route path as a suffix.
3. Reports per-route caller counts with file:line.

## When to use

Use this skill when:

- A PR changes any file in `apps/server/src/routers/**/*.ts` (excluding `index.ts` wiring files).
- You're about to comment on input/output contract changes for a route.
- You want to know whether a route is reachable from the client at all (dead routes return zero callers).

Skip this skill when:

- The PR only changes server-internal code (no router files).
- The PR only changes router `index.ts` wiring (the route names themselves are the contract; verify by reading the diff).

## How to invoke

Default mode — scope to PR-changed router files:

```bash
bun run scripts/pr-review/trpc-edges.ts --pr <PR_NUMBER> --format markdown
```

For a specific route:

```bash
bun run scripts/pr-review/trpc-edges.ts --route users.setStatus --format markdown
```

Full enumeration of every route → its callers:

```bash
bun run scripts/pr-review/trpc-edges.ts --all --format json
```

The script:

- Resolves routes by walking imports from `apps/server/src/routers/index.ts`. Sub-routers and handlers must be referenced via named imports — anonymous or re-exported handlers will appear in `unmappedRouteFiles`.
- Searches for callers using these client-side tsconfigs: `apps/client/tsconfig.app.json`, `apps/client/tsconfig.json`, `apps/desktop/tsconfig.json`, `packages/shared/tsconfig.json`. Add new workspaces by editing `CLIENT_TSCONFIGS` in the script.
- Recognizes leaf method names: `mutate`, `query`, `mutation`, `subscribe`, `useQuery`, `useMutation`, `useSubscription`, `useInfiniteQuery`.

## How to use the output

1. **Zero callers on a non-trivial route is a question, not a fact.** Either the route is genuinely unused (delete-candidate), or the call chain doesn't follow the recognized pattern (e.g. variable indirection like `const fn = trpc.users.setStatus.mutate; fn(...)`). Verify by grep before commenting.
2. **For input-shape changes, list each caller in the review.** A route adding a required field needs every caller updated; this skill gives you the precise list to verify against the diff.
3. **For output-shape changes, cite the highest-traffic call sites.** A route narrowing its return type ripples through every caller's destructuring; mention the most-impacted ones.
4. **Combine with `typecheck`.** typecheck answers "do callers compile?" after a route change; trpc-edges tells you *which files to re-verify* even when typecheck is silent (e.g. behavioral changes that don't affect types).

## What the output does NOT tell you

- Non-tRPC consumers (HTTP fetch, websocket events, server-internal helper imports) — use grep or ts-impact for those.
- Routes accessed via dynamic dispatch (e.g. building the path from a variable). The matcher is purely structural.
- Whether a caller uses the response, ignores it, or branches on it — that's a behavioral concern, read the diff.
- Subscriptions vs. mutations vs. queries — the leaf method name is reported, but contract differences are your judgment call.

## Output shape

```json
{
  "repoRoot": "/abs/path/to/repo",
  "generatedAt": "2026-05-09T...",
  "pr": 147,
  "totalRoutes": 3,
  "totalCallSites": 4,
  "routes": [
    {
      "trpcPath": "users.setStatus",
      "file": "apps/server/src/routers/users/set-status.ts",
      "exportName": "setStatusRoute",
      "callerCount": 2,
      "callers": [
        { "file": "apps/client/src/hooks/use-idle-away-checker.ts", "line": 52, "method": "mutate" },
        { "file": "apps/client/src/components/left-sidebar/user-control.tsx", "line": 89, "method": "mutate" }
      ]
    }
  ],
  "unmappedRouteFiles": []
}
```
