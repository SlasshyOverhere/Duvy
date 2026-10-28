//! Local SQLite store: addons, library, watch progress and settings.
//!
//! The store is deliberately small and synchronous. Every query here touches a
//! few hundred rows at most, so a single WAL-mode connection behind a mutex is
//! both simpler and faster than a pool.

use crate::secret;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Db(pub Mutex<Connection>);

/// Share of a title's duration after which it counts as finished.
pub const FINISHED_AT: f64 = 0.9;

const PRAGMAS: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA cache_size = -16000;
PRAGMA mmap_size = 134217728;
PRAGMA temp_store = MEMORY;
"#;

// IF NOT EXISTS throughout: databases written before versioning existed already
// hold these tables and must only be stamped as version 1, not rebuilt.
const V1: &str = r#"
CREATE TABLE IF NOT EXISTS addons (
  url          TEXT PRIMARY KEY,
  addon_id     TEXT NOT NULL,
  name         TEXT NOT NULL,
  manifest     TEXT NOT NULL,
  enabled      INTEGER NOT NULL DEFAULT 1,
  position     INTEGER NOT NULL DEFAULT 0,
  installed_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS library (
  id         TEXT PRIMARY KEY,
  media_type TEXT NOT NULL,
  name       TEXT NOT NULL,
  poster     TEXT,
  background TEXT,
  added_at   INTEGER NOT NULL,
  meta       TEXT
);

CREATE TABLE IF NOT EXISTS progress (
  key           TEXT PRIMARY KEY,
  meta_id       TEXT NOT NULL,
  media_type    TEXT NOT NULL,
  name          TEXT NOT NULL,
  poster        TEXT,
  background    TEXT,
  season        INTEGER,
  episode       INTEGER,
  episode_title TEXT,
  position      REAL NOT NULL DEFAULT 0,
  duration      REAL NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS watched (
  key        TEXT PRIMARY KEY,
  meta_id    TEXT NOT NULL,
  watched    INTEGER NOT NULL DEFAULT 1,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS people (
  key        TEXT PRIMARY KEY,
  photo      TEXT NOT NULL,
  checked_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_progress_meta ON progress(meta_id);
CREATE INDEX IF NOT EXISTS idx_progress_updated ON progress(updated_at);
CREATE INDEX IF NOT EXISTS idx_watched_meta ON watched(meta_id);
CREATE INDEX IF NOT EXISTS idx_library_added ON library(added_at);
"#;

const V2: &str = r#"
CREATE INDEX IF NOT EXISTS idx_progress_meta_updated ON progress(meta_id, updated_at DESC);
"#;

const MIGRATIONS: &[&str] = &[V1, V2];

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(PRAGMAS)?;
    migrate(&conn)?;
    encrypt_legacy_settings(&conn)?;
    prune_progress(&conn)?;
    Ok(conn)
}

/// Playheads older than a year are noise; watched history is the user's, kept.
fn prune_progress(conn: &Connection) -> rusqlite::Result<()> {
    const YEAR_MS: i64 = 365 * 24 * 60 * 60 * 1000;
    conn.execute(
        "DELETE FROM progress WHERE updated_at < ?1",
        params![now() - YEAR_MS],
    )?;
    Ok(())
}

/// Rows written before DPAPI protection existed are plaintext. Upgrade them on
/// open so an existing profile does not wait for each setting to be saved again.
fn encrypt_legacy_settings(conn: &Connection) -> rusqlite::Result<()> {
    let mut stmt = conn.prepare("SELECT key, value FROM settings")?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (key, value) in rows {
        if !value.starts_with("enc1:") {
            conn.execute(
                "UPDATE settings SET value = ?2 WHERE key = ?1",
                params![key, secret::encode(&value)],
            )?;
        }
    }
    Ok(())
}

fn migrate(conn: &Connection) -> rusqlite::Result<()> {
    let version: i64 = conn.query_row("PRAGMA user_version", [], |row| row.get(0))?;
    for (index, sql) in MIGRATIONS.iter().enumerate().skip(version.max(0) as usize) {
        let tx = conn.unchecked_transaction()?;
        tx.execute_batch(sql)?;
        tx.pragma_update(None, "user_version", index as i64 + 1)?;
        tx.commit()?;
    }
    Ok(())
}

pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Addons
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StoredAddon {
    pub url: String,
    pub addon_id: String,
    pub name: String,
    pub manifest: Value,
    pub enabled: bool,
    pub position: i64,
}

impl StoredAddon {
    pub fn from_row(row: &rusqlite::Row) -> rusqlite::Result<Self> {
        let manifest: String = row.get(3)?;
        Ok(Self {
            url: row.get(0)?,
            addon_id: row.get(1)?,
            name: row.get(2)?,
            manifest: serde_json::from_str(&manifest).unwrap_or(Value::Null),
            enabled: row.get::<_, i64>(4)? != 0,
            position: row.get(5)?,
        })
    }
}

pub fn list_addons(conn: &Connection) -> rusqlite::Result<Vec<StoredAddon>> {
    let mut stmt = conn.prepare(
        "SELECT url, addon_id, name, manifest, enabled, position FROM addons ORDER BY position, name",
    )?;
    let rows = stmt.query_map([], StoredAddon::from_row)?;
    rows.collect()
}

pub fn upsert_addon(
    conn: &Connection,
    url: &str,
    addon_id: &str,
    name: &str,
    manifest: &Value,
) -> rusqlite::Result<()> {
    let position: i64 = conn
        .query_row("SELECT COALESCE(MAX(position), 0) + 1 FROM addons", [], |r| {
            r.get(0)
        })
        .unwrap_or(1);
    conn.execute(
        "INSERT INTO addons (url, addon_id, name, manifest, enabled, position, installed_at)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
         ON CONFLICT(url) DO UPDATE SET addon_id = ?2, name = ?3, manifest = ?4",
        params![
            url,
            addon_id,
            name,
            serde_json::to_string(manifest).unwrap_or_default(),
            position,
            now()
        ],
    )?;
    Ok(())
}

pub fn remove_addon(conn: &Connection, url: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM addons WHERE url = ?1", params![url])?;
    Ok(())
}

pub fn set_addon_enabled(conn: &Connection, url: &str, enabled: bool) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE addons SET enabled = ?2 WHERE url = ?1",
        params![url, enabled as i64],
    )?;
    Ok(())
}

/// Swap an addon with its neighbour. Positions are flattened to row order first
/// so rows that share a value still move exactly one step.
pub fn move_addon(conn: &Connection, url: &str, delta: i32) -> rusqlite::Result<()> {
    let addons = list_addons(conn)?;
    let Some(index) = addons.iter().position(|a| a.url == url) else {
        return Ok(());
    };
    let target = index as i64 + delta as i64;
    if delta == 0 || target < 0 || target as usize >= addons.len() {
        return Ok(());
    }
    let target = target as usize;
    let tx = conn.unchecked_transaction()?;
    for (slot, addon) in addons.iter().enumerate() {
        tx.execute(
            "UPDATE addons SET position = ?2 WHERE url = ?1",
            params![addon.url, slot as i64],
        )?;
    }
    tx.execute(
        "UPDATE addons SET position = ?2 WHERE url = ?1",
        params![addons[index].url, target as i64],
    )?;
    tx.execute(
        "UPDATE addons SET position = ?2 WHERE url = ?1",
        params![addons[target].url, index as i64],
    )?;
    tx.commit()
}

// ---------------------------------------------------------------------------
// Library
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct LibraryItem {
    pub id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub added_at: i64,
    pub meta: Option<Value>,
}

pub fn list_library(conn: &Connection) -> rusqlite::Result<Vec<LibraryItem>> {
    // `meta` is write-only: nothing reads it back, so the blob stays in the row.
    let mut stmt = conn.prepare(
        "SELECT id, media_type, name, poster, background, added_at
         FROM library ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(LibraryItem {
            id: row.get(0)?,
            media_type: row.get(1)?,
            name: row.get(2)?,
            poster: row.get(3)?,
            background: row.get(4)?,
            added_at: row.get(5)?,
            meta: None,
        })
    })?;
    rows.collect()
}

