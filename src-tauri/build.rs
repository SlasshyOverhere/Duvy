use std::path::{Path, PathBuf};

/// Every command the window may invoke. The ACL refuses any other name.
const COMMANDS: &[&str] = &[
    "app_info",
    "net_stats",
    "playback_log",
    "settings_get",
    "settings_set",
    "update_check",
    "update_cached",
    "update_install",
    "addons_list",
    "addons_install",
    "addons_remove",
    "addons_set_enabled",
    "addons_move",
    "addons_refresh",
    "home_feed",
    "catalog",
    "search",
    "meta_details",
    "cast_photos",
    "recommendations",
    "similar",
    "streams",
    "subtitles",
    "parental_guide",
    "library_list",
    "library_toggle",
    "progress_list",
    "progress_for",
    "progress_clear",
    "watched_set",
    "watched_list",
    "watched_marks",
    "watched_keys",
    "player_open",
    "player_state",
    "player_frame",
    "player_control",
    "player_stop",
    "player_subtitle",
    "window_fullscreen",
    "nuvio_status",
    "nuvio_sign_in",
    "nuvio_sign_out",
    "nuvio_set_profile",
    "nuvio_profiles",
    "nuvio_sync_now",
    "stremio_status",
    "stremio_sign_in",
    "stremio_sign_out",
    "stremio_sync_now",
    "sync_all",
    "scrobble",
    "check_cache",
    "skip_get",
    "skip_lookup",
    "skip_set",
    "srv_list",
    "srv_add",
    "srv_remove",
    "srv_items",
    "srv_stream",
    "status",
    "begin",
    "poll",
    "disconnect",
    "sync",
    "providers",
    "set_key",
    "resolve",
];

fn main() {
    // libmpv2-sys emits `rustc-link-lib=mpv`; the import library and the
    // runtime DLL live here, outside git. See scripts/fetch-libmpv.ps1.
    let lib = PathBuf::from("libmpv");
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rerun-if-changed=libmpv/mpv.lib");
    println!("cargo:rerun-if-changed=libmpv/libmpv-2.dll");

    copy_runtime(&lib);
    comctl6_for_tests();

    let attributes = tauri_build::Attributes::new()
        .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS));
    tauri_build::try_build(attributes).expect("failed to run tauri-build");
}

/// Test binaries get no manifest, so ComCtl32 v6 symbols such as
/// `TaskDialogIndirect` fail to bind. The app binary gets its manifest from
/// tauri-build; tests need this link arg. Cargo has no test target here, so
/// `rustc-link-arg-tests` is rejected and the general form is used.
#[cfg(windows)]
fn comctl6_for_tests() {
    println!(
        "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' \
         name='Microsoft.Windows.Common-Controls' version='6.0.0.0' \
         processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
    );
}

#[cfg(not(windows))]
fn comctl6_for_tests() {}

/// Windows resolves the DLL from the executable's folder, so a dev run needs a
/// copy beside the exe. `bundle.resources` does the same for installers.
fn copy_runtime(lib: &Path) {
    let dll = lib.join("libmpv-2.dll");
    if !dll.exists() {
        println!("cargo:warning=libmpv is missing; run scripts/fetch-libmpv.ps1 before building");
        return;
    }
    // OUT_DIR is <target>/<profile>/build/<crate>/out, so the profile dir is
    // three levels up. Shared by debug and release.
    let Some(profile) = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .and_then(|out| out.ancestors().nth(3).map(Path::to_path_buf))
    else {
        println!("cargo:warning=OUT_DIR is not set; skipping the libmpv runtime copy");
        return;
    };
    // An identical copy is left alone: a dev build that is already running
    // holds this DLL open, and rewriting it fails the whole build. A source
    // newer than the copy means the DLL was fetched again, so it is rewritten.
    let dst = profile.join("libmpv-2.dll");
    let up_to_date = match (dll.metadata(), dst.metadata()) {
        (Ok(src), Ok(copy)) => src.len() == copy.len() && copy.modified().ok() >= src.modified().ok(),
        _ => false,
    };
    if !up_to_date {
        if let Err(error) = std::fs::copy(&dll, &dst) {
            println!(
                "cargo:warning=could not copy libmpv-2.dll to {}: {error}",
                dst.display()
            );
        }
    }
}
