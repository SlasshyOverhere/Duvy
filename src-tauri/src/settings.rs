//! Configuration model and persistence helpers.

use crate::db;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Explicit path to an mpv executable. If empty, the player is auto-detected.
    pub mpv_path: String,
    /// TMDB v3 API key. Optional: without it discovery falls back to addon catalogs.
    pub tmdb_api_key: String,
    /// Accent theme id, see the frontend theme table.
    pub accent: String,
    /// "auto" | "4k" | "1080p" | "720p"
    pub preferred_quality: String,
    pub auto_play_next: bool,
    pub auto_resume: bool,
    pub subtitle_language: String,
    pub audio_language: String,
    pub hardware_decoding: bool,
    pub seek_step: i64,
    pub reduce_motion: bool,
    /// How many addon catalogs to place on the home screen.
    pub home_rows_limit: i64,
    /// Remember playback position and surface a Continue Watching row.
    pub track_progress: bool,
    /// Open playback in a dedicated mpv window (the only renderer in v0.1).
    pub player_window: String,
    /// Sync library, progress and watched items with the Nuvio account.
    pub nuvio_auto_sync: bool,
    /// Sync addons, library and progress with the Stremio account.
    pub stremio_auto_sync: bool,
    /// Override for the Nuvio backend. Empty means the official endpoint.
    pub nuvio_base_url: String,
    /// Override for the Nuvio publishable key. Empty means the bundled one.
    pub nuvio_api_key: String,
    /// User consent to peer-to-peer streaming (off until explicitly accepted).
    pub p2p_consent: bool,
    /// Upper bound for the torrent cache, in megabytes.
    pub p2p_cache_mb: i64,
    /// How much to cache ahead of the playhead. Unit is "sec", "min", "mb" or "gb".
    pub buffer_forward_value: i64,
    pub buffer_forward_unit: String,
    /// How much past data to keep for seeking back. Same units as the forward buffer.
    pub buffer_backward_value: i64,
    pub buffer_backward_unit: String,
    /// Send watched events to Trakt while playing.
    pub trakt_scrobble: bool,
    /// Look for a new release on launch and every few hours.
    pub auto_update_check: bool,
    /// A version the user skipped; background checks stay quiet about it.
    pub ignored_update_version: String,
    /// The bundled metadata addons have been installed once already.
    pub defaults_seeded: bool,
    /// First-run setup has been completed or skipped.
    pub onboarded: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            mpv_path: String::new(),
            tmdb_api_key: String::new(),
            accent: "ember".into(),
            preferred_quality: "auto".into(),
            auto_play_next: true,
            auto_resume: true,
            subtitle_language: "eng".into(),
            audio_language: "eng".into(),
            hardware_decoding: true,
            seek_step: 10,
            reduce_motion: false,
            home_rows_limit: 8,
            track_progress: true,
            player_window: "mpv".into(),
            nuvio_auto_sync: true,
            stremio_auto_sync: true,
            nuvio_base_url: String::new(),
            nuvio_api_key: String::new(),
            p2p_consent: false,
            p2p_cache_mb: 2048,
            buffer_forward_value: 256,
            buffer_forward_unit: "mb".into(),
            buffer_backward_value: 75,
            buffer_backward_unit: "mb".into(),
            trakt_scrobble: true,
            auto_update_check: true,
            ignored_update_version: String::new(),
            defaults_seeded: false,
            onboarded: false,
        }
    }
}

impl Settings {
    pub fn load(conn: &Connection) -> Self {
        let stored = db::read_settings(conn).unwrap_or(Value::Null);
        let mut settings = Settings::default();
        // An install that ran before onboarding existed is already past it.
        let known = stored.get("onboarded").is_some();
        if stored.is_object() {
            if let Ok(merged) = serde_json::from_value::<Settings>(merge(
                serde_json::to_value(&settings).unwrap_or(Value::Null),
                stored,
            )) {
                settings = merged;
            }
        }
        if !known && settings.defaults_seeded {
            settings.onboarded = true;
        }
        settings
    }

    pub fn save(&self, conn: &Connection) -> Result<(), String> {
        let value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        db::write_settings(conn, &value).map_err(|e| e.to_string())
    }

    pub fn apply_patch(&mut self, patch: Value) -> Result<(), String> {
        let merged = merge(serde_json::to_value(&self).map_err(|e| e.to_string())?, patch);
        *self = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// Shallow merge where a `null` patch value means "reset to default".
fn merge(mut base: Value, patch: Value) -> Value {
    if let (Some(base_obj), Value::Object(patch_obj)) = (base.as_object_mut(), &patch) {
        for (key, value) in patch_obj {
            if value.is_null() {
                base_obj.remove(key);
            } else {
                base_obj.insert(key.clone(), value.clone());
            }
        }
    }
    base
}
