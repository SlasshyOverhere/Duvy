//! Store tests kept in their own module so the schema code stays readable.

use crate::db;
use crate::settings::Settings;
use serde_json::json;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_path() -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    std::env::temp_dir().join(format!("betternuvio-test-{stamp}.db"))
}

fn temp_database() -> (rusqlite::Connection, PathBuf) {
    let path = temp_path();
    let connection = db::open(&path).expect("test database opens");
    (connection, path)
}

fn cleanup(connection: rusqlite::Connection, path: PathBuf) {
    drop(connection);
    let _ = std::fs::remove_file(&path);
}

#[test]
fn schema_migration_is_idempotent_and_keeps_rows() {
    let path = temp_path();
    let version = |conn: &rusqlite::Connection| -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0)).unwrap()
    };

    let conn = db::open(&path).expect("first open");
    assert_eq!(version(&conn), 1);
    db::write_kv(&conn, "kept", &json!({ "yes": true })).expect("write");
    drop(conn);

    let conn = db::open(&path).expect("second open");
    assert_eq!(version(&conn), 1, "reopening must not re-run migrations");
    assert_eq!(
        db::read_kv(&conn, "kept").unwrap(),
        Some(json!({ "yes": true })),
        "existing data survives the migration"
    );

    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
        .unwrap();
    let indexes: Vec<String> = stmt
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap();
    for expected in [
        "idx_progress_meta",
        "idx_progress_updated",
        "idx_watched_meta",
        "idx_library_added",
    ] {
        assert!(indexes.iter().any(|name| name == expected), "missing {expected}");
    }
    drop(stmt);

    cleanup(conn, path);
}

#[test]
fn addons_roundtrip() {
    let (conn, path) = temp_database();
    let manifest = json!({
        "id": "com.example.test",
        "name": "Test Addon",
        "version": "1.0.0",
        "resources": ["catalog", "meta"],
        "types": ["movie"],
        "catalogs": [{ "type": "movie", "id": "top", "name": "Popular" }]
    });

    db::upsert_addon(&conn, "https://example.test", "com.example.test", "Test Addon", &manifest)
        .expect("insert");
    let addons = db::list_addons(&conn).expect("list");
    assert_eq!(addons.len(), 1);
    assert_eq!(addons[0].name, "Test Addon");
    assert!(addons[0].enabled);

    db::set_addon_enabled(&conn, "https://example.test", false).expect("disable");
    assert!(!db::list_addons(&conn).unwrap()[0].enabled);

    // Re-installing updates in place instead of duplicating.
    db::upsert_addon(&conn, "https://example.test", "com.example.test", "Renamed", &manifest)
        .expect("upsert");
    assert_eq!(db::list_addons(&conn).unwrap().len(), 1);
    assert_eq!(db::list_addons(&conn).unwrap()[0].name, "Renamed");

    db::remove_addon(&conn, "https://example.test").expect("remove");
    assert!(db::list_addons(&conn).unwrap().is_empty());

    cleanup(conn, path);
}

#[test]
fn progress_tracks_and_clears() {
    let (conn, path) = temp_database();
    let item = db::ProgressItem {
        key: "tt123:1:2".into(),
        meta_id: "tt123".into(),
        media_type: "series".into(),
        name: "Test Show".into(),
        poster: None,
        background: None,
        season: Some(1),
        episode: Some(2),
        episode_title: Some("Pilot".into()),
        position: 605.0,
        duration: 2400.0,
        updated_at: 0,
    };
    db::save_progress(&conn, &item).expect("save");

    let stored = db::get_progress(&conn, "tt123:1:2").expect("get").expect("exists");
    assert_eq!(stored.position, 605.0);
    assert!(stored.updated_at > 0);

    let list = db::list_progress(&conn).expect("list");
    assert_eq!(list.len(), 1);

    db::save_progress(
        &conn,
        &db::ProgressItem {
            position: 1000.0,
            ..item.clone()
        },
    )
    .expect("update");
    assert_eq!(db::list_progress(&conn).unwrap().len(), 1);
    assert_eq!(db::list_progress(&conn).unwrap()[0].position, 1000.0);

    db::clear_progress(&conn, "tt123:1:2").expect("clear");
    assert!(db::list_progress(&conn).unwrap().is_empty());

    cleanup(conn, path);
}

