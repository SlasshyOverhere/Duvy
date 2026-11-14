//! Update checks, background polling, download and install.
//!
//! The plugin owns the release feed and signature check; this module decides
//! when to look, what to tell the user, and when to stay quiet.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_notification::NotificationExt;
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::db;
use crate::settings::Settings;
use crate::AppState;

/// A release newer than the running build.
#[derive(Serialize, Deserialize, Clone)]
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
const RECHECK: Duration = Duration::from_secs(5 * 60);

/// A check must answer (or fail) instead of hanging on a stalled host.
const CHECK_TIMEOUT: Duration = Duration::from_secs(20);

/// Retry steps after a failed check, so one bad minute is not six hours blind.
const RETRIES: [u64; 3] = [60, 300, 900];

/// The release the last check found, so install starts downloading at once.
static CHECKED: Mutex<Option<Update>> = Mutex::new(None);

/// The last answer, kept in the DB so the next launch can announce it at once.
const CACHE_KEY: &str = "update.cache";

/// One download or install at a time: a second caller waits instead of racing.
static WORK: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// A progress event per chunk would flood the webview; this still reads live.
const PROGRESS: Duration = Duration::from_millis(120);

/// The version the background check already announced.
static ANNOUNCED: Mutex<String> = Mutex::new(String::new());

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

fn stored(app: &AppHandle) -> Option<UpdateInfo> {
    let state = app.try_state::<AppState>()?;
    let value = db::read_kv(&state.db.conn(), CACHE_KEY).ok().flatten()?;
    serde_json::from_value(value).ok()
}

fn store(app: &AppHandle, found: Option<&UpdateInfo>) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let conn = state.db.conn();
    let _ = match found {
        Some(info) => serde_json::to_value(info)
            .map_err(|e| e.to_string())
            .and_then(|value| db::write_kv(&conn, CACHE_KEY, &value).map_err(|e| e.to_string())),
        None => db::delete_kv(&conn, CACHE_KEY).map_err(|e| e.to_string()),
    };
}

fn settings(app: &AppHandle) -> Settings {
    let Some(state) = app.try_state::<AppState>() else {
        return Settings::default();
    };
    let conn = state.db.conn();
    Settings::load(&conn)
}

/// Look for a newer release. Returns `None` when the build is current.
#[tauri::command]
pub async fn update_check(app: AppHandle) -> Result<Option<UpdateInfo>, String> {
    let found = fetch(&app).await?;
    remember(found.as_ref());
    let answer = found.as_ref().map(info);
    store(&app, answer.as_ref());
    Ok(answer)
}

/// The release a previous launch already found, for an instant announcement.
#[tauri::command]
pub fn update_cached(app: AppHandle) -> Option<UpdateInfo> {
    let current = settings(&app);
    if !current.auto_update_check {
        return None;
    }
    let known = stored(&app)?;
    if known.version == app.package_info().version.to_string()
        || known.version == current.ignored_update_version
    {
        return None;
    }
    Some(known)
}

/// Download the package, reporting progress, and verify its signature.
async fn download(app: &AppHandle, update: &Update) -> Result<Vec<u8>, String> {
    let handle = app.clone();
    let mut downloaded = 0usize;
    let mut last = None::<Instant>;
    update
        .download(
            move |chunk, total| {
                downloaded += chunk;
                let done = total.is_some_and(|total| downloaded as u64 >= total);
                let due = last.is_none_or(|at| at.elapsed() >= PROGRESS);
                if !due && !done {
                    return;
                }
                last = Some(Instant::now());
                let _ = handle.emit("update:progress", Progress { downloaded, total });
            },
            || {},
        )
        .await
        .map_err(|e| e.to_string())
}

/// Download and install the newest release. On Windows the installer takes
/// over and the process exits, so this only returns when something failed.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let _busy = WORK.lock().await;
    // Reuse the release the check already found: a second latest.json round
    // trip made the download look stalled before the first byte arrived.
    let update = match cached() {
        Some(update) => update,
        None => fetch(&app).await?.ok_or("Duvy is already up to date.")?,
    };
    let bytes = download(&app, &update).await?;
    update.install(bytes).map_err(|e| e.to_string())
}

/// Check on launch, then every 5 minutes while the app stays open. A failed check
/// retries in a minute, then backs off, so one bad request is not a blank day.
///
/// A skipped version stays quiet in the background; a manual check still
/// reports it.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        let mut failures = 0u32;
        loop {
            let current = settings(&app);
            let mut wait = RECHECK;
            if current.auto_update_check {
                match update_check(app.clone()).await {
                    Ok(found) => {
                        failures = 0;
                        if let Some(found) = found
                            && found.version != current.ignored_update_version
                        {
                            announce(&app, &found);
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
    // One announcement per version: the periodic re-check must not nag.
    match ANNOUNCED.lock() {
        Ok(mut seen) => {
            if *seen == info.version {
                return;
            }
            seen.clone_from(&info.version);
        }
        Err(_) => return,
    }
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
    use super::{RECHECK, retry_after};
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
