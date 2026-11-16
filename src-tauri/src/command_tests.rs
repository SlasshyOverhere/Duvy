//! The command bodies, run against a real store instead of a mocked one: the
//! write, the read back and the error mapping are what these check.
use crate::commands::{addons_remove_in, library_toggle_in};
use crate::db::{self, LibraryItem};
use crate::{player_slot, AppState, PlayerSlot};
use serde_json::json;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Mutex, RwLock};

/// A temp database file that removes itself, including the WAL sidecars.
struct TempDb {
    path: PathBuf,
}

impl TempDb {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let id = NEXT.fetch_add(1, Ordering::Relaxed);
        Self {
            path: std::env::temp_dir().join(format!("duvy-cmd-{}-{id}.db", std::process::id())),
        }
    }

    fn path(&self) -> &Path {
        &self.path
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

fn test_store() -> (db::Db, TempDb) {
    let temp = TempDb::new();
    let connection = db::open(temp.path()).expect("test database opens");
    (db::Db(Mutex::new(connection)), temp)
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
    let (store, _temp) = test_store();
    assert!(library_toggle_in(&store, &item()).expect("toggle on"));
    let listed = db::list_library(&store.conn()).expect("list");
    assert_eq!(listed.len(), 1, "the row reached the store");
    assert_eq!(listed[0].id, "tt0111161");

    assert!(!library_toggle_in(&store, &item()).expect("toggle off"));
    assert!(db::list_library(&store.conn()).expect("list").is_empty());
}

#[test]
fn removing_an_addon_that_was_never_installed_is_a_no_op() {
    let (store, _temp) = test_store();
    addons_remove_in(&store, "https://example.invalid/manifest.json").expect("no-op");
    assert!(db::list_addons(&store.conn()).expect("list").is_empty());
}

#[test]
fn removing_an_installed_addon_empties_the_list() {
    let (store, _temp) = test_store();
    let url = "https://example.test/manifest.json";
    db::upsert_addon(
        &store.conn(),
        url,
        "com.example.test",
        "Test Addon",
        &json!({ "id": "com.example.test" }),
    )
    .expect("install");
    assert_eq!(db::list_addons(&store.conn()).unwrap().len(), 1);

    addons_remove_in(&store, url).expect("remove");
    assert!(db::list_addons(&store.conn()).unwrap().is_empty());
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

#[test]
fn player_slot_recovers_from_a_real_poisoned_lock() {
    let temp = TempDb::new();
    let state = AppState {
        db: db::Db(Mutex::new(db::open(temp.path()).expect("database opens"))),
        http: reqwest::Client::new(),
        player: PlayerSlot::new(),
        settings: RwLock::new(None),
    };

    let core = &state.player.core;
    let panicked = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let _guard = core.lock().expect("the lock is fresh");
        panic!("simulated player panic");
    }));
    assert!(panicked.is_err(), "the holder really panicked");
    assert!(core.is_poisoned(), "and the mutex really is poisoned");

    let guard = player_slot(&state);
    assert!(guard.is_none(), "the dead core is dropped, not handed out");
    assert!(
        state.player.healed.load(Ordering::Relaxed),
        "the slot records that it healed"
    );
    drop(guard);

    // Poison is sticky: later locks take the same path and must not panic.
    assert!(player_slot(&state).is_none());
    assert_eq!(db::list_library(&state.db.conn()).unwrap().len(), 0);
}
