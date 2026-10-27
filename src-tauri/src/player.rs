//! Native playback through mpv.
//!
//! Video is decoded by mpv (hardware accelerated, in-process with its own
//! render surface) while BetterNuvio drives it over mpv's JSON IPC socket. The
//! picture is painted into the app window itself and the web layer above it
//! stays transparent, so playback never leaves the window and the WebView stays
//! completely out of the decode path.

use crate::db::{self, ProgressItem};
use crate::models::{MpvInfo, PlaybackSession};
use crate::settings::Settings;
use crate::AppState;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Emitter, Manager};

pub trait Duplex: Read + Write + Send {}
impl<T: Read + Write + Send> Duplex for T {}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: i64,
    pub label: String,
    pub lang: Option<String>,
    pub selected: bool,
    pub external: bool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub playing: bool,
    pub paused: bool,
    pub position: f64,
    pub duration: f64,
    /// Seconds of media buffered ahead of the playhead.
    pub buffered: f64,
    pub title: String,
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    pub ended: bool,
    pub audio_tracks: Vec<Track>,
    pub sub_tracks: Vec<Track>,
    pub active_audio: Option<i64>,
    pub active_sub: Option<i64>,
    pub session: Option<PlaybackSession>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            playing: false,
            paused: false,
            position: 0.0,
            duration: 0.0,
            buffered: 0.0,
            title: String::new(),
            volume: 100.0,
            muted: false,
            speed: 1.0,
            ended: false,
            audio_tracks: Vec::new(),
            sub_tracks: Vec::new(),
            active_audio: None,
            active_sub: None,
            session: None,
        }
    }
}

#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct PlayRequest {
    pub url: String,
    pub title: String,
    #[serde(default)]
    pub start_at: Option<f64>,
    #[serde(default)]
    pub session: Option<PlaybackSession>,
}

pub struct Player {
    child: Child,
    writer: Box<dyn Duplex>,
    snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
    #[cfg_attr(windows, allow(dead_code))]
    pipe: String,
}

// ---------------------------------------------------------------------------
// mpv discovery
// ---------------------------------------------------------------------------

pub fn find_mpv(explicit: &str, resource_dir: Option<&std::path::Path>) -> Option<MpvInfo> {
    let mut candidates: Vec<String> = Vec::new();
    let explicit = explicit.trim();
    if !explicit.is_empty() {
        candidates.push(explicit.to_string());
    }

    // The copy shipped with the installer wins over anything on PATH, so
    // playback does not depend on the user installing mpv themselves.
    if let Some(dir) = resource_dir {
        for relative in ["mpv/mpv.exe", "resources/mpv/mpv.exe"] {
            candidates.push(dir.join(relative).to_string_lossy().to_string());
        }
    }
    candidates.push(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("resources/mpv/mpv.exe")
            .to_string_lossy()
            .to_string(),
    );
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            for relative in ["mpv/mpv.exe", "resources/mpv/mpv.exe"] {
                candidates.push(dir.join(relative).to_string_lossy().to_string());
            }
        }
    }

    #[cfg(windows)]
    {
        candidates.push("mpv".to_string());
        if let Ok(output) = hidden_command("where").arg("mpv").output() {
            for line in String::from_utf8_lossy(&output.stdout).lines() {
                let line = line.trim();
                if !line.is_empty() {
                    candidates.push(line.to_string());
                }
            }
        }
        let local = std::env::var("LOCALAPPDATA").unwrap_or_default();
        let program_files = std::env::var("PROGRAMFILES").unwrap_or_default();
        let user_profile = std::env::var("USERPROFILE").unwrap_or_default();
        for path in [
            format!("{program_files}\\mpv\\mpv.exe"),
            format!("{local}\\Programs\\mpv\\mpv.exe"),
            format!("{local}\\Microsoft\\WinGet\\Links\\mpv.exe"),
            format!("{user_profile}\\scoop\\shims\\mpv.exe"),
            format!("{user_profile}\\scoop\\apps\\mpv\\current\\mpv.exe"),
            "C:\\mpv\\mpv.exe".to_string(),
        ] {
            candidates.push(path);
        }
    }

    #[cfg(unix)]
    {
        candidates.push("mpv".to_string());
        for path in ["/usr/bin/mpv", "/usr/local/bin/mpv", "/opt/homebrew/bin/mpv"] {
            candidates.push(path.to_string());
        }
    }

    candidates.into_iter().find_map(|candidate| probe_mpv(&candidate))
}

