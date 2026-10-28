//! Tauri command surface: everything the UI can ask the Rust core to do.

use crate::addons::{
    self, CatalogResponse, Manifest, Meta, MetaPreview, MetaResponse, StreamResponse,
    SubtitleResponse,
};
use crate::db::{self, LibraryItem, ProgressItem, StoredAddon};
use crate::models::{
    AddonInfo, AppInfo, CastMember, HomeFeed, HomeRow, MetaDetails, SubtitleTrack,
};
use crate::player::{self, PlayRequest, Player, Snapshot};
use crate::settings::Settings;
use crate::streams::{self as stream_utils, StreamOption};
use crate::{tmdb, AppState};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::task::JoinSet;

const MAX_ITEMS_PER_ROW: usize = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_manifest(addon: &StoredAddon) -> Manifest {
    serde_json::from_value(addon.manifest.clone()).unwrap_or_default()
}

fn load_settings(state: &AppState) -> Settings {
    crate::settings::load_cached(state)
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    fetch_json_within(client, url, None).await
}

/// Far past any real addon reply, and enough to stop a hostile one from
/// buffering the machine out of memory.
const MAX_BODY: usize = 16 * 1024 * 1024;

fn is_http_url(value: &str) -> bool {
    url::Url::parse(value).is_ok_and(|parsed| matches!(parsed.scheme(), "http" | "https"))
}

/// Reject targets the addon layer has no business reaching: non-HTTP schemes
/// and the cloud metadata endpoints.
fn validate_target(url: &str) -> Result<(), String> {
    let parsed = url::Url::parse(url).map_err(|e| format!("invalid URL: {e}"))?;
    match parsed.scheme() {
        "http" | "https" => {}
        scheme => return Err(format!("refusing to fetch a {scheme} URL")),
    }
    let host = parsed.host_str().ok_or("that URL has no host")?;
    if crate::addons::is_blocked_host(host) {
        return Err(format!("refusing to fetch the internal address {host}"));
    }
    Ok(())
}

/// [`fetch_json`] with an optional per-request deadline.
///
/// Some addons scrape their sources the first time they are asked and answer
/// from cache afterwards, which takes well over the shared client timeout.
/// A cap is still needed: one addon whose upstream never answers must not
/// hold every other addon's results hostage.
async fn fetch_json_within(
    client: &reqwest::Client,
    url: &str,
    cap: Option<std::time::Duration>,
) -> Result<Value, String> {
    validate_target(url)?;
    let mut request = client.get(url).header("accept", "application/json");
    if let Some(cap) = cap {
        request = request.timeout(cap);
    }
    let mut response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    let too_large = || format!("reply too large (over {} MiB)", MAX_BODY / 1024 / 1024);
    if response.content_length().is_some_and(|len| len > MAX_BODY as u64) {
        return Err(too_large());
    }
    // The length header can lie or be absent after decompression, so the read
    // itself is bounded too.
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|e| format!("request failed: {e}"))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body).map_err(|e| format!("invalid JSON: {e}"))
}

fn meta_details_from_meta(meta: Meta, source: &str) -> MetaDetails {
    let preview = meta.preview.clone();
    let year = preview
        .release_info
        .as_ref()
        .filter(|s| s.chars().count() >= 4)
        .map(|s| s.chars().take(4).collect::<String>())
        .or_else(|| {
            meta.year
                .as_ref()
                .and_then(|v| v.as_str().map(|s| s.to_string()))
                .or_else(|| meta.year.as_ref().and_then(|v| v.as_i64()).map(|v| v.to_string()))
        });
    let trailer = meta
        .trailers
        .iter()
        .find(|t| t.kind == "Trailer" || t.kind == "trailer")
        .or_else(|| meta.trailers.first())
        .map(|t| format!("https://www.youtube.com/watch?v={}", t.source));
    let cast = meta
        .cast
        .clone()
        .unwrap_or_default()
        .into_iter()
        .take(14)
        .map(|name| CastMember {
            name: crate::meta::clean(&name),
            character: String::new(),
            photo: None,
        })
        .collect();
    let imdb_id = if preview.id.starts_with("tt") {
        Some(preview.id.clone())
    } else {
        None
    };

    let mut genres = preview.genres.clone().unwrap_or_default();
    genres.retain(|g| !g.is_empty());

    MetaDetails {
        id: preview.id.clone(),
        media_type: preview.media_type.clone(),
        name: preview.name.clone(),
        poster: preview.poster.clone(),
        background: preview.background.clone(),
        logo: preview.logo.clone(),
        description: preview.description.clone(),
        release_info: preview.release_info.clone(),
        year,
        rating: preview.imdb_rating.clone(),
        genres,
        runtime: preview.runtime.clone(),
        status: None,
        videos: meta.videos.clone(),
        cast,
        director: meta
            .director
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|name| crate::meta::clean(name))
            .collect(),
        writer: meta
            .writer
            .clone()
            .unwrap_or_default()
            .iter()
            .map(|name| crate::meta::clean(name))
            .collect(),
        country: meta
            .country
            .clone()
            .map(|name| crate::meta::clean(&name))
            .into_iter()
            .collect(),
        trailer,
        imdb_id,
        tmdb_id: None,
        source: source.to_string(),
    }
}

fn merge_details(base: &mut MetaDetails, rich: MetaDetails) {
    if base.poster.is_none() {
        base.poster = rich.poster;
    }
    if base.background.is_none() {
        base.background = rich.background;
    }
    if base.description.as_deref().unwrap_or("").is_empty() {
        base.description = rich.description;
    }
    if base.rating.is_none() {
        base.rating = rich.rating;
    }
    if base.runtime.is_none() {
        base.runtime = rich.runtime;
    }
    if base.genres.is_empty() {
        base.genres = rich.genres;
    }
    if base.cast.is_empty() {
        base.cast = rich.cast;
    }
    if base.director.is_empty() {
        base.director = rich.director;
    }
    if base.writer.is_empty() {
        base.writer = rich.writer;
    }
    if base.country.is_empty() {
        base.country = rich.country;
    }
    if base.trailer.is_none() {
        base.trailer = rich.trailer;
    }
    if base.tmdb_id.is_none() {
        base.tmdb_id = rich.tmdb_id;
    }
    if base.imdb_id.is_none() {
        base.imdb_id = rich.imdb_id;
    }
    if base.year.is_none() {
        base.year = rich.year;
    }
}

