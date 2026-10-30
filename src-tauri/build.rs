use std::path::{Path, PathBuf};

fn main() {
    // libmpv2-sys emits `rustc-link-lib=mpv`; the import library and the
    // runtime DLL live here, outside git. See scripts/fetch-libmpv.ps1.
    let lib = PathBuf::from("libmpv");
    println!("cargo:rustc-link-search=native={}", lib.display());
    println!("cargo:rerun-if-changed=libmpv/mpv.lib");
    println!("cargo:rerun-if-changed=libmpv/libmpv-2.dll");

    copy_runtime(&lib);

    tauri_build::build()
}

/// Windows resolves the DLL from the executable's folder, so a dev run needs a
/// copy beside the exe. `bundle.resources` does the same for installers.
fn copy_runtime(lib: &Path) {
    let dll = lib.join("libmpv-2.dll");
    if !dll.exists() {
        println!(
            "cargo:warning=libmpv is missing; run scripts/fetch-libmpv.ps1 before building"
        );
        return;
    }
    // OUT_DIR is <target>/<profile>/build/<crate>/out, so the profile dir is
    // three levels up. Shared by debug and release.
    let Some(profile) = std::env::var_os("OUT_DIR")
        .map(PathBuf::from)
        .and_then(|out| out.ancestors().nth(3).map(Path::to_path_buf))
    else {
        return;
    };
    let _ = std::fs::copy(&dll, profile.join("libmpv-2.dll"));
}
