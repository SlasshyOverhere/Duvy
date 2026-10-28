//! Stremio account sync.
//!
//! Talks to the same `api.strem.io` endpoints the official apps use: `login`,
//! `addonCollectionGet`/`addonCollectionPut` and `datastoreGet`/`datastorePut`
//! for the `libraryItem` collection. Pull merges the account's addons and
//! library into the local store; push sends the merged union back, so addons
//! installed here reach the phone and Stremio's addons reach Nuvio on the next
//! pass.
//!
//! Dedupe is by normalised manifest URL everywhere: the same addon on Stremio,
//! Nuvio and this machine is stored once, never three times.
//!
//! ponytail: only the latest watched episode is imported. Stremio's per-episode
//! history is a positional bitfield keyed by Cinemeta's episode order; decode it
//! when every watched badge must cross devices.

use crate::db;
use crate::AppState;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

const BASE: &str = "https://api.strem.io";
const SESSION_KEY: &str = "stremio";
const LIBRARY_COLLECTION: &str = "libraryItem";
const UA: &str = "Duvy/0.1";

// ---------------------------------------------------------------------------
// Session + status
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub auth_key: String,
    pub email: String,
    pub user_id: String,
    pub last_sync: i64,
}

impl Session {
    fn signed_in(&self) -> bool {
        !self.auth_key.is_empty()
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub signed_in: bool,
    pub email: String,
    pub last_sync: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub addons: i64,
    pub progress: i64,
    pub watched: i64,
    pub library: i64,
    pub pushed: i64,
}

pub fn load_session(conn: &Connection) -> Session {
    db::read_kv(conn, SESSION_KEY)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

fn save_session(conn: &Connection, session: &Session) -> Result<(), String> {
    let value = serde_json::to_value(session).map_err(|e| e.to_string())?;
    db::write_kv(conn, SESSION_KEY, &value).map_err(|e| e.to_string())
}

pub fn status(conn: &Connection) -> Status {
    let s = load_session(conn);
    Status {
        signed_in: s.signed_in(),
        email: s.email,
        last_sync: s.last_sync,
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

async fn api(http: &reqwest::Client, method: &str, body: &Value) -> Result<Value, String> {
    let response = http
        .post(format!("{BASE}/api/{method}"))
        .header("content-type", "application/json")
        .header("user-agent", UA)
        .json(body)
        .send()
        .await
        .map_err(|e| format!("Stremio: {e}"))?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    let parsed: Value = serde_json::from_str(&text)
        .map_err(|e| format!("Stremio: bad response ({status}): {e}"))?;
    if let Some(error) = parsed.get("error").filter(|e| !e.is_null()) {
        let detail = error
            .get("message")
            .or_else(|| error.get("code"))
            .and_then(Value::as_str)
            .unwrap_or("request failed");
        return Err(format!("Stremio: {detail}"));
    }
    if !status.is_success() {
        return Err(format!("Stremio request failed ({status})"));
    }
    Ok(parsed.get("result").cloned().unwrap_or(Value::Null))
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

pub async fn sign_in(state: &AppState, email: &str, password: &str) -> Result<Status, String> {
    let email = email.trim();
    if email.is_empty() || password.is_empty() {
        return Err("Email and password are required.".into());
    }
    let result = api(
        &state.http,
        "login",
        &json!({
            "type": "Login",
            "email": email,
            "password": password,
            "facebook": false,
        }),
    )
    .await?;
    let auth_key = result
        .get("authKey")
        .and_then(Value::as_str)
        .ok_or("Stremio login returned no auth key")?;
    let user = result.get("user");
    let session = Session {
        auth_key: auth_key.to_string(),
        email: user
            .and_then(|u| u.get("email"))
            .and_then(Value::as_str)
            .unwrap_or(email)
            .to_string(),
        user_id: user
            .and_then(|u| u.get("_id"))
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        last_sync: 0,
    };
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    save_session(&conn, &session)?;
    Ok(status(&conn))
}

pub fn sign_out(state: &AppState) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    db::delete_kv(&conn, SESSION_KEY).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

struct Pulled {
    addons: Vec<Value>,
    library: Vec<Value>,
}

fn as_rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn int(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

/// The descriptor URL Stremio stores, normalised the way an install is.
fn descriptor_url(row: &Value) -> Option<String> {
    let raw = row
        .get("transportUrl")
        .or_else(|| row.get("transport_url"))
        .and_then(Value::as_str)?;
    let url = crate::addons::normalize_addon_url(raw);
    (!url.is_empty()).then_some(url)
}

/// `metaId:s:e` for an episode, the bare id for a movie.
fn episode_key(meta_id: &str, video_id: &str) -> (String, Option<i64>, Option<i64>) {
    if video_id.is_empty() || video_id == meta_id {
        return (meta_id.to_string(), None, None);
    }
    let parts: Vec<&str> = video_id.split(':').collect();
    if parts.len() >= 3 {
        if let (Ok(season), Ok(episode)) = (
            parts[parts.len() - 2].parse::<i64>(),
            parts[parts.len() - 1].parse::<i64>(),
        ) {
            if season > 0 && episode > 0 {
                return (
                    format!("{meta_id}:{season}:{episode}"),
                    Some(season),
                    Some(episode),
                );
            }
        }
    }
    (meta_id.to_string(), None, None)
}

async fn pull(http: &reqwest::Client, key: &str) -> Result<Pulled, String> {
    let collection = api(
        http,
        "addonCollectionGet",
        &json!({ "type": "AddonCollectionGet", "authKey": key, "update": true }),
    )
    .await?;
    let addons = collection
        .get("addons")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    let library = api(
        http,
        "datastoreGet",
        &json!({
            "type": "DatastoreGet",
            "authKey": key,
            "collection": LIBRARY_COLLECTION,
            "ids": [],
            "all": true,
        }),
    )
    .await?;

    Ok(Pulled {
        addons,
        library: as_rows(library),
    })
}

/// Installs addons the account has and this machine does not. Dedupe is by
/// normalised manifest URL, so a second account holding the same addon adds
/// nothing.
fn merge_addons(conn: &Connection, rows: &[Value]) -> Result<i64, String> {
    let mut seen: HashSet<String> = db::list_addons(conn)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|addon| crate::addons::normalize_addon_url(&addon.url))
        .collect();
    let mut added = 0;
    for row in rows {
        let Some(url) = descriptor_url(row) else { continue };
        if !seen.insert(url.clone()) {
            continue;
        }
        let manifest = row.get("manifest").cloned().unwrap_or(Value::Null);
        let Ok(parsed) = serde_json::from_value::<crate::addons::Manifest>(manifest.clone()) else {
            continue;
        };
        if parsed.id.trim().is_empty() || parsed.name.trim().is_empty() {
            continue;
        }
        db::upsert_addon(conn, &url, &parsed.id, &parsed.name, &manifest)
            .map_err(|e| e.to_string())?;
        let disabled = row
            .get("flags")
            .and_then(|f| f.get("disabled"))
            .and_then(Value::as_bool)
            .unwrap_or(false);
        if disabled {
            let _ = db::set_addon_enabled(conn, &url, false);
        }
        added += 1;
    }
    Ok(added)
}

fn merge_library(conn: &Connection, rows: &[Value]) -> Result<(i64, i64, i64), String> {
    let mut library = 0;
    let mut progress = 0;
    let mut watched = 0;
    for row in rows {
        let id = text(row, "_id");
        if id.is_empty() || row.get("removed").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        let media_type = match text(row, "type").as_str() {
            "movie" => "movie",
            "series" => "series",
            _ => continue,
        };
        let name = text(row, "name");
        let poster = row.get("poster").and_then(Value::as_str);
        let ctime = time_ms(row.get("_ctime").unwrap_or(&Value::Null));
        let mtime = time_ms(row.get("_mtime").unwrap_or(&Value::Null));

        if !row.get("temp").and_then(Value::as_bool).unwrap_or(false) {
            let inserted = conn
                .execute(
                    "INSERT INTO library (id, media_type, name, poster, background, added_at, meta)
                     VALUES (?1, ?2, ?3, ?4, NULL, ?5, NULL)
                     ON CONFLICT(id) DO NOTHING",
                    params![
                        id,
                        media_type,
                        name,
                        poster,
                        if ctime > 0 { ctime } else { mtime }
                    ],
                )
                .map_err(|e| e.to_string())?;
            library += inserted as i64;
        }

        let Some(state) = row.get("state") else { continue };
        let offset = int(state, "timeOffset");
        let duration = int(state, "duration");
        let video_id = text(state, "video_id");
        let (key, season, episode) = episode_key(&id, &video_id);
        let last_watched = time_ms(state.get("lastWatched").unwrap_or(&Value::Null));
        let updated = if last_watched > 0 { last_watched } else { mtime }.max(1);

        if duration > 0 && offset > 0 {
            conn.execute(
                "INSERT INTO progress (key, meta_id, media_type, name, poster, background,
                                       season, episode, episode_title, position, duration, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, NULL, ?8, ?9, ?10)
                 ON CONFLICT(key) DO UPDATE SET
                   position = excluded.position,
                   duration = excluded.duration,
                   updated_at = excluded.updated_at,
                   name = CASE WHEN excluded.name = '' THEN progress.name ELSE excluded.name END,
                   poster = COALESCE(excluded.poster, progress.poster),
                   season = COALESCE(excluded.season, progress.season),
                   episode = COALESCE(excluded.episode, progress.episode)
                 WHERE excluded.updated_at >= progress.updated_at",
                params![
                    key,
                    id,
                    media_type,
                    name,
                    poster,
                    season,
                    episode,
                    offset as f64 / 1000.0,
                    duration as f64 / 1000.0,
                    updated
                ],
            )
            .map_err(|e| e.to_string())?;
            progress += 1;
        }

        let times = int(state, "timesWatched");
        let flagged = int(state, "flaggedWatched");
        let finished = duration > 0 && offset * 10 >= duration * 9;
        // A series without a `video_id` has no episode to blame, so it must not
        // mark the whole show watched.
        if (media_type == "movie" || season.is_some()) && (times > 0 || flagged > 0 || finished) {
            conn.execute(
                "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES (?1, ?2, 1, ?3)
                 ON CONFLICT(key) DO UPDATE SET watched = 1, updated_at = excluded.updated_at
                 WHERE excluded.updated_at >= watched.updated_at",
                params![key, id, updated],
            )
            .map_err(|e| e.to_string())?;
            watched += 1;
        }
    }
    Ok((library, progress, watched))
}

fn merge_all(conn: &Connection, pulled: &Pulled) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    report.addons = merge_addons(conn, &pulled.addons)?;
    let (library, progress, watched) = merge_library(conn, &pulled.library)?;
    report.library = library;
    report.progress = progress;
    report.watched = watched;
    Ok(report)
}

pub async fn pull_and_merge(state: &AppState) -> Result<SyncReport, String> {
    let session = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        load_session(&conn)
    };
    if !session.signed_in() {
        return Err("Sign in to Stremio to sync.".into());
    }
    let pulled = pull(&state.http, &session.auth_key).await?;
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    merge_all(&conn, &pulled)
}

pub async fn sync_now(state: &AppState) -> Result<SyncReport, String> {
    let session = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        load_session(&conn)
    };
    if !session.signed_in() {
        return Err("Sign in to Stremio to sync.".into());
    }
    let pulled = pull(&state.http, &session.auth_key).await?;
    let mut report = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        merge_all(&conn, &pulled)?
    };

