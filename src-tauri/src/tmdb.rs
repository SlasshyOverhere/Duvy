//! TMDB integration used for discovery rows, search and richer detail pages.
//! The shared proxy makes it work without a key; a user key takes over instead.

use crate::addons::MetaPreview;
use crate::models::{CastMember, HomeRow, MetaDetails};
use serde_json::Value;
use std::time::Duration;

const API: &str = "https://api.themoviedb.org/3";
/// Worker in `workers/tmdb-proxy.js`: holds the project's read token and caches
/// responses. Empty until deployed.
const PROXY: &str = "";
const CINEMETA_CATALOG: &str = "https://v3-cinemeta.strem.io/catalog";
const IMG: &str = "https://image.tmdb.org/t/p";

/// Base URL and inline key: a user key wins, then the proxy, then nothing.
fn route(key: &str) -> Option<(&'static str, Option<&str>)> {
    let key = key.trim();
    if !key.is_empty() {
        Some((API, Some(key)))
    } else if !PROXY.is_empty() {
        Some((PROXY, None))
    } else {
        None
    }
}

/// Whether TMDB can answer at all.
pub(crate) fn available(key: &str) -> bool {
    route(key).is_some()
}

fn poster_url(path: &str) -> String {
    format!("{IMG}/w500{path}")
}

fn backdrop_url(path: &str) -> String {
    format!("{IMG}/w1280{path}")
}

fn year_from(value: &Value) -> Option<String> {
    value
        .get("release_date")
        .or_else(|| value.get("first_air_date"))
        .and_then(|v| v.as_str())
        .filter(|s| s.chars().count() >= 4)
        .map(|s| s.chars().take(4).collect::<String>())
}

fn media_type_of(item: &Value) -> String {
    if let Some(kind) = item.get("media_type").and_then(|v| v.as_str()) {
        return kind.to_string();
    }
    if item.get("first_air_date").is_some()
        || item.get("name").is_some() && item.get("title").is_none()
    {
        "series".into()
    } else {
        "movie".into()
    }
}

fn preview_from_item(item: &Value) -> Option<MetaPreview> {
    let media_type = media_type_of(item);
    if media_type != "movie" && media_type != "series" && media_type != "tv" {
        return None;
    }
    let media_type = if media_type == "tv" {
        "series".to_string()
    } else {
        media_type
    };

    // IMDb ids are what stream addons expect, so an `tt` id is kept as-is
    // instead of being wrapped in `tmdb:`.
    let imdb = item
        .get("imdb_id")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("id").and_then(|v| v.as_str()))
        .filter(|s| s.starts_with("tt"))
        .map(|s| s.to_string());
    // An IMDb id has a Cinemeta logo without another round trip; TMDB ids get
    // theirs from the images endpoint once the item reaches the hero.
    let logo = imdb
        .as_ref()
        .map(|id| format!("https://images.metahub.space/logo/medium/{id}/img"));
    let id = match (imdb, item.get("id").and_then(|v| v.as_i64())) {
        (Some(imdb), _) => imdb,
        (None, Some(numeric)) => format!("tmdb:{media_type}:{numeric}"),
        (None, None) => return None,
    };

    let name = item
        .get("title")
        .or_else(|| item.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let poster = item
        .get("poster_path")
        .and_then(|v| v.as_str())
        .map(poster_url);
    let background = item
        .get("backdrop_path")
        .and_then(|v| v.as_str())
        .map(backdrop_url);
    // TMDB's `vote_average` is not IMDb's score, so it is left out rather than
    // shown under the IMDb mark.
    Some(MetaPreview {
        id,
        media_type,
        name,
        poster,
        poster_shape: Some("poster".into()),
        background,
        logo,
        description: item
            .get("overview")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        release_info: year_from(item),
        imdb_rating: None,
        genres: item
            .get("genre_ids")
            .and_then(|v| v.as_array())
            .map(|_| vec![]),
        runtime: None,
    })
}

