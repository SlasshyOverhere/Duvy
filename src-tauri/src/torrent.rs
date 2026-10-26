//! P2P streaming (BitTorrent) for the stream picker.
//!
//! A single `librqbit` session is kept alive while a stream is playing: the
//! selected file is served from a loopback HTTP endpoint that honours `Range`,
//! so mpv can seek as if it were a normal remote file. Metadata is resolved
//! before the URL is handed back because the stream route needs the file index.
//!
//! The whole engine is torn down (session, torrent, files, port) on `stop`.

use crate::settings::Settings;
use crate::AppState;
use librqbit::api::{Api, TorrentIdOrHash};
use librqbit::http_api::{HttpApi, HttpApiOptions};
use librqbit::{
    AddTorrent, AddTorrentOptions, AddTorrentResponse, DhtSessionConfig, ListenerMode,
    ListenerOptions, ManagedTorrent, Session, SessionOptions,
};
use librqbit_dualstack_sockets::{BindOpts, TcpListener};
use serde::Serialize;
use std::net::{Ipv4Addr, SocketAddr};
use std::path::{Path, PathBuf};
use std::sync::{Arc, OnceLock};
use std::time::Duration;
use tauri::{Manager, State};
use tokio::sync::Mutex;

/// How long the picker waits for metadata before giving up on a source.
const METADATA_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TorrentStats {
    pub active: bool,
    pub name: String,
    pub progress: f64,
    pub download_bps: f64,
    pub upload_bps: f64,
    pub peers: i64,
    pub seeds: i64,
}

struct Engine {
    session: Arc<Session>,
    torrent: usize,
    handle: Arc<ManagedTorrent>,
    http: tokio::task::JoinHandle<()>,
    url: String,
    name: String,
    dir: PathBuf,
}

impl Engine {
    async fn shutdown(self) {
        // Dropping the server future closes the listener, which frees the port.
        self.http.abort();
        let _ = self
            .session
            .delete(TorrentIdOrHash::Id(self.torrent), true)
            .await;
        self.session.stop().await;
        // Files can still be held by the OS for a moment; a leftover directory
        // is pruned on the next start, so a failure here is not fatal.
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

fn engine() -> &'static Mutex<Option<Engine>> {
    static ENGINE: OnceLock<Mutex<Option<Engine>>> = OnceLock::new();
    ENGINE.get_or_init(|| Mutex::new(None))
}

/// Serialises start/stop so two sources cannot fight over the cache directory.
fn lifecycle() -> &'static Mutex<()> {
    static LIFECYCLE: OnceLock<Mutex<()>> = OnceLock::new();
    LIFECYCLE.get_or_init(|| Mutex::new(()))
}

#[tauri::command]
pub async fn start(
    source: String,
    file_hint: Option<String>,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let (consent, cache_mb) = {
        let conn = state
            .db
            .0
            .lock()
            .map_err(|_| "settings are unavailable".to_string())?;
        let settings = Settings::load(&conn);
        (settings.p2p_consent, settings.p2p_cache_mb)
    };
    if !consent {
        return Err(
            "Peer-to-peer streaming is turned off. Enable P2P streaming in Settings first.".into(),
        );
    }

    let source = normalize_source(&source)?;
    let cache = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("could not locate the app data folder: {e}"))?
        .join("torrent-cache");

    let _guard = lifecycle().lock().await;
    let previous = { engine().lock().await.take() };
    if let Some(previous) = previous {
        previous.shutdown().await;
    }

    let running = launch(&source, file_hint.as_deref(), cache, cache_mb).await?;
    let url = running.url.clone();
    *engine().lock().await = Some(running);
    Ok(url)
}

#[tauri::command]
pub async fn stats(_state: State<'_, AppState>) -> Result<TorrentStats, String> {
    let guard = engine().lock().await;
    let Some(running) = guard.as_ref() else {
        return Ok(TorrentStats::default());
    };

    let stats = running.handle.stats();
    let live = stats.live.as_ref();
    Ok(TorrentStats {
        active: true,
        name: running.name.clone(),
        progress: if stats.total_bytes == 0 {
            0.0
        } else {
            stats.progress_bytes as f64 / stats.total_bytes as f64
        },
        download_bps: live
            .map(|l| l.download_speed.as_bytes() as f64)
            .unwrap_or(0.0),
        upload_bps: live
            .map(|l| l.upload_speed.as_bytes() as f64)
            .unwrap_or(0.0),
        peers: live.map(|l| l.snapshot.peer_stats.live as i64).unwrap_or(0),
        // librqbit only exposes aggregate peer counts, not how many of them
        // hold the complete torrent, so there is no honest seeder number here.
        seeds: 0,
    })
}

