use std::sync::Arc;

use crate::{AudioTarget, FrameQueue, PushKeybindWatcher};

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