pub fn add_to_library(conn: &Connection, item: &LibraryItem) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO library (id, media_type, name, poster, background, added_at, meta)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
         ON CONFLICT(id) DO UPDATE SET
           name = ?3, poster = ?4, background = ?5, meta = ?7",
        params![
            item.id,
            item.media_type,
            item.name,
            item.poster,
            item.background,
            now(),
            item.meta.as_ref().map(|m| m.to_string())
        ],
    )?;
    Ok(())
}

pub fn remove_from_library(conn: &Connection, id: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM library WHERE id = ?1", params![id])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ProgressItem {
    pub key: String,
    pub meta_id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub episode_title: Option<String>,
    pub position: f64,
    pub duration: f64,
    pub updated_at: i64,
}

impl ProgressItem {
    fn from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Self> {
        Ok(Self {
            key: row.get(0)?,
            meta_id: row.get(1)?,
            media_type: row.get(2)?,
            name: row.get(3)?,
            poster: row.get(4)?,
            background: row.get(5)?,
            season: row.get(6)?,
            episode: row.get(7)?,
            episode_title: row.get(8)?,
            position: row.get(9)?,
            duration: row.get(10)?,
            updated_at: row.get(11)?,
        })
    }
}

pub fn list_progress(conn: &Connection) -> rusqlite::Result<Vec<ProgressItem>> {
    let mut stmt = conn.prepare(
        "SELECT key, meta_id, media_type, name, poster, background, season, episode,
                episode_title, position, duration, updated_at
         FROM progress
         WHERE duration > 0 AND position > 5
         ORDER BY updated_at DESC LIMIT 60",
    )?;
    let rows = stmt.query_map([], ProgressItem::from_row)?;
    rows.collect()
}

