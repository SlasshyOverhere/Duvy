//! Seek-bar previews: one frame decoded by a throwaway headless mpv.
//!
//! The running player is never touched. Each preview is a short-lived mpv with
//! `--vo=image` that writes a single jpg into its own temp folder and exits.

use std::collections::HashMap;
use std::path::Path;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const BUCKET_SECONDS: f64 = 5.0;
const CACHE_LIMIT: usize = 80;
const TIMEOUT: Duration = Duration::from_secs(8);

/// A hover sweep must not spawn a dozen decoders and stall the real playback.
const DECODERS: usize = 2;

/// Snap to the preview bucket the seek bar hovers over.
pub fn bucket(seconds: f64) -> f64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0.0;
    }
    (seconds / BUCKET_SECONDS).round() * BUCKET_SECONDS
}

static CACHE: OnceLock<Mutex<Vec<(f64, String)>>> = OnceLock::new();

fn cache() -> &'static Mutex<Vec<(f64, String)>> {
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// A new source means every cached frame belongs to the old one.
pub fn clear() {
    if let Ok(mut entries) = cache().lock() {
        entries.clear();
    }
}

fn cached(key: f64) -> Option<String> {
    let entries = cache().lock().ok()?;
    entries
        .iter()
        .find(|(seen, _)| *seen == key)
        .map(|(_, data)| data.clone())
}

fn remember(key: f64, data: String) {
    let Ok(mut entries) = cache().lock() else {
        return;
    };
    entries.retain(|(seen, _)| *seen != key);
    entries.push((key, data));
    if entries.len() > CACHE_LIMIT {
        entries.remove(0);
    }
}

/// Standard-alphabet base64 with `=` padding.
pub fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 63) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// `data:image/jpeg;base64,...` for the requested time, cached per bucket.
pub async fn preview(mpv: &str, source: &str, seconds: f64) -> Result<String, String> {
    let key = bucket(seconds);
    if let Some(hit) = cached(key) {
        return Ok(hit);
    }
    let id = key.to_bits();
    // One decode per bucket: a second hover waits for the first instead of
    // spawning another mpv.
    let waiter = {
        let mut map = inflight().lock().await;
        match map.get(&id) {
            Some(tx) => Some(tx.subscribe()),
            None => {
                // The first decode may have finished between the two locks.
                if let Some(hit) = cached(key) {
                    return Ok(hit);
                }
                let (tx, _) = tokio::sync::broadcast::channel(1);
                map.insert(id, tx);
                None
            }
        }
    };
    if let Some(mut waiter) = waiter {
        return match tokio::time::timeout(Duration::from_secs(30), waiter.recv()).await {
            Ok(Ok(result)) => result,
            _ => {
                // The leader vanished; drop the slot so the next hover retries.
                inflight().lock().await.remove(&id);
                Err("The preview is busy".into())
            }
        };
    }
    let result = capture(mpv, source, key).await;
    if let Ok(data) = &result {
        remember(key, data.clone());
    }
    if let Some(tx) = inflight().lock().await.remove(&id) {
        let _ = tx.send(result.clone());
    }
    result
}

type Job = tokio::sync::broadcast::Sender<Result<String, String>>;

static INFLIGHT: OnceLock<tokio::sync::Mutex<HashMap<u64, Job>>> = OnceLock::new();

fn inflight() -> &'static tokio::sync::Mutex<HashMap<u64, Job>> {
    INFLIGHT.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

async fn capture(mpv: &str, source: &str, at: f64) -> Result<String, String> {
    // One folder per call: concurrent previews cannot read each other's jpg.
    let dir = std::env::temp_dir().join(format!(
        "betternuvio-frame-{}-{}",
        std::process::id(),
        stamp()
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the preview folder: {e}"))?;
    let result = decode(mpv, source, at, &dir).await;
    let _ = std::fs::remove_dir_all(&dir);
    result
}

async fn decode(mpv: &str, source: &str, at: f64, dir: &Path) -> Result<String, String> {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let slots = SLOTS.get_or_init(|| tokio::sync::Semaphore::new(DECODERS));
    let _slot = match tokio::time::timeout(TIMEOUT, slots.acquire()).await {
        Ok(Ok(slot)) => slot,
        Ok(Err(_)) => return Err("The preview is busy".into()),
        Err(_) => return Err("The preview is busy".into()),
    };

    let mut command = tokio::process::Command::new(mpv);
    #[cfg(windows)]
    {
        // No console window flash for the throwaway decoder.
        command.creation_flags(0x0800_0000);
    }
    command
        .arg("--no-config")
        .arg("--load-scripts=no")
        .arg("--no-input-default-bindings")
        .arg("--no-terminal")
        .arg("--really-quiet")
        .arg("--no-audio")
        .arg("--no-sub")
        .arg("--hr-seek=yes")
        .arg(format!("--start={at:.3}"))
        .arg("--frames=1")
        .arg("--vo=image")
        .arg("--vo-image-format=jpg")
        .arg(format!("--vo-image-outdir={}", dir.display()))
        .arg("--")
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .kill_on_drop(true);

    let mut child = command
        .spawn()
        .map_err(|e| format!("Could not start mpv for the preview: {e}"))?;
    let status = match tokio::time::timeout(TIMEOUT, child.wait()).await {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            let _ = child.kill().await;
            return Err(format!("The preview frame failed: {e}"));
        }
        Err(_) => {
            let _ = child.kill().await;
            return Err("The preview frame took too long".into());
        }
    };
    if !status.success() {
        return Err("mpv could not decode a preview frame".into());
    }

    // mpv's file naming differs between builds; one folder holds one frame.
    let file = std::fs::read_dir(dir)
        .map_err(|e| format!("Could not read the preview folder: {e}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_file())
        .ok_or("mpv wrote no preview frame")?;
    let bytes =
        std::fs::read(&file).map_err(|e| format!("Could not read the preview frame: {e}"))?;
    if bytes.is_empty() {
        return Err("mpv wrote an empty preview frame".into());
    }
    Ok(format!("data:image/jpeg;base64,{}", base64(&bytes)))
}

fn stamp() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos}-{}", COUNTER.fetch_add(1, Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::{base64, bucket};

    #[test]
    fn base64_pads_every_length() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64(&[0xff, 0x00, 0x80]), "/wCA");
        assert_eq!(base64(&[0, 1, 2, 3]), "AAECAw==");
    }

    /// Every byte once: catches alphabet, grouping and padding slips at once.
    #[test]
    fn base64_matches_the_whole_byte_range() {
        let all: Vec<u8> = (0..=255).collect();
        assert_eq!(
            base64(&all),
            "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/w=="
        );
    }

    #[test]
    fn preview_keys_snap_to_five_seconds() {
        assert_eq!(bucket(-3.0), 0.0);
        assert_eq!(bucket(0.0), 0.0);
        assert_eq!(bucket(2.4), 0.0);
        assert_eq!(bucket(2.6), 5.0);
        assert_eq!(bucket(7.5), 10.0);
        assert_eq!(bucket(72.4), 70.0);
        assert_eq!(bucket(f64::NAN), 0.0);
    }
}