async fn addon_meta(
    client: &reqwest::Client,
    addons: &[StoredAddon],
    id: &str,
    media_type: &str,
) -> Option<Meta> {
    let mut set: JoinSet<(usize, Option<Meta>)> = JoinSet::new();
    for (index, addon) in addons.iter().filter(|a| a.enabled).enumerate() {
        let manifest = parse_manifest(addon);
        if !manifest.resource_for("meta", media_type, id) {
            continue;
        }
        let url = addons::meta_url(&addon.url, media_type, id);
        let client = client.clone();
        set.spawn(async move {
            let meta = match fetch_json(&client, &url).await {
                Ok(value) => serde_json::from_value::<MetaResponse>(value)
                    .ok()
                    .and_then(|response| response.meta),
                Err(_) => None,
            };
            (index, meta)
        });
    }

    let mut best: Option<(usize, Meta)> = None;
    while let Some(joined) = set.join_next().await {
        if let Ok((index, Some(meta))) = joined {
            if best.as_ref().is_none_or(|(first, _)| index < *first) {
                best = Some((index, meta));
            }
        }
    }
    best.map(|(_, meta)| meta)
}

// ---------------------------------------------------------------------------
// App + settings
// ---------------------------------------------------------------------------

/// The most recent playback timing lines, oldest first.
#[tauri::command]
pub fn playback_log(lines: Option<usize>) -> Vec<String> {
    crate::playback_log::recent(lines.unwrap_or(200).min(400))
}

#[tauri::command]
pub async fn app_info(app: AppHandle, state: State<'_, AppState>) -> Result<AppInfo, String> {
    let settings = load_settings(&state);
    let data_dir = app
        .path()
        .app_data_dir()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();
    Ok(AppInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        platform: std::env::consts::OS.to_string(),
        data_dir,
        mpv: player::find_mpv_async(settings.mpv_path.clone(), mpv_dir(&app))
            .await,
    })
}

fn mpv_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().resource_dir().ok()
}

#[tauri::command]
pub async fn mpv_detect(app: AppHandle, path: Option<String>) -> Option<crate::models::MpvInfo> {
    player::detect_mpv(path.as_deref().unwrap_or_default(), mpv_dir(&app).as_deref())
}

#[tauri::command]
pub async fn settings_get(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(load_settings(&state))
}

#[tauri::command]
pub async fn settings_set(patch: Value, state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let mut settings = Settings::load(&conn);
    settings.apply_patch(patch)?;
    settings.save(&conn)?;
    drop(conn);
    crate::settings::invalidate(&state);
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

fn addon_info(addon: &StoredAddon) -> AddonInfo {
    let manifest = parse_manifest(addon);
    let configuration_required = behavior_hint(&manifest, "configurationRequired");
    let configurable = behavior_hint(&manifest, "configurable").unwrap_or(false);
    AddonInfo {
        url: addon.url.clone(),
        addon_id: addon.addon_id.clone(),
        name: if manifest.name.is_empty() {
            addon.name.clone()
        } else {
            manifest.name.clone()
        },
        version: manifest.version.clone(),
        description: manifest.description.clone(),
        logo: manifest.logo.clone(),
        enabled: addon.enabled,
        types: manifest.types.clone(),
        resources: manifest
            .resources
            .iter()
            .map(|r| r.name().to_string())
            .collect::<HashSet<_>>()
            .into_iter()
            .collect(),
        catalogs: manifest.catalogs.clone(),
        configure_url: (configurable || configuration_required.unwrap_or(false))
            .then(|| format!("{}/configure", addon_base(&addon.url))),
        configuration_required,
    }
}

fn behavior_hint(manifest: &Manifest, key: &str) -> Option<bool> {
    manifest
        .behavior_hints
        .as_ref()
        .and_then(|hints| hints.get(key))
        .and_then(Value::as_bool)
}

fn addon_base(url: &str) -> &str {
    url.strip_suffix("/manifest.json").unwrap_or(url)
}

/// Write a freshly fetched manifest and hand back the row as the UI sees it.
fn store_addon(
    state: &AppState,
    base: &str,
    manifest: &Manifest,
    value: &Value,
) -> Result<AddonInfo, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::upsert_addon(&conn, base, &manifest.id, &manifest.name, value)
        .map_err(|e| e.to_string())?;
    let addons = db::list_addons(&conn).map_err(|e| e.to_string())?;
    let stored = addons
        .iter()
        .find(|a| a.url == base)
        .ok_or("Addon was not stored")?;
    Ok(addon_info(stored))
}

async fn fetch_manifest(client: &reqwest::Client, base: &str) -> Result<(Value, Manifest), String> {
    let value = fetch_json(client, &format!("{base}/manifest.json")).await?;
    let manifest: Manifest = serde_json::from_value(value.clone())
        .map_err(|e| format!("That URL did not return a valid addon manifest: {e}"))?;
    if manifest.name.trim().is_empty() || manifest.id.trim().is_empty() {
        return Err("That manifest is missing an id or name".into());
    }
    Ok((value, manifest))
}

#[tauri::command]
pub async fn addons_list(state: State<'_, AppState>) -> Result<Vec<AddonInfo>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let addons = db::list_addons(&conn).map_err(|e| e.to_string())?;
    Ok(addons.iter().map(addon_info).collect())
}

#[tauri::command]
pub async fn addons_install(
    url: String,
    state: State<'_, AppState>,
) -> Result<AddonInfo, String> {
    let base = addons::normalize_addon_url(&url);
    if base.is_empty() {
        return Err("Enter an addon URL".into());
    }
    let (value, manifest) = fetch_manifest(&state.http, &base).await?;
    store_addon(&state, &base, &manifest, &value)
}

