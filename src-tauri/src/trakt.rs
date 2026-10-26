//! Trakt: device-code auth, scrobbling and two-way watched/progress sync.
//!
//! Everything lives in one `settings` row (`"trakt"`) so a disconnect never
//! touches the SQLite media tables, and the app credentials survive it.
//!
//! ponytail: remote playback entries only enrich resume points that already
//! exist locally, because `/sync/playback` has no duration and a new local row
//! with `duration = 0` would be invisible. Add a duration lookup (library meta
//! runtime) if new-device resume ever needs to appear here.

use crate::{db, AppState};
use reqwest::Method;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use tauri::State;

const KV: &str = "trakt";
const API: &str = "https://api.trakt.tv";
const ACTIVATE: &str = "https://trakt.tv/activate";
const REDIRECT: &str = "urn:ietf:wg:oauth:2.0:oob";
const DAY_SECS: i64 = 86_400;

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TraktStatus {
    pub connected: bool,
    pub username: String,
    pub last_sync: i64,
    /// Set while a device code is waiting for the user to approve it.
    pub user_code: String,
    pub verification_url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    client_id: String,
    client_secret: String,
    access_token: String,
    refresh_token: String,
    /// Epoch seconds.
    expires_at: i64,
    username: String,
    /// Epoch milliseconds.
    last_sync: i64,
    device_code: String,
    user_code: String,
    verification_url: String,
}

// ---------------------------------------------------------------------------
// Persistence + status
// ---------------------------------------------------------------------------

fn load(state: &AppState) -> Result<Store, String> {
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    Ok(db::read_kv(&conn, KV)
        .ok()
        .flatten()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default())
}

fn save(state: &AppState, store: &Store) -> Result<(), String> {
    let value = serde_json::to_value(store).map_err(|e| e.to_string())?;
    let conn = state.db.0.lock().map_err(|e| e.to_string())?;
    db::write_kv(&conn, KV, &value).map_err(|e| e.to_string())
}

fn status_of(store: &Store) -> TraktStatus {
    let pending = !store.device_code.is_empty() && store.access_token.is_empty();
    TraktStatus {
        connected: !store.access_token.is_empty(),
        username: store.username.clone(),
        last_sync: store.last_sync,
        user_code: if pending { store.user_code.clone() } else { String::new() },
        verification_url: if pending {
            if store.verification_url.is_empty() {
                ACTIVATE.to_string()
            } else {
                store.verification_url.clone()
            }
        } else {
            String::new()
        },
    }
}

#[tauri::command]
pub fn status(state: State<'_, AppState>) -> Result<TraktStatus, String> {
    Ok(status_of(&load(&state)?))
}

/// Saves the API app credentials without starting the device flow.
///
/// Registration lives in `lib.rs` (owned elsewhere); `begin` also accepts the
/// pair so the UI works without this command being wired up yet.
#[allow(dead_code)]
#[tauri::command]
pub fn set_client(
    state: State<'_, AppState>,
    client_id: String,
    client_secret: String,
) -> Result<(), String> {
    let client_id = client_id.trim().to_string();
    let client_secret = client_secret.trim().to_string();
    if client_id.is_empty() || client_secret.is_empty() {
        return Err("Both the Trakt client id and client secret are required.".into());
    }
    let mut store = load(&state)?;
    apply_client(&mut store, client_id, client_secret);
    save(&state, &store)
}

