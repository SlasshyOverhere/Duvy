//! Per-show intro and outro markers.
//!
//! One JSON object under the `skip` key maps a meta id to its markers. The
//! intro belongs to the show rather than the episode, so a single entry covers
//! every episode under that id.

use crate::db;
use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use tauri::State;

const KEY: &str = "skip";

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
        if end - start > 2.0 && position >= start - 0.5 && position <= end - 2.0 {
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
    let conn = state.db.0.lock().map_err(|_| "database is locked")?;
    let mut store = load(&conn);
    let stored = store.get(&meta_id).cloned().unwrap_or_default();
    let merged = SkipEntry {
        intro_start: entry.intro_start.or(stored.intro_start),
        intro_end: entry.intro_end.or(stored.intro_end),
        outro_start: entry.outro_start.or(stored.outro_start),
    };

    if merged.is_empty() {
        store.remove(&meta_id);
        save(&conn, &store)?;
        return Ok(None);
    }

    store.insert(meta_id, merged.clone());
    save(&conn, &store)?;
    Ok(Some(merged))
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