/// Re-read the manifest of an installed addon. The row is only touched once the
/// new manifest has been fetched and parsed.
#[tauri::command]
pub async fn addons_refresh(url: String, state: State<'_, AppState>) -> Result<AddonInfo, String> {
    let base = addons::normalize_addon_url(&url);
    if base.is_empty() {
        return Err("Enter an addon URL".into());
    }
    let (value, manifest) = fetch_manifest(&state.http, &base)
        .await
        .map_err(|e| format!("Refresh failed: {e}"))?;
    store_addon(&state, &base, &manifest, &value)
}

#[tauri::command]
pub fn addons_move(
    url: String,
    delta: i32,
    state: State<'_, AppState>,
) -> Result<Vec<AddonInfo>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::move_addon(&conn, &url, delta).map_err(|e| e.to_string())?;
    let addons = db::list_addons(&conn).map_err(|e| e.to_string())?;
    Ok(addons.iter().map(addon_info).collect())
}

#[tauri::command]
pub fn addons_remove(url: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::remove_addon(&conn, &url).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn addons_set_enabled(
    url: String,
    enabled: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::set_addon_enabled(&conn, &url, enabled).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Catalogs + discovery
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn home_feed(state: State<'_, AppState>) -> Result<HomeFeed, String> {
    let (settings, addons, progress) = {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        (
            Settings::load(&conn),
            db::list_addons(&conn).map_err(|e| e.to_string())?,
            db::list_continue_watching(&conn).map_err(|e| e.to_string())?,
        )
    };

    let mut errors: Vec<String> = Vec::new();

    let key = settings.tmdb_api_key.trim().to_string();
    let mut discover_error: Option<String> = None;
    // Six catalogs walk three sources each; cap them so a dead network cannot
    // hold the home screen hostage.
    let discover = {
        let client = state.http.clone();
        let key = key.clone();
        tokio::spawn(async move {
            tokio::time::timeout(
                std::time::Duration::from_secs(14),
                tmdb::home_rows(&client, &key),
            )
            .await
        })
    };

    struct Task {
        order: usize,
        addon_name: String,
        media_type: String,
        catalog_id: String,
        client: reqwest::Client,
        url: String,
        title: String,
        row_id: String,
    }

    let mut tasks: Vec<Task> = Vec::new();
    let mut order = 0usize;
    let limit = settings.home_rows_limit.clamp(1, 24) as usize;
    for addon in addons.iter().filter(|a| a.enabled) {
        if tasks.len() >= limit {
            break;
        }
        let manifest = parse_manifest(addon);
        let mut taken = 0;
        for catalog in &manifest.catalogs {
            if taken >= 4 || tasks.len() >= limit {
                break;
            }
            if catalog.media_type != "movie" && catalog.media_type != "series" {
                continue;
            }
            if catalog.extra.iter().any(|extra| extra.is_required) {
                continue;
            }
            order += 1;
            tasks.push(Task {
                order,
                addon_name: addon.name.clone(),
                media_type: catalog.media_type.clone(),
                catalog_id: catalog.id.clone(),
                client: state.http.clone(),
                url: addons::catalog_url(
                    &addon.url,
                    &catalog.media_type,
                    &catalog.id,
                    &BTreeMap::new(),
                ),
                title: if catalog.name.is_empty() {
                    addon.name.clone()
                } else {
                    catalog.name.clone()
                },
                row_id: format!("{}:{}:{}", addon.url, catalog.media_type, catalog.id),
            });
            taken += 1;
        }
    }

    let mut set: JoinSet<(usize, Task, Result<CatalogResponse, String>)> = JoinSet::new();
    for task in tasks {
        set.spawn(async move {
            let result = fetch_json(&task.client, &task.url)
                .await
                .and_then(|value| {
                    serde_json::from_value::<CatalogResponse>(value).map_err(|e| e.to_string())
                });
            (task.order, task, result)
        });
    }

    let mut addon_rows: Vec<(usize, HomeRow)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        let Ok((order, task, result)) = joined else {
            continue;
        };
        match result {
            Ok(response) => {
                if response.metas.is_empty() {
                    continue;
                }
                addon_rows.push((
                    order,
                    HomeRow {
                        id: task.row_id,
                        title: task.title,
                        addon: Some(task.addon_name),
                        media_type: task.media_type,
                        catalog_id: task.catalog_id,
                        items: response
                            .metas
                            .into_iter()
                            .take(MAX_ITEMS_PER_ROW)
                            .collect(),
                    },
                ));
            }
            Err(e) => errors.push(format!("{}: {e}", task.addon_name)),
        }
    }
    addon_rows.sort_by_key(|(order, _)| *order);
    // Disambiguate repeated catalog names (for example two "Popular" rows).
    let mut title_counts: HashMap<String, usize> = HashMap::new();
    for (_, row) in &addon_rows {
        *title_counts.entry(row.title.clone()).or_default() += 1;
    }
    let mut addon_rows = addon_rows;
    for (_, row) in addon_rows.iter_mut() {
        if title_counts.get(&row.title).copied().unwrap_or(0) > 1 {
            let suffix = if row.media_type == "series" { "Shows" } else { "Movies" };
            row.title = format!("{} · {suffix}", row.title);
        }
    }
    // Discover rows lead; its request ran alongside the catalog fan-out.
    let mut rows = match discover.await {
        Ok(Ok(Ok(rows))) => rows,
        Ok(Ok(Err(_))) => {
            discover_error = Some("Discover timed out".into());
            Vec::new()
        }
        Ok(Err(_)) => {
            discover_error = Some("Discover failed".into());
            Vec::new()
        }
        Err(_) => {
            discover_error = Some("Discover failed".into());
            Vec::new()
        }
    };
    rows.extend(addon_rows.into_iter().map(|(_, row)| row));

    rows.truncate(limit);
    errors.truncate(6);
    // A dead discovery source only matters when it left the page empty; with
    // addon catalogs on screen the banner is noise.
    if rows.is_empty() {
        if let Some(message) = discover_error {
            errors.insert(0, message);
        }
    }

    Ok(HomeFeed {
        continue_watching: progress,
        rows,
        addon_errors: errors,
    })
}

#[tauri::command]
pub async fn catalog(
    addon_url: String,
    media_type: String,
    catalog_id: String,
    query: Option<String>,
    skip: Option<u32>,
    state: State<'_, AppState>,
) -> Result<CatalogResponse, String> {
    let mut extra = BTreeMap::new();
    if let Some(query) = query.filter(|q| !q.trim().is_empty()) {
        extra.insert("search".to_string(), query);
    }
    if let Some(skip) = skip.filter(|s| *s > 0) {
        extra.insert("skip".to_string(), skip.to_string());
    }
    let base = addons::normalize_addon_url(&addon_url);
    let url = addons::catalog_url(&base, &media_type, &catalog_id, &extra);
    let value = fetch_json(&state.http, &url).await?;
    serde_json::from_value(value).map_err(|e| format!("Unexpected catalog payload: {e}"))
}

#[tauri::command]
pub async fn cast_photos(
    names: Vec<String>,
    title: String,
    state: State<'_, AppState>,
) -> Result<std::collections::HashMap<String, String>, String> {
    let mut photos: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    let mut pending: Vec<(String, String)> = Vec::new();
    {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        for name in names.into_iter().take(16) {
            let key = format!("{title}|{name}");
            match db::people_photo(&conn, &key) {
                Ok(Some(photo)) => {
                    if !photo.is_empty() {
                        photos.insert(name, photo);
                    }
                }
                _ => pending.push((name, key)),
            }
        }
    }
    if pending.is_empty() {
        return Ok(photos);
    }

    // One tap each, in parallel, then remembered - including the misses, so a
    // title never pays for the same lookup twice.
    let mut set = tokio::task::JoinSet::new();
    for (name, key) in pending {
        let client = state.http.clone();
        let title = title.clone();
        set.spawn(async move {
            let photo = crate::meta::headshot(&client, &name, &title).await;
            (name, key, photo)
        });
    }
    let mut writes: Vec<(String, String)> = Vec::new();
    while let Some(joined) = set.join_next().await {
        let Ok((name, key, photo)) = joined else {
            continue;
        };
        if let Some(photo) = photo.as_ref() {
            photos.insert(name, photo.clone());
        }
        writes.push((key, photo.unwrap_or_default()));
    }
    // One transaction for the batch instead of a lock and commit per headshot.
    if let Ok(conn) = state.db.0.lock() {
        if let Ok(tx) = conn.unchecked_transaction() {
            for (key, photo) in &writes {
                let _ = db::set_people_photo(&tx, key, photo);
            }
            let _ = tx.commit();
        }
    }
    Ok(photos)
}

/// One row of picks for this viewer, built from the genres of what they
/// recently finished and stripped of anything already watched or started.
/// No history means no row, and the screen says why.
#[tauri::command]
pub async fn recommendations(state: State<'_, AppState>) -> Result<Vec<HomeRow>, String> {
    let (recent, seen) = {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        let recent = db::list_watched_items(&conn).map_err(|e| e.to_string())?;
        let seen = db::touched_ids(&conn).map_err(|e| e.to_string())?;
        (recent, seen)
    };
    Ok(recommendation_rows(&state.http, recent, seen).await)
}

/// The pick itself, taking the history as plain data so it can be run outside
/// Tauri (and against the live network in a test). `seen` is every id the
/// viewer has touched, so nothing already watched or started can come back.
pub async fn recommendation_rows(
    http: &reqwest::Client,
    recent: Vec<db::WatchedItem>,
    seen: Vec<String>,
) -> Vec<HomeRow> {
    let seen: HashSet<String> = seen.into_iter().collect();

    // Learn the genre of the last dozen finished titles at once: most of them
    // are "Action", so the next step needs choice, not just the last three.
    const CANDIDATES: usize = 12;
    let mut probes = JoinSet::new();
    for (slot, seed) in recent
        .into_iter()
        .filter(|seed| seed.meta_id.starts_with("tt") && !seed.name.trim().is_empty())
        .take(CANDIDATES)
        .enumerate()
    {
        let http = http.clone();
        probes.spawn(async move {
            let details = crate::meta::details(&http, &seed.meta_id, &seed.media_type).await?;
            let genre = details.genres.first()?.clone();
            Some((slot, seed, details.media_type.clone(), genre))
        });
    }

    let mut found: Vec<Option<(db::WatchedItem, String, String)>> = vec![None; CANDIDATES];
    while let Some(joined) = probes.join_next().await {
        if let Ok(Some((slot, seed, media_type, genre))) = joined {
            found[slot] = Some((seed, media_type, genre));
        }
    }

    // Three genres, not three copies: five seeds that all sit in Action would
    // otherwise repeat the same catalog five times.
    let mut genres: HashSet<String> = HashSet::new();
    let seeds: Vec<(db::WatchedItem, String, String)> = found
        .into_iter()
        .flatten()
        .filter(|(_, media_type, genre)| genres.insert(format!("{media_type}|{genre}")))
        .take(3)
        .collect();

    // Each genre contributes a share, so one broad taste cannot crowd out the
    // rest of the row. Anything watched or started never makes the cut.
    const PER_GENRE: usize = 8;
    const TOTAL: usize = 24;

    let mut similar_set: JoinSet<(usize, Vec<MetaPreview>)> = JoinSet::new();
    for (slot, (seed, media_type, genre)) in seeds.iter().enumerate() {
        let http = http.clone();
        let media_type = media_type.clone();
        let genre = genre.clone();
        let exclude = seed.meta_id.clone();
        similar_set.spawn(async move {
            let items = tmdb::similar(&http, &media_type, &genre, &exclude).await;
            (slot, items)
        });
    }
    let mut similar_rows: Vec<Option<Vec<MetaPreview>>> = vec![None; seeds.len()];
    while let Some(joined) = similar_set.join_next().await {
        if let Ok((slot, items)) = joined {
            similar_rows[slot] = Some(items);
        }
    }

    let mut items = Vec::new();
    let mut used: HashSet<String> = HashSet::new();
    for rows in similar_rows.into_iter().flatten() {
        let mut taken = 0;
        for item in rows {
            if seen.contains(&item.id) || !used.insert(item.id.clone()) {
                continue;
            }
            items.push(item);
            taken += 1;
            if taken == PER_GENRE || items.len() == TOTAL {
                break;
            }
        }
        if items.len() == TOTAL {
            break;
        }
    }

    if items.is_empty() {
        return Vec::new();
    }

    vec![HomeRow {
        id: "reco:for-you".into(),
        title: "Recommended for you".into(),
        addon: Some("Cinemeta".into()),
        media_type: "movie".into(),
        catalog_id: "for-you".into(),
        items,
    }]
}

#[tauri::command]
pub async fn similar(
    media_type: String,
    genre: String,
    exclude: String,
    state: State<'_, AppState>,
) -> Result<Vec<MetaPreview>, String> {
    Ok(tmdb::similar(&state.http, &media_type, &genre, &exclude).await)
}

#[tauri::command]
pub async fn search(
    query: String,
    state: State<'_, AppState>,
) -> Result<Vec<MetaPreview>, String> {
    let query = query.trim().to_string();
    if query.is_empty() {
        return Ok(Vec::new());
    }
    let (settings, addons) = {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        (
            Settings::load(&conn),
            db::list_addons(&conn).map_err(|e| e.to_string())?,
        )
    };

    let mut results: Vec<MetaPreview> = Vec::new();
    let mut set: JoinSet<(String, Result<CatalogResponse, String>)> = JoinSet::new();
    let key = settings.tmdb_api_key.trim().to_string();
    let tmdb_task = if key.is_empty() {
        None
    } else {
        let client = state.http.clone();
        let query = query.clone();
        Some(tokio::spawn(async move {
            tmdb::search(&client, &key, &query).await
        }))
    };

    for addon in addons.iter().filter(|a| a.enabled) {
        let manifest = parse_manifest(addon);
        for catalog in &manifest.catalogs {
            if !catalog.extra.iter().any(|e| e.name == "search") {
                continue;
            }
            let mut extra = BTreeMap::new();
            extra.insert("search".to_string(), query.clone());
            let url = addons::catalog_url(
                &addon.url,
                &catalog.media_type,
                &catalog.id,
                &extra,
            );
            let client = state.http.clone();
            let name = addon.name.clone();
            set.spawn(async move {
                let result = fetch_json(&client, &url)
                    .await
                    .and_then(|value| {
                        serde_json::from_value::<CatalogResponse>(value).map_err(|e| e.to_string())
                    });
                (name, result)
            });
        }
    }

    while let Some(joined) = set.join_next().await {
        if let Ok((_addon, Ok(response))) = joined {
            results.extend(response.metas);
        }
    }

    if let Some(task) = tmdb_task {
        if let Ok(Ok(mut tmdb_results)) = task.await {
            results.append(&mut tmdb_results);
        }
    }

    let mut seen = HashSet::new();
    results.retain(|item| {
        !item.name.trim().is_empty()
            && seen.insert((item.id.clone(), item.media_type.clone()))
    });
    results.truncate(80);
    Ok(results)
}

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn meta_details(
    id: String,
    media_type: String,
    state: State<'_, AppState>,
) -> Result<MetaDetails, String> {
    let (settings, addons) = {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        (
            Settings::load(&conn),
            db::list_addons(&conn).map_err(|e| e.to_string())?,
        )
    };
    let key = settings.tmdb_api_key.trim().to_string();

    if let Some(rest) = id.strip_prefix("tmdb:") {
        if key.is_empty() {
            return Err(
                "This title comes from TMDB. Add a TMDB API key in Settings → Integrations."
                    .into(),
            );
        }
        let mut parts = rest.splitn(2, ':');
        let kind = parts.next().unwrap_or("movie");
        let tmdb_id = parts.next().ok_or("Malformed TMDB id")?;
        let mut details = tmdb::details(&state.http, &key, kind, tmdb_id).await?;

        // Episodes and richer text still come from metadata addons when present.
        if let Some(imdb) = details.imdb_id.clone() {
            if let Some(meta) = addon_meta(&state.http, &addons, &imdb, &details.media_type).await {
                let from_addon = meta_details_from_meta(meta, "addon");
                details.videos = from_addon.videos;
                if details.description.as_deref().unwrap_or("").is_empty() {
                    details.description = from_addon.description;
                }
                if details.director.is_empty() {
                    details.director = from_addon.director;
                }
            }
        }
        if details.videos.is_empty() && details.media_type == "series" {
            if let Some(imdb) = details.imdb_id.clone() {
                details.videos =
                    crate::meta::videos(&state.http, &imdb, &details.media_type).await;
            }
        }
        return Ok(details);
    }

    let mut details = if let Some(meta) =
        addon_meta(&state.http, &addons, &id, &media_type).await
    {
        meta_details_from_meta(meta, "addon")
    } else if id.starts_with("tt") {
        // No addon knows this id: the mirror and Cinemeta still do.
        match crate::meta::details(&state.http, &id, &media_type).await {
            Some(found) => found,
            None if !key.is_empty() => {
                let found = tmdb::find_by_imdb(&state.http, &key, &id).await?;
                match found {
                    Some((kind, tmdb_id)) => {
                        tmdb::details(&state.http, &key, &kind, &tmdb_id).await?
                    }
                    None => return Err("No metadata source could resolve this title".into()),
                }
            }
            None => return Err("No metadata source could resolve this title".into()),
        }
    } else {
        return Err(
            "No metadata addon is installed for this title. Add a metadata addon in Settings → Addons."
                .into(),
        );
    };

    // One Cinemeta document carries both the episode list and the cast, so a
    // single fetch fills whichever is missing. TMDB runs beside it.
    let imdb = details
        .imdb_id
        .clone()
        .or_else(|| id.starts_with("tt").then(|| id.clone()));
    let needs_videos = details.videos.is_empty() && details.media_type == "series";
    let needs_cast = details.cast.is_empty();
    let needs_tmdb =
        details.background.is_none() || details.cast.is_empty() || details.trailer.is_none();

    let cinemeta = async {
        if !needs_videos && !needs_cast {
            return None;
        }
        let imdb = imdb.as_deref()?;
        crate::meta::details(&state.http, imdb, &details.media_type).await
    };
    let rich = async {
        if key.is_empty() || !needs_tmdb {
            return None;
        }
        let imdb = imdb.as_deref()?;
        let (kind, tmdb_id) = tmdb::find_by_imdb(&state.http, &key, imdb).await.ok()??;
        tmdb::details(&state.http, &key, &kind, &tmdb_id).await.ok()
    };
    let (cinemeta, rich) = tokio::join!(cinemeta, rich);

    if let Some(mut cinemeta) = cinemeta {
        if needs_videos {
            details.videos = std::mem::take(&mut cinemeta.videos);
        }
        merge_details(&mut details, cinemeta);
    }
    if let Some(rich) = rich {
        merge_details(&mut details, rich);
    }

    Ok(details)
}

// ---------------------------------------------------------------------------
// Streams + subtitles
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn streams(
    id: String,
    media_type: String,
    season: Option<i64>,
    episode: Option<i64>,
    imdb_id: Option<String>,
    addon: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<StreamOption>, String> {
    let addons = {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        db::list_addons(&conn).map_err(|e| e.to_string())?
    };

    let base_id = imdb_id
        .filter(|value| !value.trim().is_empty())
        .unwrap_or_else(|| id.clone());
    let request_id = addons::episode_id(&base_id, season, episode);

    struct Task {
        addon: String,
        client: reqwest::Client,
        url: String,
    }

    let only = addon.clone();
    let mut tasks = Vec::new();
    for addon in addons.iter().filter(|a| a.enabled) {
        // The UI asks each addon on its own so the first answer can be shown
        // while the others are still working.
        if only.as_deref().is_some_and(|wanted| wanted != addon.name) {
            continue;
        }
        let manifest = parse_manifest(addon);
        if !manifest.resource_for("stream", &media_type, &request_id) {
            continue;
        }
        tasks.push(Task {
            addon: addon.name.clone(),
            client: state.http.clone(),
            url: addons::stream_url(&addon.url, &media_type, &request_id),
        });
    }

    let mut set: JoinSet<(String, Result<StreamResponse, String>)> = JoinSet::new();
    // 45s when one addon was asked for on its own (nothing else waits on it,
    // and scraping addons can take half a minute cold), 8s in the all-addons
    // fan-out so one dead source cannot stall the list.
    let cap = if only.is_some() { 45 } else { 8 };
    for task in tasks {
        set.spawn(async move {
            let result = fetch_json_within(
                &task.client,
                &task.url,
                Some(std::time::Duration::from_secs(cap)),
            )
            .await
            .and_then(|value| {
                serde_json::from_value::<StreamResponse>(value).map_err(|e| e.to_string())
            });
            (task.addon, result)
        });
    }

    fn collect(
        options: &mut Vec<StreamOption>,
        errors: &mut Vec<String>,
        joined: Result<(String, Result<StreamResponse, String>), tokio::task::JoinError>,
    ) {
        match joined {
            Ok((addon, Ok(response))) => {
                for stream in response.streams {
                    // Notice and donate rows carry no playable target; they
                    // would only show up as dead entries in the source list.
                    if stream.url.is_none() && stream.info_hash.is_none() {
                        continue;
                    }
                    options.push(stream_utils::normalize(&addon, &stream));
                }
            }
            Ok((addon, Err(e))) => errors.push(format!("{addon}: {e}")),
            Err(_) => {}
        }
    }

    let mut options: Vec<StreamOption> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    while let Some(joined) = set.join_next().await {
        collect(&mut options, &mut errors, joined);
        if only.is_some() || options.is_empty() {
            continue;
        }
        // First answer is up: give the stragglers a short grace period.
        while let Ok(Some(joined)) =
            tokio::time::timeout(std::time::Duration::from_millis(400), set.join_next()).await
        {
            collect(&mut options, &mut errors, joined);
        }
        break;
    }

    if options.is_empty() && !errors.is_empty() {
        return Err(format!("No streams returned. {}", errors.join(" · ")));
    }

    options.sort_by(|a, b| {
        b.score
            .cmp(&a.score)
            .then_with(|| a.addon.cmp(&b.addon))
            .then_with(|| a.name.cmp(&b.name))
    });
    let mut seen = HashSet::new();
    options.retain(|option| {
        let key = option
            .url
            .clone()
            .or_else(|| option.info_hash.clone())
            .unwrap_or_else(|| format!("{:?}", option.title));
        seen.insert(key)
    });
    Ok(options)
}

#[tauri::command]
pub async fn subtitles(
    id: String,
    media_type: String,
    season: Option<i64>,
    episode: Option<i64>,
    state: State<'_, AppState>,
) -> Result<Vec<SubtitleTrack>, String> {
    let addons = {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        db::list_addons(&conn).map_err(|e| e.to_string())?
    };
    let request_id = addons::episode_id(&id, season, episode);

    let mut set: JoinSet<(String, Result<SubtitleResponse, String>)> = JoinSet::new();
    for addon in addons.iter().filter(|a| a.enabled) {
        let manifest = parse_manifest(addon);
        if !manifest.resource_for("subtitles", &media_type, &request_id) {
            continue;
        }
        let url =
            addons::subtitle_url(&addon.url, &media_type, &request_id, &BTreeMap::new());
        let client = state.http.clone();
        let name = addon.name.clone();
        set.spawn(async move {
            let result = fetch_json(&client, &url)
                .await
                .and_then(|value| {
                    serde_json::from_value::<SubtitleResponse>(value).map_err(|e| e.to_string())
                });
            (name, result)
        });
    }

    // Built in so a fresh install finds subtitles before any addon is added.
    {
        const OPENSUBTITLES: &str = "https://opensubtitles-v3.strem.io";
        let url = addons::subtitle_url(OPENSUBTITLES, &media_type, &request_id, &BTreeMap::new());
        let client = state.http.clone();
        set.spawn(async move {
            let result = fetch_json(&client, &url).await.and_then(|value| {
                serde_json::from_value::<SubtitleResponse>(value).map_err(|e| e.to_string())
            });
            ("OpenSubtitles".to_string(), result)
        });
    }

    let mut tracks = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok((addon, Ok(response))) = joined {
            for subtitle in response.subtitles {
                // mpv plays these directly, so only hand it http(s) targets.
                if !is_http_url(&subtitle.url) {
                    continue;
                }
                tracks.push(SubtitleTrack {
                    id: subtitle.id,
                    url: subtitle.url,
                    lang: subtitle.lang,
                    addon: addon.clone(),
                });
            }
        }
    }
    Ok(tracks)
}

// ---------------------------------------------------------------------------
// Library + progress
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn library_list(state: State<'_, AppState>) -> Result<Vec<LibraryItem>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::list_library(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn library_toggle(item: LibraryItem, state: State<'_, AppState>) -> Result<bool, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let exists: Option<String> = conn
        .query_row(
            "SELECT id FROM library WHERE id = ?1",
            [&item.id],
            |row| row.get(0),
        )
        .ok();
    if exists.is_some() {
        db::remove_from_library(&conn, &item.id).map_err(|e| e.to_string())?;
        Ok(false)
    } else {
        db::add_to_library(&conn, &item).map_err(|e| e.to_string())?;
        Ok(true)
    }
}

