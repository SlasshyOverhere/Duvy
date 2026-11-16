//! Seek-bar previews: one frame decoded by a short-lived headless libmpv.
//!
//! The running player is never touched. Each preview is a disposable libmpv
//! instance with `vo=image` that writes a single jpg into its own temp folder.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use libmpv2::events::Event;

const BUCKET_SECONDS: f64 = 5.0;
/// Downscaled frames are small, so a few dozen still fit in a few megabytes.
const CACHE_LIMIT: usize = 48;
const TIMEOUT: Duration = Duration::from_secs(8);
/// The blocking task cannot be cancelled, so the await is bounded on its own.
const DECODE_TIMEOUT: Duration = Duration::from_secs(10);
/// A preview is a thumbnail, never a full-resolution frame.
const PREVIEW_FILTER: &str = "scale=-2:180";

/// A hover sweep must not spawn a dozen decoders and stall the real playback.
const DECODERS: usize = 2;

/// One frame is one source at one time bucket.
type Key = (u64, u64);

/// Snap to the preview bucket the seek bar hovers over.
fn bucket(seconds: f64) -> f64 {
    if !seconds.is_finite() || seconds <= 0.0 {
        return 0.0;
    }
    (seconds / BUCKET_SECONDS).round() * BUCKET_SECONDS
}

/// FNV-1a: the cache never hands one stream's frame to another.
fn source_hash(source: &str) -> u64 {
    let mut hash = 0xcbf2_9ce4_8422_2325u64;
    for byte in source.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

fn frame_key(source: &str, seconds: f64) -> Key {
    (source_hash(source), bucket(seconds).to_bits())
}

static CACHE: OnceLock<Mutex<Vec<(Key, String)>>> = OnceLock::new();
static GENERATION: AtomicU64 = AtomicU64::new(1);

fn cache() -> &'static Mutex<Vec<(Key, String)>> {
    CACHE.get_or_init(|| Mutex::new(Vec::new()))
}

/// A new source means every cached frame belongs to the old one.
pub fn clear() {
    // A decode already running carries the old stamp and is never cached.
    GENERATION.fetch_add(1, Ordering::Relaxed);
    if let Ok(mut entries) = cache().lock() {
        entries.clear();
    }
}

fn cached(key: Key) -> Option<String> {
    let entries = cache().lock().ok()?;
    entries
        .iter()
        .find(|(seen, _)| *seen == key)
        .map(|(_, data)| data.clone())
}

fn remember(key: Key, data: String) {
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
pub async fn preview(source: &str, seconds: f64) -> Result<String, String> {
    let key = frame_key(source, seconds);
    if let Some(hit) = cached(key) {
        return Ok(hit);
    }
    // One decode per key: a second hover waits for the first instead of
    // starting another decoder.
    let (leader, waiter) = {
        let mut map = inflight().lock().await;
        match map.get(&key) {
            Some(tx) => (None, Some((tx.clone(), tx.subscribe()))),
            None => {
                // The first decode may have finished between the two locks.
                if let Some(hit) = cached(key) {
                    return Ok(hit);
                }
                let (tx, _) = tokio::sync::broadcast::channel(1);
                map.insert(key, tx.clone());
                (Some(tx), None)
            }
        }
    };
    if let Some((tx, mut waiter)) = waiter {
        return match tokio::time::timeout(Duration::from_secs(30), waiter.recv()).await {
            Ok(Ok(result)) => result,
            _ => {
                // The leader vanished; drop its slot so the next hover retries.
                forget(key, &tx).await;
                Err("The preview is busy".into())
            }
        };
    }
    let Some(tx) = leader else {
        return Err("The preview is busy".into());
    };
    // A cancelled leader must not leave its slot behind.
    let _slot = Slot {
        key,
        tx: tx.clone(),
    };
    let generation = GENERATION.load(Ordering::Relaxed);
    let result = decode(source, bucket(seconds)).await;
    if generation == GENERATION.load(Ordering::Relaxed)
        && let Ok(data) = &result
    {
        remember(key, data.clone());
    }
    let _ = tx.send(result.clone());
    forget(key, &tx).await;
    result
}

type Job = tokio::sync::broadcast::Sender<Result<String, String>>;

static INFLIGHT: OnceLock<tokio::sync::Mutex<HashMap<Key, Job>>> = OnceLock::new();

fn inflight() -> &'static tokio::sync::Mutex<HashMap<Key, Job>> {
    INFLIGHT.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()))
}

/// Removes our own slot, never one a newer leader installed.
async fn forget(key: Key, tx: &Job) {
    let mut map = inflight().lock().await;
    if map.get(&key).is_some_and(|job| job.same_channel(tx)) {
        map.remove(&key);
    }
}

/// Cancellation cannot await, so the guard is the best-effort path; `forget`
/// covers every normal exit.
struct Slot {
    key: Key,
    tx: Job,
}

impl Drop for Slot {
    fn drop(&mut self) {
        if let Ok(mut map) = inflight().try_lock()
            && map
                .get(&self.key)
                .is_some_and(|job| job.same_channel(&self.tx))
        {
            map.remove(&self.key);
        }
    }
}