    let (addons, library, progress) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        (
            db::list_addons(&conn).map_err(|e| e.to_string())?,
            db::list_library(&conn).map_err(|e| e.to_string())?,
            db::all_progress(&conn).map_err(|e| e.to_string())?,
        )
    };
    let mut pushed =
        push_addons(&state.http, &session.auth_key, &addons, &pulled.addons).await.unwrap_or(0);
    pushed += push_library(
        &state.http,
        &session.auth_key,
        &library,
        &progress,
        &pulled.library,
    )
    .await
    .unwrap_or(0);
    report.pushed = pushed;

    let mut session = session;
    session.last_sync = db::now();
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    save_session(&conn, &session)?;
    Ok(report)
}

/// Pushes the local union without pulling first. Used by `sync_all` after the
/// Nuvio pass so Nuvio's rows reach Stremio in the same sync.
pub async fn push(state: &AppState) -> Result<i64, String> {
    let session = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        load_session(&conn)
    };
    if !session.signed_in() {
        return Ok(0);
    }
    let pulled = pull(&state.http, &session.auth_key).await?;
    let (addons, library, progress) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        (
            db::list_addons(&conn).map_err(|e| e.to_string())?,
            db::list_library(&conn).map_err(|e| e.to_string())?,
            db::all_progress(&conn).map_err(|e| e.to_string())?,
        )
    };
    let mut pushed =
        push_addons(&state.http, &session.auth_key, &addons, &pulled.addons).await.unwrap_or(0);
    pushed += push_library(
        &state.http,
        &session.auth_key,
        &library,
        &progress,
        &pulled.library,
    )
    .await
    .unwrap_or(0);
    Ok(pushed)
}

