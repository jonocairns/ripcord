use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use uuid::Uuid;
use zbus::blocking::{Connection, Proxy};
use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

use crate::{
    enqueue_push_keybind_state_event, FrameQueue, PushKeybindKind, PushKeybindWatcher,
};

use super::super::PushKeybindRegistration;
use super::LinuxPushKeybind;

const PORTAL_SERVICE_NAME: &str = "org.freedesktop.portal.Desktop";
const PORTAL_OBJECT_PATH: &str = "/org/freedesktop/portal/desktop";
const GLOBAL_SHORTCUTS_INTERFACE: &str = "org.freedesktop.portal.GlobalShortcuts";
const REQUEST_INTERFACE: &str = "org.freedesktop.portal.Request";
const SESSION_INTERFACE: &str = "org.freedesktop.portal.Session";
const REQUEST_RESPONSE_SUCCESS: u32 = 0;
const REQUEST_RESPONSE_CANCELLED: u32 = 1;
const REQUEST_RESPONSE_FAILED: u32 = 2;

#[derive(Debug, Clone)]
struct PortalShortcutBinding {
    id: String,
    description: String,
    preferred_trigger: String,
    kind: PushKeybindKind,
}

enum PortalWatcherEvent {
    State {
        kind: PushKeybindKind,
        active: bool,
    },
    SessionClosed,
}

pub(super) fn register_push_keybinds_via_portal(
    frame_queue: Arc<FrameQueue>,
    push_to_talk_keybind: Option<&LinuxPushKeybind>,
    push_to_mute_keybind: Option<&LinuxPushKeybind>,
) -> PushKeybindRegistration {
    let mut errors = Vec::new();
    let mut shortcut_bindings = Vec::new();

    if let Some(keybind) = push_to_talk_keybind {
        match build_shortcut_binding(keybind, PushKeybindKind::Talk) {
            Ok(binding) => shortcut_bindings.push(binding),
            Err(error) => errors.push(format!("Push-to-talk keybind is invalid: {error}")),
        }
    }

    if let Some(keybind) = push_to_mute_keybind {
        match build_shortcut_binding(keybind, PushKeybindKind::Mute) {
            Ok(binding) => shortcut_bindings.push(binding),
            Err(error) => errors.push(format!("Push-to-mute keybind is invalid: {error}")),
        }
    }

    if shortcut_bindings.is_empty() {
        return PushKeybindRegistration {
            talk_registered: false,
            mute_registered: false,
            errors,
            watcher: None,
        };
    }

    let connection = match Connection::session() {
        Ok(connection) => connection,
        Err(error) => {
            errors.push(format!(
                "Could not connect to the D-Bus session bus for Wayland global shortcuts: {error}"
            ));
            return PushKeybindRegistration {
                talk_registered: false,
                mute_registered: false,
                errors,
                watcher: None,
            };
        }
    };

    let session_handle = match create_global_shortcuts_session(&connection) {
        Ok(session_handle) => session_handle,
        Err(error) => {
            errors.push(error);
            return PushKeybindRegistration {
                talk_registered: false,
                mute_registered: false,
                errors,
                watcher: None,
            };
        }
    };

    if let Err(error) = bind_shortcuts(&connection, &session_handle, &shortcut_bindings) {
        let _ = close_session(&connection, &session_handle);
        errors.push(error);
        return PushKeybindRegistration {
            talk_registered: false,
            mute_registered: false,
            errors,
            watcher: None,
        };
    }

    let watcher = match start_portal_push_keybind_watcher(
        frame_queue,
        session_handle.clone(),
        shortcut_bindings.clone(),
    ) {
        Ok(watcher) => watcher,
        Err(error) => {
            let _ = close_session(&connection, &session_handle);
            errors.push(error);
            return PushKeybindRegistration {
                talk_registered: false,
                mute_registered: false,
                errors,
                watcher: None,
            };
        }
    };

    PushKeybindRegistration {
        talk_registered: shortcut_bindings
            .iter()
            .any(|binding| binding.kind == PushKeybindKind::Talk),
        mute_registered: shortcut_bindings
            .iter()
            .any(|binding| binding.kind == PushKeybindKind::Mute),
        errors,
        watcher: Some(watcher),
    }
}

fn build_shortcut_binding(
    keybind: &LinuxPushKeybind,
    kind: PushKeybindKind,
) -> Result<PortalShortcutBinding, String> {
    let id = match kind {
        PushKeybindKind::Talk => "push-to-talk",
        PushKeybindKind::Mute => "push-to-mute",
    };
    let description = match kind {
        PushKeybindKind::Talk => "Push to Talk",
        PushKeybindKind::Mute => "Push to Mute",
    };

    Ok(PortalShortcutBinding {
        id: id.to_string(),
        description: description.to_string(),
        preferred_trigger: preferred_trigger_for_keybind(keybind)?,
        kind,
    })
}

