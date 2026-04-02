mod global_shortcuts;
mod pulse;

use global_shortcuts::register_push_keybinds_via_portal;
use pulse::LinuxAudioBackendProbe;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::{fs, net::TcpStream, sync::Mutex};

use serde_json::{json, Value};
use x11_dl::xlib;

use crate::{
    enqueue_push_keybind_state_event, AudioTarget, CaptureOutcome, FrameQueue, PushKeybindKind,
    PushKeybindWatcher,
};

use super::PushKeybindRegistration;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) struct LinuxPushKeybind {
    pub(super) key_code: String,
    pub(super) key_sym: u64,
    pub(super) ctrl: bool,
    pub(super) alt: bool,
    pub(super) shift: bool,
    pub(super) meta: bool,
}

#[derive(Debug, Clone)]
struct PortalBackendDefinition {
    name: String,
    interfaces: Vec<String>,
    use_in: Vec<String>,
}

#[derive(Debug, Clone)]
struct LinuxGlobalShortcutsPortalProbe {
    configured: bool,
    backend: Option<String>,
    reason: Option<String>,
}

#[derive(Debug, Clone)]
struct LinuxPushKeybindSupportProbe {
    backend: LinuxPushKeybindBackend,
    global_push_keybinds: &'static str,
    global_push_keybinds_reason: Option<String>,
    global_push_keybinds_reason_code: Option<&'static str>,
    x11_display_available: bool,
    x11_display_reason: Option<String>,
    portal_backend_configured: bool,
    portal_backend: Option<String>,
    portal_backend_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LinuxPushKeybindBackend {
    Portal,
    X11,
    Unsupported,
}

const GLOBAL_SHORTCUTS_PORTAL_INTERFACE: &str =
    "org.freedesktop.impl.portal.GlobalShortcuts";

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
        key_code: key_code_name.to_string(),
        key_sym,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

fn parse_list_with_separator(value: &str, separator: char) -> Vec<String> {
    value
        .split(separator)
        .map(|entry| entry.trim().to_ascii_lowercase())
        .filter(|entry| !entry.is_empty())
        .collect()
}

fn parse_ini_section(path: &Path, target_section: &str) -> Option<HashMap<String, String>> {
    let contents = fs::read_to_string(path).ok()?;
    let mut current_section = String::new();
    let mut values = HashMap::new();

    for raw_line in contents.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }

        if line.starts_with('[') && line.ends_with(']') {
            current_section = line[1..line.len() - 1].trim().to_ascii_lowercase();
            continue;
        }

        if current_section != target_section {
            continue;
        }

        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };

        values.insert(key.trim().to_string(), raw_value.trim().to_string());
    }

    Some(values)
}

fn push_unique_path(paths: &mut Vec<PathBuf>, path: PathBuf) {
    if !paths.iter().any(|existing_path| existing_path == &path) {
        paths.push(path);
    }
}

fn default_path_from_home(home_env: Option<String>, suffix: &str) -> Option<PathBuf> {
    let home = home_env?;
    let mut path = PathBuf::from(home);
    path.push(suffix);
    Some(path)
}

fn xdg_config_roots() -> Vec<PathBuf> {
    let home_env = std::env::var("HOME").ok();
    let mut roots = Vec::new();

    if let Some(config_home) = std::env::var("XDG_CONFIG_HOME").ok() {
        push_unique_path(&mut roots, PathBuf::from(config_home));
    } else if let Some(default_config_home) = default_path_from_home(home_env.clone(), ".config") {
        push_unique_path(&mut roots, default_config_home);
    }

    if let Some(config_dirs) = std::env::var("XDG_CONFIG_DIRS").ok() {
        for config_dir in config_dirs.split(':').filter(|entry| !entry.is_empty()) {
            push_unique_path(&mut roots, PathBuf::from(config_dir));
        }
    } else {
        push_unique_path(&mut roots, PathBuf::from("/etc/xdg"));
    }

    push_unique_path(&mut roots, PathBuf::from("/etc"));
    roots
}

