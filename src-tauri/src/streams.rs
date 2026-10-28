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

/// `behaviorHints.videoSize` is bytes. Addons print sizes in binary units, so
/// the badge uses the same base and matches the filename beside it.
fn format_bytes(bytes: u64) -> String {
    let gb = bytes as f64 / 1_073_741_824.0;
    if gb >= 1.0 {
        format!("{gb:.1} GB")
    } else {
        format!("{:.0} MB", bytes as f64 / 1_048_576.0)
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

/// The torrent engine reads a 40-char hex or 32-char base32 info hash; anything
/// else is not a target, so a row carrying one must not look playable. Matches
/// `torrent::normalize_source`.
pub fn valid_hash(value: &str) -> bool {
    let value = value.trim();
    let hex = value.len() == 40 && value.bytes().all(|byte| byte.is_ascii_hexdigit());
    let base32 =
        value.len() == 32 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() && !matches!(byte, b'0' | b'1' | b'8' | b'9'));
    hex || base32
}

fn is_http_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("http://") || lower.starts_with("https://")
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
    // A magnet or bare hash row is playable too: the torrent engine turns it
    // into a local HTTP stream at playback time.
    let info_hash = stream
        .info_hash
        .clone()
        .filter(|hash| valid_hash(hash))
        .or_else(|| url.as_deref().and_then(magnet_hash).filter(|hash| valid_hash(hash)))
        .or_else(|| {
            url.as_deref()
                .filter(|value| valid_hash(value))
                .map(str::to_string)
        });
    let playable = info_hash.is_some() || url.as_deref().is_some_and(is_http_url);

    StreamOption {
        addon: addon.to_string(),
        name: stream.name.clone(),
        title: stream.title.clone(),
        description: stream.description.clone(),
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

/// One row per distinct target. Two rows with the same hash at different file
/// indexes are two files of one pack, so both survive.
pub fn dedupe(options: Vec<StreamOption>) -> Vec<StreamOption> {
    let mut seen = std::collections::HashSet::new();
    options
        .into_iter()
        .filter(|option| {
            let url = option.url.as_deref().filter(|url| !url.is_empty());
            match (url, &option.info_hash) {
                (Some(url), _) => seen.insert(url.to_ascii_lowercase()),
                (None, Some(hash)) => seen.insert(format!(
                    "{}#{}",
                    hash.to_ascii_lowercase(),
                    option
                        .file_idx
                        .map(|index| index.to_string())
                        .unwrap_or_default()
                )),
                (None, None) => false,
            }
        })
        .collect()
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
            info_hash: Some("cab507494d02ebb1178b38f2e9d7be299c86b862".into()),
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
    fn prefers_behavior_hint_size() {
        let stream = Stream {
            url: Some("https://x/y.mp4".into()),
            title: Some("Movie 1080p\n👤 12 💾 1.2 GB".into()),
            behavior_hints: Some(serde_json::json!({ "videoSize": 19_170_000_000u64 })),
            ..Default::default()
        };
        let option = normalize("A", &stream);
        assert_eq!(option.size.as_deref(), Some("17.9 GB"));
        assert_eq!(option.size_bytes, Some(19_170_000_000));
        assert_eq!(option.title.as_deref(), Some("Movie 1080p\n\u{1F464} 12 \u{1F4BE} 1.2 GB"));
    }

    // Titles from addons are arbitrary Unicode; parsing one must never slice a
    // string mid-character.
    #[test]
    fn seeders_handles_unicode_titles() {
        assert_eq!(super::find_seeders("👤 1234"), Some(1234));
        assert_eq!(super::find_seeders("★★★★ 720p seeders: 88"), Some(88));
        assert_eq!(super::find_seeders("日本語のタイトル"), None);
    }

    const HASH: &str = "cab507494d02ebb1178b38f2e9d7be299c86b862";

    fn pack_row(file_idx: i64) -> StreamOption {
        normalize(
            "A",
            &Stream {
                info_hash: Some(HASH.into()),
                file_idx: Some(file_idx),
                ..Default::default()
            },
        )
    }

    #[test]
    fn drops_rows_without_a_usable_target() {
        // A bare hash in `url` is what the frontend resolves as a torrent.
        let bare = normalize(
            "A",
            &Stream {
                url: Some(HASH.into()),
                ..Default::default()
            },
        );
        assert!(bare.playable);
        assert_eq!(bare.info_hash.as_deref(), Some(HASH));

        // A magnet with no btih, and a hash the engine cannot read, are not
        // selectable targets: they used to fail only after the click.
        let empty_magnet = normalize(
            "A",
            &Stream {
                url: Some("magnet:?dn=film".into()),
                ..Default::default()
            },
        );
        assert!(!empty_magnet.playable);
        assert!(empty_magnet.info_hash.is_none());

        let junk = normalize(
            "A",
            &Stream {
                info_hash: Some("abc123".into()),
                ..Default::default()
            },
        );
        assert!(!junk.playable);
        assert!(junk.info_hash.is_none());

        // 32 alphanumeric is not enough: base32 has no 0, 1, 8 or 9.
        let bad_base32 = normalize(
            "A",
            &Stream {
                info_hash: Some("0123456789ABCDEFGHIJKLMNOPQRSTUV".into()),
                ..Default::default()
            },
        );
        assert!(!bad_base32.playable);
    }

    #[test]
    fn dedupe_keeps_each_file_of_a_pack() {
        let rows = dedupe(vec![pack_row(0), pack_row(1), pack_row(1)]);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].file_idx, Some(0));
        assert_eq!(rows[1].file_idx, Some(1));
    }

    #[test]
    fn dedupe_drops_notice_rows_and_repeats() {
        let notice = normalize(
            "A",
            &Stream {
                name: Some("Download the app".into()),
                ..Default::default()
            },
        );
        assert!(dedupe(vec![notice]).is_empty());

        let direct = |url: &str| {
            normalize(
                "A",
                &Stream {
                    url: Some(url.into()),
                    ..Default::default()
                },
            )
        };
        let rows = dedupe(vec![
            direct("https://x/y.mp4"),
            direct("https://x/y.mp4"),
            direct("https://x/z.mp4"),
        ]);
        assert_eq!(rows.len(), 2);
    }
}