async fn fetch(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        // The TMDB key rides in the query string, so the URL never goes into an error.
        .map_err(|e| format!("metadata request failed: {}", e.without_url()))?;
    if !response.status().is_success() {
        return Err(format!(
            "metadata source returned HTTP {}",
            response.status()
        ));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("metadata response was not JSON: {}", e.without_url()))
}

fn items_of(value: &Value) -> Vec<MetaPreview> {
    value
        .get("results")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(preview_from_item).collect())
        .unwrap_or_default()
}

fn preview_from_cinemeta(item: &Value) -> Option<MetaPreview> {
    let id = item
        .get("imdb_id")
        .and_then(|v| v.as_str())
        .or_else(|| item.get("id").and_then(|v| v.as_str()))
        .filter(|s| s.starts_with("tt"))?
        .to_string();
    let kind = item.get("type").and_then(|v| v.as_str()).unwrap_or("movie");
    Some(MetaPreview {
        id,
        media_type: if kind == "series" {
            "series".into()
        } else {
            "movie".into()
        },
        name: item
            .get("name")
            .and_then(|v| v.as_str())
            .unwrap_or("Untitled")
            .to_string(),
        poster: item
            .get("poster")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        poster_shape: Some("poster".into()),
        background: item
            .get("background")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        logo: item
            .get("logo")
            .and_then(|v| v.as_str())
            .map(str::to_string),
        description: item
            .get("description")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        release_info: item
            .get("releaseInfo")
            .or_else(|| item.get("year"))
            .and_then(|v| v.as_str())
            .map(str::to_string),
        imdb_rating: item
            .get("imdbRating")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(str::to_string),
        genres: item.get("genres").and_then(|v| v.as_array()).map(|list| {
            list.iter()
                .filter_map(|g| g.as_str().map(str::to_string))
                .collect::<Vec<String>>()
        }),
        runtime: None,
    })
}

/// Cinemeta has two curated catalogs and they already carry IMDb ids.
fn catalog_url(path: &str) -> String {
    // Paths arrive as "movie/top" or "/movie/top": one slash, and it has to be
    // there, or the whole catalog quietly 404s into an empty row.
    format!(
        "{CINEMETA_CATALOG}/{}.json",
        path.strip_prefix('/').unwrap_or(path)
    )
}

/// Picks the clearest English logo from an images payload, falling back to the
/// best rated one when TMDB has no English art.
fn best_logo(value: &Value) -> Option<String> {
    let logos = value.get("logos").and_then(Value::as_array)?;
    let best = logos
        .iter()
        .filter_map(|logo| {
            let path = logo.get("file_path").and_then(Value::as_str)?;
            let english = logo.get("iso_639_1").and_then(Value::as_str) == Some("en");
            let votes = logo.get("vote_average").and_then(Value::as_f64).unwrap_or(0.0);
            Some(((english as u8, (votes * 1000.0) as i64), path))
        })
        .max_by_key(|(rank, _)| *rank)
        .map(|(_, path)| path)?;
    Some(format!("{IMG}/original{best}"))
}

async fn logo_for(
    client: &reqwest::Client,
    key: &str,
    kind: &str,
    tmdb_id: &str,
) -> Option<String> {
    let value = get(
        client,
        key,
        &format!("/{kind}/{tmdb_id}/images"),
        &[("include_image_language", "en,null")],
    )
    .await
    .ok()?;
    best_logo(&value)
}

/// TMDB list payloads carry no title art, so the row on screen asks for it.
async fn attach_logos(client: &reqwest::Client, key: &str, items: &mut [MetaPreview]) {
    let mut set = tokio::task::JoinSet::new();
    for (slot, item) in items.iter().enumerate() {
        let Some((kind, tmdb_id)) = item.id.strip_prefix("tmdb:").and_then(|r| r.split_once(':'))
        else {
            continue;
        };
        let (kind, tmdb_id) = (kind.to_string(), tmdb_id.to_string());
        let (client, key) = (client.clone(), key.to_string());
        set.spawn(async move {
            (slot, logo_for(&client, &key, &kind, &tmdb_id).await)
        });
    }
    while let Some(joined) = set.join_next().await {
        let Ok((slot, Some(logo))) = joined else {
            continue;
        };
        if let Some(item) = items.get_mut(slot) {
            item.logo = Some(logo);
        }
    }
}

