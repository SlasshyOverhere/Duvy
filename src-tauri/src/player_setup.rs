//! First-run player provisioning.
//!
//! The installer ships without mpv; the player is fetched once into app data on
//! first launch, so app updates never re-download it and the installer stays
//! small. Every file is verified against the release's `sha256.txt` before it
//! is moved into place, so a truncated or swapped download is never played.

use crate::AppState;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;
use tauri::{AppHandle, Emitter, Manager, State};

/// The release that carries the player build. Bump the tag to ship a new mpv.
const RELEASE: &str =
    "https://github.com/SlasshyOverhere/BetterNuvio/releases/download/player-1";

static DIR: OnceLock<PathBuf> = OnceLock::new();
static RUNNING: AtomicBool = AtomicBool::new(false);

pub fn init(app: &AppHandle) {
    if let Ok(base) = app.path().app_data_dir() {
        let dir = base.join("player");
        let _ = std::fs::create_dir_all(&dir);
        let _ = DIR.set(dir);
    }
}

fn dir() -> Option<PathBuf> {
    DIR.get().cloned()
}

/// The mpv this app downloaded itself, if the install finished.
pub fn installed() -> Option<String> {
    let path = dir()?.join("mpv.exe");
    path.is_file().then(|| path.to_string_lossy().to_string())
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    /// "ready" | "missing" | "downloading" | "failed"
    pub state: String,
    /// "downloaded" | "system" | ""
    pub source: String,
    pub version: String,
    pub error: String,
}

fn status(app: &AppHandle, state: &AppState) -> SetupStatus {
    let settings = crate::commands::load_settings(state);
    let resource = app.path().resource_dir().ok();
    let found = crate::player::find_mpv(&settings.mpv_path, resource.as_deref());
    match found {
        Some(info) => {
            let ours = installed().is_some_and(|path| path == info.path);
            SetupStatus {
                state: "ready".into(),
                source: if ours { "downloaded".into() } else { "system".into() },
                version: info.version,
                error: String::new(),
            }
        }
        None => SetupStatus {
            state: if RUNNING.load(Ordering::SeqCst) {
                "downloading"
            } else {
                "missing"
            }
            .into(),
            source: String::new(),
            version: String::new(),
            error: String::new(),
        },
    }
}

#[tauri::command]
pub fn player_setup_status(app: AppHandle, state: State<'_, AppState>) -> SetupStatus {
    status(&app, &state)
}

/// Starts the download once. Returns false when it was already running.
#[tauri::command]
pub fn player_setup_start(app: AppHandle) -> bool {
    start(&app)
}

fn start(app: &AppHandle) -> bool {
    if RUNNING.swap(true, Ordering::SeqCst) {
        return false;
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let outcome = install(&handle).await;
        RUNNING.store(false, Ordering::SeqCst);
        match outcome {
            Ok(()) => emit(&handle, "ready", 1.0, ""),
            Err(error) => emit(&handle, "failed", 0.0, &error),
        }
    });
    true
}

/// First launch with no player: fetch one in the background, no prompt.
pub fn ensure(app: &AppHandle) {
    let state = app.state::<AppState>();
    if status(app, &state).state == "missing" {
        start(app);
    }
}

fn emit(app: &AppHandle, state: &str, progress: f64, error: &str) {
    let _ = app.emit(
        "player-setup",
        serde_json::json!({ "state": state, "progress": progress, "error": error }),
    );
}

async fn install(app: &AppHandle) -> Result<(), String> {
    let dir = dir().ok_or("The app data directory is unavailable.")?;
    // The shared client caps a whole request at 18s, which a 120 MB body would
    // blow through on a slow line. The player gets its own generous budget.
    let http = reqwest::Client::builder()
        .user_agent("BetterNuvio/0.1 (+https://github.com/better-nuvio)")
        .connect_timeout(std::time::Duration::from_secs(15))
        .timeout(std::time::Duration::from_secs(900))
        .build()
        .map_err(|e| format!("Cannot prepare the download: {e}"))?;

    if install_release(app, &http, &dir).await.is_ok() {
        return Ok(());
    }
    // The player release is not published yet: take the build it is cut from.
    install_pinned(app, &http, &dir).await
}

