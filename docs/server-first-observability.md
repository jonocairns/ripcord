# Server-first observability

## Destinations and deployment

Clients upload versioned diagnostic records to their configured Ripcord server
through the authenticated WebSocket connection. The server writes
`[client-telemetry]` JSON to its existing Winston/container logging pipeline.
VictoriaLogs receives these through the existing Docker log shipper; no new
collector is required. Server exceptions use `[server-exception]` records.
Errors are structured exception logs, not an additional OpenTelemetry signal.

Logs work without an error tracker. `RIPCORD_CLIENT_ERROR_REPORTING_SENTRY_DSN`
optionally forwards client exception records **from the server** to Sentry;
`RIPCORD_SERVER_ERROR_REPORTING_SENTRY_DSN` controls server error forwarding.
The corresponding `config.ini` keys remain supported. These destinations are
independent. An authenticated reporter ID is assigned by the server, and client
records retain `source=client`, runtime, release, environment, original event
time, stack/frame coordinates, breadcrumbs and available trace/span IDs.
Downstream changes do not require changing error-reporting call sites or clients.

## Capability inventory and migration limits

| Capability | Treatment in the logs/errors PR |
| --- | --- |
| Handled errors, console errors, unhandled errors/rejections | Browser SDK remains a parsing/automatic capture adapter; `beforeSend` produces bounded neutral records and drops direct JS error sends. React hooks/boundaries call the neutral interface. |
| Client logs | Owned voice diagnostic logs upload; closed-vocabulary stream events retain #355's independent delivery policy. Arbitrary console.info/debug output is not collected. |
| Server errors | Existing logger remains authoritative, with structured exception records and optional provider forwarding. RPC capture uses the same path. |
| Stack frames/source maps | Original release, stack and frame filename/line/column plus matching debug IDs survive forwarding. No backend stack is substituted. See verification below. |
| Context/breadcrumbs | Bounded primitive context and last 30 breadcrumbs. Credentials, emails, URLs in prose and local account paths are scrubbed; opaque operation/media/reconnect IDs are retained. Request bodies, user content, attachments and arbitrary nested SDK context are excluded. |
| Tracing | #354's tracing API and existing Sentry span implementation remain in this PR. Separate transitional trace DSN configuration is available; server-first OTLP tracing follows in the dependent PR. Rates still default to zero. |
| Replay | Existing explicitly configured masked Sentry replay remains provider-specific and direct. It is not uploaded as diagnostic records. It still requires the legacy client DSN and is not generic pipeline parity. On a server/user switch replay is stopped; restarting the page initializes it for the new server. Transitional browser tracing likewise stops on server switches to prevent exports to the previous destination. |
| Desktop JS errors | Main-process events route via a validated IPC record to the renderer's authenticated server connection. Local rotating diagnostic files and sidecar lifecycle/shutdown behavior remain. |
| Native crashes/minidumps | The existing optional Electron Sentry uploader remains a separate direct path, configured by the legacy client DSN. Native dumps cannot be delivered by a crashed renderer. The process-wide native destination cannot be retargeted safely here; changing DSN disables native uploads until Electron restarts. No claim of crash capture parity without that SDK/provider. |

The legacy `/info.clientErrorReporting` fields remain available to shipped old
clients (including their direct provider behavior). New clients do not directly
send JS errors, even to older servers; without authenticated `diagnosticsVersion=1`
they retain local diagnostics only. Old server chat/media behavior is unchanged.
The legacy client DSN is still public for old clients, replay and native capture;
private credentials for server forwarding stay server-side. Removing those legacy
fields requires a separate compatibility decision.

Transitional trace-only destinations use `RIPCORD_CLIENT_TRACING_SENTRY_DSN` and
`RIPCORD_SERVER_TRACING_SENTRY_DSN` (`clientTracingSentryDsn` and
`serverTracingSentryDsn` in INI), falling back to the existing respective DSNs.
Turning off the optional server error adapter does not turn off tracing when a
trace-only DSN and positive existing sample rate are configured. This PR still
uses Sentry's tracing backend; the next PR replaces that initialization.

