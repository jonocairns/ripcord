# Desktop Troubleshooting

## macOS permissions

If screen sharing or microphone capture fails on macOS:

1. Open `System Settings > Privacy & Security > Screen Recording`.
2. Ensure `Ripcord Desktop` is allowed.
3. Open `System Settings > Privacy & Security > Microphone`.
4. Ensure `Ripcord Desktop` is allowed.
5. Restart the app after changing permissions.

In the current developer preview, macOS screen-share audio is not available. Screen video sharing continues without audio.

## Linux PipeWire and portal behavior

Linux screen/audio capture depends on your desktop session and portal stack.

1. Verify PipeWire and xdg-desktop-portal services are running.
2. Confirm your portal backend matches your compositor (GNOME/KDE/wlroots).
3. Retry screen sharing after restarting the desktop portal services.

Linux audio capture in this preview is best-effort. If audio is unavailable, Ripcord should continue sharing screen video and show a warning.

## Fallback behavior

When shared audio cannot be captured on the current platform or environment:

1. Ripcord continues with screen video if possible.
2. A non-blocking warning is shown.
3. You can switch audio mode to `No shared audio` to suppress audio capture attempts.

## Rust sidecar capture (Windows experimental)

Per-app audio isolation depends on the Rust sidecar binary.

1. In desktop development mode, run `bun run build:sidecar` in `apps/desktop`.
2. In app settings, enable `Use Rust sidecar capture (Experimental)`.
3. Use Windows 10 22H2 or newer (Windows 11 recommended) for the best loopback compatibility.
4. If startup fails, Ripcord falls back to system audio (or no audio) and displays a warning.

### Fallback matrix (audioMode = Per-app)

1. Sidecar startup fails before sharing:
   Ripcord falls back to `System audio` when available, otherwise `No shared audio`.
2. Target app exits during sharing:
   Ripcord keeps screen video active and switches to standby system audio.
3. Capture device lost/error:
   Ripcord keeps screen video active and switches to standby system audio if available, otherwise no audio.
