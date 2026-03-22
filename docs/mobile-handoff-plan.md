# Mobile Handoff Plan

## Current Checkpoint

- Branch: `feat/mobile-foundation`
- Commit: `50b026ac`
- Status: Expo mobile app boots on device again, connect/login works, and text-channel navigation is stable enough for smoke testing.

## What Was Stabilized

- Downgraded `apps/mobile` to Expo SDK 54 so it can run on the current Expo Go device.
- Added [apps/mobile/metro.config.js](/home/jonoc/sharkord/apps/mobile/metro.config.js) to keep Metro resolving React-bound libraries from the mobile app and to avoid workspace package-local `node_modules`.
- Added [scripts/wsl-mobile-proxy.ps1](/home/jonoc/sharkord/scripts/wsl-mobile-proxy.ps1) for Windows port forwarding when running Expo and server pieces from WSL.
- Moved mobile/runtime value imports away from the `@sharkord/shared` barrel where that was pulling in server-only or unstable runtime dependencies.
- Simplified mobile message rendering in [apps/mobile/src/components/message-content.tsx](/home/jonoc/sharkord/apps/mobile/src/components/message-content.tsx) to a stable plain-text fallback plus command cards.
- Replaced `FlashList` with `FlatList` in [apps/mobile/src/app/(app)/channel/[id].tsx](/home/jonoc/sharkord/apps/mobile/src/app/(app)/channel/[id].tsx) during Expo runtime stabilization.
- Removed an unstable Zustand selector pattern in [apps/mobile/src/hooks/use-channel-messages.ts](/home/jonoc/sharkord/apps/mobile/src/hooks/use-channel-messages.ts) that was producing a max render depth loop.

## Validation Completed

- `nix develop -c bun run magic`
- On-device Expo boot
- Connect flow
- Login flow
- Opening a text channel after the runtime fixes

## Known Temporary Compromises

- Mobile HTML rendering is intentionally reduced to plain-text fallback in [apps/mobile/src/components/message-content.tsx](/home/jonoc/sharkord/apps/mobile/src/components/message-content.tsx).
- Mobile channel rendering is using `FlatList`, not `FlashList`.
- Expo/Metro hot reload behavior across workspace packages is still fragile, especially from WSL.
- Mobile voice is still placeholder scaffolding only.
- Real `react-native-webrtc` voice work requires an Expo development build; Expo Go remains useful for text-only smoke testing, not native voice.
- Push registration exists, but push delivery fan-out is still not implemented.

## Highest-Priority Remaining Work

1. Implement real mobile voice transport.
2. Harden `packages/app-core` with reconnect/store tests.
3. Restore richer mobile message rendering once the runtime path is stable.
4. Implement server-side push delivery fan-out.
5. Prune leftover Expo scaffold/demo components from `apps/mobile` if they are no longer useful.

## Recommended Next Sequence

1. Do a short on-device smoke test for text channels.
2. Implement `react-native-webrtc` plus mediasoup mobile transport in [apps/mobile/src/app/(app)/voice/[id].tsx](/home/jonoc/sharkord/apps/mobile/src/app/(app)/voice/[id].tsx).
3. Keep signaling in `packages/app-core`, but keep media/device ownership in mobile.
4. Add tests around reconnect behavior in [packages/app-core/src/trpc.ts](/home/jonoc/sharkord/packages/app-core/src/trpc.ts), [packages/app-core/src/session.ts](/home/jonoc/sharkord/packages/app-core/src/session.ts), and [packages/app-core/src/server-store.ts](/home/jonoc/sharkord/packages/app-core/src/server-store.ts).
5. Revisit mobile message rendering quality after the voice/native work is settled.
6. Implement Expo push fan-out behind a small queue/service abstraction on the server.

## Smoke Test Checklist

1. Start the server.
2. Start Expo mobile.
3. Connect to the server URL from the device.
4. Log in.
5. Open home, settings, and at least one text channel.
6. Send a message.
7. Edit a message.
8. Delete a message.
9. Add/remove a reaction.
10. Upload an image.

## WSL Notes

- Expo Go + WSL requires Windows port forwarding for Metro and the Sharkord server if the phone connects through the Windows LAN IP.
- Mobile voice over WSL also needs the mediasoup WebRTC port forwarded, not just Metro and the main HTTP/TRPC server port.
- The helper script is [scripts/wsl-mobile-proxy.ps1](/home/jonoc/sharkord/scripts/wsl-mobile-proxy.ps1).
- If WSL restarts and gets a new IP, the proxy rules need to be recreated.

## Android Dev Build Workflow

1. Create or reuse an Expo account, then sign in once from WSL with `cd apps/mobile && bunx eas-cli login`.
2. Link the mobile app to EAS once with `nix develop -c bun run --filter mobile eas:init`. This runs `eas init --force` and writes `extra.eas.projectId` into [app.json](/home/jonoc/sharkord/apps/mobile/app.json).
3. Build an installable Android development client with `nix develop -c bun run --filter mobile build:android:dev`.
4. Open the EAS build URL when it finishes and install the generated APK on the Android device.
5. Get the current WSL IPv4 with `hostname -I` and use the `eth0` address, which is usually the first value in the output.
6. Get the Windows LAN IPv4 that the phone uses to reach the machine.
7. Start the Sharkord server with `SHARKORD_WEBRTC_ANNOUNCED_ADDRESS=<WINDOWS_LAN_IP>` so mediasoup advertises a phone-reachable address instead of `127.0.0.1`.
8. From an elevated Windows PowerShell session in the repo root, recreate the port proxy rules with `.\scripts\wsl-mobile-proxy.ps1 -Action enable -WslIp <WSL_IP>`.
9. Start the mobile bundler for the dev client with `nix develop -c bun run --filter mobile start:dev-client`.
10. Start the Sharkord server as usual if it is not already running.
11. On the phone, open the installed Sharkord Mobile development build and connect to the Metro server from the QR code or the dev-client launcher.

### When To Rebuild

- Rebuild the Android development client after adding or upgrading native mobile dependencies, changing Expo config in [app.json](/home/jonoc/sharkord/apps/mobile/app.json), or changing native plugin configuration.
- For normal TypeScript and React changes, keep using the existing installed development client and just restart Metro with `nix develop -c bun run --filter mobile start:dev-client`.
- For WSL voice testing, keep using the same installed dev client, but make sure the server is started with `SHARKORD_WEBRTC_ANNOUNCED_ADDRESS=<WINDOWS_LAN_IP>` and the proxy rules include port `40000`.

### Current Test Split

- Use Expo Go for text-only smoke testing.
- Use the Sharkord Mobile development build for voice-channel testing.

## Main Risks

- The current mobile runtime path is stable enough to test, but it has not been cleaned up into a final architecture yet.
- Shared workspace packages still need careful import hygiene for Metro.
- Voice reconnect behavior already has a known pitfall documented in [AGENTS.md](/home/jonoc/sharkord/AGENTS.md).
- Moving from Expo Go to a development-build workflow for voice increases setup friction for device testing.
- Rich mobile message rendering should be treated as deferred, not finished.
