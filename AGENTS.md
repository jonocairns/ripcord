- Commits: conventional format (feat:, fix:, docs:, refactor:)
- PR description: use Markdown structure (e.g. ## Summary, ## Validation) with bullet lists for readability
- Underscore prefix for unused vars (^_)
- Avoid TypeScript as casting; prefer explicit types, narrowing, and fragment-driven typing. The only acceptable use of as is in test files for constructing partial mock data (e.g. as unknown as SomeType), and even then only when the full type is impractical to construct.
- Use nix for running repo commands with bun `nix develop -c bun run magic`
- Before committing, run `nix develop -c bun run magic` to catch formatting, typecheck, and lint issues together.
- Treat shipped desktop clients as potentially behind the latest server/API version.
- Default policy: API changes must be backward compatible.
- Naming pitfall: `useChannelPermissionsById` returns channel-permission data, not user roles. Avoid role-like variable names for its result (for example `ownUserRoles`).
- Migration pitfall: `nix develop -c bun run --filter @sharkord/server db:gen` can sometimes generate a migration that re-includes older schema changes (for example `refresh_tokens` or prior `ALTER TABLE` steps). Always review the generated SQL and keep only the intended new delta before committing.
- Reconnect pitfall: pending voice auto-rejoin state is consumed from `VoiceProvider`, so it must be gated on actual server connectivity. If it runs during disconnect cleanup when `currentVoiceChannelId` is reset to `undefined`, the saved channel can be spent against a dead TRPC client and be gone by the time reconnect succeeds.
- Test pitfall: server `bun test` commands that initialize the test DB expect the working directory to be `apps/server`; running them from the repo root can fail to find `drizzle/meta/_journal.json`.

The role of this file is to describe common mistakes and confusion points that agents might encounter on this project. If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in the AGENTS.md file to help prevent future agents from having the same issue.
