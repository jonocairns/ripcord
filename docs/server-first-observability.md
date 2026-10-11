# Server-first observability

## Destinations and deployment

Clients upload versioned diagnostic records to their configured Ripcord server
through the authenticated WebSocket connection. The server writes
newline-delimited JSON to its existing Winston/container logging pipeline.
VictoriaLogs receives these through the existing Docker log shipper; no new
collector is required. Console and file records use the same uncolored JSON format;
owned boot markers and startup/debug output are JSON too. Dependencies can still
write their own runtime output.
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

| Capability | Treatment in the final stack |
| --- | --- |
| Handled errors, console errors, unhandled errors/rejections | Browser SDK remains a parsing/automatic capture adapter; `beforeSend` produces bounded neutral records and drops direct JS error sends. React hooks/boundaries call the neutral interface. |
| Client logs | Owned voice diagnostic logs upload; closed-vocabulary stream events retain #355's independent delivery policy. Arbitrary console.info/debug output is not collected. |
| Server errors | Existing logger remains authoritative, with structured exception records and optional provider forwarding. RPC capture uses the same path. |
| Stack frames/source maps | Original release, stack and frame filename/line/column plus matching debug IDs survive forwarding. No backend stack is substituted. See verification below. |
| Context/breadcrumbs | Bounded primitive context and last 30 breadcrumbs. Credentials, emails, URLs in prose and local account paths are scrubbed; opaque operation/media/reconnect IDs are retained. Request bodies, user content, attachments and arbitrary nested SDK context are excluded. |
| Tracing | #354's shared tracing API remains; PR 2 installs standard OTel providers/exporters independently of Sentry. Client OTLP batches relay through authenticated Ripcord. Rates still default to zero. |
| Replay | Existing explicitly configured masked Sentry replay remains provider-specific and direct. It is not uploaded as diagnostic records. It still requires the legacy client DSN and is not generic pipeline parity. On a server/user switch replay is stopped; restarting the page initializes it for the new server. OTel tracing cancels and recreates its provider/exporter on identity or connection changes. |
| Desktop JS errors | Main-process events route via a validated IPC record to the renderer's authenticated server connection. Local rotating diagnostic files and sidecar lifecycle/shutdown behavior remain. |
| Native crashes/minidumps | The existing optional Electron Sentry uploader remains a separate direct path, configured by the legacy client DSN. Native dumps cannot be delivered by a crashed renderer. The process-wide native destination cannot be retargeted safely here; changing DSN disables native uploads until Electron restarts. No claim of crash capture parity without that SDK/provider. |

The legacy `/info.clientErrorReporting` fields remain available to shipped old
clients (including their direct provider behavior). New clients do not directly
send JS errors, even to older servers; without authenticated `diagnosticsVersion=1`
they retain local diagnostics only. Old server chat/media behavior is unchanged.
The legacy client DSN is still public for old clients, replay and native capture;
private credentials for server forwarding stay server-side. Removing those legacy
fields requires a separate compatibility decision.

PR 1 kept transitional Sentry tracing initialization separately configurable so it
could ship alone. With PR 2 applied, `clientTracingSentryDsn` and
`serverTracingSentryDsn` are legacy compatibility configuration only; new code
ignores them for export. Legacy `/info` fields remain for older clients. Existing
Sentry replay and native crash configuration is unaffected by OTLP destination
changes.

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
may rename it. Unpack the JSON container message:

```logsql
{container="ripcord"} | unpack_json | filter source:client
{container="ripcord"} | unpack_json | filter source:client kind:exception
{container="ripcord"} "<trace-id>"
{container="ripcord"} "<producer-id>"
{container="ripcord"} | unpack_json | filter source:server level:error
{container="ripcord"} | unpack_json | filter kind:telemetry_health
```

