//! Native playback through libmpv, in this process.
//!
//! Video is decoded by mpv (hardware accelerated, with its own render surface)
//! and painted into the app window itself; the web layer above it stays
//! transparent, so playback never leaves the window and the WebView stays
//! completely out of the decode path.

use crate::db::{self, ProgressItem};
use crate::models::PlaybackSession;
use crate::settings::Settings;
use crate::AppState;
use libmpv2::events::{Event, PropertyData};
use libmpv2::{Format, Mpv};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

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
    /// True when an eof landed well before the duration: a dropped stream.
    #[serde(default)]
    pub cut_short: bool,
    /// Set when mpv cannot open or continue the source.
    pub error: Option<String>,
    pub audio_tracks: Vec<Track>,
    pub sub_tracks: Vec<Track>,
    pub active_audio: Option<i64>,
    pub active_sub: Option<i64>,
    pub chapters: Vec<Chapter>,
    pub session: Option<PlaybackSession>,
    /// Which player produced this snapshot, so a dead player's late events can
    /// be ignored by the UI.
    #[serde(default)]
    pub generation: u64,
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
            cut_short: false,
            error: None,
            audio_tracks: Vec::new(),
            sub_tracks: Vec::new(),
            active_audio: None,
            active_sub: None,
            chapters: Vec::new(),
            session: None,
            generation: 0,
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
    /// Shared with every command and with the event thread; the core lives
    /// while a handle does.
    mpv: Arc<Mpv>,
    snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
    app: AppHandle,
    session: Arc<Mutex<Option<PlaybackSession>>>,
    /// The final save must run once, whichever of kill and drop comes first.
    final_saved: AtomicBool,
    /// Exactly what mpv was handed, so frame previews decode the same stream.
    source: String,
    /// Stamped on every snapshot and event, so the UI can drop a dead player's.
    generation: u64,
}

/// One id per player, so stale events can never be mistaken for the new one.
static NEXT_GENERATION: AtomicU64 = AtomicU64::new(1);

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

/// The libmpv that is actually loaded, probed once at boot: a broken bundle
/// then shows up in the log instead of as a failed first play.
pub fn version() -> Option<String> {
    let mpv = Mpv::with_initializer(|init| {
        let _ = init.set_option("vo", "null");
        let _ = init.set_option("audio", "no");
        let _ = init.set_option("config", "no");
        Ok(())
    })
    .ok()?;
    mpv.get_property::<String>("mpv-version").ok()
}

