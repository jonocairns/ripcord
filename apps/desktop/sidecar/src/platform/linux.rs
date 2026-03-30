use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use x11_dl::xlib;

use crate::{
    enqueue_push_keybind_state_event, AudioTarget, FrameQueue, PushKeybindKind,
    PushKeybindWatcher,
};

use super::PushKeybindRegistration;

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