## Delivery and security

Upload support is negotiated only after successful authenticated join. Password
reset sessions cannot upload. There is no unauthenticated telemetry endpoint.
The strict schema limits records to 11 KB, batches to eight records/96 KB,
frames to 40, primitive context to 20 fields, and breadcrumbs to 30. Sanitization
runs again server-side. Free text may contain user-supplied content that no
pattern scrubber can recognize: call sites must never intentionally log messages,
device labels, SDP or credentials. Frame URLs keep origin/path for symbolication,
with credentials and query/fragment removed.

The client keeps at most 64 records, uploads every two seconds, expires records
after five minutes, cancels requests after five seconds, and abandons a batch
after three attempts. The tRPC link releases subscriptions on cancellation.
Server/user changes clear the queue and cancel old work. SDK scopes snapshot the
routing identity, so delayed processing cannot relabel an earlier user's event.
Disconnected, startup and pre-authentication errors stay local and are not later
attributed to another login. Already queued authenticated records can survive a
short reconnect to the same identity, subject to expiry. Terminal cleanup clears
them. Renderer quit attempts one bounded final batch after voice cleanup; process
crashes, browser tab termination and long server outages can lose data.

The server allows 30 diagnostic requests/minute per authenticated user, independent
of client session IDs. It validates before acknowledging, bounds asynchronous
pending work to 256 records and expires delayed work after 30 seconds. A bounded
five-minute dedupe map suppresses acknowledgement-loss retries by authenticated
user/session/event ID. Saturation sheds telemetry. An acknowledgement means
accepted for best-effort processing, not durable storage or provider delivery.
No disk spool or exactly-once guarantee is added. SDK transport buffering and
provider rate limits can also drop errors. Logging/adapter failures are contained
without recursively reporting themselves. Providers cannot delay the accepting
RPC or media operation. Server shutdown drains accepted records and gives optional
SDK transports a bounded flush.

## Source-map verification

Forwarding by itself does not guarantee symbolication. The adapter forwards a
JavaScript exception event with the **client** release/platform, original frames
and matching `debug_meta.images`; it does not call `captureException(new Error(...))`
on the server. Tests verify those fields before/after event conversion and export.
Web assets retain Vite's existing source map output and optional Sentry artifact
upload. Desktop `file://.../assets/<hash>.js` frames retain the existing rewrite to
the configured server URL. Public fetching only works if that server hosts the
exact chunk/map from the desktop build. A mismatched desktop/server release needs
uploaded artifacts indexed by debug ID/release; otherwise stacks remain minified.
Main-process/native symbolication needs separately uploaded desktop symbols/maps.
End-to-end Sentry symbolication requires a configured project and uploaded build
artifacts and is a deployment validation limit, not something local forwarding
tests prove. See [Sentry's source-map troubleshooting](https://docs.sentry.io/platforms/javascript/guides/hono/sourcemaps/troubleshooting_js/).

## Investigation and alerting

In the current Alloy pipeline the label is `container="ripcord"`; a future shipper
may rename it. Query the JSON after the stable prefix:

```logsql
{container="ripcord"} "[client-telemetry]"
{container="ripcord"} "[client-telemetry]" | extract "[client-telemetry] <payload>" | unpack_json from payload | filter kind:exception
{container="ripcord"} "<trace-id>"
{container="ripcord"} "<producer-id>"
{container="ripcord"} "[server-exception]"
```

Correlate original `occurredAt` against server `receivedAt`; ingestion time is not
client event time. `clientSessionId`, sequence, operation/reconnect/media IDs and
trace/span IDs complement #355's stream timelines. Structured client errors use
info-level container lines to avoid recapture by the server error adapter; alert
on `kind:exception`/record level, not solely Docker stderr. Configure rate/count
alerts in your existing log alerting service, or grouping/issue alerts in the
optional error tracker. Neither automatic alert provisioning nor a trace store
is introduced here. VictoriaLogs is a log destination; it is not a trace backend.
