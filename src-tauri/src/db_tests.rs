//! Store tests kept in their own module so the schema code stays readable.

use crate::db;
use crate::settings::Settings;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

/// A temp database file that removes itself, including the WAL sidecars.
struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        Self {
            path: std::env::temp_dir().join(format!("duvy-test-{}-{id}.db", std::process::id())),
        }
    }

    fn path(&self) -> &Path {
        &self.path
    }

    fn open(&self) -> rusqlite::Connection {
        db::open(&self.path).expect("test database opens")
    }
}

impl Drop for TempDb {
    fn drop(&mut self) {
        for suffix in ["", "-wal", "-shm"] {
            let mut file = self.path.clone().into_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(PathBuf::from(file));
        }
    }
}

#[test]
fn schema_migration_is_idempotent_and_keeps_rows() {
    let temp = TempDb::new();
    let version = |conn: &rusqlite::Connection| -> i64 {
        conn.query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap()
    };

    let conn = temp.open();
    assert_eq!(version(&conn), 2);
    db::write_kv(&conn, "kept", &json!({ "yes": true })).expect("write");
    drop(conn);

    let conn = temp.open();
    assert_eq!(version(&conn), 2, "reopening must not re-run migrations");
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
        "idx_progress_meta_updated",
        "idx_watched_meta",
        "idx_library_added",
    ] {
        assert!(
            indexes.iter().any(|name| name == expected),
            "missing {expected}"
        );
    }
    drop(stmt);
}

#[test]
fn existing_database_upgrades_to_the_new_index() {
    let temp = TempDb::new();
    let conn = temp.open();
    // Rewind to the schema an older build left behind.
    conn.execute_batch("DROP INDEX idx_progress_meta_updated; PRAGMA user_version = 1;")
        .expect("rewind");
    drop(conn);

    let conn = temp.open();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2);
    let found: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master
             WHERE type = 'index' AND name = 'idx_progress_meta_updated'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(
        found, 1,
        "the new migration must reach an existing database"
    );
}

#[test]
fn addons_roundtrip() {
    let temp = TempDb::new();
    let conn = temp.open();
    let manifest = json!({
        "id": "com.example.test",
        "name": "Test Addon",
        "version": "1.0.0",
        "resources": ["catalog", "meta"],
        "types": ["movie"],
        "catalogs": [{ "type": "movie", "id": "top", "name": "Popular" }]
    });

    db::upsert_addon(
        &conn,
        "https://example.test",
        "com.example.test",
        "Test Addon",
        &manifest,
    )
    .expect("insert");
    let addons = db::list_addons(&conn).expect("list");
    assert_eq!(addons.len(), 1);
    assert_eq!(addons[0].name, "Test Addon");
    assert!(addons[0].enabled);

    db::set_addon_enabled(&conn, "https://example.test", false).expect("disable");
    assert!(!db::list_addons(&conn).unwrap()[0].enabled);

    // Re-installing updates in place instead of duplicating.
    db::upsert_addon(
        &conn,
        "https://example.test",
        "com.example.test",
        "Renamed",
        &manifest,
    )
    .expect("upsert");
    assert_eq!(db::list_addons(&conn).unwrap().len(), 1);
    assert_eq!(db::list_addons(&conn).unwrap()[0].name, "Renamed");

    db::remove_addon(&conn, "https://example.test").expect("remove");
    assert!(db::list_addons(&conn).unwrap().is_empty());
}

#[test]
fn progress_tracks_and_clears() {
    let temp = TempDb::new();
    let conn = temp.open();
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

    let stored = db::get_progress(&conn, "tt123:1:2")
        .expect("get")
        .expect("exists");
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
}

#[test]
fn finished_titles_stay_in_history_but_not_in_continue_watching() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = db::ProgressItem {
        key: "tt5".into(),
        meta_id: "tt5".into(),
        media_type: "movie".into(),
        name: "A Film".into(),
        poster: None,
        background: None,
        season: None,
        episode: None,
        episode_title: None,
        position: 950.0,
        duration: 1000.0,
        updated_at: 0,
    };
    db::save_progress(&conn, &item).expect("finished");
    // The episode list and the history rail still need this row.
    assert_eq!(db::list_progress(&conn).unwrap().len(), 1);
    assert!(
        db::list_continue_watching(&conn).unwrap().is_empty(),
        "a finished title would restart from the end"
    );

    db::save_progress(
        &conn,
        &db::ProgressItem {
            position: 800.0,
            ..item
        },
    )
    .expect("unfinished");
    assert_eq!(db::list_continue_watching(&conn).unwrap().len(), 1);
}

#[test]
fn clear_progress_removes_the_watched_mark() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt6".into(),
            meta_id: "tt6".into(),
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
        },
    )
    .expect("finished");
    db::set_watched(&conn, "tt6", "tt6", true).expect("mark");
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 1);

    db::clear_progress(&conn, "tt6").expect("clear");
    assert!(
        db::list_watched(&conn).unwrap().is_empty(),
        "the mark must not outlive the playhead"
    );
    assert!(db::list_watched_items(&conn).unwrap().is_empty());
}

