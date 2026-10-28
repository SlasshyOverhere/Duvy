//! Stream normalisation: turn loose addon strings into sorted, comparable rows.
//!
//! Addons report quality inside free-form titles, so this module does the
//! parsing once, in Rust, instead of re-parsing strings in the UI.

use crate::addons::Stream;
use serde::Serialize;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct StreamOption {
    pub addon: String,
    pub name: Option<String>,
    pub title: Option<String>,
    pub description: Option<String>,
    pub url: Option<String>,
    pub info_hash: Option<String>,
    pub file_idx: Option<i64>,
    pub external_url: Option<String>,
    pub quality: String,
    pub size: Option<String>,
    pub size_bytes: Option<u64>,
    pub seeders: Option<i64>,
    pub languages: Vec<String>,
    pub badges: Vec<String>,
    pub cached: bool,
    pub playable: bool,
    pub score: i64,
}

const LANG_TOKENS: &[(&str, &str)] = &[
    ("MULTI", "Multi"),
    ("ENG", "English"),
    ("EN", "English"),
    ("HIN", "Hindi"),
    ("TAM", "Tamil"),
    ("TEL", "Telugu"),
    ("MAL", "Malayalam"),
    ("KAN", "Kannada"),
    ("BEN", "Bengali"),
    ("MAR", "Marathi"),
    ("PUN", "Punjabi"),
    ("SPA", "Spanish"),
    ("ESP", "Spanish"),
    ("LAT", "Latino"),
    ("FRE", "French"),
    ("FRA", "French"),
    ("VF", "French"),
    ("VOSTFR", "VOSTFR"),
    ("GER", "German"),
    ("DEU", "German"),
    ("ITA", "Italian"),
    ("JPN", "Japanese"),
    ("KOR", "Korean"),
    ("CHI", "Chinese"),
    ("RUS", "Russian"),
    ("ARA", "Arabic"),
    ("TUR", "Turkish"),
    ("POL", "Polish"),
    ("DUT", "Dutch"),
    ("NLD", "Dutch"),
    ("POR", "Portuguese"),
    ("PTB", "Portuguese"),
    ("SWE", "Swedish"),
    ("NOR", "Norwegian"),
    ("DAN", "Danish"),
    ("FIN", "Finnish"),
    ("HUN", "Hungarian"),
    ("CZE", "Czech"),
    ("UKR", "Ukrainian"),
    ("HEB", "Hebrew"),
    ("THA", "Thai"),
    ("VIE", "Vietnamese"),
    ("IND", "Indonesian"),
];

const QUALITY_TOKENS: &[(&str, &str, i64)] = &[
    ("REMUX", "REMUX", 18),
    ("BLURAY", "BluRay", 10),
    ("BLU-RAY", "BluRay", 10),
    ("WEB-DL", "WEB-DL", 8),
    ("WEBDL", "WEB-DL", 8),
    ("WEBRIP", "WEBRip", 6),
    ("WEB", "WEB", 5),
    ("HDTV", "HDTV", 3),
    ("DVDRIP", "DVDRip", 1),
    ("HDR", "HDR", 0),
    ("DOLBYVISION", "DV", 0),
    (" DV ", "DV", 0),
    ("ATMOS", "Atmos", 0),
    ("DDP", "DDP", 0),
    ("DD+", "DDP", 0),
    ("TRUEHD", "TrueHD", 0),
    ("X265", "x265", 0),
    ("HEVC", "HEVC", 0),
    ("X264", "x264", 0),
    ("10BIT", "10-bit", 0),
];

/// Detect a display quality label from arbitrary addon text.
pub fn detect_quality(text: &str) -> (String, i64) {
    let upper = text.to_uppercase();
    let (label, weight) = if upper.contains("2160P") || upper.contains("4K") || upper.contains("UHD") {
        ("4K".to_string(), 50)
    } else if upper.contains("1080P") {
        ("1080p".to_string(), 40)
    } else if upper.contains("720P") {
        ("720p".to_string(), 26)
    } else if upper.contains("480P") || upper.contains("360P") {
        ("480p".to_string(), 12)
    } else if upper.contains("CAM") || upper.contains(" HDCAM") || upper.contains("TELESYNC") || upper.contains(" TS ") {
        ("CAM".to_string(), -40)
    } else {
        ("Auto".to_string(), 20)
    };

    if label == "CAM" || label == "Auto" {
        return (label, weight);
    }
    let bonus = QUALITY_TOKENS
        .iter()
        .filter(|(token, _, _)| upper.contains(token))
        .map(|(_, _, w)| *w)
        .max()
        .unwrap_or(0);
    (label, weight + bonus)
}