fn xdg_data_roots() -> Vec<PathBuf> {
    let home_env = std::env::var("HOME").ok();
    let mut roots = Vec::new();

    if let Some(data_home) = std::env::var("XDG_DATA_HOME").ok() {
        push_unique_path(&mut roots, PathBuf::from(data_home));
    } else if let Some(default_data_home) =
        default_path_from_home(home_env.clone(), ".local/share")
    {
        push_unique_path(&mut roots, default_data_home);
    }

    if let Some(data_dirs) = std::env::var("XDG_DATA_DIRS").ok() {
        for data_dir in data_dirs.split(':').filter(|entry| !entry.is_empty()) {
            push_unique_path(&mut roots, PathBuf::from(data_dir));
        }
    } else {
        push_unique_path(&mut roots, PathBuf::from("/usr/local/share"));
        push_unique_path(&mut roots, PathBuf::from("/usr/share"));
    }

    roots
}

fn detect_current_desktops() -> Vec<String> {
    std::env::var("XDG_CURRENT_DESKTOP")
        .ok()
        .map(|value| parse_list_with_separator(&value, ':'))
        .unwrap_or_default()
}

fn portal_config_path(current_desktops: &[String]) -> Option<PathBuf> {
    let search_roots = xdg_config_roots();

    for root in search_roots {
        let portal_dir = root.join("xdg-desktop-portal");

        for desktop in current_desktops {
            let desktop_config_path = portal_dir.join(format!("{desktop}-portals.conf"));
            if desktop_config_path.is_file() {
                return Some(desktop_config_path);
            }
        }

        let generic_config_path = portal_dir.join("portals.conf");
        if generic_config_path.is_file() {
            return Some(generic_config_path);
        }
    }

    None
}

fn load_portal_backend_definitions() -> HashMap<String, PortalBackendDefinition> {
    let mut definitions = HashMap::new();

    for root in xdg_data_roots() {
        let portal_dir = root.join("xdg-desktop-portal").join("portals");
        let Ok(entries) = fs::read_dir(portal_dir) else {
            continue;
        };

        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("portal") {
                continue;
            }

            let Some(portal_name) = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .map(|stem| stem.to_ascii_lowercase())
            else {
                continue;
            };

            if definitions.contains_key(&portal_name) {
                continue;
            }

            let Some(portal_section) = parse_ini_section(&path, "portal") else {
                continue;
            };

            let interfaces = portal_section
                .get("Interfaces")
                .map(|value| parse_list_with_separator(value, ';'))
                .unwrap_or_default();

            if interfaces.is_empty() {
                continue;
            }

            let use_in = portal_section
                .get("UseIn")
                .map(|value| parse_list_with_separator(value, ';'))
                .unwrap_or_default();

            definitions.insert(
                portal_name.clone(),
                PortalBackendDefinition {
                    name: portal_name,
                    interfaces,
                    use_in,
                },
            );
        }
    }

    definitions
}

fn backend_supports_interface(
    backend: &PortalBackendDefinition,
    interface_name: &str,
) -> bool {
    backend.interfaces.iter().any(|interface| interface == interface_name)
}

fn backend_matches_desktop(
    backend: &PortalBackendDefinition,
    current_desktops: &[String],
) -> bool {
    backend.use_in.is_empty()
        || current_desktops.is_empty()
        || backend
            .use_in
            .iter()
            .any(|desktop| current_desktops.iter().any(|current| current == desktop))
}

fn resolve_portal_backend_from_candidates(
    backend_candidates: &[String],
    portal_definitions: &HashMap<String, PortalBackendDefinition>,
    current_desktops: &[String],
) -> Option<String> {
    for backend_candidate in backend_candidates {
        if backend_candidate == "none" {
            return None;
        }

        if backend_candidate == "*" {
            let mut matching_backends: Vec<&PortalBackendDefinition> = portal_definitions
                .values()
                .filter(|backend| {
                    backend_supports_interface(backend, GLOBAL_SHORTCUTS_PORTAL_INTERFACE)
                        && backend_matches_desktop(backend, current_desktops)
                })
                .collect();
            matching_backends.sort_by(|left, right| left.name.cmp(&right.name));
            return matching_backends.first().map(|backend| backend.name.clone());
        }

        if let Some(backend) = portal_definitions.get(backend_candidate) {
            if backend_supports_interface(backend, GLOBAL_SHORTCUTS_PORTAL_INTERFACE) {
                return Some(backend.name.clone());
            }
        }
    }

    None
}