#[tauri::command]
pub async fn progress_list(state: State<'_, AppState>) -> Result<Vec<ProgressItem>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::list_progress(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn watched_list(state: State<'_, AppState>) -> Result<Vec<db::WatchedItem>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::list_watched_items(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn progress_for(key: String, state: State<'_, AppState>) -> Result<Option<ProgressItem>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::get_progress(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn progress_clear(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::clear_progress(&conn, &key).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn watched_set(
    key: String,
    meta_id: String,
    watched: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::set_watched(&conn, &key, &meta_id, watched).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Playback
// ---------------------------------------------------------------------------

// Async on purpose: starting mpv waits on a named pipe, and sync commands run on
// the UI thread. Blocking there freezes the whole window.
#[tauri::command]
pub async fn player_open(
    request: PlayRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<Snapshot, String> {
    if request.url.trim().is_empty() {
        return Err("Nothing to play".into());
    }
    if let Ok(dir) = app.path().app_data_dir() {
        crate::playback_log::init(&dir);
    }
    // Only the host is logged: stream URLs carry tokens in their path.
    let source = request
        .url
        .split("://")
        .nth(1)
        .and_then(|rest| rest.split('/').next())
        .unwrap_or("local file");
    crate::playback_log::begin(format!(
        "play requested: {} [{source}]",
        request.title.chars().take(64).collect::<String>()
    ));
    let settings = load_settings(&state);
    let host = crate::video_host(&app);
    // Spawning waits for mpv to open its IPC pipe, so the lock is not held
    // across it: every other player command would block behind it.
    let previous = state.player.lock().map_err(|_| "player is busy")?.take();
    // A wedged mpv can stall wait() in Drop, so the old process is killed now
    // and reaped on its own thread. It can never hold up the next source.
    if let Some(mut previous) = previous {
        previous.kill();
        std::thread::spawn(move || drop(previous));
    }
    crate::playback_log::mark("starting mpv");
    // The picture owns the whole window. tao leaves the undecorated shadow on,
    // and that makes the host inset the client rect by the resize frame, so the
    // shadow goes before mpv measures the client it draws into.
    set_window_shadow(&app, false);
    if let Some(host) = host {
        crate::refit_webview(host);
    }
    let player = Player::spawn(
        app.clone(),
        &settings,
        &request,
        host,
        mpv_dir(&app).as_deref(),
    )?;
    // Frames cached for the previous source are meaningless now.
    crate::frame::clear();
    let snapshot = player.snapshot();
    *state.player.lock().map_err(|_| "player is busy")? = Some(player);
    Ok(snapshot)
}

/// Toggle the window's own drop shadow, which also decides whether the host
/// insets the client rect for it.
fn set_window_shadow(app: &AppHandle, on: bool) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.set_shadow(on);
    }
}

#[tauri::command]
pub async fn player_state(state: State<'_, AppState>) -> Result<Option<Snapshot>, String> {
    let guard = state.player.lock().map_err(|_| "player is busy")?;
    Ok(guard.as_ref().map(|player| player.snapshot()))
}

/// One frame from the running source as a `data:image/jpeg;base64,...` URL.
/// Decoded by a second headless mpv, so the picture keeps playing untouched.
#[tauri::command]
pub async fn player_frame(
    seconds: f64,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let source = {
        let guard = state.player.lock().map_err(|_| "player is busy")?;
        let player = guard.as_ref().ok_or("Nothing is playing")?;
        player.source().to_string()
    };
    let settings = load_settings(&state);
    let mpv = player::find_mpv_async(settings.mpv_path.clone(), mpv_dir(&app))
        .await
        .ok_or("mpv was not found")?;
    crate::frame::preview(&mpv.path, &source, seconds).await
}

#[tauri::command]
pub async fn player_control(
    action: String,
    value: Option<Value>,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if action == "stop" {
        return player_stop(app, state).await;
    }
    // Never hold the player slot across an IPC write: mpv's pipe can wedge
    // after a source dies, and that blocked the next play for good.
    let (writer, failed) = {
        let guard = state.player.lock().map_err(|_| "player is busy")?;
        let player = guard.as_ref().ok_or("Nothing is playing")?;
        (player.writer(), player.failed())
    };
    if failed {
        return Err("Playback has stopped. Choose another source.".into());
    }
    Player::send_action(&writer, &action, value)
}

#[tauri::command]
pub async fn player_stop(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    // Kill the player first so a slow P2P teardown can never leave mpv running
    // behind the menu. Reaping happens off-thread: Drop waits on the process.
    let player = {
        let mut guard = state.player.lock().map_err(|_| "player is busy")?;
        guard.take()
    };
    if let Some(mut player) = player {
        player.kill();
        std::thread::spawn(move || drop(player));
    }
    let _ = crate::torrent::shutdown().await;
    set_window_shadow(&app, true);
    if let Some(host) = crate::video_host(&app) {
        crate::refit_webview(host);
    }
    // A player we killed on purpose does not close on its own, so this is the
    // only chance the UI gets to drop the snapshot and re-read progress.
    let _ = app.emit("player:closed", ());
    Ok(())
}

#[tauri::command]
pub async fn player_subtitle(
    url: String,
    label: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // The picker hands over a local path, so both paths are accepted.
    player::validate_media_url(&url)?;
    let writer = {
        let guard = state.player.lock().map_err(|_| "player is busy")?;
        let player = guard.as_ref().ok_or("Nothing is playing")?;
        if player.failed() {
            return Err("Playback has stopped. Choose another source.".into());
        }
        player.writer()
    };
    Player::send_action(
        &writer,
        "sub-add",
        Some(json!({ "url": url, "label": label.unwrap_or_else(|| "Subtitle".into()) })),
    )
}

/// Fullscreen is driven straight against the window handle so playback keeps
/// running while the window changes shape.
#[tauri::command]
pub fn window_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let host = crate::video_host(&app).ok_or("The main window is not available")?;
    // Fullscreen has no frame, but tao still insets the client rect for the
    // window shadow, which shows as black bars around the page. The player
    // needs it off too, so it only comes back with neither.
    set_window_shadow(&app, !on && !crate::player_is_live(&app));
    if !crate::set_fullscreen(host, on) {
        return Err("The window could not go fullscreen".into());
    }
    // The style swap moves the outer window but not the child web layer, so the
    // page keeps its old height and the strip the taskbar gave up stays black.
    // Resize through tao: it reports the change to the webview (and to mpv,
    // which draws into the same client area) instead of moving pixels alone.
    if on {
        if let Some(window) = app.get_webview_window("main") {
            if let Ok(Some(monitor)) = window.current_monitor() {
                let origin = monitor.position();
                let size = monitor.size();
                let _ = window.set_position(tauri::PhysicalPosition::new(origin.x, origin.y));
                let _ = window
                    .set_size(tauri::PhysicalSize::new(size.width, size.height.saturating_sub(1)));
                let _ = window.set_size(tauri::PhysicalSize::new(size.width, size.height));
            }
        }
    }
    crate::refit_webview(host);
    Ok(())
}

