//! Configuration model and persistence helpers.

use crate::AppState;
use crate::db;
use crate::secret::SecretError;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Optional TMDB v3 API key. Overrides the bundled proxy when set.
    pub tmdb_api_key: String,
    /// Accent theme id, see the frontend theme table.
    pub accent: String,
    /// "auto" | "4k" | "1080p" | "720p"
    pub preferred_quality: String,
    /// Source list order: "size" (biggest file first) or "addon".
    pub source_sort: String,
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
    /// Crash reporting: on unless the telemetry switch is turned off.
    pub telemetry: Option<bool>,
    /// Anonymous usage counts: on from the first run, and only off if turned off.
    pub analytics: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            tmdb_api_key: String::new(),
            accent: "ember".into(),
            preferred_quality: "auto".into(),
            source_sort: "size".into(),
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
            buffer_forward_value: 256,
            buffer_forward_unit: "mb".into(),
            buffer_backward_value: 75,
            buffer_backward_unit: "mb".into(),
            trakt_scrobble: true,
            auto_update_check: true,
            ignored_update_version: String::new(),
            defaults_seeded: false,
            onboarded: false,
            telemetry: Some(true),
            analytics: true,
        }
    }
}

impl Settings {
    /// Settings, or an error when the row exists but cannot be read.
    pub fn try_load(conn: &Connection) -> Result<Self, SecretError> {
        let stored = db::read_settings(conn)?;
        if let Some(value) = stored.as_ref()
            && !value.is_object()
        {
            return Err(SecretError::Decode(
                "the stored settings are not an object".into(),
            ));
        }
        // An install that ran before onboarding existed is already past it.
        let known = stored
            .as_ref()
            .is_some_and(|value| value.get("onboarded").is_some());
        let mut settings = match stored {
            Some(value) => from_stored(value),
            None => Settings::default(),
        };
        if !known && settings.defaults_seeded {
            settings.onboarded = true;
        }
        settings.sanitize();
        Ok(settings)
    }

    /// Defaults on an unreadable row: the app still starts, and `save` refuses
    /// to write them back over the row that could not be read.
    pub fn load(conn: &Connection) -> Self {
        Self::try_load(conn).unwrap_or_else(|error| {
            eprintln!("settings: cannot read the stored settings: {error}");
            Self::default()
        })
    }

    /// Stored values can come from an older build or a hand-edited row, and a
    /// patch can carry anything. Clamp here so nothing downstream has to.
    fn sanitize(&mut self) {
        if self.source_sort != "size" && self.source_sort != "addon" {
            self.source_sort = "size".into();
        }
        self.seek_step = self.seek_step.clamp(1, 600);
        self.home_rows_limit = self.home_rows_limit.clamp(1, 24);
        // Megabyte maths in the player multiplies these by up to 1024.
        self.buffer_forward_value = self.buffer_forward_value.clamp(1, 65_536);
        self.buffer_backward_value = self.buffer_backward_value.clamp(1, 65_536);
    }

    pub fn save(&self, conn: &Connection) -> Result<(), String> {
        // Never replace a row we could not read with the defaults we fell back to.
        if let Err(error) = db::read_settings(conn) {
            return Err(format!(
                "settings were not saved: the stored settings could not be read ({error})"
            ));
        }
        let value = serde_json::to_value(self).map_err(|e| e.to_string())?;
        db::write_settings(conn, &value).map_err(|e| e.to_string())
    }

    pub fn apply_patch(&mut self, patch: Value) -> Result<(), String> {
        let merged = merge(
            serde_json::to_value(&self).map_err(|e| e.to_string())?,
            patch,
        );
        *self = serde_json::from_value(merged).map_err(|e| e.to_string())?;
        self.sanitize();
        Ok(())
    }
}

/// Hot callers: one DB read plus a DPAPI decrypt is too much per tick.
pub fn load_cached(state: &AppState) -> Settings {
    {
        let cache = state
            .settings
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(settings) = cache.as_ref() {
            return settings.clone();
        }
    }
    let loaded = {
        let conn = state.db.conn();
        Settings::load(&conn)
    };
    *state
        .settings
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = Some(loaded.clone());
    loaded
}

/// Call after any write to the settings row.
pub fn invalidate(state: &AppState) {
    *state
        .settings
        .write()
        .unwrap_or_else(|poisoned| poisoned.into_inner()) = None;
}

/// One bad field keeps its default instead of resetting the whole object.
fn from_stored(stored: Value) -> Settings {
    let base = serde_json::to_value(Settings::default()).unwrap_or(Value::Null);
    let mut accepted = Value::Object(Default::default());
    for (key, value) in stored.as_object().into_iter().flatten() {
        let mut probe = base.clone();
        if let Some(object) = probe.as_object_mut() {
            object.insert(key.clone(), value.clone());
        }
        match serde_json::from_value::<Settings>(probe) {
            Ok(_) => {
                if let Some(object) = accepted.as_object_mut() {
                    object.insert(key.clone(), value.clone());
                }
            }
            Err(error) => eprintln!("settings: ignoring the stored {key}: {error}"),
        }
    }
    serde_json::from_value(merge(base, accepted)).unwrap_or_default()
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