#[tauri::command]
pub async fn stop(_state: State<'_, AppState>) -> Result<(), String> {
    let _guard = lifecycle().lock().await;
    let running = { engine().lock().await.take() };
    if let Some(running) = running {
        running.shutdown().await;
    }
    Ok(())
}

async fn launch(
    source: &str,
    hint: Option<&str>,
    dir: PathBuf,
    cache_mb: i64,
) -> Result<Engine, String> {
    prepare_cache(&dir, cache_mb)?;
    let session = Session::new_with_opts(
        dir.clone(),
        SessionOptions {
            dht: Some(DhtSessionConfig {
                persistence: None,
                ..DhtSessionConfig::default()
            }),
            listen: Some(ListenerOptions {
                mode: ListenerMode::TcpOnly,
                listen_addr: SocketAddr::from(([0, 0, 0, 0], 0)),
                enable_upnp_port_forwarding: false,
                utp_opts: None,
                announce_port: None,
                ipv4_only: true,
                max_pending_incoming_handshake_checks: 256,
            }),
            ..SessionOptions::default()
        },
    )
    .await
    .map_err(|e| format!("could not start the torrent engine: {e:#}"))?;

    // A magnet with no reachable peers can wait on metadata indefinitely.
    match tokio::time::timeout(METADATA_TIMEOUT, prepare(&session, source, hint, &dir)).await {
        Ok(Ok(running)) => Ok(running),
        Ok(Err(error)) => {
            session.stop().await;
            Err(error)
        }
        Err(_) => {
            session.stop().await;
            Err("Timed out waiting for peers to send the torrent metadata".into())
        }
    }
}

