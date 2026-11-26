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

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CastMember {
    pub name: String,
    pub character: String,
    pub photo: Option<String>,
    /// TMDB person id, so the face opens their own page.
    pub person_id: Option<i64>,
}

/// One season of a show, with the art the season picker shows.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct SeasonSummary {
    pub number: i64,
    pub name: String,
    pub poster: Option<String>,
    pub episodes: i64,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TrailerLink {
    pub name: String,
    pub url: String,
    pub thumbnail: Option<String>,
    pub year: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    pub name: String,
    pub logo: Option<String>,
}

#[derive(Serialize, Clone, Debug, Default)]
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
    pub composer: Vec<String>,
    pub country: Vec<String>,
    pub trailer: Option<String>,
    pub trailers: Vec<TrailerLink>,
    pub seasons: Vec<SeasonSummary>,
    pub networks: Vec<Network>,
    pub companies: Vec<Network>,
    pub collection_name: Option<String>,
    pub collection_items: Vec<MetaPreview>,
    pub certification: Option<String>,
    pub origin_country: Vec<String>,
    pub original_language: Option<String>,
    pub imdb_id: Option<String>,
    pub tmdb_id: Option<i64>,
    pub source: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PersonDetails {
    pub id: i64,
    pub name: String,
    pub photo: Option<String>,
    pub department: Option<String>,
    pub birthday: Option<String>,
    pub deathday: Option<String>,
    pub place_of_birth: Option<String>,
    pub biography: Option<String>,
    pub credits: usize,
    /// First year they appear in a credit.
    pub since: Option<String>,
    pub popular: Vec<MetaPreview>,
    pub latest: Vec<MetaPreview>,
    pub upcoming: Vec<MetaPreview>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ParentalWarning {
    /// nudity, violence, profanity, alcohol or frightening.
    pub category: String,
    /// severe, moderate or mild.
    pub severity: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct SubtitleTrack {
    pub id: String,
    pub url: String,
    pub lang: String,
    pub label: String,
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
    pub configure_url: Option<String>,
    pub configuration_required: Option<bool>,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub platform: String,
    pub data_dir: String,
}
