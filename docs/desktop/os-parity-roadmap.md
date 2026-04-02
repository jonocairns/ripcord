# Desktop OS Parity Roadmap

## Goal

Define a practical path to better feature parity between the Electron desktop app and Rust sidecar on Windows, macOS, and Linux.

This does not assume identical internals across all operating systems. The target is consistent user-facing behavior, clear capability reporting, and predictable fallbacks where true parity is not possible.

## Current State

- Windows is the strongest baseline for desktop capture and update behavior.
- macOS is close on screen audio, but depends on the sidecar helper and ScreenCaptureKit availability.
- Linux is intentionally weaker today:
  - audio capture is modeled as best-effort
  - per-app audio uses a native PulseAudio-compatible backend, with legacy PipeWire-era aliases retained only for desktop/sidecar version-skew compatibility
  - per-app capture requires explicit target selection
  - global push keybinds depend on X11/XWayland
- Auto-update is currently Windows-only.
- GitHub Actions only validates and releases the desktop app on Windows today.

## Desired Parity Contract

The first step is to define the exact user-facing contract the desktop app should satisfy across OSes:

- system audio share
- per-app audio share
- app target discovery
- global push-to-talk
- global push-to-mute
- reconnect behavior during voice/session interruptions
- packaging/install flow
- auto-update behavior
- permission/setup UX
- failure and fallback messaging

This contract should drive capability reporting instead of vague platform defaults.

### Contract Definitions

- `required`: the feature is part of the supported platform experience and should work in normal supported environments
- `best-effort`: the feature is expected to degrade predictably, with explicit messaging and a defined fallback path
- `explicitly unsupported`: the feature is not part of the supported contract on that platform, and the app should say so clearly

This document uses `best-effort` to match the current `TSupportLevel` vocabulary in the desktop code.

### Feature Matrix

| Feature | Windows | macOS | Linux |
| --- | --- | --- | --- |
| Sidecar binary availability | required | required | required |
| Screen share video | required | required | required |
| System audio share | required | required | best-effort |
| Per-app audio share | required | required | best-effort |
| App audio target discovery | required | required | best-effort |
| Auto-suggest app target from selected window | required | required | explicitly unsupported |
| Per-app audio without explicit target selection | required | required | explicitly unsupported |
| Global push-to-talk | required | required | best-effort |
| Global push-to-mute | required | required | best-effort |
| Reconnect-safe voice state behavior | required | required | required |
| Packaging/install flow | required | required | required |
| Auto-update | required | best-effort | explicitly unsupported until a Linux strategy is chosen |
| Permission/setup guidance | required | required | required |
| Failure/fallback messaging | required | required | required |

### Platform Notes

#### Windows

- Windows is the reference implementation for the desktop experience.
- The expected UX includes direct support for system audio, per-app audio, target inference from selected windows, global keybinds, packaging, and auto-update.

#### macOS

- macOS should aim for user-visible parity with Windows for capture and voice features.
- Screen audio support depends on the sidecar helper, ScreenCaptureKit, and required OS permissions.
- Auto-update may lag behind Windows while signing/notarization and release infrastructure are completed, but packaging should still be a first-class supported path.

#### Linux

- Linux should target honest, high-quality support, not fake symmetry with Windows/macOS.
- System audio and per-app audio are supported only when the machine environment can satisfy the capture backend requirements.
- Per-app audio must be allowed to require explicit target selection.
- Global push keybinds may degrade based on X11/XWayland or future Wayland support.
- Unsupported scenarios must be surfaced clearly before capture begins, not only after failure.
- App-audio target discovery remains best-effort because backend/runtime readiness still varies across Linux environments.

### Fallback Rules

- A requested feature may fall back only if the fallback is predictable and the user is told what happened.
- Linux per-app audio may fall back to system audio or no audio when explicit app targeting is unavailable.
- macOS screen audio may fall back to no audio if the helper, OS version, or permissions do not allow capture startup.
- macOS auto-update currently falls back to manual download/install from desktop release artifacts until a signed updater path exists.
- Global keybind registration must never silently fail. It should either register successfully or return a clear reason.
- Unsupported states should be represented as capability data, not inferred ad hoc in UI code.

### CI Contract

The parity contract also defines what GitHub Actions should prove.

#### Pull request validation

- Windows must build and test the sidecar and desktop bundle path.
- macOS must build the sidecar and desktop bundle path.
- Linux must build the sidecar and desktop bundle path.
- Cross-platform tests must validate capability reporting and fallback semantics at the desktop/sidecar boundary.
- Sidecar binary availability should be treated as a first-class contract outcome, not an implied packaging detail.