fn create_global_shortcuts_session(connection: &Connection) -> Result<OwnedObjectPath, String> {
    let unique_name = connection
        .unique_name()
        .map(|name| name.to_string())
        .ok_or_else(|| "The D-Bus session bus did not provide a unique name.".to_string())?;
    let handle_token = format!("sharkord-request-{}", Uuid::new_v4().simple());
    let session_token = format!("sharkord-session-{}", Uuid::new_v4().simple());
    let request_path = request_handle_path(&unique_name, &handle_token)?;
    let request_proxy = portal_proxy(connection, request_path.as_str(), REQUEST_INTERFACE)?;
    let mut response_stream = request_proxy
        .receive_signal("Response")
        .map_err(|error| format!("Could not subscribe to the portal session response: {error}"))?;

    let portal_proxy = portal_proxy(connection, PORTAL_OBJECT_PATH, GLOBAL_SHORTCUTS_INTERFACE)?;
    let mut options = HashMap::new();
    options.insert("handle_token", Value::from(handle_token.as_str()));
    options.insert(
        "session_handle_token",
        Value::from(session_token.as_str()),
    );

    let response_handle: OwnedObjectPath = portal_proxy
        .call("CreateSession", &(options))
        .map_err(|error| format!("Could not create a Wayland Global Shortcuts session: {error}"))?;

    if response_handle != request_path {
        return Err(
            "The desktop portal returned an unexpected request handle for the shortcut session."
                .to_string(),
        );
    }

    let (_, results) = next_request_response(&mut response_stream, "create the shortcut session")?;
    let session_value = results
        .get("session_handle")
        .ok_or_else(|| "The desktop portal did not return a shortcut session handle.".to_string())?;

    OwnedObjectPath::try_from(session_value.clone()).map_err(|error| {
        format!("The desktop portal returned an invalid shortcut session handle: {error}")
    })
}

fn bind_shortcuts(
    connection: &Connection,
    session_handle: &OwnedObjectPath,
    shortcut_bindings: &[PortalShortcutBinding],
) -> Result<(), String> {
    let unique_name = connection
        .unique_name()
        .map(|name| name.to_string())
        .ok_or_else(|| "The D-Bus session bus did not provide a unique name.".to_string())?;
    let handle_token = format!("sharkord-bind-{}", Uuid::new_v4().simple());
    let request_path = request_handle_path(&unique_name, &handle_token)?;
    let request_proxy = portal_proxy(connection, request_path.as_str(), REQUEST_INTERFACE)?;
    let mut response_stream = request_proxy
        .receive_signal("Response")
        .map_err(|error| format!("Could not subscribe to the portal bind response: {error}"))?;
    let portal_proxy = portal_proxy(connection, PORTAL_OBJECT_PATH, GLOBAL_SHORTCUTS_INTERFACE)?;
    let mut options = HashMap::new();
    options.insert("handle_token", Value::from(handle_token.as_str()));

    let shortcuts: Vec<(&str, HashMap<&str, Value<'_>>)> = shortcut_bindings
        .iter()
        .map(|binding| {
            let mut shortcut_options = HashMap::new();
            shortcut_options.insert(
                "description",
                Value::from(binding.description.as_str()),
            );
            shortcut_options.insert(
                "preferred_trigger",
                Value::from(binding.preferred_trigger.as_str()),
            );
            (binding.id.as_str(), shortcut_options)
        })
        .collect();

    let response_handle: OwnedObjectPath = portal_proxy
        .call(
            "BindShortcuts",
            &(session_handle.clone(), shortcuts, "", options),
        )
        .map_err(|error| format!("Could not bind Wayland global shortcuts: {error}"))?;

    if response_handle != request_path {
        return Err(
            "The desktop portal returned an unexpected request handle while binding shortcuts."
                .to_string(),
        );
    }

    let (_, results) = next_request_response(&mut response_stream, "bind the requested global shortcuts")?;

    // The portal returns a `shortcuts` dict mapping accepted shortcut IDs to their info.
    // Log when the response omits any requested ID so partial binding failures surface during
    // real-world testing on non-standard compositors (standard GNOME/KDE are all-or-nothing).
    let registered_ids: Vec<String> = results
        .get("shortcuts")
        .and_then(|v| <HashMap<String, HashMap<String, OwnedValue>>>::try_from(v.clone()).ok())
        .map(|map| map.into_keys().collect())
        .unwrap_or_default();

    if !registered_ids.is_empty() {
        for binding in shortcut_bindings {
            if !registered_ids.contains(&binding.id) {
                eprintln!(
                    "[global_shortcuts] portal did not confirm shortcut '{}' ({}); it may not fire",
                    binding.id, binding.description
                );
            }
        }
    }

    Ok(())
}

fn portal_proxy<'a>(connection: &'a Connection, path: &'a str, interface: &'a str) -> Result<Proxy<'a>, String> {
    Proxy::new(connection, PORTAL_SERVICE_NAME, path, interface)
        .map_err(|error| format!("Could not create a desktop portal proxy: {error}"))
}

