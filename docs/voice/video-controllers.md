# Video ownership (provider refactor stage 5)

Stage 5 extends native stack 1714928 above stage 4 at `c6943784`.
The original untracked plan remains in `/home/jonoc/ripcord`; its status is stale.
Session runtime extraction (stage 6) is outside this work.

## Webcam extraction

`webcam-controller.ts` owns acquisition, stream and producer identity, publication,
track-ended cleanup, stop, detach and republish. `useWebcam` supplies browser,
settings and server adapters and mounts cleanup in a layout effect. Construction
acquires no media. The existing control hook still publishes successful starts.
Webcam codec, bitrate, motion hint and `stopTracks: false` configuration are retained.

The owner alone publishes the webcam snapshot. `useLocalStreams` no longer holds
its producer or tears down its capture. Recovery delegates detach and republish;
failed republish retains live capture. Settings comparison and explicit restart
live beside the webcam owner; the combined listener remains in the provider until
the settings integration layer.

Stop and recovery read the immediately current owner stream instead of a rendered
stream or a passive-effect mirror. Publication reads committed current settings
instead of the callback's render-captured codec/resolution/frame rate. Acquisition
still snapshots constraints when it starts. These getter changes are intentional:
stop reaches capture published before a React render, and restart uses the current
settings. Production-factory tests exercise immediate stop, changed constraints,
transport replacement, native track end after republish and failed republish.
Deferred-start cancellation and stale callback fencing belong to a separate fix
layer, rather than being described as mechanical extraction.
