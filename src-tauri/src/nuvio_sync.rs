//! Nuvio Cloud sync.
//!
//! Talks to the same Supabase project the official Nuvio apps use: GoTrue for
//! email/password auth, PostgREST `sync_*` RPCs for profiles, watch progress,
//! watched items and the library, and the `addons` table for installed addons.
//! The publishable ("anon") key below is the one shipped in Nuvio's own desktop
//! binary; it is public by design and only grants what row-level security allows
//! for the signed-in user. Both the endpoint and the key can be overridden in
//! settings.
//!
//! Strategy: full pull, merge by timestamp, then upsert everything local. That
//! is a couple of requests per sync for a normal account, needs no cursor
//! bookkeeping and converges no matter which app wrote last.
//!
//! ponytail: addons are pull-only, so this can never wipe the account's list;
//! add `sync_push_addons` when editing addons here should reach the phone.
//! Deletions are not propagated to the server yet either (local clear/remove
//! just comes back on the next pull). Add tombstone pushes when sync_delete_*
//! is wired to the library/progress commands.

use crate::db;
use crate::settings::Settings;
use crate::AppState;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;

pub const DEFAULT_BASE: &str = "https://api.nuvio.tv";
pub const DEFAULT_FALLBACK: &str = "https://api-two.nuvioapp.space";
pub const DEFAULT_KEY: &str = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiIsImlzcyI6InN1cGFiYXNlIiwiaWF0IjoxNzgxNTIxMzQ2LCJleHAiOjE5MzkyMDEzNDZ9.tmQaj682pwzehpqlgCDMnySOqiUvpgRbrE43T4VJpDI";

const SESSION_KEY: &str = "nuvio";
const UA: &str = "Duvy/0.1";

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

