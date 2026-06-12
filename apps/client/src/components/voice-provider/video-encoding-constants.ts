// Screen and webcam captures are both motion content, so their sender
// `contentHint` is 'motion'. That alone would default degradationPreference to
// 'maintain-framerate' (drop resolution to hold fps). We override it to
// 'balanced' so the encoder can trade a little of both under bitrate/CPU
// pressure instead of collapsing frame rate the way 'detail' +
// 'maintain-resolution' did on high-motion captures.
//
// Lives in its own leaf module because both the voice provider (initial
// publish) and the screen-share quality guard (floor release) need it without
// creating a hook -> provider import cycle.
const VIDEO_DEGRADATION_PREFERENCE: RTCDegradationPreference = 'balanced';

export { VIDEO_DEGRADATION_PREFERENCE };
