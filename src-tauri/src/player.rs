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
    /// Channels and codec, e.g. "5.1 · Dolby Digital".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub details: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Chapter {
    pub start: f64,
    pub title: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub playing: bool,
    pub paused: bool,
    /// True once mpv reported a position, so the picture exists.
    pub started: bool,
    pub position: f64,
    pub duration: f64,
    /// Seconds of media buffered ahead of the playhead.
    pub buffered: f64,
    pub title: String,
    pub volume: f64,
    pub muted: bool,
    pub speed: f64,
    pub ended: bool,
    /// Set when mpv cannot open or continue the source.
    pub error: Option<String>,
    pub audio_tracks: Vec<Track>,
    pub sub_tracks: Vec<Track>,
    pub active_audio: Option<i64>,
    pub active_sub: Option<i64>,
    pub chapters: Vec<Chapter>,
    pub session: Option<PlaybackSession>,
}

impl Default for Snapshot {
    fn default() -> Self {
        Self {
            playing: false,
            paused: false,
            started: false,
            position: 0.0,
            duration: 0.0,
            buffered: 0.0,
            title: String::new(),
            volume: 100.0,
            muted: false,
            speed: 1.0,
            ended: false,
            error: None,
            audio_tracks: Vec::new(),
            sub_tracks: Vec::new(),
            active_audio: None,
            active_sub: None,
            chapters: Vec::new(),
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
    writer: Arc<Mutex<Box<dyn Duplex>>>,
    snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    session: Arc<Mutex<Option<PlaybackSession>>>,
    /// The final save must run once, whichever of kill and drop comes first.
    final_saved: AtomicBool,
    /// Exactly what mpv was handed, so frame previews decode the same stream.
    source: String,
    #[cfg_attr(windows, allow(dead_code))]
    pipe: String,
}

// ---------------------------------------------------------------------------
// mpv discovery
// ---------------------------------------------------------------------------

pub fn find_mpv(explicit: &str, resource_dir: Option<&std::path::Path>) -> Option<MpvInfo> {
    // Probing spawns `mpv --version`; a seek-hover preview asks constantly, so
    // one answer per (explicit path, resource dir) is cached.
    static CACHE: Mutex<Option<(String, Option<MpvInfo>)>> = Mutex::new(None);
    let explicit = explicit.trim();
    let key = format!(
        "{explicit}\u{1}{}",
        resource_dir
            .map(|dir| dir.to_string_lossy().to_string())
            .unwrap_or_default()
    );
    if let Ok(cache) = CACHE.lock() {
        if let Some((seen, found)) = cache.as_ref() {
            if *seen == key {
                return found.clone();
            }
        }
    }
    let found = locate_mpv(explicit, resource_dir);
    if let Ok(mut cache) = CACHE.lock() {
        *cache = Some((key, found.clone()));
    }
    found
}

/// Detection ignores the cache: mpv may have been installed since the last try.
pub fn detect_mpv(explicit: &str, resource_dir: Option<&std::path::Path>) -> Option<MpvInfo> {
    locate_mpv(explicit.trim(), resource_dir)
}

fn locate_mpv(explicit: &str, resource_dir: Option<&std::path::Path>) -> Option<MpvInfo> {
    let mut candidates: Vec<String> = Vec::new();
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

fn bool_value(value: Option<&Value>, what: &str) -> Result<bool, String> {
    value
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("{what} must be true or false"))
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
                .map(str::trim)
                .filter(|s| !s.is_empty() && !s.eq_ignore_ascii_case("und"))
                .map(|s| s.to_string());
            let title = track
                .get("title")
                .and_then(|v| v.as_str())
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string());
            let selected = track
                .get("selected")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let external = track
                .get("external")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let label = track_label(
                kind,
                if kind == "audio" { audio.len() } else { subs.len() },
                title.as_deref(),
                lang.as_deref(),
            );
            let details = track_details(
                kind,
                &label,
                track.get("codec").and_then(|v| v.as_str()),
                track.get("demux-channels").and_then(|v| v.as_str()),
                track
                    .get("demux-channel-count")
                    .and_then(|v| v.as_i64())
                    .unwrap_or(0),
            );
            let entry = Track {
                id,
                label,
                lang,
                selected,
                external,
                details,
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

/// mpv reports tracks as `eng`, `en`, `English` or `und`; all become a name.
fn language_name(code: &str) -> Option<&'static str> {
    let raw = code.trim().to_lowercase();
    let primary = raw.split(['-', '_', '.', '/']).next().unwrap_or("");
    Some(match primary {
        "en" | "eng" | "english" => "English",
        "hi" | "hin" | "hindi" => "Hindi",
        "ta" | "tam" | "tamil" => "Tamil",
        "te" | "tel" | "telugu" => "Telugu",
        "ml" | "mal" | "malayalam" => "Malayalam",
        "kn" | "kan" | "kannada" => "Kannada",
        "bn" | "ben" | "bengali" => "Bengali",
        "mr" | "mar" | "marathi" => "Marathi",
        "pa" | "pan" | "pun" | "punjabi" => "Punjabi",
        "ur" | "urd" | "urdu" => "Urdu",
        "ar" | "ara" | "arabic" => "Arabic",
        "fa" | "fas" | "per" | "persian" => "Persian",
        "es" | "spa" | "spanish" => "Spanish",
        "fr" | "fra" | "fre" | "french" => "French",
        "de" | "deu" | "ger" | "german" => "German",
        "it" | "ita" | "italian" => "Italian",
        "pt" | "por" | "portuguese" => "Portuguese",
        "ru" | "rus" | "russian" => "Russian",
        "ja" | "jpn" | "japanese" => "Japanese",
        "ko" | "kor" | "korean" => "Korean",
        "zh" | "zho" | "chi" | "chinese" => "Chinese",
        "tr" | "tur" | "turkish" => "Turkish",
        "pl" | "pol" | "polish" => "Polish",
        "nl" | "nld" | "dut" | "dutch" => "Dutch",
        "sv" | "swe" | "swedish" => "Swedish",
        "no" | "nor" | "norwegian" => "Norwegian",
        "da" | "dan" | "danish" => "Danish",
        "fi" | "fin" | "finnish" => "Finnish",
        "cs" | "ces" | "cze" | "czech" => "Czech",
        "sk" | "slk" | "slo" | "slovak" => "Slovak",
        "hu" | "hun" | "hungarian" => "Hungarian",
        "uk" | "ukr" | "ukrainian" => "Ukrainian",
        "he" | "heb" | "hebrew" => "Hebrew",
        "el" | "ell" | "gre" | "greek" => "Greek",
        "ro" | "ron" | "rum" | "romanian" => "Romanian",
        "th" | "tha" | "thai" => "Thai",
        "vi" | "vie" | "vietnamese" => "Vietnamese",
        "id" | "ind" | "indonesian" => "Indonesian",
        "ms" | "msa" | "may" | "malay" => "Malay",
        "fil" | "tgl" | "filipino" => "Filipino",
        "is" | "isl" | "ice" | "icelandic" => "Icelandic",
        "hr" | "hrv" | "croatian" => "Croatian",
        "sr" | "srp" | "serbian" => "Serbian",
        "bg" | "bul" | "bulgarian" => "Bulgarian",
        "sl" | "slv" | "slovenian" => "Slovenian",
        "et" | "est" | "estonian" => "Estonian",
        "lv" | "lav" | "latvian" => "Latvian",
        "lt" | "lit" | "lithuanian" => "Lithuanian",
        "ca" | "cat" | "catalan" => "Catalan",
        "eu" | "eus" | "baq" | "basque" => "Basque",
        "gl" | "glg" | "galician" => "Galician",
        "af" | "afr" | "afrikaans" => "Afrikaans",
        "sw" | "swa" | "swahili" => "Swahili",
        "zu" | "zul" | "zulu" => "Zulu",
        "am" | "amh" | "amharic" => "Amharic",
        "ne" | "nep" | "nepali" => "Nepali",
        "si" | "sin" | "sinhala" => "Sinhala",
        "km" | "khm" | "khmer" => "Khmer",
        "lo" | "lao" => "Lao",
        "my" | "mya" | "bur" | "burmese" => "Burmese",
        "ka" | "kat" | "geo" | "georgian" => "Georgian",
        "hy" | "hye" | "arm" | "armenian" => "Armenian",
        "az" | "aze" | "azerbaijani" => "Azerbaijani",
        "kk" | "kaz" | "kazakh" => "Kazakh",
        "uz" | "uzb" | "uzbek" => "Uzbek",
        _ => return None,
    })
}

/// Falls back to the raw code so an unmapped language is never hidden.
fn language_display(code: &str) -> String {
    if let Some(name) = language_name(code) {
        return name.to_string();
    }
    let raw = code.trim();
    if raw.len() <= 3 {
        raw.to_uppercase()
    } else {
        raw.to_string()
    }
}

fn codec_name(codec: &str) -> Option<String> {
    let raw = codec.trim();
    if raw.is_empty() {
        return None;
    }
    let lower = raw.to_lowercase();
    let name = if lower.contains("eac3") || lower.contains("e-ac-3") || lower.contains("e ac-3") {
        if lower.contains("joc") || lower.contains("atmos") {
            "Dolby Atmos"
        } else {
            "Dolby Digital Plus"
        }
    } else if lower.contains("truehd") || lower.contains("true hd") {
        "Dolby TrueHD"
    } else if lower.contains("ac3") || lower.contains("ac-3") {
        "Dolby Digital"
    } else if lower.contains("dts-hd") || lower.contains("dtshd") || lower.contains("dts hd") {
        "DTS-HD"
    } else if lower.contains("dts") || lower == "dca" {
        "DTS"
    } else if lower.contains("aac") {
        "AAC"
    } else if lower.contains("opus") {
        "Opus"
    } else if lower.contains("vorbis") {
        "Vorbis"
    } else if lower.contains("flac") {
        "FLAC"
    } else if lower.contains("alac") {
        "ALAC"
    } else if lower.contains("mp3") || lower.contains("mpeg audio") {
        "MP3"
    } else if lower.contains("mp2") {
        "MP2"
    } else if lower.contains("pcm") || lower.contains("wav") {
        "PCM"
    } else if lower.contains("subrip") || lower == "srt" {
        "SRT"
    } else if lower.contains("ass") || lower.contains("ssa") {
        "SSA"
    } else if lower.contains("webvtt") || lower == "vtt" {
        "VTT"
    } else if lower.contains("pgs") || lower.contains("hdmv") {
        "PGS"
    } else {
        raw
    };
    Some(name.to_string())
}

fn channel_layout(name: Option<&str>, count: i64) -> Option<String> {
    if let Some(raw) = name.map(str::trim).filter(|s| !s.is_empty()) {
        if !raw.eq_ignore_ascii_case("unknown") {
            return Some(match raw.to_lowercase().as_str() {
                "mono" => "Mono".to_string(),
                "stereo" => "Stereo".to_string(),
                _ => raw.to_string(),
            });
        }
    }
    match count {
        1 => Some("Mono".into()),
        2 => Some("Stereo".into()),
        6 => Some("5.1".into()),
        8 => Some("7.1".into()),
        count if count > 0 => Some(format!("{count} channels")),
        _ => None,
    }
}

/// Language first, then the file's own title: "Hindi (Dubbed)".
fn track_label(kind: &str, ordinal: usize, title: Option<&str>, lang: Option<&str>) -> String {
    let language = lang.map(language_display).filter(|name| !name.is_empty());
    let title = title.map(str::trim).filter(|text| !text.is_empty());
    match (language, title) {
        (Some(language), Some(title)) => {
            let haystack = title.to_lowercase();
            if haystack.contains(&language.to_lowercase()) {
                title.to_string()
            } else {
                format!("{language} ({title})")
            }
        }
        (Some(language), None) => language,
        (None, Some(title)) => title.to_string(),
        (None, None) => {
            let fallback = if kind == "audio" { "Audio" } else { "Subtitle" };
            format!("{fallback} {}", ordinal + 1)
        }
    }
}

fn track_details(
    kind: &str,
    label: &str,
    codec: Option<&str>,
    channels: Option<&str>,
    channel_count: i64,
) -> Option<String> {
    if kind != "audio" {
        return None;
    }
    let haystack = label.to_lowercase();
    let mut parts = Vec::new();
    if let Some(layout) = channel_layout(channels, channel_count) {
        if !haystack.contains(&layout.to_lowercase()) {
            parts.push(layout);
        }
    }
    if let Some(codec) = codec.and_then(codec_name) {
        if !haystack.contains(&codec.to_lowercase()) {
            parts.push(codec);
        }
    }
    (!parts.is_empty()).then(|| parts.join(" · "))
}

fn parse_chapters(value: &Value) -> Vec<Chapter> {
    value
        .as_array()
        .map(|list| {
            list.iter()
                .filter_map(|chapter| {
                    let start = chapter.get("time").and_then(|v| v.as_f64())?;
                    let title = chapter
                        .get("title")
                        .and_then(|v| v.as_str())
                        .map(str::trim)
                        .filter(|s| !s.is_empty())
                        .map(|s| s.to_string());
                    Some(Chapter { start, title })
                })
                .collect()
        })
        .unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

/// Only remote HTTP(S) and file sources may reach mpv.
fn validate_media_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("No media URL supplied".into());
    }
    let scheme = url
        .split_once(':')
        .map(|(scheme, _)| scheme.to_ascii_lowercase())
        .unwrap_or_default();
    if matches!(scheme.as_str(), "http" | "https" | "file") {
        return Ok(());
    }
    Err("Only http, https and file sources can be played".into())
}

/// English is the fallback only when the user configured no language.
fn language_arg(configured: &str) -> &str {
    match configured.trim() {
        "" => "en,english",
        value => value,
    }
}

impl Player {
    pub fn spawn(
        app: AppHandle,
        settings: &Settings,
        request: &PlayRequest,
        host: Option<isize>,
        resource_dir: Option<&std::path::Path>,
    ) -> Result<Self, String> {
        validate_media_url(&request.url)?;
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
            .arg("--sub-auto=exact")
            .arg("--sub-visibility=yes")
            .arg("--volume=100")
            .arg("--volume-max=200")
            .arg("--cache=yes")
            .arg("--demuxer-max-bytes=256MiB")
            .arg("--demuxer-readahead-secs=30")
            .arg("--network-timeout=20")
            .arg(format!(
                "--alang={}",
                language_arg(&settings.audio_language)
            ))
            .arg(format!(
                "--slang={}",
                language_arg(&settings.subtitle_language)
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
            (11, "chapter-list"),
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
            app.clone(),
            Arc::clone(&snapshot),
            Arc::clone(&stop),
            Arc::clone(&session),
            host,
        );

        Ok(Self {
            child,
            writer: Arc::new(Mutex::new(writer)),
            snapshot,
            stop,
            app,
            session,
            final_saved: AtomicBool::new(false),
            source: request.url.clone(),
            pipe,
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn writer(&self) -> Arc<Mutex<Box<dyn Duplex>>> {
        Arc::clone(&self.writer)
    }

    /// mpv reported a dead source. Its pipe wedges, so writes are refused.
    pub fn failed(&self) -> bool {
        self.snapshot
            .lock()
            .map(|snap| snap.error.is_some())
            .unwrap_or(true)
    }

    /// The ticker saves every 5s; quitting in between must not lose that gap.
    fn save_final(&self) {
        if self.final_saved.swap(true, Ordering::Relaxed) {
            return;
        }
        let snap = self.snapshot();
        let session = self.session.lock().ok().and_then(|guard| guard.clone());
        persist(&self.app, &snap, session.as_ref());
    }

    /// Stop mpv now; reaping it can happen later on another thread.
    pub fn kill(&mut self) {
        self.save_final();
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.child.kill();
    }

    /// Send one action without holding the player slot, so a wedged mpv cannot
    /// block the next playback behind a full IPC pipe.
    pub fn send_action(
        writer: &Arc<Mutex<Box<dyn Duplex>>>,
        action: &str,
        value: Option<Value>,
    ) -> Result<(), String> {
        let mut writer = writer.lock().map_err(|_| "player is busy")?;
        match action {
            "toggle-pause" => send(&mut writer, json!({"command": ["cycle", "pause"]})),
            "pause" => {
                let paused = bool_value(value.as_ref(), "Pause")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "pause", paused]}),
                )
            }
            "seek" => {
                let position = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
                send(
                    &mut writer,
                    json!({"command": ["set_property", "time-pos", position]}),
                )
            }
            "seek-rel" => {
                let delta = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
                send(
                    &mut writer,
                    json!({"command": ["seek", delta, "relative+exact"]}),
                )
            }
            "volume" => {
                let volume = value.and_then(|v| v.as_f64()).unwrap_or(100.0);
                send(&mut writer, json!({"command": ["set_property", "volume", volume]}))
            }
            "mute" => {
                let muted = value
                    .as_ref()
                    .and_then(Value::as_bool)
                    .ok_or("mute needs a boolean")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "mute", muted]}),
                )
            }
            "speed" => {
                let speed = value.and_then(|v| v.as_f64()).unwrap_or(1.0);
                send(&mut writer, json!({"command": ["set_property", "speed", speed]}))
            }
            "audio" => {
                let id = value.and_then(|v| v.as_i64());
                send(
                    &mut writer,
                    json!({"command": ["set_property", "aid", id.map(Value::from).unwrap_or_else(|| json!("no"))]}),
                )
            }
            "sub" => {
                let id = value.and_then(|v| v.as_i64());
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sid", id.map(Value::from).unwrap_or_else(|| json!("no"))]}),
                )
            }
            "sub-font-size" => {
                let size = number_value(value.as_ref(), "Subtitle font size")?;
                if !(10.0..=200.0).contains(&size) {
                    return Err("Subtitle font size must be between 10 and 200".into());
                }
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-font-size", size]}),
                )
            }
            "sub-color" => {
                let color = color_value(value.as_ref(), "Subtitle colour")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-color", color]}),
                )
            }
            "sub-back-color" => {
                let color = color_value(value.as_ref(), "Subtitle background")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-back-color", color]}),
                )
            }
            "sub-delay" => {
                let delay = number_value(value.as_ref(), "Subtitle delay")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-delay", delay]}),
                )
            }
            "sub-pos" => {
                // mpv measures sub-pos from the top: 0 is the top edge, 100 the bottom.
                let position = number_value(value.as_ref(), "Subtitle position")?.clamp(25.0, 100.0);
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-pos", position]}),
                )
            }
            "sub-bold" => {
                let bold = bool_value(value.as_ref(), "Subtitle bold")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-bold", bold]}),
                )
            }
            "sub-border-size" => {
                let size = number_value(value.as_ref(), "Subtitle outline")?;
                if !(0.0..=10.0).contains(&size) {
                    return Err("Subtitle outline must be between 0 and 10".into());
                }
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-border-size", size]}),
                )
            }
            "sub-border-color" => {
                let color = color_value(value.as_ref(), "Subtitle outline colour")?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "sub-border-color", color]}),
                )
            }
            "sub-add" => {
                let url = value
                    .as_ref()
                    .and_then(|v| v.get("url"))
                    .and_then(|v| v.as_str())
                    .unwrap_or_default()
                    .trim()
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
                let lower = url.to_ascii_lowercase();
                if !(lower.starts_with("http://") || lower.starts_with("https://")) {
                    return Err("Subtitle URL must be http or https".into());
                }
                send(
                    &mut writer,
                    json!({"command": ["sub-add", url, "select", label]}),
                )
            }
            "video-mode" => {
                // Two properties per mode: aspect first, then the pan/scan crop.
                let mode = value
                    .as_ref()
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .unwrap_or_default();
                let (aspect, panscan) = match mode {
                    "fit" => ("yes", 0.0),
                    "fill" => ("yes", 1.0),
                    "stretch" => ("no", 0.0),
                    other => {
                        return Err(format!(
                            "Video mode must be fit, fill or stretch, not {other:?}"
                        ));
                    }
                };
                send(
                    &mut writer,
                    json!({"command": ["set_property", "keepaspect", aspect]}),
                )?;
                send(
                    &mut writer,
                    json!({"command": ["set_property", "panscan", panscan]}),
                )
            }
            "stop" => {
                let _ = send(&mut writer, json!({"command": ["quit"]}));
                Ok(())
            }
            other => Err(format!("Unknown player action: {other}")),
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.save_final();
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
                            // The property is an absolute timestamp, not a lead.
                            if let Some(time) = data.as_f64() {
                                let position = snap.position;
                                snap.buffered = (time - position).max(0.0);
                            }
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
                        "chapter-list" => snap.chapters = parse_chapters(&data),
                        _ => {}
                    }
                    drop(snap);
                }
                "file-loaded" => {
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.playing = true;
                        snap.paused = false;
                        snap.ended = false;
                        snap.error = None;
                    }
                    crate::playback_log::mark("demuxer opened the stream");
                }
                "end-file" => {
                    let reason = value
                        .get("reason")
                        .and_then(|v| v.as_str())
                        .unwrap_or_default();
                    let failed = reason == "error";
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.playing = false;
                        if failed {
                            snap.error =
                                Some("The stream ended before it could play.".to_string());
                        }
                        snap.ended = reason == "eof" || snap.ended || failed;
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
        let replaced = stop.swap(true, Ordering::Relaxed);
        crate::playback_log::mark("control pipe closed");
        // A player we killed on purpose (stop, or a new source taking over) is
        // not news: closing it would blank the snapshot of the new playback.
        if !replaced {
            let _ = app.emit("player:closed", ());
        }
    });
}