/// Stable account identity: the GoTrue user id when present, else the email.
fn account_identity(user_id: &str, email: &str) -> Option<String> {
    if !user_id.is_empty() {
        return Some(format!("id:{user_id}"));
    }
    let email = email.trim().to_lowercase();
    if email.is_empty() {
        None
    } else {
        Some(format!("email:{email}"))
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
    pub addons: i64,
    pub addons_pushed: i64,
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

/// Records that a sync finished without writing back the tokens this call
/// started with: another command may have rotated them while the sync ran.
fn mark_synced(state: &AppState) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    let mut session = load_session(&conn);
    session.last_sync = db::now();
    save_session(&conn, &session)
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

/// Generic request. A transient host failure is retried against the mirror, but
/// only for reads: writes are never replayed.
async fn request(
    http: &reqwest::Client,
    settings: &Settings,
    method: reqwest::Method,
    path: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<Value, String> {
    let key = api_key(settings);
    let mut hosts = vec![base_url(settings)];
    // Only the official endpoint has a mirror. A self-hosted base must not have
    // the account's bearer token handed to Nuvio's hosts.
    if settings.nuvio_base_url.trim().is_empty() {
        hosts.push(DEFAULT_FALLBACK.to_string());
    }
    // A write that already reached a server must not be replayed: a spent
    // refresh token cannot be presented again, and an RPC may have committed.
    let retry_safe = method == reqwest::Method::GET;
    let mut last_error = String::from("no endpoint tried");
    for host in hosts {
        let mut req = http
            .request(method.clone(), format!("{host}{path}"))
            .header("apikey", &key)
            .header("content-type", "application/json")
            .header("user-agent", UA);
        if let Some(body) = body {
            req = req.json(body);
        }
        req = match token {
            Some(t) => req.header("authorization", format!("Bearer {t}")),
            None => req,
        };
        let response = match req.send().await {
            Ok(r) => r,
            Err(e) => {
                last_error = format!("{host}: {e}");
                if !retry_safe {
                    break;
                }
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
        let transient =
            retry_safe && matches!(status.as_u16(), 502 | 503 | 504 | 520 | 521 | 522 | 523 | 524);
        last_error = error_from(status.as_u16(), &text);
        if !transient {
            break;
        }
    }
    Err(last_error)
}

async fn post(
    http: &reqwest::Client,
    settings: &Settings,
    path: &str,
    token: Option<&str>,
    body: &Value,
) -> Result<Value, String> {
    request(http, settings, reqwest::Method::POST, path, token, Some(body)).await
}

async fn get(
    http: &reqwest::Client,
    settings: &Settings,
    path: &str,
    token: &str,
) -> Result<Value, String> {
    request(http, settings, reqwest::Method::GET, path, Some(token), None).await
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

/// One refresh at a time: GoTrue rotates the refresh token on use, so a second
/// concurrent attempt would present one that no longer exists.
static REFRESH: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Returns a usable access token, refreshing it when it is close to expiring.
async fn ensure_token(
    state: &AppState,
    settings: &Settings,
    session: &mut Session,
) -> Result<String, String> {
    let usable = |session: &Session| {
        !session.access_token.is_empty() && session.expires_at > db::now() / 1000 + 60
    };
    if usable(session) {
        return Ok(session.access_token.clone());
    }
    let _guard = REFRESH.lock().await;
    // Whoever held the lock may have refreshed already.
    *session = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        load_session(&conn)
    };
    if usable(session) {
        return Ok(session.access_token.clone());
    }
    if session.refresh_token.is_empty() {
        return Err("Sign in to Nuvio to sync.".into());
    }
    let value = post(
        &state.http,
        settings,
        "/auth/v1/token?grant_type=refresh_token",
        None,
        &json!({ "refresh_token": session.refresh_token }),
    )
    .await?;
    apply_session(session, &value)?;
    // Persist at once: the token just spent is invalid server-side, so losing
    // this to a later failure would sign the user out.
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    save_session(&conn, session)?;
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
        load_session(&conn)
    };
    let previous = account_identity(&session.user_id, &session.email);
    let user = value.get("user");
    let current = account_identity(
        user.and_then(|u| u.get("id")).and_then(Value::as_str).unwrap_or_default(),
        user.and_then(|u| u.get("email"))
            .and_then(Value::as_str)
            .unwrap_or(email),
    );
    session.email = email.to_string();
    apply_session(&mut session, &value)?;

    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    match (previous, current) {
        (Some(previous), Some(current)) if previous != current => {
            // These rows belong to the account that was signed in before.
            db::clear_history(&conn).map_err(|e| e.to_string())?;
            session.last_sync = 0;
        }
        (None, _) if !db::touched_ids(&conn).map_err(|e| e.to_string())?.is_empty() => {
            eprintln!("nuvio: no stored account identity, keeping local history as-is");
        }
        _ => {}
    }
    save_session(&conn, &session)?;
    Ok(status(&conn, &settings))
}

pub fn sign_out(state: &AppState) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    let mut session = load_session(&conn);
    if session.signed_in() {
        // Keep the account identity so the next sign-in can tell accounts apart.
        session.access_token.clear();
        session.refresh_token.clear();
        session.expires_at = 0;
        session.last_sync = 0;
        save_session(&conn, &session)
    } else {
        db::delete_kv(&conn, SESSION_KEY).map_err(|e| e.to_string())
    }
}

/// Switches the active profile. The current profile's history is pushed first,
/// so a failed push aborts the switch and leaves local rows alone.
pub async fn set_profile(state: &AppState, index: i64) -> Result<(), String> {
    let target = index.max(1);
    let (settings, mut session) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        (Settings::load(&conn), load_session(&conn))
    };
    if target == session.profile {
        return Ok(());
    }
    if !session.signed_in() {
        session.profile = target;
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        return save_session(&conn, &session);
    }

    let from = session.profile;
    let token = ensure_token(state, &settings, &mut session)
        .await
        .map_err(|e| format!("Could not reach Nuvio to save profile {from}: {e}"))?;
    push_watching(&state.http, &settings, &token, from, local_history(state)?)
        .await
        .map_err(|e| format!("Could not save profile {from} before switching: {e}"))?;

    // Load the target's history before dropping local rows: a failed pull must
    // leave the current profile's history where it is.
    let pulled = pull(&state.http, &settings, &token, target)
        .await
        .map_err(|e| format!("Could not load profile {target}: {e}"))?;

    session.profile = target;
    session.last_sync = db::now();
    {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        db::clear_history(&conn).map_err(|e| e.to_string())?;
        merge_pulled(&conn, &pulled)?;
        save_session(&conn, &session)?;
    }
    merge_addons(state, &pulled.addons).await?;
    enrich(state).await
}

pub async fn profiles(state: &AppState) -> Result<Vec<NuvioProfile>, String> {
    let (settings, mut session) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        (Settings::load(&conn), load_session(&conn))
    };
    let token = ensure_token(state, &settings, &mut session).await?;
    let value = rpc(&state.http, &settings, &token, "sync_pull_profiles", json!({})).await?;
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

/// Some Nuvio rows store their timestamps in seconds; the local clock is ms.
fn to_ms(at: i64) -> i64 {
    if at > 0 && at < 1_000_000_000_000 {
        at * 1000
    } else {
        at
    }
}

fn content_type(value: &Value) -> String {
    match text(value, "content_type").as_str() {
        "series" => "series".into(),
        other if other.is_empty() => "movie".into(),
        other => other.into(),
    }
}

/// Local progress key for a remote entry: `metaId` for movies, `metaId:s:e`
/// for episodes, so Duvy can resolve its own resume lookups.
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
    let token = ensure_token(state, &settings, &mut session).await?;
    let pid = session.profile;

    let pulled = pull(&state.http, &settings, &token, pid).await?;
    let mut report = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        merge_pulled(&conn, &pulled)?
    };
    report.addons = merge_addons(state, &pulled.addons).await?;
    // Best-effort: a read-only addons table must not cost the history push.
    report.addons_pushed =
        push_addons(state, &settings, &token, pid, &pulled.addons).await.unwrap_or(0);

    // ---- push -------------------------------------------------------------
    let history = local_history(state)?;
    let mut pushed = push_watching(&state.http, &settings, &token, pid, history).await?;
    let library = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        local_library(&conn)?
    };
    if !library.is_empty() {
        rpc(
            &state.http,
            &settings,
            &token,
            "sync_push_library_items",
            json!({ "p_profile_id": pid, "p_items": library }),
        )
        .await?;
        pushed += library.len() as i64;
    }
    report.pushed = pushed + report.addons_pushed;

    enrich(state).await?;

    mark_synced(state)?;
    Ok(report)
}