/// Removes the folder once the core is torn down, including on an error path.
struct Cleanup(PathBuf);

impl Drop for Cleanup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

async fn decode(source: &str, at: f64) -> Result<String, String> {
    static SLOTS: OnceLock<tokio::sync::Semaphore> = OnceLock::new();
    let slots = SLOTS.get_or_init(|| tokio::sync::Semaphore::new(DECODERS));
    let _slot = match tokio::time::timeout(TIMEOUT, slots.acquire()).await {
        Ok(Ok(slot)) => slot,
        Ok(Err(_)) => return Err("The preview is busy".into()),
        Err(_) => return Err("The preview is busy".into()),
    };

    let source = source.to_owned();
    match tokio::time::timeout(
        DECODE_TIMEOUT,
        tokio::task::spawn_blocking(move || grab(&source, at)),
    )
    .await
    {
        Ok(Ok(frame)) => frame,
        Ok(Err(e)) => Err(format!("The preview frame failed: {e}")),
        Err(_) => Err("The preview frame took too long".into()),
    }
}

/// A truncated or empty write is not a frame the UI can show.
fn is_jpeg(bytes: &[u8]) -> bool {
    bytes.len() >= 512 && bytes.starts_with(&[0xff, 0xd8, 0xff])
}

/// Blocking: libmpv decodes one frame, writes it, then the core is torn down.
fn grab(source: &str, at: f64) -> Result<String, String> {
    // One folder per call: concurrent previews cannot read each other's jpg.
    let dir = std::env::temp_dir().join(format!("duvy-frame-{}-{}", std::process::id(), stamp()));
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Could not create the preview folder: {e}"))?;
    // Declared first, so it runs after mpv is gone and never deletes a live file.
    let _cleanup = Cleanup(dir.clone());
    let outdir = dir
        .to_str()
        .ok_or("The preview folder path is not valid UTF-8")?
        .to_string();
    let start = format!("{at:.3}");
    let mpv = libmpv2::Mpv::with_initializer(|init| {
        init.set_option("config", "no")?;
        init.set_option("load-scripts", "no")?;
        init.set_option("input-default-bindings", "no")?;
        init.set_option("terminal", "no")?;
        let _ = init.set_option("really-quiet", "yes");
        init.set_option("audio", "no")?;
        init.set_option("sub", "no")?;
        init.set_option("hr-seek", "yes")?;
        init.set_option("frames", "1")?;
        init.set_option("vf", PREVIEW_FILTER)?;
        init.set_option("vo", "image")?;
        init.set_option("vo-image-format", "jpg")?;
        init.set_option("vo-image-outdir", outdir.as_str())?;
        init.set_option("start", start.as_str())?;
        Ok(())
    })
    .map_err(|e| format!("Could not start mpv for the preview: {e}"))?;

    mpv.command("loadfile", &[source, "replace"])
        .map_err(|_| "mpv could not decode a preview frame".to_string())?;

    let deadline = Instant::now() + TIMEOUT;
    loop {
        match mpv.wait_event(0.1) {
            Some(Ok(Event::EndFile(_) | Event::Shutdown)) => break,
            // A bad source fails the load instead of reaching EndFile.
            Some(Err(libmpv2::Error::Raw(-13))) => {
                return Err("mpv could not decode a preview frame".into());
            }
            _ => {}
        }
        if Instant::now() >= deadline {
            return Err("The preview frame took too long".into());
        }
    }
    drop(mpv);

    // mpv's file naming differs between builds; one folder holds one frame.
    let file = std::fs::read_dir(&dir)
        .map_err(|e| format!("Could not read the preview folder: {e}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .find(|path| path.is_file())
        .ok_or("mpv wrote no preview frame")?;
    let bytes =
        std::fs::read(&file).map_err(|e| format!("Could not read the preview frame: {e}"))?;
    if !is_jpeg(&bytes) {
        return Err("mpv wrote no usable preview frame".into());
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
    use super::{base64, bucket, cached, frame_key, is_jpeg, remember, source_hash};

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

    #[test]
    fn a_frame_is_only_cached_under_its_own_source() {
        assert_ne!(source_hash("https://a/movie.mkv"), source_hash("https://b/movie.mkv"));
        let first = frame_key("https://a/movie.mkv", 12.0);
        let other = frame_key("https://b/movie.mkv", 12.0);
        remember(first, "jpeg".to_string());
        assert_eq!(cached(first).as_deref(), Some("jpeg"));
        assert_eq!(cached(other), None, "another source must not see it");
        // Same source, another bucket: still a different frame.
        assert_eq!(cached(frame_key("https://a/movie.mkv", 30.0)), None);
    }

    #[test]
    fn only_a_real_jpeg_passes_validation() {
        let mut frame = vec![0xff, 0xd8, 0xff, 0xe0];
        frame.resize(1024, 0);
        assert!(is_jpeg(&frame));
        assert!(!is_jpeg(b""), "an empty write is not a frame");
        assert!(!is_jpeg(&frame[..200]), "a truncated write is not a frame");
        let mut png = vec![0x89, b'P', b'N', b'G'];
        png.resize(1024, 0);
        assert!(!is_jpeg(&png), "a png is not a jpeg");
    }
}