/// The cheap subset of a snapshot: when two ticks match here, nothing moved.
#[derive(PartialEq)]
struct Tick {
    position: i64,
    paused: bool,
    duration: i64,
    volume: i64,
    muted: bool,
    speed: i64,
    ended: bool,
    buffered: i64,
    active_audio: Option<i64>,
    active_sub: Option<i64>,
    tracks: usize,
    error: Option<String>,
}

impl Tick {
    fn of(snap: &Snapshot) -> Self {
        let quarter = |value: f64| (value * 4.0).round() as i64;
        Self {
            position: quarter(snap.position),
            paused: snap.paused,
            duration: quarter(snap.duration),
            volume: quarter(snap.volume),
            muted: snap.muted,
            speed: quarter(snap.speed),
            ended: snap.ended,
            buffered: quarter(snap.buffered),
            active_audio: snap.active_audio,
            active_sub: snap.active_sub,
            tracks: snap.audio_tracks.len() + snap.sub_tracks.len(),
            error: snap.error.clone(),
        }
    }
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
        let mut last_emit: Option<Tick> = None;
        let mut last_saved: Option<(f64, bool, bool)> = None;
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
                Ok(mut snap) => {
                    // The first tick with a real position is the moment the
                    // picture exists; everything before it is the source being slow.
                    if !started && snap.position > 0.0 {
                        started = true;
                        snap.started = true;
                        crate::playback_log::mark(format!("first frame at {:.2}s", snap.position));
                    }
                    snap.clone()
                }
                Err(_) => break,
            };
            let tick = Tick::of(&snap);
            if last_emit.as_ref() != Some(&tick) {
                last_emit = Some(tick);
                let _ = app.emit("player:tick", &snap);
            }
            // Save every 5s, but only when the picture moved: a paused player
            // was rewriting the same row ten times a minute.
            if ticks % 10 == 0 {
                let due = match last_saved {
                    Some((position, paused, ended)) => {
                        (snap.position - position).abs() > 0.5
                            || snap.paused != paused
                            || snap.ended != ended
                    }
                    None => true,
                };
                if due {
                    last_saved = Some((snap.position, snap.paused, snap.ended));
                    let session = match session.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => None,
                    };
                    persist(&app, &snap, session.as_ref());
                }
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
    use super::{
        bool_value, color_value, number_value, parse_chapters, parse_tracks, validate_media_url,
        Duplex, Player,
    };
    use serde_json::{json, Value};
    use std::io::{Read, Write};
    use std::sync::{Arc, Mutex};

    struct FakePipe(Arc<Mutex<Vec<u8>>>);

    impl Write for FakePipe {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            self.0
                .lock()
                .map_err(|_| std::io::ErrorKind::Other)?
                .extend_from_slice(buf);
            Ok(buf.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Read for FakePipe {
        fn read(&mut self, _buf: &mut [u8]) -> std::io::Result<usize> {
            Ok(0)
        }
    }

    fn fake_player() -> (Arc<Mutex<Box<dyn Duplex>>>, Arc<Mutex<Vec<u8>>>) {
        let buffer = Arc::new(Mutex::new(Vec::new()));
        let writer = Arc::new(Mutex::new(
            Box::new(FakePipe(Arc::clone(&buffer))) as Box<dyn Duplex>
        ));
        (writer, buffer)
    }

    fn written_lines(buffer: &Arc<Mutex<Vec<u8>>>) -> Vec<Value> {
        String::from_utf8(buffer.lock().unwrap().clone())
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    #[test]
    fn pause_action_sets_the_requested_state() {
        for state in [true, false] {
            let (writer, buffer) = fake_player();
            Player::send_action(&writer, "pause", Some(json!(state))).unwrap();
            assert_eq!(
                written_lines(&buffer),
                vec![json!({"command": ["set_property", "pause", state]})]
            );
        }
    }

    #[test]
    fn pause_action_rejects_missing_or_non_boolean_values() {
        let (writer, buffer) = fake_player();
        assert!(Player::send_action(&writer, "pause", None).is_err());
        assert!(Player::send_action(&writer, "pause", Some(json!("true"))).is_err());
        assert!(buffer.lock().unwrap().is_empty());
    }

    #[test]
    fn toggle_pause_still_cycles() {
        let (writer, buffer) = fake_player();
        Player::send_action(&writer, "toggle-pause", None).unwrap();
        assert_eq!(
            written_lines(&buffer),
            vec![json!({"command": ["cycle", "pause"]})]
        );
    }

    #[test]
    fn mute_sets_the_requested_state_and_needs_a_boolean() {
        let (writer, buffer) = fake_player();
        Player::send_action(&writer, "mute", Some(json!(true))).unwrap();
        Player::send_action(&writer, "mute", Some(json!(false))).unwrap();
        assert_eq!(
            written_lines(&buffer),
            vec![
                json!({"command": ["set_property", "mute", true]}),
                json!({"command": ["set_property", "mute", false]}),
            ]
        );
        assert!(Player::send_action(&writer, "mute", None).is_err());
    }

    #[test]
    fn relative_seek_is_exact() {
        let (writer, buffer) = fake_player();
        Player::send_action(&writer, "seek-rel", Some(json!(10))).unwrap();
        assert_eq!(
            written_lines(&buffer),
            vec![json!({"command": ["seek", 10.0, "relative+exact"]})]
        );
    }

    #[test]
    fn media_urls_must_be_http_https_or_file() {
        assert!(validate_media_url("https://cdn.example/movie.mkv").is_ok());
        assert!(validate_media_url(" file:///C:/movie.mkv ").is_ok());
        assert!(validate_media_url("magnet:?xt=urn:btih:abc").is_err());
        assert!(validate_media_url("   ").is_err());
    }

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

        let bold = json!(true);
        assert!(bool_value(Some(&bold), "b").unwrap());
        assert!(bool_value(Some(&json!("true")), "b").is_err());
        assert!(bool_value(None, "b").is_err());
    }

    #[test]
    fn audio_tracks_get_language_titles_and_details() {
        let value = json!([
            {
                "type": "audio",
                "id": 1,
                "lang": "eng",
                "title": "Surround",
                "codec": "eac3",
                "demux-channels": "5.1",
                "demux-channel-count": 6,
                "selected": true
            },
            {
                "type": "audio",
                "id": 2,
                "lang": "hin",
                "title": "Dubbed",
                "codec": "ac3",
                "demux-channels": "stereo",
                "demux-channel-count": 2
            },
            { "type": "audio", "id": 3, "lang": "jpn", "codec": "aac" },
            { "type": "sub", "id": 4, "lang": "eng", "title": "English SDH" }
        ]);
        let (audio, subs, active_audio, active_sub) = parse_tracks(&value);
        assert_eq!(active_audio, Some(1));
        assert_eq!(active_sub, None);
        assert_eq!(audio.len(), 3);
        assert_eq!(audio[0].label, "English (Surround)");
        assert_eq!(audio[0].details.as_deref(), Some("5.1 · Dolby Digital Plus"));
        assert_eq!(audio[1].label, "Hindi (Dubbed)");
        assert_eq!(audio[1].details.as_deref(), Some("Stereo · Dolby Digital"));
        assert_eq!(audio[2].label, "Japanese");
        assert_eq!(audio[2].details.as_deref(), Some("AAC"));
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].label, "English SDH");
        assert_eq!(subs[0].details, None);
    }

    #[test]
    fn unnamed_tracks_still_get_a_readable_label() {
        let value = json!([{ "type": "audio", "id": 7 }, { "type": "sub", "id": 9 }]);
        let (audio, subs, _, _) = parse_tracks(&value);
        assert_eq!(audio[0].label, "Audio 1");
        assert_eq!(subs[0].label, "Subtitle 1");
    }

    #[test]
    fn chapters_parse_time_and_title() {
        let value = json!([
            { "time": 0.0, "title": "Opening" },
            { "time": 632.5, "title": "" },
            { "time": "nope", "title": "Broken" }
        ]);
        let chapters = parse_chapters(&value);
        assert_eq!(chapters.len(), 2);
        assert_eq!(chapters[0].title.as_deref(), Some("Opening"));
        assert_eq!(chapters[1].start, 632.5);
        assert_eq!(chapters[1].title, None);
    }
}