#[test]
fn save_progress_clamps_position_into_the_duration() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = db::ProgressItem {
        key: "tt8".into(),
        meta_id: "tt8".into(),
        media_type: "movie".into(),
        name: "A Film".into(),
        poster: None,
        background: None,
        season: None,
        episode: None,
        episode_title: None,
        position: 5000.0,
        duration: 1000.0,
        updated_at: 0,
    };
    db::save_progress(&conn, &item).expect("over duration");
    assert_eq!(
        db::get_progress(&conn, "tt8").unwrap().unwrap().position,
        1000.0
    );

    db::save_progress(
        &conn,
        &db::ProgressItem {
            position: -20.0,
            ..item
        },
    )
    .expect("under zero");
    assert_eq!(
        db::get_progress(&conn, "tt8").unwrap().unwrap().position,
        0.0
    );
}

#[test]
fn marking_a_finished_title_unwatched_removes_it() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt3".into(),
            meta_id: "tt3".into(),
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
        },
    )
    .expect("finished");
    db::set_watched(&conn, "tt3", "tt3", true).expect("mark");
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 1);

    db::set_watched(&conn, "tt3", "tt3", false).expect("unwatch");
    assert!(db::list_watched(&conn).unwrap().is_empty());
    assert!(
        db::list_watched_items(&conn).unwrap().is_empty(),
        "progress past the threshold still counts as watched"
    );
    assert!(db::get_progress(&conn, "tt3").unwrap().is_none());
}

#[test]
fn unmarking_an_unfinished_title_keeps_the_playhead() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt9:1:2".into(),
            meta_id: "tt9".into(),
            media_type: "series".into(),
            name: "A Show".into(),
            poster: None,
            background: None,
            season: Some(1),
            episode: Some(2),
            episode_title: None,
            position: 300.0,
            duration: 1000.0,
            updated_at: 1,
        },
    )
    .expect("playhead");
    db::set_watched(&conn, "tt9:1:2", "tt9", true).expect("mark");
    assert!(db::list_continue_watching(&conn).unwrap().is_empty());

    // Unmarking retires the mark, not the position: the card has to come back.
    db::set_watched(&conn, "tt9:1:2", "tt9", false).expect("unmark");
    assert!(db::list_watched(&conn).unwrap().is_empty());
    let back = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(back.len(), 1);
    assert_eq!(back[0].position, 300.0);
}

#[test]
fn adopting_an_imdb_id_folds_the_tmdb_rows() {
    let temp = TempDb::new();
    let conn = temp.open();
    for (key, meta_id, position, updated_at) in [
        ("tmdb:series:5:1:2", "tmdb:series:5", 300.0, 1),
        ("tt9:1:2", "tt9", 700.0, 2),
    ] {
        db::save_progress(
            &conn,
            &db::ProgressItem {
                key: key.into(),
                meta_id: meta_id.into(),
                media_type: "series".into(),
                name: "A Show".into(),
                poster: None,
                background: None,
                season: Some(1),
                episode: Some(2),
                episode_title: None,
                position,
                duration: 1000.0,
                updated_at,
            },
        )
        .expect("playhead");
    }
    db::set_watched(&conn, "tmdb:series:5:1:2", "tmdb:series:5", true).expect("mark");
    db::add_to_library(
        &conn,
        &db::LibraryItem {
            id: "tmdb:series:5".into(),
            media_type: "series".into(),
            name: "A Show".into(),
            poster: None,
            background: None,
            added_at: 1,
            meta: None,
        },
    )
    .expect("library");

    db::adopt_meta(&conn, "tmdb:series:5", "tt9").expect("adopt");

    let rows = db::all_progress(&conn).expect("progress");
    assert_eq!(rows.len(), 1, "one row per episode, not two");
    assert_eq!(rows[0].key, "tt9:1:2");
    assert_eq!(rows[0].meta_id, "tt9");
    assert_eq!(rows[0].position, 700.0, "the newer playhead wins");
    assert_eq!(db::list_watched(&conn).unwrap(), vec!["tt9:1:2".to_string()]);
    let library = db::list_library(&conn).expect("library");
    assert_eq!(library.len(), 1);
    assert_eq!(library[0].id, "tt9");
}

#[test]
fn continue_watching_stops_exactly_at_the_finish_line() {
    let temp = TempDb::new();
    let conn = temp.open();
    for (index, position) in [5.0, 6.0, 899.0, 900.0, 920.0].into_iter().enumerate() {
        db::save_progress(
            &conn,
            &db::ProgressItem {
                key: format!("tt{index}"),
                meta_id: format!("tt{index}"),
                media_type: "movie".into(),
                name: "A Film".into(),
                poster: None,
                background: None,
                season: None,
                episode: None,
                episode_title: None,
                position,
                duration: 1000.0,
                updated_at: 0,
            },
        )
        .expect("playhead");
    }
    let shown: Vec<f64> = db::list_continue_watching(&conn)
        .expect("continue")
        .iter()
        .map(|row| row.position)
        .collect();
    // A second of playback is not a position, and 90% is already finished.
    assert_eq!(shown, vec![899.0, 6.0]);
}