#[test]
fn clear_history_keeps_library_addons_settings_and_people() {
    let (conn, path) = temp_database();
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt7".into(),
            meta_id: "tt7".into(),
            media_type: "movie".into(),
            name: "A Film".into(),
            poster: None,
            background: None,
            season: None,
            episode: None,
            episode_title: None,
            position: 10.0,
            duration: 100.0,
            updated_at: 0,
        },
    )
    .expect("progress");
    db::set_watched(&conn, "tt7", "tt7", true).expect("watched");
    db::add_to_library(
        &conn,
        &db::LibraryItem {
            id: "tt7".into(),
            media_type: "movie".into(),
            name: "A Film".into(),
            poster: None,
            background: None,
            added_at: 0,
            meta: None,
        },
    )
    .expect("library");
    let manifest = json!({ "id": "com.example.keep", "name": "Keep", "version": "1.0.0" });
    db::upsert_addon(&conn, "https://example.test", "com.example.keep", "Keep", &manifest)
        .expect("addon");
    db::set_people_photo(&conn, "tt7:Jane", "https://example.test/j.jpg").expect("people");
    db::write_settings(&conn, &json!({ "accent": "kept" })).expect("settings");

    db::clear_history(&conn).expect("clear");

    assert!(db::list_progress(&conn).unwrap().is_empty());
    assert!(db::list_watched(&conn).unwrap().is_empty());
    assert_eq!(db::list_library(&conn).unwrap().len(), 1);
    assert_eq!(db::list_addons(&conn).unwrap().len(), 1);
    assert_eq!(
        db::people_photo(&conn, "tt7:Jane").unwrap().as_deref(),
        Some("https://example.test/j.jpg")
    );
    assert_eq!(db::read_settings(&conn).unwrap()["accent"], json!("kept"));

    cleanup(conn, path);
}

#[test]
fn library_and_watched_roundtrip() {
    let (conn, path) = temp_database();
    let item = db::LibraryItem {
        id: "tt999".into(),
        media_type: "movie".into(),
        name: "A Film".into(),
        poster: Some("https://example.test/p.jpg".into()),
        background: None,
        added_at: 0,
        meta: None,
    };
    db::add_to_library(&conn, &item).expect("add");
    db::add_to_library(&conn, &item).expect("idempotent add");
    assert_eq!(db::list_library(&conn).unwrap().len(), 1);

    db::set_watched(&conn, "tt999", "tt999", true).expect("watched");
    assert_eq!(db::list_watched(&conn).unwrap(), vec!["tt999".to_string()]);
    db::set_watched(&conn, "tt999", "tt999", false).expect("unwatched");
    assert!(db::list_watched(&conn).unwrap().is_empty());

    db::remove_from_library(&conn, "tt999").expect("remove");
    assert!(db::list_library(&conn).unwrap().is_empty());

    cleanup(conn, path);
}

#[test]
fn continue_watching_hides_finished_and_merges_episodes() {
    let (conn, path) = temp_database();
    let base = db::ProgressItem {
        key: String::new(),
        meta_id: "tt1".into(),
        media_type: "series".into(),
        name: "A Show".into(),
        poster: None,
        background: None,
        season: Some(1),
        episode: Some(1),
        episode_title: None,
        position: 100.0,
        duration: 1000.0,
        updated_at: 0,
    };
    let episode = |key: &str, number: i64| db::ProgressItem {
        key: key.into(),
        episode: Some(number),
        ..base.clone()
    };

    db::save_progress(&conn, &episode("tt1:1:1", 1)).expect("episode 1");
    db::save_progress(&conn, &episode("tt1:1:2", 2)).expect("episode 2");
    // Finished: 99% of a film belongs in Watched, not in Continue watching.
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt2".into(),
            meta_id: "tt2".into(),
            media_type: "movie".into(),
            name: "A Film".into(),
            season: None,
            episode: None,
            position: 990.0,
            ..base.clone()
        },
    )
    .expect("film");
    // save_progress stamps "now", so pin the play order for the assertion.
    conn.execute("UPDATE progress SET updated_at = 10 WHERE key = 'tt1:1:1'", [])
        .unwrap();
    conn.execute("UPDATE progress SET updated_at = 20 WHERE key = 'tt1:1:2'", [])
        .unwrap();

    let continuing = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(continuing.len(), 1);
    assert_eq!(continuing[0].key, "tt1:1:2");

    let watched = db::list_watched_items(&conn).expect("watched");
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0].meta_id, "tt2");

    // An explicit mark hides that episode; the show falls back to the one still
    // in progress rather than vanishing.
    db::set_watched(&conn, "tt1:1:2", "tt1", true).expect("mark");
    let remaining = db::list_continue_watching(&conn).unwrap();
    assert_eq!(remaining.len(), 1);
    assert_eq!(remaining[0].key, "tt1:1:1");
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 2);

    cleanup(conn, path);
}

#[test]
fn watched_items_keep_metadata_after_completion() {
    let (conn, path) = temp_database();
    // A finished episode: same row persist() leaves behind at >=92%.
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt42:2:5".into(),
            meta_id: "tt42".into(),
            media_type: "series".into(),
            name: "Finished Show".into(),
            poster: Some("https://example.test/p.jpg".into()),
            background: Some("https://example.test/b.jpg".into()),
            season: Some(2),
            episode: Some(5),
            episode_title: Some("Finale".into()),
            position: 1000.0,
            duration: 1000.0,
            updated_at: 0,
        },
    )
    .expect("save");
    db::set_watched(&conn, "tt42:2:5", "tt42", true).expect("watched");

    let watched = db::list_watched_items(&conn).expect("list");
    assert_eq!(watched.len(), 1);
    let row = &watched[0];
    assert_eq!(row.meta_id, "tt42");
    assert_eq!(row.name, "Finished Show");
    assert_eq!(row.media_type, "series");
    assert_eq!(row.poster.as_deref(), Some("https://example.test/p.jpg"));
    assert_eq!(row.background.as_deref(), Some("https://example.test/b.jpg"));
    assert_eq!(row.season, Some(2));
    assert_eq!(row.episode, Some(5));

    // No library entry exists, so nothing was borrowed and no id fallback fired.
    assert!(db::list_library(&conn).unwrap().is_empty());
    // The kept row must not resurface in Continue watching.
    assert!(db::list_continue_watching(&conn).unwrap().is_empty());

    cleanup(conn, path);
}