#### Release validation

- Windows releases must continue producing signed installers and updater metadata.
- macOS releases should eventually produce signed desktop artifacts, with notarization if that becomes part of the supported install/update path.
- Linux releases should eventually produce whichever package formats are declared supported.
- Release orchestration should match the supported OS matrix instead of releasing Windows alone by default.

### Immediate Product Decisions

These decisions should be treated as part of `#1` because later implementation depends on them.

- Linux per-app audio is supported, but explicit target selection is part of the contract.
- Linux automatic target inference from a selected shared window is not required for parity.
- Linux global keybinds are only parity-complete if the app can report when the current session type does not support them.
- macOS should be held to Windows-level user-facing parity for capture features, subject to OS permissions and helper readiness.
- Linux auto-update should remain out of scope until packaging formats and release channels are chosen deliberately.
- Reconnect-safe voice state behavior is already part of the contract and should be protected primarily through regression coverage rather than a separate architecture workstream.

## Prioritized Backlog

### 1. Define the parity contract

Write down the exact cross-OS feature matrix the app is expected to support.

- Put the contract near the current capability model.
- Replace vague assumptions with explicit product expectations.
- Use the contract to decide where parity is required and where fallback is acceptable.

Relevant files:

- `apps/desktop/src/main/platform-capabilities.ts`
- `apps/desktop/src/main/types.ts`

Impact: High

Difficulty: Low

### 2. Make Linux capability reporting probe-based and refreshable

Replace coarse static Linux defaults with runtime probes from the sidecar.

Examples:

- Linux audio backend availability
- portal availability
- compositor/session type
- X11/XWayland availability
- app target enumeration support
- global keybind backend support
- sidecar binary availability

The app should surface exact reasons for unavailable features instead of generic best-effort messaging.

Probe data must also be refreshable, not one-shot.

Examples:

- macOS Screen Recording permission granted mid-session
- Linux audio backend availability changing after app launch
- sidecar crash/restart on any platform
- Linux session/backend changes that affect X11/XWayland-dependent features

Keeping `#2` ahead of later Linux cleanup work is still useful, but some of this logic will be revisited during `#6`.

Relevant files:

- `apps/desktop/sidecar/src/main.rs`
- `apps/desktop/src/main/capture-capabilities.ts`

Impact: High

Difficulty: Medium

### 3. Make Linux app-audio target selection a first-class flow

Linux should treat explicit app-target selection as a normal, intended UX for per-app audio instead of borrowing the Windows/macOS model.

- Require app target selection when needed.
- Improve target labels and suggestions.
- Make fallback behavior explicit in the UI when the user asks for per-app audio without a resolvable target.

Relevant files:

- `apps/desktop/src/main/index.ts`
- `apps/desktop/sidecar/src/main.rs`

Impact: High

Difficulty: Medium

### 4. Improve desktop permissions and failure UX

Permission and environment failures should be explained in a structured, OS-specific way.

Examples:

- macOS Screen Recording guidance
- Linux audio backend and portal prerequisites
- Linux X11/XWayland requirements for keybind monitoring

This should come from structured sidecar reason codes where possible, not ad hoc UI strings.

Relevant files:

- `apps/desktop/src/main/capture-capabilities.ts`
- `apps/desktop/src/main/index.ts`
- `apps/desktop/sidecar/src/main.rs`

Impact: Medium

Difficulty: Medium

### 5. Expand cross-platform parity tests around the desktop/sidecar boundary

This step is complete for the current parity contract.

Coverage now includes:

- platform capability defaults for Windows, macOS, and Linux
- prepared screen-audio fallback behavior, including Linux manual target selection
- stable reason-code assertions for Linux and macOS degradation paths
- sidecar unavailable, macOS helper-unavailable, macOS permission, and macOS OS-version contract cases
- Linux capability probe mapping and session/backend changes after sidecar restart via the fake sidecar
- end-to-end parity coverage that combines capability probing, target listing, and capture-start fallback in one flow
- global push keybind registration failures and re-registration after sidecar restart
- reconnect-safe voice-state regression coverage for active and pending voice sessions during transport failure and reconnect handling

Test strategy:

- keep using the fake-sidecar protocol fixture for most parity tests because it exercises the desktop/sidecar contract without requiring native OS runners
- prefer assertions on capability states, reason codes, and fallback decisions over backend-specific strings so `#6` cleanup does not churn parity tests
- treat native sidecar build verification as CI work under `#11`, not as a substitute for protocol-level parity coverage here

