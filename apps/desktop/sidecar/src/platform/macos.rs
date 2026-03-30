use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::{
    io::{self, Read},
    net::TcpStream,
    process::{Command, Stdio},
};

use crate::{
    enqueue_frame_event, enqueue_push_keybind_state_event, AudioTarget, AudioTargetListResponse,
    CaptureEndReason, CaptureOutcome, FrameQueue, PushKeybindKind, PushKeybindWatcher,
    ResolveSourceResult, APP_AUDIO_CHANNELS, APP_AUDIO_SAMPLE_RATE,
    MAX_APP_AUDIO_BINARY_FRAME_BYTES, PROTOCOL_VERSION,
};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

use super::PushKeybindRegistration;

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceKeyState(state_id: i32, keycode: u16) -> bool;
}

const CG_HID_SYSTEM_STATE: i32 = 1;

const VK_MAC_SHIFT_LEFT: u16 = 0x38;
const VK_MAC_SHIFT_RIGHT: u16 = 0x3C;
const VK_MAC_CONTROL_LEFT: u16 = 0x3B;
const VK_MAC_CONTROL_RIGHT: u16 = 0x3E;
const VK_MAC_OPTION_LEFT: u16 = 0x3A;
const VK_MAC_OPTION_RIGHT: u16 = 0x3D;
const VK_MAC_COMMAND_LEFT: u16 = 0x37;
const VK_MAC_COMMAND_RIGHT: u16 = 0x36;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct MacosPushKeybind {
    key_code: u16,
    ctrl: bool,
    alt: bool,
    shift: bool,
    meta: bool,
}

fn map_key_code_to_cg_keycode(key_code: &str) -> Option<u16> {
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let ch = key_code.chars().nth(3)?;
        return match ch {
            'A' => Some(0x00),
            'S' => Some(0x01),
            'D' => Some(0x02),
            'F' => Some(0x03),
            'H' => Some(0x04),
            'G' => Some(0x05),
            'Z' => Some(0x06),
            'X' => Some(0x07),
            'C' => Some(0x08),
            'V' => Some(0x09),
            'B' => Some(0x0B),
            'Q' => Some(0x0C),
            'W' => Some(0x0D),
            'E' => Some(0x0E),
            'R' => Some(0x0F),
            'Y' => Some(0x10),
            'T' => Some(0x11),
            'O' => Some(0x1F),
            'U' => Some(0x20),
            'I' => Some(0x22),
            'P' => Some(0x23),
            'L' => Some(0x25),
            'J' => Some(0x26),
            'K' => Some(0x28),
            'N' => Some(0x2D),
            'M' => Some(0x2E),
            _ => None,
        };
    }

    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let ch = key_code.chars().nth(5)?;
        return match ch {
            '1' => Some(0x12),
            '2' => Some(0x13),
            '3' => Some(0x14),
            '4' => Some(0x15),
            '5' => Some(0x17),
            '6' => Some(0x16),
            '7' => Some(0x1A),
            '8' => Some(0x1C),
            '9' => Some(0x19),
            '0' => Some(0x1D),
            _ => None,
        };
    }

    if let Some(num_str) = key_code.strip_prefix('F') {
        if let Ok(n) = num_str.parse::<u16>() {
            return match n {
                1 => Some(0x7A),
                2 => Some(0x78),
                3 => Some(0x63),
                4 => Some(0x76),
                5 => Some(0x60),
                6 => Some(0x61),
                7 => Some(0x62),
                8 => Some(0x64),
                9 => Some(0x65),
                10 => Some(0x6D),
                11 => Some(0x67),
                12 => Some(0x6F),
                13 => Some(0x69),
                14 => Some(0x6B),
                15 => Some(0x71),
                16 => Some(0x6A),
                17 => Some(0x40),
                18 => Some(0x4F),
                19 => Some(0x50),
                20 => Some(0x5A),
                _ => None,
            };
        }
    }

    if let Some(num_str) = key_code.strip_prefix("Numpad") {
        if num_str.len() == 1 {
            let ch = num_str.chars().next()?;
            return match ch {
                '0' => Some(0x52),
                '1' => Some(0x53),
                '2' => Some(0x54),
                '3' => Some(0x55),
                '4' => Some(0x56),
                '5' => Some(0x57),
                '6' => Some(0x58),
                '7' => Some(0x59),
                '8' => Some(0x5B),
                '9' => Some(0x5C),
                _ => None,
            };
        }
    }

    match key_code {
        "Space" => Some(0x31),
        "Enter" => Some(0x24),
        "Escape" => Some(0x35),
        "Backspace" => Some(0x33),
        "Tab" => Some(0x30),
        "CapsLock" => Some(0x39),
        "ArrowLeft" => Some(0x7B),
        "ArrowRight" => Some(0x7C),
        "ArrowDown" => Some(0x7D),
        "ArrowUp" => Some(0x7E),
        "Delete" => Some(0x75),
        "Home" => Some(0x73),
        "End" => Some(0x77),
        "PageUp" => Some(0x74),
        "PageDown" => Some(0x79),
        "Minus" => Some(0x1B),
        "Equal" => Some(0x18),
        "BracketLeft" => Some(0x21),
        "BracketRight" => Some(0x1E),
        "Backslash" => Some(0x2A),
        "Semicolon" => Some(0x29),
        "Quote" => Some(0x27),
        "Comma" => Some(0x2B),
        "Period" => Some(0x2F),
        "Slash" => Some(0x2C),
        "Backquote" => Some(0x32),
        "NumpadMultiply" => Some(0x43),
        "NumpadAdd" => Some(0x45),
        "NumpadSubtract" => Some(0x4E),
        "NumpadDecimal" => Some(0x41),
        "NumpadDivide" => Some(0x4B),
        "NumpadEnter" => Some(0x4C),
        _ => None,
    }
}