struct Pulled {
    progress: Vec<Value>,
    watched: Vec<Value>,
    library: Vec<Value>,
    addons: Vec<Value>,
}

async fn pull(
    http: &reqwest::Client,
    settings: &Settings,
    token: &str,
    pid: i64,
) -> Result<Pulled, String> {
    let progress = async {
        let value = rpc(
            http,
            settings,
            token,
            "sync_pull_watch_progress",
            json!({ "p_profile_id": pid, "p_since_last_watched": 0, "p_limit": 1000 }),
        )
        .await?;
        Ok::<_, String>(as_rows(value))
    };

    let watched = async {
        let mut watched = Vec::new();
        for page in 1..=10 {
            let batch = as_rows(
                rpc(
                    http,
                    settings,
                    token,
                    "sync_pull_watched_items",
                    json!({ "p_profile_id": pid, "p_page": page, "p_page_size": 500 }),
                )
                .await?,
            );
            let done = batch.len() < 500;
            watched.extend(batch);
            if done {
                break;
            }
        }
        Ok::<_, String>(watched)
    };

    let library = async {
        let mut library = Vec::new();
        for page in 0..20 {
            let batch = as_rows(
                rpc(
                    http,
                    settings,
                    token,
                    "sync_pull_library",
                    json!({ "p_profile_id": pid, "p_limit": 500, "p_offset": page * 500 }),
                )
                .await?,
            );
            let done = batch.len() < 500;
            library.extend(batch);
            if done {
                break;
            }
        }
        Ok::<_, String>(library)
    };

    // Addons live in a plain table rather than a `sync_*` RPC. A backend that
    // refuses the read must not cost the user their history sync.
    let addons = async {
        match get(http, settings, &addons_path(pid), token).await {
            Ok(value) => as_rows(value),
            Err(error) => {
                eprintln!("nuvio: addon list unavailable: {error}");
                Vec::new()
            }
        }
    };

    // Independent pulls, so run them together; the merge order is unchanged.
    let (progress, watched, library, addons) = tokio::join!(progress, watched, library, addons);

    Ok(Pulled {
        progress: progress?,
        watched: watched?,
        library: library?,
        addons,
    })
}

