# Video ownership

**Status:** Implemented as stage 5 of the voice-provider refactor. This record
describes the ownership and lifecycle contracts; implementation sequencing and
merge-time validation notes are kept in the pull requests.

## Webcam

`webcam-controller.ts` owns acquisition, stream and producer identity, publication,
track-ended cleanup, stop, detach and republish. `useWebcam` supplies browser,
settings and server adapters and mounts cleanup in a layout effect. Construction
acquires no media. The existing control hook still publishes successful starts.
Webcam codec, bitrate, motion hint and `stopTracks: false` configuration are retained.

The owner alone publishes the webcam snapshot. `useLocalStreams` holds neither
its producer nor its capture teardown. Recovery delegates detach and republish;
failed republish retains live capture. Settings comparison and explicit restart
live beside the webcam owner.

Stop and recovery read the immediately current owner stream instead of a rendered
stream or a passive-effect mirror. Publication reads committed current settings
instead of the callback's render-captured codec/resolution/frame rate. Acquisition
still snapshots constraints when it starts. These getter reads are intentional:
stop reaches capture published before a React render, and restart uses the current
settings.

## Screen video

`screen-share-controller.ts` owns picker integration, display/video publication,
track-ended handling, detach/republish, capture stop and quality-guard mounting.
`useScreenShare` supplies browser/dialog/desktop/timer adapters and the existing
tracing span. Selection normalization, sidecar capability gating, loopback
fallback acquisition and early video notification remain explicit. Optional
audio starts through the [share-audio](./share-audio-controller.md) API after
video publication.

Composition injects `isScreenVideoLive` into audio. Video calls audio operations;
audio imports no video controller and writes no video state. Video stop targets
video tracks; audio stop remains with its owner for mixed display streams.
Session cleanup calls the owners directly, while `useLocalStreams` retains only
React snapshots/setters. Stats and the quality guard use producer getters.

Screen stop/republish and the audio-liveness getter read immediately current
owner state. Picker/audio/capture settings are snapshotted at invocation; video
publication reads committed current codec/resolution/frame rate.

The quality guard keeps its sampling, floor and cooldown policy. It is mounted
after successful screen publication, retained through producer detachment for
recovery, and disposed when capture stops or ends. Idle owners install no
polling interval.

## Combined media settings

`mountMediaSettingsIntegration` subscribes to committed input changes and owns
the previous-device comparison. `useMediaSettings` mounts it and supplies React
notifications.

The mount retains the original effect's independent, uncancelled invocations.
Each invocation decides which media to restart before its microphone await;
webcam restart then reads current committed settings. Cleanup unsubscribes but
does not cancel an invocation already awaiting microphone restart. Webcam owner
fencing rejects a stale overlapping restart, which reports supersession without
a failure toast.

## Lifecycle fencing

Both video owners fence deferred work with lifecycle activation and
per-operation generations:

| Boundary | Previous race | Current behavior |
| --- | --- | --- |
| Deferred capture/publication | Stop, a later start or layout cleanup could be followed by an older acquisition/publication installing resources. | Activation and operation generations fence acquisition, publication and sender-configuration completion. A late attempt closes only its own allocation and capture. |
| Overlapping webcam restarts | Settings starts could finish in the opposite order and overwrite current capture. | The latest invoked webcam start owns completion. Acquisition is not serialized; stale work is rejected and cleaned. |
| Track-ended identity | A callback retained an old producer, and an old screen callback could clear replacement video/audio. | Capture-scoped listeners survive detach, successful republish and failed republish, closing the current producer. Replaced-capture callbacks cannot mutate the successor or notify its controls. |
| Control-hook supersession | A superseded start rejection could make the existing catch handler stop preserved or replacement capture. | Video controls ignore explicit owner supersession while keeping successful-start publication and ordinary failure cleanup. A superseded screen start settles only its own transition's UI: surviving capture finishes the starting indicator, absent capture restores the stage. Neither path stops capture or invalidates its track-ended callback. Expired recovery commands reject before detaching a current producer. |
| Late server allocations | A superseded producer could close before its server-close listener was installed. | Allocation cleanup is registered before awaiting sender configuration. Stale transport/sender completions close the allocated server producer by its immutable ID. |
| Screen startup and optional audio | Stop during picker preparation, acquisition or audio setup could be followed by early/final success or global cleanup of a successor. | The video attempt is checked after every await and after early video notification. A stale picker selection returns null. Late mixed-stream audio tracks are discarded through their sole owner without stopping replacement audio. |
| Quality guard | A sender adjustment completing after disposal/replacement could still update guard bookkeeping. | Producer identity and disposal are rechecked after `setParameters`, including rejection, in addition to the existing stats check. |

Detaching a producer invalidates pending publication but preserves capture and
its loss listener. Republish failure never stops preserved video. Terminal stop
revokes capture before clearing its React snapshot. Layout cleanup fences work
before passive session cleanup; mount cleanup is idempotent during replay.
Session cleanup reaches audio terminal stop once through screen stop; recovery
detaches video and audio separately and calls their republish/recovery
operations. No session machine or retry policy was extracted.

## Coverage limits

Unit tests import the production factories and mounts and mock tracks,
acquisition, transport, the desktop bridge and reporting. They prove ownership
and race handling, not native capture or encoded media.

Browser E2E uses real signaling, mediasoup, WebRTC and decoded remote media, with
Chromium fake camera/microphone and the video-only canvas fixture described in
the [screen-share baseline](./screen-share-baseline.md).
`screen-share-lifecycle.spec.ts` covers leaving and rejoining voice while a
screen acquisition is held. Neither proves physical devices, OS picker
permissions, real tab/window/monitor capture or packaged desktop stop/reconnect.
