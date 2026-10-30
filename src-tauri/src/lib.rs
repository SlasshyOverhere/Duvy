//! Duvy: a performance-first desktop media hub.
//!
//! The Rust side owns everything that should never block the UI: the local
//! store, addon HTTP calls, metadata enrichment and playback control.

mod addons;
mod commands;
mod db;
mod debrid;
mod frame;
mod meta;
mod models;
mod nuvio_sync;
mod playback_log;
mod player;
mod secret;
mod servers;
mod settings;
mod skip;
mod stremio_sync;
mod streams;
mod tmdb;
mod torrent;
mod trakt;
mod updates;

use std::sync::{Mutex, RwLock};
use std::time::Duration;
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::{DialogExt, MessageDialogKind};

pub struct AppState {
    pub db: db::Db,
    pub http: reqwest::Client,
    pub player: Mutex<Option<player::Player>>,
    /// Decoded settings; `None` means "read it again from the database".
    pub settings: RwLock<Option<settings::Settings>>,
}

#[cfg(test)]
mod db_tests;

/// A panic ends the process, so the hook is the last thing that can say why:
/// one line in the local journal, plus a report to the window while it lasts.
fn install_crash_hook(handle: tauri::AppHandle) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let detail = info
            .payload()
            .downcast_ref::<&str>()
            .map(|text| (*text).to_string())
            .or_else(|| info.payload().downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "panic".to_string());
        let message = match info.location() {
            Some(place) => format!("{detail} ({}:{})", place.file(), place.line()),
            None => detail,
        };
        playback_log::mark(format!("crash: {message}"));
        let _ = handle.emit("app:error", message);
        previous(info);
    }));
}

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
        // GetClassNameW can report more than the buffer holds when the class
        // name is long, and slicing past it aborts the app from a window event.
        let len = (len as usize).min(name.len());
        let class = String::from_utf16_lossy(&name[..len]);
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

/// Re-fit the web layer to the client rect.
///
/// A frame change that leaves the outer size alone (turning off the window
/// shadow, adding or dropping the caption) moves the client rect without a
/// size message, so the host keeps the old bounds and the band between the two
/// is painted with the window background. A synthetic size message re-runs the
/// host's own fit.
#[cfg(windows)]
pub fn refit_webview(host: isize) {
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetClientRect, SendMessageW, SetWindowPos, SIZE_RESTORED, SWP_FRAMECHANGED, SWP_NOACTIVATE,
        SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, WM_SIZE,
    };
    let hwnd = host as HWND;
    let mut rect: RECT = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    unsafe {
        // Recompute the non-client area so the frame flags just changed take
        // effect, then force the host's own fit for the new client rect.
        SetWindowPos(
            hwnd,
            std::ptr::null_mut(),
            0,
            0,
            0,
            0,
            SWP_FRAMECHANGED | SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
        );
        if GetClientRect(hwnd, &mut rect) == 0 {
            return;
        }
        let packed = (rect.right as isize & 0xFFFF) | ((rect.bottom as isize & 0xFFFF) << 16);
        SendMessageW(hwnd, WM_SIZE, SIZE_RESTORED as usize, packed);
    }
}

#[cfg(not(windows))]
pub fn refit_webview(_host: isize) {}