Relevant files:

- `apps/desktop/src/main/__tests__/platform-capabilities.test.ts`
- `apps/desktop/src/main/__tests__/capture-capabilities.test.ts`
- `apps/desktop/src/main/__tests__/capture-sidecar-manager.test.ts`
- `apps/desktop/src/main/__tests__/fixtures/fake-sidecar.cjs`
- `apps/desktop/src/main/index.ts`
- `apps/client/src/features/server/__tests__/reconnect-policy.test.ts`
- `apps/client/src/features/server/reconnect-policy.ts`
- `apps/client/src/lib/trpc.ts`
- `apps/client/src/components/voice-provider/index.tsx`

Impact: High

Difficulty: Medium

### 6. Finish Linux native-backend cleanup and remove PipeWire-era assumptions

This step is complete for the current parity contract.

What landed:

- the Linux audio backend replacement: audio capture and target discovery now use a native Rust PulseAudio-compatible path instead of `pw-dump` / `pw-record`
- cleanup of stale shell-out assumptions in roadmap text, desktop capability mapping, and user-facing guidance
- continued backward-compatibility aliases only where shipped desktop/sidecar version skew still needs them
- desktop capability handling now consumes Linux capture-readiness separately from runtime and target-enumeration readiness

Remaining follow-up is no longer parity cleanup; it belongs under later maintainability work such as `#7` and any future client-version cleanup once the legacy aliases can be removed.

Relevant files:

- `docs/desktop/os-parity-roadmap.md`
- `apps/desktop/src/main/capture-capabilities.ts`
- `apps/desktop/sidecar/src/main.rs`

Impact: Medium

Difficulty: Medium

### 7. Refactor the sidecar into explicit platform backends

This step is complete for the current parity contract.

What landed:

- shared sidecar protocol/types/event framing now live in dedicated Rust modules instead of being declared inline in `main.rs`
- queueing, event emission, and binary egress runtime helpers now live outside `main.rs`
- the Linux PulseAudio backend internals now live under `src/platform/linux/pulse.rs` instead of being embedded in `main.rs`
- macOS helper-launching code and Windows process-loopback helper code now live with their platform backends instead of in `main.rs`
- shared request handling, capture-session lifecycle, and shutdown orchestration now live in a dedicated sidecar app layer
- `main.rs` is now a thin entry point that wires the sidecar app/runtime together instead of owning backend internals directly

Remaining follow-up is normal maintainability work inside the backend modules themselves, not an outstanding parity-roadmap split task.

Suggested shape:

- `windows`
- `macos`
- `linux_x11`
- `linux_wayland`
- shared protocol/types/event framing

This is primarily a maintainability/code-health step, not a direct parity unlock by itself.

The main motivation is that `main.rs` is already large enough that ongoing parity work will become harder to reason about and test if backend concerns stay interleaved.

Relevant files:

- `apps/desktop/sidecar/src/main.rs`
- `apps/desktop/sidecar/src/app.rs`
- `apps/desktop/sidecar/src/protocol.rs`
- `apps/desktop/sidecar/src/runtime.rs`
- `apps/desktop/sidecar/src/platform/mod.rs`
- `apps/desktop/sidecar/src/platform/linux/pulse.rs`

Impact: Low direct parity, high maintainability

Difficulty: High

### 8. Build a real Linux Wayland strategy for global push keybinds

This step is complete for the current parity scope.

What landed:

- Linux capability probing now distinguishes three Wayland shortcut states instead of flattening everything into generic X11 absence
- Wayland sessions with a configured and reachable Global Shortcuts portal now use a real portal-backed registration and signal path instead of stopping at capability probing
- XWayland remains a best-effort fallback when the Wayland portal path is unavailable but an X11 display still exists
- unsupported Wayland sessions fail explicitly when neither a usable portal path nor X11/XWayland is available
- push keybind registration now reuses the same environment-specific backend selection as capability reporting, so runtime behavior matches what the desktop app advertises
- sidecar capability data now reports whether a Wayland Global Shortcuts portal backend is configured and which backend was detected

Residual follow-up:

- validate compositor-specific behavior across the desktops we intend to support
- tighten any UX/documentation details that fall out of the portal session/action model in real-world use

Investigate:

- portal support
- compositor-specific support paths
- safe, explicit unsupported states where the platform does not allow global monitoring

