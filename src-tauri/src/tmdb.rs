//! Optional TMDB integration used for discovery rows, search and richer detail
//! pages. Without a key the app works entirely from addon data.

use crate::models::{CastMember, HomeRow, MetaDetails};
use crate::addons::MetaPreview;
use serde_json::Value;

const API: &str = "https://api.themoviedb.org/3";
const IMG: &str = "https://image.tmdb.org/t/p";

pub fn poster_url(path: &str) -> String {
    format!("{IMG}/w500{path}")
}

pub fn backdrop_url(path: &str) -> String {
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
    if item.get("first_air_date").is_some() || item.get("name").is_some() && item.get("title").is_none() {
        "series".into()
    } else {
        "movie".into()
    }
}

pub fn preview_from_item(item: &Value) -> Option<MetaPreview> {
    let tmdb_id = item.get("id")?.as_i64()?;
    let media_type = media_type_of(item);
    if media_type != "movie" && media_type != "series" && media_type != "tv" {
        return None;
    }
    let media_type = if media_type == "tv" { "series".to_string() } else { media_type };
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
    let rating = item
        .get("vote_average")
        .and_then(|v| v.as_f64())
        .filter(|v| *v > 0.0)
        .map(|v| format!("{v:.1}"));

    Some(MetaPreview {
        id: format!("tmdb:{media_type}:{tmdb_id}"),
        media_type,
        name,
        poster,
        poster_shape: Some("poster".into()),
        background,
        logo: None,
        description: item
            .get("overview")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        release_info: year_from(item),
        imdb_rating: rating,
        genres: item.get("genre_ids").and_then(|v| v.as_array()).map(|_| vec![]),
        runtime: None,
    })
}

async fn get(
    client: &reqwest::Client,
    key: &str,
    path: &str,
    query: &[(&str, &str)],
) -> Result<Value, String> {
    let url = format!("{API}{path}");
    let request = client.get(&url).query(query).query(&[("api_key", key)]);
    let response = request
        .send()
        .await
        .map_err(|e| format!("TMDB request failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!("TMDB returned HTTP {}", response.status()));
    }
    response
        .json::<Value>()
        .await
        .map_err(|e| format!("TMDB response was not JSON: {e}"))
}

const ROWS: &[(&str, &str)] = &[
    ("trending/all/week", "Trending this week"),
    ("movie/popular", "Popular movies"),
    ("tv/popular", "Popular series"),
    ("movie/top_rated", "Top rated movies"),
    ("tv/top_rated", "Top rated series"),
    ("movie/now_playing", "In cinemas"),
];

pub async fn home_rows(client: &reqwest::Client, key: &str) -> Result<Vec<HomeRow>, String> {
    let mut rows = Vec::new();
    for (path, title) in ROWS {
        let value = get(client, key, &format!("/{path}"), &[("language", "en-US")]).await?;
        let items: Vec<MetaPreview> = value
            .get("results")
            .and_then(|v| v.as_array())
            .map(|arr| arr.iter().filter_map(preview_from_item).collect())
            .unwrap_or_default();
        if items.is_empty() {
            continue;
        }
        rows.push(HomeRow {
            id: format!("tmdb:{path}"),
            title: (*title).to_string(),
            addon: Some("TMDB".into()),
            media_type: "mixed".into(),
            catalog_id: path.to_string(),
            items,
        });
    }
    Ok(rows)
}

pub async fn search(
    client: &reqwest::Client,
    key: &str,
    query: &str,
) -> Result<Vec<MetaPreview>, String> {
    let value = get(
        client,
        key,
        "/search/multi",
        &[("query", query), ("include_adult", "false"), ("language", "en-US")],
    )
    .await?;
    Ok(value
        .get("results")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter().filter_map(preview_from_item).collect())
        .unwrap_or_default())
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
        &[("append_to_response", "credits,videos,external_ids"), ("language", "en-US")],
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
                .filter_map(|g| g.get("name").and_then(|n| n.as_str()).map(|s| s.to_string()))
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

    let details = MetaDetails {
        id: format!("tmdb:{media_type}:{tmdb_id}"),
        media_type: if kind == "tv" { "series".into() } else { "movie".into() },
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
        trailer,
        imdb_id,
        tmdb_id: tmdb_id.parse().ok(),
        source: "tmdb".into(),
    };
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
        if let Some(first) = value.get(key_name).and_then(|v| v.as_array()).and_then(|a| a.first()) {
            if let Some(id) = first.get("id").and_then(|v| v.as_i64()) {
                return Ok(Some((kind.to_string(), id.to_string())));
            }
        }
    }
    Ok(None)
}
