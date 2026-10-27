//! Nuvio Cloud sync.
//!
//! Talks to the same Supabase project the official Nuvio apps use: GoTrue for
//! email/password auth and PostgREST `sync_*` RPCs for profiles, watch
//! progress, watched items and the library. The publishable ("anon") key below
//! is the one shipped in Nuvio's own desktop binary; it is public by design and
//! only grants what row-level security allows for the signed-in user. Both the
//! endpoint and the key can be overridden in settings.
//!
//! Strategy: full pull, merge by timestamp, then upsert everything local. That
//! is a couple of requests per sync for a normal account, needs no cursor
//! bookkeeping and converges no matter which app wrote last.
//!
//! ponytail: deletions are not propagated to the server yet (local clear/remove
//! just comes back on the next pull). Add tombstone pushes when sync_delete_*
//! is wired to the library/progress commands.

use crate::db;
use crate::settings::Settings;
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const DEFAULT_BASE: &str = "https://api.nuvio.tv";
pub const DEFAULT_FALLBACK: &str = "https://api-two.nuvioapp.space";
pub const DEFAULT_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI";

const SESSION_KEY: &str = "nuvio";
const UA: &str = "BetterNuvio/0.1";

// ---------------------------------------------------------------------------
// Session + status
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Session {
    pub access_token: String,
    pub refresh_token: String,
    pub user_id: String,
    pub email: String,
    /// Epoch seconds at which `access_token` expires.
    pub expires_at: i64,
    /// Nuvio profile index (1-based).
    pub profile: i64,
    pub last_sync: i64,
}

impl Default for Session {
    fn default() -> Self {
        Self {
            access_token: String::new(),
            refresh_token: String::new(),
            user_id: String::new(),
            email: String::new(),
            expires_at: 0,
            profile: 1,
            last_sync: 0,
        }
    }
}

impl Session {
    fn signed_in(&self) -> bool {
        !self.access_token.is_empty() || !self.refresh_token.is_empty()
    }
}