/// Only remote HTTP(S), file sources and local paths may reach mpv.
pub fn validate_media_url(url: &str) -> Result<(), String> {
    let url = url.trim();
    if url.is_empty() {
        return Err("No media URL supplied".into());
    }
    // The file pickers return a bare path, which has no scheme.
    if std::path::Path::new(url).is_absolute() {
        return Ok(());
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

/// The forward cache as (megabytes, seconds). A time setting wins: `--cache-secs`
/// is the real limit, and the byte cap is a generous 8 MB/s ceiling so 4K fits.
fn forward_cache(value: i64, unit: &str) -> (u64, Option<u64>) {
    let value = value.max(1) as u64;
    match unit {
        "sec" | "min" => {
            let secs = (value * if unit == "min" { 60 } else { 1 }).min(86_400);
            (cap_mb(secs * 8), Some(secs))
        }
        "gb" => (cap_mb(value * 1024), None),
        _ => (cap_mb(value), None),
    }
}

/// mpv has no time limit for the back buffer, so seconds are read as 1 MB each.
fn back_cache(value: i64, unit: &str) -> u64 {
    let value = value.max(1) as u64;
    match unit {
        "sec" | "min" => cap_mb(value * if unit == "min" { 60 } else { 1 }),
        "gb" => cap_mb(value * 1024),
        _ => cap_mb(value),
    }
}

fn cap_mb(megabytes: u64) -> u64 {
    megabytes.clamp(1, 65_536)
}

impl Player {
    pub fn spawn(
        app: AppHandle,
        settings: &Settings,
        request: &PlayRequest,
        host: Option<isize>,
    ) -> Result<Self, String> {
        validate_media_url(&request.url)?;

        let (forward_mb, forward_secs) =
            forward_cache(settings.buffer_forward_value, &settings.buffer_forward_unit);
        let backward_mb = back_cache(settings.buffer_backward_value, &settings.buffer_backward_unit);
        let start = request.start_at.unwrap_or(0.0);

        // Keep a log next to the database: when a stream refuses to play on a
        // user's machine this is the only window into mpv's decision making.
        let log_file = app.path().app_data_dir().ok().map(|dir| {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("mpv.log").to_string_lossy().to_string()
        });

        let mpv = Mpv::with_initializer(|init| {
            // Only `wid` and `vo` can fail the open. Everything else is
            // cosmetic, and one unknown option must not cost a playback.
            if let Some(log) = log_file.as_deref() {
                let _ = init.set_option("log-file", log);
            }
            let _ = init.set_option("config", "no");
            let _ = init.set_option("keep-open", "no");
            let _ = init.set_option("save-position-on-quit", "no");
            let _ = init.set_option("idle", "yes");
            let _ = init.set_option("osd-level", "1");
            let _ = init.set_option("osd-font-size", "34");
            let _ = init.set_option("osd-duration", "2500");
            let _ = init.set_option("sub-font-size", "46");
            let _ = init.set_option("sub-auto", "fuzzy");
            let _ = init.set_option("sub-visibility", "yes");
            let _ = init.set_option("volume", "100");
            let _ = init.set_option("volume-max", "200");
            let _ = init.set_option("cache", "yes");
            let _ = init.set_option("cache-on-disk", "no");
            let _ = init.set_option("demuxer-max-bytes", format!("{forward_mb}MiB"));
            let _ = init.set_option("demuxer-max-back-bytes", format!("{backward_mb}MiB"));
            // A time-based forward buffer is capped by seconds; the byte
            // ceiling above only stops a runaway read on a broken stream.
            if let Some(secs) = forward_secs {
                let _ = init.set_option("cache-secs", secs.to_string());
            }
            let _ = init.set_option("network-timeout", "20");
            let _ = init.set_option("alang", language_arg(&settings.audio_language));
            let _ = init.set_option("slang", language_arg(&settings.subtitle_language));
            let _ = init.set_option(
                "hwdec",
                if settings.hardware_decoding {
                    "auto-safe"
                } else {
                    "no"
                },
            );
            // Pin the picture pipeline instead of relying on whatever the mpv
            // build picks as defaults: libplacebo renders, maps HDR and Dolby
            // Vision to the panel's real range (SDR included) and dithers the
            // result, and every codec the GPU can decode is offloaded.
            init.set_option("vo", "gpu-next")?;
            let _ = init.set_option("hwdec-codecs", "all");
            let _ = init.set_option("tone-mapping", "bt.2390");
            let _ = init.set_option("hdr-compute-peak", "yes");
            let _ = init.set_option("dither-depth", "auto");
            let _ = init.set_option("force-media-title", request.title.as_str());
            let _ = init.set_option("user-agent", "Mozilla/5.0 Duvy/0.1");
            // Resume is an open option, not a loadfile one: mpv answers
            // `loadfile url replace "start=..."` with "invalid parameter".
            if let Some(start) = request.start_at.filter(|value| *value > 5.0) {
                let _ = init.set_option("start", format!("{start:.3}"));
            }
            match host {
                Some(wid) => {
                    // Set before initialization, so the picture has a surface
                    // the moment the core starts. Everything mpv would draw
                    // around it is off: the web layer is the only UI.
                    init.set_property("wid", wid as i64)?;
                    let _ = init.set_option("border", "no");
                    let _ = init.set_option("osc", "no");
                    let _ = init.set_option("osd-bar", "no");
                    let _ = init.set_option("input-vo-keyboard", "no");
                    let _ = init.set_option("input-default-bindings", "no");
                    let _ = init.set_option("stop-screensaver", "yes");
                }
                None => {
                    // Fallback: mpv's own window, still driven by us.
                    let _ = init.set_option("force-window", "yes");
                    let _ = init.set_option("osc", "yes");
                    let _ = init.set_option("autofit-larger", "90%x90%");
                    let _ = init.set_option("title", "Duvy");
                }
            }
            Ok(())
        })
        .map_err(|error| format!("Could not start the player: {error}"))?;
        crate::playback_log::mark("libmpv initialised");

        let mpv = Arc::new(mpv);
        // A second handle for the event loop: `wait_event` needs `&mut`, while
        // commands and property reads come in on the shared one. No client
        // name: libmpv2 5 builds a dangling `CString` when one is given.
        let events = mpv
            .create_client(None)
            .map_err(|error| format!("Could not attach the player's events: {error}"))?;

        for (id, name, format) in [
            (1, "time-pos", Format::Double),
            (2, "duration", Format::Double),
            (3, "pause", Format::Flag),
            (4, "volume", Format::Double),
            (5, "mute", Format::Flag),
            (6, "speed", Format::Double),
            (7, "track-list/count", Format::Int64),
            (8, "eof-reached", Format::Flag),
            (9, "media-title", Format::String),
            (10, "demuxer-cache-time", Format::Double),
            (11, "chapter-list/count", Format::Int64),
        ] {
            if let Err(error) = events.observe_property(name, format, id) {
                crate::playback_log::mark(format!("playback failed: {error}"));
                return Err(format!("Could not watch {name}: {error}"));
            }
        }

        crate::playback_log::mark(format!("handing the URL to mpv (start at {start:.1}s)"));
        mpv.command("loadfile", &[request.url.as_str(), "replace"])
            .map_err(|error| format!("mpv refused the source: {error}"))?;
        mpv.set_property("pause", false)
            .map_err(|error| format!("mpv would not start playback: {error}"))?;
        crate::playback_log::mark("waiting for the first frame");

        let generation = NEXT_GENERATION.fetch_add(1, Ordering::Relaxed);
        let snapshot = Snapshot {
            playing: true,
            title: request.title.clone(),
            session: request.session.clone(),
            generation,
            ..Default::default()
        };

        let snapshot = Arc::new(Mutex::new(snapshot));
        let stop = Arc::new(AtomicBool::new(false));
        let session = Arc::new(Mutex::new(request.session.clone()));

        spawn_events(
            app.clone(),
            events,
            Arc::clone(&snapshot),
            Arc::clone(&stop),
            Arc::clone(&mpv),
        );
        spawn_ticker(
            app.clone(),
            Arc::clone(&snapshot),
            Arc::clone(&stop),
            Arc::clone(&session),
            host,
        );

        Ok(Self {
            mpv,
            snapshot,
            stop,
            app,
            session,
            final_saved: AtomicBool::new(false),
            source: request.url.clone(),
            generation,
        })
    }

    pub fn snapshot(&self) -> Snapshot {
        self.snapshot.lock().map(|s| s.clone()).unwrap_or_default()
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn source(&self) -> &str {
        &self.source
    }

    pub fn handle(&self) -> Arc<Mpv> {
        Arc::clone(&self.mpv)
    }

    /// mpv reported a dead source, so further actions have nothing to drive.
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

    /// Stop mpv now; the core itself goes when its last handle drops.
    pub fn kill(&mut self) {
        self.save_final();
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.mpv.command("quit", &[]);
    }

    /// Commands are thread-safe on the handle, so no lock stands between the UI
    /// and a player that is already stopping.
    pub fn send_action(mpv: &Mpv, action: &str, value: Option<Value>) -> Result<(), String> {
        fn apply(result: libmpv2::Result<()>) -> Result<(), String> {
            result.map_err(|error| format!("mpv rejected that: {error}"))
        }
        match action {
            "toggle-pause" => apply(mpv.command("cycle", &["pause"])),
            "pause" => {
                let paused = bool_value(value.as_ref(), "Pause")?;
                apply(mpv.set_property("pause", paused))
            }
            "seek" => {
                let position = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
                apply(mpv.set_property("time-pos", position))
            }
            "seek-rel" => {
                let delta = value.and_then(|v| v.as_f64()).unwrap_or(0.0);
                let delta = format!("{delta}");
                apply(mpv.command("seek", &[delta.as_str(), "relative+exact"]))
            }
            "volume" => {
                let volume = value.and_then(|v| v.as_f64()).unwrap_or(100.0);
                apply(mpv.set_property("volume", volume))
            }
            "mute" => {
                let muted = value
                    .as_ref()
                    .and_then(Value::as_bool)
                    .ok_or("mute needs a boolean")?;
                apply(mpv.set_property("mute", muted))
            }
            "speed" => {
                let speed = value.and_then(|v| v.as_f64()).unwrap_or(1.0);
                apply(mpv.set_property("speed", speed))
            }
            "audio" => {
                let id = value.and_then(|v| v.as_i64());
                apply(mpv.set_property(
                    "aid",
                    id.map(|n| n.to_string()).unwrap_or_else(|| "no".into()),
                ))
            }
            "sub" => {
                let id = value.and_then(|v| v.as_i64());
                apply(mpv.set_property(
                    "sid",
                    id.map(|n| n.to_string()).unwrap_or_else(|| "no".into()),
                ))
            }
            "sub-ass-override" => {
                // ASS tracks keep their own styling until a control is moved.
                let custom = bool_value(value.as_ref(), "Subtitle style override")?;
                apply(mpv.set_property(
                    "sub-ass-override",
                    if custom { "force" } else { "no" },
                ))
            }
            "sub-font-size" => {
                let size = number_value(value.as_ref(), "Subtitle font size")?;
                if !(10.0..=200.0).contains(&size) {
                    return Err("Subtitle font size must be between 10 and 200".into());
                }
                apply(mpv.set_property("sub-font-size", size))
            }
            "sub-color" => {
                let color = color_value(value.as_ref(), "Subtitle colour")?;
                apply(mpv.set_property("sub-color", color))
            }
            "sub-back-color" => {
                let color = color_value(value.as_ref(), "Subtitle background")?;
                apply(mpv.set_property("sub-back-color", color))
            }
            "sub-delay" => {
                let delay = number_value(value.as_ref(), "Subtitle delay")?;
                apply(mpv.set_property("sub-delay", delay))
            }
            "sub-pos" => {
                // mpv measures sub-pos from the top: 0 is the top edge, 100 the bottom.
                let position =
                    number_value(value.as_ref(), "Subtitle position")?.clamp(25.0, 100.0);
                apply(mpv.set_property("sub-pos", position))
            }
            "sub-bold" => {
                let bold = bool_value(value.as_ref(), "Subtitle bold")?;
                apply(mpv.set_property("sub-bold", bold))
            }
            "sub-border-size" => {
                let size = number_value(value.as_ref(), "Subtitle outline")?;
                if !(0.0..=10.0).contains(&size) {
                    return Err("Subtitle outline must be between 0 and 10".into());
                }
                apply(mpv.set_property("sub-border-size", size))
            }
            "sub-border-color" => {
                let color = color_value(value.as_ref(), "Subtitle outline colour")?;
                apply(mpv.set_property("sub-border-color", color))
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
                validate_media_url(&url)?;
                apply(mpv.command("sub-add", &[url.as_str(), "select", label.as_str()]))
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
                apply(mpv.set_property("keepaspect", aspect))?;
                apply(mpv.set_property("panscan", panscan))
            }
            "stop" => {
                let _ = mpv.command("quit", &[]);
                Ok(())
            }
            other => Err(format!("Unknown player action: {other}")),
        }
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.save_final();
        // `quit` only queues the request, so dropping a player can never freeze
        // the UI. The core ends once the last handle is gone.
        self.stop.store(true, Ordering::Relaxed);
        let _ = self.mpv.command("quit", &[]);
    }
}

/// The event thread owns the handle it waits on: `wait_event` needs `&mut`,
/// while commands and property reads use the shared one.
fn spawn_events(
    app: AppHandle,
    mut events: Mpv,
    snapshot: Arc<Mutex<Snapshot>>,
    stop: Arc<AtomicBool>,
    mpv: Arc<Mpv>,
) {
    thread::spawn(move || {
        let mut ended = false;
        while !stop.load(Ordering::Relaxed) {
            let event = match events.wait_event(0.2) {
                None => continue,
                Some(Ok(event)) => event,
                // mpv reports a source that will not open as a bare error, not
                // as EndFile: this is the only signal a dead stream gives.
                Some(Err(error)) => {
                    let dead = matches!(
                        &error,
                        libmpv2::Error::Raw(code)
                            if *code == libmpv2::mpv_error::LoadingFailed
                    );
                    if dead {
                        end_stream(&app, &snapshot, &stop, &mpv, "error");
                        ended = true;
                        break;
                    }
                    // A failed property or command reply must not cost a playback.
                    crate::playback_log::mark(format!("mpv event error: {error}"));
                    continue;
                }
            };
            match event {
                Event::PropertyChange { name, change, .. } => {
                    let mut snap = match snapshot.lock() {
                        Ok(snap) => snap,
                        Err(_) => break,
                    };
                    match name {
                        "time-pos" => {
                            if let Some(position) = as_double(&change) {
                                snap.position = position;
                            }
                        }
                        "duration" => {
                            if let Some(duration) = as_double(&change) {
                                snap.duration = duration;
                            }
                        }
                        "demuxer-cache-time" => {
                            // The property is an absolute timestamp, not a lead.
                            if let Some(time) = as_double(&change) {
                                snap.buffered = (time - snap.position).max(0.0);
                            }
                        }
                        "pause" => snap.paused = as_flag(&change),
                        "volume" => {
                            if let Some(volume) = as_double(&change) {
                                snap.volume = volume;
                            }
                        }
                        "mute" => snap.muted = as_flag(&change),
                        "speed" => {
                            if let Some(speed) = as_double(&change) {
                                snap.speed = speed;
                            }
                        }
                        "media-title" => {
                            if let Some(title) = as_text(&change).filter(|text| !text.is_empty()) {
                                snap.title = title.to_string();
                            }
                        }
                        "eof-reached" => {
                            if as_flag(&change) {
                                let cut_short = ended_early(&snap);
                                snap.cut_short = cut_short;
                                snap.ended = true;
                                snap.paused = true;
                            }
                        }
                        "track-list/count" => {
                            let (audio, subs, active_audio, active_sub) =
                                parse_tracks(&read_tracks(&mpv));
                            snap.audio_tracks = audio;
                            snap.sub_tracks = subs;
                            snap.active_audio = active_audio;
                            snap.active_sub = active_sub;
                        }
                        "chapter-list/count" => snap.chapters = parse_chapters(&read_chapters(&mpv)),
                        _ => {}
                    }
                    drop(snap);
                }
                Event::FileLoaded => {
                    if let Ok(mut snap) = snapshot.lock() {
                        snap.playing = true;
                        snap.paused = false;
                        snap.ended = false;
                        snap.cut_short = false;
                        snap.error = None;
                    }
                    crate::playback_log::mark("demuxer opened the stream");
                }
                Event::EndFile(reason) => {
                    end_stream(&app, &snapshot, &stop, &mpv, end_reason(reason));
                    ended = true;
                    break;
                }
                Event::Shutdown => break,
                _ => {}
            }
        }
        if !ended {
            if let Ok(mut snap) = snapshot.lock() {
                snap.playing = false;
            }
            close(&app, &snapshot, &stop);
        }
    });
}

/// libmpv's end reasons, as the strings the UI already listens for.
fn end_reason(reason: libmpv2::EndFileReason) -> &'static str {
    if reason == libmpv2::mpv_end_file_reason::Eof {
        "eof"
    } else if reason == libmpv2::mpv_end_file_reason::Error {
        "error"
    } else if reason == libmpv2::mpv_end_file_reason::Stop {
        "stop"
    } else if reason == libmpv2::mpv_end_file_reason::Redirect {
        "redirect"
    } else {
        "quit"
    }
}

/// An eof well short of the duration is a dropped stream, not the credits.
/// Same threshold as the playback watchdog.
fn ended_early(snap: &Snapshot) -> bool {
    snap.duration > 60.0 && snap.position / snap.duration < 0.85
}

/// One end for every way a stream dies: record why, tell the UI, and let go of
/// the core only when the stream itself is not what ended.
fn end_stream(
    app: &AppHandle,
    snapshot: &Arc<Mutex<Snapshot>>,
    stop: &Arc<AtomicBool>,
    mpv: &Mpv,
    reason: &str,
) {
    // A player we stopped on purpose already answered the UI. An EndFile on the
    // way down is not the end of a stream, so it must not emit one.
    if stop.load(Ordering::Relaxed) {
        return;
    }
    let failed = reason == "error";
    if let Ok(mut snap) = snapshot.lock() {
        snap.playing = false;
        // An eof well short of the duration is a dropped stream, not the
        // credits: the UI retries it instead of showing the end card.
        let cut_short = reason == "eof" && ended_early(&snap);
        snap.cut_short = cut_short;
        if failed {
            snap.error = Some("The stream ended before it could play.".to_string());
        }
        snap.ended = reason == "eof" || snap.ended || failed;
    }
    crate::playback_log::mark(format!("stream ended ({reason})"));
    let _ = app.emit("player:ended", reason.to_string());
    // An episode or a dead source keeps its player: the epilogue on screen is
    // the viewer's to act on, and closing is never our call.
    if reason != "eof" && reason != "error" {
        // Whichever handle goes last ends the core, so the picture and the
        // audio go with the stream.
        let _ = mpv.command("quit", &[]);
        close(app, snapshot, stop);
    }
}

/// The tail every exit path shares: silence the ticker and give the slot back.
fn close(app: &AppHandle, snapshot: &Arc<Mutex<Snapshot>>, stop: &Arc<AtomicBool>) {
    // The stream is gone, so the ticker has nothing left to report. Without
    // this it keeps emitting ticks for a player that no longer exists.
    let replaced = stop.swap(true, Ordering::Relaxed);
    let generation = snapshot.lock().map(|snap| snap.generation).unwrap_or(0);
    crate::playback_log::mark("player closed");
    // Drop this player from the slot so the next open starts clean and
    // controls stop writing into a dead core. A newer player may already own
    // the slot, so only our own is cleared.
    if let Some(state) = app.try_state::<AppState>() {
        let doomed = match state.player.lock() {
            Ok(mut guard)
                if guard
                    .as_ref()
                    .is_some_and(|player| Arc::ptr_eq(&player.snapshot, snapshot)) =>
            {
                guard.take()
            }
            _ => None,
        };
        // Dropping ends the core, which must not happen under the lock.
        drop(doomed);
    }
    // A player we killed on purpose (stop, or a new source taking over) is
    // not news: closing it would blank the snapshot of the new playback.
    if !replaced {
        let _ = app.emit("player:closed", generation);
    }
}

fn as_double(data: &PropertyData) -> Option<f64> {
    match data {
        PropertyData::Double(value) => Some(*value),
        _ => None,
    }
}

fn as_flag(data: &PropertyData) -> bool {
    matches!(data, PropertyData::Flag(true))
}

fn as_text<'a>(data: &PropertyData<'a>) -> Option<&'a str> {
    match data {
        PropertyData::Str(value) => Some(*value),
        _ => None,
    }
}