/// PostgREST query for one profile's addons, newest ordering preserved.
fn addons_path(pid: i64) -> String {
    format!(
        "/rest/v1/addons?profile_id=eq.{pid}&select=url,name,enabled,sort_order&order=sort_order.asc"
    )
}

/// The manifest URL Nuvio stores for a row, normalised the way an install is.
fn remote_addon_url(row: &Value) -> Option<String> {
    let url = crate::addons::normalize_addon_url(&text(row, "url"));
    if url.is_empty() {
        None
    } else {
        Some(url)
    }
}

/// Installs addons the account has and this machine does not. Pull-only: local
/// addons are never removed, so a sync cannot wipe a source you added here.
async fn merge_addons(state: &AppState, rows: &[Value]) -> Result<i64, String> {
    if rows.is_empty() {
        return Ok(0);
    }
    let installed: Vec<String> = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        db::list_addons(&conn)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|addon| addon.url)
            .collect()
    };
    let mut added = 0;
    for row in rows {
        let Some(url) = remote_addon_url(row) else { continue };
        if installed.iter().any(|known| known == &url) {
            continue;
        }
        let manifest_url = format!("{url}/manifest.json");
        let value = match state
            .http
            .get(&manifest_url)
            .header("accept", "application/json")
            .send()
            .await
        {
            Ok(response) if response.status().is_success() => {
                match response.json::<Value>().await {
                    Ok(value) => value,
                    Err(_) => continue,
                }
            }
            _ => continue,
        };
        let Ok(manifest) = serde_json::from_value::<crate::addons::Manifest>(value.clone()) else {
            continue;
        };
        if manifest.id.trim().is_empty() || manifest.name.trim().is_empty() {
            continue;
        }
        let enabled = row.get("enabled").and_then(Value::as_bool).unwrap_or(true);
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        if db::upsert_addon(&conn, &url, &manifest.id, &manifest.name, &value).is_err() {
            continue;
        }
        if !enabled {
            let _ = db::set_addon_enabled(&conn, &url, false);
        }
        added += 1;
    }
    Ok(added)
}

/// Adds local addons the account does not have. Remote URLs win, so the same
/// addon already on Nuvio and Stremio is never inserted twice.
async fn push_addons(
    state: &AppState,
    settings: &Settings,
    token: &str,
    pid: i64,
    remote: &[Value],
) -> Result<i64, String> {
    let mut seen: HashSet<String> = remote.iter().filter_map(remote_addon_url).collect();
    let local = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        db::list_addons(&conn).map_err(|e| e.to_string())?
    };
    let mut pushed = 0;
    for addon in local {
        let url = crate::addons::normalize_addon_url(&addon.url);
        if url.is_empty() || !seen.insert(url.clone()) {
            continue;
        }
        let body = json!({
            "profile_id": pid,
            "url": url,
            "name": addon.name,
            "enabled": addon.enabled,
            "sort_order": addon.position,
        });
        post(&state.http, settings, "/rest/v1/addons", Some(token), &body).await?;
        pushed += 1;
    }
    Ok(pushed)
}

