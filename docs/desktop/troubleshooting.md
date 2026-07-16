# Desktop Troubleshooting

Ripcord reports runtime capture and shortcut capability issues in the desktop
device settings. Start with the displayed issue and guidance: capability flags
come from the backend that will perform the operation and may be more specific
than these general notes.

## Shared audio fallback

Screen sharing can continue when shared audio is unavailable. Depending on the
requested mode and runtime capabilities, Ripcord falls back from per-app audio to
system audio, or continues with no shared audio and shows a warning.

Per-app audio is not available when sharing an entire display. Ripcord uses
system audio when supported. Linux also requires selecting a running app audio
target; without one, it falls back to system or no audio.

The desktop capture sidecar is a production dependency on Windows, macOS, and
Linux. A missing or failed sidecar can disable per-app audio and other
platform-specific capabilities; it is not a Windows-only experimental toggle.

## macOS

System and per-app audio capture use the sidecar and ScreenCaptureKit on macOS 13
or newer.

If screen or shared-audio capture fails:

1. Open `System Settings > Privacy & Security > Screen Recording`.
2. Allow Ripcord Desktop.
3. Restart the app after changing permission.
4. Retry the share and check the capability issue shown in device settings.

If the app reports that the capture helper is unavailable, reinstall the
packaged app or rebuild it so the macOS helper and sidecar are included.

Microphone permission is separate. Grant it under
`System Settings > Privacy & Security > Microphone` when microphone capture
fails, then restart the app.

## Linux

Screen selection and audio support depend on the session, compositor, portal,
and native audio runtime.

- On Wayland, ensure PipeWire and the correct `xdg-desktop-portal` backend are
  running for the current desktop environment.
- Per-app capture requires choosing the application that is producing audio;
  Ripcord does not infer it from the selected share source on Linux.
- System and per-app audio are best-effort and may be reported unsupported when
  the native PulseAudio-compatible backend is unavailable.
- Global push-to-talk and push-to-mute currently require X11 or XWayland. A
  detected Wayland Global Shortcuts portal does not mean the current build uses
  that backend.

Restart the relevant portal services and Ripcord after changing the desktop
session or portal configuration.

## Windows

System and per-app audio are supported through the capture sidecar. If per-app
capture fails, restart Ripcord and confirm the app being captured is actively
producing audio. A sidecar startup or runtime failure is surfaced in device
settings; reinstall the packaged app if the binary is missing.

## Development builds

Run repository Bun commands through the Nix shell. To build the sidecar from the
directory expected by the desktop package:

```bash
cd apps/desktop
nix develop -c bun run build:sidecar
```

The normal desktop development command runs the optional sidecar build first and
watches sidecar sources. Packaged builds require the platform sidecar under
`apps/desktop/sidecar/bin`; release workflows build and package it for each
supported operating system.

Useful implementation references:

- `apps/desktop/src/main/capture-capabilities.ts` maps backend reason codes to
  user guidance.
- `apps/desktop/src/main/platform-capabilities.ts` defines platform defaults and
  audio fallback policy.
- `apps/desktop/src/main/capture-sidecar-manager.ts` locates, starts, and monitors
  the sidecar.