#[test]
fn a_mark_without_a_playhead_still_has_a_type_and_an_episode() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::set_watched(&conn, "tt8:2:3", "tt8", true).expect("mark");

    let rows = db::list_watched_items(&conn).expect("watched");
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].media_type, "series");
    assert_eq!(rows[0].season, Some(2));
    assert_eq!(rows[0].episode, Some(3));
    // The placeholder borrows the row for its metadata, not as a playhead.
    assert!(db::list_progress(&conn).unwrap().is_empty());
    assert!(db::list_continue_watching(&conn).unwrap().is_empty());
}

#[test]
fn an_older_mark_cannot_resurrect_an_unwatched_title() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::set_watched(&conn, "tt4", "tt4", true).expect("mark");
    db::set_watched(&conn, "tt4", "tt4", false).expect("unmark");
    assert!(db::list_watched(&conn).unwrap().is_empty());

    // The upsert every sync merge uses, with a timestamp from before the unmark.
    conn.execute(
        "INSERT INTO watched (key, meta_id, watched, updated_at) VALUES ('tt4', 'tt4', 1, 1)
         ON CONFLICT(key) DO UPDATE SET watched = 1, updated_at = excluded.updated_at
         WHERE excluded.updated_at >= watched.updated_at",
        [],
    )
    .expect("merge");
    assert!(db::list_watched(&conn).unwrap().is_empty());
}

#[test]
fn clear_history_keeps_library_addons_settings_and_people() {
    let temp = TempDb::new();
    let conn = temp.open();
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
    db::upsert_addon(
        &conn,
        "https://example.test",
        "com.example.keep",
        "Keep",
        &manifest,
    )
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
    assert_eq!(
        db::read_settings(&conn).unwrap().unwrap()["accent"],
        json!("kept")
    );
}

#[test]
fn library_and_watched_roundtrip() {
    let temp = TempDb::new();
    let conn = temp.open();
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
}

#[test]
fn continue_watching_hides_finished_and_merges_episodes() {
    let temp = TempDb::new();
    let conn = temp.open();
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
    conn.execute(
        "UPDATE progress SET updated_at = 10 WHERE key = 'tt1:1:1'",
        [],
    )
    .unwrap();
    conn.execute(
        "UPDATE progress SET updated_at = 20 WHERE key = 'tt1:1:2'",
        [],
    )
    .unwrap();

    let continuing = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(continuing.len(), 1);
    assert_eq!(continuing[0].key, "tt1:1:2");

    let watched = db::list_watched_items(&conn).expect("watched");
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0].meta_id, "tt2");

    // An explicit mark finishes the newest episode, so the title leaves Continue
    // watching. Falling back to an older episode is the bug: the card moves
    // backwards and the episode you just finished comes back.
    db::set_watched(&conn, "tt1:1:2", "tt1", true).expect("mark");
    let remaining = db::list_continue_watching(&conn).unwrap();
    assert!(
        remaining.is_empty(),
        "finished newest episode still resumes {:?}",
        remaining.first().map(|p| &p.key)
    );
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 2);
}

#[test]
fn watched_items_keep_metadata_after_completion() {
    let temp = TempDb::new();
    let conn = temp.open();
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
    assert_eq!(
        row.background.as_deref(),
        Some("https://example.test/b.jpg")
    );
    assert_eq!(row.season, Some(2));
    assert_eq!(row.episode, Some(5));

    // No library entry exists, so nothing was borrowed and no id fallback fired.
    assert!(db::list_library(&conn).unwrap().is_empty());
    // The kept row must not resurface in Continue watching.
    assert!(db::list_continue_watching(&conn).unwrap().is_empty());
}

#[test]
fn watched_marks_keep_every_episode_of_a_show() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::set_watched(&conn, "tt88:1:1", "tt88", true).expect("first");
    db::set_watched(&conn, "tt88:1:2", "tt88", true).expect("second");
    db::set_watched(&conn, "tt88:2:1", "tt88", true).expect("third");
    db::set_watched(&conn, "tt89:1:1", "tt89", true).expect("other show");

    // History still collapses to one row per title...
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 2);
    // ...but the episode list needs every mark, not just the newest one.
    let mut keys: Vec<String> = db::list_watched_marks(&conn, "tt88")
        .expect("marks")
        .into_iter()
        .map(|(key, _)| key)
        .collect();
    keys.sort();
    assert_eq!(keys, vec!["tt88:1:1", "tt88:1:2", "tt88:2:1"]);
}

#[test]
fn watched_keys_keep_every_episode_of_a_show() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::set_watched(&conn, "tt91:1:1", "tt91", true).expect("first");
    db::set_watched(&conn, "tt91:1:2", "tt91", true).expect("second");

    // The per-title list keeps only the newest mark, which is how a show that
    // finished E1 then E2 lost E1 and put the card back on E1.
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 1);
    let mut keys = db::all_watched_keys(&conn).expect("keys");
    keys.sort();
    assert_eq!(keys, vec!["tt91:1:1", "tt91:1:2"]);
}