async fn install_release(
    app: &AppHandle,
    http: &reqwest::Client,
    dir: &Path,
) -> Result<(), String> {
    let manifest = http
        .get(format!("{RELEASE}/sha256.txt"))
        .send()
        .await
        .map_err(|e| format!("Cannot reach the player download: {e}"))?
        .error_for_status()
        .map_err(|e| format!("The player manifest is unavailable: {e}"))?
        .text()
        .await
        .map_err(|e| format!("The player manifest could not be read: {e}"))?;

    let files: Vec<(String, String)> = manifest
        .lines()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let hash = parts.next()?;
            let name = parts.next()?.trim_start_matches('*');
            (hash.len() == 64 && !name.is_empty()).then(|| (hash.to_string(), name.to_string()))
        })
        .collect();
    if files.is_empty() {
        return Err("The player manifest listed no files.".into());
    }

    for (index, (hash, name)) in files.iter().enumerate() {
        let target = dir.join(name);
        if verify(&target, hash) {
            continue;
        }
        let part = dir.join(format!("{name}.part"));
        fetch(app, http, name, &part, hash, index, files.len()).await?;
        std::fs::rename(&part, &target).map_err(|e| format!("Cannot install {name}: {e}"))?;
    }
    Ok(())
}

/// The upstream build the player release is cut from, checksum and all.
const PINNED: &str =
    "https://github.com/shinchiro/mpv-winbuild-cmake/releases/download/20261021/mpv-x86_64-20261021-git-e471496c56.7z";
const PINNED_SHA256: &str = "4a355f3e89c83fabc730d33fb4e759dfec747806ed2287b61a90d1681b83e8d3";
const PLAYER_FILES: [&str; 2] = ["mpv.exe", "d3dcompiler_43.dll"];

async fn install_pinned(
    app: &AppHandle,
    http: &reqwest::Client,
    dir: &Path,
) -> Result<(), String> {
    let mut response = http
        .get(PINNED)
        .send()
        .await
        .map_err(|e| format!("Cannot reach the player download: {e}"))?
        .error_for_status()
        .map_err(|e| format!("The player download is unavailable: {e}"))?;

    let size = response.content_length().unwrap_or(0);
    let archive = dir.join("mpv.7z");
    let mut file = std::fs::File::create(&archive).map_err(|e| format!("Cannot write the player: {e}"))?;
    let mut hasher = Sha256::new();
    let mut seen: u64 = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("The player download stalled: {e}"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| format!("Cannot write the player: {e}"))?;
        seen += chunk.len() as u64;
        if size > 0 {
            emit(app, "downloading", seen as f64 / size as f64, "");
        }
    }
    file.flush().map_err(|e| format!("Cannot write the player: {e}"))?;
    drop(file);

    if format!("{:x}", hasher.finalize()) != PINNED_SHA256 {
        let _ = std::fs::remove_file(&archive);
        return Err("The player download did not match its published checksum.".into());
    }

    // Windows ships bsdtar, which reads 7z; only the two files are unpacked.
    let status = crate::player::hidden_command("tar")
        .arg("-xf")
        .arg(&archive)
        .arg("-C")
        .arg(dir)
        .args(PLAYER_FILES)
        .status()
        .map_err(|e| format!("Cannot unpack the player: {e}"))?;
    let _ = std::fs::remove_file(&archive);
    if !status.success() {
        return Err("Cannot unpack the player archive.".into());
    }
    Ok(())
}

async fn fetch(
    app: &AppHandle,
    http: &reqwest::Client,
    name: &str,
    part: &Path,
    hash: &str,
    index: usize,
    total: usize,
) -> Result<(), String> {
    let mut response = http
        .get(format!("{RELEASE}/{name}"))
        .send()
        .await
        .map_err(|e| format!("Cannot download {name}: {e}"))?
        .error_for_status()
        .map_err(|e| format!("The download of {name} failed: {e}"))?;

    let size = response.content_length().unwrap_or(0);
    let mut file = std::fs::File::create(part).map_err(|e| format!("Cannot write {name}: {e}"))?;
    let mut hasher = Sha256::new();
    let mut seen: u64 = 0;

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("The download of {name} stalled: {e}"))?
    {
        hasher.update(&chunk);
        file.write_all(&chunk)
            .map_err(|e| format!("Cannot write {name}: {e}"))?;
        seen += chunk.len() as u64;
        let share = if size > 0 {
            seen as f64 / size as f64
        } else {
            0.0
        };
        emit(app, "downloading", (index as f64 + share) / total as f64, "");
    }

    file.flush().map_err(|e| format!("Cannot write {name}: {e}"))?;
    drop(file);

    if format!("{:x}", hasher.finalize()) != hash.to_ascii_lowercase() {
        let _ = std::fs::remove_file(part);
        return Err(format!("{name} did not match its published checksum."));
    }
    Ok(())
}

fn verify(path: &Path, hash: &str) -> bool {
    let Ok(mut file) = std::fs::File::open(path) else {
        return false;
    };
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1 << 16];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => hasher.update(&buffer[..read]),
            Err(_) => return false,
        }
    }
    format!("{:x}", hasher.finalize()) == hash.to_ascii_lowercase()
}