/// Rebuild the track list in the shape `parse_tracks` already reads.
fn read_tracks(mpv: &Mpv) -> Value {
    let count = mpv
        .get_property::<i64>("track-list/count")
        .unwrap_or(0)
        .max(0);
    let mut list = Vec::with_capacity(count as usize);
    for index in 0..count {
        let text = |name: &str| {
            mpv.get_property::<String>(&format!("track-list/{index}/{name}"))
                .ok()
        };
        let number = |name: &str| {
            mpv.get_property::<i64>(&format!("track-list/{index}/{name}"))
                .unwrap_or(0)
        };
        let flag = |name: &str| {
            mpv.get_property::<bool>(&format!("track-list/{index}/{name}"))
                .unwrap_or(false)
        };
        list.push(json!({
            "type": text("type").unwrap_or_default(),
            "id": number("id"),
            "lang": text("lang"),
            "title": text("title"),
            "codec": text("codec"),
            "demux-channels": text("demux-channels"),
            "demux-channel-count": number("demux-channel-count"),
            "selected": flag("selected"),
            "external": flag("external"),
        }));
    }
    Value::Array(list)
}

fn read_chapters(mpv: &Mpv) -> Value {
    let count = mpv
        .get_property::<i64>("chapter-list/count")
        .unwrap_or(0)
        .max(0);
    let mut list = Vec::with_capacity(count as usize);
    for index in 0..count {
        let time = mpv
            .get_property::<f64>(&format!("chapter-list/{index}/time"))
            .unwrap_or(0.0);
        let title = mpv
            .get_property::<String>(&format!("chapter-list/{index}/title"))
            .ok();
        list.push(json!({ "time": time, "title": title }));
    }
    Value::Array(list)
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
            // The cheap tick is taken under the lock; the full snapshot is only
            // cloned on the ticks that will actually be emitted.
            let mut send: Option<Snapshot> = None;
            let state;
            let tick = match snapshot.lock() {
                Ok(mut snap) => {
                    // The first tick with a real position is the moment the
                    // picture exists; everything before it is the source being slow.
                    if !started && snap.position > 0.0 {
                        started = true;
                        snap.started = true;
                        crate::playback_log::mark(format!("first frame at {:.2}s", snap.position));
                    }
                    state = (snap.position, snap.paused, snap.ended);
                    let tick = Tick::of(&snap);
                    if last_emit.as_ref() != Some(&tick) {
                        send = Some(snap.clone());
                    }
                    tick
                }
                Err(_) => break,
            };
            if let Some(snap) = &send {
                last_emit = Some(tick);
                let _ = app.emit("player:tick", snap);
            }
            // Save every 5s, but only when the picture moved: a paused player
            // was rewriting the same row ten times a minute.
            if ticks % 10 == 0 {
                let due = match last_saved {
                    Some((position, paused, ended)) => {
                        (state.0 - position).abs() > 0.5
                            || state.1 != paused
                            || state.2 != ended
                    }
                    None => true,
                };
                if due {
                    last_saved = Some(state);
                    let session = match session.lock() {
                        Ok(guard) => guard.clone(),
                        Err(_) => None,
                    };
                    let snap = match send {
                        Some(snap) => snap,
                        None => match snapshot.lock() {
                            Ok(snap) => snap.clone(),
                            Err(_) => break,
                        },
                    };
                    persist(&app, &snap, session.as_ref());
                }
            }
        }
        // Final save when the window closes. The snapshot lock is released first:
        // persist writes to the database, and the reader thread waits on it.
        let last = snapshot.lock().map(|snap| snap.clone());
        if let Ok(snap) = last {
            let session = session.lock().ok().and_then(|guard| guard.clone());
            persist(&app, &snap, session.as_ref());
        }
    });
}

