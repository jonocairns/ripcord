use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const PROTOCOL_VERSION: u32 = 1;
pub(crate) const PCM_ENCODING: &str = "f32le_base64";
pub(crate) const APP_AUDIO_BINARY_EGRESS_FRAMING: &str = "length_prefixed_f32le_v1";
pub(crate) const APP_AUDIO_FRAME_SIZE: usize = 960;
pub(crate) const APP_AUDIO_SAMPLE_RATE: u32 = 48_000;
pub(crate) const APP_AUDIO_CHANNELS: usize = 1;
#[cfg(target_os = "linux")]
pub(crate) const APP_AUDIO_FRAME_BYTES: usize = APP_AUDIO_FRAME_SIZE * APP_AUDIO_CHANNELS * 4;
#[allow(dead_code)]
pub(crate) const MAX_APP_AUDIO_BINARY_FRAME_BYTES: usize = 4 * 1024 * 1024;
#[cfg(target_os = "macos")]
pub(crate) const MACOS_HELPER_BINARY_NAME: &str = "sharkord-capture-sidecar-macos-helper";

#[derive(Debug, Deserialize)]
pub(crate) struct SidecarRequest {
    #[serde(default)]
    pub(crate) id: Option<String>,
    pub(crate) method: String,
    #[serde(default)]
    pub(crate) params: Value,
}

#[derive(Debug, Serialize)]
pub(crate) struct SidecarResponse<'a> {
    pub(crate) id: &'a str,
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<SidecarError>,
}

#[derive(Debug, Serialize)]
pub(crate) struct SidecarError {
    pub(crate) message: String,
}

#[derive(Debug, Serialize)]
pub(crate) struct SidecarEvent<'a> {
    pub(crate) event: &'a str,
    pub(crate) params: Value,
}

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioTarget {
    pub(crate) id: String,
    pub(crate) label: String,
    pub(crate) pid: u32,
    pub(crate) process_name: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveSourceParams {
    pub(crate) source_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ListTargetsParams {
    pub(crate) source_id: Option<String>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioTargetListResponse {
    pub(crate) targets: Vec<AudioTarget>,
}

#[cfg(target_os = "macos")]
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ResolveSourceResult {
    pub(crate) pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StartAudioCaptureParams {
    pub(crate) source_id: Option<String>,
    pub(crate) app_audio_target_id: Option<String>,
    pub(crate) self_exclude_pid: Option<u32>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StopAudioCaptureParams {
    pub(crate) session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetPushKeybindsParams {
    pub(crate) push_to_talk_keybind: Option<String>,
    pub(crate) push_to_mute_keybind: Option<String>,
}

#[derive(Debug, Clone, Copy)]
pub(crate) enum CaptureEndReason {
    CaptureStopped,
    #[cfg(windows)]
    AppExited,
    CaptureError,
    #[cfg(windows)]
    DeviceLost,
}

impl CaptureEndReason {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::CaptureStopped => "capture_stopped",
            #[cfg(windows)]
            Self::AppExited => "app_exited",
            Self::CaptureError => "capture_error",
            #[cfg(windows)]
            Self::DeviceLost => "device_lost",
        }
    }
}

#[derive(Debug)]
pub(crate) struct CaptureOutcome {
    pub(crate) reason: CaptureEndReason,
    pub(crate) error: Option<String>,
}

impl CaptureOutcome {
    pub(crate) fn from_reason(reason: CaptureEndReason) -> Self {
        Self {
            reason,
            error: None,
        }
    }

    pub(crate) fn capture_error(error: String) -> Self {
        Self {
            reason: CaptureEndReason::CaptureError,
            error: Some(error),
        }
    }
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum PushKeybindKind {
    Talk,
    Mute,
}

#[cfg(any(windows, target_os = "macos", target_os = "linux"))]
impl PushKeybindKind {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Talk => "talk",
            Self::Mute => "mute",
        }
    }
}