/// One card per title for the home screen: the newest unfinished episode.
/// Anything marked watched, or played past 90%, belongs in the Watched list.
pub fn list_continue_watching(conn: &Connection) -> rusqlite::Result<Vec<ProgressItem>> {
    let mut stmt = conn.prepare(
        "SELECT key, meta_id, media_type, name, poster, background, season, episode,
                episode_title, position, duration, updated_at
         FROM (
           SELECT progress.*,
                  ROW_NUMBER() OVER (PARTITION BY meta_id ORDER BY updated_at DESC) AS rn
           FROM progress
           WHERE duration > 0
             AND position > 5
             AND position < duration * ?1
             -- Only a finished mark newer than the position hides the title.
             -- One left over from an earlier run must not outrank playback
             -- that happened after it.
             AND key NOT IN (
               SELECT w.key FROM watched w
               JOIN progress p ON p.key = w.key
               WHERE w.watched = 1 AND w.updated_at > p.updated_at
             )
         )
         WHERE rn = 1
         ORDER BY updated_at DESC
         LIMIT 30",
    )?;
    let rows = stmt.query_map(params![FINISHED_AT], ProgressItem::from_row)?;
    rows.collect()
}

pub fn get_progress(conn: &Connection, key: &str) -> rusqlite::Result<Option<ProgressItem>> {
    conn.query_row(
        "SELECT key, meta_id, media_type, name, poster, background, season, episode,
                episode_title, position, duration, updated_at
         FROM progress WHERE key = ?1",
        params![key],
        ProgressItem::from_row,
    )
    .optional()
}

pub fn save_progress(conn: &Connection, p: &ProgressItem) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    write_progress(&tx, p)?;
    tx.commit()
}

/// One transaction for the ticker: the watched mark and the playhead together.
pub fn save_playback(conn: &Connection, p: &ProgressItem, watched: bool) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    if watched {
        mark_watched(&tx, &p.key, &p.meta_id)?;
    }
    write_progress(&tx, p)?;
    tx.commit()
}

fn write_progress(conn: &Connection, p: &ProgressItem) -> rusqlite::Result<()> {
    // Container metadata can report a duration shorter than the playhead.
    let position = if p.duration > 0.0 {
        p.position.clamp(0.0, p.duration)
    } else {
        p.position
    };
    conn.execute(
        "INSERT INTO progress (key, meta_id, media_type, name, poster, background, season,
                               episode, episode_title, position, duration, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT(key) DO UPDATE SET
           meta_id = ?2, media_type = ?3, name = ?4, poster = ?5, background = ?6,
           season = ?7, episode = ?8, episode_title = ?9, position = ?10,
           duration = ?11, updated_at = ?12",
        params![
            p.key,
            p.meta_id,
            p.media_type,
            p.name,
            p.poster,
            p.background,
            p.season,
            p.episode,
            p.episode_title,
            position,
            p.duration,
            now()
        ],
    )?;
    // A position short of the end means the title is being watched again, so a
    // finished mark from an earlier run no longer applies. Without this it stays
    // out of Continue watching for good.
    if p.duration > 0.0 && position < p.duration * FINISHED_AT {
        conn.execute("DELETE FROM watched WHERE key = ?1", params![p.key])?;
    }
    Ok(())
}

