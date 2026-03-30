use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use std::{
    ffi::{c_void, CString},
    fs,
    net::TcpStream,
    sync::{Mutex, OnceLock},
};

use serde_json::{json, Value};
use x11_dl::xlib;

use crate::{
    enqueue_push_keybind_state_event, AudioTarget, CaptureEndReason, CaptureOutcome, FrameQueue,
    PaSampleSpec, PushKeybindKind, PushKeybindWatcher, APP_AUDIO_CHANNELS, APP_AUDIO_FRAME_BYTES,
    PA_SAMPLE_FLOAT32LE, PA_STREAM_RECORD,
};

use super::PushKeybindRegistration;

#[derive(Clone)]
struct LinuxAudioBackendProbe {
    backend: &'static str,
    uses_shell_outs: bool,
    runtime_available: bool,
    runtime_reason: Option<String>,
    per_app_audio_supported: bool,
    per_app_audio_reason: Option<String>,
    per_app_audio_reason_code: Option<&'static str>,
}

struct LinuxAudioBackendProbeCacheEntry {
    expires_at: Instant,
    probe: LinuxAudioBackendProbe,
}

const LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE: &str = "pulseaudio-native";
const LINUX_AUDIO_BACKEND_UNAVAILABLE_CODE: &str = "linux-native-audio-backend-unavailable";
const LINUX_AUDIO_BACKEND_PROBE_CACHE_TTL: Duration = Duration::from_secs(2);

static LINUX_AUDIO_BACKEND_PROBE_CACHE: OnceLock<Mutex<Option<LinuxAudioBackendProbeCacheEntry>>> =
    OnceLock::new();

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct LinuxPushKeybind {
    key_sym: u64,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

fn map_key_code_to_x11_keysym(key_code: &str) -> Option<u64> {
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let ch = key_code.chars().nth(3)?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_lowercase() as u64);
        }
    }

    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let ch = key_code.chars().nth(5)?;
        if ch.is_ascii_digit() {
            return Some(ch as u64);
        }
    }

    if let Some(num_str) = key_code.strip_prefix('F') {
        if let Ok(n) = num_str.parse::<u64>() {
            if (1..=24).contains(&n) {
                return Some(0xFFBD + n);
            }
        }
    }

    if let Some(num_str) = key_code.strip_prefix("Numpad") {
        if num_str.len() == 1 {
            let ch = num_str.chars().next()?;
            if ch.is_ascii_digit() {
                return Some(0xFFB0 + (ch as u64 - '0' as u64));
            }
        }
    }

    match key_code {
        "Space" => Some(0x0020),
        "Enter" => Some(0xFF0D),
        "Escape" => Some(0xFF1B),
        "Backspace" => Some(0xFF08),
        "Tab" => Some(0xFF09),
        "CapsLock" => Some(0xFFE5),
        "ArrowLeft" => Some(0xFF51),
        "ArrowRight" => Some(0xFF53),
        "ArrowUp" => Some(0xFF52),
        "ArrowDown" => Some(0xFF54),
        "Delete" => Some(0xFFFF),
        "Insert" => Some(0xFF63),
        "Home" => Some(0xFF50),
        "End" => Some(0xFF57),
        "PageUp" => Some(0xFF55),
        "PageDown" => Some(0xFF56),
        "Minus" => Some(0x002D),
        "Equal" => Some(0x003D),
        "BracketLeft" => Some(0x005B),
        "BracketRight" => Some(0x005D),
        "Backslash" => Some(0x005C),
        "Semicolon" => Some(0x003B),
        "Quote" => Some(0x0027),
        "Comma" => Some(0x002C),
        "Period" => Some(0x002E),
        "Slash" => Some(0x002F),
        "Backquote" => Some(0x0060),
        "NumpadMultiply" => Some(0xFFAA),
        "NumpadAdd" => Some(0xFFAB),
        "NumpadSubtract" => Some(0xFFAD),
        "NumpadDecimal" => Some(0xFFAE),
        "NumpadDivide" => Some(0xFFAF),
        "NumpadEnter" => Some(0xFF8D),
        _ => None,
    }
}