#[test]
fn rewatching_a_finished_title_returns_it_to_continue_watching() {
    let (conn, path) = temp_database();
    let item = db::ProgressItem {
        key: "tt9".into(),
        meta_id: "tt9".into(),
        media_type: "movie".into(),
        name: "A Film".into(),
        poster: None,
        background: None,
        season: None,
        episode: None,
        episode_title: None,
        position: 990.0,
        duration: 1000.0,
        updated_at: 0,
    };
    db::save_progress(&conn, &item).expect("finish");
    db::set_watched(&conn, "tt9", "tt9", true).expect("mark");
    assert!(db::list_continue_watching(&conn).unwrap().is_empty());

    // Starting it again saves a position short of the end, and that has to
    // retire the finished mark or the title never comes back.
    db::save_progress(
        &conn,
        &db::ProgressItem {
            position: 200.0,
            ..item
        },
    )
    .expect("rewatch");

    let continuing = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(continuing.len(), 1);
    assert_eq!(continuing[0].position, 200.0);
    assert!(db::list_watched_items(&conn).unwrap().is_empty());

    cleanup(conn, path);
}

#[test]
fn a_finished_mark_older_than_the_position_does_not_hide_the_title() {
    let (conn, path) = temp_database();
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt9".into(),
            meta_id: "tt9".into(),
            media_type: "movie".into(),
            name: "A Film".into(),
            poster: None,
            background: None,
            season: None,
            episode: None,
            episode_title: None,
            position: 200.0,
            duration: 1000.0,
            updated_at: 0,
        },
    )
    .expect("play");
    // A mark left behind by an earlier completion, older than this position.
    conn.execute(
        "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES ('tt9', 'tt9', 1, 1)",
        [],
    )
    .unwrap();

    let continuing = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(continuing.len(), 1);
    assert_eq!(continuing[0].position, 200.0);
    assert!(db::list_watched_items(&conn).unwrap().is_empty());

    cleanup(conn, path);
}

#[test]
fn credentials_are_encrypted_at_rest() {
    let (conn, path) = temp_database();
    let stored = json!({ "tmdbKey": "abc123", "trakt": { "token": "tok" } });
    db::write_settings(&conn, &stored).expect("settings write");
    assert_eq!(db::read_settings(&conn).unwrap(), stored, "settings roundtrip");

    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| row.get(0))
        .expect("raw value");
    assert!(raw.starts_with("enc1:"), "stored value must be encrypted: {raw}");
    assert!(!raw.contains("abc123"), "plaintext key must not survive on disk");

    // Rows written before encryption existed still load.
    let legacy = json!({ "plain": true }).to_string();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('legacy', ?1)",
        rusqlite::params![legacy],
    )
    .expect("legacy insert");
    assert_eq!(
        db::read_kv(&conn, "legacy").unwrap(),
        Some(json!({ "plain": true }))
    );

    // The shared kv path roundtrips through the same codec.
    db::write_kv(&conn, "kv", &json!({ "n": 1 })).expect("kv write");
    assert_eq!(db::read_kv(&conn, "kv").unwrap(), Some(json!({ "n": 1 })));

    cleanup(conn, path);
}

#[test]
fn legacy_plaintext_rows_are_encrypted_on_open() {
    let path = temp_path();
    let conn = db::open(&path).expect("first open");
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('legacy', ?1)",
        rusqlite::params![json!({ "old": true }).to_string()],
    )
    .expect("legacy insert");
    drop(conn);

    let conn = db::open(&path).expect("second open");
    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'legacy'", [], |row| row.get(0))
        .expect("raw value");
    assert!(raw.starts_with("enc1:"), "legacy row must be upgraded: {raw}");
    assert_eq!(
        db::read_kv(&conn, "legacy").unwrap(),
        Some(json!({ "old": true }))
    );
    cleanup(conn, path);
}

#[test]
fn settings_patch_merges_and_resets() {
    let (conn, path) = temp_database();
    let mut settings = Settings::default();
    settings.apply_patch(json!({ "accent": "violet", "seekStep": 30 })).unwrap();
    assert_eq!(settings.accent, "violet");
    assert_eq!(settings.seek_step, 30);
    settings.save(&conn).expect("save");

    let reloaded = Settings::load(&conn);
    assert_eq!(reloaded.accent, "violet");
    assert_eq!(reloaded.seek_step, 30);

    // null resets a field back to its default.
    let mut patched = reloaded;
    patched.apply_patch(json!({ "accent": null })).unwrap();
    assert_eq!(patched.accent, Settings::default().accent);

    cleanup(conn, path);
}
