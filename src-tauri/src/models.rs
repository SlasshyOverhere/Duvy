//! Shared data shapes passed across the Tauri IPC boundary.

use crate::addons::{MetaPreview, Video};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HomeRow {
    pub id: String,
    pub title: String,
    pub addon: Option<String>,
    #[serde(rename = "type")]
    pub media_type: String,
    pub catalog_id: String,
    pub items: Vec<MetaPreview>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HomeFeed {
    pub continue_watching: Vec<crate::db::ProgressItem>,
    pub rows: Vec<HomeRow>,
    /// Configured but unusable addons, surfaced so the UI can explain empty homes.
    pub addon_errors: Vec<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CastMember {
    pub name: String,
    pub character: String,
    pub photo: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MetaDetails {
    pub id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub logo: Option<String>,
    pub description: Option<String>,
    pub release_info: Option<String>,
    pub year: Option<String>,
    pub rating: Option<String>,
    pub genres: Vec<String>,
    pub runtime: Option<String>,
    pub status: Option<String>,
    pub videos: Vec<Video>,
    pub cast: Vec<CastMember>,
    pub director: Vec<String>,
    pub writer: Vec<String>,
    pub country: Vec<String>,
    pub trailer: Option<String>,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<i64>,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SubtitleTrack {
    pub id: String,
    pub url: String,
    pub lang: String,
    pub addon: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackSession {
    pub key: String,
    pub meta_id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_title: Option<String>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AddonInfo {
    pub url: String,
    pub addon_id: String,
    pub name: String,
    pub version: String,
    pub description: Option<String>,
    pub logo: Option<String>,
    pub enabled: bool,
    pub types: Vec<String>,
    pub resources: Vec<String>,
    pub catalogs: Vec<crate::addons::CatalogDef>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub data_dir: String,
    pub mpv: Option<MpvInfo>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MpvInfo {
    pub path: String,
    pub version: String,
}