fn parse_push_keybind(keybind: Option<&str>) -> Result<Option<LinuxPushKeybind>, String> {
    let Some(keybind) = keybind else {
        return Ok(None);
    };

    if keybind.trim().is_empty() {
        return Ok(None);
    }

    let tokens: Vec<&str> = keybind
        .split('+')
        .map(|token| token.trim())
        .filter(|token| !token.is_empty())
        .collect();

    if tokens.is_empty() {
        return Ok(None);
    }

    let mut ctrl = false;
    let mut alt = false;
    let mut shift = false;
    let mut meta = false;
    let mut key_code_token: Option<&str> = None;

    for token in tokens {
        match token {
            "Control" | "Ctrl" => {
                ctrl = true;
            }
            "Alt" => {
                alt = true;
            }
            "Shift" => {
                shift = true;
            }
            "Meta" | "Super" => {
                meta = true;
            }
            _ => {
                if key_code_token.is_some() {
                    return Err("Invalid keybind format.".to_string());
                }

                key_code_token = Some(token);
            }
        }
    }

    let key_code_name = key_code_token.ok_or_else(|| "Missing key code in keybind.".to_string())?;
    let key_sym = map_key_code_to_x11_keysym(key_code_name)
        .ok_or_else(|| "Unsupported key for global keybind monitoring.".to_string())?;

    Ok(Some(LinuxPushKeybind {
        key_sym,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

fn open_x11_and_resolve_keycodes(
    talk_keybind: Option<&LinuxPushKeybind>,
    mute_keybind: Option<&LinuxPushKeybind>,
) -> Result<(Option<u8>, Option<u8>), String> {
    use std::ptr;

    let xlib = xlib::Xlib::open().map_err(|_| {
        "X11 library (libX11.so) not found. Keybind monitoring requires X11 or XWayland."
            .to_string()
    })?;

    let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
    if display.is_null() {
        return Err(
            "Could not connect to X11 display. Ensure $DISPLAY is set or XWayland is running."
                .to_string(),
        );
    }

    let resolve = |sym: u64| -> Option<u8> {
        let kc = unsafe { (xlib.XKeysymToKeycode)(display, sym) };
        if kc == 0 {
            eprintln!(
                "[capture-sidecar] XKeysymToKeycode returned 0 for KeySym {sym:#x} — key not present in current layout"
            );
            None
        } else {
            Some(kc)
        }
    };

    let talk_kc = talk_keybind.and_then(|kb| resolve(kb.key_sym));
    let mute_kc = mute_keybind.and_then(|kb| resolve(kb.key_sym));

    unsafe { (xlib.XCloseDisplay)(display) };

    Ok((talk_kc, mute_kc))
}

fn start_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<(LinuxPushKeybind, u8)>,
    mute_keybind: Option<(LinuxPushKeybind, u8)>,
) -> PushKeybindWatcher {
    use std::ptr;

    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        let xlib = match xlib::Xlib::open() {
            Ok(lib) => lib,
            Err(error) => {
                eprintln!("[capture-sidecar] X11 unavailable in keybind thread: {error}");
                return;
            }
        };

        let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
        if display.is_null() {
            eprintln!("[capture-sidecar] could not open X11 display in keybind thread");
            return;
        }

        let resolve = |sym: u64| -> u8 { unsafe { (xlib.XKeysymToKeycode)(display, sym) } };

        let shift_l = resolve(0xFFE1);
        let shift_r = resolve(0xFFE2);
        let ctrl_l = resolve(0xFFE3);
        let ctrl_r = resolve(0xFFE4);
        let alt_l = resolve(0xFFE9);
        let alt_r = resolve(0xFFEA);
        let meta_l = resolve(0xFFEB);
        let meta_r = resolve(0xFFEC);

        let mut talk_active = false;
        let mut mute_active = false;

        while !thread_stop_flag.load(Ordering::Relaxed) {
            let mut keys = [0i8; 32];
            unsafe { (xlib.XQueryKeymap)(display, keys.as_mut_ptr()) };

            let kc_down =
                |kc: u8| -> bool { kc != 0 && (keys[kc as usize / 8] & (1 << (kc % 8))) != 0 };

            let keybind_active = |(kb, kc): &(LinuxPushKeybind, u8)| -> bool {
                if !kc_down(*kc) {
                    return false;
                }
                let ctrl = kc_down(ctrl_l) || kc_down(ctrl_r);
                let alt = kc_down(alt_l) || kc_down(alt_r);
                let shift = kc_down(shift_l) || kc_down(shift_r);
                let meta = kc_down(meta_l) || kc_down(meta_r);
                ctrl == kb.ctrl && alt == kb.alt && shift == kb.shift && meta == kb.meta
            };

            let next_talk_active = talk_keybind.as_ref().is_some_and(keybind_active);
            let next_mute_active = mute_keybind.as_ref().is_some_and(keybind_active);

            if next_talk_active != talk_active {
                talk_active = next_talk_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, talk_active);
            }

            if next_mute_active != mute_active {
                mute_active = next_mute_active;
                enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, mute_active);
            }

            thread::sleep(Duration::from_millis(8));
        }

        if talk_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, false);
        }

        if mute_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, false);
        }

        unsafe { (xlib.XCloseDisplay)(display) };
    });

    PushKeybindWatcher::new(stop_flag, handle)
}