/// Everything the Settings screen needs, without leaking the tokens.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub signed_in: bool,
    pub email: String,
    pub profile: i64,
    pub last_sync: i64,
    pub base_url: String,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SyncReport {
    pub progress: i64,
    pub watched: i64,
    pub library: i64,
    pub pushed: i64,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NuvioProfile {
    pub id: String,
    pub name: String,
    pub profile_index: i64,
    pub avatar_color_hex: String,
    pub avatar_url: Option<String>,
    pub pin_enabled: bool,
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

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

pub fn status(conn: &Connection, settings: &Settings) -> Status {
    let s = load_session(conn);
    Status {
        signed_in: s.signed_in(),
        email: s.email,
        profile: s.profile,
        last_sync: s.last_sync,
        base_url: base_url(settings),
    }
}

fn base_url(settings: &Settings) -> String {
    let custom = settings.nuvio_base_url.trim().trim_end_matches('/');
    if custom.is_empty() {
        DEFAULT_BASE.to_string()
    } else {
        custom.to_string()
    }
}

fn api_key(settings: &Settings) -> String {
    let custom = settings.nuvio_api_key.trim();
    if custom.is_empty() {
        DEFAULT_KEY.to_string()
    } else {
        custom.to_string()
    }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn error_from(status: u16, body: &str) -> String {
    let parsed: Option<Value> = serde_json::from_str(body).ok();
    let detail = parsed
        .as_ref()
        .and_then(|v| {
            v.get("msg")
                .or_else(|| v.get("message"))
                .or_else(|| v.get("error_description"))
                .or_else(|| v.get("error"))
        })
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .unwrap_or_else(|| body.chars().take(200).collect());
    match status {
        401 | 403 => format!("Nuvio rejected the credentials ({status}): {detail}"),
        404 => format!("Nuvio endpoint not found ({status}): {detail}"),
        _ => format!("Nuvio request failed ({status}): {detail}"),
    }
}

/// POST that falls back to the secondary endpoint on transient failures.
async fn post(
    http: &reqwest::Client,
    settings: &Settings,
    path: &str,
    token: Option<&str>,
    body: &Value,
) -> Result<Value, String> {
    let key = api_key(settings);
    let mut hosts = vec![base_url(settings)];
    for extra in [DEFAULT_BASE.to_string(), DEFAULT_FALLBACK.to_string()] {
        if !hosts.contains(&extra) {
            hosts.push(extra);
        }
    }
    let mut last_error = String::from("no endpoint tried");
    for host in hosts {
        let mut req = http
            .post(format!("{host}{path}"))
            .header("apikey", &key)
            .header("content-type", "application/json")
            .header("user-agent", UA)
            .json(body);
        req = match token {
            Some(t) => req.header("authorization", format!("Bearer {t}")),
            None => req,
        };
        let response = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("{host}: {e}");
                continue;
            }
        };
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        if status.is_success() {
            if text.trim().is_empty() {
                return Ok(Value::Null);
            }
            return serde_json::from_str(&text).map_err(|e| format!("{host}: bad JSON: {e}"));
        }
        // Only an unavailable backend is worth retrying elsewhere; auth and
        // validation errors are ours to fix.
        let transient = matches!(status.as_u16(), 502 | 503 | 504 | 520 | 521 | 522 | 523 | 524);
        last_error = error_from(status.as_u16(), &text);
        if !transient {
            break;
        }
    }
    Err(last_error)
}

async fn rpc(
    http: &reqwest::Client,
    settings: &Settings,
    token: &str,
    name: &str,
    body: Value,
) -> Result<Value, String> {
    post(http, settings, &format!("/rest/v1/rpc/{name}"), Some(token), &body).await
}

/// Returns a usable access token, refreshing it when it is close to expiring.
async fn ensure_token(
    http: &reqwest::Client,
    settings: &Settings,
    session: &mut Session,
) -> Result<String, String> {
    let now = db::now() / 1000;
    if !session.access_token.is_empty() && session.expires_at > now + 60 {
        return Ok(session.access_token.clone());
    }
    if session.refresh_token.is_empty() {
        return Err("Sign in to Nuvio to sync.".into());
    }
    let value = post(
        http,
        settings,
        "/auth/v1/token?grant_type=refresh_token",
        None,
        &json!({ "refresh_token": session.refresh_token }),
    )
    .await?;
    apply_session(session, &value)?;
    Ok(session.access_token.clone())
}

fn apply_session(session: &mut Session, value: &Value) -> Result<(), String> {
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .ok_or("Nuvio auth response had no access token")?;
    session.access_token = access.to_string();
    if let Some(refresh) = value.get("refresh_token").and_then(Value::as_str) {
        session.refresh_token = refresh.to_string();
    }
    if let Some(user) = value.get("user") {
        if let Some(id) = user.get("id").and_then(Value::as_str) {
            session.user_id = id.to_string();
        }
        if let Some(email) = user.get("email").and_then(Value::as_str) {
            session.email = email.to_string();
        }
    }
    let issued = db::now() / 1000;
    let ttl = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(3600);
    session.expires_at = issued + ttl;
    Ok(())
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

pub async fn sign_in(
    state: &AppState,
    email: &str,
    password: &str,
    sign_up: bool,
) -> Result<Status, String> {
    let email = email.trim();
    if email.is_empty() || password.is_empty() {
        return Err("Email and password are required.".into());
    }
    let settings = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        Settings::load(&conn)
    };
    let path = if sign_up {
        "/auth/v1/signup"
    } else {
        "/auth/v1/token?grant_type=password"
    };
    let value = post(
        &state.http,
        &settings,
        path,
        None,
        &json!({ "email": email, "password": password }),
    )
    .await?;
    if value.get("access_token").is_none() {
        // Supabase returns a bare user object when email confirmation is on.
        return Err("Check your inbox to confirm the Nuvio account, then sign in.".into());
    }
    let mut session = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        let mut s = load_session(&conn);
        s.email = email.to_string();
        s
    };
    apply_session(&mut session, &value)?;
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    save_session(&conn, &session)?;
    Ok(status(&conn, &settings))
}

pub fn sign_out(state: &AppState) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    db::delete_kv(&conn, SESSION_KEY).map_err(|e| e.to_string())
}

pub fn set_profile(state: &AppState, index: i64) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    let mut session = load_session(&conn);
    session.profile = index.max(1);
    save_session(&conn, &session)
}