// Blocks the calling thread until the portal emits a Response signal on `response_stream`.
// The portal Request object is always closed (with a Response) or replaced by an error on the
// D-Bus level, so this only hangs indefinitely if the compositor is buggy or the D-Bus session
// bus has crashed. Callers must ensure the sidecar process is bounded by a higher-level timeout
// (e.g. the desktop manager's registration deadline) if strict liveness is required.
fn next_request_response(
    response_stream: &mut zbus::blocking::proxy::SignalIterator<'_>,
    action: &str,
) -> Result<(u32, HashMap<String, OwnedValue>), String> {
    let Some(message) = response_stream.next() else {
        return Err(format!(
            "The desktop portal closed the request before it could {action}."
        ));
    };
    let (response_code, results): (u32, HashMap<String, OwnedValue>) = message
        .body()
        .deserialize()
        .map_err(|error| format!("Could not decode the desktop portal response: {error}"))?;

    match response_code {
        REQUEST_RESPONSE_SUCCESS => Ok((response_code, results)),
        REQUEST_RESPONSE_CANCELLED => Err(format!(
            "The desktop portal request was cancelled while trying to {action}."
        )),
        REQUEST_RESPONSE_FAILED => Err(format!(
            "The desktop portal failed while trying to {action}. {}",
            request_response_detail(&results)
        )),
        _ => Err(format!(
            "The desktop portal returned response code `{response_code}` while trying to {action}. {}",
            request_response_detail(&results)
        )),
    }
}

fn request_response_detail(results: &HashMap<String, OwnedValue>) -> String {
    results
        .get("message")
        .and_then(|value| String::try_from(value.clone()).ok())
        .map(|message| format!("Portal detail: {message}"))
        .unwrap_or_else(|| "No additional portal detail was provided.".to_string())
}

fn request_handle_path(unique_name: &str, token: &str) -> Result<OwnedObjectPath, String> {
    let sender_name = sanitize_unique_name(unique_name);
    let path = format!("/org/freedesktop/portal/desktop/request/{sender_name}/{token}");

    OwnedObjectPath::try_from(path).map_err(|error| {
        format!("Could not build the expected desktop portal request handle: {error}")
    })
}

fn sanitize_unique_name(unique_name: &str) -> String {
    unique_name
        .trim_start_matches(':')
        .replace('.', "_")
}

fn preferred_trigger_for_keybind(keybind: &LinuxPushKeybind) -> Result<String, String> {
    let mut tokens = Vec::new();

    if keybind.ctrl {
        tokens.push("CTRL".to_string());
    }
    if keybind.alt {
        tokens.push("ALT".to_string());
    }
    if keybind.shift {
        tokens.push("SHIFT".to_string());
    }
    if keybind.meta {
        tokens.push("LOGO".to_string());
    }

    let key = portal_key_name(&keybind.key_code)
        .ok_or_else(|| "Unsupported key for Wayland global shortcut registration.".to_string())?;
    tokens.push(key);
    Ok(tokens.join("+"))
}