pub fn clear_progress(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    // The finished mark has to go too, or the title reappears in Watched.
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM progress WHERE key = ?1", params![key])?;
    tx.execute("DELETE FROM watched WHERE key = ?1", params![key])?;
    tx.commit()
}

/// Drops watching history only. Library, addons, settings and people stay, so
/// switching Nuvio profile or account starts from a clean slate.
pub fn clear_history(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute("DELETE FROM progress", [])?;
    tx.execute("DELETE FROM watched", [])?;
    tx.commit()
}

/// Progress rows that arrived from the account with nothing but an id, one
/// entry per title so a 40-episode show costs one lookup instead of forty.
pub fn progress_missing_meta(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT meta_id, media_type FROM progress
         WHERE meta_id LIKE 'tt%'
           AND (name IS NULL OR name = '' OR name LIKE 'tt%')
         GROUP BY meta_id
         ORDER BY MAX(updated_at) DESC LIMIT 40",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

/// Patch the identity of every row of a title without touching playheads.
pub fn set_progress_meta(
    conn: &Connection,
    meta_id: &str,
    name: &str,
    poster: Option<&str>,
    background: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE progress
         SET name = CASE WHEN name IS NULL OR name = '' OR name LIKE 'tt%' THEN ?2 ELSE name END,
             poster = COALESCE(poster, ?3),
             background = COALESCE(background, ?4)
         WHERE meta_id = ?1",
        params![meta_id, name, poster, background],
    )?;
    Ok(())
}

/// Library rows that arrived from the account with nothing but an id.
pub fn library_missing_meta(conn: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = conn.prepare(
        "SELECT id, media_type FROM library
         WHERE id LIKE 'tt%'
           AND (name IS NULL OR name = '' OR name LIKE 'tt%')
         ORDER BY added_at DESC LIMIT 40",
    )?;
    let rows = stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?;
    rows.collect()
}