/// Spawn without flashing a console window on Windows.
fn hidden_command(program: &str) -> Command {
    #[allow(unused_mut)]
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000);
    }
    command
}

fn probe_mpv(path: &str) -> Option<MpvInfo> {
    let output = hidden_command(path).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout)
        .lines()
        .next()
        .unwrap_or("mpv")
        .trim()
        .to_string();
    Some(MpvInfo {
        path: path.to_string(),
        version,
    })
}

// ---------------------------------------------------------------------------
// IPC plumbing
// ---------------------------------------------------------------------------

fn pipe_name() -> String {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    #[cfg(windows)]
    {
        format!(r"\\.\pipe\betternuvio-{}-{stamp}", std::process::id())
    }
    #[cfg(unix)]
    {
        format!("/tmp/betternuvio-{}-{stamp}.sock", std::process::id())
    }
}

fn connect_pipe(name: &str) -> std::io::Result<(Box<dyn Duplex>, Box<dyn Duplex>)> {
    #[cfg(windows)]
    {
        let reader = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(name)?;
        let writer = reader.try_clone()?;
        Ok((Box::new(reader), Box::new(writer)))
    }
    #[cfg(unix)]
    {
        let reader = std::os::unix::net::UnixStream::connect(name)?;
        let writer = reader.try_clone()?;
        Ok((Box::new(reader), Box::new(writer)))
    }
}

fn send(writer: &mut Box<dyn Duplex>, command: Value) -> Result<(), String> {
    let mut payload = serde_json::to_string(&command).map_err(|e| e.to_string())?;
    payload.push('\n');
    writer
        .write_all(payload.as_bytes())
        .and_then(|_| writer.flush())
        .map_err(|e| format!("mpv IPC write failed: {e}"))
}

fn number_value(value: Option<&Value>, what: &str) -> Result<f64, String> {
    value
        .and_then(Value::as_f64)
        .filter(|number| number.is_finite())
        .ok_or_else(|| format!("{what} must be a number"))
}

/// mpv colours are `#RRGGBB` or `#AARRGGBB`.
fn color_value<'a>(value: Option<&'a Value>, what: &str) -> Result<&'a str, String> {
    let text = value.and_then(Value::as_str).map(str::trim).unwrap_or_default();
    let digits = text.strip_prefix('#').unwrap_or_default();
    if matches!(digits.len(), 6 | 8) && digits.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(text);
    }
    Err(format!("{what} must be a #RRGGBB or #AARRGGBB colour"))
}

