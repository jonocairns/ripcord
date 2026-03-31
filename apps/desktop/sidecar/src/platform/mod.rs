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

macro_rules! dispatch_platform_fn {
    (
        fn $name:ident($($arg:ident: $ty:ty),* $(,)?) -> $return:ty {
            windows => $windows:path,
            macos => $macos:path,
            linux => $linux:path,
            fallback => $fallback:block
        }
    ) => {
        #[cfg(windows)]
        pub(crate) fn $name($($arg: $ty),*) -> $return {
            $windows($($arg),*)
        }

        #[cfg(target_os = "macos")]
        pub(crate) fn $name($($arg: $ty),*) -> $return {
            $macos($($arg),*)
        }

        #[cfg(target_os = "linux")]
        pub(crate) fn $name($($arg: $ty),*) -> $return {
            $linux($($arg),*)
        }

        #[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
        pub(crate) fn $name($($arg: $ty),*) -> $return {
            $fallback
        }
    };
}

dispatch_platform_fn! {
    fn register_push_keybinds(
        frame_queue: Arc<FrameQueue>,
        push_to_talk_keybind: Option<&str>,
        push_to_mute_keybind: Option<&str>,
    ) -> PushKeybindRegistration {
        windows => windows::register_push_keybinds,
        macos => macos::register_push_keybinds,
        linux => linux::register_push_keybinds,
        fallback => {
            let mut errors = Vec::new();
            if push_to_talk_keybind.is_some() || push_to_mute_keybind.is_some() {
                errors.push(
                    "Global push keybind monitoring is not supported on this platform."
                        .to_string(),
                );
            }

            PushKeybindRegistration {
                talk_registered: false,
                mute_registered: false,
                errors,
                watcher: None,
            }
        }
    }
}

dispatch_platform_fn! {
    fn list_audio_targets() -> Vec<AudioTarget> {
        windows => windows::list_audio_targets,
        macos => macos::list_audio_targets,
        linux => linux::list_audio_targets,
        fallback => { Vec::new() }
    }
}

dispatch_platform_fn! {
    fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
        windows => windows::resolve_source_to_pid,
        macos => macos::resolve_source_to_pid,
        linux => linux::resolve_source_to_pid,
        fallback => { None }
    }
}

dispatch_platform_fn! {
    fn capabilities() -> Value {
        windows => windows::capabilities,
        macos => macos::capabilities,
        linux => linux::capabilities,
        fallback => {
            serde_json::json!({
                "platform": std::env::consts::OS,
                "systemAudio": "unsupported",
                "perAppAudio": "unsupported",
                "protocolVersion": crate::PROTOCOL_VERSION,
                "encoding": crate::PCM_ENCODING,
            })
        }
    }
}

dispatch_platform_fn! {
    fn capture_loopback_audio(
        session_id: &str,
        source_id: Option<&str>,
        target_id: &str,
        target_pid: u32,
        self_exclude_pid: Option<u32>,
        stop_flag: Arc<AtomicBool>,
        frame_queue: Arc<FrameQueue>,
        app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
    ) -> CaptureOutcome {
        windows => windows::capture_loopback_audio,
        macos => macos::capture_loopback_audio,
        linux => linux::capture_loopback_audio,
        fallback => {
            CaptureOutcome::capture_error(
                "Per-app audio capture is only available on Windows, macOS, and Linux."
                    .to_string(),
            )
        }
    }
}