pub(crate) fn register_push_keybinds(
    frame_queue: Arc<FrameQueue>,
    push_to_talk_keybind: Option<&str>,
    push_to_mute_keybind: Option<&str>,
) -> PushKeybindRegistration {
    let mut errors: Vec<String> = Vec::new();

    let talk_keybind = match parse_push_keybind(push_to_talk_keybind) {
        Ok(parsed_keybind) => parsed_keybind,
        Err(error) => {
            errors.push(format!("Push-to-talk keybind is invalid: {error}"));
            None
        }
    };

    let mut mute_keybind = match parse_push_keybind(push_to_mute_keybind) {
        Ok(parsed_keybind) => parsed_keybind,
        Err(error) => {
            errors.push(format!("Push-to-mute keybind is invalid: {error}"));
            None
        }
    };

    if talk_keybind.is_some() && mute_keybind.is_some() && talk_keybind == mute_keybind {
        mute_keybind = None;
        errors.push("Push-to-mute keybind matches push-to-talk and was ignored.".to_string());
    }

    let mut resolved_talk: Option<(LinuxPushKeybind, u8)> = None;
    let mut resolved_mute: Option<(LinuxPushKeybind, u8)> = None;
    let mut watcher = None;

    if talk_keybind.is_some() || mute_keybind.is_some() {
        match open_x11_and_resolve_keycodes(talk_keybind.as_ref(), mute_keybind.as_ref()) {
            Err(error) => errors.push(error),
            Ok((talk_kc, mute_kc)) => {
                if talk_keybind.is_some() && talk_kc.is_none() {
                    errors.push(
                        "Push-to-talk key has no mapping on this keyboard layout.".to_string(),
                    );
                }
                if mute_keybind.is_some() && mute_kc.is_none() {
                    errors.push(
                        "Push-to-mute key has no mapping on this keyboard layout.".to_string(),
                    );
                }

                resolved_talk = talk_keybind.zip(talk_kc);
                resolved_mute = mute_keybind.zip(mute_kc);

                if resolved_talk.is_some() || resolved_mute.is_some() {
                    watcher = Some(start_push_keybind_watcher(
                        frame_queue,
                        resolved_talk,
                        resolved_mute,
                    ));
                }
            }
        }
    }

    PushKeybindRegistration {
        talk_registered: resolved_talk.is_some(),
        mute_registered: resolved_mute.is_some(),
        errors,
        watcher,
    }
}