#[test]
fn watched_marks_drop_an_episode_marked_unwatched() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::set_watched(&conn, "tt90:1:1", "tt90", true).expect("mark");
    db::set_watched(&conn, "tt90:1:2", "tt90", true).expect("mark");
    db::set_watched(&conn, "tt90:1:1", "tt90", false).expect("unmark");

    let keys = db::list_watched_marks(&conn, "tt90").expect("marks");
    assert_eq!(keys.len(), 1);
    assert_eq!(keys[0].0, "tt90:1:2");
}

#[test]
fn watched_list_keeps_the_episode_that_was_watched() {
    let temp = TempDb::new();
    let conn = temp.open();
    let episode = |season: i64, number: i64, position: f64| db::ProgressItem {
        key: format!("tt77:{season}:{number}"),
        meta_id: "tt77".into(),
        media_type: "series".into(),
        name: "A Show".into(),
        poster: None,
        background: None,
        season: Some(season),
        episode: Some(number),
        episode_title: None,
        position,
        duration: 1000.0,
        updated_at: 0,
    };
    db::save_progress(&conn, &episode(1, 1, 1000.0)).expect("finish episode one");
    db::set_watched(&conn, "tt77:1:1", "tt77", true).expect("mark");
    db::save_progress(&conn, &episode(1, 2, 10.0)).expect("start episode two");

    let watched = db::list_watched_items(&conn).expect("list");
    assert_eq!(watched.len(), 1);
    assert_eq!(watched[0].key, "tt77:1:1");
    assert_eq!(watched[0].season, Some(1));
    assert_eq!(watched[0].episode, Some(1));
}

#[test]
fn rewatching_a_finished_title_returns_it_to_continue_watching() {
    let temp = TempDb::new();
    let conn = temp.open();
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
}

#[test]
fn playing_again_drops_the_watched_mark() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = db::ProgressItem {
        key: "tt5:1:1".into(),
        meta_id: "tt5".into(),
        media_type: "series".into(),
        name: "A Show".into(),
        poster: None,
        background: None,
        season: Some(1),
        episode: Some(1),
        episode_title: None,
        position: 980.0,
        duration: 1000.0,
        updated_at: 0,
    };
    db::save_playback(&conn, &item, true).expect("finish");
    db::set_watched(&conn, "tt5", "tt5", true).expect("show mark");
    assert_eq!(db::list_watched_items(&conn).unwrap().len(), 1);

    // Starting the episode again saves a playhead, and that has to retire the
    // mark instead of leaving the title listed as finished.
    db::save_playback(
        &conn,
        &db::ProgressItem {
            position: 120.0,
            ..item
        },
        false,
    )
    .expect("rewatch");

    assert!(db::list_watched(&conn).unwrap().is_empty());
    let continuing = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(continuing.len(), 1);
    assert_eq!(continuing[0].position, 120.0);
}

#[test]
fn a_finished_mark_older_than_the_position_does_not_hide_the_title() {
    let temp = TempDb::new();
    let conn = temp.open();
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
    // OR REPLACE because the write above already left a tombstone there.
    conn.execute(
        "INSERT OR REPLACE INTO watched (key, meta_id, watched, updated_at)
         VALUES ('tt9', 'tt9', 1, 1)",
        [],
    )
    .unwrap();

    let continuing = db::list_continue_watching(&conn).expect("continue");
    assert_eq!(continuing.len(), 1);
    assert_eq!(continuing[0].position, 200.0);
    assert!(db::list_watched_items(&conn).unwrap().is_empty());
}

#[cfg(unix)]
#[test]
fn the_database_file_is_owner_only() {
    use std::os::unix::fs::PermissionsExt;

    let temp = TempDb::new();
    let conn = temp.open();
    let mode = std::fs::metadata(temp.path())
        .expect("metadata")
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600, "watch history must not be world readable");
}

#[test]
fn credentials_are_never_persisted_in_a_reversible_form() {
    let temp = TempDb::new();
    let conn = temp.open();
    let stored = json!({ "tmdbKey": "abc123", "trakt": { "token": "tok" } });
    db::write_settings(&conn, &stored).expect("settings write");
    assert_eq!(
        db::read_settings(&conn).unwrap().unwrap(),
        stored,
        "settings roundtrip"
    );

    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
            row.get(0)
        })
        .expect("raw value");
    assert_eq!(
        raw,
        crate::secret::marker(),
        "the row only says where the value lives"
    );
    assert!(!raw.contains("abc123"), "plaintext must not survive on disk");
    assert!(
        !raw.contains("616263313233"),
        "nor hex of the plaintext: {raw}"
    );

    // Rows written before the protected store existed still load.
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

    // Caches that hold no credential stay plain JSON.
    db::write_kv(&conn, "kv", &json!({ "n": 1 })).expect("kv write");
    assert_eq!(db::read_kv(&conn, "kv").unwrap(), Some(json!({ "n": 1 })));
}

