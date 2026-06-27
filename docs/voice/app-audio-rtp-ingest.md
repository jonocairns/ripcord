---
description: Design for ingesting desktop app/system audio into mediasoup as a native RTP producer, replacing the renderer-side Web Audio PCM jitter buffer.
tags: [voice, mediasoup, app-audio, screen-audio, plain-transport, rtp, srtp, sidecar, opus, jitter-buffer]
verified: { "date": "2026/06/27", "commit": "3751ac7c157a2711c00f01519ff6acafa197fa98" }
---

# Desktop App Audio — Native RTP Ingest Design

## North Star

Shared-app audio reaches every listener cleanly. No periodic drops, no clock-drift glitches, no hand-tuned buffer that trades latency against dropouts. The audio leaves the capture process and arrives at the SFU through the same kind of pipeline the rest of WebRTC uses, and the listeners never know how it got there.

## Context

Desktop per-app and system audio is captured by a native sidecar binary and currently reaches the SFU through a Web Audio detour:

```
sidecar (native) ──PCM──► Electron main ──IPC──► renderer worklet ──MediaStreamTrack──► mediasoup-client ──WebRTC──► SFU
```

The renderer worklet (`PcmQueueProcessor` in `apps/client/src/components/voice-provider/desktop-app-audio.worklet.js`) is a hand-rolled jitter buffer. In `low-latency` mode it targets 3 chunks and hard-trims at 6 by discarding queued chunks (`apps/client/src/components/voice-provider/desktop-app-audio-queue-policy.ts`). Because the native capture clock and the Web Audio render clock are independent and nothing resamples between them, the queue drifts to the trim threshold and dumps ~80ms of audio at once — the audible "odd drops" during streaming. The `AudioContext` is also forced to `session.sampleRate` (`apps/client/src/components/voice-provider/desktop-app-audio.ts`), which can stack a second hidden resampler between the worklet and the output device.

This design removes the renderer from the media path entirely. App audio is encoded to Opus and sent as RTP into a mediasoup `PlainTransport`, where it becomes an ordinary producer. The clock-domain crossing moves into the encoder's fixed-cadence pull, where a resampler belongs — the same shape libwebrtc's AudioDeviceModule uses.

**Enables:** glitch-free shared-app audio; a capture path that no longer depends on Web Audio timing under CPU contention from concurrent screen-share encode.

## Constraints

- The server runs a **single mediasoup worker** and a **per-channel `Router`** (`apps/server/src/utils/mediasoup.ts`, `apps/server/src/runtimes/voice.ts` `getRouter`/`createRouter`). Consumption is always within a channel; there is no `pipeTransport` fan-out.
- App/system audio is already modelled as **`StreamKind.SCREEN_AUDIO`** (`apps/client/src/components/voice-provider/index.tsx:1795,1806`) and consumers already watch that kind (`index.tsx:868`). Producer identity must be preserved so the consume side is untouched.
- The producing client may be behind NAT, and the server may be remote. Plain RTP has no ICE and no DTLS.
- The sidecar already exposes a **binary PCM egress over a local TCP socket** (`TAppAudioBinaryEgressInfo { port, framing, protocolVersion }`, `apps/desktop/src/main/capture-sidecar-manager.ts`). The "get audio out of the native process over a socket" primitive exists.
- Web clients and locked-down networks must keep working — the existing worklet→WebRTC path stays as a fallback.
- mediasoup `3.19.17` (`PlainTransport` supports `comedia` and `enableSrtp`).

---

## Design

### Architecture

```
TARGET (desktop, native ingest):

  sidecar (native) ──PCM (binary egress)──► Electron main
                                              │  resample → Opus encode → RTP → SRTP
                                              ▼
                                      UDP ──► server PlainTransport (comedia + SRTP)
                                              │
                                      router.plainTransport.produce(kind=audio,
                                                appData={ kind: SCREEN_AUDIO, userId })
                                              │
                                      runtime.addProducer() + VOICE_NEW_PRODUCER
                                              │
                                      (unchanged) consumers in the channel

FALLBACK (web, or ingest unreachable):

  ...existing renderer worklet → MediaStreamTrack → WebRTC producer transport...
```