// ---------------------------------------------------------------------------
// Nuvio Cloud sync
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn nuvio_status(state: State<'_, AppState>) -> Result<crate::nuvio_sync::Status, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let settings = Settings::load(&conn);
    Ok(crate::nuvio_sync::status(&conn, &settings))
}

#[tauri::command]
pub async fn nuvio_sign_in(
    email: String,
    password: String,
    sign_up: Option<bool>,
    state: State<'_, AppState>,
) -> Result<crate::nuvio_sync::Status, String> {
    crate::nuvio_sync::sign_in(&state, &email, &password, sign_up.unwrap_or(false)).await?;
    // First sync right after sign-in so the other devices land immediately.
    let _ = crate::nuvio_sync::sync_now(&state).await;
    nuvio_status(state)
}

#[tauri::command]
pub fn nuvio_sign_out(state: State<'_, AppState>) -> Result<(), String> {
    crate::nuvio_sync::sign_out(&state)
}

#[tauri::command]
pub async fn nuvio_set_profile(index: i64, state: State<'_, AppState>) -> Result<(), String> {
    crate::nuvio_sync::set_profile(&state, index).await
}

#[tauri::command]
pub async fn nuvio_profiles(
    state: State<'_, AppState>,
) -> Result<Vec<crate::nuvio_sync::NuvioProfile>, String> {
    crate::nuvio_sync::profiles(&state).await
}