#[test]
fn unreadable_settings_are_not_replaced_by_defaults() {
    let temp = TempDb::new();
    let conn = temp.open();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('app', 'keyring:1')",
        [],
    )
    .expect("marker row");

    // The row exists but cannot be recovered: not a fresh install.
    assert!(matches!(
        Settings::try_load(&conn),
        Err(crate::secret::SecretError::Absent)
    ));
    assert!(
        Settings::default().save(&conn).is_err(),
        "defaults must not overwrite a row that could not be read"
    );

    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'app'", [], |row| {
            row.get(0)
        })
        .expect("row survives");
    assert_eq!(raw, crate::secret::marker(), "the row is untouched");
}

#[test]
fn a_fresh_install_is_not_an_unreadable_row() {
    let temp = TempDb::new();
    let conn = temp.open();
    assert!(matches!(db::read_settings(&conn), Ok(None)));
    assert!(Settings::try_load(&conn).is_ok(), "no row is not a failure");
    assert!(Settings::default().save(&conn).is_ok());
}

#[test]
fn a_bad_settings_field_keeps_its_default_without_losing_the_rest() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::write_settings(
        &conn,
        &json!({ "accent": "violet", "seekStep": "not a number" }),
    )
    .expect("settings write");

    let settings = Settings::try_load(&conn).expect("one bad field is not fatal");
    assert_eq!(settings.accent, "violet");
    assert_eq!(settings.seek_step, Settings::default().seek_step);
}

#[test]
fn a_failed_decode_is_an_error_not_a_plaintext_value() {
    let temp = TempDb::new();
    let conn = temp.open();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('lost', 'keyring:1')",
        [],
    )
    .expect("marker row");

    // The row exists but its value is gone: an error, never Ok(None) or text.
    assert!(matches!(
        db::read_secret_kv(&conn, "lost"),
        Err(crate::secret::SecretError::Absent)
    ));
    assert!(matches!(
        db::read_secret_kv(&conn, "garbage"),
        Ok(None)
    ));
}

#[test]
fn a_legacy_enc1_row_migrates_into_protected_storage() {
    let temp = TempDb::new();
    let conn = temp.open();
    let payload = json!({ "old": true }).to_string();
    conn.execute(
        "INSERT INTO settings (key, value) VALUES ('legacy', ?1)",
        rusqlite::params![crate::secret::legacy_payload(&payload)],
    )
    .expect("legacy insert");

    assert_eq!(
        db::read_secret_kv(&conn, "legacy").unwrap(),
        Some(json!({ "old": true })),
        "the old value still loads"
    );
    let raw: String = conn
        .query_row("SELECT value FROM settings WHERE key = 'legacy'", [], |row| {
            row.get(0)
        })
        .expect("raw value");
    assert_eq!(
        raw,
        crate::secret::marker(),
        "and the reversible row is replaced"
    );
}

#[test]
fn settings_patch_merges_and_resets() {
    let temp = TempDb::new();
    let conn = temp.open();
    let mut settings = Settings::default();
    settings
        .apply_patch(json!({ "accent": "violet", "seekStep": 30 }))
        .unwrap();
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
}

#[test]
fn settings_load_clamps_numbers_and_tolerates_unknown_fields() {
    let temp = TempDb::new();
    let conn = temp.open();
    // A row written by an older build or edited by hand: a field that no longer
    // exists, a skip step of zero and a buffer large enough to overflow the
    // player's megabyte maths.
    db::write_kv(
        &conn,
        "app",
        &json!({
            "accent": "violet",
            "seekStep": 0,
            "homeRowsLimit": -3,
            "bufferForwardValue": i64::MAX,
            "removedInAnEarlierVersion": true
        }),
    )
    .expect("write");

    let settings = Settings::load(&conn);
    assert_eq!(settings.accent, "violet", "a neighbour is not reset");
    assert_eq!(
        settings.seek_step, 1,
        "zero would make the skip buttons dead"
    );
    assert_eq!(settings.home_rows_limit, 1);
    assert_eq!(settings.buffer_forward_value, 65_536);
    assert_eq!(
        settings.buffer_backward_value,
        Settings::default().buffer_backward_value
    );

    // The same clamp applies to a patch that arrives from the frontend.
    let mut patched = Settings::default();
    patched
        .apply_patch(json!({ "bufferForwardValue": 0 }))
        .unwrap();
    assert_eq!(patched.buffer_forward_value, 1);
}

#[test]
fn pruning_drops_stale_playheads_but_keeps_finished_titles() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = |key: &str, name: &str, position: f64| db::ProgressItem {
        key: key.into(),
        meta_id: key.into(),
        media_type: "movie".into(),
        name: name.into(),
        poster: None,
        background: None,
        season: None,
        episode: None,
        episode_title: None,
        position,
        duration: 1000.0,
        updated_at: 0,
    };
    db::save_progress(&conn, &item("tt1", "Abandoned Show", 100.0)).expect("unfinished");
    db::save_progress(&conn, &item("tt2", "Old Film", 1000.0)).expect("finished");
    db::set_watched(&conn, "tt2", "tt2", true).expect("mark");
    conn.execute("UPDATE progress SET updated_at = 1", [])
        .expect("age past a year");
    drop(conn);

    let conn = temp.open();
    assert!(
        db::get_progress(&conn, "tt1").unwrap().is_none(),
        "a stale playhead is noise"
    );
    let watched = db::list_watched_items(&conn).unwrap();
    assert_eq!(watched.len(), 1);
    assert_eq!(
        watched[0].name, "Old Film",
        "the finished row carries the title the Watched list shows"
    );
}