fn apply_client(store: &mut Store, client_id: String, client_secret: String) {
    store.client_id = client_id;
    store.client_secret = client_secret;
    // Tokens minted for another app are worthless.
    store.access_token.clear();
    store.refresh_token.clear();
    store.expires_at = 0;
    store.username.clear();
    store.device_code.clear();
    store.user_code.clear();
    store.verification_url.clear();
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

fn success(status: u16) -> bool {
    (200..300).contains(&status)
}

fn text(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn http_error(status: u16, value: &Value) -> String {
    let detail = ["error_description", "error", "message"]
        .iter()
        .find_map(|k| value.get(k).and_then(Value::as_str))
        .or_else(|| value.as_str())
        .unwrap_or("no detail")
        .chars()
        .take(200)
        .collect::<String>();
    match status {
        401 | 403 => format!("Trakt rejected the credentials ({status}): {detail}"),
        429 => format!("Trakt is rate limiting this app ({status}): {detail}"),
        _ => format!("Trakt request failed ({status}): {detail}"),
    }
}

async fn send(
    http: &reqwest::Client,
    method: Method,
    path: &str,
    client_id: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<(u16, Value, Option<i64>), String> {
    let mut request = http
        .request(method, format!("{API}{path}"))
        .header("content-type", "application/json")
        .header("trakt-api-version", "2")
        .header("trakt-api-key", client_id);
    if let Some(token) = token {
        request = request.header("authorization", format!("Bearer {token}"));
    }
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("Trakt request failed: {e}"))?;
    let status = response.status().as_u16();
    // Trakt paginates the watched endpoints; it sends the total page count so
    // an unpaginated legacy response (no header) can be treated as complete.
    let pages = response
        .headers()
        .get("x-pagination-page-count")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<i64>().ok());
    let raw = response.text().await.unwrap_or_default();
    let value = if raw.trim().is_empty() {
        Value::Null
    } else {
        serde_json::from_str(&raw).unwrap_or(Value::String(raw))
    };
    Ok((status, value, pages))
}

async fn call(
    http: &reqwest::Client,
    method: Method,
    path: &str,
    client_id: &str,
    token: Option<&str>,
    body: Option<&Value>,
) -> Result<(u16, Value), String> {
    let (status, value, _) = send(http, method, path, client_id, token, body).await?;
    Ok((status, value))
}

/// Reads every page of a paginated sync endpoint. A response without the
/// pagination header is a complete (old-style) list.
async fn get_all(
    http: &reqwest::Client,
    path: &str,
    extra_query: &str,
    client_id: &str,
    token: &str,
) -> Result<Vec<Value>, String> {
    let mut all = Vec::new();
    let mut page = 1;
    loop {
        let query = if extra_query.is_empty() {
            format!("?page={page}&limit=100")
        } else {
            format!("?page={page}&limit=100&{extra_query}")
        };
        let (status, value, pages) =
            send(http, Method::GET, &format!("{path}{query}"), client_id, Some(token), None).await?;
        if !success(status) {
            return Err(http_error(status, &value));
        }
        all.extend(rows(value));
        if pages.map_or(true, |total| page >= total) || page >= 50 {
            break;
        }
        page += 1;
    }
    Ok(all)
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

fn apply_tokens(store: &mut Store, value: &Value, now_secs: i64) -> Result<(), String> {
    let access = value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or("Trakt did not return an access token.")?;
    store.access_token = access.to_string();
    if let Some(refresh) = value.get("refresh_token").and_then(Value::as_str) {
        if !refresh.is_empty() {
            store.refresh_token = refresh.to_string();
        }
    }
    let ttl = value
        .get("expires_in")
        .and_then(Value::as_i64)
        .unwrap_or(90 * DAY_SECS);
    store.expires_at = expiry_from(now_secs, ttl);
    Ok(())
}

/// Refresh a day before the 90-day token actually dies.
fn needs_refresh(expires_at: i64, now_secs: i64) -> bool {
    expires_at - now_secs <= DAY_SECS
}

fn expiry_from(now_secs: i64, expires_in: i64) -> i64 {
    now_secs + expires_in.max(60)
}

async fn ensure_token(http: &reqwest::Client, store: &mut Store) -> Result<String, String> {
    let now = db::now() / 1000;
    if !needs_refresh(store.expires_at, now) {
        return Ok(store.access_token.clone());
    }
    if store.refresh_token.is_empty() {
        return Err("The Trakt session expired. Connect again.".into());
    }
    let body = json!({
        "refresh_token": store.refresh_token,
        "client_id": store.client_id,
        "client_secret": store.client_secret,
        "redirect_uri": REDIRECT,
        "grant_type": "refresh_token",
    });
    let (status, value) = call(http, Method::POST, "/oauth/token", &store.client_id, None, Some(&body)).await?;
    if !success(status) {
        return Err(http_error(status, &value));
    }
    apply_tokens(store, &value, now)?;
    Ok(store.access_token.clone())
}

/// Starts the device flow: returns the code the user types into trakt.tv/activate.
///
/// The client id/secret are optional so the form can save them in the same
/// round trip; when omitted, the stored pair is reused.
#[tauri::command]
pub async fn begin(
    state: State<'_, AppState>,
    client_id: Option<String>,
    client_secret: Option<String>,
) -> Result<TraktStatus, String> {
    let mut store = load(&state)?;
    let id = client_id.unwrap_or_default().trim().to_string();
    let secret = client_secret.unwrap_or_default().trim().to_string();
    if !id.is_empty() || !secret.is_empty() {
        if id.is_empty() || secret.is_empty() {
            return Err("Both the Trakt client id and client secret are required.".into());
        }
        apply_client(&mut store, id, secret);
    }
    if store.client_id.is_empty() || store.client_secret.is_empty() {
        return Err("Paste the client id and secret of a free Trakt API app first.".into());
    }

    let body = json!({ "client_id": store.client_id });
    let (status, value) = call(
        &state.http,
        Method::POST,
        "/oauth/device/code",
        &store.client_id,
        None,
        Some(&body),
    )
    .await?;
    if !success(status) {
        return Err(http_error(status, &value));
    }
    let device_code = text(&value, "device_code");
    if device_code.is_empty() {
        return Err("Trakt did not return a device code.".into());
    }
    store.device_code = device_code;
    store.user_code = text(&value, "user_code");
    store.verification_url = match text(&value, "verification_url") {
        url if url.is_empty() => ACTIVATE.to_string(),
        url => url,
    };
    save(&state, &store)?;
    Ok(status_of(&store))
}

/// Polls the device flow once; resolves to a connected status.
#[tauri::command]
pub async fn poll(state: State<'_, AppState>) -> Result<TraktStatus, String> {
    let mut store = load(&state)?;
    if !store.access_token.is_empty() {
        return Ok(status_of(&store));
    }
    if store.device_code.is_empty() {
        return Err("No Trakt device code in progress. Start the connection first.".into());
    }

    let body = json!({
        "code": store.device_code,
        "client_id": store.client_id,
        "client_secret": store.client_secret,
    });
    let (status, value) = call(
        &state.http,
        Method::POST,
        "/oauth/device/token",
        &store.client_id,
        None,
        Some(&body),
    )
    .await?;
    match status {
        // Still waiting for the user to approve the code.
        400 => Ok(status_of(&store)),
        200..=299 => {
            apply_tokens(&mut store, &value, db::now() / 1000)?;
            store.device_code.clear();
            store.user_code.clear();
            store.verification_url.clear();
            if let Ok((code, me)) = call(
                &state.http,
                Method::GET,
                "/users/me",
                &store.client_id,
                Some(&store.access_token),
                None,
            )
            .await
            {
                if success(code) {
                    store.username = text(&me, "username");
                }
            }
            save(&state, &store)?;
            Ok(status_of(&store))
        }
        404 | 409 | 410 | 418 => {
            store.device_code.clear();
            store.user_code.clear();
            store.verification_url.clear();
            save(&state, &store)?;
            Err(match status {
                404 => "Trakt did not recognise that code.".to_string(),
                409 => "That code was already used. Start again.".to_string(),
                410 => "The code expired. Start again.".to_string(),
                _ => "The Trakt approval was denied.".to_string(),
            })
        }
        _ => Err(http_error(status, &value)),
    }
}

#[tauri::command]
pub fn disconnect(state: State<'_, AppState>) -> Result<(), String> {
    let mut store = load(&state)?;
    // Keep the API app credentials: reconnecting should not need a re-paste.
    store.access_token.clear();
    store.refresh_token.clear();
    store.expires_at = 0;
    store.username.clear();
    store.last_sync = 0;
    store.device_code.clear();
    store.user_code.clear();
    store.verification_url.clear();
    save(&state, &store)
}

// ---------------------------------------------------------------------------
// Ids, keys and timestamps (pure)
// ---------------------------------------------------------------------------

#[derive(Clone, Debug, Default, PartialEq)]
struct Ids {
    imdb: Option<String>,
    tmdb: Option<i64>,
}

impl Ids {
    fn is_empty(&self) -> bool {
        self.imdb.is_none() && self.tmdb.is_none()
    }

    fn to_json(&self) -> Value {
        let mut map = serde_json::Map::new();
        if let Some(imdb) = &self.imdb {
            map.insert("imdb".into(), json!(imdb));
        }
        if let Some(tmdb) = self.tmdb {
            map.insert("tmdb".into(), json!(tmdb));
        }
        Value::Object(map)
    }

    fn merge(&mut self, other: Ids) {
        if self.imdb.is_none() {
            self.imdb = other.imdb;
        }
        if self.tmdb.is_none() {
            self.tmdb = other.tmdb;
        }
    }
}

/// Reads a Stremio-style id: `tt1234567`, `imdb:tt1234567`, `tmdb:1396`.
fn ids_from_text(raw: &str) -> Ids {
    let raw = raw.trim();
    let body = raw.strip_prefix("imdb:").unwrap_or(raw);
    let bytes = body.as_bytes();
    if bytes.len() > 2
        && bytes[0].eq_ignore_ascii_case(&b't')
        && bytes[1].eq_ignore_ascii_case(&b't')
        && bytes[2..].iter().all(u8::is_ascii_digit)
    {
        return Ids {
            imdb: Some(format!("tt{}", &body[2..])),
            tmdb: None,
        };
    }
    if let Some(rest) = raw.strip_prefix("tmdb:") {
        if let Ok(tmdb) = rest.parse::<i64>() {
            return Ids { imdb: None, tmdb: Some(tmdb) };
        }
    }
    Ids::default()
}

/// Reads `meta.ids.imdb` / `meta.ids.tmdb`, then `meta.id`.
fn ids_from_meta(meta: &Value) -> Ids {
    let mut ids = Ids::default();
    if let Some(object) = meta.get("ids") {
        if let Some(imdb) = object.get("imdb").and_then(Value::as_str) {
            ids.merge(ids_from_text(imdb));
        }
        if let Some(tmdb) = object.get("tmdb").and_then(Value::as_i64) {
            ids.merge(Ids { imdb: None, tmdb: Some(tmdb) });
        }
    }
    if ids.is_empty() {
        if let Some(id) = meta.get("id").and_then(Value::as_str) {
            ids = ids_from_text(id);
        }
    }
    ids
}

fn ids_from_json(value: Option<&Value>) -> Ids {
    value.map(ids_from_meta).unwrap_or_default()
}

/// IMDb/TMDB ids for a local row: the meta id itself when it is one, plus
/// whatever the library record carries.
fn resolve_ids(conn: &Connection, meta_id: &str) -> Ids {
    let mut ids = ids_from_text(meta_id);
    let raw: Option<Option<String>> = conn
        .query_row("SELECT meta FROM library WHERE id = ?1", params![meta_id], |r| r.get(0))
        .optional()
        .ok()
        .flatten();
    if let Some(meta) = raw.flatten().and_then(|m| serde_json::from_str::<Value>(&m).ok()) {
        ids.merge(ids_from_meta(&meta));
    }
    ids
}

/// `metaId` for movies, `metaId:season:episode` for episodes. Meta ids can
/// contain colons (`tmdb:1396`), so split from the right.
fn split_key(key: &str) -> (String, Option<i64>, Option<i64>) {
    let mut parts = key.rsplitn(3, ':');
    let episode = parts.next().and_then(|s| s.parse::<i64>().ok());
    let season = parts.next().and_then(|s| s.parse::<i64>().ok());
    match (parts.next(), season, episode) {
        (Some(meta_id), Some(season), Some(episode)) => (meta_id.to_string(), Some(season), Some(episode)),
        _ => (key.to_string(), None, None),
    }
}

fn local_key(meta_id: &str, season: i64, episode: i64) -> String {
    format!("{meta_id}:{season}:{episode}")
}

fn library_index(conn: &Connection) -> Result<HashMap<String, String>, String> {
    let mut stmt = conn
        .prepare("SELECT id, meta FROM library")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|e| e.to_string())?;
    let mut index = HashMap::new();
    for row in rows {
        let (id, meta) = row.map_err(|e| e.to_string())?;
        let mut ids = ids_from_text(&id);
        if let Some(meta) = meta.and_then(|m| serde_json::from_str::<Value>(&m).ok()) {
            ids.merge(ids_from_meta(&meta));
        }
        if let Some(imdb) = ids.imdb {
            index.entry(format!("imdb:{imdb}")).or_insert_with(|| id.clone());
        }
        if let Some(tmdb) = ids.tmdb {
            index.entry(format!("tmdb:{tmdb}")).or_insert_with(|| id.clone());
        }
    }
    Ok(index)
}

fn local_for(ids: &Ids, index: &HashMap<String, String>) -> Option<String> {
    if let Some(imdb) = &ids.imdb {
        if let Some(id) = index.get(&format!("imdb:{imdb}")) {
            return Some(id.clone());
        }
    }
    ids.tmdb
        .and_then(|tmdb| index.get(&format!("tmdb:{tmdb}")).cloned())
}

/// Local meta ids are usually Stremio ids, which are exactly these canonical
/// IMDb/TMDB strings, so a row outside the library is still addressable.
fn canonical_local(ids: &Ids) -> Option<String> {
    ids.imdb
        .clone()
        .or_else(|| ids.tmdb.map(|tmdb| format!("tmdb:{tmdb}")))
}

fn movie_entry(ids: &Ids, watched_at: i64) -> Value {
    json!({ "ids": ids.to_json(), "watched_at": iso(watched_at) })
}

fn episode_entry(ids: &Ids, season: i64, episode: i64, watched_at: i64) -> Value {
    json!({
        "ids": ids.to_json(),
        "seasons": [{ "number": season, "episodes": [{ "number": episode, "watched_at": iso(watched_at) }] }],
    })
}

// --- civil date <-> epoch, no chrono dependency ----------------------------

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let y = if month <= 2 { year - 1 } else { year };
    let era = (if y >= 0 { y } else { y - 399 }) / 400;
    let yoe = y - era * 400;
    let mp = (month + 9) % 12;
    let doy = (153 * mp + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146_097 + doe - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let z = days + 719_468;
    let era = (if z >= 0 { z } else { z - 146_096 }) / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    (if month <= 2 { year + 1 } else { year }, month, day)
}

fn iso(ms: i64) -> String {
    let secs = ms.div_euclid(1000);
    let millis = ms.rem_euclid(1000);
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (year, month, day) = civil_from_days(days);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{millis:03}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

fn parse_iso(raw: &str) -> Option<i64> {
    let body = raw.trim().trim_end_matches('Z');
    let (base, millis) = match body.split_once('.') {
        Some((base, fraction)) => {
            let digits: String = fraction.chars().filter(|c| c.is_ascii_digit()).take(3).collect();
            let millis = format!("{digits:0<3}").parse::<i64>().ok()?;
            (base, millis)
        }
        None => (body, 0),
    };
    if base.len() != 19 {
        return None;
    }
    let number = |from: usize, to: usize| base.get(from..to)?.parse::<i64>().ok();
    let (year, month, day) = (number(0, 4)?, number(5, 7)?, number(8, 10)?);
    let (hour, minute, second) = (number(11, 13)?, number(14, 16)?, number(17, 19)?);
    let secs = days_from_civil(year, month, day) * 86_400 + hour * 3600 + minute * 60 + second;
    Some(secs * 1000 + millis)
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

fn rows(value: Value) -> Vec<Value> {
    match value {
        Value::Array(rows) => rows,
        _ => Vec::new(),
    }
}

/// Newest write wins; a tie goes to the remote row so both sides converge.
fn should_apply(local_updated: Option<i64>, remote_updated: i64) -> bool {
    local_updated.map_or(true, |local| remote_updated >= local)
}

fn upsert_watched(conn: &Connection, key: &str, meta_id: &str, watched_at: i64) -> Result<bool, String> {
    let watched_at = if watched_at > 0 { watched_at } else { db::now() };
    let local: Option<i64> = conn
        .query_row("SELECT updated_at FROM watched WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
        .map_err(|e| e.to_string())?;
    if !should_apply(local, watched_at) {
        return Ok(false);
    }
    conn.execute(
        "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(key) DO UPDATE SET watched = 1, updated_at = ?3",
        params![key, meta_id, watched_at],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

fn merge_watched(
    conn: &Connection,
    movies: &[Value],
    shows: &[Value],
    index: &HashMap<String, String>,
) -> Result<(i64, HashSet<String>), String> {
    let mut applied = 0;
    let mut keys = HashSet::new();

    for row in movies {
        let ids = ids_from_json(row.get("movie"));
        let Some(meta_id) = local_for(&ids, index).or_else(|| canonical_local(&ids)) else {
            continue;
        };
        let watched_at = parse_iso(&text(row, "last_watched_at")).unwrap_or_else(db::now);
        keys.insert(meta_id.clone());
        if upsert_watched(conn, &meta_id, &meta_id, watched_at)? {
            applied += 1;
        }
    }

    for row in shows {
        let ids = ids_from_json(row.get("show"));
        let Some(meta_id) = local_for(&ids, index).or_else(|| canonical_local(&ids)) else {
            continue;
        };
        let seasons = row.get("seasons").and_then(Value::as_array);
        for season in seasons.into_iter().flatten() {
            let number = season.get("number").and_then(Value::as_i64).unwrap_or(0);
            for episode in season
                .get("episodes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
            {
                let number_in_season = episode.get("number").and_then(Value::as_i64).unwrap_or(0);
                let plays = episode.get("plays").and_then(Value::as_i64).unwrap_or(0);
                if number <= 0 || number_in_season <= 0 || plays <= 0 {
                    continue;
                }
                let watched_at = parse_iso(&text(episode, "last_watched_at"))
                    .or_else(|| parse_iso(&text(row, "last_watched_at")))
                    .unwrap_or_else(db::now);
                let key = local_key(&meta_id, number, number_in_season);
                keys.insert(key.clone());
                if upsert_watched(conn, &key, &meta_id, watched_at)? {
                    applied += 1;
                }
            }
        }
    }

    Ok((applied, keys))
}

/// Remote pause points only adjust rows that already exist locally: without a
/// duration there is nothing sensible to write for a brand-new row.
fn merge_playback(
    conn: &Connection,
    rows: &[Value],
    index: &HashMap<String, String>,
) -> Result<i64, String> {
    let mut applied = 0;
    for row in rows {
        let paused_at = match parse_iso(&text(row, "paused_at")) {
            Some(ms) if ms > 0 => ms,
            _ => continue,
        };
        let percent = row.get("progress").and_then(Value::as_f64).unwrap_or(0.0);
        if !(0.0..100.0).contains(&percent) {
            continue;
        }

        let key = match text(row, "type").as_str() {
            "movie" => {
                let ids = ids_from_json(row.get("movie"));
                match local_for(&ids, index).or_else(|| canonical_local(&ids)) {
                    Some(id) => id,
                    None => continue,
                }
            }
            "episode" => {
                let ids = ids_from_json(row.get("show"));
                let Some(meta_id) = local_for(&ids, index).or_else(|| canonical_local(&ids)) else {
                    continue;
                };
                let season = row.get("episode").and_then(|e| e.get("season")).and_then(Value::as_i64);
                let episode = row.get("episode").and_then(|e| e.get("number")).and_then(Value::as_i64);
                match (season, episode) {
                    (Some(season), Some(episode)) if season > 0 && episode > 0 => {
                        local_key(&meta_id, season, episode)
                    }
                    _ => continue,
                }
            }
            _ => continue,
        };

        let Some(existing) = db::get_progress(conn, &key).map_err(|e| e.to_string())? else {
            continue;
        };
        if existing.duration <= 0.0 || !should_apply(Some(existing.updated_at), paused_at) {
            continue;
        }
        let position = (existing.duration * percent / 100.0).clamp(0.0, existing.duration);
        conn.execute(
            "UPDATE progress SET position = ?2, updated_at = ?3 WHERE key = ?1",
            params![key, position, paused_at],
        )
        .map_err(|e| e.to_string())?;
        applied += 1;
    }
    Ok(applied)
}

/// Local watched rows Trakt does not know about yet, split into the two
/// `/sync/history` arrays.
fn pending_history(
    conn: &Connection,
    remote: &HashSet<String>,
) -> Result<(Vec<Value>, Vec<Value>), String> {
    let mut stmt = conn
        .prepare("SELECT key, meta_id, updated_at FROM watched WHERE watched = 1")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    let mut movies = Vec::new();
    let mut episodes = Vec::new();
    for row in rows {
        let (key, meta_id, watched_at) = row.map_err(|e| e.to_string())?;
        if remote.contains(&key) {
            continue;
        }
        let (_, season, episode) = split_key(&key);
        let ids = resolve_ids(conn, &meta_id);
        if ids.is_empty() {
            continue;
        }
        match (season, episode) {
            (Some(season), Some(episode)) => {
                if season > 0 && episode > 0 {
                    episodes.push(episode_entry(&ids, season, episode, watched_at));
                }
            }
            _ => movies.push(movie_entry(&ids, watched_at)),
        }
    }
    Ok((movies, episodes))
}

/// Two-way sync: pull Trakt history/progress into SQLite, then push local rows
/// Trakt has never seen. `{pulled, pushed}` counts rows, not API calls.
#[tauri::command]
pub async fn sync(state: State<'_, AppState>) -> Result<Value, String> {
    let mut store = load(&state)?;
    if store.access_token.is_empty() {
        return Err("Connect Trakt to sync.".into());
    }
    let token = ensure_token(&state.http, &mut store).await?;
    // Persist a refreshed token before the network round trips below so a
    // failure here does not strand the old (already invalidated) refresh token.
    save(&state, &store)?;

    let movies = get_all(
        &state.http,
        "/sync/watched/movies",
        "extended=min",
        &store.client_id,
        &token,
    )
    .await?;
    // Seasons and episodes are no longer included by default; the sync needs
    // `extended=progress` to know which episodes were watched.
    let shows = get_all(
        &state.http,
        "/sync/watched/shows",
        "extended=progress",
        &store.client_id,
        &token,
    )
    .await?;
    let playback = get_all(
        &state.http,
        "/sync/playback",
        "",
        &store.client_id,
        &token,
    )
    .await?;

    let (pulled, pending) = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        let index = library_index(&conn)?;
        let (mut pulled, remote_keys) = merge_watched(&conn, &movies, &shows, &index)?;
        pulled += merge_playback(&conn, &playback, &index)?;
        let pending = pending_history(&conn, &remote_keys)?;
        (pulled, pending)
    };

    let pushed = (pending.0.len() + pending.1.len()) as i64;
    if pushed > 0 {
        let body = json!({ "movies": pending.0, "episodes": pending.1 });
        checked(
            call(
                &state.http,
                Method::POST,
                "/sync/history",
                &store.client_id,
                Some(&token),
                Some(&body),
            )
            .await?,
        )?;
    }

    store.last_sync = db::now();
    save(&state, &store)?;
    Ok(json!({ "pulled": pulled, "pushed": pushed }))
}

fn checked((status, value): (u16, Value)) -> Result<Value, String> {
    if success(status) {
        Ok(value)
    } else {
        Err(http_error(status, &value))
    }
}

// ---------------------------------------------------------------------------
// Scrobbling
// ---------------------------------------------------------------------------

/// Feeds the player's `start` / `pause` / `stop` events to Trakt.
///
/// Not wired to `player.rs` in this build; the player only needs to call this
/// with its resume key and percentage. `key` is a local key, so episodes carry
/// their show meta id.
#[allow(dead_code)]
#[tauri::command]
pub async fn scrobble(
    state: State<'_, AppState>,
    action: String,
    key: String,
    progress: f64,
) -> Result<Value, String> {
    let verb = match action.as_str() {
        "start" => "start",
        "pause" => "pause",
        "stop" => "stop",
        _ => return Err("action must be start, pause or stop".into()),
    };
    let mut store = load(&state)?;
    if store.access_token.is_empty() {
        return Err("Connect Trakt to scrobble.".into());
    }
    let token = ensure_token(&state.http, &mut store).await?;
    save(&state, &store)?;

    let (meta_id, season, episode) = split_key(&key);
    let ids = {
        let conn = state.db.0.lock().map_err(|e| e.to_string())?;
        resolve_ids(&conn, &meta_id)
    };
    if ids.is_empty() {
        return Err("This title has no IMDb or TMDB id, so Trakt cannot match it.".into());
    }

    let progress = progress.clamp(0.0, 100.0);
    let body = match (season, episode) {
        (Some(season), Some(episode)) if season > 0 && episode > 0 => json!({
            "show": { "ids": ids.to_json() },
            "episode": { "season": season, "number": episode },
            "progress": progress,
        }),
        _ => json!({ "movie": { "ids": ids.to_json() }, "progress": progress }),
    };
    let (status, value) = call(
        &state.http,
        Method::POST,
        &format!("/scrobble/{verb}"),
        &store.client_id,
        Some(&token),
        Some(&body),
    )
    .await?;
    if !success(status) {
        return Err(http_error(status, &value));
    }
    Ok(value)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_read_from_stremio_ids() {
        assert_eq!(ids_from_text("tt1234567").imdb.as_deref(), Some("tt1234567"));
        assert_eq!(ids_from_text("imdb:tt42").imdb.as_deref(), Some("tt42"));
        assert_eq!(ids_from_text("tmdb:1396").tmdb, Some(1396));
        assert!(ids_from_text("kitsu:120").is_empty());
    }

    #[test]
    fn ids_are_read_from_meta_json() {
        let meta = json!({ "id": "tmdb:1396", "ids": { "imdb": "tt0903747", "tmdb": 1396 } });
        let ids = ids_from_meta(&meta);
        assert_eq!(ids.imdb.as_deref(), Some("tt0903747"));
        assert_eq!(ids.tmdb, Some(1396));

        let fallback = ids_from_meta(&json!({ "id": "tt0944947" }));
        assert_eq!(fallback.imdb.as_deref(), Some("tt0944947"));
    }

    #[test]
    fn keys_split_without_eating_colons_in_meta_ids() {
        assert_eq!(split_key("tt123"), ("tt123".into(), None, None));
        assert_eq!(split_key("tmdb:1396"), ("tmdb:1396".into(), None, None));
        assert_eq!(split_key("tt123:2:5"), ("tt123".into(), Some(2), Some(5)));
        assert_eq!(split_key("tmdb:1396:1:2"), ("tmdb:1396".into(), Some(1), Some(2)));
    }

    #[test]
    fn history_payloads_carry_ids_and_timestamps() {
        let ids = Ids {
            imdb: Some("tt0133093".into()),
            tmdb: Some(603),
        };
        let movie = movie_entry(&ids, 0);
        assert_eq!(movie["ids"]["imdb"], "tt0133093");
        assert_eq!(movie["ids"]["tmdb"], 603);
        assert_eq!(movie["watched_at"], "1970-01-01T00:00:00.000Z");

        let episode = episode_entry(&ids, 2, 5, 1_600_000_000_000);
        assert_eq!(episode["ids"]["imdb"], "tt0133093");
        assert_eq!(episode["seasons"][0]["number"], 2);
        assert_eq!(episode["seasons"][0]["episodes"][0]["number"], 5);
        assert_eq!(
            episode["seasons"][0]["episodes"][0]["watched_at"],
            "2020-09-13T12:26:40.000Z"
        );
    }

    #[test]
    fn timestamps_round_trip() {
        assert_eq!(parse_iso("2020-09-13T12:26:40.000Z"), Some(1_600_000_000_000));
        assert_eq!(parse_iso(&iso(1_600_000_123_456)), Some(1_600_000_123_456));
        assert_eq!(parse_iso("2024-02-29T00:00:00.000Z"), Some(1_709_164_800_000));
        assert_eq!(parse_iso("not a date"), None);
    }

    #[test]
    fn tokens_refresh_a_day_before_expiry() {
        let now = 1_000_000_000;
        assert!(!needs_refresh(now + 2 * DAY_SECS, now));
        assert!(needs_refresh(now + DAY_SECS, now));
        assert!(needs_refresh(now - 1, now));
        assert!(needs_refresh(0, now));
        assert_eq!(expiry_from(now, 90 * DAY_SECS), now + 90 * DAY_SECS);
    }

    #[test]
    fn newest_write_wins() {
        assert!(should_apply(None, 10));
        assert!(!should_apply(Some(10), 9));
        assert!(should_apply(Some(10), 11));
        assert!(should_apply(Some(10), 10));
    }

    #[test]
    fn watched_merge_keeps_local_and_accepts_remote() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE watched (key TEXT PRIMARY KEY, meta_id TEXT NOT NULL,
             watched INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES ('tt1', 'tt1', 1, 1000000)",
            [],
        )
        .unwrap();
        let index = HashMap::new();

        // Older remote write: local timestamp survives.
        let older = vec![json!({
            "last_watched_at": "1970-01-01T00:16:39.000Z",
            "movie": { "ids": { "imdb": "tt1" } },
        })];
        let (applied, keys) = merge_watched(&conn, &older, &[], &index).unwrap();
        assert_eq!(applied, 0);
        assert!(keys.contains("tt1"));
        let updated: i64 = conn
            .query_row("SELECT updated_at FROM watched WHERE key = 'tt1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(updated, 1000000);

        // Newer remote write: it replaces local.
        let newer = vec![json!({
            "last_watched_at": "1970-01-01T00:16:41.000Z",
            "movie": { "ids": { "imdb": "tt1" } },
        })];
        let (applied, keys) = merge_watched(&conn, &newer, &[], &index).unwrap();
        assert_eq!(applied, 1);
        assert!(keys.contains("tt1"));
        let updated: i64 = conn
            .query_row("SELECT updated_at FROM watched WHERE key = 'tt1'", [], |r| r.get(0))
            .unwrap();
        assert_eq!(updated, 1_001_000);
    }

    #[test]
    fn remote_episodes_land_on_episode_keys() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE watched (key TEXT PRIMARY KEY, meta_id TEXT NOT NULL,
             watched INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL);",
        )
        .unwrap();
        let shows = vec![json!({
            "show": { "ids": { "imdb": "tt0903747" } },
            "seasons": [{ "number": 1, "episodes": [
                { "number": 1, "plays": 1, "last_watched_at": "2020-09-13T12:26:40.000Z" },
                { "number": 2, "plays": 0, "last_watched_at": "2020-09-13T12:26:40.000Z" },
            ] }],
        })];
        let (applied, keys) = merge_watched(&conn, &[], &shows, &HashMap::new()).unwrap();
        assert_eq!(applied, 1);
        assert!(keys.contains("tt0903747:1:1"));
        assert!(!keys.contains("tt0903747:1:2"));
        let meta_id: String = conn
            .query_row(
                "SELECT meta_id FROM watched WHERE key = 'tt0903747:1:1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(meta_id, "tt0903747");
    }
}