fn portal_key_name(key_code: &str) -> Option<String> {
    if key_code.starts_with("Key") && key_code.len() == 4 {
        let ch = key_code.chars().nth(3)?;
        if ch.is_ascii_alphabetic() {
            return Some(ch.to_ascii_lowercase().to_string());
        }
    }

    if key_code.starts_with("Digit") && key_code.len() == 6 {
        let ch = key_code.chars().nth(5)?;
        if ch.is_ascii_digit() {
            return Some(ch.to_string());
        }
    }

    if let Some(function_number) = key_code.strip_prefix('F') {
        if let Ok(number) = function_number.parse::<u8>() {
            if (1..=24).contains(&number) {
                return Some(format!("F{number}"));
            }
        }
    }

    if let Some(keypad) = key_code.strip_prefix("Numpad") {
        return match keypad {
            "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" => {
                Some(format!("KP_{keypad}"))
            }
            "Multiply" => Some("KP_Multiply".to_string()),
            "Add" => Some("KP_Add".to_string()),
            "Subtract" => Some("KP_Subtract".to_string()),
            "Decimal" => Some("KP_Decimal".to_string()),
            "Divide" => Some("KP_Divide".to_string()),
            "Enter" => Some("KP_Enter".to_string()),
            _ => None,
        };
    }

    match key_code {
        "Space" => Some("space".to_string()),
        "Enter" => Some("Return".to_string()),
        "Escape" => Some("Escape".to_string()),
        "Backspace" => Some("BackSpace".to_string()),
        "Tab" => Some("Tab".to_string()),
        "CapsLock" => Some("Caps_Lock".to_string()),
        "ArrowLeft" => Some("Left".to_string()),
        "ArrowRight" => Some("Right".to_string()),
        "ArrowUp" => Some("Up".to_string()),
        "ArrowDown" => Some("Down".to_string()),
        "Delete" => Some("Delete".to_string()),
        "Insert" => Some("Insert".to_string()),
        "Home" => Some("Home".to_string()),
        "End" => Some("End".to_string()),
        "PageUp" => Some("Page_Up".to_string()),
        "PageDown" => Some("Page_Down".to_string()),
        "Minus" => Some("minus".to_string()),
        "Equal" => Some("equal".to_string()),
        "BracketLeft" => Some("bracketleft".to_string()),
        "BracketRight" => Some("bracketright".to_string()),
        "Backslash" => Some("backslash".to_string()),
        "Semicolon" => Some("semicolon".to_string()),
        "Quote" => Some("apostrophe".to_string()),
        "Comma" => Some("comma".to_string()),
        "Period" => Some("period".to_string()),
        "Slash" => Some("slash".to_string()),
        "Backquote" => Some("grave".to_string()),
        _ => None,
    }
}

fn start_portal_push_keybind_watcher(
    frame_queue: Arc<FrameQueue>,
    session_handle: OwnedObjectPath,
    shortcut_bindings: Vec<PortalShortcutBinding>,
) -> Result<PushKeybindWatcher, String> {
    let stop_flag = Arc::new(AtomicBool::new(false));
    let thread_stop_flag = Arc::clone(&stop_flag);

    let activation_connection = Connection::session().map_err(|error| {
        format!("Could not connect to the D-Bus session bus for shortcut activation events: {error}")
    })?;
    let deactivation_connection = Connection::session().map_err(|error| {
        format!("Could not connect to the D-Bus session bus for shortcut deactivation events: {error}")
    })?;
    let session_connection = Connection::session().map_err(|error| {
        format!("Could not connect to the D-Bus session bus for shortcut session events: {error}")
    })?;

    let handle = thread::spawn(move || {
        let (event_tx, event_rx) = mpsc::channel();
        let activation_thread = {
            let connection = activation_connection.clone();
            let session_handle = session_handle.clone();
            let shortcut_bindings = shortcut_bindings.clone();
            let event_tx = event_tx.clone();
            thread::spawn(move || {
                listen_for_shortcut_signal(
                    connection,
                    "Activated",
                    session_handle,
                    shortcut_bindings,
                    true,
                    event_tx,
                );
            })
        };
        let deactivation_thread = {
            let connection = deactivation_connection.clone();
            let session_handle = session_handle.clone();
            let shortcut_bindings = shortcut_bindings.clone();
            let event_tx = event_tx.clone();
            thread::spawn(move || {
                listen_for_shortcut_signal(
                    connection,
                    "Deactivated",
                    session_handle,
                    shortcut_bindings,
                    false,
                    event_tx,
                );
            })
        };
        let session_thread = {
            let connection = session_connection.clone();
            let session_handle = session_handle.clone();
            let event_tx = event_tx.clone();
            thread::spawn(move || {
                listen_for_session_closed(connection, session_handle, event_tx);
            })
        };

        let mut talk_active = false;
        let mut mute_active = false;
        let mut session_closed = false;

        while !thread_stop_flag.load(Ordering::Relaxed) && !session_closed {
            match event_rx.recv_timeout(Duration::from_millis(25)) {
                Ok(PortalWatcherEvent::State { kind, active }) => match kind {
                    PushKeybindKind::Talk if talk_active != active => {
                        talk_active = active;
                        enqueue_push_keybind_state_event(
                            &frame_queue,
                            PushKeybindKind::Talk,
                            talk_active,
                        );
                    }
                    PushKeybindKind::Mute if mute_active != active => {
                        mute_active = active;
                        enqueue_push_keybind_state_event(
                            &frame_queue,
                            PushKeybindKind::Mute,
                            mute_active,
                        );
                    }
                    _ => {}
                },
                Ok(PortalWatcherEvent::SessionClosed) => {
                    session_closed = true;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {}
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }

        let _ = close_session(&session_connection, &session_handle);
        let _ = activation_connection.close();
        let _ = deactivation_connection.close();
        let _ = session_connection.close();

        let _ = activation_thread.join();
        let _ = deactivation_thread.join();
        let _ = session_thread.join();

        if talk_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Talk, false);
        }
        if mute_active {
            enqueue_push_keybind_state_event(&frame_queue, PushKeybindKind::Mute, false);
        }
    });

    Ok(PushKeybindWatcher::new(stop_flag, handle))
}

