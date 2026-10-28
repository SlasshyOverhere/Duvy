//! Debrid resolution: turn a cached/torrent link into a direct HTTPS stream.
//!
//! The account keys live in the `settings` table as one blob under `debrid`,
//! shaped `{ "realdebrid": "...", "alldebrid": "...", ... }`. SQLite is only
//! touched synchronously: the blob is loaded, the lock dropped, then the HTTP
//! calls run. Each provider answers with a different JSON shape, so every
//! response has a small pure parser below that the unit tests pin down.

use crate::{db, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
use tauri::State;
use tokio::time::sleep;

const KEY_BLOB: &str = "debrid";
const PROVIDERS: [(&str, &str); 4] = [
    ("realdebrid", "Real-Debrid"),
    ("alldebrid", "AllDebrid"),
    ("premiumize", "Premiumize"),
    ("torbox", "TorBox"),
];

/// Domains whose links a provider can unrestrict. Anything else is already playable.
const UNRESTRICT_HOSTS: [(&str, &[&str]); 3] = [
    ("realdebrid", &["real-debrid.com"]),
    ("alldebrid", &["alldebrid.com", "alldebrid.fr"]),
    ("premiumize", &["premiumize.me"]),
];

const RD_API: &str = "https://api.real-debrid.com/rest/1.0";
const AD_API: &str = "https://api.alldebrid.com/v4";
const PM_API: &str = "https://www.premiumize.me/api";
const TB_API: &str = "https://api.torbox.app/v1/api";

/// How long `resolve` waits for a provider to finish downloading before giving up.
const POLL_WINDOW: Duration = Duration::from_secs(30);
const POLL_INTERVAL: Duration = Duration::from_secs(1);
const STILL_DOWNLOADING: &str =
    "The torrent is still downloading on the debrid account. Try again in a minute.";

const VIDEO_EXT: [&str; 14] = [
    "mkv", "mp4", "avi", "mov", "m4v", "webm", "ts", "m2ts", "mpg", "mpeg", "wmv", "flv", "ogv",
    "3gp",
];

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: String,
    pub name: String,
    pub connected: bool,
}

// ---------------------------------------------------------------------------
// Stored keys
// ---------------------------------------------------------------------------

fn label(provider: &str) -> &'static str {
    PROVIDERS
        .iter()
        .find(|(id, _)| *id == provider)
        .map(|(_, name)| *name)
        .unwrap_or("Debrid")
}

/// Accepts `realdebrid`, `real-debrid`, `Real Debrid`, and similar spellings.
fn canonical(provider: &str) -> Option<&'static str> {
    let id: String = provider
        .trim()
        .to_ascii_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect();
    PROVIDERS
        .iter()
        .map(|(known, _)| *known)
        .find(|known| *known == id)
}

