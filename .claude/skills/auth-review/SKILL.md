---
name: auth-review
description: Apply a stricter, repo-specific review pass to changes that touch authentication, authorization, permissions, or session handling. Use whenever the diff modifies files under `apps/server/src/http/`, `apps/server/src/routers/channels/*permission*`, `apps/server/src/utils/trpc.ts`, or any file that contains `protectedProcedure`, `publicProcedure`, `hasPermission`, `authenticated`, `authToken`, `refreshToken`, `passwordHash`, or `cookie`. Auth bugs have catastrophic blast radius — this skill enumerates the specific patterns to verify in this codebase.
---

# Auth-touch review

When the diff touches auth/authorization, this skill defines the specific things to check in *this* codebase. Treat the checklist as a gate: every applicable item should be considered before the review concludes.

## When to apply

Apply this skill when the PR diff touches any of:

- `apps/server/src/http/auth-tokens.ts`
- `apps/server/src/http/refresh.ts`
- `apps/server/src/http/upload.ts` (uses auth tokens for file access)
- `apps/server/src/utils/trpc.ts` (defines `protectedProcedure`/`publicProcedure`)
- `apps/server/src/utils/wss.ts` (websocket auth)
- Any file under `apps/server/src/routers/channels/` matching `*permission*`
- Any file that newly calls `protectedProcedure`, `publicProcedure`, `hasPermission`, `invariant(ctx.authenticated, ...)`, or sets/reads `cookie`/`authToken`/`refreshToken`/`passwordHash`/`tokenVersion`

If none of the above apply, skip this skill entirely.

## Repo-specific procedure conventions

This codebase splits tRPC procedures into:

- `publicProcedure` — no auth required. Anything attached to this is callable by unauthenticated clients.
- `protectedProcedure` — requires `ctx.authenticated`.
- `rateLimitedProcedure(...)` — wraps `publicProcedure` with rate limiting; still unauthenticated.

A new endpoint added to the router must use the correct base. Adding a sensitive operation to `publicProcedure` is a bug, not a stylistic choice.

## Checklist (verify each that applies)

### Procedure base correctness

1. **Every new query/mutation that reads or modifies user-scoped data uses `protectedProcedure`**, not `publicProcedure`. Verify by reading the procedure definition, not just the file.
2. **Permission checks (`hasPermission`, `invariant(...)`) are present at the start of the handler**, before any side-effectful work. A handler that does work and *then* checks permission is a bug.
3. **Permission checks compare against the correct scope** — channel-permission data should be evaluated as channel-permission data, not user roles (per AGENTS.md: `useChannelPermissionsById` results are channel-permission data, not user roles).

### Token / session handling

4. **Auth tokens are not logged.** Search the diff for `logger.info`, `logger.debug`, `logger.error`, `console.log`, etc. and verify they don't include token values, password hashes, or session secrets.
5. **`tokenVersion` is incremented on credential changes** (password change, forced logout). Failing to increment lets old tokens stay valid.
6. **Cookies set for auth use `httpOnly`, `secure`, and `sameSite`** unless there's an explicit, justified reason otherwise.
7. **Refresh-token rotation is preserved.** Any change to refresh flow must still invalidate the old refresh token after a successful exchange.

### WebSocket auth

8. **WSS connections check `authenticated` before attaching user-scoped state.** A new message handler in `wss.ts` that mutates per-user state must verify the sender owns that state.

### File / upload auth

9. **Upload endpoints validate that the requesting user owns the target resource** (channel, message, profile). A user must not be able to upload to another user's resource by guessing IDs.

### Permission API surface

10. **New permission strings added to the database must be present in the application code's permission enum/check** (and vice versa). Mismatch = silent permission failures.
11. **Removed permissions** in migrations have a corresponding `DELETE FROM channel_role_permissions WHERE permission = '...'` and equivalent for `channel_user_permissions` (per the existing pattern in migration `0009`).

### Trust boundaries

12. **Input validation at the boundary.** New procedures should use Zod (or equivalent) to validate input. A handler that destructures user input without validation is a bug, even if TypeScript types it.
13. **No `as` casts on auth-relevant data.** Per AGENTS.md, `as` is reserved for rare test-only partial mocks. Casting auth context, user IDs, or permission results is a bug.

## How to comment

- Raise auth concerns as **inline comments**, not summary bullets — they need to be at the exact line.
- One comment per concern; do not pile multiple checklist items into one comment.
- Cite the specific checklist item by name (e.g. "Auth checklist #2 — permission check after side effect") so the author can find the rule.
- If the diff is fine on every applicable checklist item, do *not* leave a comment confirming so. Silence is approval.

## What this skill does NOT replace

- It does not check that the auth implementation itself is correct — assume the existing primitives (`protectedProcedure`, `hasPermission`, etc.) are correct and focus on whether the change uses them correctly.
- It does not run any tool. It is a structured review prompt.
- It does not catch concurrency bugs (token race conditions). Those are out of scope for static review.