// The tables an older build left behind before the schema was versioned.
const LEGACY_SCHEMA: &str = r#"
CREATE TABLE addons (
  url TEXT PRIMARY KEY, addon_id TEXT NOT NULL, name TEXT NOT NULL,
  manifest TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  position INTEGER NOT NULL DEFAULT 0, installed_at INTEGER NOT NULL
);
CREATE TABLE library (
  id TEXT PRIMARY KEY, media_type TEXT NOT NULL, name TEXT NOT NULL,
  poster TEXT, background TEXT, added_at INTEGER NOT NULL, meta TEXT
);
CREATE TABLE progress (
  key TEXT PRIMARY KEY, meta_id TEXT NOT NULL, media_type TEXT NOT NULL,
  name TEXT NOT NULL, poster TEXT, background TEXT, season INTEGER,
  episode INTEGER, episode_title TEXT, position REAL NOT NULL DEFAULT 0,
  duration REAL NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
);
CREATE TABLE watched (
  key TEXT PRIMARY KEY, meta_id TEXT NOT NULL,
  watched INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL
);
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE people (key TEXT PRIMARY KEY, photo TEXT NOT NULL, checked_at INTEGER NOT NULL);
"#;

#[test]
fn a_legacy_database_keeps_its_rows_through_the_migration() {
    let temp = TempDb::new();
    {
        let raw = rusqlite::Connection::open(temp.path()).expect("raw open");
        raw.execute_batch(LEGACY_SCHEMA).expect("legacy schema");
        let now = db::now();
        raw.execute_batch(&format!(
            "INSERT INTO addons VALUES ('https://old', 'old.id', 'Old', '{{}}', 1, 1, {now});
             INSERT INTO library VALUES ('tt1', 'movie', 'Old Film', 'p.jpg', NULL, {now}, NULL);
             INSERT INTO progress VALUES ('tt1', 'tt1', 'movie', 'Old Film', 'p.jpg', NULL,
                                          NULL, NULL, NULL, 400.0, 1000.0, {now});
             INSERT INTO watched VALUES ('tt2', 'tt2', 1, {now});
             INSERT INTO settings VALUES ('legacy', '{{\"kept\":true}}');
             INSERT INTO people VALUES ('tt1:Jane', 'j.jpg', {now});"
        ))
        .expect("legacy rows");
        let version: i64 = raw
            .query_row("PRAGMA user_version", [], |row| row.get(0))
            .unwrap();
        assert_eq!(version, 0, "the fixture is a pre-versioning database");
    }

    let conn = temp.open();
    let version: i64 = conn
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .unwrap();
    assert_eq!(version, 2, "the migration lands on the current version");

    let addons = db::list_addons(&conn).expect("addons survive");
    assert_eq!(addons.len(), 1);
    assert_eq!(addons[0].name, "Old");
    assert_eq!(db::list_library(&conn).unwrap()[0].name, "Old Film");
    let progress = db::get_progress(&conn, "tt1").unwrap().expect("row kept");
    assert_eq!(progress.position, 400.0);
    assert_eq!(db::list_watched(&conn).unwrap(), vec!["tt2".to_string()]);
    assert_eq!(
        db::read_kv(&conn, "legacy").unwrap(),
        Some(json!({ "kept": true }))
    );
    assert_eq!(
        db::people_photo(&conn, "tt1:Jane").unwrap().as_deref(),
        Some("j.jpg")
    );

    // The old tables only get the indexes, and writes keep working on them.
    db::upsert_addon(&conn, "https://new", "new.id", "New", &json!({}))
        .expect("write after migration");
    assert_eq!(db::list_addons(&conn).unwrap().len(), 2);
    let indexes: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexes, 5, "every index the migration owns exists once");
}

#[test]
fn all_progress_keeps_rows_the_home_row_drops() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = |key: &str, position: f64, duration: f64| db::ProgressItem {
        key: key.into(),
        meta_id: key.into(),
        media_type: "movie".into(),
        name: key.into(),
        poster: None,
        background: None,
        season: None,
        episode: None,
        episode_title: None,
        position,
        duration,
        updated_at: 0,
    };
    db::save_progress(&conn, &item("tt1", 3.0, 1000.0)).expect("barely started");
    db::save_progress(&conn, &item("tt2", 100.0, 1000.0)).expect("normal");
    db::save_progress(&conn, &item("tt3", 50.0, 0.0)).expect("no duration");
    conn.execute("UPDATE progress SET updated_at = 10 WHERE key = 'tt2'", [])
        .unwrap();
    conn.execute("UPDATE progress SET updated_at = 20 WHERE key = 'tt1'", [])
        .unwrap();
    conn.execute("UPDATE progress SET updated_at = 5 WHERE key = 'tt3'", [])
        .unwrap();

    // Sync needs every row, including the ones the home rail hides.
    let all = db::all_progress(&conn).expect("all");
    assert_eq!(all.len(), 3);
    let keys: Vec<&str> = all.iter().map(|p| p.key.as_str()).collect();
    assert_eq!(keys, ["tt1", "tt2", "tt3"], "newest first");
    assert_eq!(db::list_progress(&conn).unwrap().len(), 1);
}

