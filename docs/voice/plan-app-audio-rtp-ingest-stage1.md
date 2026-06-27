---
description: Stage 1 execution plan — ingest desktop app/system audio as a mediasoup PlainTransport SRTP producer with Electron-main Opus encode, gated on first media with worklet fallback.
tags: [plan, voice, app-audio, screen-audio, plain-transport, srtp, opus, stage-1]
---

# Plan: App Audio RTP Ingest — Stage 1 (Electron-main encoder)

Implements: [App Audio RTP Ingest Design](./app-audio-rtp-ingest.md) — Server PlainTransport ingest, Signaling contract, Desktop main RTP sender, Cross-cutting concerns.

> Transient artifact. Delete on completion — the design doc and the code are the durable record.

## Scope

**Covers:**
- Server: two tRPC routes (`createAppAudioIngest`, `produceAppAudio`) under `apps/server/src/routers/voice/`, registered in `voice/index.ts`.
- Server: `VoiceRuntime` plain-transport state, SRTP `connect()`, first-media (`tuple`) gate, lifecycle/cleanup.
- Server: `SHARE_SCREEN` permission boundary for the new route.
- Desktop main: `app-audio-rtp-sender.ts` — binary-egress PCM → resample → Opus → RTP → SRTP → UDP.
- Desktop main: egress routing — native ingest and renderer-forwarding (worklet) are mutually exclusive sinks of the single binary egress, with explicit teardown/restore on switch.
- Client: capability gate selecting native ingest vs the existing worklet fallback.
- Tests + an ffmpeg ingest fixture.

**Does not cover:**
- Native (Rust/Swift) sidecar encode — Stage 2, design §Delivery Staging.
- Removing or refactoring the worklet jitter buffer — it is retained verbatim as fallback.
- Mid-stream liveness recovery beyond the initial first-media gate (design flags as a follow-up STUB).

## Enables

