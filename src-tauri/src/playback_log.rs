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

static START: Mutex<Option<Instant>> = Mutex::new(None);
static LAST: Mutex<Option<Instant>> = Mutex::new(None);
static FILE: Mutex<Option<PathBuf>> = Mutex::new(None);
static LINES: Mutex<Vec<String>> = Mutex::new(Vec::new());

const KEEP: usize = 400;

fn lock<T>(slot: &Mutex<T>) -> MutexGuard<'_, T> {
    match slot.lock() {
        Ok(guard) => guard,
        Err(poisoned) => poisoned.into_inner(),
    }
}

/// Point the log at the app data directory. Safe to call on every playback.
pub fn init(dir: &Path) {
    let mut file = lock(&FILE);
    if file.is_some() {
        return;
    }
    let path = dir.join("playback.log");
    if let Ok(meta) = std::fs::metadata(&path) {
        // Keep only the recent history; one session is a handful of lines.
        if meta.len() > 2 * 1024 * 1024 {
            let _ = std::fs::remove_file(&path);
        }
    }
    *lock(&START) = Some(Instant::now());
    *file = Some(path);
}

pub fn mark(label: impl AsRef<str>) {
    let now = Instant::now();
    let total = lock(&START).map(|start| now.duration_since(start).as_secs_f64());
    let gap = lock(&LAST)
        .replace(now)
        .map(|previous| now.duration_since(previous).as_secs_f64());

    let label = label.as_ref();
    let line = match (total, gap) {
        (Some(total), Some(gap)) => format!("T+{total:6.2}s  +{gap:6.3}s  {label}"),
        (Some(total), None) => format!("T+{total:6.2}s  +   ---  {label}"),
        (None, _) => format!("T+  ?.??s  +   ---  {label}"),
    };

    {
        let mut lines = lock(&LINES);
        if lines.len() >= KEEP {
            lines.remove(0);
        }
        lines.push(line.clone());
    }
    eprintln!("[playback] {line}");

    let path = (*lock(&FILE)).clone();
    if let Some(path) = path {
        if let Ok(mut handle) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(handle, "{line}");
        }
    }
}

/// Start a fresh session: the next line begins a new timing run.
pub fn begin(label: impl AsRef<str>) {
    *lock(&LAST) = None;
    mark(label);
}

pub fn recent(limit: usize) -> Vec<String> {
    let lines = lock(&LINES);
    let from = lines.len().saturating_sub(limit);
    lines[from..].to_vec()
}

#[cfg(test)]
mod tests {
    #[test]
    fn lines_carry_a_step_and_a_gap() {
        // A new session starts the clock again instead of inheriting the gap
        // from whatever was logged last.
        super::begin("play requested");
        super::mark("mpv process started");
        let lines = super::recent(2);
        assert_eq!(lines.len(), 2);
        assert!(lines[0].contains("play requested"));
        assert!(lines[1].contains("mpv process started"));
        assert!(lines[1].contains("+"), "second line reports the gap: {lines:?}");
    }
}