The insertion point is deliberately narrow. Today `produce.ts` does `producerTransport.produce(...)` → `runtime.addProducer(userId, kind, producer)` → publish `VOICE_NEW_PRODUCER` (`apps/server/src/routers/voice/produce.ts`). The plain-transport producer hits the **same** `addProducer` + publish seam, so every consumer behaves identically. The change is contained to the producing client's ingest path plus new server signaling.

### Server — PlainTransport ingest

A new transport type is created on the channel's existing router, alongside the per-user WebRTC producer transport:

- `runtime.createAppAudioIngest(userId)` creates `router.createPlainTransport({ comedia: true, rtcpMux: true, enableSrtp: true, srtpCryptoSuite: <agreed suite>, listenInfo: <reuse webRtc listen ip/announcedAddress> })`.
- `comedia: true` means the server learns the sender's address/port from the first RTP packet — the client behind NAT sends first, no ICE needed.
- After creation the transport exposes the server's `srtpParameters`. SRTP requires an explicit **`plainTransport.connect({ srtpParameters })`** with the *client's* keying material before media can be decrypted; in comedia mode `connect` carries SRTP params only and no remote ip/port. This step is mandatory and must precede `produce()`.
- The transport is tracked per session and torn down in the same lifecycle path that closes WebRTC producers on leave/disconnect (mirror existing producer cleanup in `VoiceRuntime`).
- The producer is created server-side with fixed Opus `RtpParameters` and `appData: { kind: StreamKind.SCREEN_AUDIO, userId }`. Publishing `VOICE_NEW_PRODUCER` is **gated on first media** (see Media liveness below), not on `produce()` returning — a published producer that never receives RTP would leave listeners with a silent stream and no fallback.

**Permission boundary.** This route becomes the real authorization boundary for app/system audio. The current WebRTC `produce.ts:22-26` branches only on `AUDIO`→`SPEAK`, `VIDEO`→`WEBCAM`, `SCREEN`→`SHARE_SCREEN` — **`SCREEN_AUDIO` falls through ungated** (covered today only by the route-level `JOIN_VOICE_CHANNELS`). The new route gates on **`SHARE_SCREEN`**, since app/system audio only exists alongside an active screen share and `update-state.ts:25` already gates screen-share state on it. `STUB` — confirm `SHARE_SCREEN` is the intended boundary (vs `SHARE_SCREEN` + `SPEAK`), and decide whether to backfill the same gate onto the existing `SCREEN_AUDIO` produce path.

### Signaling contract

Two tRPC routes under `apps/server/src/routers/voice/`, parallel to `create-producer-transport` / `produce`. The SRTP handshake is a four-step sequence — server params out, client params back via `connect`, then media-gated produce:

```
1. createAppAudioIngest()         → server: createPlainTransport(); returns server SRTP + tuple target + rtpParameters
2. client generates its SRTP key, begins SRTP/RTP send to ip:port
3. produceAppAudio({ clientSrtp }) → server: plainTransport.connect({ srtpParameters: clientSrtp })
                                              produce({ kind:'audio', rtpParameters, appData:{ SCREEN_AUDIO, userId } })
                                              await first media (PlainTransport 'tuple' event) OR timeout
4. on tuple  → addProducer() + publish VOICE_NEW_PRODUCER → { producerId }
   on timeout → close transport+producer            → { fallback: true }
```

```ts
// createAppAudioIngest — allocate the plain transport for this session
input:  {}                          // channel/user from auth context
output: {
  id: string;                       // transport id
  ip: string;                       // where the client sends RTP
  port: number;
  rtcpPort?: number;                // omitted when rtcpMux
  srtpParameters: {                 // SERVER's keying material
    cryptoSuite: string;
    keyBase64: string;
  };
  rtpParameters: RtpParameters;     // fixed Opus params the encoder MUST mirror
}

// produceAppAudio — connect SRTP, then publish only once media is flowing
input:  {
  transportId: string;
  srtpParameters: { cryptoSuite; keyBase64 };  // CLIENT's keying material → plainTransport.connect()
}
output:
  | { producerId: string }          // first RTP observed within the timeout
  | { fallback: true }              // no media before timeout → client uses the worklet path
```

