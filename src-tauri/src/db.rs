//! Local SQLite store: addons, library, watch progress and settings.
//!
//! The store is deliberately small and synchronous. Every query here touches a
//! few hundred rows at most, so a single WAL-mode connection behind a mutex is
//! both simpler and faster than a pool.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Db(pub Mutex<Connection>);

const SCHEMA: &str = r#"
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

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
"#;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let conn = Connection::open(path)?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
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
    let mut stmt = conn.prepare(
        "SELECT id, media_type, name, poster, background, added_at, meta
         FROM library ORDER BY added_at DESC",
    )?;
    let rows = stmt.query_map([], |row| {
        let meta: Option<String> = row.get(6)?;
        Ok(LibraryItem {
            id: row.get(0)?,
            media_type: row.get(1)?,
            name: row.get(2)?,
            poster: row.get(3)?,
            background: row.get(4)?,
            added_at: row.get(5)?,
            meta: meta.and_then(|m| serde_json::from_str(&m).ok()),
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

pub fn list_progress(conn: &Connection) -> rusqlite::Result<Vec<ProgressItem>> {
    let mut stmt = conn.prepare(
        "SELECT key, meta_id, media_type, name, poster, background, season, episode,
                episode_title, position, duration, updated_at
         FROM progress
         WHERE duration > 0 AND position > 5
         ORDER BY updated_at DESC LIMIT 60",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok(ProgressItem {
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
    })?;
    rows.collect()
}

pub fn get_progress(conn: &Connection, key: &str) -> rusqlite::Result<Option<ProgressItem>> {
    conn.query_row(
        "SELECT key, meta_id, media_type, name, poster, background, season, episode,
                episode_title, position, duration, updated_at
         FROM progress WHERE key = ?1",
        params![key],
        |row| {
            Ok(ProgressItem {
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
        },
    )
    .optional()
}

pub fn save_progress(conn: &Connection, p: &ProgressItem) -> rusqlite::Result<()> {
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
            p.position,
            p.duration,
            now()
        ],
    )?;
    Ok(())
}

pub fn clear_progress(conn: &Connection, key: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM progress WHERE key = ?1", params![key])?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Watched
// ---------------------------------------------------------------------------

pub fn set_watched(conn: &Connection, key: &str, meta_id: &str, watched: bool) -> rusqlite::Result<()> {
    if watched {
        conn.execute(
            "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES (?1, ?2, 1, ?3)
             ON CONFLICT(key) DO UPDATE SET watched = 1, updated_at = ?3",
            params![key, meta_id, now()],
        )?;
    } else {
        conn.execute("DELETE FROM watched WHERE key = ?1", params![key])?;
    }
    Ok(())
}

#[cfg_attr(not(test), allow(dead_code))]
pub fn list_watched(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT key FROM watched WHERE watched = 1")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    rows.collect()
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
    Ok(raw.and_then(|s| serde_json::from_str(&s).ok()))
}

pub fn write_kv(conn: &Connection, key: &str, value: &Value) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO settings (key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = ?2",
        params![key, value.to_string()],
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
