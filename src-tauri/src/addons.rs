//! Stremio-compatible addon protocol client.
//!
//! An addon is any HTTP service that serves the open Stremio addon
//! protocol (`/manifest.json`, `/catalog/...`, `/meta/...`, `/stream/...`,
//! `/subtitles/...`). Nothing here ships content: the user brings their own
//! addon URLs.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

// ---------------------------------------------------------------------------
// Protocol models
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct CatalogDef {
    #[serde(rename = "type", default)]
    pub media_type: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub extra: Vec<ExtraProp>,
    #[serde(default)]
    pub genres: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ExtraProp {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub is_required: bool,
    #[serde(default)]
    pub options: Option<Vec<String>>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(untagged)]
pub enum ResourceRef {
    Name(String),
    Detailed {
        #[serde(default)]
        name: String,
        #[serde(default)]
        types: Vec<String>,
        // The protocol spells this `idPrefixes`; without the rename the field is
        // silently dropped and every addon looks like it supports every id.
        #[serde(default, rename = "idPrefixes")]
        id_prefixes: Option<Vec<String>>,
    },
}

impl ResourceRef {
    pub fn name(&self) -> &str {
        match self {
            ResourceRef::Name(name) => name,
            ResourceRef::Detailed { name, .. } => name,
        }
    }

    pub fn supports_type(&self, media_type: &str) -> bool {
        match self {
            ResourceRef::Name(_) => true,
            ResourceRef::Detailed { types, .. } => {
                types.is_empty() || types.iter().any(|t| t == media_type)
            }
        }
    }

    pub fn supports_id(&self, id: &str) -> bool {
        match self {
            ResourceRef::Name(_) => true,
            ResourceRef::Detailed { id_prefixes, .. } => match id_prefixes {
                None => true,
                Some(prefixes) => prefixes.iter().any(|p| id.starts_with(p)),
            },
        }
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub resources: Vec<ResourceRef>,
    #[serde(default)]
    pub types: Vec<String>,
    #[serde(default)]
    pub catalogs: Vec<CatalogDef>,
    #[serde(default)]
    pub id_prefixes: Option<Vec<String>>,
    #[serde(default)]
    pub behavior_hints: Option<Value>,
    #[serde(default)]
    pub addon_collection: Option<Value>,
}

impl Manifest {
    pub fn resource_for(&self, name: &str, media_type: &str, id: &str) -> bool {
        self.resources
            .iter()
            .any(|r| r.name() == name && r.supports_type(media_type) && r.supports_id(id))
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetaPreview {
    #[serde(default)]
    pub id: String,
    #[serde(rename = "type", default)]
    pub media_type: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub poster: Option<String>,
    #[serde(default)]
    pub poster_shape: Option<String>,
    #[serde(default)]
    pub background: Option<String>,
    #[serde(default)]
    pub logo: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub release_info: Option<String>,
    #[serde(default)]
    pub imdb_rating: Option<String>,
    #[serde(default)]
    pub genres: Option<Vec<String>>,
    #[serde(default)]
    pub runtime: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Meta {
    #[serde(flatten)]
    pub preview: MetaPreview,
    #[serde(default)]
    pub year: Option<Value>,
    #[serde(default)]
    pub cast: Option<Vec<String>>,
    #[serde(default)]
    pub director: Option<Vec<String>>,
    #[serde(default)]
    pub writer: Option<Vec<String>>,
    #[serde(default)]
    pub country: Option<String>,
    #[serde(default)]
    pub awards: Option<String>,
    #[serde(default)]
    pub videos: Vec<Video>,
    #[serde(default)]
    pub trailers: Vec<Trailer>,
    #[serde(default)]
    pub trailers_streams: Option<Vec<Stream>>,
    #[serde(default)]
    pub links: Vec<Link>,
    #[serde(default)]
    pub behavior_hints: Option<Value>,
    #[serde(default)]
    pub release_dates: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Video {
    #[serde(default)]
    pub id: String,
    #[serde(default, alias = "name")]
    pub title: Option<String>,
    #[serde(default)]
    pub season: Option<i64>,
    #[serde(default)]
    pub episode: Option<i64>,
    #[serde(default)]
    pub number: Option<i64>,
    #[serde(default)]
    pub overview: Option<String>,
    #[serde(default)]
    pub thumbnail: Option<String>,
    #[serde(default)]
    pub released: Option<String>,
    #[serde(default)]
    pub available: Option<bool>,
    #[serde(default)]
    pub rating: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Trailer {
    #[serde(default)]
    pub source: String,
    #[serde(default, rename = "type")]
    pub kind: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Link {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub category: String,
    #[serde(default)]
    pub url: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stream {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub url: Option<String>,
    #[serde(default)]
    pub yt_id: Option<String>,
    #[serde(default)]
    pub info_hash: Option<String>,
    #[serde(default)]
    pub file_idx: Option<i64>,
    #[serde(default)]
    pub external_url: Option<String>,
    #[serde(default)]
    pub sources: Option<Vec<String>>,
    #[serde(default)]
    pub behavior_hints: Option<Value>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct CatalogResponse {
    #[serde(default)]
    pub metas: Vec<MetaPreview>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct StreamResponse {
    #[serde(default)]
    pub streams: Vec<Stream>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Subtitle {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub lang: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct SubtitleResponse {
    #[serde(default)]
    pub subtitles: Vec<Subtitle>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
pub struct MetaResponse {
    #[serde(default)]
    pub meta: Option<Meta>,
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

/// The cloud metadata endpoints, which no addon has any business reaching.
/// Loopback and LAN hosts stay allowed: addons are user-configured and often
/// run on the same machine or network.
pub(crate) fn is_blocked_host(host: &str) -> bool {
    let lower = host.trim_matches(['[', ']']).to_ascii_lowercase();
    if lower == "metadata.google.internal" {
        return true;
    }
    match lower.parse::<std::net::IpAddr>() {
        Ok(std::net::IpAddr::V4(v4)) => v4.is_link_local() || v4.is_unspecified(),
        Ok(std::net::IpAddr::V6(v6)) => {
            v6.is_unspecified()
                || v6.to_ipv4_mapped()
                    .is_some_and(|v4| v4.is_link_local() || v4.is_unspecified())
        }
        Err(_) => false,
    }
}

/// Normalise anything a user may paste into an addon base URL.
pub fn normalize_addon_url(input: &str) -> String {
    let mut raw = input.trim().to_string();
    if raw.is_empty() {
        return raw;
    }
    if let Some(rest) = raw.strip_prefix("stremio://") {
        raw = format!("https://{rest}");
    }
    if !raw.starts_with("http://") && !raw.starts_with("https://") {
        raw = format!("https://{raw}");
    }
    let mut trimmed = raw.trim_end_matches('/').to_string();
    if trimmed.ends_with("/manifest.json") {
        trimmed.truncate(trimmed.len() - "/manifest.json".len());
    }
    trimmed.trim_end_matches('/').to_string()
}

/// Percent-encode a query value the way the addon protocol expects.
pub fn encode(value: &str) -> String {
    encode_with(value, false)
}

/// A path segment may keep `:`, or episode ids (`tt123:1:2`) lose their shape.
fn encode_segment(value: &str) -> String {
    encode_with(value, true)
}

fn encode_with(value: &str, keep_colon: bool) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*byte as char)
            }
            b':' if keep_colon => out.push(':'),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

pub fn extra_segment(extra: &BTreeMap<String, String>) -> String {
    extra
        .iter()
        .filter(|(_, v)| !v.is_empty())
        .map(|(k, v)| format!("{}={}", encode(k), encode(v)))
        .collect::<Vec<_>>()
        .join("&")
}

pub fn catalog_url(
    base: &str,
    media_type: &str,
    catalog_id: &str,
    extra: &BTreeMap<String, String>,
) -> String {
    // Catalog ids come from the addon's own manifest, so they are encoded like
    // any other untrusted segment instead of being pasted into the path.
    let media_type = encode_segment(media_type);
    let catalog_id = encode_segment(catalog_id);
    let segment = extra_segment(extra);
    if segment.is_empty() {
        format!("{base}/catalog/{media_type}/{catalog_id}.json")
    } else {
        format!("{base}/catalog/{media_type}/{catalog_id}/{segment}.json")
    }
}

pub fn meta_url(base: &str, media_type: &str, id: &str) -> String {
    format!(
        "{base}/meta/{}/{}.json",
        encode_segment(media_type),
        encode_segment(id)
    )
}

pub fn stream_url(base: &str, media_type: &str, id: &str) -> String {
    format!(
        "{base}/stream/{}/{}.json",
        encode_segment(media_type),
        encode_segment(id)
    )
}

pub fn subtitle_url(base: &str, media_type: &str, id: &str, extra: &BTreeMap<String, String>) -> String {
    let media_type = encode_segment(media_type);
    let id = encode_segment(id);
    let segment = extra_segment(extra);
    if segment.is_empty() {
        format!("{base}/subtitles/{media_type}/{id}.json")
    } else {
        format!("{base}/subtitles/{media_type}/{id}/{segment}.json")
    }
}

/// Build the protocol id for an episode: `tt1234567:2:5`.
pub fn episode_id(base_id: &str, season: Option<i64>, episode: Option<i64>) -> String {
    match (season, episode) {
        (Some(season), Some(episode)) => format!("{base_id}:{season}:{episode}"),
        _ => base_id.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalises_addon_urls() {
        assert_eq!(
            normalize_addon_url("https://v3-cinemeta.strem.io/manifest.json"),
            "https://v3-cinemeta.strem.io"
        );
        assert_eq!(
            normalize_addon_url("v3-cinemeta.strem.io/"),
            "https://v3-cinemeta.strem.io"
        );
        assert_eq!(
            normalize_addon_url("stremio://example.org/manifest.json"),
            "https://example.org"
        );
        assert_eq!(
            normalize_addon_url("http://example.org/manifest.json"),
            "http://example.org"
        );
        assert_eq!(
            normalize_addon_url("http://192.168.1.10:8096"),
            "http://192.168.1.10:8096"
        );
    }

    #[test]
    fn encodes_meta_and_stream_segments() {
        assert_eq!(
            meta_url("https://x", "movie", "tt 123"),
            "https://x/meta/movie/tt%20123.json"
        );
        assert_eq!(
            stream_url("https://x", "series", "tt123:1:2"),
            "https://x/stream/series/tt123:1:2.json"
        );
    }

    #[test]
    fn builds_catalog_urls() {
        let mut extra = BTreeMap::new();
        extra.insert("search".to_string(), "the last of us".to_string());
        assert_eq!(
            catalog_url("https://x", "series", "top", &extra),
            "https://x/catalog/series/top/search=the%20last%20of%20us.json"
        );
        assert_eq!(
            catalog_url("https://x", "movie", "top", &BTreeMap::new()),
            "https://x/catalog/movie/top.json"
        );
    }

    #[test]
    fn builds_episode_ids() {
        assert_eq!(episode_id("tt123", Some(2), Some(5)), "tt123:2:5");
        assert_eq!(episode_id("tt123", None, None), "tt123");
    }

    #[test]
    fn manifest_reads_resource_id_prefixes() {
        let manifest: Manifest = serde_json::from_value(serde_json::json!({
            "id": "org.example",
            "resources": [{ "name": "stream", "types": ["movie"], "idPrefixes": ["tt"] }]
        }))
        .expect("manifest");
        assert!(manifest.resource_for("stream", "movie", "tt123"));
        assert!(!manifest.resource_for("stream", "movie", "kitsu:5"));
        assert!(!manifest.resource_for("stream", "series", "tt123"));
    }

    #[test]
    fn catalog_ids_from_a_manifest_are_escaped() {
        assert_eq!(
            catalog_url("https://x", "series", "top/extra?x=1", &BTreeMap::new()),
            "https://x/catalog/series/top%2Fextra%3Fx%3D1.json"
        );
    }
}