async fn prepare(
    session: &Arc<Session>,
    source: &str,
    hint: Option<&str>,
    dir: &Path,
) -> Result<Engine, String> {
    let output_folder = dir.to_string_lossy().into_owned();

    // `list_only` waits for metadata without writing any content, so the file
    // list is available before the real download is started.
    let listed = session
        .add_torrent(
            AddTorrent::from_url(source),
            Some(AddTorrentOptions {
                list_only: true,
                output_folder: Some(output_folder.clone()),
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| format!("could not fetch torrent metadata: {e:#}"))?;
    let AddTorrentResponse::ListOnly(list) = listed else {
        return Err("the torrent engine did not return metadata".into());
    };

    let files: Vec<(String, u64)> = list
        .info
        .iter_file_details()
        .map(|file| (file.filename.to_string(), file.len))
        .collect();
    let index = pick_file(&files, hint).ok_or("this torrent has no playable files")?;
    let name = list
        .info
        .name()
        .map(|n| n.into_owned())
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| files[index].0.clone());

    let added = session
        .add_torrent(
            AddTorrent::from_bytes(list.torrent_bytes),
            Some(AddTorrentOptions {
                only_files: Some(vec![index]),
                overwrite: true,
                output_folder: Some(output_folder),
                ..Default::default()
            }),
        )
        .await
        .map_err(|e| format!("could not start the torrent: {e:#}"))?;
    let (torrent, handle) = match added {
        AddTorrentResponse::Added(id, handle)
        | AddTorrentResponse::AlreadyManaged(id, handle) => (id, handle),
        AddTorrentResponse::ListOnly(_) => return Err("the torrent engine did not start".into()),
    };

    let api = Api::new(session.clone(), None, None);
    let http = HttpApi::new(
        api,
        Some(HttpApiOptions {
            read_only: true,
            ..Default::default()
        }),
    );
    let listener = TcpListener::bind_tcp(
        SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
        BindOpts {
            request_dualstack: false,
            reuseport: false,
            device: None,
        },
    )
    .map_err(|e| format!("could not open a local stream port: {e}"))?;
    let port = listener.bind_addr().port();
    let http = tokio::spawn(async move {
        if let Err(error) = http.make_http_api_and_run(listener, None).await {
            eprintln!("torrent stream server stopped: {error:#}");
        }
    });

    Ok(Engine {
        session: session.clone(),
        torrent,
        handle,
        http,
        url: format!("http://127.0.0.1:{port}/torrents/{torrent}/stream/{index}"),
        name,
        dir: dir.to_path_buf(),
    })
}

// ---------------------------------------------------------------------------
// Source parsing and file selection
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS: &[&str] = &[
    "mp4", "mkv", "avi", "webm", "m4v", "mov", "ts", "m2ts", "mpg", "mpeg", "wmv", "flv", "3gp",
];

/// Returns the URL to hand to librqbit: a magnet link as given, or a bare info
/// hash lowercased (librqbit accepts either, but only these two forms).
fn normalize_source(source: &str) -> Result<String, String> {
    let source = source.trim();
    if source.is_empty() {
        return Err("No torrent source was provided".into());
    }
    if let Some(query) = source.strip_prefix("magnet:?") {
        if magnet_info_hash(query).is_none() {
            return Err("That magnet link does not contain a valid BTIH info hash".into());
        }
        return Ok(source.to_string());
    }
    if source.len() == 40 && source.chars().all(|c| c.is_ascii_hexdigit()) {
        return Ok(source.to_ascii_lowercase());
    }
    Err("Unsupported torrent source: expected a magnet link or a 40-character info hash".into())
}

fn magnet_info_hash(query: &str) -> Option<String> {
    query
        .split('&')
        .filter_map(|pair| pair.split_once('='))
        .filter(|(key, _)| key.eq_ignore_ascii_case("xt"))
        .find_map(|(_, value)| {
            let hash = value.strip_prefix("urn:btih:")?;
            if hash.len() == 40 && hash.chars().all(|c| c.is_ascii_hexdigit()) {
                Some(hash.to_ascii_lowercase())
            } else if hash.len() == 32 && hash.chars().all(|c| c.is_ascii_alphanumeric()) {
                Some(hash.to_ascii_uppercase())
            } else {
                None
            }
        })
}

fn is_video(name: &str) -> bool {
    name.rsplit_once('.')
        .map(|(_, ext)| {
            let ext = ext.to_ascii_lowercase();
            VIDEO_EXTENSIONS.contains(&ext.as_str())
        })
        .unwrap_or(false)
}

/// Chooses the file to stream.
///
/// A numeric hint is a Stremio `fileIdx` and wins outright. A text hint is
/// matched against the file name (exact, then suffix, then substring, preferring
/// the largest). Without a usable hint the largest video wins, falling back to
/// the largest file of any kind so an unusual container still plays.
fn pick_file(files: &[(String, u64)], hint: Option<&str>) -> Option<usize> {
    if files.is_empty() {
        return None;
    }
    if let Some(hint) = hint.map(str::trim).filter(|h| !h.is_empty()) {
        if let Ok(index) = hint.parse::<usize>() {
            if index < files.len() {
                return Some(index);
            }
        } else if let Some(index) = best_name_match(files, hint) {
            return Some(index);
        }
    }
    largest(files, true).or_else(|| largest(files, false))
}

fn best_name_match(files: &[(String, u64)], hint: &str) -> Option<usize> {
    let needle = hint.to_ascii_lowercase();
    let mut best: Option<(u8, u64, usize)> = None;
    for (index, (name, length)) in files.iter().enumerate() {
        let lower = name.to_ascii_lowercase();
        let base = lower.rsplit('/').next().unwrap_or(lower.as_str());
        let score = if lower == needle || base == needle {
            3
        } else if lower.ends_with(&needle) || base.ends_with(&needle) {
            2
        } else if lower.contains(&needle) {
            1
        } else {
            continue;
        };
        let better = match best {
            None => true,
            Some((score_best, length_best, _)) => {
                score > score_best || (score == score_best && *length > length_best)
            }
        };
        if better {
            best = Some((score, *length, index));
        }
    }
    best.map(|(_, _, index)| index)
}

fn largest(files: &[(String, u64)], video_only: bool) -> Option<usize> {
    files
        .iter()
        .enumerate()
        .filter(|(_, (name, _))| !video_only || is_video(name))
        .max_by_key(|(_, (_, length))| *length)
        .map(|(index, _)| index)
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

fn dir_size(dir: &Path) -> u64 {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return 0;
    };
    entries
        .filter_map(|entry| entry.ok())
        .map(|entry| {
            let path = entry.path();
            if path.is_dir() {
                dir_size(&path)
            } else {
                entry.metadata().map(|meta| meta.len()).unwrap_or(0)
            }
        })
        .sum()
}

/// librqbit streams the whole selected file to disk and has no sliding-window
/// cache, so the configured budget is enforced between sessions: leftovers above
/// `p2p_cache_mb` are wiped before a new torrent starts.
fn prepare_cache(dir: &Path, cache_mb: i64) -> Result<(), String> {
    let budget = cache_mb.max(64) as u64 * 1024 * 1024;
    if dir_size(dir) > budget {
        std::fs::remove_dir_all(dir)
            .map_err(|e| format!("could not clear the torrent cache: {e}"))?;
    }
    std::fs::create_dir_all(dir).map_err(|e| format!("could not create the torrent cache: {e}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn file(name: &str, length: u64) -> (String, u64) {
        (name.to_string(), length)
    }

    #[test]
    fn accepts_a_magnet_link() {
        let magnet = "magnet:?xt=urn:btih:cab507494d02ebb1178b38f2e9d7be299c86b862&dn=film";
        assert_eq!(normalize_source(magnet).unwrap(), magnet);
    }

    #[test]
    fn accepts_a_bare_hash_in_any_case() {
        let hash = "CAB507494D02EBB1178B38F2E9D7BE299C86B862";
        assert_eq!(
            normalize_source(hash).unwrap(),
            "cab507494d02ebb1178b38f2e9d7be299c86b862"
        );
        assert_eq!(
            normalize_source("  cab507494d02ebb1178b38f2e9d7be299c86b862  ").unwrap(),
            "cab507494d02ebb1178b38f2e9d7be299c86b862"
        );
    }

    #[test]
    fn accepts_a_base32_magnet_hash() {
        let magnet = "magnet:?xt=urn:btih:ZLFSSUSD6C7XELWI7HOT5VZ3JEWGDGWC";
        assert!(normalize_source(magnet).is_ok());
        assert_eq!(
            magnet_info_hash("xt=urn:btih:zlfssusd6c7xelwi7hot5vz3jewgdgwc").unwrap(),
            "ZLFSSUSD6C7XELWI7HOT5VZ3JEWGDGWC"
        );
    }

    #[test]
    fn rejects_sources_it_cannot_stream() {
        assert!(normalize_source("").is_err());
        assert!(normalize_source("   ").is_err());
        assert!(normalize_source("https://example.com/film.torrent").is_err());
        assert!(normalize_source("magnet:?dn=film").is_err());
        assert!(normalize_source("magnet:?xt=urn:btih:nothex").is_err());
        // 39 and 41 characters are not info hashes.
        assert!(normalize_source(&"a".repeat(39)).is_err());
        assert!(normalize_source(&"a".repeat(41)).is_err());
        assert!(normalize_source("zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz").is_err());
    }

    #[test]
    fn numeric_hint_selects_the_index() {
        let files = vec![file("a.mkv", 1), file("b.mkv", 2), file("c.mkv", 3)];
        assert_eq!(pick_file(&files, Some("1")), Some(1));
        // Out of range falls back to the largest video.
        assert_eq!(pick_file(&files, Some("9")), Some(2));
    }

    #[test]
    fn name_hint_beats_size() {
        let files = vec![
            file("Show/S01E01.mkv", 900),
            file("Show/S01E02.mkv", 950),
            file("Show/Sample.mkv", 50),
        ];
        assert_eq!(pick_file(&files, Some("S01E01")), Some(0));
        assert_eq!(pick_file(&files, Some("sample.mkv")), Some(2));
        // Unknown text hint falls back to the largest video.
        assert_eq!(pick_file(&files, Some("nothing")), Some(1));
    }

    #[test]
    fn picks_the_largest_video_and_skips_extras() {
        let files = vec![
            file("film.nfo", 40_000),
            file("film.srt", 9_000),
            file("film.mkv", 5_000),
            file("film.mp4", 6_000),
        ];
        assert_eq!(pick_file(&files, None), Some(3));
    }

    #[test]
    fn falls_back_to_the_largest_file_without_a_video() {
        let files = vec![file("readme.txt", 10), file("data.bin", 99)];
        assert_eq!(pick_file(&files, None), Some(1));
        assert_eq!(pick_file(&[], None), None);
    }

    #[test]
    fn video_detection_is_case_insensitive() {
        assert!(is_video("Film.MKV"));
        assert!(is_video("clip.webm"));
        assert!(!is_video("film.srt"));
        assert!(!is_video("mkv"));
    }
}