pub async fn profiles(state: &AppState) -> Result<Vec<NuvioProfile>, String> {
    let (settings, mut session) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        (Settings::load(&conn), load_session(&conn))
    };
    let token = ensure_token(&state.http, &settings, &mut session).await?;
    let value = rpc(&state.http, &settings, &token, "sync_pull_profiles", json!({})).await?;
    {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        save_session(&conn, &session)?;
    }
    let mut list: Vec<NuvioProfile> = serde_json::from_value(value).unwrap_or_default();
    list.sort_by_key(|p| p.profile_index);
    Ok(list)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn as_rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        Value::Null => Vec::new(),
        other => vec![other],
    }
}

fn int(value: &Value, key: &str) -> i64 {
    value
        .get(key)
        .and_then(|v| v.as_i64().or_else(|| v.as_f64().map(|f| f as i64)))
        .unwrap_or(0)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn content_type(value: &Value) -> String {
    match text(value, "content_type").as_str() {
        "series" => "series".into(),
        other if other.is_empty() => "movie".into(),
        other => other.into(),
    }
}

/// Local progress key for a remote entry: `metaId` for movies, `metaId:s:e`
/// for episodes, so BetterNuvio can resolve its own resume lookups.
fn local_key(content_id: &str, season: i64, episode: i64) -> String {
    if season > 0 && episode > 0 {
        format!("{content_id}:{season}:{episode}")
    } else {
        content_id.to_string()
    }
}

pub async fn sync_now(state: &AppState) -> Result<SyncReport, String> {
    let (settings, mut session) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        (Settings::load(&conn), load_session(&conn))
    };
    if !session.signed_in() {
        return Err("Sign in to Nuvio to sync.".into());
    }
    let token = ensure_token(&state.http, &settings, &mut session).await?;
    let pid = session.profile;

    // ---- pull -------------------------------------------------------------
    let progress_rows = as_rows(
        rpc(
            &state.http,
            &settings,
            &token,
            "sync_pull_watch_progress",
            json!({ "p_profile_id": pid, "p_since_last_watched": 0, "p_limit": 1000 }),
        )
        .await?,
    );

    let mut watched_rows = Vec::new();
    for page in 1..=10 {
        let batch = as_rows(
            rpc(
                &state.http,
                &settings,
                &token,
                "sync_pull_watched_items",
                json!({ "p_profile_id": pid, "p_page": page, "p_page_size": 500 }),
            )
            .await?,
        );
        let done = batch.len() < 500;
        watched_rows.extend(batch);
        if done {
            break;
        }
    }

    let mut library_rows = Vec::new();
    for page in 0..20 {
        let batch = as_rows(
            rpc(
                &state.http,
                &settings,
                &token,
                "sync_pull_library",
                json!({ "p_profile_id": pid, "p_limit": 500, "p_offset": page * 500 }),
            )
            .await?,
        );
        let done = batch.len() < 500;
        library_rows.extend(batch);
        if done {
            break;
        }
    }

    // ---- merge ------------------------------------------------------------
    let mut report = SyncReport::default();
    let (push_progress, push_watched, push_library) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        report.progress = merge_progress(&conn, &progress_rows)?;
        report.watched = merge_watched(&conn, &watched_rows)?;
        report.library = merge_library(&conn, &library_rows)?;
        (
            local_progress(&conn)?,
            local_watched(&conn)?,
            local_library(&conn)?,
        )
    };

    // ---- push -------------------------------------------------------------
    if !push_progress.is_empty() {
        rpc(
            &state.http,
            &settings,
            &token,
            "sync_push_watch_progress",
            json!({ "p_profile_id": pid, "p_entries": push_progress }),
        )
        .await?;
    }
    if !push_watched.is_empty() {
        rpc(
            &state.http,
            &settings,
            &token,
            "sync_push_watched_items",
            json!({ "p_profile_id": pid, "p_items": push_watched }),
        )
        .await?;
    }
    if !push_library.is_empty() {
        rpc(
            &state.http,
            &settings,
            &token,
            "sync_push_library_items",
            json!({ "p_profile_id": pid, "p_items": push_library }),
        )
        .await?;
    }

    report.pushed = (report.progress + report.watched + report.library) as i64;

    // ---- enrich -----------------------------------------------------------
    // The account carries ids only, so pulled rows arrive with no title or
    // art. Resolve them here; anything that fails is retried next sync.
    let mut missing = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        let mut rows = db::progress_missing_meta(&conn).unwrap_or_default();
        rows.append(&mut db::library_missing_meta(&conn).unwrap_or_default());
        rows
    };
    // The same title usually lands in both tables; resolve it once.
    missing.sort();
    missing.dedup();
    if !missing.is_empty() {
        let filled = crate::meta::fill_missing(&state.http, missing).await;
        if !filled.is_empty() {
            let conn = state.db.0.lock().map_err(|e| e.to_string())?;
            for (meta_id, name, poster, background) in filled {
                let _ = db::set_progress_meta(
                    &conn,
                    &meta_id,
                    &name,
                    poster.as_deref(),
                    background.as_deref(),
                );
                let _ = db::set_library_meta(
                    &conn,
                    &meta_id,
                    &name,
                    poster.as_deref(),
                    background.as_deref(),
                );
            }
        }
    }

    session.last_sync = db::now();
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    save_session(&conn, &session)?;
    Ok(report)
}

