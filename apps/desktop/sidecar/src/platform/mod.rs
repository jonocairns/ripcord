use std::net::TcpStream;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::{AudioTarget, CaptureOutcome, FrameQueue, PushKeybindWatcher};

pub(crate) struct PushKeybindRegistration {
    pub(crate) talk_registered: bool,
    pub(crate) mute_registered: bool,
    pub(crate) errors: Vec<String>,
    pub(crate) watcher: Option<PushKeybindWatcher>,
}

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(windows)]
mod windows;

#[cfg(windows)]
pub(crate) fn register_push_keybinds(
    frame_queue: Arc<FrameQueue>,
    push_to_talk_keybind: Option<&str>,
    push_to_mute_keybind: Option<&str>,
) -> PushKeybindRegistration {
    windows::register_push_keybinds(frame_queue, push_to_talk_keybind, push_to_mute_keybind)
}

#[cfg(target_os = "macos")]
pub(crate) fn register_push_keybinds(
    frame_queue: Arc<FrameQueue>,
    push_to_talk_keybind: Option<&str>,
    push_to_mute_keybind: Option<&str>,
) -> PushKeybindRegistration {
    macos::register_push_keybinds(frame_queue, push_to_talk_keybind, push_to_mute_keybind)
}

#[cfg(target_os = "linux")]
pub(crate) fn register_push_keybinds(
    frame_queue: Arc<FrameQueue>,
    push_to_talk_keybind: Option<&str>,
    push_to_mute_keybind: Option<&str>,
) -> PushKeybindRegistration {
    linux::register_push_keybinds(frame_queue, push_to_talk_keybind, push_to_mute_keybind)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn register_push_keybinds(
    _frame_queue: Arc<FrameQueue>,
    push_to_talk_keybind: Option<&str>,
    push_to_mute_keybind: Option<&str>,
) -> PushKeybindRegistration {
    let mut errors = Vec::new();
    if push_to_talk_keybind.is_some() || push_to_mute_keybind.is_some() {
        errors
            .push("Global push keybind monitoring is not supported on this platform.".to_string());
    }

    PushKeybindRegistration {
        talk_registered: false,
        mute_registered: false,
        errors,
        watcher: None,
    }
}

#[cfg(windows)]
pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    windows::list_audio_targets()
}

#[cfg(target_os = "macos")]
pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    macos::list_audio_targets()
}

#[cfg(target_os = "linux")]
pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    linux::list_audio_targets()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    Vec::new()
}

#[cfg(windows)]
pub(crate) fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    windows::resolve_source_to_pid(source_id)
}

#[cfg(target_os = "macos")]
pub(crate) fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    macos::resolve_source_to_pid(source_id)
}

#[cfg(target_os = "linux")]
pub(crate) fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    linux::resolve_source_to_pid(source_id)
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn resolve_source_to_pid(_source_id: &str) -> Option<u32> {
    None
}

#[cfg(windows)]
pub(crate) fn capabilities() -> Value {
    windows::capabilities()
}

#[cfg(target_os = "macos")]
pub(crate) fn capabilities() -> Value {
    macos::capabilities()
}

#[cfg(target_os = "linux")]
pub(crate) fn capabilities() -> Value {
    linux::capabilities()
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn capabilities() -> Value {
    serde_json::json!({
        "platform": std::env::consts::OS,
        "systemAudio": "unsupported",
        "perAppAudio": "unsupported",
        "protocolVersion": crate::PROTOCOL_VERSION,
        "encoding": crate::PCM_ENCODING,
    })
}

#[cfg(windows)]
pub(crate) fn capture_loopback_audio(
    session_id: &str,
    source_id: Option<&str>,
    target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    windows::capture_loopback_audio(
        session_id,
        source_id,
        target_id,
        target_pid,
        self_exclude_pid,
        stop_flag,
        frame_queue,
        app_audio_binary_stream,
    )
}

#[cfg(target_os = "macos")]
pub(crate) fn capture_loopback_audio(
    session_id: &str,
    source_id: Option<&str>,
    target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    macos::capture_loopback_audio(
        session_id,
        source_id,
        target_id,
        target_pid,
        self_exclude_pid,
        stop_flag,
        frame_queue,
        app_audio_binary_stream,
    )
}

#[cfg(target_os = "linux")]
pub(crate) fn capture_loopback_audio(
    session_id: &str,
    source_id: Option<&str>,
    target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    linux::capture_loopback_audio(
        session_id,
        source_id,
        target_id,
        target_pid,
        self_exclude_pid,
        stop_flag,
        frame_queue,
        app_audio_binary_stream,
    )
}

#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub(crate) fn capture_loopback_audio(
    _session_id: &str,
    _source_id: Option<&str>,
    _target_id: &str,
    _target_pid: u32,
    _self_exclude_pid: Option<u32>,
    _stop_flag: Arc<AtomicBool>,
    _frame_queue: Arc<FrameQueue>,
    _app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    CaptureOutcome::capture_error(
        "Per-app audio capture is only available on Windows, macOS, and Linux.".to_string(),
    )
}