async fn cinemeta_catalog(client: &reqwest::Client, path: &str) -> Vec<MetaPreview> {
    match fetch(client, &catalog_url(path)).await {
        Ok(value) => value
            .get("metas")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(preview_from_cinemeta).collect())
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    }
}

/// Percent-encode a search term so it stays one catalog-extra value.
pub(crate) fn escape(query: &str) -> String {
    let mut out = String::with_capacity(query.len());
    for byte in query.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Cinemeta's own catalogs double as search and return IMDb ids.
async fn cinemeta_search(client: &reqwest::Client, query: &str) -> Vec<MetaPreview> {
    let term = escape(query);
    let movie_path = format!("movie/top/search={term}");
    let series_path = format!("series/top/search={term}");
    let (movies, series) = tokio::join!(
        cinemeta_catalog(client, &movie_path),
        cinemeta_catalog(client, &series_path),
    );
    movies.into_iter().chain(series).collect()
}

async fn get(
    client: &reqwest::Client,
    key: &str,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let (base, key) = route(key).ok_or("TMDB is not configured")?;
    let mut url = reqwest::Url::parse(&format!("{base}{path}")).map_err(|e| e.to_string())?;
    {
        let mut pairs = url.query_pairs_mut();
        for (name, value) in query {
            pairs.append_pair(name, value);
        }
        if let Some(key) = key {
            pairs.append_pair("api_key", key);
        }
    }
    fetch(client, url.as_str()).await
}

/// More like this: Cinemeta's genre catalog, minus the title being viewed.
pub async fn similar(
    client: &reqwest::Client,
    media_type: &str,
    genre: &str,
    exclude: &str,
) -> Vec<MetaPreview> {
    let kind = if media_type == "series" {
        "series"
    } else {
        "movie"
    };
    let path = format!("{kind}/top/genre={}", escape(genre));
    cinemeta_catalog(client, &path)
        .await
        .into_iter()
        .filter(|item| item.id != exclude)
        .take(18)
        .collect()
}

/// (row id, Cinemeta catalog, TMDB path, row title)
const ROWS: &[(&str, &str, &str, &str)] = &[
    (
        "/popular/all",
        "",
        "trending/all/week",
        "Trending this week",
    ),
    (
        "/popular/movie",
        "movie/top",
        "movie/popular",
        "Popular movies",
    ),
    ("/popular/tv", "series/top", "tv/popular", "Popular shows"),
    (
        "/movie/top_rated",
        "movie/imdbRating",
        "movie/top_rated",
        "Top rated movies",
    ),
    (
        "/tv/top_rated",
        "series/imdbRating",
        "tv/top_rated",
        "Top rated shows",
    ),
    ("/movie/upcoming", "", "movie/now_playing", "In cinemas"),
];

pub async fn home_rows(client: &reqwest::Client, key: &str) -> Result<Vec<HomeRow>, String> {
    // The rows are independent, so launch them together: the wait becomes the
    // slowest row instead of the sum of all six.
    let mut set = tokio::task::JoinSet::new();
    for (index, row) in ROWS.iter().enumerate() {
        let (row_id, cinemeta_path, tmdb_path, title) = *row;
        let client = client.clone();
        let key = key.to_string();
        set.spawn(async move {
            // Cinemeta answers without a key and hands back IMDb ids, which is
            // what stream addons key on. TMDB fills rows it cannot serve.
            let mut items = if cinemeta_path.is_empty() {
                Vec::new()
            } else {
                cinemeta_catalog(&client, cinemeta_path).await
            };
            if items.is_empty() && available(&key) {
                items = get(
                    &client,
                    &key,
                    &format!("/{tmdb_path}"),
                    &[("language", "en-US")],
                )
                .await
                .map(|value| items_of(&value))
                .unwrap_or_default();
            }
            if items.is_empty() {
                return (index, None);
            }
            (
                index,
                Some(HomeRow {
                    id: format!("row:{row_id}"),
                    title: title.to_string(),
                    addon: Some("Discover".into()),
                    media_type: "mixed".into(),
                    catalog_id: row_id.to_string(),
                    items,
                }),
            )
        });
    }
    // Keep the declaration order: the first row feeds the hero.
    let mut slots: Vec<Option<HomeRow>> = ROWS.iter().map(|_| None).collect();
    while let Some(joined) = set.join_next().await {
        if let Ok((index, Some(row))) = joined {
            slots[index] = Some(row);
        }
    }
    let mut rows: Vec<HomeRow> = slots.into_iter().flatten().collect();
    if rows.is_empty() {
        return Err("No discovery source answered. Try again in a moment.".into());
    }
    // Only the hero shows title art, so only the first row pays for the lookup.
    // Cinemeta items already carry a logo and skip it.
    if let Some(hero) = rows.first_mut()
        && available(key)
    {
        attach_logos(client, key, &mut hero.items).await;
    }
    Ok(rows)
}

pub async fn search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> Result<Vec<MetaPreview>, String> {
    // Cinemeta first: no key, and the ids are the ones addons can stream.
    let mut items = cinemeta_search(client, query).await;

    if items.is_empty() && available(key) {
        let value = get(
            client,
            key,
            "/search/multi",
            &[
                ("query", query),
                ("include_adult", "false"),
                ("language", "en-US"),
            ],
        )
        .await?;
        items = items_of(&value);
    }
    Ok(items)
}

/// Resolve a TMDB id into a full detail record.
pub async fn details(
    client: &reqwest::Client,
    key: &str,
    media_type: &str,
    tmdb_id: &str,
) -> Result<MetaDetails, String> {
    let kind = if media_type == "series" || media_type == "tv" {
        "tv"
    } else {
        "movie"
    };
    let value = get(
        client,
        key,
        &format!("/{kind}/{tmdb_id}"),
        &[
            ("append_to_response", "credits,videos,external_ids"),
            ("language", "en-US"),
        ],
    )
    .await?;

    let name = value
        .get("title")
        .or_else(|| value.get("name"))
        .and_then(|v| v.as_str())
        .unwrap_or("Untitled")
        .to_string();
    let year = year_from(&value);
    let rating = value
        .get("vote_average")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
        .map(|v| format!("{v:.1}"));
    let genres = value
        .get("genres")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|g| {
                    g.get("name")
                        .and_then(|n| n.as_str())
                        .map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    let runtime = value
        .get("runtime")
        .and_then(|v| v.as_i64())
        .or_else(|| {
            value
                .get("episode_run_time")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_i64())
        })
        .map(|m| format!("{m} min"));

    let cast: Vec<CastMember> = value
        .get("credits")
        .and_then(|c| c.get("cast"))
        .and_then(|c| c.as_array())
        .map(|arr| {
            arr.iter()
                .take(14)
                .filter_map(|person| {
                    Some(CastMember {
                        name: person.get("name")?.as_str()?.to_string(),
                        character: person
                            .get("character")
                            .and_then(|v| v.as_str())
                            .unwrap_or("")
                            .to_string(),
                        photo: person
                            .get("profile_path")
                            .and_then(|v| v.as_str())
                            .map(|p| format!("{IMG}/w185{p}")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let trailer = value
        .get("videos")
        .and_then(|v| v.get("results"))
        .and_then(|v| v.as_array())
        .and_then(|arr| {
            arr.iter()
                .find(|v| {
                    v.get("site").and_then(|s| s.as_str()) == Some("YouTube")
                        && v.get("type").and_then(|s| s.as_str()) == Some("Trailer")
                })
                .or_else(|| arr.first())
        })
        .and_then(|v| v.get("key").and_then(|k| k.as_str()))
        .map(|k| format!("https://www.youtube.com/watch?v={k}"));

    let imdb_id = value
        .get("external_ids")
        .and_then(|e| e.get("imdb_id"))
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());

    let mut details = MetaDetails {
        id: format!("tmdb:{media_type}:{tmdb_id}"),
        media_type: if kind == "tv" {
            "series".into()
        } else {
            "movie".into()
        },
        name,
        poster: value
            .get("poster_path")
            .and_then(|v| v.as_str())
            .map(poster_url),
        background: value
            .get("backdrop_path")
            .and_then(|v| v.as_str())
            .map(backdrop_url),
        logo: None,
        description: value
            .get("overview")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        release_info: year.clone(),
        year,
        rating,
        genres,
        runtime,
        status: value
            .get("status")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string()),
        videos: vec![],
        cast,
        director: vec![],
        writer: vec![],
        country: vec![],
        trailer,
        imdb_id,
        tmdb_id: tmdb_id.parse().ok(),
        source: "tmdb".into(),
    };
    if details.logo.is_none() {
        details.logo = logo_for(client, key, kind, tmdb_id).await;
    }
    Ok(details)
}

/// Find the TMDB record for an IMDb id. Used to enrich addon metadata.
pub async fn find_by_imdb(
    client: &reqwest::Client,
    key: &str,
    imdb_id: &str,
) -> Result<Option<(String, String)>, String> {
    let value = get(
        client,
        key,
        &format!("/find/{imdb_id}"),
        &[("external_source", "imdb_id"), ("language", "en-US")],
    )
    .await?;
    for (key_name, kind) in [("movie_results", "movie"), ("tv_results", "series")] {
        if let Some(first) = value
            .get(key_name)
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            && let Some(id) = first.get("id").and_then(|v| v.as_i64())
        {
            return Ok(Some((kind.to_string(), id.to_string())));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod catalog_tests {
    use super::*;

    #[test]
    fn a_user_key_wins_and_a_blank_one_falls_back() {
        assert_eq!(route("abc").map(|(base, _)| base), Some(API));
        assert_eq!(route("").is_some(), !PROXY.is_empty());
    }

    #[test]
    fn catalog_urls_keep_their_slash() {
        let base = "https://v3-cinemeta.strem.io/catalog";
        assert_eq!(catalog_url("movie/top"), format!("{base}/movie/top.json"));
        assert_eq!(catalog_url("/movie/top"), format!("{base}/movie/top.json"));
        assert_eq!(
            catalog_url("movie/top/genre=Action"),
            format!("{base}/movie/top/genre=Action.json")
        );
    }

    #[test]
    fn best_logo_prefers_english_then_votes() {
        let payload = serde_json::json!({
            "logos": [
                { "file_path": "/de.png", "iso_639_1": "de", "vote_average": 9.0 },
                { "file_path": "/en-low.png", "iso_639_1": "en", "vote_average": 1.0 },
                { "file_path": "/en-high.png", "iso_639_1": "en", "vote_average": 7.0 }
            ]
        });
        assert_eq!(
            best_logo(&payload).as_deref(),
            Some("https://image.tmdb.org/t/p/original/en-high.png")
        );
        assert_eq!(best_logo(&serde_json::json!({})), None);
    }

    #[test]
    fn imdb_rows_get_a_logo_without_a_request() {
        let item = serde_json::json!({ "id": "tt37287335", "title": "Obsession" });
        let preview = preview_from_item(&item).expect("preview");
        assert_eq!(
            preview.logo.as_deref(),
            Some("https://images.metahub.space/logo/medium/tt37287335/img")
        );
    }
}