The `rtpParameters` are fixed and server-authored (one Opus codec, one payload type, agreed clock rate/channels) so the encoder has an unambiguous target. `STUB` — pin the exact payload type, clock rate (48000), channel count (2), SRTP crypto suite, and the first-media timeout during Stage 1.

### Desktop main — RTP sender

A new module `apps/desktop/src/main/app-audio-rtp-sender.ts` consumes the existing binary PCM egress and produces SRTP:

1. **Fixed-cadence pull + resample.** Pull PCM at a fixed 10ms (or 20ms) Opus frame cadence; resample the sidecar's stream onto the encoder clock. This is the drift fix — drift is absorbed by continuous resampling at the encoder boundary, never by dropping a buffered chunk.
2. **Opus encode** at the fixed `rtpParameters` codec settings.
3. **RTP packetize** (12-byte header, sequence/timestamp/SSRC).
4. **SRTP protect** using the keys exchanged via signaling.
5. **UDP send** to the plain transport `ip:port`. Comedia: just start sending; the server adopts the source address.

`STUB` — select the Node-side Opus encoder and SRTP libraries (native ABI addon is acceptable; the desktop build already ships the sidecar and mediasoup binaries). Validate SRTP interop against mediasoup before wiring the encoder.

### Client — capability gating and fallback

The renderer chooses the ingest path when starting app-audio capture:

- **Native ingest** when: desktop runtime present, sidecar available, and `produceAppAudio` returns `{ producerId }` — i.e. the server observed first RTP within the timeout.
- **Fallback** when: not desktop/sidecar, or `produceAppAudio` returns `{ fallback: true }` (UDP path to the server blocked, packets never arrived). The existing worklet→`MediaStreamTrack`→WebRTC producer path (`index.tsx` around `:1795`) is retained unchanged.

Reachability is not assumed — it is **proven by media**. Because plain RTP has no ICE/DTLS connection state, "is the ingest working?" can only be answered by the server seeing real packets, so the fallback decision is driven by the first-media gate, not by transport creation succeeding. Either way the producer surfaces as `SCREEN_AUDIO` via `VOICE_NEW_PRODUCER`, so remote UI and consumption are identical across paths.

### Cross-Cutting Concerns

- **Security parity.** WebRTC media is DTLS-SRTP. The plain path MUST use SRTP (`enableSrtp`) so app audio is not sent in clear over the network. Keying is two-sided: the server returns its `srtpParameters` from `createAppAudioIngest`, and the client's `srtpParameters` are applied via `plainTransport.connect()` in `produceAppAudio`. Media cannot be decrypted until `connect()` completes.
- **Media liveness.** Plain RTP has no ICE/DTLS state, so a `produce()` can succeed while no packet ever arrives — a silent, published `SCREEN_AUDIO` producer that never triggers fallback. The server gates `VOICE_NEW_PRODUCER` on the PlainTransport `tuple` event (first received RTP) with a bounded timeout; on timeout it tears down and signals `{ fallback: true }`. The existing `apps/server/src/runtimes/media-liveness-telemetry.ts` is the natural home for ongoing liveness once published. `STUB` — set the first-media timeout and decide whether mid-stream liveness loss also drops back to the worklet path.
- **NAT / remote servers.** `comedia` handles client-behind-NAT (client sends first). The server must expose a UDP port (or range) for plain RTP and announce the same reachable address used for WebRTC. `STUB` — define the port allocation/range and document the firewall requirement next to existing WebRTC port docs.
- **No bandwidth estimation.** PlainTransport gives no transport-cc/REMB feedback to the encoder. This is acceptable: Opus app audio is low, near-constant bitrate. BWE only matters for video, which this path never carries.
- **Lifecycle.** The plain transport and its producer are owned by the voice session and closed by the same teardown that handles WebRTC producers — a disconnect or channel leave must release the UDP port and close the producer.
- **Producer identity.** The producer is `SCREEN_AUDIO` with `appData.userId`, identical to today, so existing consumer routing, watch logic, and UI need no change.