fn merge_pulled(conn: &Connection, pulled: &Pulled) -> Result<SyncReport, String> {
    let mut report = SyncReport::default();
    report.progress = merge_progress(conn, &pulled.progress)?;
    report.watched = merge_watched(conn, &pulled.watched)?;
    report.library = merge_library(conn, &pulled.library)?;
    // Watched on another device and never played here: no progress row exists
    // to carry a name. Park a zero-length one so the enrich pass can title it.
    // Zero duration keeps it out of every progress and push query.
    conn.execute(
        "INSERT OR IGNORE INTO progress (key, meta_id, media_type, name, poster, background,
                               season, episode, episode_title, position, duration, updated_at)
         SELECT w.key, w.meta_id, COALESCE(l.media_type, 'movie'), '',
                l.poster, l.background, NULL, NULL, NULL, 0, 0, w.updated_at
         FROM watched w
         LEFT JOIN library l ON l.id = w.meta_id
         WHERE w.watched = 1
           AND NOT EXISTS (SELECT 1 FROM progress p WHERE p.meta_id = w.meta_id)",
        [],
    )
    .map_err(|e| e.to_string())?;
    Ok(report)
}

fn local_history(state: &AppState) -> Result<(Vec<Value>, Vec<Value>), String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    Ok((local_progress(&conn)?, local_watched(&conn)?))
}

async fn push_watching(
    http: &reqwest::Client,
    settings: &Settings,
    token: &str,
    pid: i64,
    history: (Vec<Value>, Vec<Value>),
) -> Result<i64, String> {
    let (progress, watched) = history;
    let sent = (progress.len() + watched.len()) as i64;
    if !progress.is_empty() {
        rpc(
            http,
            settings,
            token,
            "sync_push_watch_progress",
            json!({ "p_profile_id": pid, "p_entries": progress }),
        )
        .await?;
    }
    if !watched.is_empty() {
        rpc(
            http,
            settings,
            token,
            "sync_push_watched_items",
            json!({ "p_profile_id": pid, "p_items": watched }),
        )
        .await?;
    }
    Ok(sent)
}

/// Pulled rows carry ids only, so resolve titles and artwork.
async fn enrich(state: &AppState) -> Result<(), String> {
    let mut missing = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        let mut rows = db::progress_missing_meta(&conn).unwrap_or_default();
        rows.append(&mut db::library_missing_meta(&conn).unwrap_or_default());
        rows
    };
    // The same title usually lands in both tables; resolve it once.
    missing.sort();
    missing.dedup();
    if missing.is_empty() {
        return Ok(());
    }
    let filled = crate::meta::fill_missing(&state.http, missing).await;
    if filled.is_empty() {
        return Ok(());
    }
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
    Ok(())
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
        let updated = to_ms(int(row, "last_watched"));
        let position = int(row, "position") as f64 / 1000.0;
        let duration = int(row, "duration") as f64 / 1000.0;
        if duration <= 0.0 {
            continue;
        }
        // A remote position past the end would resume beyond the file.
        let position = position.clamp(0.0, duration);
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
        let watched_at = to_ms(int(row, "watched_at"));
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
        let added_at = to_ms(int(row, "added_at"));
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
    fn remote_timestamps_normalise_to_milliseconds() {
        assert_eq!(to_ms(1_763_000_000), 1_763_000_000_000);
        assert_eq!(to_ms(1_763_000_000_123), 1_763_000_000_123);
        assert_eq!(to_ms(0), 0);
    }

    #[test]
    fn addon_rows_normalise_to_manifest_urls() {
        let row = json!({ "url": "https://example.com/addon/", "enabled": true, "sort_order": 0 });
        assert_eq!(
            remote_addon_url(&row).as_deref(),
            Some("https://example.com/addon")
        );
        assert_eq!(
            remote_addon_url(&json!({ "url": "stremio://a/b/manifest.json" })).as_deref(),
            Some("https://a/b")
        );
        assert_eq!(remote_addon_url(&json!({ "url": "   " })), None);
        assert!(addons_path(2).contains("profile_id=eq.2"));
    }

    #[test]
    fn error_text_is_extracted() {
        let msg = error_from(401, r#"{"message":"Invalid login credentials"}"#);
        assert!(msg.contains("Invalid login credentials"));
    }
}
