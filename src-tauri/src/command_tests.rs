//! The command bodies, run against a real store instead of a mocked one: the
//! write, the read back and the error mapping are what these check.
use crate::commands::{addons_remove_in, library_toggle_in};
use crate::db::{self, LibraryItem};
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::time::{SystemTime, UNIX_EPOCH};

fn test_store() -> (db::Db, PathBuf) {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = std::env::temp_dir().join(format!("duvy-cmd-{stamp}.db"));
    let connection = db::open(&path).expect("test database opens");
    (db::Db(Mutex::new(connection)), path)
}

fn item() -> LibraryItem {
    LibraryItem {
        id: "tt0111161".into(),
        media_type: "movie".into(),
        name: "The Shawshank Redemption".into(),
        poster: None,
        background: None,
        added_at: 0,
        meta: None,
    }
}

#[test]
fn library_toggle_adds_then_removes() {
    let (store, path) = test_store();
    assert!(library_toggle_in(&store, &item()).expect("toggle on"));
    let listed = db::list_library(&store.conn()).expect("list");
    assert_eq!(listed.len(), 1, "the row reached the store");
    assert_eq!(listed[0].id, "tt0111161");

    assert!(!library_toggle_in(&store, &item()).expect("toggle off"));
    assert!(db::list_library(&store.conn()).expect("list").is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn removing_an_addon_that_was_never_installed_is_a_no_op() {
    let (store, path) = test_store();
    addons_remove_in(&store, "https://example.invalid/manifest.json").expect("no-op");
    assert!(db::list_addons(&store.conn()).expect("list").is_empty());
    let _ = std::fs::remove_file(&path);
}

#[test]
fn a_poisoned_slot_loses_the_dead_value_once_and_keeps_the_next() {
    // The rule the player slot uses, on a payload that needs no mpv.
    let mut slot = Some(7u8);
    let healed = AtomicBool::new(false);
    crate::heal(&mut slot, &healed, "test slot was poisoned");
    assert_eq!(slot, None, "the value from the panicking holder is dropped");

    slot = Some(9);
    crate::heal(&mut slot, &healed, "test slot was poisoned");
    assert_eq!(
        slot,
        Some(9),
        "a value written after recovery is not dropped again"
    );
}
