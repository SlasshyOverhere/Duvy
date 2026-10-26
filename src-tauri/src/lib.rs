//! BetterNuvio: an unofficial, performance-first desktop media hub.
//!
//! The Rust side owns everything that should never block the UI: the local
//! store, addon HTTP calls, metadata enrichment and playback control.

mod addons;
mod commands;
mod db;
mod models;
mod playback_log;
mod player;
mod settings;
mod streams;
mod tmdb;

use std::sync::Mutex;
use std::time::Duration;
use tauri::Manager;

pub struct AppState {
    pub db: db::Db,
    pub http: reqwest::Client,
    pub player: Mutex<Option<player::Player>>,
}

#[cfg(test)]
mod db_tests;

/// Keep the web layer above mpv's render window.
///
/// mpv's render window is created after the web view, so by default it becomes
/// the topmost child of the app window and would swallow every click meant for
/// the controls. Raising the web view instead leaves the video underneath it.
#[cfg(windows)]
pub fn raise_webview(host: isize) {
    use windows_sys::Win32::Foundation::{HWND, LPARAM};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        EnumChildWindows, GetClassNameW, SetWindowPos, HWND_TOP, SWP_ASYNCWINDOWPOS,
        SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
    };

    unsafe extern "system" fn collect(child: HWND, lparam: LPARAM) -> windows_sys::core::BOOL {
        let children = unsafe { &mut *(lparam as *mut Vec<HWND>) };
        children.push(child);
        1
    }

    let mut children: Vec<HWND> = Vec::new();
    unsafe {
        EnumChildWindows(
            host as HWND,
            Some(collect),
            &mut children as *mut _ as LPARAM,
        );
    }
    for child in children {
        let mut name = [0u16; 64];
        let len = unsafe { GetClassNameW(child, name.as_mut_ptr(), name.len() as i32) };
        if len <= 0 {
            continue;
        }
        let class = String::from_utf16_lossy(&name[..len as usize]);
        if class.starts_with("Chrome_WidgetWin") {
            unsafe {
                SetWindowPos(
                    child,
                    HWND_TOP,
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS,
                );
            }
        }
    }
}

#[cfg(not(windows))]
pub fn raise_webview(_host: isize) {}

/// Toggle a borderless, monitor-filling window.
///
/// The framework's own fullscreen path rewrites the window flags while the
/// video surface is presenting into the same window, and that round trip can
/// wedge the UI thread. Doing the style swap here keeps the whole change to one
/// placement call, and the exact previous style and position are restored on
/// the way back out.
#[cfg(windows)]
pub fn set_fullscreen(host: isize, on: bool) -> bool {
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowPlacement, IsWindow, SetWindowLongPtrW, SetWindowPlacement,
        SetWindowPos, GWL_STYLE, SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE,
        SWP_NOZORDER, SWP_SHOWWINDOW, WINDOWPLACEMENT, WS_CAPTION, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_SYSMENU, WS_THICKFRAME,
    };

    static SAVED: Mutex<Option<(isize, isize, WINDOWPLACEMENT)>> = Mutex::new(None);

    let hwnd = host as HWND;
    unsafe {
        if IsWindow(hwnd) == 0 {
            return false;
        }

        if on {
            // Entering twice must not overwrite the only real placement with
            // the borderless one, or there is nothing left to restore.
            if SAVED.lock().map(|guard| guard.is_some()).unwrap_or(false) {
                return true;
            }

            let mut placement: WINDOWPLACEMENT = std::mem::zeroed();
            placement.length = std::mem::size_of::<WINDOWPLACEMENT>() as u32;
            if GetWindowPlacement(hwnd, &mut placement) == 0 {
                return false;
            }
            let style = GetWindowLongPtrW(hwnd, GWL_STYLE);
            if style == 0 {
                return false;
            }

            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return false;
            }

            if let Ok(mut saved) = SAVED.lock() {
                *saved = Some((hwnd as isize, style, placement));
            }

            let RECT {
                left,
                top,
                right,
                bottom,
            } = info.rcMonitor;
            let chrome = (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
                as isize;
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !chrome);
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                left,
                top,
                right - left,
                bottom - top,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOACTIVATE | SWP_SHOWWINDOW,
            );
            true
        } else {
            let saved = SAVED.lock().ok().and_then(|mut guard| guard.take());
            let Some((saved_hwnd, style, placement)) = saved else {
                return false;
            };
            if IsWindow(saved_hwnd as HWND) == 0 {
                return false;
            }
            let saved_hwnd = saved_hwnd as HWND;
            SetWindowLongPtrW(saved_hwnd, GWL_STYLE, style);
            SetWindowPlacement(saved_hwnd, &placement);
            // A style change only takes effect once the frame is recomputed,
            // otherwise the window comes back still looking borderless.
            SetWindowPos(
                saved_hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
            );
            true
        }
    }
}

#[cfg(not(windows))]
pub fn set_fullscreen(_host: isize, _on: bool) -> bool {
    false
}

/// Window handle mpv draws into, or `None` when there is nothing to embed in.
///
/// mpv renders into the app window's own client area, so the web layer above it
/// stays transparent during playback and React supplies the whole player UI.
pub fn video_host(app: &tauri::AppHandle) -> Option<isize> {
    let window = app.get_webview_window("main")?;
    #[cfg(windows)]
    {
        window.hwnd().ok().map(|hwnd| hwnd.0 as isize)
    }
    #[cfg(not(windows))]
    {
        let _ = window;
        None
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("the app data directory should be available");
            std::fs::create_dir_all(&data_dir)?;

            let connection = db::open(&data_dir.join("betternuvio.db"))
                .expect("the local database should open");
            let http = reqwest::Client::builder()
                .user_agent("BetterNuvio/0.1 (+https://github.com/better-nuvio)")
                .timeout(Duration::from_secs(18))
                .connect_timeout(Duration::from_secs(8))
                .pool_max_idle_per_host(6)
                .build()
                .expect("the HTTP client should build");

            app.manage(AppState {
                db: db::Db(Mutex::new(connection)),
                http,
                player: Mutex::new(None),
            });

            // The window itself stays opaque (a transparent window cannot host
            // the video surface); only the web layer is see-through, so the
            // picture mpv paints behind it is visible while the player route is
            // open and every other route paints its own background as usual.
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::app_info,
            commands::mpv_detect,
            commands::playback_log,
            commands::settings_get,
            commands::settings_set,
            commands::addons_list,
            commands::addons_install,
            commands::addons_remove,
            commands::addons_set_enabled,
            commands::home_feed,
            commands::catalog,
            commands::search,
            commands::meta_details,
            commands::streams,
            commands::subtitles,
            commands::library_list,
            commands::library_toggle,
            commands::progress_list,
            commands::progress_for,
            commands::progress_clear,
            commands::watched_set,
            commands::player_open,
            commands::player_state,
            commands::player_control,
            commands::player_stop,
            commands::player_subtitle,
            commands::window_fullscreen,
        ])
        .build(tauri::generate_context!())
        .expect("error while building BetterNuvio");

    app.run(|handle, event| {
        if let tauri::RunEvent::Exit = event {
            if let Some(state) = handle.try_state::<AppState>() {
                if let Ok(mut guard) = state.player.lock() {
                    *guard = None;
                }
            }
        }
    });
}
