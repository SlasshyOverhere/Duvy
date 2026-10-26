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
use tauri::{AppHandle, Manager, State};
use tokio::task::JoinSet;

const MAX_ITEMS_PER_ROW: usize = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn parse_manifest(addon: &StoredAddon) -> Manifest {
    serde_json::from_value(addon.manifest.clone()).unwrap_or_default()
}

fn load_settings(state: &AppState) -> Settings {
    match state.db.0.lock() {
        Ok(conn) => Settings::load(&conn),
        // A poisoned lock means an earlier panic; recovering keeps the app up.
        Err(poisoned) => Settings::load(&poisoned.into_inner()),
    }
}

async fn fetch_json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    fetch_json_within(client, url, None).await
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
    let mut request = client.get(url).header("accept", "application/json");
    if let Some(cap) = cap {
        request = request.timeout(cap);
    }
    let response = request
        .send()
        .await
        .map_err(|e| format!("request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("invalid JSON: {e}"))
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
            name,
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
        director: meta.director.clone().unwrap_or_default(),
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
    for addon in addons.iter().filter(|a| a.enabled) {
        let manifest = parse_manifest(addon);
        if !manifest.resource_for("meta", media_type, id) {
            continue;
        }
        let url = addons::meta_url(&addon.url, media_type, id);
        if let Ok(value) = fetch_json(client, &url).await {
            if let Ok(response) = serde_json::from_value::<MetaResponse>(value) {
                if let Some(meta) = response.meta {
                    return Some(meta);
                }
            }
        }
    }
    None
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
        mpv: player::find_mpv(&settings.mpv_path, mpv_dir(&app).as_deref()),
    })
}

fn mpv_dir(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().resource_dir().ok()
}

#[tauri::command]
pub async fn mpv_detect(app: AppHandle, path: Option<String>) -> Option<crate::models::MpvInfo> {
    player::find_mpv(path.as_deref().unwrap_or_default(), mpv_dir(&app).as_deref())
}

#[tauri::command]
pub fn settings_get(state: State<'_, AppState>) -> Result<Settings, String> {
    Ok(load_settings(&state))
}

#[tauri::command]
pub fn settings_set(patch: Value, state: State<'_, AppState>) -> Result<Settings, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let mut settings = Settings::load(&conn);
    settings.apply_patch(patch)?;
    settings.save(&conn)?;
    Ok(settings)
}

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

fn addon_info(addon: &StoredAddon) -> AddonInfo {
    let manifest = parse_manifest(addon);
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
    }
}