fn parse_tracks(value: &Value) -> (Vec<Track>, Vec<Track>, Option<i64>, Option<i64>) {
    let mut audio = Vec::new();
    let mut subs = Vec::new();
    let mut active_audio = None;
    let mut active_sub = None;
    if let Some(list) = value.as_array() {
        for track in list {
            let kind = track.get("type").and_then(|v| v.as_str()).unwrap_or("");
            if kind != "audio" && kind != "sub" {
                continue;
            }
            let id = track.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            let lang = track
                .get("lang")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let title = track
                .get("title")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let label = title
                .or_else(|| lang.clone())
                .unwrap_or_else(|| if kind == "audio" { "Audio".into() } else { "Subtitle".into() });
            let selected = track
                .get("selected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let external = track
                .get("external")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let entry = Track {
                id,
                label,
                lang,
                selected,
                external,
            };
            if kind == "audio" {
                if selected {
                    active_audio = Some(id);
                }
                audio.push(entry);
            } else {
                if selected {
                    active_sub = Some(id);
                }
                subs.push(entry);
            }
        }
    }
    (audio, subs, active_audio, active_sub)
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

impl Player {
    pub fn spawn(
        app: AppHandle,
        settings: &Settings,
        request: &PlayRequest,
        host: Option<isize>,
        resource_dir: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        let mpv = find_mpv(&settings.mpv_path, resource_dir).ok_or_else(|| {
            "mpv was not found. Reinstall BetterNuvio, or point it at an mpv.exe in Settings → Playback."
                .to_string()
        })?;

        crate::playback_log::mark(format!("mpv found: {}", mpv.path));

        let pipe = pipe_name();
        let mut command = hidden_command(&mpv.path);
        // Keep a log next to the database: when a stream refuses to play on a
        // user's machine this is the only window into mpv's decision making.
        let mut stderr_sink = None;
        if let Ok(dir) = app.path().app_data_dir() {
            let _ = std::fs::create_dir_all(&dir);
            command.arg(format!("--log-file={}", dir.join("mpv.log").display()));
            if let Ok(file) = std::fs::File::create(dir.join("mpv-stderr.log")) {
                stderr_sink = Some(file);
            }
        }
        command
            .arg("--no-config")
            .arg(format!("--input-ipc-server={pipe}"))
            .arg("--idle=yes")
            .arg("--keep-open=no")
            .arg("--save-position-on-quit=no")
            .arg("--osd-level=1")
            .arg("--osd-font-size=34")
            .arg("--osd-duration=2500")
            .arg("--sub-font-size=46")
            .arg("--sub-auto=fuzzy")
            .arg("--sub-visibility=yes")
            .arg("--volume=100")
            .arg("--volume-max=200")
            .arg("--cache=yes")
            .arg("--demuxer-max-bytes=256MiB")
            .arg("--demuxer-readahead-secs=30")
            .arg("--network-timeout=20")
            .arg(format!(
                "--alang={},en,english",
                settings.audio_language.trim()
            ))
            .arg(format!(
                "--slang={},en,english",
                settings.subtitle_language.trim()
            ))
            .arg(format!(
                "--hwdec={}",
                if settings.hardware_decoding {
                    "auto-safe"
                } else {
                    "no"
                }
            ))
            // Pin the picture pipeline instead of relying on whatever the mpv
            // build picks as defaults: libplacebo renders, maps HDR and Dolby
            // Vision to the panel's real range (SDR included) and dithers the
            // result, and every codec the GPU can decode is offloaded.
            .arg("--vo=gpu-next")
            .arg("--hwdec-codecs=all")
            .arg("--tone-mapping=bt.2390")
            .arg("--hdr-compute-peak=yes")
            .arg("--dither-depth=auto")
            // mpv 0.40+ dropped space-separated values for these two.
            .arg(format!("--force-media-title={}", request.title))
            .arg("--user-agent=Mozilla/5.0 BetterNuvio/0.1")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(match stderr_sink {
                Some(file) => Stdio::from(file),
                None => Stdio::null(),
            });

        // Resume is a launch option, not a loadfile one: mpv answers
        // `loadfile url replace "start=..."` with "invalid parameter", which
        // aborted the whole open whenever a saved position existed.
        if let Some(start) = request.start_at.filter(|value| *value > 5.0) {
            command.arg(format!("--start={start:.3}"));
        }

        match host {
            Some(wid) => {
                // mpv paints straight into the app window's client area, and the
                // transparent web layer above it draws the controls. Everything
                // mpv would normally draw around the picture is turned off so
                // there is exactly one UI.
                command
                    .arg(format!("--wid={wid}"))
                    .arg("--no-border")
                    .arg("--osc=no")
                    .arg("--osd-bar=no")
                    .arg("--input-vo-keyboard=no")
                    .arg("--input-default-bindings=no")
                    .arg("--stop-screensaver=yes");
            }
            None => {
                // Fallback: a normal mpv window, still driven over IPC.
                command
                    .arg("--force-window=yes")
                    .arg("--osc=yes")
                    .arg("--autofit-larger=90%x90%")
                    .arg("--title=BetterNuvio");
            }
        }

        let mut child = command
            .spawn()
            .map_err(|e| format!("Could not start mpv at {}: {e}", mpv.path))?;
        crate::playback_log::mark(format!("mpv process started (pid {})", child.id()));

        // A failure below used to return with the child still alive: mpv keeps
        // painting over the app window with nobody driving it, and every retry
        // leaks another process. Any early return kills it first.
        macro_rules! give_up {
            ($error:expr) => {{
                crate::playback_log::mark(format!("playback failed: {}", $error));
                let _ = child.kill();
                let _ = child.wait();
                return Err($error);
            }};
        }


        // mpv creates the IPC server asynchronously; give it a moment.
        let mut connected = None;
        let mut attempts = 0u32;
        for _ in 0..60 {
            attempts += 1;
            match connect_pipe(&pipe) {
                Ok(pair) => {
                    connected = Some(pair);
                    break;
                }
                Err(_) => thread::sleep(Duration::from_millis(50)),
            }
        }
        let (reader, mut writer) = match connected {
            Some(pair) => {
                crate::playback_log::mark(format!(
                    "control pipe ready after {attempts} attempt(s)"
                ));
                pair
            }
            None => give_up!("mpv started but its IPC socket never became available.".to_string()),
        };

        // Esc leaves playback and hands the app window back.
        let _ = send(&mut writer, json!({"command": ["keybind", "ESC", "quit"]}));

        for (id, property) in [
            (1, "time-pos"),
            (2, "duration"),
            (3, "pause"),
            (4, "volume"),
            (5, "mute"),
            (6, "speed"),
            (7, "track-list"),
            (8, "eof-reached"),
            (9, "media-title"),
            (10, "demuxer-cache-time"),
        ] {
            if let Err(error) = send(
                &mut writer,
                json!({"command": ["observe_property", id, property]}),
            ) {
                give_up!(error);
            }
        }

        let start = request.start_at.unwrap_or(0.0);
        let load = json!({"command": ["loadfile", request.url, "replace"]});
        crate::playback_log::mark(format!("handing the URL to mpv (start at {start:.1}s)"));
        if let Err(error) = send(&mut writer, load) {
            give_up!(error);
        }
        if let Err(error) = send(
            &mut writer,
            json!({"command": ["set_property", "pause", false]}),
        ) {
            give_up!(error);
        }
        crate::playback_log::mark("waiting for the first frame");

        let snapshot = Snapshot {
            playing: true,
            title: request.title.clone(),
            session: request.session.clone(),
            ..Default::default()
        };

        let snapshot = Arc::new(Mutex::new(snapshot));
        let stop = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Mutex::new(request.session.clone()));

        spawn_reader(
            app.clone(),
            reader,
            Arc::clone(&snapshot),
            Arc::clone(&stop),
        );
        spawn_ticker(
            app,
            Arc::clone(&snapshot),
            Arc::clone(&stop),
            session,
            host,
        );

        Ok(Self {
            child,
            writer,
            snapshot,
            stop,
            pipe,
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn command(&mut self, action: &str, value: Option<Value>) -> Result<(), String> {
        match action {
            "toggle-pause" => send(&mut self.writer, json!({"command": ["cycle", "pause"]})),
            "seek" => {
                let position = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "time-pos", position]}),
                )
            }
            "seek-rel" => {
                let delta = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
                send(
                    &mut self.writer,
                    json!({"command": ["seek", delta, "relative"]}),
                )
            }
            "volume" => {
                let volume = value.and_then(|v| v.as_f64()).unwrap_or(100.0);
                send(&mut self.writer, json!({"command": ["set_property", "volume", volume]}))
            }
            "mute" => send(&mut self.writer, json!({"command": ["cycle", "mute"]})),
            "speed" => {
                let speed = value.and_then(|v| v.as_f64()).unwrap_or(1.0);
                send(&mut self.writer, json!({"command": ["set_property", "speed", speed]}))
            }
            "audio" => {
                let id = value.and_then(|v| v.as_i64());
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "aid", id.map(Value::from).unwrap_or_else(|| json!("no"))]}),
                )
            }
            "sub" => {
                let id = value.and_then(|v| v.as_i64());
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "sid", id.map(Value::from).unwrap_or_else(|| json!("no"))]}),
                )
            }
            "sub-font-size" => {
                let size = number_value(value.as_ref(), "Subtitle font size")?;
                if !(10.0..=200.0).contains(&size) {
                    return Err("Subtitle font size must be between 10 and 200".into());
                }
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "sub-font-size", size]}),
                )
            }
            "sub-color" => {
                let color = color_value(value.as_ref(), "Subtitle colour")?;
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "sub-color", color]}),
                )
            }
            "sub-back-color" => {
                let color = color_value(value.as_ref(), "Subtitle background")?;
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "sub-back-color", color]}),
                )
            }
            "sub-delay" => {
                let delay = number_value(value.as_ref(), "Subtitle delay")?;
                send(
                    &mut self.writer,
                    json!({"command": ["set_property", "sub-delay", delay]}),
                )
            }
            "sub-add" => {
                let url = value
                    .as_ref()
                    .and_then(|v| v.get("url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .to_string();
                let label = value
                    .as_ref()
                    .and_then(|v| v.get("label"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("Subtitle")
                    .to_string();
                if url.is_empty() {
                    return Err("No subtitle URL supplied".into());
                }
                send(
                    &mut self.writer,
                    json!({"command": ["sub-add", url, "select", label]}),
                )
            }
            "stop" => {
                let _ = send(&mut self.writer, json!({"command": ["quit"]}));
                Ok(())
            }
            other => Err(format!("Unknown player action: {other}")),
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        // Terminate mpv directly. A graceful `quit` over the IPC pipe can
        // block forever if mpv's IPC thread is parked (after end-of-file, for
        // instance), and dropping a player must never freeze the UI.
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.child.kill();
        let _ = self.child.wait();

        #[cfg(unix)]
        {
            let _ = std::fs::remove_file(&self.pipe);
        }
    }
}

fn spawn_reader(
    app: AppHandle,
    reader: Box<dyn Duplex>,
    snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
) {
    thread::spawn(move || {
        let buffered = BufReader::new(reader);
        for line in buffered.lines() {
            if stop.load(Ordering::Relaxed) {
                break;
            }
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            let event = value.get("event").and_then(|v| v.as_str()).unwrap_or("");
            match event {
                "property-change" => {
                    let name = value.get("name").and_then(|v| v.as_str()).unwrap_or("");
                    let data = value.get("data").cloned().unwrap_or(Value::Null);
                    let mut snap = match snapshot.lock() {
                        Ok(snap) => snap,
                        Err(_) => break,
                    };
                    match name {
                        "time-pos" => {
                            if let Some(position) = data.as_f64() {
                                snap.position = position;
                            }
                        }
                        "duration" => {
                            if let Some(duration) = data.as_f64() {
                                snap.duration = duration;
                            }
                        }
                        "demuxer-cache-time" => {
                            snap.buffered = data.as_f64().unwrap_or(0.0);
                        }
                        "pause" => snap.paused = data.as_bool().unwrap_or(false),
                        "volume" => {
                            if let Some(volume) = data.as_f64() {
                                snap.volume = volume;
                            }
                        }
                        "mute" => snap.muted = data.as_bool().unwrap_or(false),
                        "speed" => {
                            if let Some(speed) = data.as_f64() {
                                snap.speed = speed;
                            }
                        }
                        "media-title" => {
                            if let Some(title) = data.as_str() {
                                if !title.is_empty() {
                                    snap.title = title.to_string();
                                }
                            }
                        }
                        "eof-reached" => {
                            if data.as_bool().unwrap_or(false) {
                                snap.ended = true;
                                snap.paused = true;
                            }
                        }
                        "track-list" => {
                            let (audio, subs, active_audio, active_sub) = parse_tracks(&data);
                            snap.audio_tracks = audio;
                            snap.sub_tracks = subs;
                            snap.active_audio = active_audio;
                            snap.active_sub = active_sub;
                        }
                        _ => {}
                    }
                    drop(snap);
                }
                "file-loaded" => {
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.playing = true;
                        snap.paused = false;
                        snap.ended = false;
                    }
                    crate::playback_log::mark("demuxer opened the stream");
                }
                "end-file" => {
                    let reason = value
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.playing = false;
                        snap.ended = reason == "eof" || snap.ended;
                    }
                    crate::playback_log::mark(format!("stream ended ({reason})"));
                    let _ = app.emit("player:ended", reason.to_string());
                }
                _ => {}
            }
        }
        if let Ok(mut snap) = snapshot.lock() {
            snap.playing = false;
        }
        // The pipe is gone, so the ticker has nothing left to report. Without
        // this it keeps emitting ticks for a player that no longer exists.
        stop.store(true, Ordering::Relaxed);
        crate::playback_log::mark("control pipe closed");
        let _ = app.emit("player:closed", ());
    });
}