fn load_keys(state: &AppState) -> serde_json::Map<String, Value> {
    let Ok(conn) = state.db.0.lock() else {
        return Default::default();
    };
    db::read_kv(&conn, KEY_BLOB)
        .ok()
        .flatten()
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn store_keys(
    state: &AppState,
    keys: &serde_json::Map<String, Value>,
) -> Result<(), String> {
    let conn = state
        .db
        .0
        .lock()
        .map_err(|_| "The local database is locked.".to_string())?;
    db::write_kv(&conn, KEY_BLOB, &Value::Object(keys.clone())).map_err(|e| e.to_string())
}

fn stored_keys(state: &AppState) -> Vec<(String, String)> {
    let keys = load_keys(state);
    PROVIDERS
        .iter()
        .filter_map(|(id, _)| {
            let key = keys.get(*id)?.as_str()?.trim();
            (!key.is_empty()).then(|| ((*id).to_string(), key.to_string()))
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn providers(state: State<'_, AppState>) -> Result<Vec<Provider>, String> {
    let keys = load_keys(state.inner());
    Ok(PROVIDERS
        .iter()
        .map(|(id, name)| Provider {
            id: (*id).to_string(),
            name: (*name).to_string(),
            connected: keys
                .get(*id)
                .and_then(Value::as_str)
                .is_some_and(|key| !key.trim().is_empty()),
        })
        .collect())
}

#[tauri::command]
pub async fn set_key(
    provider: String,
    key: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let id = canonical(&provider).ok_or("Unknown debrid provider.")?;
    let key = key.trim().to_string();

    let mut keys = load_keys(state.inner());
    if key.is_empty() {
        keys.remove(id);
        return store_keys(state.inner(), &keys);
    }

    let http = state.http.clone();
    verify_key(&http, id, &key).await?;
    keys.insert(id.to_string(), Value::String(key));
    store_keys(state.inner(), &keys)
}

/// Resolve a magnet, an info hash, or an HTTP link into a direct playable URL.
#[tauri::command]
pub async fn resolve(url: String, state: State<'_, AppState>) -> Result<String, String> {
    let source = url.trim().to_string();
    if source.is_empty() {
        return Err("Nothing to resolve.".into());
    }

    let accounts = stored_keys(state.inner());

    if is_http(&source) {
        // A plain stream is already playable; only provider-hosted links need a round trip.
        let targets = unrestrict_targets(accounts, &source);
        if targets.is_empty() {
            return Ok(source);
        }
        let http = state.http.clone();
        let mut last = String::new();
        for (id, key) in &targets {
            match unrestrict(&http, id, key, &source).await {
                Ok(link) => return Ok(link),
                Err(message) => last = message,
            }
        }
        return Err(if last.is_empty() {
            "No connected debrid account could unrestrict that link.".into()
        } else {
            last
        });
    }

    if accounts.is_empty() {
        return Err("No debrid account is connected. Add a key on the Debrid screen.".into());
    }
    let http = state.http.clone();

    let magnet = to_magnet(&source);
    if !is_magnet(&magnet) {
        return Err("Paste a magnet link, an info hash or an HTTP link.".into());
    }

    // Cached torrents start streaming immediately, so try those providers first.
    let mut ordered = accounts;
    if ordered.len() > 1 {
        // Read-only probes, so they run together; index keeps the original
        // order among accounts with the same cache answer.
        let mut set = tokio::task::JoinSet::new();
        for (index, account) in ordered.drain(..).enumerate() {
            let http = http.clone();
            let magnet = magnet.clone();
            set.spawn(async move {
                let cached = is_cached(&http, &account.0, &account.1, &magnet).await;
                (index, cached, account)
            });
        }
        let mut ranked = Vec::new();
        while let Some(joined) = set.join_next().await {
            if let Ok(entry) = joined {
                ranked.push(entry);
            }
        }
        ranked.sort_by_key(|(index, cached, _)| (!*cached, *index));
        ordered = ranked
            .into_iter()
            .map(|(_, _, account)| account)
            .collect();
    }

    let mut last = String::new();
    let hint = file_index(&magnet);
    for (id, key) in &ordered {
        match resolve_torrent(&http, id, key, &magnet, hint).await {
            Ok(link) => return Ok(link),
            Err(message) => last = message,
        }
    }
    Err(if last.is_empty() {
        STILL_DOWNLOADING.into()
    } else {
        last
    })
}

/// Cheap cache probe across every connected account. Not wired into
/// `generate_handler!` yet, so add it there before calling it from the UI.
#[allow(dead_code)]
#[tauri::command]
pub async fn check_cache(source: String, state: State<'_, AppState>) -> Result<bool, String> {
    let source = source.trim();
    if source.is_empty() {
        return Ok(false);
    }
    let magnet = to_magnet(source);
    let http = state.http.clone();
    for (id, key) in stored_keys(state.inner()) {
        if is_cached(&http, &id, &key, &magnet).await {
            return Ok(true);
        }
    }
    Ok(false)
}

// ---------------------------------------------------------------------------
// Source handling
// ---------------------------------------------------------------------------

fn is_http(source: &str) -> bool {
    let lower = source.trim().to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
}

fn is_magnet(source: &str) -> bool {
    let bytes = source.trim().as_bytes();
    bytes.len() > 7 && bytes[..7].eq_ignore_ascii_case(b"magnet:")
}

/// Info hash from a magnet (`xt=urn:btih:...`) or from a bare 40-hex / 32-base32 hash.
fn info_hash(source: &str) -> Option<String> {
    let source = source.trim();
    for part in source.split(['?', '&']) {
        let Some((name, value)) = part.split_once('=') else {
            continue;
        };
        if !name.eq_ignore_ascii_case("xt") {
            continue;
        }
        let hash = value.rsplit(':').next().unwrap_or_default().trim();
        if hash.len() == 40 || hash.len() == 32 {
            return Some(hash.to_string());
        }
    }
    let bare = matches!(source.len(), 40 | 32) && source.bytes().all(|b| b.is_ascii_alphanumeric());
    bare.then(|| source.to_string())
}

/// `fileIdx=<n>` from the magnet the UI builds for a pack.
fn file_index(source: &str) -> Option<usize> {
    source
        .split(['?', '&'])
        .filter_map(|part| part.split_once('='))
        .find(|(name, _)| name.eq_ignore_ascii_case("fileIdx"))
        .and_then(|(_, value)| value.trim().parse().ok())
}

fn to_magnet(source: &str) -> String {
    let source = source.trim();
    if is_magnet(source) {
        return source.to_string();
    }
    match info_hash(source) {
        Some(hash) => format!("magnet:?xt=urn:btih:{hash}"),
        None => source.to_string(),
    }
}

// ---------------------------------------------------------------------------
// File selection
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, PartialEq)]
struct FileEntry {
    /// What the provider needs to hand out this file: a file id or a direct link.
    key: String,
    name: String,
    bytes: u64,
}

fn is_video(name: &str) -> bool {
    let ext = name.rsplit('.').next().unwrap_or_default().to_ascii_lowercase();
    VIDEO_EXT.contains(&ext.as_str())
}

fn pick_largest_video(files: &[FileEntry]) -> Option<&FileEntry> {
    files.iter().filter(|file| is_video(&file.name)).max_by_key(|file| file.bytes)
}

/// Stremio's `fileIdx` is a 0-based index into the torrent's file list. It only
/// wins when it lands on a video, so a filtered list falls back to the largest.
fn pick_video<'a>(files: &'a [FileEntry], hint: Option<usize>) -> Option<&'a FileEntry> {
    hint.and_then(|index| files.get(index))
        .filter(|file| is_video(&file.name))
        .or_else(|| pick_largest_video(files))
}

// ---------------------------------------------------------------------------
// Normalised provider state
// ---------------------------------------------------------------------------

#[derive(Debug, Default, PartialEq)]
struct TorrentState {
    status: String,
    files: Vec<FileEntry>,
    /// Links the provider already generated (Real-Debrid only).
    links: Vec<String>,
}

fn scalar(value: &Value, field: &str) -> Option<String> {
    match value.get(field)? {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        Value::Number(number) => Some(number.to_string()),
        _ => None,
    }
}