pub fn set_library_meta(
    conn: &Connection,
    id: &str,
    name: &str,
    poster: Option<&str>,
    background: Option<&str>,
) -> rusqlite::Result<()> {
    conn.execute(
        "UPDATE library
         SET name = CASE WHEN name IS NULL OR name = '' OR name LIKE 'tt%' THEN ?2 ELSE name END,
             poster = COALESCE(poster, ?3),
             background = COALESCE(background, ?4)
         WHERE id = ?1",
        params![id, name, poster, background],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Watched
// ---------------------------------------------------------------------------

pub fn set_watched(conn: &Connection, key: &str, meta_id: &str, watched: bool) -> rusqlite::Result<()> {
    if watched {
        mark_watched(conn, key, meta_id)?;
    } else {
        // Watched also counts progress finished at FINISHED_AT, so the playhead
        // has to go with the mark or the title stays in Watched.
        let tx = conn.unchecked_transaction()?;
        tx.execute("DELETE FROM watched WHERE key = ?1", params![key])?;
        tx.execute("DELETE FROM progress WHERE key = ?1", params![key])?;
        tx.commit()?;
    }
    Ok(())
}

fn mark_watched(conn: &Connection, key: &str, meta_id: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES (?1, ?2, 1, ?3)
         ON CONFLICT(key) DO UPDATE SET watched = 1, updated_at = ?3",
        params![key, meta_id, now()],
    )?;
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn list_watched(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT key FROM watched WHERE watched = 1")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchedItem {
    pub meta_id: String,
    #[serde(rename = "type")]
    pub media_type: String,
    pub name: String,
    pub poster: Option<String>,
    pub background: Option<String>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub watched_at: i64,
}

/// Everything already finished, one row per title: the account's explicit
/// watched marks plus anything played past 90%. Titles that only ever existed
/// as an id in the account borrow their name and artwork from the library.
pub fn list_watched_items(conn: &Connection) -> rusqlite::Result<Vec<WatchedItem>> {
    let mut stmt = conn.prepare(
        "WITH marks AS (
           SELECT w.meta_id, w.updated_at AS at FROM watched w
           WHERE w.watched = 1
             -- Playback after a mark means the title is being watched again,
             -- so the completed entry has to go.
             AND NOT EXISTS (
               SELECT 1 FROM progress p
               WHERE p.key = w.key
                 AND p.duration > 0
                 AND p.position < p.duration * ?1
                 AND p.updated_at > w.updated_at
             )
           UNION ALL
           SELECT meta_id, updated_at FROM progress
           WHERE duration > 0 AND position >= duration * ?1
         ),
         latest AS (SELECT meta_id, MAX(at) AS at FROM marks GROUP BY meta_id)
         SELECT l.meta_id, l.at,
                COALESCE(p.media_type, b.media_type, 'movie'),
                COALESCE(NULLIF(p.name, ''), NULLIF(b.name, ''), l.meta_id),
                COALESCE(p.poster, b.poster),
                COALESCE(p.background, b.background),
                p.season, p.episode
         FROM latest l
         LEFT JOIN progress p ON p.key = (
           SELECT p2.key FROM progress p2 WHERE p2.meta_id = l.meta_id
           ORDER BY p2.updated_at DESC LIMIT 1)
         LEFT JOIN library b ON b.id = l.meta_id
         ORDER BY l.at DESC
         LIMIT 300",
    )?;
    let rows = stmt.query_map(params![FINISHED_AT], |row| {
        Ok(WatchedItem {
            meta_id: row.get(0)?,
            watched_at: row.get(1)?,
            media_type: row.get(2)?,
            name: row.get(3)?,
            poster: row.get(4)?,
            background: row.get(5)?,
            season: row.get(6)?,
            episode: row.get(7)?,
        })
    })?;
    rows.collect()
}

/// Every title the viewer has touched in any way: finished, marked watched, or
/// only started. Used to keep recommendations clear of anything already seen.
pub fn touched_ids(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt =
        conn.prepare("SELECT meta_id FROM progress UNION SELECT meta_id FROM watched")?;
    let rows = stmt.query_map([], |row| row.get(0))?;
    rows.collect()
}

// ---------------------------------------------------------------------------
// People (headshots)
// ---------------------------------------------------------------------------

/// Headshots are keyed by title and name, because a lookup that missed is worth
/// remembering too: an empty string means "asked, nothing found".
pub fn people_photo(conn: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    conn.query_row("SELECT photo FROM people WHERE key = ?1", params![key], |r| r.get(0))
        .optional()
}

pub fn set_people_photo(conn: &Connection, key: &str, photo: &str) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO people (key, photo, checked_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET photo = ?2, checked_at = ?3",
        params![key, photo, now()],
    )?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

pub fn read_kv(conn: &Connection, key: &str) -> rusqlite::Result<Option<Value>> {
    let raw: Option<String> = conn
        .query_row("SELECT value FROM settings WHERE key = ?1", params![key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(raw
        .and_then(|s| secret::decode(&s))
        .and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn write_kv(conn: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, secret::encode(&value.to_string())],
    )?;
    Ok(())
}

pub fn delete_kv(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM settings WHERE key = ?1", params![key])?;
    Ok(())
}

pub fn read_settings(conn: &Connection) -> rusqlite::Result<Value> {
    Ok(read_kv(conn, "app")?.unwrap_or(Value::Object(Default::default())))
}

pub fn write_settings(conn: &Connection, value: &Value) -> rusqlite::Result<()> {
    write_kv(conn, "app", value)
}

#[cfg(test)]
mod reorder_tests {
    use super::*;

    fn urls(conn: &Connection) -> Vec<String> {
        list_addons(conn)
            .unwrap()
            .into_iter()
            .map(|a| a.url)
            .collect()
    }

    #[test]
    fn moving_swaps_one_neighbour() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(V1).unwrap();
        for url in ["https://a", "https://b", "https://c"] {
            upsert_addon(&conn, url, url, url, &Value::Null).unwrap();
        }

        move_addon(&conn, "https://b", -1).unwrap();
        assert_eq!(urls(&conn), ["https://b", "https://a", "https://c"]);
        move_addon(&conn, "https://b", -1).unwrap();
        assert_eq!(urls(&conn), ["https://b", "https://a", "https://c"], "top stays put");
        move_addon(&conn, "https://a", 1).unwrap();
        assert_eq!(urls(&conn), ["https://b", "https://c", "https://a"]);

        // Rows left sharing a position still move a single step.
        conn.execute("UPDATE addons SET position = 0", []).unwrap();
        move_addon(&conn, "https://c", -1).unwrap();
        assert_eq!(urls(&conn), ["https://a", "https://c", "https://b"]);
    }
}