async fn push_addons(
    http: &reqwest::Client,
    key: &str,
    addons: &[db::StoredAddon],
    remote: &[Value],
) -> Result<i64, String> {
    let mut by_url: HashMap<String, Value> = HashMap::new();
    for row in remote {
        if let Some(url) = descriptor_url(row) {
            by_url.entry(url).or_insert_with(|| row.clone());
        }
    }

    let mut seen = HashSet::new();
    let mut descriptors = Vec::new();
    for addon in addons {
        let url = crate::addons::normalize_addon_url(&addon.url);
        if url.is_empty()
            || !addon.enabled
            || !seen.insert(url.clone())
            || !addon.manifest.is_object()
        {
            continue;
        }
        let mut descriptor = by_url.remove(&url).unwrap_or_else(|| {
            json!({
                "transportUrl": url,
                "transportName": "http",
                "manifest": addon.manifest.clone(),
                "flags": { "official": false, "protected": false },
            })
        });
        if let Some(object) = descriptor.as_object_mut() {
            object.insert("transportUrl".into(), Value::String(url.clone()));
            object
                .entry("transportName")
                .or_insert_with(|| Value::String("http".into()));
            object.insert("manifest".into(), addon.manifest.clone());
            let flags = object.entry("flags").or_insert_with(|| json!({}));
            if let Some(flags) = flags.as_object_mut() {
                flags.entry("official").or_insert(json!(false));
                flags.entry("protected").or_insert(json!(false));
            }
        }
        descriptors.push(descriptor);
    }

    if descriptors.is_empty() {
        return Ok(0);
    }
    api(
        http,
        "addonCollectionPut",
        &json!({
            "type": "AddonCollectionPut",
            "authKey": key,
            "addons": descriptors,
        }),
    )
    .await?;
    Ok(descriptors.len() as i64)
}

