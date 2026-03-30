use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use std::{ffi::c_void, path::Path};

use windows::core::PWSTR;
use windows::Win32::Foundation::{BOOL, HWND, LPARAM};
use windows::Win32::System::Threading::{
    OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32,
    PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
};
use windows::Win32::UI::Input::KeyboardAndMouse::GetAsyncKeyState;
use windows::Win32::UI::WindowsAndMessaging::{
    EnumWindows, GetWindow, GetWindowLongW, GetWindowTextLengthW, GetWindowTextW,
    GetWindowThreadProcessId, IsWindow, IsWindowVisible, GWL_EXSTYLE, GW_OWNER, WS_EX_TOOLWINDOW,
};

use crate::{
    enqueue_push_keybind_state_event, AudioTarget, FrameQueue, PushKeybindKind,
    PushKeybindWatcher,
};

use super::PushKeybindRegistration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct WindowsPushKeybind {
    key_code: i32,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

const VK_LSHIFT: i32 = 0xA0;
const VK_RSHIFT: i32 = 0xA1;
const VK_LCONTROL: i32 = 0xA2;
const VK_RCONTROL: i32 = 0xA3;
const VK_LMENU: i32 = 0xA4;
const VK_RMENU: i32 = 0xA5;
const VK_LWIN: i32 = 0x5B;
const VK_RWIN: i32 = 0x5C;

fn map_key_code_to_virtual_key(key_code: &str) -> Option<i32> {
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let key = key_code.chars().nth(3)?;
        if key.is_ascii_alphabetic() {
            return Some(key.to_ascii_uppercase() as i32);
        }
    }

    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let key = key_code.chars().nth(5)?;
        if key.is_ascii_digit() {
            return Some(key as i32);
        }
    }

    if let Some(function_key) = key_code.strip_prefix('F') {
        if let Ok(function_number) = function_key.parse::<i32>() {
            if (1..=24).contains(&function_number) {
                return Some(0x6F + function_number);
            }
        }
    }

    if let Some(numpad_key) = key_code.strip_prefix("Numpad") {
        if numpad_key.len() == 1 {
            let key = numpad_key.chars().next()?;
            if key.is_ascii_digit() {
                return Some(0x60 + (key as i32 - '0' as i32));
            }
        }
    }

    match key_code {
        "Space" => Some(0x20),
        "Enter" => Some(0x0D),
        "Escape" => Some(0x1B),
        "Backspace" => Some(0x08),
        "Tab" => Some(0x09),
        "CapsLock" => Some(0x14),
        "NumLock" => Some(0x90),
        "ScrollLock" => Some(0x91),
        "ArrowUp" => Some(0x26),
        "ArrowDown" => Some(0x28),
        "ArrowLeft" => Some(0x25),
        "ArrowRight" => Some(0x27),
        "Delete" => Some(0x2E),
        "Insert" => Some(0x2D),
        "Home" => Some(0x24),
        "End" => Some(0x23),
        "PageUp" => Some(0x21),
        "PageDown" => Some(0x22),
        "Minus" => Some(0xBD),
        "Equal" => Some(0xBB),
        "BracketLeft" => Some(0xDB),
        "BracketRight" => Some(0xDD),
        "Backslash" => Some(0xDC),
        "Semicolon" => Some(0xBA),
        "Quote" => Some(0xDE),
        "Comma" => Some(0xBC),
        "Period" => Some(0xBE),
        "Slash" => Some(0xBF),
        "Backquote" => Some(0xC0),
        "NumpadMultiply" => Some(0x6A),
        "NumpadAdd" => Some(0x6B),
        "NumpadSubtract" => Some(0x6D),
        "NumpadDecimal" => Some(0x6E),
        "NumpadDivide" => Some(0x6F),
        "NumpadEnter" => Some(0x0D),
        _ => None,
    }
}