---

## Delivery Staging

Staging is explicitly requested: prove the server ingest path with the cheaper encoder first, then push the encoder down to the native layer.

**Stage 1 — Electron-main encoder.** Encode + RTP + SRTP live in Electron main, reading the existing binary PCM egress. Write-once and platform-agnostic, reuses the socket that already exists, and ships the drop fix. This stage proves the riskiest unknown — server PlainTransport ingest with SRTP keying and comedia — independently of any native media code.

**Stage 2 — Native sidecar encoder.** Move encode + RTP into the sidecar (shared Rust core; Swift backend via FFI) so media never crosses a process boundary as PCM. This is an optimization of an already-working, already-tested path — full parity with the libwebrtc model.

The earliest validation is cheapest: stand up the server PlainTransport + signaling and drive it with an off-the-shelf RTP source (e.g. ffmpeg/GStreamer) to confirm ingest, SRTP, and the `addProducer` seam before any desktop code is written.

---

## Trade-offs

| Chose | Over | Because |
|-------|------|---------|
| PlainTransport RTP ingest | Renderer worklet jitter buffer | Removes the Web Audio clock domain that causes the drops |
| Encoder-side resample | Hand-tuned chunk-trim policy | Drift corrected continuously and inaudibly, not in 80ms dumps |
| Stage 1 in Electron main | Native sidecar encode first | Proves server path fast, write-once, ships the fix sooner |
| SRTP + comedia | Plain RTP | Security parity with DTLS-SRTP; works behind NAT |
| Keep worklet fallback | Delete it | Web clients and blocked-UDP networks still need a path |
| No BWE on the plain path | Replicating WebRTC feedback | Constant low-bitrate Opus does not need it |

## Alternatives Considered

**Harden the worklet in place (Option A).** Adaptive jitter buffer + WSOLA time-stretch + drift resampling inside `PcmQueueProcessor`. Mitigates the drops without an architecture change, but reimplements a slice of NetEq in the renderer and keeps the Web Audio clock domain. Viable as a stopgap; rejected as the long-term target because the clock crossing remains in the wrong place.

**Native sidecar encode first.** Full parity in one step, but write-twice across the Rust and Swift capture backends and slower to a first working build. Deferred to Stage 2, after the server path is proven.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| SRTP keying / crypto-suite interop with mediasoup | Validate with an ffmpeg/GStreamer SRTP source before encoder work; pin the suite in the signaling contract; verify the `connect({ srtpParameters })` handshake end-to-end |
| Silent producer — `produce()` succeeds but no RTP arrives | First-media gate: publish `VOICE_NEW_PRODUCER` only on the PlainTransport `tuple` event; timeout → teardown + `{ fallback: true }` |
| UDP path to server blocked (corporate networks) | Surfaces as the first-media timeout above; client falls back to the WebRTC worklet path |
| New route under-gates app-audio authorization | Route gates on `SHARE_SCREEN`; the legacy `SCREEN_AUDIO` produce path is currently ungated — confirm and align both |
| comedia source-address adoption races on reconnect | Recreate transport+producer on reconnect; reuse existing producer-replacement handling |
| Port exhaustion / firewall for plain RTP | Define a bounded port range; document alongside WebRTC port config |
| Node real-time encode jitter (Stage 1) | Acceptable for low-bitrate Opus; Stage 2 moves encode native if measured jitter is a problem |

## Extension Points

- The signaling contract is transport-shaped, not encoder-shaped — Stage 2 swaps the RTP sender's location without changing the server or the consume side.
- The capability gate is the single switch between native ingest and the worklet fallback.
- System audio and per-app audio share the `SCREEN_AUDIO` producer identity and therefore the same ingest path.
