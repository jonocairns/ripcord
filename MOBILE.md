# Mobile Development

This document describes the working mobile development flow for Sharkord.

It is written for the current setup:

- Expo SDK 54
- Android development build for native voice work
- WSL-hosted server and Metro during local development

## Current Test Split

- Use `Expo Go` for text-only smoke testing.
- Use the installed Sharkord Android development build for voice testing.

`react-native-webrtc` is required for voice, so Expo Go is not a valid runtime for mobile voice features.

## One-Time Setup

1. Install repo dependencies.

```bash
nix develop -c bun install
```

2. Log in to Expo from the mobile workspace.

```bash
cd /home/jonoc/sharkord/apps/mobile
bunx eas-cli login
```

3. Link the mobile app to EAS once.

```bash
cd /home/jonoc/sharkord
nix develop -c bun run --filter mobile eas:init
```

This writes the EAS project ID into [app.json](/home/jonoc/sharkord/apps/mobile/app.json).

4. Build the Android development client once and install it on the phone.

```bash
cd /home/jonoc/sharkord
nix develop -c bun run --filter mobile build:android:dev
```

Open the resulting EAS build URL, download the APK on the Android phone, and install it.

## Daily Development Loop

Once the development build is installed, normal iteration should not require another EAS build.

1. Get the current WSL IPv4.

```bash
hostname -I
```

Use the `eth0` address, usually the first IPv4 in the output.

2. Find the Windows LAN IPv4 that the phone uses to reach the machine.

3. In elevated Windows PowerShell, refresh the WSL proxy rules.

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\wsl-mobile-proxy.ps1 -Action enable -WslIp <WSL_IP>
```

4. Start the Sharkord server with a reachable WebRTC announced address.

```bash
cd /home/jonoc/sharkord
SHARKORD_WEBRTC_ANNOUNCED_ADDRESS=<WINDOWS_LAN_IP> nix develop -c bun run --filter @sharkord/server dev
```

5. Start Metro for the development client.

```bash
cd /home/jonoc/sharkord
nix develop -c bun run --filter mobile start:dev-client -- --clear
```

6. Open the installed Sharkord Mobile development build on the Android phone.

The installed dev build should connect to the Metro server and load the app. For normal React and TypeScript changes, keep using this loop.

## When You Must Rebuild The Dev Client

Rebuild the Android development build when any of these change:

- native dependencies
- Expo plugins
- Android permissions
- `expo.android.package`
- `expo.ios.bundleIdentifier`
- native config in [app.json](/home/jonoc/sharkord/apps/mobile/app.json)

Use:

```bash
cd /home/jonoc/sharkord
nix develop -c bun run --filter mobile build:android:dev
```

## WSL Voice Requirements

Text/auth can work while voice is still broken if the WebRTC path is not reachable.

Voice over WSL requires all of the following:

- Metro forwarded on `8081`
- Sharkord server forwarded on `4991`
- mediasoup WebRTC forwarded on `40000`
- server started with `SHARKORD_WEBRTC_ANNOUNCED_ADDRESS=<WINDOWS_LAN_IP>`

The helper script in [scripts/wsl-mobile-proxy.ps1](/home/jonoc/sharkord/scripts/wsl-mobile-proxy.ps1) now forwards all three ports.

## Useful Commands

Start Metro for dev client:

```bash
nix develop -c bun run --filter mobile start:dev-client -- --clear
```

Build Android dev client:

```bash
nix develop -c bun run --filter mobile build:android:dev
```

Run mobile checks:

```bash
nix develop -c bun run --filter mobile check-types
nix develop -c bun run --filter mobile lint
```

Run full repo validation:

```bash
nix develop -c bun run magic
```

## Common Failure Modes

`Expo Go works but voice does not`

- Expected if you are trying to use native voice features in Expo Go.

`Text works but mobile voice has no audio in either direction`

- Check that the server is running with `SHARKORD_WEBRTC_ANNOUNCED_ADDRESS=<WINDOWS_LAN_IP>`.
- Check that the Windows proxy rules include port `40000`.
- Recreate the proxy rules after any WSL IP change.

`EAS build fails in non-interactive mode`

- Make sure [apps/mobile/eas.json](/home/jonoc/sharkord/apps/mobile/eas.json) exists.
- Make sure [apps/mobile/app.json](/home/jonoc/sharkord/apps/mobile/app.json) includes `expo.android.package`, `expo.ios.bundleIdentifier`, and `expo.extra.eas.projectId`.

`Remote build fails reading app config`

- Make sure `@config-plugins/react-native-webrtc` is present in [apps/mobile/package.json](/home/jonoc/sharkord/apps/mobile/package.json).

`Metro crashes from shared-package imports`

- Avoid mobile runtime imports from the `@sharkord/shared` barrel when direct source imports are safer for Metro.

## Related Files

- [apps/mobile/app.json](/home/jonoc/sharkord/apps/mobile/app.json)
- [apps/mobile/eas.json](/home/jonoc/sharkord/apps/mobile/eas.json)
- [apps/mobile/package.json](/home/jonoc/sharkord/apps/mobile/package.json)
- [scripts/wsl-mobile-proxy.ps1](/home/jonoc/sharkord/scripts/wsl-mobile-proxy.ps1)
- [docs/mobile-handoff-plan.md](/home/jonoc/sharkord/docs/mobile-handoff-plan.md)
