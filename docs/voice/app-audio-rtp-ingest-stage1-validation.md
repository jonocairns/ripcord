---
description: Manual ffmpeg validation fixture for the Stage 1 server PlainTransport app-audio ingest — proves SRTP keying, comedia, the connect→produce handshake, and the first-media gate without any desktop code.
tags: [voice, app-audio, plain-transport, srtp, ffmpeg, validation, stage-1]
---

# Stage 1 Validation — ffmpeg App-Audio Ingest Fixture

Drives the server ingest path with an off-the-shelf SRTP RTP source so the
PlainTransport + SRTP + `connect()` + `tuple` gate + `addProducer` path can be
validated independently of the Electron-main sender.

Routes under test (`apps/server/src/routers/voice/`):

- `voice.createAppAudioIngest` → `{ id, ip, port, ssrc, srtpParameters, rtpParameters }`
- `voice.produceAppAudio({ transportId, srtpParameters })` → `{ producerId } | { fallback: true }`

## Prerequisites

- A running server with at least one user joined to a voice channel and holding
  `ChannelPermission.SHARE_SCREEN`.
- `ffmpeg` built with `libopus` and SRTP (`--enable-libopus`, SRTP is on by
  default in modern builds).
- A second voice client in the same channel to confirm the `SCREEN_AUDIO`
  producer is heard.

## Steps

1. **Generate the client SRTP key** (base64, 30 bytes for
   `AES_CM_128_HMAC_SHA1_80` = 16-byte master key + 14-byte salt):

   ```bash
   CLIENT_SRTP_KEY=$(head -c 30 /dev/urandom | base64)
   echo "$CLIENT_SRTP_KEY"
   ```

2. **Call `createAppAudioIngest`** (over the authenticated tRPC/WS client). Record
   from the response:
   - `IP`   = `ip`   (this is `announcedAddress ?? listenInfo.ip`, never `0.0.0.0`)
   - `PORT` = `port`
   - `SSRC` = `ssrc` (per-ingest allocated value the sender MUST use)

   The server's `srtpParameters` in the response are the *server's* keys; ffmpeg
   does not need them for send-only RTP.

3. **Start ffmpeg** sending an SRTP-protected Opus 440 Hz tone to `IP:PORT`,
   mirroring the server-authored `rtpParameters` (payload type 100, 48 kHz,
   stereo). comedia means the server adopts the source address from the first
   packet — just start sending:

   ```bash
   ffmpeg -re -f lavfi -i "sine=frequency=440:sample_rate=48000:duration=30" \
     -c:a libopus -b:a 96000 -ar 48000 -ac 2 \
     -payload_type 100 -ssrc <SSRC> \
     -f rtp -srtp_out_suite AES_CM_128_HMAC_SHA1_80 -srtp_out_params "$CLIENT_SRTP_KEY" \
     "srtp://<IP>:<PORT>"
   ```

4. **Call `produceAppAudio`** with the same key:

   ```jsonc
   { "transportId": "<id from step 2>",
     "srtpParameters": { "cryptoSuite": "AES_CM_128_HMAC_SHA1_80", "keyBase64": "<CLIENT_SRTP_KEY>" } }
   ```

## Expected

- `produceAppAudio` returns `{ producerId }` (first RTP observed within
  `APP_AUDIO_FIRST_MEDIA_TIMEOUT_MS`, default 3000 ms).
- The second voice client receives a `VOICE_NEW_PRODUCER` for
  `kind: "screen_audio"` and hears the 440 Hz tone.

## Negative cases

- **Blocked / no media:** point ffmpeg at an unreachable port (or do not start
  it) before calling `produceAppAudio` → returns `{ fallback: true }`, no
  `VOICE_NEW_PRODUCER` published, and the transport/UDP port is released.
- **Authorization:** a user lacking `SHARE_SCREEN` calling `createAppAudioIngest`
  or `produceAppAudio` gets a hard `FORBIDDEN` — never `{ fallback: true }`.

## Notes

- SSRC is allocated per ingest (`allocateAppAudioSsrc` in
  `apps/server/src/runtimes/app-audio-ingest.ts`); always read it back from the
  `createAppAudioIngest` response rather than hard-coding it.
- A scripted fixture (vs. this manual flow) could live under
  `apps/server/src/runtimes/__tests__/fixtures/`; the manual ffmpeg path is kept
  here because end-to-end SRTP interop is the thing being proven and is best
  observed against a live worker.

## Desktop native path (implemented)

The Electron-main sender is `apps/desktop/src/main/app-audio-rtp-sender.ts`
(resample → Opus via `@evan/opus` → RTP+SRTP via `werift-rtp` → UDP). The client
gate is `startNativeAppAudioIngest` in `apps/client/src/components/voice-provider/index.tsx`.
It is opt-in from the desktop app's user device settings. `VITE_VOICE_NATIVE_APP_AUDIO=true`
or `localStorage['voice.nativeAppAudio']='true'` can still force it on for smoke tests. It falls back
to the worklet path on older builds, blocked UDP, no first media, or the default-off rollout gate.
Unit tests in `apps/desktop/src/main/__tests__/app-audio-rtp-sender.test.ts`
prove the RTP/SRTP packet is decryptable with the key handed to the server
(local SRTP interop), plus resampler behavior.

**Still requires a live + packaged validation** (cannot be exercised in CI):

1. **End-to-end audio**: run a desktop build, share an app with audio to a
   channel, and confirm a second client hears it with no periodic drops and the
   server logs no `[per-app-audio] PCM queue telemetry` (worklet path unused).
2. **Packaging of `@evan/opus`**: it is `--external` in the tsup `build:main` and
   listed in electron-builder `files` + `asarUnpack` (it loads a per-platform
   `.node`/`.wasm` from disk and cannot be bundled or run from inside the asar).
   Verify the packaged app loads the encoder — if native ingest silently falls
   back in a packaged build, this is the first thing to check. Set
   `OPUS_FORCE_WASM=1` to rule the native addon in/out.
3. **comedia + SRTP `tuple` ordering** against the live worker — confirm
   `produceAppAudio` returns `{ producerId }` and not a spurious `{ fallback }`.