/// Remove the accent frame Windows 11 paints around a window. A borderless
/// window stretched over the whole monitor otherwise keeps a light edge along
/// the bottom that reads as a strip in fullscreen.
#[cfg(windows)]
fn set_window_frame(hwnd: isize, borderless: bool) {
    use windows_sys::Win32::Foundation::HWND;
    use windows_sys::Win32::Graphics::Dwm::{
        DwmSetWindowAttribute, DWMWA_BORDER_COLOR, DWMWA_CAPTION_COLOR, DWMWA_TEXT_COLOR,
        DWMWA_USE_IMMERSIVE_DARK_MODE, DWMWA_WINDOW_CORNER_PREFERENCE, DWMWCP_DONOTROUND,
    };
    /// COLORREF for the app's own background, so the frame stops standing out.
    const BLACK: u32 = 0x0000_0000;
    const WHITE: u32 = 0x00FF_FFFF;
    const COLOR_DEFAULT: u32 = 0xFFFF_FFFF;
    const CORNER_DEFAULT: u32 = 0;
    let black = borderless;
    let set = |attribute: u32, value: u32, size: u32| unsafe {
        let _ = DwmSetWindowAttribute(
            hwnd as HWND,
            attribute,
            &value as *const u32 as *const _,
            size,
        );
    };
    let word = std::mem::size_of::<u32>() as u32;
    set(
        DWMWA_USE_IMMERSIVE_DARK_MODE as u32,
        black as u32,
        std::mem::size_of::<i32>() as u32,
    );
    set(DWMWA_CAPTION_COLOR as u32, if black { BLACK } else { COLOR_DEFAULT }, word);
    set(DWMWA_BORDER_COLOR as u32, if black { BLACK } else { COLOR_DEFAULT }, word);
    set(DWMWA_TEXT_COLOR as u32, if black { WHITE } else { COLOR_DEFAULT }, word);
    set(
        DWMWA_WINDOW_CORNER_PREFERENCE as u32,
        if black { DWMWCP_DONOTROUND as u32 } else { CORNER_DEFAULT },
        word,
    );
}

#[cfg(not(windows))]
fn set_window_frame(_hwnd: isize, _borderless: bool) {}

/// Toggle a borderless, monitor-filling window.
///
/// The framework's own fullscreen path rewrites the window flags while the
/// video surface is presenting into the same window, and that round trip can
/// wedge the UI thread. Doing the style swap here keeps the whole change to one
/// placement call, and the exact previous style and position are restored on
/// the way back out.
///
/// Removing the caption changes the client insets without changing the outer
/// rect, so the host keeps the framed client size and leaves the last rows of
/// the window uncovered. Nudging the height by a pixel and back forces that
/// recalculation, and the transition is painted once at the end.
#[cfg(windows)]
pub fn set_fullscreen(host: isize, on: bool) -> bool {
    use std::sync::Mutex;
    use windows_sys::Win32::Foundation::{HWND, RECT};
    use windows_sys::Win32::Graphics::Gdi::{
        GetMonitorInfoW, GetStockObject, MonitorFromWindow, RedrawWindow, BLACK_BRUSH,
        MONITORINFO, MONITOR_DEFAULTTONEAREST, RDW_ALLCHILDREN, RDW_ERASE, RDW_FRAME,
        RDW_INVALIDATE, RDW_UPDATENOW,
    };
    use windows_sys::Win32::UI::WindowsAndMessaging::{
        GetWindowLongPtrW, GetWindowPlacement, IsIconic, IsWindow, IsZoomed, SendMessageW,
        SetClassLongPtrW, SetWindowLongPtrW, SetWindowPlacement, SetWindowPos, ShowWindow,
        GCLP_HBRBACKGROUND, GWL_EXSTYLE, GWL_STYLE,
        SWP_FRAMECHANGED, SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOOWNERZORDER, SWP_NOREDRAW, SWP_NOSIZE,
        SWP_NOZORDER, SW_RESTORE, WM_SETREDRAW, WINDOWPLACEMENT, WS_CAPTION, WS_EX_CLIENTEDGE,
        WS_EX_DLGMODALFRAME, WS_EX_STATICEDGE, WS_EX_WINDOWEDGE, WS_MAXIMIZEBOX, WS_MINIMIZEBOX,
        WS_SYSMENU, WS_THICKFRAME,
    };

    static SAVED: Mutex<Option<(isize, isize, isize, WINDOWPLACEMENT)>> = Mutex::new(None);

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
            let ex_style = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);

            let mut info: MONITORINFO = std::mem::zeroed();
            info.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            if GetMonitorInfoW(monitor, &mut info) == 0 {
                return false;
            }

            if let Ok(mut saved) = SAVED.lock() {
                *saved = Some((hwnd as isize, style, ex_style, placement));
            }

            // Anything the webview does not cover is erased with the class
            // brush, which is white by default and stays white on screen.
            SetClassLongPtrW(hwnd, GCLP_HBRBACKGROUND, GetStockObject(BLACK_BRUSH) as isize);

            if IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 {
                ShowWindow(hwnd, SW_RESTORE);
            }

            let RECT {
                left,
                top,
                right,
                bottom,
            } = info.rcMonitor;
            let (width, height) = (right - left, bottom - top);

            SendMessageW(hwnd, WM_SETREDRAW, 0, 0);

            let chrome = (WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX)
                as isize;
            let edges = (WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE | WS_EX_STATICEDGE)
                as isize;
            SetWindowLongPtrW(hwnd, GWL_STYLE, style & !chrome);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style & !edges);

            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                left,
                top,
                width,
                height,
                SWP_FRAMECHANGED | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_NOACTIVATE | SWP_NOREDRAW,
            );
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                width,
                height - 1,
                SWP_NOMOVE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | SWP_NOACTIVATE
                    | SWP_FRAMECHANGED
                    | SWP_NOREDRAW,
            );
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                width,
                height,
                SWP_NOMOVE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | SWP_NOACTIVATE
                    | SWP_FRAMECHANGED
                    | SWP_NOREDRAW,
            );


            SendMessageW(hwnd, WM_SETREDRAW, 1, 0);
            RedrawWindow(
                hwnd,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_FRAME | RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW | RDW_ALLCHILDREN,
            );
            set_window_frame(host, true);
            refit_webview(host);
            true
        } else {
            let saved = SAVED.lock().ok().and_then(|mut guard| guard.take());
            let Some((saved_hwnd, style, ex_style, placement)) = saved else {
                return false;
            };
            if IsWindow(saved_hwnd as HWND) == 0 {
                return false;
            }
            let hwnd = saved_hwnd as HWND;

            SendMessageW(hwnd, WM_SETREDRAW, 0, 0);
            SetWindowLongPtrW(hwnd, GWL_STYLE, style);
            SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex_style);
            SetWindowPlacement(hwnd, &placement);
            // A style change only takes effect once the frame is recomputed,
            // otherwise the window comes back still looking borderless.
            SetWindowPos(
                hwnd,
                std::ptr::null_mut(),
                0,
                0,
                0,
                0,
                SWP_FRAMECHANGED
                    | SWP_NOMOVE
                    | SWP_NOSIZE
                    | SWP_NOZORDER
                    | SWP_NOOWNERZORDER
                    | SWP_NOACTIVATE
                    | SWP_NOREDRAW,
            );
            SendMessageW(hwnd, WM_SETREDRAW, 1, 0);
            set_window_frame(saved_hwnd, false);
            RedrawWindow(
                hwnd,
                std::ptr::null(),
                std::ptr::null_mut(),
                RDW_FRAME | RDW_INVALIDATE | RDW_ERASE | RDW_UPDATENOW | RDW_ALLCHILDREN,
            );
            refit_webview(saved_hwnd);
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