fn spawn_ticker(
    app: AppHandle,
    snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
    session: Arc<Mutex<Option<PlaybackSession>>>,
    host: Option<isize>,
) {
    thread::spawn(move || {
        let mut ticks: u64 = 0;
        let mut started = false;
        while !stop.load(Ordering::Relaxed) {
            thread::sleep(Duration::from_millis(500));
            if stop.load(Ordering::Relaxed) {
                break;
            }
            ticks += 1;
            // mpv adds its render window a moment after start-up; keep the web
            // layer above it until the window tree settles.
            if let Some(host) = host {
                if ticks <= 8 {
                    crate::raise_webview(host);
                }
            }
            let snap = match snapshot.lock() {
                Ok(snap) => snap.clone(),
                Err(_) => break,
            };
            // The first tick with a real position is the moment the picture
            // exists; everything before it is the source being slow.
            if !started && snap.position > 0.0 {
                started = true;
                crate::playback_log::mark(format!("first frame at {:.2}s", snap.position));
            }
            let _ = app.emit("player:tick", &snap);
            if ticks % 10 == 0 {
                let session = match session.lock() {
                    Ok(guard) => guard.clone(),
                    Err(_) => None,
                };
                persist(&app, &snap, session.as_ref());
            }
        }
        // Final save when the window closes.
        if let Ok(snap) = snapshot.lock() {
            let session = session.lock().ok().and_then(|guard| guard.clone());
            persist(&app, &snap.clone(), session.as_ref());
        }
    });
}

