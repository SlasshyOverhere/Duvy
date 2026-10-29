//! Per-episode intro and outro markers.
//!
//! One JSON object under the `skip` key maps a session key (`id:season:episode`)
//! to its markers. Markers the viewer sets by hand win; when there are none,
//! `skip_lookup` asks IntroDB for the community timestamps, the same source
//! Nuvio uses.

use crate::db;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::time::Duration;
use tauri::State;

const KEY: &str = "skip";
const INTRODB: &str = "https://api.introdb.app/segments";

#[derive(Serialize, Deserialize, Clone, Debug, Default, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct SkipEntry {
    pub intro_start: Option<f64>,
    pub intro_end: Option<f64>,
    pub outro_start: Option<f64>,
}

impl SkipEntry {
    fn is_empty(&self) -> bool {
        self.intro_start.is_none() && self.intro_end.is_none() && self.outro_start.is_none()
    }
}

type Store = BTreeMap<String, SkipEntry>;

fn load(conn: &rusqlite::Connection) -> Store {
    db::read_kv(conn, KEY)
        .ok()
        .flatten()
        .and_then(|value| serde_json::from_value(value).ok())
        .unwrap_or_default()
}

fn save(conn: &rusqlite::Connection, store: &Store) -> Result<(), String> {
    let value = serde_json::to_value(store).map_err(|e| e.to_string())?;
    db::write_kv(conn, KEY, &value).map_err(|e| e.to_string())
}

/// The segment to skip and the timestamp to seek to.
///
/// The intro fires from half a second before its start until two seconds
/// before its end, and lands on that end. The outro fires from half a second
/// before its start until two seconds before the file ends, and lands on the
/// end of the file. The padding keeps a seek from landing back on the marker.
pub fn apply(entry: &SkipEntry, position: f64, duration: f64) -> Option<(String, f64)> {
    if !duration.is_finite() || duration <= 0.0 || !position.is_finite() {
        return None;
    }

    if let (Some(start), Some(end)) = (entry.intro_start, entry.intro_end) {
        let end = end.min(duration);
        // A stale marker near the end of the file would skip to the credits.
        if end < duration - 2.0
            && end - start > 2.0
            && position >= start - 0.5
            && position <= end - 2.0
        {
            return Some(("intro".to_string(), end));
        }
    }

    if let Some(start) = entry.outro_start {
        if start > 0.0
            && start < duration - 2.0
            && position >= start - 0.5
            && position <= duration - 2.0
        {
            return Some(("outro".to_string(), duration));
        }
    }

    None
}

#[tauri::command]
pub fn skip_get(meta_id: String, state: State<'_, AppState>) -> Result<Option<SkipEntry>, String> {
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    Ok(load(&conn).get(&meta_id).cloned())
}

#[tauri::command]
pub fn skip_set(
    meta_id: String,
    entry: SkipEntry,
    state: State<'_, AppState>,
) -> Result<Option<SkipEntry>, String> {
    if meta_id.trim().is_empty() {
        return Err("missing meta id".into());
    }
    validate(&entry)?;
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let mut store = load(&conn);

    if entry.is_empty() {
        store.remove(&meta_id);
        save(&conn, &store)?;
        return Ok(None);
    }

    store.insert(meta_id, entry.clone());
    save(&conn, &store)?;
    Ok(Some(entry))
}

/// Community markers from IntroDB for one episode, or none when it has no entry.
#[tauri::command]
pub async fn skip_lookup(
    imdb_id: String,
    season: Option<u32>,
    episode: Option<u32>,
    state: State<'_, AppState>,
) -> Result<Option<SkipEntry>, String> {
    if !imdb_id.starts_with("tt") || !imdb_id[2..].bytes().all(|b| b.is_ascii_digit()) {
        return Ok(None);
    }
    let mut url = format!("{INTRODB}?imdb_id={imdb_id}");
    match (season, episode) {
        (Some(season), Some(episode)) => url.push_str(&format!("&season={season}&episode={episode}")),
        _ => url.push_str("&is_movie=true"),
    }
    let response = state
        .http
        .get(url)
        .timeout(Duration::from_secs(6))
        .send()
        .await
        .map_err(|e| format!("intro lookup failed: {e}"))?;
    // A missing entry is the normal case, not an error.
    if !response.status().is_success() {
        return Ok(None);
    }
    let value = response
        .json::<serde_json::Value>()
        .await
        .map_err(|e| format!("intro lookup was not JSON: {e}"))?;
    let entry = from_segments(&value);
    Ok((!entry.is_empty()).then_some(entry))
}