Correlate original `occurredAt` against server `receivedAt`; ingestion time is not
client event time. `clientSessionId`, sequence, operation/reconnect/media IDs and
trace/span IDs complement #355's stream timelines. Client records keep their actual
severity (`error`, `warn`, `info` or `debug`; the wire-level `warning` maps to
Winston's `warn` and remains `warning` in Sentry). The server error adapter explicitly
skips `source:client`, so a forwarded error is sent only through the client adapter.
Alert on `source`, `kind:exception` and `level`, not solely Docker stderr. The
existing debug threshold still controls whether debug records reach transports.
Configure rate/count alerts in your existing log alerting service, or grouping/issue alerts in the
optional error tracker. Neither automatic alert provisioning nor a trace store
is introduced here. VictoriaLogs is a log destination; it is not a trace backend.

Replay uses the legacy client Sentry DSN and remains independent of OpenTelemetry
tracing. Trace-only Sentry DSNs are ignored by new clients.
On-error replay is explicitly flushed using its existing configured probability
(the SDK's successful-error-send trigger is unavailable when errors are routed
through the server); its replay ID is forwarded for optional error correlation.

Locally produced exceptions are fitted to the 11 KB record budget after scrubbing: shorten the raw stack first, discard oldest breadcrumbs next, shorten context strings next, and discard oldest source frames only if still necessary. Identity, client time, release and correlation remain intact. The server rejects untrusted oversized records.

Dedupe caches evict their oldest entries at capacity so fresh reports from other
users remain eligible. Retries of evicted entries can be delivered again under
load; deduplication is bounded best effort, not an exactly-once guarantee.

## Delivery health

The server emits at most one `kind:telemetry_health`, `source:telemetry_health`
warning per minute while known failures accumulate, plus a final summary after
provider shutdown flushing. Counters have a fixed set of reason keys and saturate
at 4,294,967,295 per window; no session IDs, user IDs, provider URLs or error text
become labels. Idle periods produce no summaries. The timer does not keep the
process alive, and shutdown cancels it. Health summaries bypass Sentry forwarding
and failures writing a summary are not recursively reported.

`diagnostic_stale`, `diagnostic_future`, `diagnostic_queue_full` and
`diagnostic_queue_expired` count discarded records. `diagnostic_log_failure` and
`error_adapter_failure` count synchronous sink failures. `error_export_failure`
counts Sentry transport sends rejected by the network or a non-2xx response;
`error_transport_dropped` counts SDK transport drop notifications, and
`error_flush_timeout` counts failed/incomplete transport flushes. These different
units can overlap and must not be summed as an exact lost-event total. SDK
processing losses outside transport callbacks, provider-side rejection/grouping,
crashes, pre-authentication loss, and a failing local logging sink are not fully
observable here. Client `droppedEvents` remains separate reported context and
stream events retain their existing independent upload policy. Configure alerts
on sustained health-counter increases with the existing log alerting service;
no metrics backend or new collector is required.

## Provider-neutral tracing (PR 2)

No compatible trace backend was identified in the current homelab infrastructure.
VictoriaLogs receives logs, not traces. With no OTLP endpoint, tracing export is
deferred and the instrumentation API stays available as a no-op. Installing a
collector is optional; it is useful for a backend requiring protocol conversion,
central tail sampling or durable queues, and is not required by this change.

Configure an existing OTLP/HTTP backend that accepts **JSON** traces on its exact
trace endpoint, normally `/v1/traces`:

```sh
RIPCORD_TRACING_OTLP_ENDPOINT=https://traces.example/v1/traces
RIPCORD_TRACING_OTLP_HEADERS='{"Authorization":"Bearer server-credential"}'
RIPCORD_CLIENT_TRACING_SAMPLE_RATE=0.01
RIPCORD_SERVER_TRACING_SAMPLE_RATE=0.01
```

INI equivalents in `[server]` are `tracingOtlpEndpoint`, `tracingOtlpHeaders`,
`clientTracingSampleRate` and `serverTracingSampleRate`. Headers are a JSON object;
invalid endpoint/header configuration disables export. HTTPS is recommended
outside a trusted local network. Credentials stay in server configuration and
are never included in join or `/info`. The independently configured error adapter
can be absent. No collector or automatic alert provisioning is installed.

Both existing root sampling defaults remain **0**. Standard ParentBased sampling
preserves inherited sampled/unsampled decisions; the server can continue a
sampled client parent even when its own root rate is zero. Without a trace backend
or authenticated `tracingVersion=1`/`tracingEnabled`, new clients export no traces
and send ordinary tRPC inputs. Older clients keep their legacy behavior. Logs and
error reporting work regardless of trace enablement.

The browser uses WebTracerProvider, BatchSpanProcessor and W3C propagation. The
thin authenticated RPC exporter uses OTel's standard JSON serializer; it does not
invent spans. Query/mutation calls attach a bounded W3C carrier before their
validated input, and the server extracts it before starting its real RPC span.
Subscription spans retain the existing server setup lifetime. The Bun server
uses NodeTracerProvider with AsyncLocalStorage context and the standard
OTLPTraceExporter. Client and server resources are `ripcord.client` and
`ripcord.server`, with release/runtime identity; the relay assigns authenticated
reporter identity to the client resource and preserves IDs, parents, nanosecond
times, trace state and flags. Trace batches never create replacement server spans.

Browser StackContextManager scopes synchronous callbacks and explicit
`observation.run` blocks. It does **not** propagate context automatically across
native `await` continuations; no parent is inferred from timing, session or media
IDs. Explicit error captures snapshot a real active context before SDK parsing;
automatic SDK events without that snapshot omit trace IDs rather than forwarding
the SDK's unrelated fallback IDs. Voice diagnostic logs use real active IDs.
Client-session, operation, reconnect, producer, consumer and transport IDs remain
useful where asynchronous boundaries lack an active span. Failed RPCs retain their
span IDs for structured exception logging and optional error forwarding after the
WebSocket callback leaves the handler context. Server ALS parent isolation across
concurrent async operations is covered by real exporter tests.
Desktop main has no shared manual tracing call sites; its previous optional Sentry automatic spans are disabled, while main diagnostics and native crash capture remain separate. No browser document/fetch auto-instrumentation is added: the former Sentry browser
integration's automatic navigation/network spans are an explicit migration limit.

The client SDK queues at most 64 ended spans, batches at most 16, and flushes on a
two-second schedule (standard browser visibility flushing also applies). The RPC
exporter permits four concurrent batches, makes at most three attempts with
two-second request deadlines and a 6.5-second overall deadline, and cancels on
identity change/disconnect. Pending observations cannot activate an old identity's
context. Telemetry RPCs are excluded from instrumentation to prevent recursion.
The schema limits batches to 64 KB and only the existing primitive manual span
attributes; events, links and spans lasting over ten minutes are not exported.
The client exporter excludes long spans individually so they cannot discard other
valid spans in the batch.
There is no persistent browser spool. Quit attempts a one-second tracing flush
after local voice cleanup, alongside diagnostics; abrupt crashes/tab termination
can still lose spans.

The authenticated trace route allows 30 requests/minute/user and acknowledges
validated input before export. The server relay queues at most 64 batches, expires
queued work after 30 seconds, rejects records older than five minutes or over one
minute in the future, and deduplicates user/trace/span IDs in a bounded 4096-entry
five-minute map. It exports the sanitized original client resource/spans as OTLP
JSON, with at most three two-second attempts. Permanent HTTP 4xx errors (except
429) are not retried. Partial OTLP backend rejection and saturation can drop spans;
acceptance is not a durable delivery promise. Server manual spans use the standard
exporter with a 256-span queue, 32-span batches and bounded export deadlines.
Server shutdown gives trace delivery at most 2.5 seconds. Provider failures are
contained and cannot recursively capture themselves or fail chat/media requests.

In your trace backend, find a trace by the `traceId` recorded in structured logs,
then compare `service.name`, `service.version`, `ripcord.runtime` and
`ripcord.client_session.id`. Search producer/consumer/transport or operation IDs
when no active trace exists. Use existing log-based alerts for unsampled exception
counts and your backend's sampled latency/error analysis for traces; sampled
traces do not provide complete event counts. Actual deployed backend ingestion,
provider replay and source-map symbolication remain deployment validation limits.