#[tauri::command]
pub async fn nuvio_sync_now(
    state: State<'_, AppState>,
) -> Result<crate::nuvio_sync::SyncReport, String> {
    let report = crate::nuvio_sync::sync_now(&state).await?;
    Ok(report)
}
#[cfg(test)]
mod reco_tests {
    use super::*;

    fn seed(id: &str, name: &str, media_type: &str) -> db::WatchedItem {
        db::WatchedItem {
            meta_id: id.into(),
            media_type: media_type.into(),
            name: name.into(),
            poster: None,
            background: None,
            season: None,
            episode: None,
            watched_at: 0,
        }
    }

    /// The honest check: the real client, the real catalogs, real history.
    /// `cargo test --lib -- --ignored`
    #[tokio::test]
    #[ignore = "talks to Cinemeta"]
    async fn one_row_of_picks_never_repeats_history() {
        let history = vec![
            seed("tt38915678", "Dorothy", "movie"),
            seed("tt28607951", "Anora", "movie"),
            seed("tt7363076", "Raid", "movie"),
            seed("tt16997004", "Matka King", "series"),
        ];
        let seen: Vec<String> = history.iter().map(|item| item.meta_id.clone()).collect();
        let rows = recommendation_rows(&crate::http_client(), history, seen.clone()).await;

        assert_eq!(rows.len(), 1, "the picks should be one row, not a stack");
        let row = &rows[0];
        assert_eq!(row.title, "Recommended for you");
        assert!(!row.items.is_empty(), "the one row came out empty");

        let ids: HashSet<&str> = row.items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids.len(), row.items.len(), "the same title appeared twice");
        for id in &seen {
            assert!(!ids.contains(id.as_str()), "{id} is already watched");
        }
        assert!(row.items.len() <= 24, "the row outgrew its cap");
    }
}
