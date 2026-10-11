# Application tracing

Ripcord's custom application spans use a portable boundary in
`packages/shared/src/telemetry/tracing.ts`. Voice components and the server RPC
middleware call `traceSpan` or `startSpanObservation`; they do not call Sentry's
span APIs directly.

The server uses the real `@opentelemetry/api` tracer and context APIs. The
installed `@sentry/bun` 10.x SDK initializes the tracing provider, sampler,
async context manager and Sentry exporter. Manual spans work without automatic
module instrumentation, including Bun's compiled executable. There is no
collector or additional tracing provider to run.

The React browser SDK has a different tracing implementation. Its adapter is
installed by `configureClientErrorReporting` and implements the same portable
boundary using Sentry's existing browser spans and active context. This is a
portable application API, **not a native browser OpenTelemetry pipeline**.
Replacing the browser backend requires replacing that adapter. Browser async
parenting retains the installed SDK's existing behavior; the server's async
context guarantees do not imply equivalent browser support.

## Configuration and cost

Existing server/client DSNs and tracing sample rates still control capture.
Without a configured SDK and a positive sample rate, the application tracing
boundary is a no-op. Sampling remains with Sentry, so parent/child sampling
stays consistent. No new configuration, exporter, analytics service or metrics
pipeline is introduced.

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
URLs are scrubbed before either adapter receives them. Do not add arbitrary
request payloads, device labels, user content or error messages as span data;
redaction is a safeguard rather than permission to collect those fields. The
existing Sentry error reporting, React boundaries, replay and source map setup
remain separate.

## Validation and future backends

The portable boundary tests exercise disabled capture, exporter/context failures,
async completion, original rejection preservation, idempotence and redaction.
The server integration fixture initializes the actual Sentry SDK in an isolated
Bun subprocess and checks exported parent/child spans and concurrent async
context. It can also be built with `bun build --compile` for release verification.
Browser adapter tests cover configuration and observation behavior; browser or
Electron capture must still be verified in its runtime when changing the SDK.

A future server backend can initialize a different OTel provider/exporter while
keeping application call sites and the shared OTel adapter. A future browser
backend implements `TTracingAdapter`. Logs, errors/replay, analytics and metrics
are not migrated to OTLP by this first pass.

References:

- [Sentry Bun 10.x support for OpenTelemetry APIs](https://docs.sentry.io/platforms/javascript/guides/bun/opentelemetry/using-opentelemetry-apis__v10.x/)
- [OpenTelemetry JavaScript API](https://opentelemetry.io/docs/languages/js/instrumentation/)
