//! Update checks, background polling, download and install.
//!
//! The plugin owns the release feed and signature check; this module decides
//! when to look, what to tell the user, and when to stay quiet.

use std::sync::Mutex;
use std::time::{Duration, Instant};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::settings::Settings;
use crate::AppState;

/// A release newer than the running build.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UpdateInfo {
    pub version: String,
    pub current_version: String,
    pub notes: Option<String>,
    pub date: Option<String>,
}

/// Download progress, in bytes; `total` is missing when the host sends no size.
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct Progress {
    downloaded: usize,
    total: Option<u64>,
}

/// How often a running app looks again after a successful check.
const RECHECK: Duration = Duration::from_secs(60 * 60);

/// Startup traffic settles fast; the launch check must not wait out a timer.
const WARMUP: Duration = Duration::from_secs(2);

/// A check must answer (or fail) instead of hanging on a stalled host.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// Retry steps after a failed check, so one bad minute is not six hours blind.
const RETRIES: [u64; 3] = [60, 300, 900];

/// The release the last check found, so install starts downloading at once.
static CHECKED: Mutex<Option<Update>> = Mutex::new(None);

fn retry_after(failures: u32) -> Duration {
    let step = RETRIES
        .get(failures.saturating_sub(1) as usize)
        .copied()
        .unwrap_or(RECHECK.as_secs());
    Duration::from_secs(step)
}

fn cached() -> Option<Update> {
    CHECKED.lock().ok().and_then(|slot| slot.clone())
}

fn remember(update: Option<&Update>) {
    if let Ok(mut slot) = CHECKED.lock() {
        *slot = update.cloned();
    }
}

async fn fetch(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app
        .updater_builder()
        .timeout(CHECK_TIMEOUT)
        // A dead host fails the handshake instead of stalling the whole check.
        .configure_client(|client| client.connect_timeout(Duration::from_secs(8)))
        .build()
        .map_err(|e| e.to_string())?;
    updater.check().await.map_err(|e| e.to_string())
}

fn info(update: &Update) -> UpdateInfo {
    UpdateInfo {
        version: update.version.clone(),
        current_version: update.current_version.clone(),
        notes: update.body.clone(),
        date: update.date.map(|date| date.date().to_string()),
    }
}

fn settings(app: &AppHandle) -> Settings {
    let Some(state) = app.try_state::<AppState>() else {
        return Settings::default();
    };
    let Ok(conn) = state.db.0.lock() else {
        return Settings::default();
    };
    Settings::load(&conn)
}

/// Look for a newer release. Returns `None` when the build is current.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let found = fetch(&app).await?;
    remember(found.as_ref());
    Ok(found.as_ref().map(info))
}

/// Download and install the newest release. On Windows the installer takes
/// over and the process exits, so this only returns when something failed.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    // Reuse the release the check already found: a second latest.json round
    // trip made the download look stalled before the first byte arrived.
    let update = match cached() {
        Some(update) => update,
        None => fetch(&app)
            .await?
            .ok_or("Duvy is already up to date.")?,
    };
    let handle = app.clone();
    let mut downloaded = 0usize;
    let mut last = None::<Instant>;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
                let done = total.is_some_and(|total| downloaded as u64 >= total);
                // One event per network chunk floods the webview; a quarter of
                // a second still reads as live without the jank.
                let due = last.is_none_or(|at| at.elapsed() >= Duration::from_millis(250));
                if !due && !done {
                    return;
                }
                last = Some(Instant::now());
                let _ = handle.emit(
                    "update:progress",
                    Progress {
                        downloaded,
                        total,
                    },
                );
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// Check on launch, then hourly while the app stays open. A failed check
/// retries in a minute, then backs off, so one bad request is not a blank day.
///
/// A skipped version stays quiet in the background; a manual check still
/// reports it.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let startup traffic settle before the first request.
        tokio::time::sleep(WARMUP).await;
        let mut failures = 0u32;
        loop {
            let current = settings(&app);
            let mut wait = RECHECK;
            if current.auto_update_check {
                match update_check(app.clone()).await {
                    Ok(found) => {
                        failures = 0;
                        if let Some(found) = found {
                            if found.version != current.ignored_update_version {
                                announce(&app, &found);
                            }
                        }
                    }
                    Err(_) => {
                        failures += 1;
                        wait = retry_after(failures);
                    }
                }
            }
            tokio::time::sleep(wait).await;
        }
    });
}

/// In-app toast plus a desktop notification, so an update is noticed even when
/// the window is behind something else.
fn announce(app: &AppHandle, info: &UpdateInfo) {
    let _ = app.emit("update:available", info.clone());
    let _ = app
        .notification()
        .builder()
        .title(format!("Duvy {} is available", info.version))
        .body("Open Settings, Update to install it.")
        .show();
}

#[cfg(test)]
mod tests {
    use super::{retry_after, RECHECK};
    use std::time::Duration;

    #[test]
    fn a_failed_check_retries_before_the_long_interval() {
        assert_eq!(retry_after(1), Duration::from_secs(60));
        assert_eq!(retry_after(2), Duration::from_secs(300));
        assert_eq!(retry_after(3), Duration::from_secs(900));
        // Past the ladder it settles on the normal interval, never beyond it.
        assert_eq!(retry_after(9), RECHECK);
        assert_eq!(retry_after(0), Duration::from_secs(60));
    }
}