/// Pulls remote progress into the local table, newest write wins. Returns the
/// number of rows accepted.
fn merge_progress(conn: &Connection, rows: &[Value]) -> Result<i64, String> {
    let mut applied = 0;
    for row in rows {
        let content_id = text(row, "content_id");
        if content_id.is_empty() {
            continue;
        }
        let season = int(row, "season");
        let episode = int(row, "episode");
        let key = local_key(&content_id, season, episode);
        let updated = int(row, "last_watched");
        let position = int(row, "position") as f64 / 1000.0;
        let duration = int(row, "duration") as f64 / 1000.0;
        if duration <= 0.0 {
            continue;
        }
        let existing: Option<(String, i64)> = conn
            .query_row(
                "SELECT name, updated_at FROM progress WHERE key = ?1",
                params![key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some((_, local_updated)) = &existing {
            if *local_updated > updated {
                continue;
            }
        }
        conn.execute(
            "INSERT INTO progress (key, meta_id, media_type, name, poster, background, season,
                                   episode, episode_title, position, duration, updated_at)
             VALUES (?1, ?2, ?3, ?2, NULL, NULL, ?4, ?5, NULL, ?6, ?7, ?8)
             ON CONFLICT(key) DO UPDATE SET
               position = ?6, duration = ?7, updated_at = ?8,
               season = COALESCE(progress.season, ?4), episode = COALESCE(progress.episode, ?5)",
            params![
                key,
                content_id,
                content_type(row),
                if season > 0 { Some(season) } else { None },
                if episode > 0 { Some(episode) } else { None },
                position,
                duration,
                if updated > 0 { updated } else { db::now() },
            ],
        )
        .map_err(|e| e.to_string())?;
        applied += 1;
    }
    Ok(applied)
}

fn merge_watched(conn: &Connection, rows: &[Value]) -> Result<i64, String> {
    let mut applied = 0;
    for row in rows {
        let content_id = text(row, "content_id");
        if content_id.is_empty() {
            continue;
        }
        let season = int(row, "season");
        let episode = int(row, "episode");
        let key = local_key(&content_id, season, episode);
        let watched_at = int(row, "watched_at");
        let existing: Option<i64> = conn
            .query_row("SELECT updated_at FROM watched WHERE key = ?1", params![key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if let Some(local_updated) = existing {
            if local_updated > watched_at {
                continue;
            }
        }
        conn.execute(
            "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(key) DO UPDATE SET watched = 1, updated_at = ?3",
            params![key, content_id, if watched_at > 0 { watched_at } else { db::now() }],
        )
        .map_err(|e| e.to_string())?;
        applied += 1;
    }
    Ok(applied)
}

fn merge_library(conn: &Connection, rows: &[Value]) -> Result<i64, String> {
    let mut applied = 0;
    for row in rows {
        let content_id = text(row, "content_id");
        if content_id.is_empty() {
            continue;
        }
        let added_at = int(row, "added_at");
        let existing: Option<i64> = conn
            .query_row("SELECT added_at FROM library WHERE id = ?1", params![content_id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(|e| e.to_string())?;
        if existing.is_some() {
            continue;
        }
        let name = {
            let title = text(row, "title");
            if title.is_empty() { content_id.clone() } else { title }
        };
        conn.execute(
            "INSERT INTO library (id, media_type, name, poster, background, added_at, meta)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL)
             ON CONFLICT(id) DO NOTHING",
            params![
                content_id,
                content_type(row),
                name,
                row.get("poster").and_then(Value::as_str),
                row.get("background").and_then(Value::as_str),
                if added_at > 0 { added_at } else { db::now() },
            ],
        )
        .map_err(|e| e.to_string())?;
        applied += 1;
    }
    Ok(applied)
}

// ---------------------------------------------------------------------------
// Local rows -> server payloads
// ---------------------------------------------------------------------------

fn local_progress(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT key, meta_id, media_type, season, episode, position, duration, updated_at
             FROM progress WHERE duration > 0",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let media_type: String = row.get(2)?;
            let season: Option<i64> = row.get(3)?;
            let episode: Option<i64> = row.get(4)?;
            let position: f64 = row.get(5)?;
            let duration: f64 = row.get(6)?;
            let updated: i64 = row.get(7)?;
            Ok(json!({
                "content_id": row.get::<_, String>(1)?,
                "content_type": media_type,
                "video_id": row.get::<_, String>(0)?,
                "season": season,
                "episode": episode,
                "position": (position * 1000.0) as i64,
                "duration": (duration * 1000.0) as i64,
                "last_watched": updated,
                "progress_key": row.get::<_, String>(0)?,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn local_watched(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT w.key, w.meta_id, w.updated_at, p.season, p.episode, p.media_type,
                    COALESCE(p.name, l.name, w.meta_id)
             FROM watched w
             LEFT JOIN progress p ON p.key = w.key
             LEFT JOIN library l ON l.id = w.meta_id
             WHERE w.watched = 1",
        )
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let key: String = row.get(0)?;
            let season: Option<i64> = row.get(3)?;
            let episode: Option<i64> = row.get(4)?;
            let media_type: Option<String> = row.get(5)?;
            Ok(json!({
                "content_id": row.get::<_, String>(1)?,
                "content_type": media_type.unwrap_or_else(|| {
                    if season.unwrap_or(0) > 0 { "series".into() } else { "movie".into() }
                }),
                "title": row.get::<_, String>(6)?,
                "season": season,
                "episode": episode,
                "watched_at": row.get::<_, i64>(2)?,
                "video_id": key,
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

fn local_library(conn: &Connection) -> Result<Vec<Value>, String> {
    let mut stmt = conn
        .prepare("SELECT id, media_type, name, poster, background, added_at, meta FROM library")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            let meta: Option<String> = row.get(6)?;
            let meta: Value = meta
                .and_then(|m| serde_json::from_str(&m).ok())
                .unwrap_or(Value::Null);
            Ok(json!({
                "content_id": row.get::<_, String>(0)?,
                "content_type": row.get::<_, String>(1)?,
                "title": row.get::<_, String>(2)?,
                "name": row.get::<_, String>(2)?,
                "poster": row.get::<_, Option<String>>(3)?,
                "background": row.get::<_, Option<String>>(4)?,
                "added_at": row.get::<_, i64>(5)?,
                "poster_shape": "POSTER",
                "release_info": meta.get("releaseInfo").and_then(Value::as_str),
                "imdb_rating": meta
                    .get("imdbRating")
                    .and_then(|v| v.as_str())
                    .and_then(|v| v.parse::<f64>().ok()),
            }))
        })
        .map_err(|e| e.to_string())?;
    rows.collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_round_trip_to_nuvio_shape() {
        assert_eq!(local_key("tt1", 0, 0), "tt1");
        assert_eq!(local_key("tt1", 2, 5), "tt1:2:5");
    }

    #[test]
    fn error_text_is_extracted() {
        let msg = error_from(401, r#"{"message":"Invalid login credentials"}"#);
        assert!(msg.contains("Invalid login credentials"));
    }
}