async fn push_library(
    http: &reqwest::Client,
    key: &str,
    library: &[db::LibraryItem],
    progress: &[db::ProgressItem],
    remote: &[Value],
) -> Result<i64, String> {
    let remote_by_id: HashMap<String, Value> = remote
        .iter()
        .filter_map(|row| {
            let id = text(row, "_id");
            (!id.is_empty()).then(|| (id, row.clone()))
        })
        .collect();

    let mut newest: HashMap<String, db::ProgressItem> = HashMap::new();
    for item in progress {
        newest.entry(item.meta_id.clone()).or_insert_with(|| item.clone());
    }

    let mut covered = HashSet::new();
    let mut changes = Vec::new();
    for item in library {
        covered.insert(item.id.clone());
        let remote_row = remote_by_id.get(&item.id);
        let remote_updated = remote_row
            .map(|row| time_ms(row.get("_mtime").unwrap_or(&Value::Null)))
            .unwrap_or(0);
        let progress = newest.get(&item.id);
        match progress {
            Some(p) if remote_updated <= p.updated_at => {}
            Some(_) => continue,
            None if remote_row.is_some() => continue,
            None => {}
        }
        changes.push(library_record(
            remote_row,
            true,
            &item.id,
            &item.name,
            &item.media_type,
            item.poster.as_deref(),
            item.added_at,
            progress,
        ));
    }

    for (id, progress) in newest {
        if covered.contains(&id) {
            continue;
        }
        let remote_row = remote_by_id.get(&id);
        let remote_updated = remote_row
            .map(|row| time_ms(row.get("_mtime").unwrap_or(&Value::Null)))
            .unwrap_or(0);
        if remote_updated > progress.updated_at {
            continue;
        }
        changes.push(library_record(
            remote_row,
            false,
            &id,
            &progress.name,
            &progress.media_type,
            progress.poster.as_deref(),
            progress.updated_at,
            Some(&progress),
        ));
    }

    if changes.is_empty() {
        return Ok(0);
    }
    // A large library would otherwise be one oversized request.
    for chunk in changes.chunks(100) {
        api(
            http,
            "datastorePut",
            &json!({
                "type": "DatastorePut",
                "authKey": key,
                "collection": LIBRARY_COLLECTION,
                "changes": chunk,
            }),
        )
        .await?;
    }
    Ok(changes.len() as i64)
}

