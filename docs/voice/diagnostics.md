# Voice and desktop diagnostics

Desktop builds write JSON lines to `logs/diagnostics.jsonl` inside Electron's
user-data directory. For the installed app this is normally:

- Windows: `%APPDATA%\Ripcord\logs`
- macOS: `~/Library/Application Support/Ripcord/logs`
- Linux: `~/.config/Ripcord/logs` (or the configured XDG location)

Preview builds use their own user-data directory. Logging starts at app startup
and does not require a Sentry DSN or tracing configuration. Existing console
output and Sentry error reporting continue to work.
Each user-data directory has one running desktop instance. Launching another
copy focuses the existing window, so only one process rotates its log files.

The active file rotates at 2 MiB with four retained archives, named
`diagnostics.jsonl.1` through `.4`. Records are capped at 8 KiB and writes use a
bounded, ordered queue. Oversized data is replaced by a truncation marker;
main-process queue drops or failed writes are counted on the next accepted event.
The renderer limits outstanding writes to 128 and drops additional events.
Disk failures do not interrupt media or recovery. After the renderer's voice-leave
flush, quit gives the sidecar up to one second to shut down and drain its output,
force-stopping it halfway through that deadline if necessary. It then waits at
most one second for accepted diagnostic writes, including the final sidecar
events. New diagnostic directories are private to the user on POSIX systems.

Every record includes UTC time, desktop version, platform, and a process-session
ID. Renderer voice logs, command attempts and outcomes, WebSocket closes/opens,
restore RPC requests/outcomes, explicit voice leaves, desktop process crashes, and sidecar stderr/lifecycle/audio
status events are retained. Client-instance and reconnect-attempt IDs are kept
for correlation with server logs. Sensitive keys, credentials, URLs, email
addresses, home directories, IPv4 addresses, chat content and source labels are
redacted; these logs contain no audio or video frames.

In VictoriaLogs, query `{container="ripcord"} "voice_leave"` for structured
leave events and `{container="ripcord"} "voice_transport_failed"` for server
transport failures. Leave reasons are client-reported diagnostic context, not an
authorization input. Older clients omit the reason and are logged as `unknown`.
Current reasons distinguish `user_action`, `recovery_exhausted`, `join_failed`,
and `app_quit`. A leave may remove the seat, find it already removed, or find a
newer session owns it; the event records the outcome.

Transport failures record channel/user/transport IDs, source, ICE/DTLS states,
selected transport protocol and producer count before cleanup. Failures from
superseded transports do not appear as failures of the current session.

For an incident, collect the active file and archives from the affected viewers
as well as the screen sharer. Match UTC timestamps and correlation IDs against
server events. A server restore succeeding still does not prove client media
playback resumed; these diagnostics record signaling and transport recovery.