fn probe_wayland_global_shortcuts_portal() -> LinuxGlobalShortcutsPortalProbe {
    let current_desktops = detect_current_desktops();
    let portal_definitions = load_portal_backend_definitions();

    if portal_definitions
        .values()
        .all(|backend| !backend_supports_interface(backend, GLOBAL_SHORTCUTS_PORTAL_INTERFACE))
    {
        return LinuxGlobalShortcutsPortalProbe {
            configured: false,
            backend: None,
            reason: Some(
                "No installed xdg-desktop-portal backend advertises the Global Shortcuts interface."
                    .to_string(),
            ),
        };
    }

    if let Some(config_path) = portal_config_path(&current_desktops) {
        if let Some(preferred_section) = parse_ini_section(&config_path, "preferred") {
            let configured_backends = preferred_section
                .get(GLOBAL_SHORTCUTS_PORTAL_INTERFACE)
                .or_else(|| preferred_section.get("default"))
                .map(|value| parse_list_with_separator(value, ';'))
                .unwrap_or_default();

            if configured_backends.iter().any(|backend| backend == "none") {
                return LinuxGlobalShortcutsPortalProbe {
                    configured: false,
                    backend: None,
                    reason: Some(
                        "The current portal configuration disables the Global Shortcuts interface."
                            .to_string(),
                    ),
                };
            }

            if let Some(backend) = resolve_portal_backend_from_candidates(
                &configured_backends,
                &portal_definitions,
                &current_desktops,
            ) {
                return LinuxGlobalShortcutsPortalProbe {
                    configured: true,
                    backend: Some(backend),
                    reason: None,
                };
            }

            if !configured_backends.is_empty() {
                return LinuxGlobalShortcutsPortalProbe {
                    configured: false,
                    backend: None,
                    reason: Some(
                        "The current portal configuration does not select a backend that implements Global Shortcuts."
                            .to_string(),
                    ),
                };
            }
        }
    }

    let mut matching_backends: Vec<&PortalBackendDefinition> = portal_definitions
        .values()
        .filter(|backend| {
            backend_supports_interface(backend, GLOBAL_SHORTCUTS_PORTAL_INTERFACE)
                && backend_matches_desktop(backend, &current_desktops)
        })
        .collect();
    matching_backends.sort_by(|left, right| left.name.cmp(&right.name));

    if let Some(backend) = matching_backends.first() {
        return LinuxGlobalShortcutsPortalProbe {
            configured: true,
            backend: Some(backend.name.clone()),
            reason: None,
        };
    }

    LinuxGlobalShortcutsPortalProbe {
        configured: false,
        backend: None,
        reason: Some(
            "No portal backend advertises Global Shortcuts for the current desktop environment."
                .to_string(),
        ),
    }
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

    if talk_keybind.is_none() && mute_keybind.is_none() {
        return PushKeybindRegistration {
            talk_registered: false,
            mute_registered: false,
            errors,
            watcher: None,
        };
    }

    let session_type = detect_session_type();
    let (portal_available, portal_reason) = probe_desktop_portal();
    let push_keybind_support = probe_linux_push_keybind_support(
        &session_type,
        portal_available,
        portal_reason.as_deref(),
    );

    let mut registration = match push_keybind_support.backend {
        LinuxPushKeybindBackend::Portal => register_push_keybinds_via_portal(
            frame_queue,
            talk_keybind.as_ref(),
            mute_keybind.as_ref(),
        ),
        LinuxPushKeybindBackend::X11 => register_push_keybinds_via_x11(
            frame_queue,
            talk_keybind,
            mute_keybind,
        ),
        LinuxPushKeybindBackend::Unsupported => {
            if let Some(reason) = push_keybind_support.global_push_keybinds_reason {
                errors.push(reason);
            }

            PushKeybindRegistration {
                talk_registered: false,
                mute_registered: false,
                errors: Vec::new(),
                watcher: None,
            }
        }
    };

    errors.append(&mut registration.errors);
    registration.errors = errors;
    registration
}