fn parse_push_keybind(keybind: Option<&str>) -> Result<Option<WindowsPushKeybind>, String> {
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
            "Meta" | "Command" => {
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
    let key_code = map_key_code_to_virtual_key(key_code_name)
        .ok_or_else(|| "Unsupported key for global keybind monitoring.".to_string())?;

    Ok(Some(WindowsPushKeybind {
        key_code,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

fn is_virtual_key_down(key_code: i32) -> bool {
    (unsafe { GetAsyncKeyState(key_code) } as u16 & 0x8000) != 0
}

fn current_modifiers_match(keybind: &WindowsPushKeybind) -> bool {
    let ctrl = is_virtual_key_down(VK_LCONTROL) || is_virtual_key_down(VK_RCONTROL);
    let alt = is_virtual_key_down(VK_LMENU) || is_virtual_key_down(VK_RMENU);
    let shift = is_virtual_key_down(VK_LSHIFT) || is_virtual_key_down(VK_RSHIFT);
    let meta = is_virtual_key_down(VK_LWIN) || is_virtual_key_down(VK_RWIN);

    ctrl == keybind.ctrl && alt == keybind.alt && shift == keybind.shift && meta == keybind.meta
}

fn is_push_keybind_active(keybind: &WindowsPushKeybind) -> bool {
    is_virtual_key_down(keybind.key_code) && current_modifiers_match(keybind)
}

fn start_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<WindowsPushKeybind>,
    mute_keybind: Option<WindowsPushKeybind>,
) -> PushKeybindWatcher {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let handle = thread::spawn(move || {
        let mut talk_active = false;
        let mut mute_active = false;

        while !thread_stop_flag.load(Ordering::Relaxed) {
            let next_talk_active = talk_keybind.as_ref().is_some_and(is_push_keybind_active);
            let next_mute_active = mute_keybind.as_ref().is_some_and(is_push_keybind_active);

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

    let watcher = if talk_keybind.is_some() || mute_keybind.is_some() {
        Some(start_push_keybind_watcher(
            frame_queue,
            talk_keybind,
            mute_keybind,
        ))
    } else {
        None
    };

    PushKeybindRegistration {
        talk_registered: talk_keybind.is_some(),
        mute_registered: mute_keybind.is_some(),
        errors,
        watcher,
    }
}

fn window_title(hwnd: HWND) -> Option<String> {
    let length = unsafe { GetWindowTextLengthW(hwnd) };

    if length <= 0 {
        return None;
    }

    let mut buf = vec![0u16; (length + 1) as usize];
    let read = unsafe { GetWindowTextW(hwnd, &mut buf) };

    if read <= 0 {
        return None;
    }

    Some(String::from_utf16_lossy(&buf[..read as usize]))
}

fn is_user_visible_window(hwnd: HWND) -> bool {
    if !unsafe { IsWindowVisible(hwnd).as_bool() } {
        return false;
    }

    if unsafe { GetWindow(hwnd, GW_OWNER) }
        .ok()
        .is_some_and(|owner| !owner.is_invalid())
    {
        return false;
    }

    let ex_style = unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) };
    let tool_window = (ex_style & WS_EX_TOOLWINDOW.0 as i32) != 0;

    !tool_window
}

fn process_name_from_pid(pid: u32) -> Option<String> {
    let process = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .ok()?;

    let mut buffer = vec![0u16; 4096];
    let mut size = buffer.len() as u32;

    let success = unsafe {
        QueryFullProcessImageNameW(
            process,
            PROCESS_NAME_WIN32,
            PWSTR(buffer.as_mut_ptr()),
            &mut size,
        )
        .is_ok()
    };

    let _ = unsafe { windows::Win32::Foundation::CloseHandle(process) };

    if !success {
        return None;
    }

    let full_path = String::from_utf16_lossy(&buffer[..size as usize]);
    let file_name = Path::new(&full_path)
        .file_name()
        .and_then(|value| value.to_str())
        .map(|value| value.to_string())
        .unwrap_or(full_path);

    Some(file_name)
}

unsafe extern "system" fn enum_windows_callback(hwnd: HWND, lparam: LPARAM) -> BOOL {
    if !is_user_visible_window(hwnd) {
        return BOOL(1);
    }

    let title = match window_title(hwnd) {
        Some(value) if !value.trim().is_empty() => value,
        _ => return BOOL(1),
    };

    let mut pid = 0u32;
    let _thread_id = GetWindowThreadProcessId(hwnd, Some(&mut pid));

    if pid == 0 {
        return BOOL(1);
    }

    let entries_ptr = lparam.0 as *mut Vec<(u32, String)>;
    if !entries_ptr.is_null() {
        (*entries_ptr).push((pid, title));
    }

    BOOL(1)
}

pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    let mut entries: Vec<(u32, String)> = Vec::new();

    let _ = unsafe {
        EnumWindows(
            Some(enum_windows_callback),
            LPARAM((&mut entries as *mut Vec<(u32, String)>) as isize),
        )
    };

    let deduped = crate::dedupe_window_entries_by_pid(entries);
    let mut targets = Vec::new();

    for (pid, title) in deduped {
        let process_name = process_name_from_pid(pid).unwrap_or_else(|| "unknown.exe".to_string());
        let label = format!("{} - {} ({})", title.trim(), process_name, pid);

        targets.push(AudioTarget {
            id: format!("pid:{pid}"),
            label,
            pid,
            process_name,
        });
    }

    targets.sort_by(|left, right| left.label.cmp(&right.label));
    targets
}

pub(crate) fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    let hwnd_value = crate::parse_window_source_id(source_id)?;
    let hwnd = HWND(hwnd_value as *mut c_void);

    if !unsafe { IsWindow(hwnd).as_bool() } {
        return None;
    }

    let mut pid = 0u32;
    unsafe {
        let _ = GetWindowThreadProcessId(hwnd, Some(&mut pid));
    }

    if pid == 0 {
        return None;
    }

    Some(pid)
}
