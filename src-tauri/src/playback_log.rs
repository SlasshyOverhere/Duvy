//! Playback timing log.
//!
//! One line per step between pressing play and mpv putting a picture on
//! screen: locating mpv, starting the process, connecting the control pipe,
//! handing over the URL, the demuxer opening it and the first frame. Each line
//! carries the time since the play request and the gap since the line above,
//! so a slow source is easy to tell apart from a slow start in the app.
//!
//! Written to `playback.log` next to the database and echoed to the terminal.

use std::{
    fs::OpenOptions,
    io::Write,
    path::{Path, PathBuf},
    sync::{Mutex, MutexGuard},
    time::Instant,
};

const KEEP: usize = 400;
const LIMIT: u64 = 2 * 1024 * 1024;

/// One lock: the clock, the file and the lines move together, so concurrent
/// marks cannot interleave their totals and gaps.
struct Log {
    start: Option<Instant>,
    last: Option<Instant>,
    file: Option<PathBuf>,
    lines: Vec<String>,
    bytes: u64,
}

static LOG: Mutex<Log> = Mutex::new(Log {
    start: None,
    last: None,
    file: None,
    lines: Vec::new(),
    bytes: 0,
});

fn log() -> MutexGuard<'static, Log> {
    match LOG.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Point the log at the app data directory. Safe to call on every playback.
pub fn init(dir: &Path) {
    let mut state = log();
    if state.file.is_some() {
        return;
    }
    let path = dir.join("playback.log");
    let existing = std::fs::metadata(&path).map(|meta| meta.len()).unwrap_or(0);
    // Keep only the recent history; one session is a handful of lines.
    if existing > LIMIT {
        let _ = std::fs::remove_file(&path);
    }
    crate::owner_only(&path);
    state.bytes = if existing > LIMIT { 0 } else { existing };
    state.start = Some(Instant::now());
    state.file = Some(path);
}

pub fn mark(label: impl AsRef<str>) {
    let now = Instant::now();
    // A newline in a label would let one entry forge the next one.
    let label = label.as_ref().replace(['\r', '\n'], " ");
    let mut state = log();
    let total = state.start.map(|start| now.duration_since(start).as_secs_f64());
    let gap = state
        .last
        .replace(now)
        .map(|previous| now.duration_since(previous).as_secs_f64());

    let line = match (total, gap) {
        (Some(total), Some(gap)) => format!("T+{total:6.2}s  +{gap:6.3}s  {label}"),
        (Some(total), None) => format!("T+{total:6.2}s  +   ---  {label}"),
        (None, _) => format!("T+  ?.??s  +   ---  {label}"),
    };

    if state.lines.len() >= KEEP {
        state.lines.remove(0);
    }
    state.lines.push(line.clone());
    eprintln!("[playback] {line}");

    if let Some(path) = state.file.clone()
        && let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(&path)
    {
        let _ = writeln!(handle, "{line}");
    }
    // Rotate here too: a long session never returns to init().
    state.bytes += line.len() as u64 + 1;
    if state.bytes > LIMIT
        && let Some(path) = &state.file
    {
        let _ = std::fs::remove_file(path);
        // Re-created owner-only, not with the umask default.
        crate::owner_only(path);
        state.bytes = 0;
    }
}

/// Start a fresh session: the next line begins a new timing run.
pub fn begin(label: impl AsRef<str>) {
    {
        // Each playback measures from its own request, not from app start.
        let mut state = log();
        state.start = Some(Instant::now());
        state.last = None;
    }
    mark(label);
}

pub fn recent(limit: usize) -> Vec<String> {
    let state = log();
    let from = state.lines.len().saturating_sub(limit);
    state.lines[from..].to_vec()
}

#[cfg(test)]
mod tests {
    use std::sync::{Mutex, MutexGuard};

    /// The log is process-wide, so these tests must not interleave.
    fn serial() -> MutexGuard<'static, ()> {
        static LOCK: Mutex<()> = Mutex::new(());
        match LOCK.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        }
    }

    #[test]
    fn lines_carry_a_step_and_a_gap() {
        let _serial = serial();
        // A new session starts the clock again instead of inheriting the gap
        // from whatever was logged last.
        super::begin("play requested");
        super::mark("mpv process started");
        let lines = super::recent(2);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("play requested"));
        assert!(lines[1].contains("mpv process started"));
        assert!(
            lines[1].contains("+"),
            "second line reports the gap: {lines:?}"
        );
    }

    #[test]
    fn a_label_cannot_forge_another_line() {
        let _serial = serial();
        super::begin("play requested\r\nT+  0.00s  +   ---  fake");
        let lines = super::recent(1);
        assert!(!lines[0].contains('\n'), "label kept a line break: {lines:?}");
        assert!(!lines[0].contains('\r'));
        assert!(lines[0].contains("fake"));
    }

    #[cfg(unix)]
    #[test]
    fn the_log_file_is_owner_only() {
        use std::os::unix::fs::PermissionsExt;

        let _serial = serial();
        let dir = std::env::temp_dir().join(format!("duvy-log-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("playback.log");
        let _ = std::fs::remove_file(&path);
        super::init(&dir);
        super::mark("permission check");
        let mode = std::fs::metadata(&path)
            .expect("log file")
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600, "the log carries stream URLs");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
