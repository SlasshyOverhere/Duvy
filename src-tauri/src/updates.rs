//! Update checks, background polling, download and install.
//!
//! The plugin owns the release feed and signature check; this module decides
//! when to look, what to tell the user, and when to stay quiet.

use std::time::Duration;
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

/// How often a running app looks again after the launch check.
const RECHECK: Duration = Duration::from_secs(6 * 60 * 60);

async fn fetch(app: &AppHandle) -> Result<Option<Update>, String> {
    let updater = app.updater().map_err(|e| e.to_string())?;
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
    Ok(fetch(&app).await?.as_ref().map(info))
}

/// Download and install the newest release. On Windows the installer takes
/// over and the process exits, so this only returns when something failed.
#[tauri::command]
pub async fn update_install(app: AppHandle) -> Result<(), String> {
    let Some(update) = fetch(&app).await? else {
        return Err("Duvy is already up to date.".into());
    };
    let handle = app.clone();
    let mut downloaded = 0usize;
    update
        .download_and_install(
            move |chunk, total| {
                downloaded += chunk;
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

/// Check on launch, then every few hours while the app stays open.
///
/// A skipped version stays quiet in the background; a manual check still
/// reports it.
pub fn watch(app: AppHandle) {
    tauri::async_runtime::spawn(async move {
        // Let startup traffic settle before the first request.
        tokio::time::sleep(Duration::from_secs(15)).await;
        loop {
            let current = settings(&app);
            if current.auto_update_check {
                if let Ok(Some(found)) = update_check(app.clone()).await {
                    if found.version != current.ignored_update_version {
                        announce(&app, &found);
                    }
                }
            }
            tokio::time::sleep(RECHECK).await;
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