/// Pull a human-readable size such as "1.4 GB" out of a description.
pub fn find_size(text: &str) -> Option<String> {
    let words: Vec<&str> = text.split_whitespace().collect();
    for (index, word) in words.iter().enumerate() {
        let cleaned = word.trim_matches(|c: char| !c.is_ascii_alphanumeric() && c != '.');
        let upper = cleaned.to_uppercase();
        for unit in ["TB", "GB", "MB"] {
            if let Some(number) = upper.strip_suffix(unit) {
                if !number.is_empty() && number.parse::<f64>().is_ok() {
                    return Some(format!("{} {}", number, unit));
                }
                // Handle "1.4 GB" where the unit is a separate word.
                if number.is_empty() {
                    if let Some(prev) = index.checked_sub(1).and_then(|i| words.get(i)) {
                        let prev = prev.trim_matches(|c: char| !c.is_ascii_digit() && c != '.');
                        if prev.parse::<f64>().is_ok() {
                            return Some(format!("{} {}", prev, unit));
                        }
                    }
                }
            }
        }
    }
    None
}

/// Pull a seeder count from common emoji / text forms.
pub fn find_seeders(text: &str) -> Option<i64> {
    let normalised = text.replace(['\u{1F464}', '\u{1F465}'], "seeders:");
    let lower = normalised.to_lowercase();
    for marker in ["seeders:", "seeds:", "seeders ", "👤"] {
        if let Some(pos) = lower.find(marker) {
            let rest = &lower[pos + marker.len()..];
            let digits: String = rest
                .trim_start_matches([' ', ':', '=', '\u{1F464}'])
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if let Ok(value) = digits.parse::<i64>() {
                return Some(value);
            }
        }
    }
    None
}

fn detect_languages(text: &str) -> Vec<String> {
    let mut tokens: Vec<String> = text
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|t| !t.is_empty())
        .map(|t| t.to_uppercase())
        .collect();
    // "MULTi" style spellings.
    tokens = tokens
        .into_iter()
        .map(|t| if t.starts_with("MULTI") { "MULTI".to_string() } else { t })
        .collect();

    let mut found: Vec<String> = Vec::new();
    for (token, label) in LANG_TOKENS {
        if tokens.iter().any(|t| t == token) && !found.iter().any(|f| f == label) {
            found.push((*label).to_string());
        }
    }
    found.truncate(4);
    found
}

fn detect_badges(text: &str) -> Vec<String> {
    let upper = text.to_uppercase();
    let mut badges: Vec<String> = Vec::new();
    for (token, label, _) in QUALITY_TOKENS {
        if matches!(*label, "HDR" | "DV" | "Atmos" | "DDP" | "TrueHD" | "x265" | "HEVC" | "10-bit")
            && upper.contains(token)
            && !badges.iter().any(|b| b == label)
        {
            badges.push((*label).to_string());
        }
    }
    if upper.contains("REMUX") && !badges.iter().any(|b| b == "REMUX") {
        badges.insert(0, "REMUX".into());
    }
    badges.truncate(4);
    badges
}

/// Addon titles carry emoji metadata and hard line breaks; a row wants the
/// release name alone. Anything unprintable is dropped, never sliced.
fn clean_label(raw: &str) -> String {
    const NOISE: &[char] = &[
        '\u{1F4BE}', '\u{1F464}', '\u{1F465}', '\u{26A1}', '\u{1F517}', '\u{1F4E6}',
        '\u{1F3AC}', '\u{1F310}', '\u{2B50}', '\u{2601}', '\u{FE0F}', '\u{1F4C1}',
        '\u{1F4E1}', '\u{1F9F2}', '\u{1F4C0}',
    ];
    let collapse = |text: &str| {
        let joined = text
            .chars()
            .map(|c| if c == '\n' || c == '\r' { ' ' } else { c })
            .collect::<String>()
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        joined
            .trim_matches(|c: char| " -|·•:".contains(c))
            .trim()
            .to_string()
    };
    // Everything from the first metadata emoji on is machine text, not a name.
    let head = collapse(raw.split(|c| NOISE.contains(&c)).next().unwrap_or(raw));
    if head.is_empty() { collapse(raw) } else { head }
}

/// `behaviorHints.videoSize` is bytes; addons that send it are exact, so it
/// beats guessing from the title text.
fn format_bytes(bytes: u64) -> String {
    let gb = bytes as f64 / 1_000_000_000.0;
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", bytes as f64 / 1_000_000.0)
    }
}

fn video_size(stream: &Stream) -> Option<u64> {
    stream
        .behavior_hints
        .as_ref()?
        .get("videoSize")?
        .as_u64()
        .filter(|value| *value > 0)
}