fn parse_rd_info(value: &Value) -> TorrentState {
    let files = value
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    Some(FileEntry {
                        key: scalar(file, "id")?,
                        name: file.get("path").and_then(Value::as_str).unwrap_or_default().into(),
                        bytes: file.get("bytes").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    TorrentState {
        status: value
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase(),
        files,
        links: value
            .get("links")
            .and_then(Value::as_array)
            .map(|links| {
                links
                    .iter()
                    .filter_map(|link| link.as_str().map(str::to_string))
                    .collect()
            })
            .unwrap_or_default(),
    }
}

#[derive(Debug, Default, PartialEq)]
struct AdStatus {
    status: String,
    code: i64,
    /// `key` holds the locked link that `/link/unlock` takes.
    links: Vec<FileEntry>,
}

fn parse_ad_status(value: &Value) -> AdStatus {
    let magnets = value.pointer("/data/magnets").cloned().unwrap_or(Value::Null);
    let item = if magnets.is_array() {
        magnets.get(0).cloned().unwrap_or(Value::Null)
    } else {
        magnets
    };
    AdStatus {
        status: item
            .get("status")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_ascii_lowercase(),
        code: item.get("statusCode").and_then(Value::as_i64).unwrap_or(0),
        links: item
            .get("links")
            .and_then(Value::as_array)
            .map(|links| {
                links
                    .iter()
                    .filter_map(|link| {
                        Some(FileEntry {
                            key: link.get("link").and_then(Value::as_str)?.to_string(),
                            name: link
                                .get("filename")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                                .into(),
                            bytes: link.get("size").and_then(Value::as_u64).unwrap_or(0),
                        })
                    })
                    .collect()
            })
            .unwrap_or_default(),
    }
}

/// `/transfer/directdl` content list: `key` holds the direct link.
fn parse_pm_content(value: &Value) -> Vec<FileEntry> {
    value
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(FileEntry {
                        key: item.get("link").and_then(Value::as_str)?.to_string(),
                        name: item.get("path").and_then(Value::as_str).unwrap_or_default().into(),
                        bytes: item.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

#[derive(Debug, Default, PartialEq)]
enum PmTransfer {
    #[default]
    Pending,
    Finished,
    Failed,
}

fn parse_pm_transfer(value: &Value, id: &str) -> PmTransfer {
    let Some(transfer) = value
        .get("transfers")
        .and_then(Value::as_array)
        .and_then(|transfers| {
            transfers
                .iter()
                .find(|transfer| scalar(transfer, "id").as_deref() == Some(id))
        })
    else {
        return PmTransfer::Pending;
    };
    match transfer.get("status").and_then(Value::as_str).unwrap_or_default() {
        "finished" => PmTransfer::Finished,
        "error" | "deleted" | "timeout" => PmTransfer::Failed,
        _ => PmTransfer::Pending,
    }
}

fn parse_tb_torrent(value: &Value) -> Option<TorrentState> {
    let data = value.get("data")?;
    let item = if data.is_object() {
        data
    } else {
        data.as_array()?.first()?
    };
    // `download_present` is the only flag that means "streamable now"; a cached
    // torrent can sit there without ever reporting `download_finished`.
    let ready = item.get("download_present").and_then(Value::as_bool).unwrap_or(false)
        || item.get("download_finished").and_then(Value::as_bool).unwrap_or(false)
        || item
            .get("download_state")
            .and_then(Value::as_str)
            .is_some_and(|state| state.eq_ignore_ascii_case("downloaded"));
    let files = item
        .get("files")
        .and_then(Value::as_array)
        .map(|files| {
            files
                .iter()
                .filter_map(|file| {
                    Some(FileEntry {
                        key: scalar(file, "id")?,
                        name: file.get("name").and_then(Value::as_str).unwrap_or_default().into(),
                        bytes: file.get("size").and_then(Value::as_u64).unwrap_or(0),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    Some(TorrentState {
        status: if ready {
            "downloaded".into()
        } else {
            item.get("download_state")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_ascii_lowercase()
        },
        files,
        links: Vec::new(),
    })
}

// ---------------------------------------------------------------------------
// Cache probes
// ---------------------------------------------------------------------------

fn parse_rd_cached(value: &Value) -> bool {
    value
        .as_object()
        .is_some_and(|hosts| {
            hosts.values().any(|host| {
                host.get("rd")
                    .and_then(Value::as_array)
                    .is_some_and(|variants| {
                        variants.iter().any(|variant| {
                            variant.as_object().is_some_and(|files| !files.is_empty())
                        })
                    })
            })
        })
}

fn parse_ad_cached(value: &Value) -> bool {
    value
        .pointer("/data/magnets")
        .and_then(Value::as_array)
        .is_some_and(|magnets| {
            magnets
                .iter()
                .any(|magnet| magnet.get("instant").and_then(Value::as_bool).unwrap_or(false))
        })
}

fn parse_pm_cached(value: &Value) -> bool {
    value
        .get("response")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

fn parse_tb_cached(value: &Value) -> bool {
    match value.get("data") {
        Some(Value::Object(map)) => !map.is_empty(),
        Some(Value::Array(items)) => !items.is_empty(),
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// Error envelopes
// ---------------------------------------------------------------------------

/// Pull a message out of any of the four providers' error shapes.
fn api_error(value: &Value) -> Option<String> {
    let text = |value: &Value| {
        value
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_string)
    };
    // AllDebrid: { status: "error", error: { code, message } }
    if let Some(message) = value.get("error").and_then(|error| error.get("message")).and_then(text) {
        return Some(message);
    }
    // Real-Debrid: { error: "bad_token" }
    if let Some(message) = value.get("error").and_then(text) {
        return Some(message);
    }
    // TorBox: { success: false, detail: "..." }
    if value.get("success").and_then(Value::as_bool) == Some(false) {
        for field in ["detail", "message", "error"] {
            if let Some(message) = value.get(field).and_then(text) {
                return Some(message);
            }
        }
        return Some("The debrid service rejected the request.".into());
    }
    // Premiumize: { status: "error", message: "..." }
    if value.get("status").and_then(Value::as_str) == Some("error") {
        return value.get("message").and_then(text);
    }
    None
}

fn session_ok(provider: &str, value: &Value) -> bool {
    match provider {
        "realdebrid" => value.get("id").is_some() || scalar(value, "username").is_some(),
        "alldebrid" => {
            value.get("status").and_then(Value::as_str) == Some("success") && value.get("data").is_some()
        }
        "premiumize" => value.get("status").and_then(Value::as_str) == Some("success"),
        _ => value.get("success").and_then(Value::as_bool) == Some(true),
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn offline(error: reqwest::Error) -> String {
    format!("Could not reach the debrid service: {error}")
}

fn request(
    http: &reqwest::Client,
    method: reqwest::Method,
    provider: &str,
    key: &str,
    url: &str,
) -> reqwest::RequestBuilder {
    let builder = http.request(method, url);
    match provider {
        "alldebrid" => builder.query(&[("agent", "BetterNuvio")]).bearer_auth(key),
        "premiumize" => builder.query(&[("apikey", key)]),
        _ => builder.bearer_auth(key),
    }
}

fn get(
    http: &reqwest::Client,
    provider: &str,
    key: &str,
    url: &str,
) -> reqwest::RequestBuilder {
    request(http, reqwest::Method::GET, provider, key, url)
}

fn post(
    http: &reqwest::Client,
    provider: &str,
    key: &str,
    url: &str,
) -> reqwest::RequestBuilder {
    request(http, reqwest::Method::POST, provider, key, url)
}

async fn reply(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let body = response
        .text()
        .await
        .map_err(|error| format!("Could not read the debrid reply: {error}"))?;
    let value: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
    if status.is_success() {
        if let Some(message) = api_error(&value) {
            return Err(message);
        }
        return Ok(value);
    }
    let message = api_error(&value)
        .or_else(|| value.get("detail").and_then(Value::as_str).map(str::to_string))
        .or_else(|| value.get("message").and_then(Value::as_str).map(str::to_string));
    Err(message.unwrap_or_else(|| format!("The debrid service answered {status}.")))
}

async fn get_json(http: &reqwest::Client, provider: &str, key: &str, url: &str) -> Result<Value, String> {
    let response = get(http, provider, key, url).send().await.map_err(offline)?;
    reply(response).await
}

async fn verify_key(http: &reqwest::Client, provider: &str, key: &str) -> Result<(), String> {
    let url = match provider {
        "realdebrid" => format!("{RD_API}/user"),
        "alldebrid" => format!("{AD_API}/user"),
        "premiumize" => format!("{PM_API}/account/info"),
        _ => format!("{TB_API}/user/me"),
    };
    let value = get_json(http, provider, key, &url)
        .await
        .map_err(|message| format!("{} rejected that key: {message}", label(provider)))?;
    if session_ok(provider, &value) {
        Ok(())
    } else {
        Err(format!("{} rejected that key.", label(provider)))
    }
}

// ---------------------------------------------------------------------------
// Real-Debrid
// ---------------------------------------------------------------------------

async fn rd_unrestrict(http: &reqwest::Client, key: &str, link: &str) -> Result<String, String> {
    let value = reply(
        post(http, "realdebrid", key, &format!("{RD_API}/unrestrict/link"))
            .form(&[("link", link)])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    scalar(&value, "download").ok_or_else(|| "Real-Debrid did not return a download link.".to_string())
}

async fn rd_resolve(
    http: &reqwest::Client,
    key: &str,
    magnet: &str,
    hint: Option<usize>,
) -> Result<String, String> {
    let added = reply(
        post(http, "realdebrid", key, &format!("{RD_API}/torrents/addMagnet"))
            .form(&[("magnet", magnet)])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    let id = scalar(&added, "id").ok_or_else(|| "Real-Debrid did not return a torrent id.".to_string())?;

    let deadline = Instant::now() + POLL_WINDOW;
    let mut selected = false;
    loop {
        let info = get_json(
            http,
            "realdebrid",
            key,
            &format!("{RD_API}/torrents/info/{id}"),
        )
        .await?;
        let state = parse_rd_info(&info);
        match state.status.as_str() {
            "downloaded" => {
                let link = state.links.first().ok_or_else(|| {
                    "Real-Debrid marked the torrent ready but returned no link.".to_string()
                })?;
                return rd_unrestrict(http, key, link).await;
            }
            "waiting_files_selection" if !selected => {
                let file = pick_video(&state.files, hint)
                    .ok_or_else(|| "That torrent contains no video file.".to_string())?;
                reply(
                    post(
                        http,
                        "realdebrid",
                        key,
                        &format!("{RD_API}/torrents/selectFiles/{id}"),
                    )
                    .form(&[("files", file.key.as_str())])
                    .send()
                    .await
                    .map_err(offline)?,
                )
                .await?;
                selected = true;
            }
            "magnet_error" | "error" | "dead" | "virus" => {
                return Err(format!("Real-Debrid could not load that torrent ({})", state.status));
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err(STILL_DOWNLOADING.into());
        }
        sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// AllDebrid
// ---------------------------------------------------------------------------

async fn ad_unlock(http: &reqwest::Client, key: &str, link: &str) -> Result<String, String> {
    let value = reply(
        get(http, "alldebrid", key, &format!("{AD_API}/link/unlock"))
            .query(&[("link", link)])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    value
        .pointer("/data/link")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "AllDebrid did not return a direct link.".to_string())
}

async fn ad_resolve(
    http: &reqwest::Client,
    key: &str,
    magnet: &str,
    hint: Option<usize>,
) -> Result<String, String> {
    let uploaded = reply(
        get(http, "alldebrid", key, &format!("{AD_API}/magnet/upload"))
            .query(&[("magnets[]", magnet)])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    let item = uploaded.pointer("/data/magnets/0").cloned().unwrap_or(Value::Null);
    let id = scalar(&item, "id")
        .or_else(|| scalar(&item, "magnet"))
        .ok_or_else(|| "AllDebrid did not return a magnet id.".to_string())?;

    let deadline = Instant::now() + POLL_WINDOW;
    loop {
        let value = reply(
            get(http, "alldebrid", key, &format!("{AD_API}/magnet/status"))
                .query(&[("id", id.as_str())])
                .send()
                .await
                .map_err(offline)?,
        )
        .await?;
        let state = parse_ad_status(&value);
        if state.status == "ready" || state.code == 4 {
            let file = pick_video(&state.links, hint)
                .ok_or_else(|| "That torrent contains no video file.".to_string())?;
            return ad_unlock(http, key, &file.key).await;
        }
        if state.status.contains("error") {
            return Err(format!("AllDebrid could not load that torrent ({})", state.status));
        }
        if Instant::now() >= deadline {
            return Err(STILL_DOWNLOADING.into());
        }
        sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// Premiumize
// ---------------------------------------------------------------------------

/// One-shot resolve for cached content: returns the chosen video's direct link.
async fn pm_direct(
    http: &reqwest::Client,
    key: &str,
    source: &str,
    hint: Option<usize>,
) -> Result<String, String> {
    let value = reply(
        post(http, "premiumize", key, &format!("{PM_API}/transfer/directdl"))
            .form(&[("src", source)])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    let files = parse_pm_content(&value);
    let file = pick_video(&files, hint)
        .ok_or_else(|| "Premiumize did not return a video file for that source.".to_string())?;
    Ok(file.key.clone())
}

async fn pm_resolve(
    http: &reqwest::Client,
    key: &str,
    magnet: &str,
    hint: Option<usize>,
) -> Result<String, String> {
    if let Ok(link) = pm_direct(http, key, magnet, hint).await {
        return Ok(link);
    }

    // Not cached yet: queue the transfer and wait for it to finish.
    let created = reply(
        post(http, "premiumize", key, &format!("{PM_API}/transfer/create"))
            .form(&[("src", magnet)])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    let id = scalar(&created, "id")
        .ok_or_else(|| "Premiumize did not return a transfer id.".to_string())?;

    let deadline = Instant::now() + POLL_WINDOW;
    loop {
        let list = get_json(http, "premiumize", key, &format!("{PM_API}/transfer/list")).await?;
        match parse_pm_transfer(&list, &id) {
            PmTransfer::Finished => return pm_direct(http, key, magnet, hint).await,
            PmTransfer::Failed => {
                return Err("Premiumize could not load that torrent.".to_string())
            }
            PmTransfer::Pending => {}
        }
        if Instant::now() >= deadline {
            return Err(STILL_DOWNLOADING.into());
        }
        sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// TorBox
// ---------------------------------------------------------------------------

async fn tb_request(
    http: &reqwest::Client,
    key: &str,
    torrent: &str,
    file: &str,
) -> Result<String, String> {
    let value = reply(
        post(http, "torbox", key, &format!("{TB_API}/torrents/requestdl"))
            .query(&[
                ("token", key),
                ("torrent_id", torrent),
                ("file_id", file),
                ("zip_link", "false"),
            ])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    match value.get("data") {
        Some(Value::String(link)) => Ok(link.clone()),
        _ => Err("TorBox did not return a direct link.".to_string()),
    }
}

async fn tb_resolve(
    http: &reqwest::Client,
    key: &str,
    magnet: &str,
    hint: Option<usize>,
) -> Result<String, String> {
    let created = reply(
        post(http, "torbox", key, &format!("{TB_API}/torrents/createtorrent"))
            .form(&[("magnet", magnet), ("allow_zip", "false")])
            .send()
            .await
            .map_err(offline)?,
    )
    .await?;
    let id = created
        .get("data")
        .and_then(|data| {
            scalar(data, "torrent_id")
                .or_else(|| scalar(data, "id"))
                .or_else(|| data.as_i64().map(|id| id.to_string()))
        })
        .or_else(|| scalar(&created, "torrent_id"))
        .ok_or_else(|| "TorBox did not return a torrent id.".to_string())?;

    let deadline = Instant::now() + POLL_WINDOW;
    loop {
        let list = reply(
            get(http, "torbox", key, &format!("{TB_API}/torrents/mylist"))
                .query(&[("id", id.as_str()), ("bypass_cache", "true")])
                .send()
                .await
                .map_err(offline)?,
        )
        .await?;
        let state = parse_tb_torrent(&list)
            .ok_or_else(|| "TorBox did not return that torrent.".to_string())?;
        if state.status == "downloaded" {
            let file = pick_video(&state.files, hint)
                .ok_or_else(|| "That torrent contains no video file.".to_string())?;
            return tb_request(http, key, &id, &file.key).await;
        }
        if matches!(
            state.status.as_str(),
            "error" | "failed" | "missingfiles" | "missing_files"
        ) {
            return Err(format!("TorBox could not load that torrent ({})", state.status));
        }
        if Instant::now() >= deadline {
            return Err(STILL_DOWNLOADING.into());
        }
        sleep(POLL_INTERVAL).await;
    }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async fn resolve_torrent(
    http: &reqwest::Client,
    provider: &str,
    key: &str,
    magnet: &str,
    hint: Option<usize>,
) -> Result<String, String> {
    match provider {
        "realdebrid" => rd_resolve(http, key, magnet, hint).await,
        "alldebrid" => ad_resolve(http, key, magnet, hint).await,
        "premiumize" => pm_resolve(http, key, magnet, hint).await,
        _ => tb_resolve(http, key, magnet, hint).await,
    }
}

async fn unrestrict(
    http: &reqwest::Client,
    provider: &str,
    key: &str,
    link: &str,
) -> Result<String, String> {
    match provider {
        "realdebrid" => rd_unrestrict(http, key, link).await,
        "alldebrid" => ad_unlock(http, key, link).await,
        "premiumize" => pm_direct(http, key, link, None).await,
        _ => Err("TorBox cannot unrestrict a plain HTTP link; use a magnet.".into()),
    }
}

/// True when the link lives on a domain the provider itself hands out.
fn can_unrestrict(provider: &str, link: &str) -> bool {
    let Ok(url) = url::Url::parse(link.trim()) else {
        return false;
    };
    if !matches!(url.scheme(), "http" | "https") {
        return false;
    }
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_ascii_lowercase();
    UNRESTRICT_HOSTS
        .iter()
        .find(|(id, _)| *id == provider)
        .is_some_and(|(_, domains)| {
            domains
                .iter()
                .any(|domain| host == *domain || host.ends_with(&format!(".{domain}")))
        })
}

fn unrestrict_targets(
    accounts: Vec<(String, String)>,
    link: &str,
) -> Vec<(String, String)> {
    accounts
        .into_iter()
        .filter(|(id, _)| can_unrestrict(id, link))
        .collect()
}

async fn is_cached(http: &reqwest::Client, provider: &str, key: &str, source: &str) -> bool {
    let hash = info_hash(source);
    let (url, query): (String, Vec<(&str, &str)>) = match provider {
        "realdebrid" => {
            let Some(hash) = hash.as_deref() else {
                return false;
            };
            (format!("{RD_API}/torrents/instantAvailability/{hash}"), vec![])
        }
        "alldebrid" => (format!("{AD_API}/magnet/instant"), vec![("magnets[]", source)]),
        "premiumize" => (format!("{PM_API}/cache/check"), vec![("items[]", source)]),
        _ => {
            let Some(hash) = hash.as_deref() else {
                return false;
            };
            (format!("{TB_API}/torrents/checkcached"), vec![("hash", hash)])
        }
    };

    let response = match get(http, provider, key, &url).query(&query).send().await {
        Ok(response) => response,
        Err(_) => return false,
    };
    let Ok(value) = reply(response).await else {
        return false;
    };
    match provider {
        "realdebrid" => parse_rd_cached(&value),
        "alldebrid" => parse_ad_cached(&value),
        "premiumize" => parse_pm_cached(&value),
        _ => parse_tb_cached(&value),
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn info_hash_reads_magnets_and_bare_hashes() {
        let hash = "2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e";
        assert_eq!(
            info_hash(&format!("magnet:?xt=urn:btih:{hash}&dn=Some.Movie.2019")),
            Some(hash.to_string())
        );
        assert_eq!(info_hash(hash), Some(hash.to_string()));
        assert_eq!(
            info_hash("MAGNET:?XT=URN:BTIH:2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D5E"),
            Some("2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D5E".to_string())
        );
        assert_eq!(info_hash("not a hash"), None);
        assert_eq!(to_magnet(hash), format!("magnet:?xt=urn:btih:{hash}"));
    }

    #[test]
    fn largest_video_wins_and_non_video_is_ignored() {
        let files = sample_files();
        let picked = pick_largest_video(&files).expect("a video file");
        assert_eq!(picked.name, "Show/Show.S01E02.1080p.mkv");

        let only_extras = vec![
            FileEntry { key: "1".into(), name: "Show.nfo".into(), bytes: 40 },
            FileEntry { key: "2".into(), name: "Show.srt".into(), bytes: 90 },
        ];
        assert!(pick_largest_video(&only_extras).is_none());
    }

    #[test]
    fn file_index_prefers_the_requested_episode() {
        let files = sample_files();
        assert_eq!(file_index("magnet:?xt=urn:btih:abc&fileIdx=2"), Some(2));
        assert_eq!(file_index("magnet:?xt=urn:btih:abc&FILEIDX=0"), Some(0));
        assert_eq!(file_index("magnet:?xt=urn:btih:abc"), None);
        assert_eq!(file_index("magnet:?xt=urn:btih:abc&fileIdx=x"), None);

        // A real index wins even when a bigger file sits elsewhere in the pack.
        assert_eq!(pick_video(&files, Some(0)).unwrap().name, "Show/Show.S01E01.1080p.mkv");
        // A non-video or out-of-range index falls back to the largest video.
        assert_eq!(pick_video(&files, Some(3)).unwrap().name, "Show/Show.S01E02.1080p.mkv");
        assert_eq!(pick_video(&files, Some(99)).unwrap().name, "Show/Show.S01E02.1080p.mkv");
        assert_eq!(pick_video(&files, None).unwrap().name, "Show/Show.S01E02.1080p.mkv");
    }

    fn sample_files() -> Vec<FileEntry> {
        vec![
            FileEntry {
                key: "1".into(),
                name: "Show/Show.S01E01.1080p.mkv".into(),
                bytes: 1_500_000,
            },
            FileEntry {
                key: "2".into(),
                name: "Show/Show.S01E02.1080p.mkv".into(),
                bytes: 2_100_000,
            },
            FileEntry {
                key: "3".into(),
                name: "Show/Extras/Behind.The.Scenes.mkv".into(),
                bytes: 400_000,
            },
            FileEntry { key: "4".into(), name: "Show/Show.nfo".into(), bytes: 2_000 },
        ]
    }

    #[test]
    fn realdebrid_info_parses_status_files_and_links() {
        let payload = json!({
            "id": "ABC123",
            "status": "downloaded",
            "files": [
                { "id": 1, "path": "Movie/Movie.2019.1080p.mkv", "bytes": 4_000_000, "selected": 1 },
                { "id": 2, "path": "Movie/Movie.2019.1080p.nfo", "bytes": 900, "selected": 0 }
            ],
            "links": ["https://real-debrid.com/d/ABCDEF"]
        });
        let state = parse_rd_info(&payload);
        assert_eq!(state.status, "downloaded");
        assert_eq!(state.links, vec!["https://real-debrid.com/d/ABCDEF"]);
        assert_eq!(state.files.len(), 2);
        assert_eq!(pick_largest_video(&state.files).unwrap().key, "1");
    }

    #[test]
    fn realdebrid_unrestrict_link_is_extracted() {
        let payload = json!({
            "id": "ABCDEF",
            "filename": "Movie.2019.1080p.mkv",
            "filesize": 4_000_000,
            "download": "https://download.real-debrid.com/d/XYZ/Movie.mkv"
        });
        assert_eq!(
            scalar(&payload, "download").as_deref(),
            Some("https://download.real-debrid.com/d/XYZ/Movie.mkv")
        );
    }

    #[test]
    fn alldebrid_status_parses_ready_links() {
        let payload = json!({
            "status": "success",
            "data": { "magnets": {
                "id": 4242,
                "filename": "Movie.2019.1080p.mkv",
                "status": "Ready",
                "statusCode": 4,
                "files": [
                    { "n": "Movie.2019.1080p.mkv", "s": 4_000_000, "l": "https://alldebrid.com/f/AAA" }
                ],
                "links": [
                    { "link": "https://alldebrid.com/f/AAA", "filename": "Movie.2019.1080p.mkv", "size": 4_000_000 },
                    { "link": "https://alldebrid.com/f/BBB", "filename": "Movie.nfo", "size": 800 }
                ]
            } }
        });
        let state = parse_ad_status(&payload);
        assert_eq!(state.status, "ready");
        assert_eq!(state.code, 4);
        assert_eq!(pick_largest_video(&state.links).unwrap().key, "https://alldebrid.com/f/AAA");

        let unlocked = json!({ "status": "success", "data": { "link": "https://dl.alldebrid.com/x/Movie.mkv" } });
        assert_eq!(
            unlocked.pointer("/data/link").and_then(Value::as_str),
            Some("https://dl.alldebrid.com/x/Movie.mkv")
        );
    }

    #[test]
    fn premiumize_directdl_picks_the_main_video() {
        let payload = json!({
            "status": "success",
            "content": [
                { "path": "Show/E01.mkv", "size": 900_000, "link": "https://premiumize.me/file/a" },
                { "path": "Show/E02.mkv", "size": 1_400_000, "link": "https://premiumize.me/file/b" },
                { "path": "Show/info.nfo", "size": 400, "link": "https://premiumize.me/file/c" }
            ]
        });
        let files = parse_pm_content(&payload);
        assert_eq!(files.len(), 3);
        assert_eq!(pick_largest_video(&files).unwrap().key, "https://premiumize.me/file/b");
    }

    #[test]
    fn premiumize_transfer_status_is_read_by_id() {
        let payload = json!({
            "status": "success",
            "transfers": [
                { "id": "one", "status": "running" },
                { "id": "two", "status": "finished" }
            ]
        });
        assert_eq!(parse_pm_transfer(&payload, "two"), PmTransfer::Finished);
        assert_eq!(parse_pm_transfer(&payload, "one"), PmTransfer::Pending);
        assert_eq!(parse_pm_transfer(&payload, "missing"), PmTransfer::Pending);

        let failed = json!({ "transfers": [{ "id": "x", "status": "error" }] });
        assert_eq!(parse_pm_transfer(&failed, "x"), PmTransfer::Failed);
    }

    #[test]
    fn torbox_torrent_parses_download_state_and_files() {
        let payload = json!({
            "success": true,
            "data": {
                "id": 42,
                "download_finished": true,
                "download_state": "downloaded",
                "files": [
                    { "id": 7, "name": "Show.S01E01.1080p.mkv", "size": 2_000_000 },
                    { "id": 8, "name": "Show.S01E01.nfo", "size": 300 }
                ]
            }
        });
        let state = parse_tb_torrent(&payload).expect("torrent");
        assert_eq!(state.status, "downloaded");
        assert_eq!(pick_largest_video(&state.files).unwrap().key, "7");

        // Cached torrents report `download_present` without finishing a download.
        let cached = json!({
            "success": true,
            "data": {
                "id": 43,
                "download_present": true,
                "download_finished": false,
                "download_state": "cached",
                "files": [{ "id": 1, "name": "Show.S01E01.mkv", "size": 2_000_000 }]
            }
        });
        assert_eq!(parse_tb_torrent(&cached).unwrap().status, "downloaded");

        // A list response is accepted too (older /torrents/mylist shape).
        let list = json!({ "success": true, "data": [{ "id": 9, "download_state": "downloading", "files": [] }] });
        assert_eq!(parse_tb_torrent(&list).unwrap().status, "downloading");
    }

    #[test]
    fn torbox_direct_link_is_a_string_in_data() {
        let payload = json!({ "success": true, "data": "https://nexus.torbox.app/x/Show.mkv" });
        assert_eq!(
            payload.get("data").and_then(Value::as_str),
            Some("https://nexus.torbox.app/x/Show.mkv")
        );
    }

    #[test]
    fn cache_probes_read_each_provider_shape() {
        assert!(parse_rd_cached(&json!({
            "2B3C4D5E6F708192A3B4C5D6E7F8091A2B3C4D5E": {
                "rd": [{ "Movie.mkv": { "filesize": 4_000_000, "id": 1 } }]
            }
        })));
        assert!(!parse_rd_cached(&json!({ "HASH": {} })));
        assert!(!parse_rd_cached(&json!({ "HASH": { "rd": [] } })));

        assert!(parse_ad_cached(&json!({
            "status": "success",
            "data": { "magnets": [{ "magnet": "abc", "instant": true }] }
        })));
        assert!(!parse_ad_cached(&json!({
            "status": "success",
            "data": { "magnets": [{ "magnet": "abc", "instant": false }] }
        })));

        assert!(parse_pm_cached(&json!({ "status": "success", "response": [true] })));
        assert!(!parse_pm_cached(&json!({ "status": "success", "response": [false] })));

        assert!(parse_tb_cached(&json!({ "success": true, "data": { "HASH": { "name": "x" } } })));
        assert!(!parse_tb_cached(&json!({ "success": true, "data": null })));
    }

    #[test]
    fn provider_errors_are_unwrapped() {
        assert_eq!(
            api_error(&json!({ "status": "error", "error": { "code": "MAGNET_INVALID", "message": "Invalid magnet" } })),
            Some("Invalid magnet".to_string())
        );
        assert_eq!(
            api_error(&json!({ "error": "bad_token" })),
            Some("bad_token".to_string())
        );
        assert_eq!(
            api_error(&json!({ "success": false, "detail": "Invalid API key" })),
            Some("Invalid API key".to_string())
        );
        assert_eq!(
            api_error(&json!({ "status": "error", "message": "Not premium" })),
            Some("Not premium".to_string())
        );
        assert_eq!(api_error(&json!({ "status": "success", "response": [true] })), None);
    }

    #[test]
    fn account_endpoints_are_recognised() {
        assert!(session_ok("realdebrid", &json!({ "id": 1, "username": "someone" })));
        assert!(!session_ok("realdebrid", &json!({ "error": "bad_token" })));
        assert!(session_ok(
            "alldebrid",
            &json!({ "status": "success", "data": { "user": { "username": "someone" } } })
        ));
        assert!(session_ok("premiumize", &json!({ "status": "success", "customer_id": "1" })));
        assert!(session_ok("torbox", &json!({ "success": true, "data": { "id": 1 } })));
        assert!(!session_ok("torbox", &json!({ "success": false, "detail": "nope" })));
    }

    #[test]
    fn source_classification() {
        assert!(is_http("https://example.com/file.mkv"));
        assert!(is_http("HTTP://example.com"));
        assert!(!is_http("magnet:?xt=urn:btih:abc"));
        assert!(is_magnet("magnet:?xt=urn:btih:abc"));
        assert!(!is_magnet("https://example.com"));
        assert!(canonical("Real-Debrid").is_some());
        assert_eq!(canonical("real_debrid"), Some("realdebrid"));
        assert_eq!(canonical("torrentio"), None);
    }

    fn sample_accounts() -> Vec<(String, String)> {
        PROVIDERS
            .iter()
            .map(|(id, _)| ((*id).to_string(), format!("{id}-key")))
            .collect()
    }

    #[test]
    fn direct_http_streams_pass_through_untouched() {
        assert!(unrestrict_targets(sample_accounts(), "https://cdn.example.com/Movie.1080p.mkv").is_empty());
        assert!(unrestrict_targets(
            sample_accounts(),
            "http://stream.example.net:8080/live/index.m3u8?token=abc"
        )
        .is_empty());
        // TorBox links are already direct downloads, so they are never un-restricted.
        assert!(unrestrict_targets(sample_accounts(), "https://nexus.torbox.app/x/Show.mkv").is_empty());
    }

    #[test]
    fn debrid_hosted_links_are_still_resolvable() {
        let links = [
            ("realdebrid", "https://real-debrid.com/d/ABCDEF"),
            ("alldebrid", "https://alldebrid.com/f/AAA"),
            ("premiumize", "https://download.premiumize.me/file/b.mkv"),
        ];
        for (provider, link) in links {
            assert!(can_unrestrict(provider, link), "{provider} should handle {link}");
            let targets = unrestrict_targets(sample_accounts(), link);
            assert_eq!(targets.len(), 1);
            assert_eq!(targets[0].0, provider);
        }
    }

    #[test]
    fn unhandled_links_never_reach_the_provider() {
        assert!(!can_unrestrict("torbox", "https://real-debrid.com/d/ABCDEF"));
        assert!(!can_unrestrict("realdebrid", "https://alldebrid.com/f/AAA"));
        // Spoofed hosts and odd schemes are not provider links.
        assert!(!can_unrestrict("realdebrid", "https://real-debrid.com.evil.test/d/x"));
        assert!(!can_unrestrict("premiumize", "ftp://premiumize.me/file/a.mkv"));
        assert!(!can_unrestrict("realdebrid", "not a url"));
        assert_eq!(
            unrestrict_targets(vec![("torbox".into(), "k".into())], "https://real-debrid.com/d/ABCDEF"),
            Vec::new()
        );
    }
}