#[tauri::command]
pub fn addons_list(state: State<'_, AppState>) -> Result<Vec<AddonInfo>, String> {
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
    let manifest_url = format!("{base}/manifest.json");
    let value = fetch_json(&state.http, &manifest_url).await?;
    let manifest: Manifest = serde_json::from_value(value.clone())
        .map_err(|e| format!("That URL did not return a valid addon manifest: {e}"))?;
    if manifest.name.trim().is_empty() || manifest.id.trim().is_empty() {
        return Err("That manifest is missing an id or name".into());
    }
    {
        let conn = state.db.0.lock().map_err(|_| "database is locked")?;
        db::upsert_addon(&conn, &base, &manifest.id, &manifest.name, &value)
            .map_err(|e| e.to_string())?;
        let addons = db::list_addons(&conn).map_err(|e| e.to_string())?;
        let stored = addons
            .iter()
            .find(|a| a.url == base)
            .ok_or("Addon was not stored")?;
        Ok(addon_info(stored))
    }
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
            db::list_progress(&conn).map_err(|e| e.to_string())?,
        )
    };

    let mut rows: Vec<HomeRow> = Vec::new();
    let mut errors: Vec<String> = Vec::new();

    let key = settings.tmdb_api_key.trim().to_string();
    if !key.is_empty() {
        match tmdb::home_rows(&state.http, &key).await {
            Ok(mut tmdb_rows) => rows.append(&mut tmdb_rows),
            Err(e) => errors.push(format!("TMDB: {e}")),
        }
    }

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
    for addon in addons.iter().filter(|a| a.enabled) {
        let manifest = parse_manifest(addon);
        let mut taken = 0;
        for catalog in &manifest.catalogs {
            if taken >= 4 {
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
            let suffix = if row.media_type == "series" { "Series" } else { "Movies" };
            row.title = format!("{} · {suffix}", row.title);
        }
    }
    rows.extend(addon_rows.into_iter().map(|(_, row)| row));

    let limit = settings.home_rows_limit.clamp(1, 24) as usize;
    rows.truncate(limit);
    errors.truncate(6);

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

    let key = settings.tmdb_api_key.trim().to_string();
    if !key.is_empty() {
        if let Ok(mut tmdb_results) = tmdb::search(&state.http, &key, &query).await {
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
        return Ok(details);
    }

    let mut details = if let Some(meta) =
        addon_meta(&state.http, &addons, &id, &media_type).await
    {
        meta_details_from_meta(meta, "addon")
    } else if !key.is_empty() && id.starts_with("tt") {
        let found = tmdb::find_by_imdb(&state.http, &key, &id).await?;
        match found {
            Some((kind, tmdb_id)) => tmdb::details(&state.http, &key, &kind, &tmdb_id).await?,
            None => return Err("No metadata source could resolve this title".into()),
        }
    } else {
        return Err(
            "No metadata addon is installed for this title. Add a metadata addon in Settings → Addons."
                .into(),
        );
    };

    if !key.is_empty() {
        let imdb = details
            .imdb_id
            .clone()
            .or_else(|| id.starts_with("tt").then(|| id.clone()));
        if let Some(imdb) = imdb {
            if details.background.is_none() || details.cast.is_empty() || details.trailer.is_none() {
                if let Ok(Some((kind, tmdb_id))) =
                    tmdb::find_by_imdb(&state.http, &key, &imdb).await
                {
                    if let Ok(rich) = tmdb::details(&state.http, &key, &kind, &tmdb_id).await {
                        merge_details(&mut details, rich);
                    }
                }
            }
        }
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
    // and scraping addons can take half a minute cold), 20s in the all-addons
    // fan-out so one dead source cannot stall the list.
    let cap = if only.is_some() { 45 } else { 20 };
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

    let mut options: Vec<StreamOption> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    while let Some(joined) = set.join_next().await {
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

    let mut tracks = Vec::new();
    while let Some(joined) = set.join_next().await {
        if let Ok((addon, Ok(response))) = joined {
            for subtitle in response.subtitles {
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
pub fn library_list(state: State<'_, AppState>) -> Result<Vec<LibraryItem>, String> {
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
pub fn progress_list(state: State<'_, AppState>) -> Result<Vec<ProgressItem>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    db::list_progress(&conn).map_err(|e| e.to_string())
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
    drop(previous);
    let player = Player::spawn(
        app.clone(),
        &settings,
        &request,
        host,
        mpv_dir(&app).as_deref(),
    )?;
    let snapshot = player.snapshot();
    *state.player.lock().map_err(|_| "player is busy")? = Some(player);
    Ok(snapshot)
}

#[tauri::command]
pub async fn player_state(state: State<'_, AppState>) -> Result<Option<Snapshot>, String> {
    let guard = state.player.lock().map_err(|_| "player is busy")?;
    Ok(guard.as_ref().map(|player| player.snapshot()))
}

#[tauri::command]
pub async fn player_control(
    action: String,
    value: Option<Value>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.player.lock().map_err(|_| "player is busy")?;
    if action == "stop" {
        if let Some(player) = guard.as_mut() {
            let _ = player.command("stop", None);
        }
        *guard = None;
        return Ok(());
    }
    let player = guard.as_mut().ok_or("Nothing is playing")?;
    player.command(&action, value)
}

#[tauri::command]
pub async fn player_stop(state: State<'_, AppState>) -> Result<(), String> {
    let mut guard = state.player.lock().map_err(|_| "player is busy")?;
    *guard = None;
    Ok(())
}

#[tauri::command]
pub async fn player_subtitle(
    url: String,
    label: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut guard = state.player.lock().map_err(|_| "player is busy")?;
    let player = guard.as_mut().ok_or("Nothing is playing")?;
    player.command(
        "sub-add",
        Some(json!({ "url": url, "label": label.unwrap_or_else(|| "Subtitle".into()) })),
    )
}

/// Fullscreen is driven straight against the window handle so playback keeps
/// running while the window changes shape.
#[tauri::command]
pub fn window_fullscreen(app: AppHandle, on: bool) -> Result<(), String> {
    let host = crate::video_host(&app).ok_or("The main window is not available")?;
    if crate::set_fullscreen(host, on) {
        Ok(())
    } else {
        Err("The window could not go fullscreen".into())
    }
}