fn persist(app: &AppHandle, snap: &Snapshot, session: Option<&PlaybackSession>) {
    let Some(session) = session else { return };
    if session.key.is_empty() || snap.duration <= 0.0 || snap.position <= 5.0 {
        return;
    }
    let state = app.state::<AppState>();
    let settings = crate::settings::load_cached(&state);
    if !settings.track_progress {
        return;
    }
    let Ok(conn) = state.db.0.lock() else { return };
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
    let watched = snap.position / snap.duration >= 0.92;
    let _ = db::save_playback(&conn, &item, watched);
}

#[cfg(test)]
mod tests {
    use super::{
        back_cache, bool_value, color_value, ended_early, forward_cache, number_value,
        parse_chapters, parse_tracks, validate_media_url, Snapshot,
    };
    use serde_json::json;

    #[test]
    fn an_eof_short_of_the_duration_is_a_dropped_stream() {
        let at = |position: f64, duration: f64| Snapshot {
            position,
            duration,
            ..Default::default()
        };
        // The Covenant died at 2675s of 7383s.
        assert!(ended_early(&at(2675.0, 7383.0)));
        assert!(!ended_early(&at(7300.0, 7383.0)));
        // A live stream has no duration to compare against.
        assert!(!ended_early(&at(10.0, 0.0)));
    }

    #[test]
    fn cache_limits_accept_time_and_size_units() {
        assert_eq!(forward_cache(256, "mb"), (256, None));
        assert_eq!(forward_cache(2, "gb"), (2048, None));
        assert_eq!(forward_cache(2, "min"), (960, Some(120)));
        assert_eq!(forward_cache(0, "gb"), (1024, None));
        assert_eq!(back_cache(45, "sec"), 45);
        assert_eq!(back_cache(3, "min"), 180);
        assert_eq!(back_cache(1, "gb"), 1024);
        assert_eq!(back_cache(99_999, "gb"), 65_536);
    }

    #[test]
    fn media_urls_must_be_http_https_or_file() {
        assert!(validate_media_url("https://cdn.example/movie.mkv").is_ok());
        assert!(validate_media_url(" file:///C:/movie.mkv ").is_ok());
        assert!(validate_media_url("magnet:?xt=urn:btih:abc").is_err());
        assert!(validate_media_url("   ").is_err());
    }

    #[cfg(windows)]
    #[test]
    fn a_bare_path_from_the_file_picker_is_playable() {
        assert!(validate_media_url(r"C:\Movies\movie.mkv").is_ok());
        assert!(validate_media_url(r"C:\Movies\subs.srt").is_ok());
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
