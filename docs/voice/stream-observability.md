# Investigating watched stream drops

Stream lifecycle diagnostics use the existing server/container logging pipeline.
Both server events and authenticated client uploads produce `[stream-event]`
followed by JSON. They do not require an OTEL collector, Sentry Logs or desktop
diagnostics. Deploy the server and client to enable the complete timeline.

## Compatibility, privacy and limits

The authenticated server join response advertises `streamObservabilityVersion: 1`
only when the upload route is implemented. New clients do not call the route on
older servers. Old clients can ignore the additive response field.

Events use a strict shared allowlist of names, reason codes and bounded IDs/
counters. Arbitrary console arguments, error messages, capture titles, URLs,
credentials, SDP, candidate addresses and media are not accepted. The server
derives `reporterUserId` from authentication; client `remoteId`/producer references
are untrusted correlation claims, never permission or membership evidence.

The queue is in memory: 256 events maximum, 32 per request, a five-second minimum
flush interval, ten-minute expiry, ten-second upload timeout, and three attempts
per failed batch. It retains timestamps and sequence through a temporary socket
disconnect and uploads only after server authentication. Switching server origin,
server ID or user, or terminal cleanup, clears the queue. A process exit can lose
buffered events. `droppedEvents` exposes bounded-buffer/retry losses; network
acknowledgement loss can produce duplicates with the same session and sequence.
The backend limits uploads to 30 batches/minute per authenticated user.

Sentry keeps its existing tracing/sampling settings. Only exhausted SCREEN
consume retries produce a new error, limited to three reports per ten minutes
per controller session and one report per remote/kind/producer in that window.
Ordinary disconnects, retries and playback inactivity remain structured logs.

## Reading a timeline

Correlate `producerId`, `consumerId`, original `transportId`, and `remoteId` across
`source: server` and `source: client`. Server producer closure records distinguish
recoverable transport replacement from terminal closure. Client close reception
and committed `watch_intent_retained`/`watch_intent_cleared` explain whether a
replacement was still wanted. A manual Watch/Stop/Retry records its own event;
consume operations have opaque `operationId` and mode (`manual` means an explicit
Retry; initial Watch is logged separately before its scheduled consume).

`clientSessionId` persists through short reconnects. Sort each client's buffered
events by `sequence` and use `occurredAt` (epoch milliseconds) for occurrence time;
`receivedAt` is upload time. Client clock skew prevents exact cross-machine
ordering, so prefer matching resource IDs. A server `consumer_created` or
`consumer_resumed` proves allocation/resume, not successful viewer playback.
Client events also retain the most recent `reconnectAttemptId` when it is a UUID,
matching the existing `[voice-session]` restore attempt logs. Resource IDs remain
the authority for ownership when older operations finish during a new attempt.

SCREEN playback monitors actual `Consumer.getStats()` receiver counters and
rendered frames via `requestVideoFrameCallback`. A first rendered frame gets its
own event. Moving incoming frames without decoding, or moving decoded frames
without visible rendering for 15 seconds, can diagnose a stall. Thirty seconds
of inactivity is labelled `static_or_idle` when connected and
`no_incoming_media` when the receive transport is disconnected. Static screens
alone cannot prove failure. Paused, ended, hidden or absent video elements suppress
diagnoses; browsers lacking frame callbacks omit render-specific conclusions.
Recovery requires progress in the counter corresponding to the diagnosed stage.
Monitoring stops with consumer ownership and never starts a media repair.

## VictoriaLogs queries

These queries assume the container message is stored in `_msg`; add your Ripcord
container stream filter if the log store contains other applications. JSON is
embedded after the existing logger prefix. The extraction/JSON pipes follow the
[LogsQL documentation](https://docs.victoriametrics.com/victorialogs/logsql/).

Find the original 10 October 2026 8:30–11 pm NZDT window (07:30–10:00 UTC):

```logsql
_time:[2026-10-10T07:30:00Z,2026-10-10T10:00:00Z] "[stream-event]"
| extract_regexp '(?P<stream_json>[{].*[}])' from _msg
| unpack_json from stream_json
| sort by (occurredAt, clientSessionId, sequence)
```

Find all broadcaster/viewer events for a producer (replace `PRODUCER_ID`):

```logsql
_time:24h "[stream-event]"
| extract_regexp '(?P<stream_json>[{].*[}])' from _msg
| unpack_json from stream_json
| filter producerId:="PRODUCER_ID" OR previousProducerId:="PRODUCER_ID"
| sort by (occurredAt, clientSessionId, sequence)
```

Find final consume failures and playback evidence, then drill into the returned
session/operation/producer IDs:

```logsql
_time:24h "[stream-event]"
| extract_regexp '(?P<stream_json>[{].*[}])' from _msg
| unpack_json from stream_json
| filter event:in(consume_exhausted,playback_stalled,playback_inactive,playback_recovered)
| sort by (occurredAt, clientSessionId, sequence)
```

These changes add future evidence; they cannot reconstruct missing client events
from incidents before deployment.