#[test]
fn progress_missing_meta_lists_one_entry_per_title() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = |key: &str, name: &str, poster: Option<&str>| db::ProgressItem {
        key: key.into(),
        meta_id: "tt100".into(),
        media_type: "series".into(),
        name: name.into(),
        poster: poster.map(str::to_string),
        background: None,
        season: Some(1),
        episode: Some(1),
        episode_title: None,
        position: 100.0,
        duration: 1000.0,
        updated_at: 0,
    };
    // Two episodes of a title that arrived with only its id.
    db::save_progress(&conn, &item("tt100:1:1", "tt100", None)).expect("bare id");
    db::save_progress(&conn, &item("tt100:1:2", "", Some(""))).expect("empty name");
    // Already hydrated, and an id that is not a title id at all.
    db::save_progress(&conn, &item("tt200", "Known Show", Some("p.jpg"))).expect("complete");
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "local:1".into(),
            meta_id: "local".into(),
            ..item("ignored", "Local", None)
        },
    )
    .expect("not a title id");

    assert_eq!(
        db::progress_missing_meta(&conn).unwrap(),
        vec![("tt100".to_string(), "series".to_string())]
    );
}

#[test]
fn set_progress_meta_fills_only_the_missing_parts() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = |key: &str, name: &str, poster: Option<&str>, background: Option<&str>| {
        db::ProgressItem {
            key: key.into(),
            meta_id: "tt300".into(),
            media_type: "series".into(),
            name: name.into(),
            poster: poster.map(str::to_string),
            background: background.map(str::to_string),
            season: Some(1),
            episode: Some(1),
            episode_title: None,
            position: 200.0,
            duration: 1000.0,
            updated_at: 0,
        }
    };
    db::save_progress(&conn, &item("tt300:1:1", "tt300", Some(""), None)).expect("bare");
    db::save_progress(
        &conn,
        &item(
            "tt300:1:2",
            "Known Name",
            Some("https://old/p.jpg"),
            Some("https://old/b.jpg"),
        ),
    )
    .expect("complete");

    db::set_progress_meta(
        &conn,
        "tt300",
        "Real Name",
        Some("https://new/p.jpg"),
        Some("https://new/b.jpg"),
    )
    .expect("patch");

    let bare = db::get_progress(&conn, "tt300:1:1").unwrap().unwrap();
    assert_eq!(bare.name, "Real Name");
    assert_eq!(bare.poster.as_deref(), Some("https://new/p.jpg"));
    assert_eq!(bare.background.as_deref(), Some("https://new/b.jpg"));
    assert_eq!(bare.position, 200.0, "the playhead is not touched");

    let complete = db::get_progress(&conn, "tt300:1:2").unwrap().unwrap();
    assert_eq!(complete.name, "Known Name", "an existing name wins");
    assert_eq!(complete.poster.as_deref(), Some("https://old/p.jpg"));
    assert_eq!(complete.background.as_deref(), Some("https://old/b.jpg"));
}

#[test]
fn library_missing_meta_lists_and_patches_bare_rows() {
    let temp = TempDb::new();
    let conn = temp.open();
    let item = |id: &str, name: &str, poster: Option<&str>| db::LibraryItem {
        id: id.into(),
        media_type: "movie".into(),
        name: name.into(),
        poster: poster.map(str::to_string),
        background: None,
        added_at: 0,
        meta: None,
    };
    db::add_to_library(&conn, &item("tt400", "tt400", None)).expect("bare");
    db::add_to_library(&conn, &item("tt401", "Known Film", Some("p.jpg"))).expect("complete");

    assert_eq!(
        db::library_missing_meta(&conn).unwrap(),
        vec![("tt400".to_string(), "movie".to_string())]
    );

    db::set_library_meta(&conn, "tt400", "Real Film", Some("new.jpg"), Some("bg.jpg"))
        .expect("patch");
    let rows = db::list_library(&conn).unwrap();
    let patched = rows.iter().find(|r| r.id == "tt400").unwrap();
    assert_eq!(patched.name, "Real Film");
    assert_eq!(patched.poster.as_deref(), Some("new.jpg"));
    assert_eq!(patched.background.as_deref(), Some("bg.jpg"));
    let kept = rows.iter().find(|r| r.id == "tt401").unwrap();
    assert_eq!(kept.name, "Known Film");
    assert_eq!(kept.poster.as_deref(), Some("p.jpg"));
}

