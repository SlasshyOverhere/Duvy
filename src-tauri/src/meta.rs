//! IMDb-keyed metadata for ids that arrive without a title.
//!
//! Nuvio Cloud only stores ids, so a progress row can land here as `tt1234567`
//! with no name and no artwork. Cinemeta answers: no key, one request, a whole
//! episode list, and cast and trailers in the same document. Every failure just
//! means "no data": callers keep what they have.

use crate::addons::Video;
use crate::models::{CastMember, MetaDetails};
use serde_json::Value;
use std::time::Duration;

const CINEMETA: &str = "https://v3-cinemeta.strem.io/meta";
/// A metadata document is text and artwork links; anything this size is not one.
const MAX_BODY: u64 = 8 * 1024 * 1024;
/// A series with more episodes than this is not a series anyone can browse.
const MAX_VIDEOS: usize = 5_000;

fn is_tv(media_type: &str) -> bool {
    media_type == "series" || media_type == "tv"
}

/// IMDb ids are `tt` plus digits. Anything else is untrusted text that must not
/// be pasted into an upstream path, where `..`, `/` or `?` would move the request.
pub(crate) fn imdb_id(value: &str) -> Option<&str> {
    let digits = value.strip_prefix("tt")?;
    (digits.len() <= 10 && !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()))
        .then_some(value)
}

fn text(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(clean)
}

/// Artwork is loaded by the webview, so only a plain https URL may pass.
fn https(value: Option<&Value>) -> Option<String> {
    text(value).filter(|url| url.starts_with("https://") && !url.contains(char::is_whitespace))
}

/// Cinemeta HTML-escapes names ("Emma D&apos;Arcy"), which then fails to match
/// anything else. Seven entities cover the whole catalogue.
pub(crate) fn clean(value: &str) -> String {
    value
        .replace("&apos;", "'")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
}

async fn json(client: &reqwest::Client, url: &str) -> Result<Value, String> {
    crate::note_request(url);
    let response = client
        .get(url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if response.content_length().is_some_and(|len| len > MAX_BODY) {
        return Err("the response was too large".into());
    }
    let bytes = response.bytes().await.map_err(|e| e.to_string())?;
    if bytes.len() as u64 > MAX_BODY {
        return Err("the response was too large".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| e.to_string())
}

/// Three outcomes: a record, an id the source does not know, and a source that
/// could not answer. Only the last one may count against the source.
enum Lookup {
    Found(MetaDetails),
    Missing,
    Failed,
}

fn videos_of(meta: &Value) -> Vec<Video> {
    meta.get("videos")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .take(MAX_VIDEOS)
                .filter_map(|item| {
                    // Without an id a video row cannot be played or resolved.
                    let id = text(item.get("id"))?;
                    let season = item.get("season").and_then(Value::as_i64);
                    let number = item.get("number").and_then(Value::as_i64);
                    Some(Video {
                        id,
                        title: text(item.get("name")),
                        season,
                        episode: number,
                        number,
                        overview: text(item.get("overview")),
                        thumbnail: https(item.get("thumbnail")),
                        released: text(item.get("released")),
                        rating: text(item.get("rating")),
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Cinemeta carries every episode in one document, so it owns the video list.
async fn cinemeta(client: &reqwest::Client, imdb: &str, media_type: &str) -> Lookup {
    let Some(imdb) = imdb_id(imdb) else {
        return Lookup::Missing;
    };
    let kind = if is_tv(media_type) { "series" } else { "movie" };
    let value = match json(client, &format!("{CINEMETA}/{kind}/{imdb}.json")).await {
        Ok(value) => value,
        Err(_) => return Lookup::Failed,
    };
    let Some(meta) = value.get("meta").filter(|meta| !meta.is_null()) else {
        return Lookup::Missing;
    };

    let videos = videos_of(meta);

    // Cinemeta names the cast and crew but carries no headshots or roles.
    let cast: Vec<CastMember> = meta
        .get("cast")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|person| {
                    Some(CastMember {
                        name: text(Some(person))?,
                        character: String::new(),
                        photo: None,
                        person_id: None,
                    })
                })
                .take(14)
                .collect()
        })
        .unwrap_or_default();

    let director: Vec<String> = meta
        .get("director")
        .and_then(Value::as_array)
        .map(|list| list.iter().filter_map(|name| text(Some(name))).collect())
        .unwrap_or_default();

    // Cinemeta calls these lists `writer` and `country`; both are plain names,
    // and `country` arrives as one string for series and an array for films.
    let names = |field: &str| -> Vec<String> {
        meta.get(field)
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|name| text(Some(name))).collect())
            .unwrap_or_default()
    };
    let writer = names("writer");
    let country = match meta.get("country") {
        Some(Value::Array(_)) => names("country"),
        Some(Value::String(_)) => text(meta.get("country")).into_iter().collect(),
        _ => Vec::new(),
    };

    let trailer = meta
        .get("trailers")
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find(|t| text(t.get("type")).as_deref() == Some("Trailer"))
                .or_else(|| list.first())
        })
        .and_then(|t| text(t.get("source")))
        .map(|id| format!("https://www.youtube.com/watch?v={id}"));

    Lookup::Found(MetaDetails {
        id: imdb.to_string(),
        media_type: match text(meta.get("type")).as_deref() {
            Some("series") => "series".into(),
            Some("movie") => "movie".into(),
            _ if is_tv(media_type) => "series".into(),
            _ => "movie".into(),
        },
        name: text(meta.get("name")).unwrap_or_else(|| imdb.to_string()),
        poster: https(meta.get("poster")),
        background: https(meta.get("background")),
        logo: https(meta.get("logo")),
        description: text(meta.get("description")),
        release_info: text(meta.get("releaseInfo")),
        year: text(meta.get("releaseInfo")).and_then(|info| {
            let year = info.get(0..4)?;
            year.bytes()
                .all(|b| b.is_ascii_digit())
                .then(|| year.to_string())
        }),
        rating: text(meta.get("imdbRating")),
        genres: meta
            .get("genres")
            .and_then(Value::as_array)
            .map(|list| list.iter().filter_map(|g| text(Some(g))).collect())
            .unwrap_or_default(),
        runtime: text(meta.get("runtime")),
        status: None,
        videos,
        cast,
        director,
        writer,
        composer: Vec::new(),
        country,
        trailer,
        trailers: vec![],
        seasons: vec![],
        networks: vec![],
        companies: vec![],
        collection_name: None,
        collection_items: vec![],
        certification: None,
        origin_country: vec![],
        original_language: None,
        imdb_id: Some(imdb.to_string()),
        tmdb_id: None,
        source: "cinemeta".into(),
    })
}