The goal is not to fake parity, but to make support predictable.

Relevant files:

- `apps/desktop/sidecar/src/platform/linux.rs`
- `apps/desktop/sidecar/src/platform/linux/global_shortcuts.rs`

Impact: High

Difficulty: High

### 9. Normalize audio session behavior across OSes

Make audio protocol semantics consistent between macOS and Linux where possible.

Focus areas:

- sample rate
- channel count
- framing
- target semantics
- stop reasons
- exclusion behavior

This is less visible than backend work, but important for correctness and maintainability.

Relevant files:

- `apps/desktop/sidecar/src/main.rs`
- `apps/desktop/src/main/types.ts`

Impact: Medium

Difficulty: Medium

### 10. Add packaging and update parity as a separate workstream

Desktop distribution parity is currently not there.

- Windows has updater support.
- macOS and Linux need a deliberate packaging and release strategy.

For macOS:

- signed builds
- notarization
- update channel support

For Linux:

- choose supported package formats
- define install/update expectations explicitly

Relevant files:

- `apps/desktop/src/main/updater.ts`
- `apps/desktop/package.json`

Impact: Medium

Difficulty: High

### 11. Add GitHub Actions parity for desktop PR CI

The roadmap should explicitly include CI for desktop parity, not just runtime features.

Current workflow gaps:

- PR validation builds and tests the desktop sidecar on Windows only.
- Sidecar binary availability on macOS/Linux is not exercised in PR CI.

Work needed:

- add desktop PR validation jobs for macOS and Linux
- verify sidecar builds on macOS and Linux in CI
- add capability-level tests where feasible across the supported OS matrix
- treat "sidecar builds on all supported desktop OSes" as a milestone 1 requirement

Relevant files:

- `.github/workflows/pull-request.yml`

Impact: High

Difficulty: Medium

### 12. Add GitHub Actions parity for desktop releases

The roadmap should explicitly include CI and release automation, not just runtime features.

Current workflow gaps:

- Desktop release automation is Windows-only.
- The server release workflow only chains into the Windows desktop release workflow.

Work needed:

- decide whether release workflows should produce signed macOS artifacts, Linux artifacts, or both
- add artifact validation for non-Windows desktop bundles
- make release orchestration explicit so desktop release coverage matches the supported OS matrix
- document required secrets and signing/notarization prerequisites for each supported platform

Relevant files:

- `.github/workflows/release-desktop-windows.yml`
- `.github/workflows/release-server.yml`

Impact: High

Difficulty: High

## Recommended Order

1. Define the parity contract
2. Make Linux capability reporting probe-based and refreshable
6. Finish Linux native-backend cleanup and remove PipeWire-era assumptions
11. Add GitHub Actions parity for desktop PR CI
3. Make Linux app-audio target selection a first-class flow
4. Improve desktop permissions and failure UX
5. Add cross-platform integration tests for parity behavior
7. Refactor the sidecar into explicit platform backends
8. Build a real Linux Wayland strategy for global push keybinds
9. Normalize audio session behavior across OSes
10. Add packaging and update parity as a separate workstream
12. Add GitHub Actions parity for desktop releases

## Milestones

### Milestone 1: Honest capabilities and explicit Linux UX

- parity contract defined
- runtime capability probes added
- capability probes are refreshable after environment/permission/sidecar changes
- sidecar builds on all supported desktop OSes in PR CI
- Linux per-app target selection made explicit
- clearer setup and failure messaging

### Milestone 2: Stronger Linux capture backend

- native Linux audio backend is reflected consistently in capability data, docs, and user-facing messaging
- more predictable target discovery and capture startup

### Milestone 3: Better Linux shortcut support

- Wayland strategy defined
- X11/XWayland limitations surfaced cleanly

### Milestone 4: Packaging and update parity

- supported macOS/Linux distribution paths defined
- update strategy implemented where feasible

### Milestone 5: Release automation parity

- release automation reflects the supported desktop OS matrix
- platform-specific signing/notarization requirements are wired into CI

## Success Criteria

We should consider this work successful when:

- the desktop app reports capabilities accurately per machine, not just per OS
- capability data can be refreshed after sidecar restart or environment/permission changes
- Linux backend behavior, capability mapping, and messaging no longer assume fragile shell-outs
- Linux users get a clear, intentional per-app audio workflow
- unsupported global keybind scenarios are explicit and non-confusing
- macOS and Linux packaging/update behavior are documented and intentionally supported
- parity discussions are grounded in a written feature contract instead of assumptions