fn listen_for_shortcut_signal(
    connection: Connection,
    signal_name: &'static str,
    session_handle: OwnedObjectPath,
    shortcut_bindings: Vec<PortalShortcutBinding>,
    active: bool,
    event_tx: mpsc::Sender<PortalWatcherEvent>,
) {
    let shortcut_kinds: HashMap<String, PushKeybindKind> = shortcut_bindings
        .into_iter()
        .map(|binding| (binding.id, binding.kind))
        .collect();
    let proxy = match portal_proxy(&connection, PORTAL_OBJECT_PATH, GLOBAL_SHORTCUTS_INTERFACE) {
        Ok(proxy) => proxy,
        Err(error) => {
            eprintln!("[capture-sidecar] {error}");
            return;
        }
    };
    let mut signal_stream = match proxy.receive_signal(signal_name) {
        Ok(signal_stream) => signal_stream,
        Err(error) => {
            eprintln!(
                "[capture-sidecar] could not subscribe to Wayland shortcut signal `{signal_name}`: {error}"
            );
            return;
        }
    };

    while let Some(message) = signal_stream.next() {
        let Ok((signal_session_handle, shortcut_id, _timestamp, _options)) = message
            .body()
            .deserialize::<(OwnedObjectPath, String, u64, HashMap<String, OwnedValue>)>()
        else {
            eprintln!(
                "[capture-sidecar] could not decode Wayland shortcut signal `{signal_name}`"
            );
            continue;
        };

        if signal_session_handle != session_handle {
            continue;
        }

        let Some(kind) = shortcut_kinds.get(&shortcut_id) else {
            continue;
        };
        if event_tx
            .send(PortalWatcherEvent::State {
                kind: *kind,
                active,
            })
            .is_err()
        {
            break;
        }
    }
}

fn listen_for_session_closed(
    connection: Connection,
    session_handle: OwnedObjectPath,
    event_tx: mpsc::Sender<PortalWatcherEvent>,
) {
    let proxy = match portal_proxy(&connection, session_handle.as_str(), SESSION_INTERFACE) {
        Ok(proxy) => proxy,
        Err(error) => {
            eprintln!("[capture-sidecar] {error}");
            return;
        }
    };
    let mut signal_stream = match proxy.receive_signal("Closed") {
        Ok(signal_stream) => signal_stream,
        Err(error) => {
            eprintln!("[capture-sidecar] could not subscribe to the shortcut session close signal: {error}");
            return;
        }
    };

    if signal_stream.next().is_some() {
        let _ = event_tx.send(PortalWatcherEvent::SessionClosed);
    }
}

fn close_session(connection: &Connection, session_handle: &OwnedObjectPath) -> Result<(), String> {
    let session_proxy = portal_proxy(connection, session_handle.as_str(), SESSION_INTERFACE)?;
    session_proxy
        .call_noreply("Close", &())
        .map_err(|error| format!("Could not close the Wayland shortcut session: {error}"))
}

#[cfg(test)]
mod tests {
    use super::{preferred_trigger_for_keybind, LinuxPushKeybind};

    #[test]
    fn preferred_trigger_uses_xdg_key_names() {
        let keybind = LinuxPushKeybind {
            key_code: "KeyT".to_string(),
            key_sym: 0,
            ctrl: true,
            alt: false,
            shift: true,
            meta: false,
        };

        assert_eq!(
            preferred_trigger_for_keybind(&keybind).as_deref(),
            Ok("CTRL+SHIFT+t"),
        );
    }

    #[test]
    fn preferred_trigger_maps_keypad_names() {
        let keybind = LinuxPushKeybind {
            key_code: "NumpadEnter".to_string(),
            key_sym: 0,
            ctrl: false,
            alt: false,
            shift: false,
            meta: true,
        };

        assert_eq!(
            preferred_trigger_for_keybind(&keybind).as_deref(),
            Ok("LOGO+KP_Enter"),
        );
    }
}