/// The other side of the movie/series split, for when an id was labelled wrong.
fn other(media_type: &str) -> &'static str {
    if is_tv(media_type) { "movie" } else { "series" }
}

/// Best available record, or the reason there is none: `Ok(None)` is an id the
/// source does not know, `Err` is a source that could not answer.
async fn lookup(
    client: &reqwest::Client,
    imdb: &str,
    media_type: &str,
) -> Result<Option<MetaDetails>, ()> {
    let cap = std::time::Duration::from_secs(3);
    let mut failed = false;
    // Synced rows sometimes carry the wrong kind; the id is what counts.
    for kind in [media_type, other(media_type)] {
        match tokio::time::timeout(cap, cinemeta(client, imdb, kind)).await {
            Ok(Lookup::Found(found)) => return Ok(Some(found)),
            Ok(Lookup::Missing) => {}
            Ok(Lookup::Failed) | Err(_) => failed = true,
        }
    }
    if failed { Err(()) } else { Ok(None) }
}

/// Best available record for an IMDb id, or `None` when nothing answers.
///
/// Cinemeta is the only source here: no key, one request, and the whole episode
/// list comes back with it. Callers fall back to TMDB when a key is set.
pub async fn details(
    client: &reqwest::Client,
    imdb: &str,
    media_type: &str,
) -> Option<MetaDetails> {
    lookup(client, imdb, media_type).await.ok().flatten()
}

/// Episode list only: used to repair series whose addon sent no videos.
pub async fn videos(client: &reqwest::Client, imdb: &str, media_type: &str) -> Vec<Video> {
    match cinemeta(client, imdb, media_type).await {
        Lookup::Found(found) => found.videos,
        _ => Vec::new(),
    }
}

const IMDB_SUGGEST: &str = "https://v2.sg.media-imdb.com/suggestion/x";