fn persist(app: &AppHandle, snap: &Snapshot, session: Option<&PlaybackSession>) {
    let Some(session) = session else { return };
    if session.key.is_empty() || snap.duration <= 0.0 || snap.position <= 5.0 {
        return;
    }
    let state = app.state::<AppState>();
    let Ok(conn) = state.db.0.lock() else { return };
    let settings = Settings::load(&conn);
    if !settings.track_progress {
        return;
    }
    if snap.position / snap.duration >= 0.92 {
        let _ = db::set_watched(&conn, &session.key, &session.meta_id, true);
    }
    // Keep the row at completion: it carries the name, poster and episode the
    // Watched list shows. Continue watching excludes >=90% rows on its own.
    let item = ProgressItem {
        key: session.key.clone(),
        meta_id: session.meta_id.clone(),
        media_type: session.media_type.clone(),
        name: session.name.clone(),
        poster: session.poster.clone(),
        background: session.background.clone(),
        season: session.season,
        episode: session.episode,
        episode_title: session.episode_title.clone(),
        position: snap.position,
        duration: snap.duration,
        updated_at: db::now(),
    };
    let _ = db::save_progress(&conn, &item);
}

#[cfg(test)]
mod tests {
    use super::{color_value, number_value};
    use serde_json::json;

    #[test]
    fn subtitle_values_are_validated() {
        let color = json!("#a1b2c3");
        assert_eq!(color_value(Some(&color), "c").unwrap(), "#a1b2c3");
        let with_alpha = json!("#80000000");
        assert!(color_value(Some(&with_alpha), "c").is_ok());
        assert!(color_value(Some(&json!("red")), "c").is_err());
        assert!(color_value(None, "c").is_err());

        let delay = json!(-0.4);
        assert_eq!(number_value(Some(&delay), "d").unwrap(), -0.4);
        assert!(number_value(Some(&json!("0.4")), "d").is_err());
        assert!(number_value(None, "d").is_err());
    }
}
