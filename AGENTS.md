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
- IPTV pitfall: transient IPTV retry/reconnect paths should preserve the existing external stream identity when possible. Tearing down the external stream object during ffmpeg retries causes visible leave/join churn in clients.
- IPTV pitfall: combined byte-count health checks can hide video starvation when audio is still flowing. When debugging IPTV ingest, log or inspect video/audio tracks separately.
- IPTV pitfall: raising the transcode `maxrate`/`bufsize` globally can cause HD streams to micro-stutter without tripping the health checks. Keep IPTV transcode bitrate ceilings resolution/fps-aware and preserve low-latency encoder settings.
- IPTV pitfall: private-channel IPTV controls should treat global `MANAGE_CHANNELS` as sufficient for admins. Requiring only channel-level `MANAGE_IPTV` makes admin users look broken unless they also have a channel override.
- IPTV pitfall: the voice-stage IPTV button is hidden until `iptv.getViewerConfig` succeeds. Because voice join is optimistic on the client, a one-shot fetch can race the server-side `currentVoiceChannelId` update and hide the control even when permissions and overrides are correct.
- IPTV/client pitfall: external stream audio playback is already owned by `left-sidebar/voice-control` via `ExternalAudioStreams`. Rendering a second `<audio>` element for the same external stream inside `ExternalStreamCard` can steal the shared ref and make IPTV audio drop when the card unmounts during channel navigation.
- Reconnect pitfall: pending voice auto-rejoin state is consumed from `VoiceProvider`, so it must be gated on actual server connectivity. If it runs during disconnect cleanup when `currentVoiceChannelId` is reset to `undefined`, the saved channel can be spent against a dead TRPC client and be gone by the time reconnect succeeds.

The role of this file is to describe common mistakes and confusion points that agents might encounter on this project. If you ever encounter something in the project that surprises you, please alert the developer working with you and indicate that this is the case in the AGENTS.md file to help prevent future agents from having the same issue.
