# Share-audio ownership

**Status:** Implemented. This record describes the ownership and lifecycle
contracts; implementation sequencing and
merge-time validation notes are kept in the pull requests.

The controller, React adapter, desktop app-audio modules/worklet and tests live
together under `apps/client/src/components/voice-provider/share-audio/`.

## Production boundary

`share-audio/share-audio-controller.ts` is the framework-free owner of browser
display audio, native RTP ingest, renderer worklet capture, the published audio stream,
producer identity, desktop publish intent, subscriptions, startup timeout,
fallback, recovery and teardown. Construction acquires no media. Dependencies
supply the bridge, signaling, transport getter, pipeline factory, stream factory
and publication, timers and reporting. Video liveness is not a dependency: each
`start` and `recover` call supplies an `isScreenVideoLive` getter.

`share-audio/use-share-audio.ts` retains one instance, supplies committed current
inputs and production adapters, and mounts it in a layout effect. The existing desktop
recovery controller still owns its serialized recovery queue and lifecycle
leases; its mount helper lives beside that framework-free controller. No
session/retry policy is introduced.

The [screen-video owner](./video-controllers.md) handles screen selection,
display acquisition, screen-video publication, the early video-start notification
and screen-video cleanup. Immediately after acquisition it hands audio ownership
to `adoptDisplayAudio`; that also covers video publication failure before audio
startup. It then calls `start` for optional audio, and `discardDisplayAudio` for
a late mixed stream it never installed. Explicit stop, screen-video ending and
terminal session cleanup reach `stop` through the screen owner. Reconnect cleanup
calls `detachProducer`, retaining capture and desktop intent. The republish plan
delegates audio to `republish`, and session recovery call sites delegate to
`recover`.

Audio calls no screen lifecycle operation. The screen owner passes its `isLive`
to `start`, and the session runtime passes a getter that reads the screen owner
to `recover`. Liveness reflects the installed video producer or the preserved
screen stream. All screen audio producer and stream writes are private to its
owner; `useLocalStreams` retains the React snapshot/setter and no audio teardown
or producer ref. Video cleanup targets video tracks; audio cleanup targets audio
tracks, even for a mixed display stream.

Native startup returns publication, abandonment or operational fallback.
Authorization denial rejects without another publication path. Session and
transport IDs belong to individual attempts. Worklet startup preserves stable
queue mode, dropped-frame silence insertion, the three-second first-frame gate,
capability guidance and live system-loopback fallback. Opus settings, capture
mechanisms, server/API contracts, desktop bridge contracts and the consumed
`useVoice` API are unchanged from the provider implementation.

## Behavior relative to the provider implementation

The native/worklet algorithms, status messages, settings, fallback decisions
and recovery serialization are unchanged. These ownership behaviors differ
deliberately, and each has a production-controller regression test:

| Boundary | Previous behavior / potential race | Current behavior |
| --- | --- | --- |
| Stream reads | Stop captured rendered streams; cleanup/republish read passive-effect stream refs. | Operations read the owner's immediately current stream, so stop reaches audio published before a React snapshot updates. Failed republish retains live capture. |
| Native setting | Native rollout read a value captured by the provider callback. | The native entry reads the latest committed rollout setting after pending teardown. LocalStorage/build overrides keep their precedence. |
| Video liveness | Recovery read the passive screen-stream ref. | The getter supplied with each start or recovery checks the current installed video track, falling back to preserved capture during reconnect. Startup and every recovery step, including queued recovery, read liveness when they run rather than when they were requested, without waiting for a stream-state render. |
| Browser publication | Deferred browser publication and old track callbacks lacked capture-generation fencing. | Stop, supersession and layout cleanup fence publication. Callback identity prevents an old handler from clearing a republished stream. Track cleanup survives expiry of the completed session command's publication lease. |
| Pending cleanup | Queued cleanup detached shared resources only after waiting for its predecessor. | Cleanup detaches its own resource snapshot synchronously, then queues destruction. A new start waits for committed-resource teardown. Attempt-local late teardown cannot clear replacement resources. |
| Native teardown completion | `ownsGlobalState` was captured before awaited RTP/capture/ingest teardown, then used to clear active state afterward. | Native generation is rechecked after the awaits, so an old teardown cannot hide a successor's native producer from cleanup. Server close uses the retained native producer ID. |
| Fallback during recovery | Cleanup temporarily cleared the published display-loopback stream; a successful native recovery dropped the stream without stopping that track. | Recovery retains fallback ownership across its awaits so audio-only stop still reaches it. Native takeover releases the fallback track. Mixed display-stream video stays live. |
| Failed recovery | Native authorization denial or failed loopback republication dropped the last owner of a live fallback track. | Recovery releases retained fallback audio unless its track transferred to a published stream. Late failure cannot release a successor's audio. |

## Lifecycle fencing

Lifecycle cleanup fences startup and recovery before passive session effects can
run. Obsolete work cleans its own session/ingest/pipeline. `awaitTeardown` drains
the committed-resource cleanup queue; it does not make an unresolved bridge
acquisition cancellable. Its eventual result is rejected by the attempt's lease
and cleaned with attempt-owned IDs.

## Coverage limits

`share-audio/__tests__/share-audio-controller.test.ts` and
`share-audio/__tests__/native-app-audio-ingest.test.ts` import the production
controller and mock acquisition, the desktop bridge, signaling and
transport, pipeline creation and media objects. They prove ownership and
branching, not physical capture, SRTP encoding, UDP ingress or WebRTC media flow.

The [browser screen fixture](./video-controllers.md#browser-screen-fixture) is
video-only, so browser display-audio acquisition has no end-to-end coverage. Native RTP ingest,
the renderer worklet with real sidecar capture, system loopback and OS
permission flows need packaged desktop smoke tests on each platform.
