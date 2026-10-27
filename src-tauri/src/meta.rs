//! IMDb-keyed metadata for ids that arrive without a title.
//!
//! Nuvio Cloud only stores ids, so a progress row can land here as `tt1234567`
//! with no name and no artwork. This resolves such an id through the unofficial
//! TMDB mirror first (it speaks TMDB's shapes but takes IMDb ids), then
//! Cinemeta, which is the only source that returns a whole episode list in one
//! request. Every failure just means "no data": callers keep what they have.

use crate::addons::Video;
use crate::models::{CastMember, MetaDetails};
use serde_json::Value;
use std::time::Duration;

const BALLOON: &str = "https://api.balloonerismm.workers.dev";
const CINEMETA: &str = "https://v3-cinemeta.strem.io/meta";
const IMG: &str = "https://image.tmdb.org/t/p";

fn is_tv(media_type: &str) -> bool {
    media_type == "series" || media_type == "tv"
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

fn image(value: &Value, field: &str, size: &str) -> Option<String> {
    text(value.get(field)).map(|path| format!("{IMG}/{size}{path}"))
}

fn year(value: &Value) -> Option<String> {
    text(value.get("release_date"))
        .or_else(|| text(value.get("first_air_date")))
        .filter(|s| s.len() >= 4)
        .map(|s| s[..4].to_string())
}

fn rating(value: &Value) -> Option<String> {
    value
        .get("vote_average")
        .and_then(Value::as_f64)
        .filter(|v| *v > 0.0)
        .map(|v| format!("{v:.1}"))
}

async fn json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    let response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    response.json::<Value>().await.map_err(|e| e.to_string())
}

