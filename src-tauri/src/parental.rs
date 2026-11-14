//! IMDb parents guide: the content-warning card the player shows on start.
//!
//! IMDb's public GraphQL answers keylessly, but only to a browser-shaped
//! request: without an origin and referer it replies 403. Any failure means an
//! empty list, and the card simply does not appear.

use crate::models::ParentalWarning;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const GRAPHQL: &str = "https://api.graphql.imdb.com/";
const CACHE_LIMIT: usize = 400;

static CACHE: OnceLock<Mutex<HashMap<String, Vec<ParentalWarning>>>> = OnceLock::new();

fn cache() -> &'static Mutex<HashMap<String, Vec<ParentalWarning>>> {
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The five categories the card shows, in IMDb's own ids.
fn category(id: &str) -> Option<&'static str> {
    Some(match id {
        "NUDITY" => "nudity",
        "VIOLENCE" => "violence",
        "PROFANITY" => "profanity",
        "ALCOHOL" => "alcohol",
        "FRIGHTENING" => "frightening",
        _ => return None,
    })
}

/// Severe first: the worst thing in the title is what the card leads with.
fn rank(severity: &str) -> usize {
    match severity.to_ascii_lowercase().as_str() {
        "severe" => 0,
        "moderate" => 1,
        _ => 2,
    }
}

fn parse(value: &Value) -> Vec<ParentalWarning> {
    let mut warnings: Vec<ParentalWarning> = value
        .pointer("/data/title/parentsGuide/categories")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|entry| {
                    let id = entry.pointer("/category/id").and_then(Value::as_str)?;
                    let severity = entry.pointer("/severity/text").and_then(Value::as_str)?;
                    // "None" is a category IMDb found nothing in, not a warning.
                    if severity.eq_ignore_ascii_case("none") {
                        return None;
                    }
                    Some(ParentalWarning {
                        category: category(id)?.to_string(),
                        severity: severity.to_ascii_lowercase(),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    warnings.sort_by_key(|warning| rank(&warning.severity));
    warnings
}

/// `tt` plus its digits, from a bare id or one wrapped in a longer meta id.
pub fn imdb_id(value: &str) -> Option<&str> {
    let start = value.find("tt")?;
    let digits = value[start + 2..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    (digits > 0).then(|| &value[start..start + 2 + digits])
}

pub async fn guide(client: &reqwest::Client, meta_id: &str) -> Vec<ParentalWarning> {
    let Some(imdb) = imdb_id(meta_id) else {
        return Vec::new();
    };
    if let Some(hit) = cache().lock().ok().and_then(|c| c.get(imdb).cloned()) {
        return hit;
    }
    let body = json!({
        "query": "query($id: ID!) { title(id: $id) { parentsGuide { categories { category { id } severity { text } } } } }",
        "variables": { "id": imdb },
    });
    let reply = client
        .post(GRAPHQL)
        .timeout(Duration::from_secs(8))
        .header("origin", "https://www.imdb.com")
        .header("referer", "https://www.imdb.com/")
        .json(&body)
        .send()
        .await;
    // A failure is not cached: the next episode may get through.
    let Ok(response) = reply else {
        return Vec::new();
    };
    if !response.status().is_success() {
        return Vec::new();
    }
    let warnings = response
        .json::<Value>()
        .await
        .map(|value| parse(&value))
        .unwrap_or_default();
    if let Ok(mut entries) = cache().lock() {
        if entries.len() >= CACHE_LIMIT {
            entries.clear();
        }
        entries.insert(imdb.to_string(), warnings.clone());
    }
    warnings
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_known_categories_and_drops_none() {
        let value = json!({ "data": { "title": { "parentsGuide": { "categories": [
            { "category": { "id": "NUDITY" }, "severity": { "text": "Mild" } },
            { "category": { "id": "VIOLENCE" }, "severity": { "text": "None" } },
            { "category": { "id": "PROFANITY" }, "severity": { "text": "Severe" } },
            { "category": { "id": "SPOILERS" }, "severity": { "text": "Mild" } }
        ] } } } });
        let warnings = parse(&value);
        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[0].category, "profanity");
        assert_eq!(warnings[1].severity, "mild");
    }

    #[test]
    fn missing_guide_is_empty() {
        let none = json!({ "data": { "title": { "parentsGuide": { "categories": null } } } });
        assert!(parse(&none).is_empty());
        assert!(parse(&json!({})).is_empty());
    }

    #[test]
    fn finds_the_imdb_id_inside_a_meta_id() {
        assert_eq!(imdb_id("tt0944947"), Some("tt0944947"));
        assert_eq!(imdb_id("tt0944947:1:3"), Some("tt0944947"));
        assert_eq!(imdb_id("series:tt0111161"), Some("tt0111161"));
        assert_eq!(imdb_id("tmdb:movie:12345"), None);
        assert_eq!(imdb_id("tt"), None);
    }
}