- Glitch-free shared-app audio on desktop, removing the Web Audio clock-domain that produces the periodic ~80ms drops.
- A proven server PlainTransport + SRTP + first-media path that Stage 2 reuses unchanged (only the sender's location moves).
- Closes a pre-existing authorization gap: `SCREEN_AUDIO` produce is ungated today (`produce.ts:22-26`).

## Prerequisites

- mediasoup `3.19.17` PlainTransport (`comedia`, `enableSrtp`) — already the server's version (`apps/server/src/utils/mediasoup.ts`).
- Per-channel `Router` with `audio/opus` codec — confirmed (`voice.ts` `defaultRouterOptions`, `:108-118`).
- Sidecar binary PCM egress operational (`capture-sidecar-manager.ts`, `TAppAudioBinaryEgressInfo`).
- A reachable UDP listen address for plain RTP (reuse the WebRTC announced address; see Constraints).

## North Star

A desktop user shares an app with audio; every listener hears it with no periodic drops over a multi-minute stream, and the server emits no `[per-app-audio] PCM queue telemetry` (the worklet path is not used). If UDP to the server is blocked, the user still gets audio via the worklet fallback within the first-media timeout, with no silent producer ever published.

## Constants (pin during implementation)

```
SRTP_CRYPTO_SUITE      = 'AES_CM_128_HMAC_SHA1_80'   // libsrtp/ffmpeg-interoperable; mediasoup-supported
// APP_AUDIO_RTP is a TEMPLATE, not a constant. The SSRC is allocated PER INGEST
// (per transport) so two users publishing app audio in the same router never
// collide, and returned to the sender. Everything else is fixed.
appAudioRtpFor(ssrc) = {
  codecs:   [{ mimeType: 'audio/opus', payloadType: 100, clockRate: 48000, channels: 2,
               parameters: { useinbandfec: 1 } }],   // matches router audio/opus (voice.ts:110)
  encodings:[{ ssrc }],                              // unique per ingest; regenerate on reconnect
  rtcp:     { cname: `app-audio-${userId}` },
}
OPUS_FRAME_MS          = 20                            // encoder pull cadence
OPUS_BITRATE_BPS       = 96_000
FIRST_MEDIA_TIMEOUT_MS = 3_000                         // tuple event must fire within this window
INGEST_PERMISSION      = ChannelPermission.SHARE_SCREEN
// Send target the route returns to the client:
SEND_ADDRESS           = announcedAddress ?? listenInfo.ip   // NEVER the raw 0.0.0.0 bind ip
```

## Done Criteria

### Signaling: `createAppAudioIngest`
- The route shall require `Permission.JOIN_VOICE_CHANNELS` and `ChannelPermission.SHARE_SCREEN`.
  - If the user lacks `SHARE_SCREEN`, then the route shall reject with `FORBIDDEN` and shall not create a transport (a hard, client-visible denial — never a fallback; see Error Policy).
- The route shall create one `PlainTransport` per session via `runtime.createAppAudioIngest(userId)` with `comedia: true`, `rtcpMux: true`, `enableSrtp: true`, `srtpCryptoSuite: SRTP_CRYPTO_SUITE`, and the selected WebRTC `listenInfo`, preserving `announcedAddress` when configured.
- The route shall **allocate a unique SSRC per ingest**, store it on the runtime ingest record, and build `rtpParameters` via `appAudioRtpFor(ssrc)`.
- The route shall **attach the PlainTransport `tuple` listener at creation time** and record `firstMediaSeen` on the ingest record, so a packet that arrives before `produceAppAudio` is not missed (see race note below).
- The route shall return `{ id, ip: SEND_ADDRESS, port, ssrc, srtpParameters /* server */, rtpParameters }`.
  - `ip` MUST be `announcedAddress ?? listenInfo.ip` (never the raw bind ip).
  - If a prior ingest transport exists for the user, then the route shall close it before creating the new one.

### Signaling: `produceAppAudio`
- When called with the client `srtpParameters`, the route shall call `plainTransport.connect({ srtpParameters })` **before** `produce()`.
  - If `connect()` has not occurred, then `produce()` shall not be called.
- The route shall `produce({ kind: 'audio', rtpParameters /* the ingest's */, appData: { kind: StreamKind.SCREEN_AUDIO, userId } })`.
- First-media gate (race-safe): if `firstMediaSeen` is already set (or `plainTransport.tuple` is populated), the route shall treat media as flowing immediately; otherwise it shall await the `tuple` event up to `FIRST_MEDIA_TIMEOUT_MS`.
- When media is flowing within the window, the route shall register via `runtime.addProducer(userId, StreamKind.SCREEN_AUDIO, producer)`, publish `VOICE_NEW_PRODUCER`, and return `{ producerId }`.
- If no media is observed within `FIRST_MEDIA_TIMEOUT_MS`, then the route shall close the producer and transport and return `{ fallback: true }` without publishing.

### PlainTransport lifecycle
- The runtime shall track the ingest transport per user, separate from `producerTransports`.
- While a user has an active ingest transport, the runtime shall close it on channel leave, disconnect, and session-replace — the same teardown points that close WebRTC transports.
  - The `SCREEN_AUDIO` producer lives on the ingest transport, **not** `producerTransports[userId]`; closing the WebRTC producer transport shall not be relied on to close it.
- When the ingest transport closes, the runtime shall close its `SCREEN_AUDIO` producer, whose existing `addProducer` close-observer deletes the map entry and publishes `VOICE_PRODUCER_CLOSED`.

### Permission alignment
- The `createAppAudioIngest`/`produceAppAudio` routes shall gate on `SHARE_SCREEN` as the native-ingest authorization boundary.
- The legacy WebRTC `produce.ts` path **shall** gain a `SCREEN_AUDIO` → `SHARE_SCREEN` branch in this stage — **non-optional**. Rationale: a `SHARE_SCREEN` denial on the native path must not be escapable by falling back to the worklet path, which today produces `SCREEN_AUDIO` through an ungated `produce.ts` branch. Both paths must enforce the same gate or the boundary is meaningless.
- If a user is denied `SHARE_SCREEN`, then neither path shall yield a `SCREEN_AUDIO` producer.

### Desktop main — RTP sender
- The sender shall pull PCM from the sidecar binary egress at `OPUS_FRAME_MS` cadence and resample onto the encoder clock.
  - While the sidecar produces faster or slower than the encoder consumes, the sender shall absorb drift via resampling, not by dropping buffered frames.
- The sender shall Opus-encode at `OPUS_BITRATE_BPS`, RTP-packetize with the ingest's returned `ssrc` and `payloadType: 100`, SRTP-protect with the client key, and UDP-send to the returned `ip` (`SEND_ADDRESS`) `:port`.
- The sender shall begin sending before calling `produceAppAudio` so the server's `tuple` gate observes media (comedia: client sends first). The server attaches its `tuple` listener at `createAppAudioIngest`, so early packets are not lost.

### Desktop main — egress routing (single-active sink)
- The sidecar binary egress is a single active stream. Native ingest and renderer-forwarding (which feeds the worklet) shall be **mutually exclusive** consumers — at most one `SCREEN_AUDIO` producer exists at a time.
- While native ingest is active, the main process shall consume egress PCM into the RTP sender and shall **not** forward PCM to the renderer worklet pipeline.
- When falling back (`{ fallback: true }` or sender error), the main process shall fully tear down the RTP sender (close socket, stop encoder) and **restore renderer forwarding before** the worklet path starts — never run both against the same egress.
- `STUB` — confirm whether `app-audio-rtp-sender` subscribes to the existing `CaptureSidecarManager.onPcmFrame` fan-out (preferred; EventEmitter already multicasts) or takes ownership of the egress socket; the switch must be reversible either way.

### Client — capability gate and fallback
- Where desktop runtime and sidecar are present, the client shall attempt native ingest.
- When `produceAppAudio` returns `{ producerId }`, the client shall use the native producer and shall not build the worklet pipeline.
- If `produceAppAudio` returns `{ fallback: true }` or native ingest is unavailable, then the client shall use the existing worklet→`MediaStreamTrack`→WebRTC path (`index.tsx` ~`:1795`) unchanged.
- The producer shall surface as `StreamKind.SCREEN_AUDIO` regardless of path, so consume-side code is untouched.

## Tests

### Server (bun:test, mirror `apps/server/src/routers/__tests__/close-producer.test.ts`)
- **Permission is a hard denial**: a user lacking `SHARE_SCREEN` is rejected with `FORBIDDEN` by `createAppAudioIngest` and `produceAppAudio`, **and no transport/producer is created** — the route must not resolve to `{ fallback: true }`.
- **Legacy path gated**: the WebRTC `produce.ts` path rejects a `SCREEN_AUDIO` produce from a user lacking `SHARE_SCREEN` (regression guard for the backfill).
- **Unique SSRC**: two ingest sessions in the same router receive distinct SSRCs; the returned `rtpParameters.encodings[0].ssrc` matches the stored value.
- **Send address**: with a `0.0.0.0` bind + announced address configured, the route returns the announced address as `ip`, never `0.0.0.0`.
- **Connect-before-produce**: assert `plainTransport.connect({ srtpParameters })` is invoked before `produce()`; a produce attempt without a preceding connect fails.
- **First-media success**: simulate the `tuple` event → `addProducer` called with `SCREEN_AUDIO`, `VOICE_NEW_PRODUCER` published, returns `{ producerId }`.
- **Early-media race**: a `tuple` that fires **before** `produceAppAudio` is called (listener attached at create) still resolves to `{ producerId }`, not a timeout.
- **Timeout fallback**: no media within `FIRST_MEDIA_TIMEOUT_MS` → producer and transport closed, no publish, returns `{ fallback: true }`.
- **Cleanup**: on leave/disconnect/session-replace, the ingest transport and its `SCREEN_AUDIO` producer close and `VOICE_PRODUCER_CLOSED` publishes exactly once (reuse producer-replacement test patterns in `voice-producer-replacement.test.ts`).
- **No double-publish**: a stale producer close after replacement does not emit `VOICE_PRODUCER_CLOSED` for the live one.

### Desktop main
- Resampler holds output cadence within tolerance when the input PCM rate drifts (unit test the pull/resample, no real audio device).
- RTP/SRTP packets are well-formed for `payloadType: 100` and the ingest's `ssrc` (encode a known buffer; assert header fields).
- **Egress mutual-exclusion**: enabling native ingest stops renderer forwarding; falling back tears down the sender and restores renderer forwarding — never both active against the egress simultaneously.

## ffmpeg validation fixture

Drive the server ingest with no desktop code — proves PlainTransport + SRTP + `connect` + `tuple` gate + `addProducer` end to end. All placeholders come from `createAppAudioIngest`: `<IP>` = `SEND_ADDRESS` (announced address), `<PORT>`, and `<SSRC>` = the per-ingest allocated SSRC. `<KEY>` is the **client** SRTP key (base64, 30 bytes for `AES_CM_128_HMAC_SHA1_80`) passed identically to `produceAppAudio`.

```bash
ffmpeg -re -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
  -c:a libopus -b:a 96000 -ar 48000 -ac 2 \
  -payload_type 100 -ssrc <SSRC> \
  -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params "<KEY>" \
  "srtp://<IP>:<PORT>"
```

Expected: `createAppAudioIngest` → start ffmpeg → `produceAppAudio({ clientSrtp: <KEY> })` returns `{ producerId }`; a second voice client in the channel consumes `SCREEN_AUDIO` and hears the 440Hz tone. Stopping ffmpeg before produce (or pointing at a blocked port) yields `{ fallback: true }`.

`STUB` — if a scripted fixture is preferred over manual ffmpeg, add it under `apps/server/src/runtimes/__tests__/fixtures/`.

## Constraints

- **No worklet changes** — the fallback path stays byte-for-byte; this plan only adds a parallel path and a gate. (Design: keep fallback.)
- **Producer identity fixed** — must register as `SCREEN_AUDIO` with `appData.userId`; any other kind breaks consumer routing. (Design: Producer identity.)
- **SRTP mandatory** — no plaintext RTP path, even on LAN. (Design: Security parity.)
- **Ingest transport owned by the session** — never reuse across sessions; recreate (new ssrc, new keys) on reconnect. (Design: comedia reconnect risk.)
- **Reuse the WebRTC announced address** — do not introduce a second public-address config surface. (Design: NAT/remote.)

## References

- [App Audio RTP Ingest Design](./app-audio-rtp-ingest.md) — architecture, signaling sequence, risks.
- mediasoup PlainTransport API — `PlainTransportOptions`, `plainTransport.connect`, `tuple` event: https://mediasoup.org/documentation/v3/mediasoup/api/#PlainTransport
- Server seams: `apps/server/src/routers/voice/produce.ts` (produce→addProducer→publish), `apps/server/src/runtimes/voice.ts` (`createProducerTransport` `:506`, `addProducer` `:578`, codec `:110`), `apps/server/src/utils/mediasoup.ts` (worker/server, announced address).
- Client seam: `apps/client/src/components/voice-provider/index.tsx:1795` (`SCREEN_AUDIO` produce), capability gating around sidecar capture start `~:2336`.
- Test patterns: `apps/server/src/routers/__tests__/close-producer.test.ts`, `apps/server/src/runtimes/__tests__/voice-producer-replacement.test.ts`.

## Error Policy

Two error classes, deliberately different:

- **Authorization failures are hard.** A missing `SHARE_SCREEN` (or `JOIN_VOICE_CHANNELS`) MUST reject with `FORBIDDEN` and surface as a client-visible denial — **never** `{ fallback: true }`. Falling back here would route the user through the worklet path and produce `SCREEN_AUDIO` anyway, defeating the gate. This is why the legacy `produce.ts` backfill is non-optional.
- **Operational failures fall back.** Transport creation, `connect()`, or first-media timeout resolve to `{ fallback: true }` (or a typed error the client treats as fallback), and the client uses the worklet path. App audio degrading to the existing path is acceptable; a silent or crashed voice session is not.
- **Always release resources.** The ingest transport and producer must be closed on any operational error before returning, to avoid leaking the UDP port (Done Criteria: lifecycle). On client-side fallback, the RTP sender must be torn down and renderer forwarding restored before the worklet path starts (Done Criteria: egress routing).