fn from_segments(value: &serde_json::Value) -> SkipEntry {
    let seg = |key: &str| -> Option<(f64, f64)> {
        let seg = value.get(key)?;
        Some((seg.get("start_sec")?.as_f64()?, seg.get("end_sec")?.as_f64()?))
    };
    let mut entry = SkipEntry::default();
    if let Some((start, end)) = seg("intro") {
        entry.intro_start = Some(start);
        entry.intro_end = Some(end);
    }
    // Only the outro's start is needed; the skip lands on the end of the file.
    if let Some((start, _)) = seg("outro") {
        entry.outro_start = Some(start);
    }
    entry
}

fn validate(entry: &SkipEntry) -> Result<(), String> {
    for value in [entry.intro_start, entry.intro_end, entry.outro_start]
        .into_iter()
        .flatten()
    {
        if !value.is_finite() || value < 0.0 {
            return Err("skip markers must be finite and non-negative".into());
        }
    }
    if let (Some(start), Some(end)) = (entry.intro_start, entry.intro_end) {
        if end <= start {
            return Err("the intro must end after it starts".into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(intro: (f64, f64), outro: Option<f64>) -> SkipEntry {
        SkipEntry {
            intro_start: Some(intro.0),
            intro_end: Some(intro.1),
            outro_start: outro,
        }
    }

    #[test]
    fn invalid_markers_are_rejected() {
        assert!(validate(&entry((10.0, 70.0), None)).is_ok());
        assert!(validate(&SkipEntry {
            intro_start: Some(-1.0),
            ..SkipEntry::default()
        })
        .is_err());
        assert!(validate(&entry((f64::NAN, 70.0), None)).is_err());
        assert!(validate(&entry((70.0, 70.0), None)).is_err());
    }

    #[test]
    fn intro_fires_on_open_and_lands_on_its_end() {
        assert_eq!(
            apply(&entry((10.0, 70.0), None), 10.4, 1440.0),
            Some(("intro".to_string(), 70.0))
        );
    }

    #[test]
    fn intro_stops_firing_once_the_window_closes() {
        let skip = entry((10.0, 70.0), None);
        assert_eq!(apply(&skip, 9.0, 1440.0), None);
        assert_eq!(apply(&skip, 68.1, 1440.0), None);
    }

    #[test]
    fn outro_lands_on_the_end_of_the_file() {
        let skip = entry((10.0, 70.0), Some(1350.0));
        assert_eq!(
            apply(&skip, 1350.0, 1440.0),
            Some(("outro".to_string(), 1440.0))
        );
        assert_eq!(apply(&skip, 1439.0, 1440.0), None);
    }

    #[test]
    fn an_intro_past_the_end_of_the_file_does_nothing() {
        // Community markers are not validated against the real runtime.
        assert_eq!(apply(&entry((10.0, 70.0), None), 12.0, 60.0), None);
    }

    #[test]
    fn segments_map_to_markers() {
        let value = serde_json::json!({
            "intro": { "start_sec": 2.5, "end_sec": 58 },
            "recap": null,
            "outro": { "start_sec": 2600, "end_sec": 2650 },
        });
        assert_eq!(
            from_segments(&value),
            entry((2.5, 58.0), Some(2600.0))
        );
        assert!(from_segments(&serde_json::json!({ "intro": null })).is_empty());
    }

    #[test]
    fn partial_and_empty_markers_do_nothing() {
        assert_eq!(apply(&SkipEntry::default(), 30.0, 900.0), None);
        let half = SkipEntry {
            intro_start: Some(5.0),
            ..SkipEntry::default()
        };
        assert_eq!(apply(&half, 6.0, 900.0), None);
        let short = SkipEntry {
            intro_start: Some(5.0),
            intro_end: Some(6.0),
            ..SkipEntry::default()
        };
        assert_eq!(apply(&short, 5.0, 900.0), None);
    }
}
