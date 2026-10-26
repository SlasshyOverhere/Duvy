//! Store tests kept in their own module so the schema code stays readable.

use crate::db;
use crate::settings::Settings;
use serde_json::json;
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

fn temp_database() -> (rusqlite::Connection, PathBuf) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("betternuvio-test-{stamp}.db"));
    let connection = db::open(&path).expect("test database opens");
    (connection, path)
}

fn cleanup(connection: rusqlite::Connection, path: PathBuf) {
    drop(connection);
    let _ = std::fs::remove_file(&path);
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