/// A complete Stremio `LibraryItem`. Remote rows are kept as-is so unknown
/// fields and the original timestamps survive; local-only rows get a full shape
/// the official clients can deserialize.
fn library_record(
    remote: Option<&Value>,
    in_library: bool,
    id: &str,
    name: &str,
    media_type: &str,
    poster: Option<&str>,
    added_at: i64,
    progress: Option<&db::ProgressItem>,
) -> Value {
    let mut record = remote.cloned().unwrap_or_else(|| {
        json!({
            "_id": id,
            "name": name,
            "type": media_type,
            "poster": poster,
            "posterShape": "poster",
            "removed": !in_library,
            "temp": !in_library,
            "_ctime": iso8601(added_at),
            "_mtime": iso8601(added_at),
            "state": {
                "timeWatched": 0,
                "timeOffset": 0,
                "overallTimeWatched": 0,
                "timesWatched": 0,
                "flaggedWatched": 0,
                "duration": 0,
                "noNotif": false
            }
        })
    });
    let Some(progress) = progress else { return record };
    let updated = iso8601(progress.updated_at);
    if let Some(object) = record.as_object_mut() {
        object.insert("_mtime".into(), Value::String(updated.clone()));
        if !progress.name.is_empty() {
            object.insert("name".into(), Value::String(progress.name.clone()));
        }
        if let Some(poster) = &progress.poster {
            object.insert("poster".into(), Value::String(poster.clone()));
        }
        let state = object.entry("state").or_insert_with(|| json!({}));
        if let Some(state) = state.as_object_mut() {
            let offset = (progress.position * 1000.0) as i64;
            let duration = (progress.duration * 1000.0) as i64;
            state.insert("timeOffset".into(), json!(offset));
            state.insert("duration".into(), json!(duration));
            state.insert("timeWatched".into(), json!(offset));
            state.insert("lastWatched".into(), Value::String(updated));
            if progress.key.starts_with(&format!("{}:", progress.meta_id)) {
                state.insert("video_id".into(), Value::String(progress.key.clone()));
            }
            if duration > 0 && offset * 10 >= duration * 9 {
                let times = state
                    .get("timesWatched")
                    .and_then(Value::as_u64)
                    .unwrap_or(0);
                state.insert("timesWatched".into(), json!(times + 1));
                if progress.media_type == "movie" {
                    state.insert("flaggedWatched".into(), json!(1));
                }
            }
        }
    }
    record
}

// ---------------------------------------------------------------------------
// Timestamps
// ---------------------------------------------------------------------------

/// Stremio stores dates as RFC3339 strings; older payloads use epoch ms.
fn time_ms(value: &Value) -> i64 {
    match value {
        Value::Number(number) => number.as_i64().unwrap_or(0),
        Value::String(text) => parse_iso(text).unwrap_or(0),
        _ => 0,
    }
}

fn parse_iso(text: &str) -> Option<i64> {
    let (date, rest) = text.trim().split_once('T')?;
    let mut date = date.split('-');
    let year: i64 = date.next()?.parse().ok()?;
    let month: u32 = date.next()?.parse().ok()?;
    let day: u32 = date.next()?.parse().ok()?;
    let rest = rest.trim_end_matches('Z');
    let mut clock = rest.split(':');
    let hour: i64 = clock.next()?.parse().ok()?;
    let minute: i64 = clock.next()?.parse().ok()?;
    let seconds = clock.next()?;
    let (seconds, fraction) = seconds.split_once('.').unwrap_or((seconds, ""));
    let seconds: i64 = seconds.parse().ok()?;
    let millis: i64 = if fraction.is_empty() {
        0
    } else {
        let digits: String = fraction.chars().take(3).collect();
        format!("{digits:0<3}").parse().ok()?
    };
    let days = days_from_civil(year, month, day);
    Some(days * 86_400_000 + (hour * 3600 + minute * 60 + seconds) * 1000 + millis)
}