fn parse_push_keybind(keybind: Option<&str>) -> Result<Option<MacosPushKeybind>, String> {
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
            "Alt" | "Option" => {
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
    let key_code = map_key_code_to_cg_keycode(key_code_name)
        .ok_or_else(|| "Unsupported key for global keybind monitoring.".to_string())?;

    Ok(Some(MacosPushKeybind {
        key_code,
        ctrl,
        alt,
        shift,
        meta,
    }))
}

fn is_cg_key_down(keycode: u16) -> bool {
    unsafe { CGEventSourceKeyState(CG_HID_SYSTEM_STATE, keycode) }
}

fn current_modifiers_match(keybind: &MacosPushKeybind) -> bool {
    let ctrl = is_cg_key_down(VK_MAC_CONTROL_LEFT) || is_cg_key_down(VK_MAC_CONTROL_RIGHT);
    let alt = is_cg_key_down(VK_MAC_OPTION_LEFT) || is_cg_key_down(VK_MAC_OPTION_RIGHT);
    let shift = is_cg_key_down(VK_MAC_SHIFT_LEFT) || is_cg_key_down(VK_MAC_SHIFT_RIGHT);
    let meta = is_cg_key_down(VK_MAC_COMMAND_LEFT) || is_cg_key_down(VK_MAC_COMMAND_RIGHT);

    ctrl == keybind.ctrl && alt == keybind.alt && shift == keybind.shift && meta == keybind.meta
}

fn is_push_keybind_active(keybind: &MacosPushKeybind) -> bool {
    is_cg_key_down(keybind.key_code) && current_modifiers_match(keybind)
}

fn start_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    talk_keybind: Option<MacosPushKeybind>,
    mute_keybind: Option<MacosPushKeybind>,
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

pub(crate) fn list_audio_targets() -> Vec<AudioTarget> {
    match crate::run_macos_helper_command(&["list-targets"]).and_then(|output| {
        serde_json::from_slice::<AudioTargetListResponse>(&output)
            .map_err(|error| error.to_string())
    }) {
        Ok(response) => response.targets,
        Err(error) => {
            eprintln!("[capture-sidecar] {error}");
            Vec::new()
        }
    }
}

pub(crate) fn resolve_source_to_pid(source_id: &str) -> Option<u32> {
    let output =
        crate::run_macos_helper_command(&["resolve-source", "--source-id", source_id]).ok()?;
    let response = serde_json::from_slice::<ResolveSourceResult>(&output).ok()?;
    response.pid
}

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
    let helper_path = match crate::resolve_macos_helper_path() {
        Ok(helper_path) => helper_path,
        Err(error) => return CaptureOutcome::capture_error(error),
    };

    let mut capture_command = Command::new(helper_path);
    capture_command.arg("capture");
    if let Some(source_id) = source_id {
        capture_command.arg("--source-id").arg(source_id);
    }

    if let Some(exclude_pid) = self_exclude_pid {
        capture_command
            .arg("--exclude-pid")
            .arg(exclude_pid.to_string());
    } else {
        capture_command
            .arg("--target-pid")
            .arg(target_pid.to_string());
    }

    let mut child = match capture_command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(error) => {
            return CaptureOutcome::capture_error(format!(
                "Failed to launch macOS audio helper: {error}"
            ))
        }
    };

    let Some(stdout_pipe) = child.stdout.take() else {
        let _ = child.kill();
        let _ = child.wait();
        return CaptureOutcome::capture_error(
            "macOS audio helper did not expose stdout.".to_string(),
        );
    };

    let stderr_slot = Arc::new(Mutex::new(String::new()));
    let stderr_slot_for_thread = Arc::clone(&stderr_slot);
    let stderr_thread = child.stderr.take().map(|stderr_pipe| {
        thread::spawn(move || {
            let mut stderr_reader = io::BufReader::new(stderr_pipe);
            let mut stderr_output = String::new();
            let _ = stderr_reader.read_to_string(&mut stderr_output);
            if let Ok(mut stderr_lock) = stderr_slot_for_thread.lock() {
                *stderr_lock = stderr_output;
            }
        })
    });

    let (frame_sender, frame_receiver) = mpsc::channel::<Result<Vec<f32>, String>>();
    let stdout_thread = thread::spawn(move || {
        let mut stdout_reader = io::BufReader::new(stdout_pipe);

        loop {
            let mut packet_length_bytes = [0u8; 4];
            match stdout_reader.read_exact(&mut packet_length_bytes) {
                Ok(()) => {}
                Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => break,
                Err(error) => {
                    let _ = frame_sender.send(Err(format!(
                        "Failed reading macOS audio packet header: {error}"
                    )));
                    return;
                }
            }

            let packet_length = u32::from_le_bytes(packet_length_bytes) as usize;
            if packet_length == 0
                || packet_length > MAX_APP_AUDIO_BINARY_FRAME_BYTES
                || packet_length % std::mem::size_of::<f32>() != 0
            {
                let _ = frame_sender.send(Err(
                    "Received malformed packet from macOS audio helper.".to_string(),
                ));
                return;
            }

            let mut payload = vec![0u8; packet_length];
            if let Err(error) = stdout_reader.read_exact(&mut payload) {
                let _ = frame_sender.send(Err(format!(
                    "Failed reading macOS audio packet payload: {error}"
                )));
                return;
            }

            let mut frame_samples = Vec::with_capacity(packet_length / std::mem::size_of::<f32>());
            for sample_bytes in payload.chunks_exact(std::mem::size_of::<f32>()) {
                frame_samples.push(f32::from_le_bytes([
                    sample_bytes[0],
                    sample_bytes[1],
                    sample_bytes[2],
                    sample_bytes[3],
                ]));
            }

            if frame_sender.send(Ok(frame_samples)).is_err() {
                return;
            }
        }
    });

    let mut sequence: u64 = 0;

    loop {
        if stop_flag.load(Ordering::Relaxed) {
            let _ = child.kill();
            let _ = child.wait();
            let _ = stdout_thread.join();
            if let Some(stderr_thread) = stderr_thread {
                let _ = stderr_thread.join();
            }
            return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
        }

        match frame_receiver.recv_timeout(Duration::from_millis(50)) {
            Ok(Ok(frame_samples)) => {
                let frame_count = frame_samples.len() / APP_AUDIO_CHANNELS;
                if frame_count == 0 || frame_count * APP_AUDIO_CHANNELS != frame_samples.len() {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(
                        "Received malformed PCM frame from macOS audio helper.".to_string(),
                    );
                }

                let wrote_binary = app_audio_binary_stream
                    .as_ref()
                    .map(|stream_slot| {
                        crate::try_write_app_audio_binary_frame(
                            stream_slot,
                            session_id,
                            target_id,
                            sequence,
                            APP_AUDIO_SAMPLE_RATE as usize,
                            APP_AUDIO_CHANNELS,
                            frame_count,
                            PROTOCOL_VERSION,
                            0,
                            &frame_samples,
                        )
                    })
                    .unwrap_or(false);

                if !wrote_binary {
                    let frame_bytes = bytemuck::cast_slice(&frame_samples);
                    let pcm_base64 = BASE64.encode(frame_bytes);

                    enqueue_frame_event(
                        &frame_queue,
                        session_id,
                        target_id,
                        sequence,
                        APP_AUDIO_SAMPLE_RATE as usize,
                        frame_count,
                        pcm_base64,
                    );
                }

                sequence = sequence.saturating_add(1);
            }
            Ok(Err(error)) => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_thread.join();
                if let Some(stderr_thread) = stderr_thread {
                    let _ = stderr_thread.join();
                }
                return CaptureOutcome::capture_error(error);
            }
            Err(RecvTimeoutError::Timeout) => match child.try_wait() {
                Ok(Some(status)) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }

                    if stop_flag.load(Ordering::Relaxed) {
                        return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
                    }

                    let stderr_output = stderr_slot
                        .lock()
                        .ok()
                        .map(|stderr_lock| stderr_lock.trim().to_string())
                        .filter(|stderr_output| !stderr_output.is_empty());
                    let error_message = stderr_output.unwrap_or_else(|| {
                        format!("macOS audio helper exited unexpectedly (status={status}).")
                    });

                    return CaptureOutcome::capture_error(error_message);
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = child.kill();
                    let _ = child.wait();
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(format!(
                        "Failed waiting on macOS audio helper: {error}"
                    ));
                }
            },
            Err(RecvTimeoutError::Disconnected) => match child.wait() {
                Ok(status) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }

                    if stop_flag.load(Ordering::Relaxed) {
                        return CaptureOutcome::from_reason(CaptureEndReason::CaptureStopped);
                    }

                    let stderr_output = stderr_slot
                        .lock()
                        .ok()
                        .map(|stderr_lock| stderr_lock.trim().to_string())
                        .filter(|stderr_output| !stderr_output.is_empty());
                    let error_message = stderr_output.unwrap_or_else(|| {
                        format!("macOS audio helper exited unexpectedly (status={status}).")
                    });

                    return CaptureOutcome::capture_error(error_message);
                }
                Err(error) => {
                    let _ = stdout_thread.join();
                    if let Some(stderr_thread) = stderr_thread {
                        let _ = stderr_thread.join();
                    }
                    return CaptureOutcome::capture_error(format!(
                        "Failed waiting on macOS audio helper: {error}"
                    ));
                }
            },
        }
    }
}
