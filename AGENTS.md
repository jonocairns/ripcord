- Base branches and PRs on `main`.
- Commits use conventional prefixes: `feat:`, `fix:`, `docs:`, `refactor:`.
- PR titles should be plain sentence case summaries of the feature or fix.
- PR descriptions should use Markdown sections such as `## Summary` and `## Validation`, with bullets for scanability.

- Run repo Bun commands through Nix. Before committing, run `nix develop -c bunx biome check --write <changed paths>` on files intentionally modified by the current task. This matches the editor's formatting, safe lint fixes, and import organization; review the resulting diff.
- After formatting, use non-mutating checks that match CI: `nix develop -c bun run check-types`, `nix develop -c bun run lint`, relevant package tests, and `nix develop -c bun run knip` when the change can affect imports or exports.
- Do not use the root `magic` script as a validation command because it formats the entire repository with `--write`, including unrelated files changed elsewhere on the branch.
- Lint warnings are CI failures. Fix warnings caused by the current task, and do not introduce new warnings.
- Do not assume local package manager tools are available outside the Nix shell.
- Review generated files before committing them. Database migrations must contain only the intended new schema delta, not regenerated historical changes.
- Run package-specific test commands from the directory expected by that package.
- Unit tests should cover app-specific behavior, regressions, branching state transitions, data transformation, validation, and side-effect boundaries. Avoid tests that only prove framework behavior or simple setters/callback plumbing.
- For tests that touch browser, audio, desktop, or network APIs at module load, prefer extracting side-effect-free helpers or mocking the side effect explicitly.

- Prefix intentionally unused variables with `_`.
- Prefer explicit types, control-flow narrowing, and fragment-driven typing over TypeScript `as` casts.
- Acceptable `as` usage: `as const` for literal inference, or rare test-only partial mocks when constructing the full type is impractical.
- Handle possibly undefined values with guards and narrowing instead of assuming presence.
- Name values after the data they actually contain. For example, channel permission data should not be named as if it were user role data.

- Keep React modules friendly to Vite HMR. Avoid exporting multiple unrelated React components from one file, especially alongside hooks or constants.
- Avoid `useEffect` for derived state or render-time computations. Prefer inline computation, `useMemo`, keyed components, lifted state, or derived values.
- Keep portal and overlay layering centralized. Prefer stable z-index rules over component-specific visibility guards.
- Verify UI state changes that depend on permissions, device pickers, or media acquisition after the underlying operation actually succeeds.
- For local stop flows, stop the local resource first, then mark the UI state inactive.

- Keep API changes backward compatible by default.
- Keep shipped desktop clients compatible with newer server/API versions.
- Treat capability flags as runtime contracts. They should reflect what the current backend can actually start or use, not what the platform might theoretically support.
- Before planning work against a path, doc, roadmap, or app package, verify it exists in the current checkout and reflects the current architecture.

- Gate reconnect and recovery flows on confirmed server connectivity. Do not consume one-shot recovery state while disconnected or during cleanup.
- Distinguish terminal exits from recovery bookkeeping. Terminal exits should stop local capture immediately; reconnect bookkeeping should preserve active media sessions when recovery is expected.
- After reconnects or server restarts, rebuild local transports/subscriptions and resync existing remote producers or streams.
- Track media consume/resume operations until they succeed or exhaust bounded retries. Avoid fire-and-forget recovery paths.
- Order overlapping local media mutations, such as mute, push-to-talk, webcam, and screenshare changes, so stale confirmations cannot overwrite the latest local intent.
- Preserve browser/WebRTC capability matching when changing media codecs or router settings.
- Avoid attaching live call tracks to Web Audio nodes solely for activity metering. Prefer WebRTC/browser stats APIs.
- Treat server-derived media activity as event-driven and potentially stale. Use explicit expiry, sequence ordering, and producer identity checks when merging it with client-reported activity.

- Keep the shipped sidecar focused on supported production capabilities. Do not reintroduce dormant dependencies, binaries, or CI hooks without a current product path.
- Inspect the existing platform backend structure before changing desktop capture, shortcuts, or OS integration.
- Keep Linux, macOS, and Windows capability reporting aligned with the backend path that actually performs the operation.
- Treat OS integration APIs as product/backend integrations, not drop-in transport swaps. Account for user approval, session semantics, packaging, and runtime availability.
- Fix packaged Electron behavior at the Electron/session layer when the issue comes from `file://` origins, request headers, window lifecycle, or renderer teardown.
- For close-time or quit-time cleanup that must reach the renderer, intercept the window lifecycle while the renderer is still alive, flush required state, then continue closing.

The role of this file is to describe repo standards, common mistakes, and recurring confusion points that future agents are likely to encounter. Keep entries durable, current, and decision-oriented. Prefer reusable rules over one-off bug narratives, stale roadmap notes, or narrow file-specific history unless the detail captures a pattern that is likely to recur.