#[test]
fn touched_ids_unions_progress_and_watched() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt1".into(),
            meta_id: "tt1".into(),
            media_type: "movie".into(),
            name: "One".into(),
            poster: None,
            background: None,
            season: None,
            episode: None,
            episode_title: None,
            position: 100.0,
            duration: 1000.0,
            updated_at: 0,
        },
    )
    .expect("progress");
    db::set_watched(&conn, "tt2", "tt2", true).expect("watched");
    db::set_watched(&conn, "tt1", "tt1", true).expect("overlap");

    let mut ids = db::touched_ids(&conn).expect("ids");
    ids.sort();
    assert_eq!(ids, ["tt1", "tt2"], "each title once, from either table");
}

#[test]
fn delete_kv_removes_only_the_named_row() {
    let temp = TempDb::new();
    let conn = temp.open();
    db::write_kv(&conn, "keep", &json!({ "n": 1 })).expect("keep");
    db::write_kv(&conn, "drop", &json!({ "n": 2 })).expect("drop");

    db::delete_kv(&conn, "drop").expect("delete");
    assert_eq!(db::read_kv(&conn, "drop").unwrap(), None);
    assert_eq!(db::read_kv(&conn, "keep").unwrap(), Some(json!({ "n": 1 })));
    db::delete_kv(&conn, "never-written").expect("a missing row is a no-op");
}

#[test]
fn list_addon_urls_follows_the_display_order() {
    let temp = TempDb::new();
    let conn = temp.open();
    for url in ["https://a", "https://b", "https://c"] {
        db::upsert_addon(&conn, url, url, url, &json!({})).expect("insert");
    }
    assert_eq!(
        db::list_addon_urls(&conn).unwrap(),
        ["https://a", "https://b", "https://c"]
    );

    db::move_addon(&conn, "https://c", -1).expect("move");
    assert_eq!(
        db::list_addon_urls(&conn).unwrap(),
        ["https://a", "https://c", "https://b"],
        "the list must match what the UI shows"
    );
}

#[test]
fn hostile_text_roundtrips_through_every_text_column() {
    let temp = TempDb::new();
    let conn = temp.open();
    let long = "x".repeat(100_000);
    let values = [
        "O'Brien \"quoted\"; DROP TABLE settings; --",
        "nul\u{0}byte",
        "日本語 🎬 Ünïcode",
        long.as_str(),
    ];
    for (index, value) in values.iter().enumerate() {
        let key = format!("hostile-{index}");
        db::write_kv(&conn, &key, &json!(value)).expect("write");
        assert_eq!(
            db::read_kv(&conn, &key).unwrap(),
            Some(json!(value)),
            "value {index} must come back unchanged"
        );
    }
    // The quote-heavy value did not end the statement it was bound into.
    db::write_kv(&conn, "after", &json!(1)).expect("table still there");

    db::save_progress(
        &conn,
        &db::ProgressItem {
            key: "tt1".into(),
            meta_id: "tt1".into(),
            media_type: "movie".into(),
            name: values[0].into(),
            poster: None,
            background: None,
            season: None,
            episode: None,
            episode_title: Some(values[2].into()),
            position: 100.0,
            duration: 1000.0,
            updated_at: 0,
        },
    )
    .expect("progress");
    let stored = db::get_progress(&conn, "tt1").unwrap().unwrap();
    assert_eq!(stored.name, values[0]);
    assert_eq!(stored.episode_title.as_deref(), Some(values[2]));

    db::upsert_addon(&conn, "https://hostile", "id", values[2], &json!({}))
        .expect("addon");
    assert_eq!(db::list_addons(&conn).unwrap()[0].name, values[2]);
}

#[test]
fn a_write_waits_for_an_exclusive_lock_instead_of_failing() {
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    let temp = TempDb::new();
    let conn = temp.open();
    let timeout: i64 = conn
        .query_row("PRAGMA busy_timeout", [], |row| row.get(0))
        .unwrap();
    assert!(timeout >= 1000, "the wait comes from a configured timeout");
    let holder_path = temp.path().to_path_buf();
    let (ready, wait_ready) = mpsc::channel();

    let holder = std::thread::spawn(move || {
        let mut other = rusqlite::Connection::open(&holder_path).expect("second connection");
        other
            .execute_batch("PRAGMA busy_timeout = 5000;")
            .expect("pragmas");
        let tx = other.transaction().expect("transaction");
        tx.execute(
            "INSERT INTO settings (key, value) VALUES ('held', '1')",
            [],
        )
        .expect("hold the write lock");
        ready.send(()).expect("signal");
        std::thread::sleep(Duration::from_millis(200));
        tx.commit().expect("release");
    });

    wait_ready.recv().expect("the holder is holding");
    let started = Instant::now();
    db::write_kv(&conn, "writer", &json!(true)).expect("the write must wait, then land");
    let waited = started.elapsed();
    holder.join().expect("holder");

    assert!(
        waited >= Duration::from_millis(150),
        "the write returned in {waited:?} while the lock was held"
    );
    assert_eq!(db::read_kv(&conn, "writer").unwrap(), Some(json!(true)));
    assert_eq!(db::read_kv(&conn, "held").unwrap(), Some(json!(1)));
}