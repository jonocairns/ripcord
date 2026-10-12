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

With no provider configured, this server console/file pipeline is the default
destination. The browser SDK only parses and captures errors locally for upload
to Ripcord; its session and client-report uploads are disabled. Its external
transport accepts only replay envelopes when a real DSN and a positive replay
sample rate are explicitly configured.

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
VictoriaLogs receives logs, not traces. With no OTLP endpoint and console tracing
disabled, the instrumentation API stays available as a no-op. Local trace logging
is a separate opt-in output described below. Installing a
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
invalid endpoint/header configuration disables OTLP export. Local trace logging
can remain enabled independently. HTTPS is recommended
outside a trusted local network. Credentials stay in server configuration and
are never included in join or `/info`. The independently configured error adapter
can be absent. No collector or automatic alert provisioning is installed.

Both existing root sampling defaults remain **0**. Standard ParentBased sampling
preserves inherited sampled/unsampled decisions; the server can continue a
sampled client parent even when its own root rate is zero. Without an enabled trace output
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
validated input before export. Each enabled server relay output queues at most
64 batches, expires
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

Tracing uses the same bounded health summaries. `trace_relay_stale` and
`trace_relay_future` count refused client spans; `trace_relay_queue_full` counts
fresh batches refused for capacity (all-duplicate acknowledgement retries are
excluded). Rejected fresh spans are not inserted into the dedupe cache and remain
eligible on a later retry. `trace_relay_queue_expired`,
`trace_relay_failed_batch` and `trace_relay_shutdown_drop` count batches discarded
at expiry, after permanent/exhausted failures, or while queued/in flight at
shutdown. An in-flight shutdown drop means delivery is unconfirmed; a backend
may already have accepted it. `trace_relay_export_failure` counts failed HTTP
attempts and `trace_relay_retry` counts additional attempts actually started. These units
can overlap; retry warnings do not imply final loss when a later attempt succeeds.
Relay loss counters count work per enabled output, so the same spans or batch can
contribute to both outputs' counters when both local and OTLP output are enabled.

The standard server SpanExporter decorator reports `trace_export_failure` per
failed SDK export callback or synchronous export failure, and
`trace_export_failed_spans` counts spans in those batches. It passes original
span objects and callback results through unchanged, delegates optional
`forceFlush`, and adds no queue, sampling, retries or deadlines. Standard exporter
shutdown rejection or the existing overall trace shutdown deadline increments
`trace_shutdown_failure`. Invalid configured destinations and failed provider
initialization increment `trace_configuration_invalid` and
`trace_initialize_failure`; an absent endpoint with console tracing disabled
intentionally disables tracing without reporting a failure. Health records have
no inherited request trace IDs.

These counters do not observe browser/server BatchSpanProcessor internal queue
overflows, unsampled spans, successful HTTP responses containing OTLP partial
rejection, or all downstream storage failures. Provider credentials/error strings
are never health labels. Deployments should monitor their backend/collector's
own rejected-span/drop counters as well; local acceptance and HTTP success remain
best-effort boundaries rather than proof of durable storage.

## Local trace logging and server retention

Console trace logging is opt-in and needs no OTLP backend or collector. To collect
sampled client and server spans in the existing JSON console/file pipeline:

```sh
RIPCORD_TRACING_CONSOLE_ENABLED=true
RIPCORD_CLIENT_TRACING_SAMPLE_RATE=0.1
RIPCORD_SERVER_TRACING_SAMPLE_RATE=0.1
```

Set both rates to `1` for full root sampling while investigating a drop. Existing
rates still default to `0`; enabling an output alone does not change sampling.
Standard parent-based sampling preserves an actual parent's sampling decision.

`RIPCORD_TRACING_CONSOLE_LEVEL` defaults to `info` and also accepts `debug`.
Debug trace logs require `SHARKORD_DEBUG=true`; a console sink filtered out by the
logger threshold does not advertise client tracing support. Sampling controls
span capture volume, independently of severity. Failed spans retain `status:error`
in trace records at the selected trace level. Actual exceptions and telemetry
health warnings keep their existing error/warn levels.

INI equivalents in `[server]` are `tracingConsoleEnabled` and
`tracingConsoleLevel`. Console and optional OTLP export can run together. Turn
console tracing off with `RIPCORD_TRACING_CONSOLE_ENABLED=false`. With console off
and an empty OTLP endpoint, tracing is disabled. Configuration changes take effect
after server restart/rejoin. No endpoint credentials are advertised to clients.

`kind:trace`, `message:"[trace-span]"` records preserve original trace/span/parent
IDs, service/runtime/release, start/end nanosecond timestamps, duration, status and
bounded scrubbed attributes. Client records also carry authenticated reporter
identity. They are searchable log records, not a trace-store UI. Client batches
use independent bounded queues, expiry and deduplication for local and OTLP
output; OTLP retries do not
repeat local log writes. A failing local client trace sink increments
`trace_log_failure` once per affected batch and cannot block optional OTLP export.
Server exporter failures use the existing trace export counters. Each server sink
has its own bounded standard SDK batch processor, so OTLP failures do not delay
local trace logging.

Server `app.log` and `error.log` now rotate at 10 MiB, retaining five files per
stream including the active file (two files minimum). Configure `[server].logMaxSizeMb` and
`logMaxFiles`, or `RIPCORD_LOG_MAX_SIZE_MB` and `RIPCORD_LOG_MAX_FILES`. Size is a
rotation threshold, not a strict disk quota: a final record can cross it. Stdout
and Docker log retention remain the deployment's responsibility; desktop
rotation remains independent. Older archives are discarded, so use the existing
log shipper for longer retention.

Voice diagnostics now retain closed-vocabulary connection state, recovery
command type/phase/outcome, attempt counters, durations, media intent flags,
WebSocket close codes and standard error type/code. Known transport-failure
metadata is flattened without raw payloads. Command start/finish records upload
independently of trace sampling; failures use warning severity. Client-instance,
producer/consumer/transport and reconnect IDs support incident correlation.
These operational events can show successful versus failed recovery and broad
media usage; they are not a complete or durable usage-analytics counter. Queues
remain bounded and disconnected/crashed clients can lose pending data. Device
labels, arbitrary close reasons, addresses, SDP, credentials, user content and
raw nested error data are excluded from this voice context allowlist. During
bursts, the diagnostic collector retains and dispatches exceptions, warnings, and
structured state/outcome records before repetitive informational lines. Retries
keep their original record set; original timestamps and sequences are preserved,
so use those fields to order an incident timeline rather than upload order.