fn iso8601(ms: i64) -> String {
    let seconds = ms.div_euclid(1000);
    let days = seconds.div_euclid(86_400);
    let clock = seconds.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}Z",
        clock / 3600,
        (clock % 3600) / 60,
        clock % 60
    )
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let year = if month <= 2 { year - 1 } else { year };
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let yoe = (year - era * 400) as u64;
    let mp = if month > 2 { month - 3 } else { month + 9 } as u64;
    let doy = (153 * mp + 2) / 5 + day as u64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe as i64 - 719_468
}

fn civil_from_days(days: i64) -> (i64, u32, u32) {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = (z - era * 146_097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let month = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if month <= 2 { year + 1 } else { year }, month, day)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_same_addon_on_every_source_stays_one_row() {
        let rows = vec![
            json!({ "transportUrl": "https://example.com/addon/", "manifest": { "id": "a", "name": "A" } }),
            json!({ "transportUrl": "https://example.com/addon/manifest.json", "manifest": { "id": "a", "name": "A" } }),
            json!({ "transportUrl": "stremio://example.com/addon", "manifest": { "id": "a", "name": "A" } }),
        ];
        let urls: HashSet<String> = rows.iter().filter_map(descriptor_url).collect();
        assert_eq!(urls.len(), 1);
    }

    #[test]
    fn series_video_ids_become_episode_keys() {
        assert_eq!(episode_key("tt1", "tt1"), ("tt1".into(), None, None));
        assert_eq!(
            episode_key("tt1", "tt1:2:5"),
            ("tt1:2:5".into(), Some(2), Some(5))
        );
        assert_eq!(episode_key("tt1", ""), ("tt1".into(), None, None));
    }

    #[test]
    fn camel_case_state_imports_progress_and_watched() {
        let path = std::env::temp_dir().join(format!("duvy-stremio-{}.db", db::now()));
        let conn = db::open(&path).expect("test database opens");
        let rows = vec![
            json!({
                "_id": "tt1",
                "name": "Film",
                "type": "movie",
                "poster": "poster",
                "removed": false,
                "temp": false,
                "_ctime": "2026-10-01T00:00:00Z",
                "_mtime": "2026-10-02T00:00:00Z",
                "state": {
                    "lastWatched": "2026-10-02T00:00:00Z",
                    "timeWatched": 5_400_000,
                    "timeOffset": 5_400_000,
                    "overallTimeWatched": 5_400_000,
                    "timesWatched": 1,
                    "flaggedWatched": 1,
                    "duration": 5_400_000,
                    "video_id": "tt1",
                    "watched": null,
                    "noNotif": false
                }
            }),
            json!({
                "_id": "tt2",
                "name": "Show",
                "type": "series",
                "removed": false,
                "temp": false,
                "_mtime": "2026-10-03T00:00:00Z",
                "state": {
                    "lastWatched": "2026-10-03T00:00:00Z",
                    "timesWatched": 1,
                    "flaggedWatched": 1,
                    "video_id": "tt2:1:2"
                }
            }),
        ];
        let (_, progress, watched) = merge_library(&conn, &rows).expect("merge");
        assert_eq!(progress, 1, "a Stremio resume point must become progress");
        assert_eq!(watched, 2, "a Stremio watched mark must become a watched row");
        let film = db::get_progress(&conn, "tt1").unwrap().expect("film progress");
        assert_eq!(film.position, 5400.0);
        assert_eq!(film.duration, 5400.0);
        let marks = db::list_watched(&conn).unwrap();
        assert!(marks.contains(&"tt1".to_string()));
        assert!(marks.contains(&"tt2:1:2".to_string()));
        let listed = db::list_watched_items(&conn).unwrap();
        assert!(
            listed.iter().any(|item| item.meta_id == "tt1" && item.name == "Film"),
            "a watched movie must appear in the Watched list"
        );
        assert!(
            listed.iter().any(|item| item.meta_id == "tt2" && item.name == "Show"),
            "a watched series must appear in the Watched list"
        );
        drop(conn);
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn stremio_dates_round_trip() {
        let ms = 1_793_190_296_000;
        let text = iso8601(ms);
        assert_eq!(text, "2026-10-28T12:24:56Z");
        assert_eq!(parse_iso(&text), Some(ms));
        assert_eq!(parse_iso("2026-10-28T12:24:56.789Z"), Some(ms + 789));
    }
}
