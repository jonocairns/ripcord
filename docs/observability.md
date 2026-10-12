# Application tracing

Ripcord's custom application spans use a portable boundary in
`packages/shared/src/telemetry/tracing.ts`. Voice components and the server RPC
middleware call `traceSpan` or `startSpanObservation`; they do not call Sentry's
span APIs directly.

The server initializes a standard OpenTelemetry NodeTracerProvider with
AsyncLocalStorage context, ParentBased sampling, BatchSpanProcessor and the
OTLP/HTTP exporter. Manual spans work without automatic module instrumentation,
including Bun's compiled executable.

The browser initializes WebTracerProvider and BatchSpanProcessor. Its thin RPC
exporter uses the standard OTLP JSON serializer and the authenticated Ripcord
connection. The server relays original client resources and spans to its configured
backend; it does not recreate them as server spans. StackContextManager preserves
synchronous scopes and explicit `observation.run` blocks, but does not automatically
carry context across native `await`. No absent parent is inferred from timing or
session/media identifiers. Browser and server async context guarantees differ.

See [Server-first observability](server-first-observability.md) for deployment,
configuration, migration limits, correlation, delivery guarantees and health
queries. Logs use the existing server/container pipeline; structured exception
logs can additionally reach independently configured error adapters. Sentry remains
an optional error/replay/native-crash integration, separate from tracing.

## Configuration and cost

Configure `RIPCORD_TRACING_OTLP_ENDPOINT` and optional server-only
`RIPCORD_TRACING_OTLP_HEADERS` for a compatible OTLP/HTTP JSON backend. A collector
is optional; VictoriaLogs is the existing log destination, not a trace store.
Without a valid destination, export is deferred and instrumentation is a no-op.
New clients also require authenticated server tracing capability and enablement.

Client/server root sample rates retain their zero defaults. Standard ParentBased
sampling preserves real sampled/unsampled parent decisions, so a server can
continue a sampled client parent even with its own root rate at zero. Legacy
Sentry tracing DSNs remain compatibility fields for shipped older clients; new
tracing does not use them. Changing the downstream destination does not require
changing application call sites or releasing new clients.

Server RPC spans cover middleware/handler execution, including unsuccessful
`tRPC` results. For subscriptions they cover subscription setup, not the entire
subscription lifetime. Voice attempt spans record kind, path, outcome and
duration. Existing structured lifecycle logs remain available independently.
Server RPC and voice attempt spans add trace volume when tracing is enabled;
use the existing sample rates to control that volume.

## Failure and data boundaries

Span setup, context setup/teardown, attributes, status and finish failures cannot
change the application operation's success or original error. A context-manager
failure cannot replay a media or RPC effect that already ran. Observations finish
once, including cancelled/superseded operations. Those outcomes are recorded with
an unset status, while failures use error status.

Each attribute update accepts at most 20 application attributes, with string
values bounded to 200 characters. Creation additionally reserves an operation
attribute. Attribute names must be fixed application-defined keys; they are not
length-bounded by the sanitizer. Credentials, token-like attribute names, email addresses and
URLs are scrubbed before the adapter receives them. Do not add arbitrary
request payloads, device labels, user content or error messages as span data;
redaction is a safeguard rather than permission to collect those fields. The
error-reporting interface, React boundaries, replay, native crash capture and source
map setup remain separate. Replay/native crashes retain provider-specific paths;
generic telemetry parity is not claimed.

## Validation and backend independence

The portable boundary tests exercise disabled capture, exporter/context failures,
async completion, original rejection preservation, idempotence and redaction.
The server fixture uses the actual standard OTLP exporter in an isolated Bun
subprocess and checks IDs, parents, resource identity, inherited sampling,
concurrent async context and exporter failure observation. The fixture can also
be compiled for release verification. Browser SDK tests cover real RPC context,
identity cancellation, disabled sampling, original span graphs and bounded export.

Server configuration selects the downstream trace backend while the shared API
and client exporter remain unchanged. Bounded health summaries expose known relay
losses and exporter failures without adding another processor or metrics backend.
They cannot observe all SDK queue drops, OTLP partial rejection or downstream
storage failures. Deployed backend ingestion, hosted symbolication and packaged
desktop/native/replay behavior still require runtime validation.