fn probe_audio_backend() -> LinuxAudioBackendProbe {
    let cache = LINUX_AUDIO_BACKEND_PROBE_CACHE.get_or_init(|| Mutex::new(None));
    let now = Instant::now();

    if let Ok(cache_guard) = cache.lock() {
        if let Some(entry) = cache_guard.as_ref() {
            if now < entry.expires_at {
                return entry.probe.clone();
            }
        }
    }

    let probe = match crate::linux_pulse_lib() {
        Ok(_) => match crate::linux_pulse_audio_snapshot() {
            Ok(_) => LinuxAudioBackendProbe {
                backend: LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE,
                uses_shell_outs: false,
                runtime_available: true,
                runtime_reason: None,
                per_app_audio_supported: true,
                per_app_audio_reason: None,
                per_app_audio_reason_code: None,
            },
            Err(error) => LinuxAudioBackendProbe {
                backend: LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE,
                uses_shell_outs: false,
                runtime_available: true,
                runtime_reason: None,
                per_app_audio_supported: false,
                per_app_audio_reason: Some(error),
                per_app_audio_reason_code: Some(LINUX_AUDIO_BACKEND_UNAVAILABLE_CODE),
            },
        },
        Err(error) => LinuxAudioBackendProbe {
            backend: LINUX_AUDIO_BACKEND_PULSEAUDIO_NATIVE,
            uses_shell_outs: false,
            runtime_available: false,
            runtime_reason: Some(error.clone()),
            per_app_audio_supported: false,
            per_app_audio_reason: Some(error),
            per_app_audio_reason_code: Some(LINUX_AUDIO_BACKEND_UNAVAILABLE_CODE),
        },
    };

    if let Ok(mut cache_guard) = cache.lock() {
        *cache_guard = Some(LinuxAudioBackendProbeCacheEntry {
            expires_at: Instant::now() + LINUX_AUDIO_BACKEND_PROBE_CACHE_TTL,
            probe: probe.clone(),
        });
    }

    probe
}

fn detect_session_type() -> String {
    let session_type = std::env::var("XDG_SESSION_TYPE")
        .ok()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| !value.is_empty());

    if let Some(session_type) = session_type {
        return session_type;
    }

    if std::env::var_os("WAYLAND_DISPLAY").is_some() {
        return "wayland".to_string();
    }

    if std::env::var_os("DISPLAY").is_some() {
        return "x11".to_string();
    }

    "unknown".to_string()
}

fn probe_x11_display() -> (bool, Option<String>) {
    use std::ptr;

    if std::env::var_os("DISPLAY").is_none() {
        return (
            false,
            Some("No X11 display was detected for the current Linux session.".to_string()),
        );
    }

    let xlib = match xlib::Xlib::open() {
        Ok(xlib) => xlib,
        Err(_) => {
            return (
                false,
                Some("X11 library (libX11.so) not found. Global push keybind monitoring requires X11 or XWayland.".to_string()),
            )
        }
    };

    let display = unsafe { (xlib.XOpenDisplay)(ptr::null()) };
    if display.is_null() {
        return (
            false,
            Some(
                "Could not connect to the current X11 display. Global push keybind monitoring requires X11 or XWayland."
                    .to_string(),
            ),
        );
    }

    unsafe { (xlib.XCloseDisplay)(display) };
    (true, None)
}

fn process_cmdline_contains(needle: &str) -> bool {
    let Ok(entries) = fs::read_dir("/proc") else {
        return false;
    };

    entries
        .flatten()
        .filter_map(|entry| {
            entry
                .file_name()
                .into_string()
                .ok()
                .filter(|name| name.chars().all(|char| char.is_ascii_digit()))
        })
        .any(|pid| {
            let cmdline_path = format!("/proc/{pid}/cmdline");
            let Ok(cmdline) = fs::read(cmdline_path) else {
                return false;
            };

            cmdline
                .split(|byte| *byte == 0)
                .filter_map(|segment| std::str::from_utf8(segment).ok())
                .any(|segment| segment.contains(needle))
        })
}

fn probe_desktop_portal() -> (bool, Option<String>) {
    // This is intentionally a best-effort readiness heuristic, not a hard gate:
    // some desktop sessions rely on D-Bus socket activation, so the portal
    // process may not appear in `/proc` until the first request triggers it.
    // We still surface the missing-portal result as guidance because it catches
    // the common broken-session case without adding a D-Bus dependency here.
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return (
            false,
            Some(
                "No D-Bus session bus was detected. Wayland screen sharing requires xdg-desktop-portal."
                    .to_string(),
            ),
        );
    }

    if !process_cmdline_contains("xdg-desktop-portal") {
        return (
            false,
            Some(
                "xdg-desktop-portal is not running for the current desktop session. Wayland screen sharing requires it."
                    .to_string(),
            ),
        );
    }

    (true, None)
}