fn register_push_keybinds_via_x11(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<LinuxPushKeybind>,
    mute_keybind: Option<LinuxPushKeybind>,
) -> PushKeybindRegistration {
    let mut errors = Vec::new();
    let mut resolved_talk: Option<(LinuxPushKeybind, u8)> = None;
    let mut resolved_mute: Option<(LinuxPushKeybind, u8)> = None;
    let mut watcher = None;

    match open_x11_and_resolve_keycodes(talk_keybind.as_ref(), mute_keybind.as_ref()) {
        Err(error) => errors.push(error),
        Ok((talk_kc, mute_kc)) => {
            if talk_keybind.is_some() && talk_kc.is_none() {
                errors.push("Push-to-talk key has no mapping on this keyboard layout.".to_string());
            }
            if mute_keybind.is_some() && mute_kc.is_none() {
                errors.push("Push-to-mute key has no mapping on this keyboard layout.".to_string());
            }

            resolved_talk = talk_keybind.zip(talk_kc);
            resolved_mute = mute_keybind.zip(mute_kc);

            if resolved_talk.is_some() || resolved_mute.is_some() {
                let talk_registered = resolved_talk.is_some();
                let mute_registered = resolved_mute.is_some();
                watcher = Some(start_push_keybind_watcher(
                    frame_queue,
                    resolved_talk.clone(),
                    resolved_mute.clone(),
                ));

                return PushKeybindRegistration {
                    talk_registered,
                    mute_registered,
                    errors,
                    watcher,
                };
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
    pulse::probe_audio_backend()
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

fn probe_linux_push_keybind_support(
    session_type: &str,
    portal_available: bool,
    portal_reason: Option<&str>,
) -> LinuxPushKeybindSupportProbe {
    let (x11_display_available, x11_display_reason) = probe_x11_display();
    let portal_probe = if session_type == "wayland" {
        Some(probe_wayland_global_shortcuts_portal())
    } else {
        None
    };

    if session_type == "wayland"
        && portal_available
        && portal_probe.as_ref().is_some_and(|probe| probe.configured)
    {
        return LinuxPushKeybindSupportProbe {
            backend: LinuxPushKeybindBackend::Portal,
            global_push_keybinds: "supported",
            global_push_keybinds_reason: None,
            global_push_keybinds_reason_code: None,
            x11_display_available,
            x11_display_reason,
            portal_backend_configured: true,
            portal_backend: portal_probe.as_ref().and_then(|probe| probe.backend.clone()),
            portal_backend_reason: portal_probe.as_ref().and_then(|probe| probe.reason.clone()),
        };
    }

    if x11_display_available {
        let (reason, reason_code) = if session_type == "wayland" {
            (
                Some(
                    "Global push keybinds use XWayland in Wayland sessions and may not work in every compositor."
                        .to_string(),
                ),
                Some("linux-xwayland-best-effort"),
            )
        } else {
            (None, None)
        };

        return LinuxPushKeybindSupportProbe {
            backend: LinuxPushKeybindBackend::X11,
            global_push_keybinds: if session_type == "wayland" {
                "best-effort"
            } else {
                "supported"
            },
            global_push_keybinds_reason: reason,
            global_push_keybinds_reason_code: reason_code,
            x11_display_available,
            x11_display_reason,
            portal_backend_configured: portal_probe
                .as_ref()
                .is_some_and(|probe| probe.configured),
            portal_backend: portal_probe.as_ref().and_then(|probe| probe.backend.clone()),
            portal_backend_reason: portal_probe.as_ref().and_then(|probe| probe.reason.clone()),
        };
    }

    if session_type != "wayland" {
        return LinuxPushKeybindSupportProbe {
            backend: LinuxPushKeybindBackend::Unsupported,
            global_push_keybinds: "unsupported",
            global_push_keybinds_reason: x11_display_reason.clone(),
            global_push_keybinds_reason_code: Some("linux-x11-display-required"),
            x11_display_available,
            x11_display_reason,
            portal_backend_configured: false,
            portal_backend: None,
            portal_backend_reason: None,
        };
    }

    let portal_probe = portal_probe.unwrap_or(LinuxGlobalShortcutsPortalProbe {
        configured: false,
        backend: None,
        reason: None,
    });

    let (reason, reason_code) = if portal_probe.configured {
        let backend_name = portal_probe
            .backend
            .as_deref()
            .unwrap_or("the current desktop");

        if portal_available {
            (
                Some(format!(
                    "This Wayland session advertises the Global Shortcuts portal backend `{backend_name}`, but Sharkord still relies on X11/XWayland polling for global push keybinds."
                )),
                Some("linux-wayland-global-shortcuts-portal-available"),
            )
        } else {
            (
                Some(format!(
                    "This Wayland session advertises the Global Shortcuts portal backend `{backend_name}`, but xdg-desktop-portal is unavailable for the current session. {}",
                    portal_reason.unwrap_or("Start the portal service and retry.")
                )),
                Some("linux-wayland-global-shortcuts-portal-required"),
            )
        }
    } else {
        let portal_probe_reason = portal_probe
            .reason
            .as_deref()
            .unwrap_or("No Wayland Global Shortcuts portal backend was detected.");
        (
            Some(format!(
                "This Wayland session has no usable X11/XWayland display, and no Global Shortcuts portal backend was detected. {portal_probe_reason}"
            )),
            Some("linux-wayland-global-shortcuts-unavailable"),
        )
    };

    LinuxPushKeybindSupportProbe {
        backend: LinuxPushKeybindBackend::Unsupported,
        global_push_keybinds: "unsupported",
        global_push_keybinds_reason: reason,
        global_push_keybinds_reason_code: reason_code,
        x11_display_available,
        x11_display_reason,
        portal_backend_configured: portal_probe.configured,
        portal_backend: portal_probe.backend,
        portal_backend_reason: portal_probe.reason,
    }
}

fn probe_desktop_portal() -> (bool, Option<String>) {
    let connection = match zbus::blocking::Connection::session() {
        Ok(connection) => connection,
        Err(_) => {
            return (
                false,
                Some(
                    "No D-Bus session bus was detected. Wayland screen sharing requires xdg-desktop-portal."
                        .to_string(),
                ),
            )
        }
    };
    let dbus_proxy = match zbus::blocking::fdo::DBusProxy::new(&connection) {
        Ok(proxy) => proxy,
        Err(error) => {
            return (
                false,
                Some(format!(
                    "The current D-Bus session bus is unavailable for desktop portal checks: {error}"
                )),
            )
        }
    };

    let portal_service_name =
        zbus::names::BusName::try_from("org.freedesktop.portal.Desktop").expect("valid bus name");

    match dbus_proxy.name_has_owner(portal_service_name) {
        Ok(true) => (true, None),
        Ok(false) => (
            false,
            Some(
                "org.freedesktop.portal.Desktop is not available on the current session bus. Wayland screen sharing requires xdg-desktop-portal."
                    .to_string(),
            ),
        ),
        Err(error) => (
            false,
            Some(format!(
                "Could not query desktop portal availability on the current session bus: {error}"
            )),
        ),
    }
}

pub(crate) fn capabilities() -> Value {
    let audio_backend = probe_audio_backend();
    let session_type = detect_session_type();
    let (portal_available, portal_reason) = probe_desktop_portal();
    let push_keybind_support = probe_linux_push_keybind_support(
        &session_type,
        portal_available,
        portal_reason.as_deref(),
    );
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
        "globalPushKeybinds": push_keybind_support.global_push_keybinds,
        "x11DisplayAvailable": push_keybind_support.x11_display_available,
        "linuxGlobalShortcutsPortalConfigured": push_keybind_support.portal_backend_configured,
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

    if let Some(reason) = push_keybind_support.global_push_keybinds_reason {
        response["globalPushKeybindsReason"] = json!(reason);
        if let Some(reason_code) = push_keybind_support.global_push_keybinds_reason_code {
            response["globalPushKeybindsReasonCode"] = json!(reason_code);
        }
    }

    if let Some(reason) = push_keybind_support.x11_display_reason {
        response["x11DisplayReason"] = json!(reason);
        response["x11DisplayReasonCode"] = json!("linux-x11-display-required");
    }

    if let Some(portal_backend) = push_keybind_support.portal_backend {
        response["linuxGlobalShortcutsPortalBackend"] = json!(portal_backend);
    }

    if let Some(portal_backend_reason) = push_keybind_support.portal_backend_reason {
        response["linuxGlobalShortcutsPortalReason"] = json!(portal_backend_reason);
    }

    response
}

pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    match pulse::list_audio_targets() {
        Ok(targets) => targets,
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
    pulse::capture_loopback_audio(
        session_id,
        _target_id,
        target_pid,
        stop_flag,
        frame_queue,
        app_audio_binary_stream,
    )
}