/// Lowercase, letters and digits only: IMDb labels and our names have to meet
/// on the same ground before a face is allowed to stand in for a person.
fn bare(value: &str) -> String {
    value
        .chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Headshot for a cast name, or `None` when the match is not certain.
///
/// Keyless: IMDb's own suggestion endpoint. A face is only accepted on an exact
/// full-name hit, and the person whose "known for" line names this title wins -
/// that is what tells four Michael Johnstons apart.
pub async fn headshot(client: &reqwest::Client, name: &str, title: &str) -> Option<String> {
    let value = json(
        client,
        &format!("{IMDB_SUGGEST}/{}.json", crate::tmdb::escape(name)),
    )
    .await
    .ok()?;
    let wanted = bare(name);
    let known = bare(title);
    let matches: Vec<&Value> = value
        .get("d")
        .and_then(Value::as_array)?
        .iter()
        .filter(|entry| {
            text(entry.get("id")).is_some_and(|id| id.starts_with("nm"))
                && text(entry.get("l")).is_some_and(|label| bare(&label) == wanted)
                && entry.pointer("/i/imageUrl").is_some()
        })
        .collect();
    let pick = matches
        .iter()
        .find(|entry| {
            !known.is_empty()
                && text(entry.get("s")).is_some_and(|line| bare(&line).contains(&known))
        })
        .or_else(|| matches.first())?;
    https(pick.pointer("/i/imageUrl"))
}

/// Fill the title and art that a synced progress title never carried.
/// Input is `(meta_id, media_type)`; output adds name, poster, backdrop.
///
/// A fresh account can miss hundreds of rows, so the lookups run a few at a
/// time instead of one after another: the same work in a fraction of the wait.
type Filled = (usize, String, String, Option<String>, Option<String>);

pub async fn fill_missing(
    client: &reqwest::Client,
    rows: Vec<(String, String)>,
) -> Vec<(String, String, Option<String>, Option<String>)> {
    // Six in flight keeps the burst polite; slots restore the input order.
    const IN_FLIGHT: usize = 6;
    let mut pending = rows
        .into_iter()
        .filter(|(meta_id, _)| meta_id.starts_with("tt"))
        .enumerate();
    let mut set = tokio::task::JoinSet::new();
    let mut filled: Vec<Filled> = Vec::new();
    let mut failures = 0;
    loop {
        while set.len() < IN_FLIGHT && failures < 3 {
            let Some((index, (meta_id, media_type))) = pending.next() else {
                break;
            };
            let client = client.clone();
            set.spawn(async move {
                let found = lookup(&client, &meta_id, &media_type).await;
                (index, meta_id, found)
            });
        }
        let Some(joined) = set.join_next().await else {
            break;
        };
        match joined {
            Ok((index, meta_id, Ok(Some(found)))) => {
                failures = 0;
                filled.push((index, meta_id, found.name, found.poster, found.background));
            }
            // An id the source does not know is an answer, not an outage.
            Ok((_, _, Ok(None))) => failures = 0,
            // Both sources down: stop hammering them and try again later.
            _ => failures += 1,
        }
    }
    filled.sort_by_key(|(index, ..)| *index);
    filled
        .into_iter()
        .map(|(_, meta_id, name, poster, background)| (meta_id, name, poster, background))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn treats_tv_as_series() {
        assert!(is_tv("series"));
        assert!(is_tv("tv"));
        assert!(!is_tv("movie"));
    }

    #[test]
    fn names_are_compared_without_case_or_punctuation() {
        assert_eq!(bare("Michael Johnston"), bare("michael  johnston"));
        assert_eq!(bare("Jean-Luc Picard"), "jeanlucpicard");
        // A near miss must stay a miss: a wrong face is worse than none.
        assert_ne!(bare("Michael Johnston"), bare("Michael Johnstone"));
    }

    #[test]
    fn artwork_must_be_a_plain_https_url() {
        assert_eq!(
            https(Some(&json!("https://images.example/p.jpg"))),
            Some("https://images.example/p.jpg".into())
        );
        for refused in [
            json!("http://images.example/p.jpg"),
            json!("file:///C:/secret.png"),
            json!("javascript:alert(1)"),
            json!("https://images.example/a b.jpg"),
            json!(""),
            json!(42),
        ] {
            assert_eq!(https(Some(&refused)), None, "{refused} is not artwork");
        }
    }

    #[test]
    fn videos_without_an_id_are_dropped() {
        let meta = json!({
            "videos": [
                { "id": "tt1:1:1", "season": 1, "number": 1 },
                { "season": 1, "number": 2 },
                { "id": "  " },
            ]
        });
        let videos = videos_of(&meta);
        assert_eq!(videos.len(), 1);
        assert_eq!(videos[0].id, "tt1:1:1");
        assert_eq!(videos[0].episode, Some(1));
    }

    #[test]
    fn only_imdb_ids_reach_an_upstream_path() {
        assert_eq!(imdb_id("tt1234567"), Some("tt1234567"));
        for refused in [
            "tt",
            "kitsu:5",
            "tt123/../config",
            "tt123?x=1",
            "tt123#frag",
            "TT123",
            "tt12a45",
            "tt12345678901",
        ] {
            assert_eq!(imdb_id(refused), None, "{refused} is not an id");
        }
    }
}