/// `xt=urn:btih:<hash>` from a magnet link.
fn magnet_hash(url: &str) -> Option<String> {
    let lower = url.to_ascii_lowercase();
    if !lower.starts_with("magnet:") {
        return None;
    }
    let start = lower.find("urn:btih:")? + "urn:btih:".len();
    let hash: String = url[start..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    (!hash.is_empty()).then_some(hash)
}

pub fn normalize(addon: &str, stream: &Stream) -> StreamOption {
    let name = stream.name.clone().unwrap_or_default();
    let title = stream.title.clone().unwrap_or_default();
    let description = stream.description.clone().unwrap_or_default();
    let combined = format!("{name} {title} {description}");

    let (quality, mut score) = detect_quality(&combined);
    let size_bytes = video_size(stream);
    let size = size_bytes.map(format_bytes).or_else(|| find_size(&combined));
    let seeders = find_seeders(&combined);
    let languages = detect_languages(&combined);
    let badges = detect_badges(&combined);
    let lower = combined.to_lowercase();
    let cached = combined.contains('\u{26A1}')
        || lower.contains("cached")
        || lower.contains("instant")
        || combined.contains("[RD+]")
        || combined.contains("[AD+]");

    if cached {
        score += 24;
    }
    if let Some(seeders) = seeders {
        score += (seeders as f64).sqrt().min(12.0) as i64;
    }
    if quality == "4K" {
        score += 6;
    }

    let url = stream.url.clone();
    // A magnet/hash row is playable too: the torrent engine turns it into a
    // local HTTP stream at playback time.
    let magnet = url
        .as_deref()
        .is_some_and(|u| u.get(..7).is_some_and(|p| p.eq_ignore_ascii_case("magnet:")));
    let info_hash = stream
        .info_hash
        .clone()
        .or_else(|| url.as_deref().and_then(magnet_hash));
    let playable = magnet
        || info_hash.is_some()
        || url
            .as_deref()
            .map(|u| u.starts_with("http://") || u.starts_with("https://"))
            .unwrap_or(false);

    StreamOption {
        addon: addon.to_string(),
        name: stream.name.as_deref().map(clean_label),
        title: stream.title.as_deref().map(clean_label),
        description: stream.description.as_deref().map(clean_label),
        url,
        info_hash,
        file_idx: stream.file_idx,
        external_url: stream.external_url.clone(),
        quality,
        size,
        size_bytes,
        seeders,
        languages,
        badges,
        cached,
        playable,
        score,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_quality_and_size() {
        let (quality, _) = detect_quality("[Torrentio] Movie 2160p HDR BluRay");
        assert_eq!(quality, "4K");
        assert_eq!(find_size("💾 12.4 GB ⚡"), Some("12.4 GB".into()));
        assert_eq!(find_size("Size: 900 MB"), Some("900 MB".into()));
    }

    #[test]
    fn detects_seeders() {
        assert_eq!(find_seeders("👤 124 💾 1.2 GB"), Some(124));
        assert_eq!(find_seeders("Seeders: 8"), Some(8));
        assert_eq!(find_seeders("nothing here"), None);
    }

    #[test]
    fn marks_direct_urls_playable() {
        let direct = Stream {
            url: Some("https://cdn.example/movie.mkv".into()),
            name: Some("Provider".into()),
            ..Default::default()
        };
        assert!(normalize("A", &direct).playable);

        let torrent = Stream {
            info_hash: Some("abc123".into()),
            name: Some("Torrent".into()),
            ..Default::default()
        };
        let option = normalize("A", &torrent);
        assert!(option.playable);
        assert!(option.info_hash.is_some());

        let magnet = Stream {
            url: Some(
                "magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862&dn=film".into(),
            ),
            ..Default::default()
        };
        let option = normalize("A", &magnet);
        assert!(option.playable);
        assert_eq!(
            option.info_hash.as_deref(),
            Some("cab507494d02ebb1178b38f2e9d7be299c86b862")
        );

        let local = Stream {
            url: Some("file:///C:/movie.mkv".into()),
            ..Default::default()
        };
        assert!(!normalize("A", &local).playable);
    }

    #[test]
    fn ranks_cached_1080_above_cam() {
        let good = normalize(
            "A",
            &Stream {
                url: Some("https://x/y.mp4".into()),
                name: Some("1080p WEB-DL ⚡ cached".into()),
                ..Default::default()
            },
        );
        let bad = normalize(
            "A",
            &Stream {
                url: Some("https://x/z.mp4".into()),
                name: Some("CAM".into()),
                ..Default::default()
            },
        );
        assert!(good.score > bad.score);
    }

    #[test]
    fn strips_addon_metadata_from_labels() {
        assert_eq!(
            clean_label("The.Invite.2026.2160p\n👤 1888 💾 1.99 GB ⚡"),
            "The.Invite.2026.2160p"
        );
        assert_eq!(clean_label("[TB+] Torrentio\n1080p"), "[TB+] Torrentio 1080p");
        assert_eq!(clean_label("  "), "");
    }

    #[test]
    fn prefers_behavior_hint_size() {
        let stream = Stream {
            url: Some("https://x/y.mp4".into()),
            title: Some("Movie 1080p\n👤 12 💾 1.2 GB".into()),
            behavior_hints: Some(serde_json::json!({ "videoSize": 19_170_000_000u64 })),
            ..Default::default()
        };
        let option = normalize("A", &stream);
        assert_eq!(option.size.as_deref(), Some("19.2 GB"));
        assert_eq!(option.size_bytes, Some(19_170_000_000));
        assert_eq!(option.title.as_deref(), Some("Movie 1080p"));
    }

    // Titles from addons are arbitrary Unicode; parsing one must never slice a
    // string mid-character.
    #[test]
    fn seeders_handles_unicode_titles() {
        assert_eq!(super::find_seeders("👤 1234"), Some(1234));
        assert_eq!(super::find_seeders("★★★★ 720p seeders: 88"), Some(88));
        assert_eq!(super::find_seeders("日本語のタイトル"), None);
    }
}