/// Whether an mpv surface is currently attached to the window.
pub(crate) fn player_is_live(app: &tauri::AppHandle) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    state
        .player
        .lock()
        .map(|guard| guard.is_some())
        .unwrap_or(false)
}

/// One client for every outbound request: the same user agent Cinemeta expects,
/// and timeouts short enough that a dead host cannot hold a screen hostage.
pub fn http_client() -> reqwest::Client {
    reqwest::Client::builder()
        .user_agent("Duvy/0.1 (+https://github.com/SlasshyOverhere/Duvy)")
        .timeout(Duration::from_secs(18))
        .connect_timeout(Duration::from_secs(8))
        .tcp_keepalive(Duration::from_secs(30))
        .pool_max_idle_per_host(16)
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            // Five hops is plenty for a CDN or a moved addon host.
            if attempt.previous().len() >= 5 {
                return attempt.error("too many redirects");
            }
            // Never let a redirect quietly drop TLS.
            if attempt.url().scheme() == "http"
                && attempt.previous().last().is_some_and(|url| url.scheme() == "https")
            {
                return attempt.error("refusing to redirect from https to http");
            }
            attempt.follow()
        }))
        .build()
        .expect("the HTTP client should build")
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app
                .path()
                .app_data_dir()
                .expect("the app data directory should be available");
            std::fs::create_dir_all(&data_dir)?;
            // The journal exists before anything can fail, and a panic is the
            // one failure with nowhere else to go.
            playback_log::init(&data_dir);
            install_crash_hook(app.handle().clone());

            let db_path = data_dir.join("duvy.db");
            let connection = match db::open(&db_path) {
                Ok(connection) => connection,
                Err(error) => {
                    eprintln!("[startup] cannot open {}: {error}", db_path.display());
                    if let Some(window) = app.get_webview_window("main") {
                        let _ = window.hide();
                    }
                    // setup runs on the event loop thread, so the dialog has to
                    // be queued and the exit taken from its callback.
                    app.dialog()
                        .message(format!(
                            "Duvy could not open its local database:\n\n{}\n\n{error}\n\nThe app will now close.",
                            db_path.display()
                        ))
                        .title("Duvy cannot start")
                        .kind(MessageDialogKind::Error)
                        .show(|_| std::process::exit(1));
                    return Ok(());
                }
            };
            let http = http_client();

            app.manage(AppState {
                db: db::Db(Mutex::new(connection)),
                http,
                player: Mutex::new(None),
                settings: RwLock::new(None),
            });

            updates::watch(app.handle().clone());
            // Cinemeta ships by default, the way Stremio and Nuvio do it.
            tauri::async_runtime::spawn(commands::seed_default_addons(app.handle().clone()));

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
            commands::playback_log,
            commands::settings_get,
            commands::settings_set,
            updates::update_check,
            updates::update_prefetch,
            updates::update_install,
            commands::addons_list,
            commands::addons_install,
            commands::addons_remove,
            commands::addons_set_enabled,
            commands::addons_move,
            commands::addons_refresh,
            commands::home_feed,
            commands::catalog,
            commands::search,
            commands::meta_details,
            commands::cast_photos,
            commands::recommendations,
            commands::similar,
            commands::streams,
            commands::subtitles,
            commands::library_list,
            commands::library_toggle,
            commands::progress_list,
            commands::progress_for,
            commands::progress_clear,
            commands::watched_set,
            commands::watched_list,
            commands::player_open,
            commands::player_state,
            commands::player_frame,
            commands::player_control,
            commands::player_stop,
            commands::player_subtitle,
            commands::window_fullscreen,
            commands::nuvio_status,
            commands::nuvio_sign_in,
            commands::nuvio_sign_out,
            commands::nuvio_set_profile,
            commands::nuvio_profiles,
            commands::nuvio_sync_now,
            commands::stremio_status,
            commands::stremio_sign_in,
            commands::stremio_sign_out,
            commands::stremio_sync_now,
            commands::sync_all,
            trakt::set_client,
            trakt::scrobble,
            debrid::check_cache,
            skip::skip_get,
            skip::skip_lookup,
            skip::skip_set,
            servers::srv_list,
            servers::srv_add,
            servers::srv_remove,
            servers::srv_items,
            servers::srv_stream,
            torrent::start,
            torrent::stats,
            torrent::stop,
            trakt::status,
            trakt::begin,
            trakt::poll,
            trakt::disconnect,
            trakt::sync,
            debrid::providers,
            debrid::set_key,
            debrid::resolve,
        ])
        .build(tauri::generate_context!())
        .expect("error while building Duvy");

    app.run(|handle, event| {
        match event {
            tauri::RunEvent::Exit => {
                if let Some(state) = handle.try_state::<AppState>() {
                    if let Ok(mut guard) = state.player.lock() {
                        *guard = None;
                    }
                }
            }
            // mpv's render window is created after the web layer, so any event
            // that rebuilds the child tree can put it back on top and swallow
            // every click. Re-raise the web layer while something is playing.
            tauri::RunEvent::WindowEvent { event, .. } => {
                let resized = matches!(event, tauri::WindowEvent::Resized(_));
                let focused = matches!(event, tauri::WindowEvent::Focused(true));
                if (resized || focused) && player_is_live(&handle) {
                    if let Some(host) = video_host(&handle) {
                        raise_webview(host);
                    }
                }
            }
            _ => {}
        }
    });
}
