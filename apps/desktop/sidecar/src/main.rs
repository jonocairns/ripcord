mod app;
mod platform;
mod protocol;
mod runtime;

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
pub(crate) use protocol::PushKeybindKind;
#[cfg(target_os = "linux")]
pub(crate) use protocol::APP_AUDIO_FRAME_BYTES;
#[cfg(any(windows, target_os = "linux"))]
pub(crate) use protocol::APP_AUDIO_FRAME_SIZE;
#[cfg(target_os = "macos")]
pub(crate) use protocol::MAX_APP_AUDIO_BINARY_FRAME_BYTES;
pub(crate) use protocol::{
    AudioTarget, CaptureEndReason, CaptureOutcome, APP_AUDIO_CHANNELS, APP_AUDIO_SAMPLE_RATE,
    PCM_ENCODING, PROTOCOL_VERSION,
};
#[cfg(target_os = "macos")]
pub(crate) use protocol::{AudioTargetListResponse, ResolveSourceResult, MACOS_HELPER_BINARY_NAME};
#[cfg(any(windows, target_os = "macos"))]
pub(crate) use runtime::enqueue_frame_event;
pub(crate) use runtime::{enqueue_push_keybind_state_event, FrameQueue, PushKeybindWatcher};

fn main() {
    app::run();
}