/// The mirror answers with TMDB's schema, keyed by `tt` id.
async fn balloon(
    client: &reqwest::Client,
    imdb: &str,
    media_type: &str,
) -> Result<MetaDetails, String> {
    let kind = if is_tv(media_type) { "tv" } else { "movie" };
    let value = json(
        client,
        &format!("{BALLOON}/{kind}/{imdb}?language=en-US&append_to_response=credits,videos,external_ids"),
    )
    .await?;
    let name = text(value.get("title"))
        .or_else(|| text(value.get("name")))
        .ok_or("no title in reply")?;

    let genres = value
        .get("genres")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|g| text(g.get("name")))
                .collect()
        })
        .unwrap_or_default();

    let cast = value
        .get("credits")
        .and_then(|c| c.get("cast"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(14)
                .filter_map(|person| {
                    Some(CastMember {
                        name: text(person.get("name"))?,
                        character: text(person.get("character")).unwrap_or_default(),
                        photo: image(person, "profile_path", "w185"),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    let director = value
        .get("credits")
        .and_then(|c| c.get("crew"))
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter(|person| text(person.get("job")).as_deref() == Some("Director"))
                .filter_map(|person| text(person.get("name")))
                .collect()
        })
        .unwrap_or_default();

    let trailer = value
        .get("videos")
        .and_then(|v| v.get("results"))
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find(|v| {
                    text(v.get("site")).as_deref() == Some("YouTube")
                        && text(v.get("type")).as_deref() == Some("Trailer")
                })
                .or_else(|| list.first())
        })
        .and_then(|v| text(v.get("key")))
        .map(|key| format!("https://www.youtube.com/watch?v={key}"));

    let runtime = value
        .get("runtime")
        .and_then(Value::as_i64)
        .or_else(|| {
            value
                .get("episode_run_time")
                .and_then(Value::as_array)
                .and_then(|a| a.first())
                .and_then(Value::as_i64)
        })
        .map(|minutes| format!("{minutes} min"));

    Ok(MetaDetails {
        id: imdb.to_string(),
        media_type: if is_tv(media_type) { "series".into() } else { "movie".into() },
        name,
        poster: image(&value, "poster_path", "w500"),
        background: image(&value, "backdrop_path", "w1280"),
        logo: None,
        description: text(value.get("overview")),
        release_info: year(&value),
        year: year(&value),
        rating: rating(&value),
        genres,
        runtime,
        status: text(value.get("status")),
        videos: Vec::new(),
        cast,
        director,
        trailer,
        imdb_id: Some(imdb.to_string()),
        tmdb_id: value.get("id").and_then(Value::as_i64),
        source: "balloonerism".into(),
    })
}

/// Cinemeta carries every episode in one document, so it owns the video list.
async fn cinemeta(
    client: &reqwest::Client,
    imdb: &str,
    media_type: &str,
) -> Option<MetaDetails> {
    let kind = if is_tv(media_type) { "series" } else { "movie" };
    let value = json(client, &format!("{CINEMETA}/{kind}/{imdb}.json"))
        .await
        .ok()?;
    let meta = value.get("meta")?;
    if meta.is_null() {
        return None;
    }

    let videos: Vec<Video> = meta
        .get("videos")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|item| {
                    let season = item.get("season").and_then(Value::as_i64);
                    let number = item.get("number").and_then(Value::as_i64);
                    Some(Video {
                        id: text(item.get("id")).unwrap_or_default(),
                        title: text(item.get("name")),
                        season,
                        episode: number,
                        number,
                        overview: text(item.get("overview")),
                        thumbnail: text(item.get("thumbnail")),
                        released: text(item.get("released")),
                        available: Some(true),
                        rating: text(item.get("rating")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();

    Some(MetaDetails {
        id: imdb.to_string(),
        media_type: match text(meta.get("type")).as_deref() {
            Some("series") => "series".into(),
            Some("movie") => "movie".into(),
            _ if is_tv(media_type) => "series".into(),
            _ => "movie".into(),
        },
        name: text(meta.get("name")).unwrap_or_else(|| imdb.to_string()),
        poster: text(meta.get("poster")),
        background: text(meta.get("background")),
        logo: text(meta.get("logo")),
        description: text(meta.get("description")),
        release_info: text(meta.get("releaseInfo")),
        year: text(meta.get("releaseInfo"))
            .filter(|s| s.len() >= 4)
            .map(|s| s[..4].to_string()),
        rating: text(meta.get("imdbRating")),
        genres: meta
            .get("genres")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|g| text(Some(g))).collect())
            .unwrap_or_default(),
        runtime: text(meta.get("runtime")),
        status: None,
        videos,
        cast: Vec::new(),
        director: Vec::new(),
        trailer: None,
        imdb_id: Some(imdb.to_string()),
        tmdb_id: None,
        source: "cinemeta".into(),
    })
}

/// The other side of the movie/series split, for when an id was labelled wrong.
fn other(media_type: &str) -> &'static str {
    if is_tv(media_type) {
        "movie"
    } else {
        "series"
    }
}

/// Best available record for an IMDb id, or `None` when nothing answers.
pub async fn details(
    client: &reqwest::Client,
    imdb: &str,
    media_type: &str,
) -> Option<MetaDetails> {
    let mut found = match balloon(client, imdb, media_type).await {
        Ok(details) => details,
        Err(_) => match cinemeta(client, imdb, media_type).await {
            Some(details) => details,
            // Synced rows sometimes carry the wrong kind; the id is what counts.
            None => cinemeta(client, imdb, other(media_type)).await?,
        },
    };
    if found.videos.is_empty() {
        if let Some(fallback) = cinemeta(client, imdb, media_type).await {
            found.poster = found.poster.or(fallback.poster);
            found.background = found.background.or(fallback.background);
            found.logo = found.logo.or(fallback.logo);
            if found.description.is_none() {
                found.description = fallback.description;
            }
            if found.rating.is_none() {
                found.rating = fallback.rating;
            }
            if found.runtime.is_none() {
                found.runtime = fallback.runtime;
            }
            found.videos = fallback.videos;
        }
    }
    Some(found)
}

/// Episode list only: used to repair series whose addon sent no videos.
pub async fn videos(client: &reqwest::Client, imdb: &str, media_type: &str) -> Vec<Video> {
    cinemeta(client, imdb, media_type)
        .await
        .map(|found| found.videos)
        .unwrap_or_default()
}

/// Fill the title and art that a synced progress title never carried.
/// Input is `(meta_id, media_type)`; output adds name, poster, backdrop.
pub async fn fill_missing(
    client: &reqwest::Client,
    rows: Vec<(String, String)>,
) -> Vec<(String, String, Option<String>, Option<String>)> {
    let mut filled = Vec::new();
    let mut failures = 0;
    for (meta_id, media_type) in rows {
        if !meta_id.starts_with("tt") {
            continue;
        }
        match details(client, &meta_id, &media_type).await {
            Some(found) => {
                failures = 0;
                filled.push((meta_id, found.name, found.poster, found.background));
            }
            None => {
                // Both sources down: stop hammering them and try again later.
                failures += 1;
                if failures >= 3 {
                    break;
                }
            }
        }
    }
    filled
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_year_and_rating_from_tmdb_shapes() {
        let value = json!({ "first_air_date": "2017-11-17", "vote_average": 8.09 });
        assert_eq!(year(&value).as_deref(), Some("2017"));
        assert_eq!(rating(&value).as_deref(), Some("8.1"));

        let missing = json!({ "vote_average": 0 });
        assert_eq!(year(&missing), None);
        assert_eq!(rating(&missing), None);
    }

    #[test]
    fn builds_image_urls_and_ignores_blanks() {
        let value = json!({ "poster_path": "/abc.jpg", "backdrop_path": "  " });
        assert_eq!(
            image(&value, "poster_path", "w500").as_deref(),
            Some("https://image.tmdb.org/t/p/w500/abc.jpg")
        );
        assert_eq!(image(&value, "backdrop_path", "w1280"), None);
    }

    #[test]
    fn treats_tv_as_series() {
        assert!(is_tv("series"));
        assert!(is_tv("tv"));
        assert!(!is_tv("movie"));
    }
}