pub(crate) fn capabilities() -> Value {
    let audio_backend = probe_audio_backend();
    let session_type = detect_session_type();
    let (portal_available, portal_reason) = probe_desktop_portal();
    let (x11_display_available, x11_display_reason) = probe_x11_display();
    let source_audio_target_inference_reason = Some(
        "Linux does not infer an app-audio target from the selected share source; choose a target manually."
            .to_string(),
    );
    let (system_audio, per_app_audio, per_app_audio_reason) =
        if audio_backend.per_app_audio_supported {
            ("best-effort", "best-effort", None)
        } else {
            (
                "unsupported",
                "unsupported",
                audio_backend.per_app_audio_reason.clone(),
            )
        };
    let (global_push_keybinds, global_push_keybinds_reason) = if x11_display_available {
        if session_type == "wayland" {
            (
                "best-effort",
                Some(
                    "Global push keybinds use XWayland in Wayland sessions and may not work in every compositor."
                        .to_string(),
                ),
            )
        } else {
            ("supported", None)
        }
    } else {
        ("unsupported", x11_display_reason.clone())
    };

    let mut response = json!({
        "platform": std::env::consts::OS,
        "systemAudio": system_audio,
        "perAppAudio": per_app_audio,
        "protocolVersion": crate::PROTOCOL_VERSION,
        "encoding": crate::PCM_ENCODING,
        "sessionType": session_type,
        "linuxAudioBackend": audio_backend.backend,
        "linuxAudioBackendUsesShellOuts": audio_backend.uses_shell_outs,
        "linuxAudioRuntimeAvailable": audio_backend.runtime_available,
        "linuxAudioCaptureAvailable": audio_backend.per_app_audio_supported,
        // Keep the PipeWire-era field names as aliases until older desktop clients
        // no longer depend on the original sidecar contract.
        "pipewireRuntimeAvailable": audio_backend.runtime_available,
        "pipewireToolsAvailable": audio_backend.per_app_audio_supported,
        "portalAvailable": portal_available,
        "appAudioTargetEnumerationSupported": audio_backend.per_app_audio_supported,
        "sourceAudioTargetInferenceSupported": false,
        "globalPushKeybinds": global_push_keybinds,
        "x11DisplayAvailable": x11_display_available,
    });

    if let Some(reason) = per_app_audio_reason {
        response["perAppAudioReason"] = json!(reason);
    }

    if let Some(reason) = portal_reason {
        response["portalReason"] = json!(reason);
        response["portalReasonCode"] = json!("linux-desktop-portal-required");
    }

    if let Some(reason) = audio_backend.runtime_reason.clone() {
        response["linuxAudioRuntimeReason"] = json!(reason);
        response["pipewireRuntimeReason"] = json!(reason);
    }

    if let Some(reason) = audio_backend.per_app_audio_reason.clone() {
        response["appAudioTargetEnumerationReason"] = json!(reason);
        if let Some(reason_code) = audio_backend.per_app_audio_reason_code {
            response["appAudioTargetEnumerationReasonCode"] = json!(reason_code);
            response["perAppAudioReasonCode"] = json!(reason_code);
        }
    }

    if let Some(reason) = source_audio_target_inference_reason {
        response["sourceAudioTargetInferenceReason"] = json!(reason);
        response["sourceAudioTargetInferenceReasonCode"] =
            json!("linux-manual-app-target-selection-required");
    }

    if let Some(reason) = global_push_keybinds_reason {
        response["globalPushKeybindsReason"] = json!(reason);
        response["globalPushKeybindsReasonCode"] = json!(if x11_display_available {
            "linux-xwayland-best-effort"
        } else {
            "linux-x11-display-required"
        });
    }

    if let Some(reason) = x11_display_reason {
        response["x11DisplayReason"] = json!(reason);
        response["x11DisplayReasonCode"] = json!("linux-x11-display-required");
    }

    response
}

pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    match crate::linux_pulse_audio_snapshot() {
        Ok(snapshot) => snapshot
            .targets
            .into_iter()
            .map(|target| AudioTarget {
                id: target.id,
                label: target.label,
                pid: target.pid,
                process_name: target.process_name,
            })
            .collect(),
        Err(error) => {
            eprintln!("[capture-sidecar] {error}");
            Vec::new()
        }
    }
}

pub(crate) fn resolve_source_to_pid(_source_id: &str) -> Option<u32> {
    None
}

pub(crate) fn capture_loopback_audio(
    session_id: &str,
    _source_id: Option<&str>,
    _target_id: &str,
    target_pid: u32,
    self_exclude_pid: Option<u32>,
    stop_flag: Arc<AtomicBool>,
    frame_queue: Arc<FrameQueue>,
    app_audio_binary_stream: Option<Arc<Mutex<Option<TcpStream>>>>,
) -> CaptureOutcome {
    let _ = self_exclude_pid;
    let capture_source = match crate::linux_pulse_capture_source_for_target(if target_pid == 0 {
        "loopback"
    } else {
        _target_id
    }) {
        Ok(capture_source) => capture_source,
        Err(error) => return CaptureOutcome::capture_error(error),
    };

    let lib = match crate::linux_pulse_lib() {
        Ok(lib) => lib,
        Err(error) => return CaptureOutcome::capture_error(error),
    };

    let app_name = CString::new("Sharkord Capture Sidecar")
        .unwrap_or_else(|_| CString::new("Sharkord").unwrap());
    let stream_name = CString::new("Sharkord App Audio Capture")
        .unwrap_or_else(|_| CString::new("Capture").unwrap());
    let source_name = match CString::new(capture_source.monitor_source_name.clone()) {
        Ok(source_name) => source_name,
        Err(error) => {
            return CaptureOutcome::capture_error(format!(
                "Invalid Linux monitor source name: {error}"
            ))
        }
    };

    let sample_spec = PaSampleSpec {
        format: PA_SAMPLE_FLOAT32LE,
        rate: crate::APP_AUDIO_SAMPLE_RATE,
        channels: APP_AUDIO_CHANNELS as u8,
    };
    let mut error_code = 0;
    let simple = unsafe {
        (lib.pa_simple_new)(
            std::ptr::null(),
            app_name.as_ptr(),
            PA_STREAM_RECORD,
            source_name.as_ptr(),
            stream_name.as_ptr(),
            &sample_spec,
            std::ptr::null(),
            std::ptr::null(),
            &mut error_code,
        )
    };

    if simple.is_null() {
        return CaptureOutcome::capture_error(format!(
            "Failed to start Linux audio capture: {}",
            crate::linux_pulse_strerror(lib, error_code)
        ));
    }

    let mut sequence: u64 = 0;
    let mut frame_bytes = vec![0u8; APP_AUDIO_FRAME_BYTES];

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            unsafe { (lib.pa_simple_free)(simple) };
            return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
        }

        if unsafe {
            (lib.pa_simple_read)(
                simple,
                frame_bytes.as_mut_ptr().cast::<c_void>(),
                frame_bytes.len(),
                &mut error_code,
            )
        } < 0
        {
            unsafe { (lib.pa_simple_free)(simple) };
            return CaptureOutcome::capture_error(format!(
                "Failed reading Linux audio frames: {}",
                crate::linux_pulse_strerror(lib, error_code)
            ));
        }

        let mut frame_samples = frame_bytes
            .chunks_exact(4)
            .map(|sample_bytes| {
                f32::from_le_bytes([
                    sample_bytes[0],
                    sample_bytes[1],
                    sample_bytes[2],
                    sample_bytes[3],
                ])
            })
            .collect::<Vec<f32>>();
        crate::clamp_audio_samples(&mut frame_samples);

        crate::emit_linux_audio_frame(
            session_id,
            &capture_source.target_id,
            sequence,
            &frame_samples,
            &frame_queue,
            &app_audio_binary_stream,
        );
        sequence = sequence.saturating_add(1);
    }
}
