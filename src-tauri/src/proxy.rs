//! Parallel range fetching in front of mpv.
//!
//! mpv reads a remote file over one connection, so a source that is slow per
//! connection plays at exactly that speed. This serves the same bytes on
//! loopback and fetches several ranges at once, so playback runs at the sum of
//! the connections instead.

use std::fmt::Write as _;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use reqwest::header::RANGE;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::OnceCell;

/// Bytes per parallel request: big enough that request overhead vanishes,
/// small enough that one stalled request only holds back this much.
const CHUNK: u64 = 4 << 20;
/// Bytes written to the socket per pass.
const PIECE: usize = 256 << 10;
/// How far past the worker count a prefetch may run.
const SLACK: usize = 4;
/// A range that fails this often is left for mpv to report.
const MAX_ATTEMPTS: u8 = 3;
/// Poll interval while a chunk fills. A wakeup channel is not worth the races.
const POLL: Duration = Duration::from_millis(4);
/// Finished chunks kept behind the playhead, so a short seek back is instant and
/// the tail read at open does not throw the head away.
const KEEP: usize = 32 << 20;

/// A running loopback server. Dropping it stops the fetching.
pub struct StreamProxy {
    url: String,
    cancel: Arc<AtomicBool>,
    accept: tauri::async_runtime::JoinHandle<()>,
}

impl StreamProxy {
    /// `None` when the source cannot be proxied; it is then handed to mpv as-is.
    pub fn start(url: &str, threads: usize) -> Option<Self> {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).ok()?;
        listener.set_nonblocking(true).ok()?;
        let port = listener.local_addr().ok()?.port();
        let cancel = Arc::new(AtomicBool::new(false));
        let ctx = Arc::new(Ctx {
            url: url.to_string(),
            threads: threads.max(2),
            cancel: Arc::clone(&cancel),
            client: reqwest::Client::builder()
                .user_agent("Mozilla/5.0 Duvy/0.1")
                // One TCP connection per range: HTTP/2 would multiplex them all
                // onto a single flow, which is the thing being worked around.
                .http1_only()
                .build()
                .ok()?,
            target: OnceCell::new(),
        });
        let accept = tauri::async_runtime::spawn(accept_loop(listener, ctx, Arc::clone(&cancel)));
        Some(Self {
            url: format!("http://127.0.0.1:{port}/stream"),
            cancel,
            accept,
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for StreamProxy {
    fn drop(&mut self) {
        self.cancel.store(true, Ordering::Relaxed);
        self.accept.abort();
    }
}

struct Ctx {
    url: String,
    threads: usize,
    cancel: Arc<AtomicBool>,
    client: reqwest::Client,
    target: OnceCell<Target>,
}

#[derive(Clone)]
enum Target {
    /// Ranges work: chunks are fetched in parallel.
    Ranged(Arc<Store>),
    /// The origin ignores ranges, so it is passed through on one connection.
    Relay,
}

struct Store {
    /// As handed to us: the resolver URL a stale CDN link is renewed from.
    url: String,
    total: u64,
    content_type: String,
    /// The URL after redirects, so ranges go straight to the CDN.
    origin: Mutex<String>,
    chunks: Mutex<Chunks>,
    cancel: Arc<AtomicBool>,
    /// The origin asked us to back off, so the rest is read on one connection.
    single: AtomicBool,
    client: reqwest::Client,
    threads: usize,
}

#[derive(Default)]
struct Chunk {
    data: Vec<u8>,
    started: bool,
    done: bool,
    attempts: u8,
    /// A failed range waits before it is retried, so a rate limit is not hit
    /// again on the next poll.
    not_before: Option<Instant>,
}

struct Chunks {
    list: Vec<Chunk>,
    /// The chunk the reader last served, so data behind it can be dropped.
    cursor: usize,
    /// Lowest chunk that still holds data.
    low: usize,
    retained: usize,
}

impl Chunks {
    fn trim(&mut self) {
        while self.retained > KEEP && self.low < self.cursor {
            let low = self.low;
            self.retained -= self.list[low].data.len();
            // An in-flight worker writes into the fresh chunk and is left to
            // finish; it is behind the reader, so the bytes go unused.
            self.list[low] = Chunk::default();
            self.low = low + 1;
        }
    }
}

/// The probe already carries the chunk mpv asked for, so its bytes are kept
/// rather than fetched again, and the chunks after it start right away.
fn prime(store: &Arc<Store>, index: usize, response: reqwest::Response) {
    if let Ok(mut guard) = store.chunks.lock() {
        guard.list[index].started = true;
    }
    pump(store, index);
    let store = Arc::clone(store);
    let want = (store.total - index as u64 * CHUNK).min(CHUNK) as usize;
    tauri::async_runtime::spawn(async move {
        let mut response = response;
        loop {
            match response.chunk().await {
                Ok(Some(piece)) => {
                    if append(&store, index, &piece, want as u64) != Some(false) {
                        finish(&store, index);
                        return;
                    }
                }
                Ok(None) => {
                    finish(&store, index);
                    return;
                }
                Err(_) => {
                    release(&store, index);
                    return;
                }
            }
        }
    });
}

async fn accept_loop(listener: std::net::TcpListener, ctx: Arc<Ctx>, cancel: Arc<AtomicBool>) {
    let Ok(listener) = TcpListener::from_std(listener) else {
        return;
    };
    while !cancel.load(Ordering::Relaxed) {
        match listener.accept().await {
            Ok((stream, _)) => {
                tauri::async_runtime::spawn(handle_conn(Arc::clone(&ctx), stream));
            }
            Err(_) => tokio::time::sleep(Duration::from_millis(20)).await,
        }
    }
}

async fn handle_conn(ctx: Arc<Ctx>, mut stream: TcpStream) {
    // mpv seeks by reopening, but a kept-alive connection is served the same way.
    loop {
        let Some(head) = read_head(&mut stream).await else {
            return;
        };
        let Some(request) = Request::parse(&head) else {
            let _ = write_status(&mut stream, 400).await;
            return;
        };
        if request.path != "/stream" {
            let _ = write_status(&mut stream, 404).await;
            return;
        }
        if !serve_request(&ctx, &mut stream, &request).await {
            return;
        }
    }
}

async fn serve_request(ctx: &Arc<Ctx>, stream: &mut TcpStream, request: &Request) -> bool {
    let Ok(target) = target(ctx, request.from).await else {
        let _ = write_status(stream, 502).await;
        return false;
    };
    match target {
        Target::Ranged(store) => ranged(store, stream, request).await,
        Target::Relay => relay(ctx, stream, request).await,
    }
}

/// The probe asks for a whole chunk rather than one byte: its headers already
/// say the size, and its body saves mpv's first read a whole round trip. It is
/// the chunk mpv asked for, so a resume does not prefetch the wrong end.
async fn target(ctx: &Arc<Ctx>, from: u64) -> Result<Target, ()> {
    let first = from / CHUNK;
    ctx.target
        .get_or_try_init(|| async {
            let start = first * CHUNK;
            let response = ctx
                .client
                .get(&ctx.url)
                .header(RANGE, format!("bytes={start}-{}", start + CHUNK - 1))
                .send()
                .await
                .map_err(|_| ())?;
            // A 200 means the range was ignored and this body is the whole
            // file, which cannot be chunked.
            let ranged = response.status().as_u16() == 206;
            let total = response
                .headers()
                .get("content-range")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.rsplit('/').next())
                .and_then(|value| value.trim().parse::<u64>().ok())
                .filter(|total| *total > 0);
            let Some(total) = total.filter(|_| ranged) else {
                return Ok::<Target, ()>(Target::Relay);
            };
            let content_type = response
                .headers()
                .get("content-type")
                .and_then(|value| value.to_str().ok())
                .unwrap_or("application/octet-stream")
                .to_string();
            let origin = response.url().to_string();
            let count = total.div_ceil(CHUNK) as usize;
            let store = Arc::new(Store {
                url: ctx.url.clone(),
                total,
                content_type,
                origin: Mutex::new(origin),
                chunks: Mutex::new(Chunks {
                    list: (0..count).map(|_| Chunk::default()).collect(),
                    cursor: 0,
                    low: 0,
                    retained: 0,
                }),
                cancel: Arc::clone(&ctx.cancel),
                single: AtomicBool::new(false),
                client: ctx.client.clone(),
                threads: ctx.threads,
            });
            // A request past the end gets a 416 from `ranged`; priming would
            // index outside the chunk list.
            if start < total {
                prime(&store, first as usize, response);
            }
            Ok(Target::Ranged(store))
        })
        .await
        .cloned()
        .map_err(|_| ())
}

async fn ranged(store: Arc<Store>, stream: &mut TcpStream, request: &Request) -> bool {
    let from = request.from;
    let to = request
        .end
        .map_or(store.total - 1, |end| end.min(store.total - 1));
    if from > to {
        let head = format!(
            "HTTP/1.1 416 Range Not Satisfiable\r\ncontent-range: bytes */{}\r\n\
             content-length: 0\r\nconnection: close\r\n\r\n",
            store.total
        );
        let _ = stream.write_all(head.as_bytes()).await;
        return false;
    }
    let length = to - from + 1;
    let mut head = String::new();
    if request.range.is_some() {
        let _ = write!(
            head,
            "HTTP/1.1 206 Partial Content\r\ncontent-type: {}\r\ncontent-length: {length}\r\n\
             content-range: bytes {from}-{to}/{}\r\naccept-ranges: bytes\r\n\r\n",
            store.content_type, store.total
        );
    } else {
        let _ = write!(
            head,
            "HTTP/1.1 200 OK\r\ncontent-type: {}\r\ncontent-length: {length}\r\n\
             accept-ranges: bytes\r\n\r\n",
            store.content_type
        );
    }
    if stream.write_all(head.as_bytes()).await.is_err() {
        return false;
    }
    if request.head_only {
        return false;
    }
    serve(store, stream, from, to).await.is_ok()
}

/// The origin refused ranges: forward the request and pipe the answer.
async fn relay(ctx: &Arc<Ctx>, stream: &mut TcpStream, request: &Request) -> bool {
    let mut builder = ctx.client.get(&ctx.url);
    if let Some(range) = &request.range {
        builder = builder.header(RANGE, range);
    }
    let Ok(mut response) = builder.send().await else {
        return false;
    };
    let status = response.status();
    let mut head = format!(
        "HTTP/1.1 {} {}\r\n",
        status.as_u16(),
        status.canonical_reason().unwrap_or("")
    );
    for name in [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
    ] {
        if let Some(value) = response
            .headers()
            .get(name)
            .and_then(|value| value.to_str().ok())
        {
            let _ = write!(head, "{name}: {value}\r\n");
        }
    }
    head.push_str("connection: close\r\n\r\n");
    if stream.write_all(head.as_bytes()).await.is_err() || request.head_only {
        return false;
    }
    while let Ok(Some(piece)) = response.chunk().await {
        if stream.write_all(&piece).await.is_err() {
            return false;
        }
    }
    false
}

async fn serve(
    store: Arc<Store>,
    stream: &mut TcpStream,
    from: u64,
    to: u64,
) -> std::io::Result<()> {
    let mut position = from;
    while position <= to {
        if store.cancel.load(Ordering::Relaxed) {
            return Ok(());
        }
        if store.single.load(Ordering::Relaxed) {
            rescue(&store, stream, position).await;
            return Ok(());
        }
        let index = (position / CHUNK) as usize;
        pump(&store, index);
        match take(&store, index, (position % CHUNK) as usize) {
            Ready::Bytes(mut bytes) => {
                bytes.truncate((to - position + 1) as usize);
                stream.write_all(&bytes).await?;
                position += bytes.len() as u64;
            }
            Ready::Wait => tokio::time::sleep(POLL).await,
            // The parallel path gave up, so the rest is read on one connection
            // rather than failing a playback that used to work.
            Ready::Stop => {
                rescue(&store, stream, position).await;
                return Ok(());
            }
        }
    }
    Ok(())
}

/// Reads the rest of the stream on a single connection.
async fn rescue(store: &Arc<Store>, stream: &mut TcpStream, from: u64) {
    if from >= store.total {
        return;
    }
    for attempt in 0..3 {
        if attempt > 0 {
            tokio::time::sleep(Duration::from_millis(700)).await;
        }
        let Ok(mut response) = store.fetch(from, store.total - 1).await else {
            continue;
        };
        while let Ok(Some(piece)) = response.chunk().await {
            if stream.write_all(&piece).await.is_err() {
                return;
            }
        }
        return;
    }
}

enum Ready {
    Bytes(Vec<u8>),
    Wait,
    Stop,
}

fn take(store: &Store, index: usize, offset: usize) -> Ready {
    let Ok(mut guard) = store.chunks.lock() else {
        return Ready::Stop;
    };
    take_from(&mut guard, index, offset)
}

fn take_from(chunks: &mut Chunks, index: usize, offset: usize) -> Ready {
    if index > chunks.cursor {
        chunks.cursor = index;
        chunks.trim();
    }
    let chunk = &mut chunks.list[index];
    if chunk.data.len() > offset {
        let end = (offset + PIECE).min(chunk.data.len());
        return Ready::Bytes(chunk.data[offset..end].to_vec());
    }
    if chunk.done {
        // Finished without reaching this offset: the chunk was trimmed while it
        // was in flight, or the origin truncated it. Fetch it again.
        chunks.retained -= chunk.data.len();
        let attempts = chunk.attempts + 1;
        *chunk = Chunk {
            attempts,
            ..Chunk::default()
        };
        if attempts >= MAX_ATTEMPTS {
            return Ready::Stop;
        }
    }
    if chunk.attempts >= MAX_ATTEMPTS {
        return Ready::Stop;
    }
    Ready::Wait
}

/// Keep `threads` ranges in flight from `need` onwards.
fn pump(store: &Arc<Store>, need: usize) {
    let started = {
        let Ok(mut guard) = store.chunks.lock() else {
            return;
        };
        let list = &mut guard.list;
        let picked = plan(list, need, store.threads);
        for index in &picked {
            list[*index].started = true;
        }
        picked
    };
    for index in started {
        tauri::async_runtime::spawn(run_chunk(Arc::clone(store), index));
    }
}

/// Chunk indices to fetch: the reader's window, with `threads` in flight.
fn plan(list: &[Chunk], need: usize, threads: usize) -> Vec<usize> {
    let end = (need + threads + SLACK).min(list.len());
    if need >= end {
        return Vec::new();
    }
    let mut inflight = list[need..end]
        .iter()
        .filter(|chunk| chunk.started && !chunk.done)
        .count();
    let mut out = Vec::new();
    for index in need..end {
        if inflight >= threads {
            break;
        }
        let chunk = &list[index];
        if chunk.started || chunk.done || chunk.attempts >= MAX_ATTEMPTS {
            continue;
        }
        if chunk.not_before.is_some_and(|at| at > Instant::now()) {
            continue;
        }
        out.push(index);
        inflight += 1;
    }
    out
}

async fn run_chunk(store: Arc<Store>, index: usize) {
    let start = index as u64 * CHUNK;
    let end = (start + CHUNK).min(store.total).saturating_sub(1);
    let mut response = match store.fetch(start, end).await {
        Ok(response) => response,
        Err(error) => {
            crate::playback_log::mark(format!("parallel stream: {error}"));
            release(&store, index);
            return;
        }
    };
    loop {
        if store.cancel.load(Ordering::Relaxed) || store.single.load(Ordering::Relaxed) {
            release(&store, index);
            return;
        }
        match response.chunk().await {
            Ok(Some(piece)) => {
                if append(&store, index, &piece, end - start + 1) != Some(false) {
                    finish(&store, index);
                    return;
                }
            }
            Ok(None) => {
                finish(&store, index);
                return;
            }
            Err(error) => {
                crate::playback_log::mark(format!("parallel stream: {error}"));
                release(&store, index);
                return;
            }
        }
    }
}

/// Adds bytes to a chunk. `None` when the chunk was trimmed while in flight, so
/// the worker stops rather than filling memory nobody reads.
fn append(store: &Store, index: usize, piece: &[u8], expected: u64) -> Option<bool> {
    let mut guard = store.chunks.lock().ok()?;
    if index < guard.low {
        return Some(true);
    }
    let chunk = &mut guard.list[index];
    chunk.data.extend_from_slice(piece);
    let held = chunk.data.len() as u64;
    guard.retained += piece.len();
    Some(held >= expected)
}

fn finish(store: &Store, index: usize) {
    if let Ok(mut guard) = store.chunks.lock() {
        guard.list[index].done = true;
    }
}

/// Hand a failed chunk back to the reader, which retries it after a pause.
fn release(store: &Store, index: usize) {
    if let Ok(mut guard) = store.chunks.lock() {
        let held = guard.list[index].data.len();
        guard.retained = guard.retained.saturating_sub(held);
        let chunk = &mut guard.list[index];
        chunk.data.clear();
        chunk.started = false;
        chunk.attempts += 1;
        chunk.not_before =
            Some(Instant::now() + Duration::from_millis(250 * chunk.attempts as u64));
    }
}

impl Store {
    async fn fetch(&self, from: u64, to: u64) -> Result<reqwest::Response, String> {
        let mut last = String::new();
        for attempt in 0..2 {
            // The second try goes back to the resolver: it is the CDN link that
            // expires, and asking for a fresh one is the fix.
            let url = if attempt == 0 {
                match self.origin.lock() {
                    Ok(origin) => origin.clone(),
                    Err(_) => self.url.clone(),
                }
            } else {
                self.url.clone()
            };
            let sent = self
                .client
                .get(&url)
                .header(RANGE, format!("bytes={from}-{to}"))
                .send()
                .await;
            match sent {
                Ok(response) if response.status().is_success() => {
                    if let Ok(mut origin) = self.origin.lock() {
                        *origin = response.url().to_string();
                    }
                    return Ok(response);
                }
                Ok(response) => {
                    // A CDN that rate-limits parallel ranges is read the way mpv
                    // reads it, rather than failing the playback.
                    if matches!(response.status().as_u16(), 429 | 503) {
                        self.single.store(true, Ordering::Relaxed);
                    }
                    last = format!("range request answered {}", response.status());
                }
                Err(error) => last = error.to_string(),
            }
        }
        Err(last)
    }
}

struct Request {
    head_only: bool,
    path: String,
    from: u64,
    end: Option<u64>,
    range: Option<String>,
}

impl Request {
    fn parse(head: &str) -> Option<Self> {
        let mut lines = head.split("\r\n");
        let mut first = lines.next()?.split_whitespace();
        let method = first.next()?;
        let path = first.next()?.to_string();
        let mut range = None;
        for line in lines {
            let Some((name, value)) = line.split_once(':') else {
                continue;
            };
            if name.trim().eq_ignore_ascii_case("range") {
                range = Some(value.trim().to_string());
            }
        }
        let (from, end) = range.as_deref().and_then(parse_bounds).unwrap_or((0, None));
        Some(Self {
            head_only: method.eq_ignore_ascii_case("head"),
            path,
            from,
            end,
            range,
        })
    }
}

/// `bytes=1234-` and `bytes=1234-5678` are the only forms mpv sends.
fn parse_bounds(range: &str) -> Option<(u64, Option<u64>)> {
    let spec = range.split_once('=')?.1.split(',').next()?;
    let (start, end) = spec.split_once('-')?;
    let start = start.trim().parse().ok()?;
    let end = end.trim();
    Some((
        start,
        if end.is_empty() {
            None
        } else {
            end.parse().ok()
        },
    ))
}

/// One request head; `None` when the peer is gone or too slow to send it.
async fn read_head(stream: &mut TcpStream) -> Option<String> {
    let mut buffer = Vec::new();
    loop {
        if buffer.windows(4).any(|window| window == b"\r\n\r\n") {
            return String::from_utf8(buffer).ok();
        }
        if buffer.len() > 16 * 1024 {
            return None;
        }
        let mut piece = [0u8; 1024];
        let read = tokio::time::timeout(Duration::from_secs(30), stream.read(&mut piece))
            .await
            .ok()?
            .ok()?;
        if read == 0 {
            return None;
        }
        buffer.extend_from_slice(&piece[..read]);
    }
}

async fn write_status(stream: &mut TcpStream, code: u16) -> std::io::Result<()> {
    let head = format!("HTTP/1.1 {code}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n");
    stream.write_all(head.as_bytes()).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::sync::atomic::AtomicUsize;
    use std::thread;

    #[test]
    fn a_window_fills_up_to_the_thread_count() {
        let list: Vec<Chunk> = (0..20).map(|_| Chunk::default()).collect();
        assert_eq!(plan(&list, 0, 4), vec![0, 1, 2, 3]);
        // A seek starts the window where the reader landed.
        assert_eq!(plan(&list, 10, 2), vec![10, 11]);
        // Past the end there is nothing left to fetch.
        assert!(plan(&list, 20, 4).is_empty());
    }

    #[test]
    fn finished_and_failing_chunks_are_not_fetched_again() {
        let mut list: Vec<Chunk> = (0..8).map(|_| Chunk::default()).collect();
        list[0].done = true;
        list[1].attempts = MAX_ATTEMPTS;
        assert_eq!(plan(&list, 0, 2), vec![2, 3]);
        // In flight chunks count against the thread budget.
        for index in [2, 3] {
            list[index].started = true;
        }
        assert!(plan(&list, 0, 2).is_empty());
    }

    #[test]
    fn a_range_header_is_read_where_mpv_puts_it() {
        let head = "GET /stream HTTP/1.1\r\nHost: 127.0.0.1\r\nRange: bytes=1234-\r\n\r\n";
        let request = Request::parse(head).expect("parsed");
        assert_eq!(request.from, 1234);
        assert!(!request.head_only);
        let open = "GET /stream HTTP/1.1\r\n\r\n";
        assert_eq!(Request::parse(open).map(|request| request.from), Some(0));
        let closed = "GET /stream HTTP/1.1\r\nrange: bytes=10-20\r\n\r\n";
        let bounded = Request::parse(closed).expect("parsed");
        assert_eq!((bounded.from, bounded.end), (10, Some(20)));
    }

    /// A file behind a resolver redirect, the shape every debrid link has.
    struct Origin {
        port: u16,
        peak: Arc<AtomicUsize>,
        /// Where every range request started, in arrival order.
        starts: Arc<Mutex<Vec<u64>>>,
    }

    impl Origin {
        /// `throttle` lets the first chunk through and refuses the rest, the way
        /// a CDN answers too many parallel connections.
        fn start(file: Arc<Vec<u8>>, throttle: bool, rate: Option<u64>) -> Self {
            let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).expect("bind");
            let port = listener.local_addr().expect("addr").port();
            let peak = Arc::new(AtomicUsize::new(0));
            let live = Arc::new(AtomicUsize::new(0));
            let starts = Arc::new(Mutex::new(Vec::new()));
            let served = Arc::new(AtomicUsize::new(0));
            let seen = Arc::clone(&peak);
            let log = Arc::clone(&starts);
            thread::spawn(move || {
                for stream in listener.incoming() {
                    let Ok(mut stream) = stream else { return };
                    let file = Arc::clone(&file);
                    let live = Arc::clone(&live);
                    let seen = Arc::clone(&seen);
                    let log = Arc::clone(&log);
                    let served = Arc::clone(&served);
                    thread::spawn(move || {
                        let now = live.fetch_add(1, Ordering::SeqCst) + 1;
                        seen.fetch_max(now, Ordering::SeqCst);
                        answer(&mut stream, &file, throttle.then_some(&served), &log, rate);
                        live.fetch_sub(1, Ordering::SeqCst);
                    });
                }
            });
            Self { port, peak, starts }
        }

        fn starts_at(&self, from: u64) -> usize {
            self.starts
                .lock()
                .expect("starts")
                .iter()
                .filter(|start| **start == from)
                .count()
        }
    }

    fn answer(
        stream: &mut std::net::TcpStream,
        file: &[u8],
        throttle: Option<&AtomicUsize>,
        log: &Mutex<Vec<u64>>,
        rate: Option<u64>,
    ) {
        let mut head = Vec::new();
        let mut piece = [0u8; 512];
        while !head.windows(4).any(|window| window == b"\r\n\r\n") {
            let Ok(read) = stream.read(&mut piece) else {
                return;
            };
            if read == 0 {
                return;
            }
            head.extend_from_slice(&piece[..read]);
        }
        let head = String::from_utf8_lossy(&head).to_string();
        if head.contains(" /resolve ") {
            let _ = stream
                .write_all(b"HTTP/1.1 302 Found\r\nlocation: /file\r\ncontent-length: 0\r\n\r\n");
            return;
        }
        let request = Request::parse(&head).expect("parsed");
        let last = file.len() as u64 - 1;
        let from = request.from.min(last);
        let to = request.end.map_or(last, |end| end.min(last));
        log.lock().expect("starts").push(from);
        // A chunk-sized range is exactly what a rate limit refuses.
        if let Some(served) = throttle {
            if to - from + 1 == CHUNK && served.fetch_add(1, Ordering::SeqCst) > 0 {
                let _ = stream
                    .write_all(b"HTTP/1.1 429 Too Many Requests\r\ncontent-length: 0\r\n\r\n");
                return;
            }
        }
        let _ = write!(
            stream,
            "HTTP/1.1 206 Partial Content\r\ncontent-range: bytes {from}-{to}/{}\r\n\
             content-length: {}\r\naccept-ranges: bytes\r\n\r\n",
            file.len(),
            to - from + 1
        );
        let body = &file[from as usize..=to as usize];
        match rate {
            // Hold each connection to its own share of the link, which is the
            // shape of a source that is fast in aggregate but slow per stream.
            Some(rate) => {
                for piece in body.chunks(64 << 10) {
                    if stream.write_all(piece).is_err() {
                        return;
                    }
                    thread::sleep(Duration::from_secs_f64(piece.len() as f64 / rate as f64));
                }
            }
            None => {
                let _ = stream.write_all(body);
            }
        }
    }

    #[test]
    fn the_proxy_serves_a_range_from_several_connections() {
        // Five chunks, so four workers have something to do at once.
        let file: Arc<Vec<u8>> = Arc::new((0..5 * CHUNK).map(|i| (i * 31 % 251) as u8).collect());
        let origin = Origin::start(Arc::clone(&file), false, None);
        let source = format!("http://127.0.0.1:{}/resolve", origin.port);
        let proxy = StreamProxy::start(&source, 4).expect("proxy");
        let url = proxy.url().to_string();
        let expected = Arc::clone(&file);
        tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::new();
            let response = client
                .get(&url)
                .header(RANGE, format!("bytes={CHUNK}-"))
                .send()
                .await
                .expect("request");
            assert_eq!(response.status().as_u16(), 206);
            let body = response.bytes().await.expect("body");
            assert_eq!(body.len() as u64, expected.len() as u64 - CHUNK);
            assert_eq!(&body[..], &expected[CHUNK as usize..]);
            // A bounded range answers with exactly what was asked for.
            let bounded = client
                .get(&url)
                .header(RANGE, "bytes=100-1099")
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            assert_eq!(&bounded[..], &expected[100..1100]);
        });
        assert!(
            origin.peak.load(Ordering::SeqCst) >= 2,
            "the source was read on one connection"
        );
    }

    #[test]
    fn the_head_is_fetched_once_and_survives_a_jump_to_the_tail() {
        // Small enough to stay inside the keep budget.
        let file: Arc<Vec<u8>> = Arc::new((0..4 * CHUNK).map(|i| (i * 13 % 249) as u8).collect());
        let origin = Origin::start(Arc::clone(&file), false, None);
        let source = format!("http://127.0.0.1:{}/file", origin.port);
        let proxy = StreamProxy::start(&source, 4).expect("proxy");
        let url = proxy.url().to_string();
        let expected = Arc::clone(&file);
        tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::new();
            let head = client
                .get(&url)
                .header(RANGE, "bytes=0-1023")
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            assert_eq!(&head[..], &expected[..1024]);
            // The mkv tail read, then back to the start: neither may refetch.
            let tail = client
                .get(&url)
                .header(RANGE, format!("bytes={}-", 3 * CHUNK))
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            assert_eq!(&tail[..], &expected[3 * CHUNK as usize..]);
            let again = client
                .get(&url)
                .header(RANGE, "bytes=0-1023")
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            assert_eq!(&again[..], &expected[..1024]);
        });
        // The probe carries chunk 0, and the head was kept across the jump.
        assert_eq!(origin.starts_at(0), 1, "the head was fetched twice");
    }

    #[test]
    fn a_rate_limited_source_still_plays_on_one_connection() {
        let file: Arc<Vec<u8>> = Arc::new((0..4 * CHUNK).map(|i| (i * 17 % 253) as u8).collect());
        let origin = Origin::start(Arc::clone(&file), true, None);
        let source = format!("http://127.0.0.1:{}/file", origin.port);
        let proxy = StreamProxy::start(&source, 4).expect("proxy");
        let url = proxy.url().to_string();
        let expected = Arc::clone(&file);
        tauri::async_runtime::block_on(async move {
            let body = reqwest::Client::new()
                .get(&url)
                .header(RANGE, "bytes=0-")
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            assert_eq!(&body[..], &expected[..]);
        });
    }

    /// The whole point: a source that is slow per connection, fast in aggregate.
    /// Four chunks over four connections take one chunk's time, not four.
    #[test]
    fn parallel_reads_beat_a_source_that_is_slow_per_connection() {
        const RATE: u64 = 8 << 20;
        const COUNT: u64 = 4;
        let file: Arc<Vec<u8>> =
            Arc::new((0..COUNT * CHUNK).map(|i| (i * 7 % 241) as u8).collect());
        let origin = Origin::start(Arc::clone(&file), false, Some(RATE));
        let source = format!("http://127.0.0.1:{}/file", origin.port);
        let proxy = StreamProxy::start(&source, COUNT as usize).expect("proxy");
        let url = proxy.url().to_string();
        let expected = Arc::clone(&file);
        let span = format!("bytes=0-{}", COUNT * CHUNK - 1);

        let (direct, parallel) = tauri::async_runtime::block_on(async move {
            let client = reqwest::Client::new();
            let started = std::time::Instant::now();
            let one = client
                .get(&source)
                .header(RANGE, &span)
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            let direct = started.elapsed();
            assert_eq!(&one[..], &expected[..]);

            let started = std::time::Instant::now();
            let many = client
                .get(&url)
                .header(RANGE, &span)
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            let parallel = started.elapsed();
            assert_eq!(&many[..], &expected[..]);
            (direct, parallel)
        });

        println!("one connection {direct:?}, four {parallel:?}");
        assert!(
            parallel * 2 < direct,
            "four connections took {parallel:?} against {direct:?} on one"
        );
    }

    fn chunks(count: usize) -> Chunks {
        Chunks {
            list: (0..count).map(|_| Chunk::default()).collect(),
            cursor: 0,
            low: 0,
            retained: 0,
        }
    }

    #[test]
    fn a_chunk_that_finished_without_its_bytes_is_fetched_again() {
        // A chunk trimmed while its fetch was in flight lands here as done with
        // no data. Serving it as the end of the stream would truncate playback.
        let mut held = chunks(2);
        held.list[0].done = true;
        assert!(matches!(take_from(&mut held, 0, 0), Ready::Wait));
        assert_eq!(held.list[0].attempts, 1);
        assert!(!held.list[0].done);

        // One that keeps coming back empty is reported, not retried forever.
        let mut takes = 1;
        loop {
            held.list[0].done = true;
            takes += 1;
            match take_from(&mut held, 0, 0) {
                Ready::Wait => continue,
                Ready::Stop => break,
                Ready::Bytes(_) => panic!("served a chunk that has no bytes"),
            }
        }
        assert_eq!(
            takes, MAX_ATTEMPTS as usize,
            "gave up after the wrong number of tries"
        );
    }

    #[test]
    fn finished_chunks_are_kept_behind_the_playhead_until_the_budget_runs_out() {
        // Ten chunks is more than the keep budget holds.
        let mut held = chunks(10);
        for index in 0..10 {
            held.list[index].data = vec![0u8; CHUNK as usize];
            held.list[index].done = true;
            held.retained += CHUNK as usize;
        }
        held.cursor = 9;
        held.trim();
        assert!(held.retained <= KEEP, "{} bytes kept", held.retained);
        assert!(held.list[0].data.is_empty(), "the oldest chunk was kept");
        assert_eq!(
            held.list[9].data.len(),
            CHUNK as usize,
            "the chunk being read was trimmed"
        );

        // A short seek back inside the budget is served without a refetch.
        let mut held = chunks(2);
        held.list[0].data = vec![7u8; 1024];
        held.list[0].done = true;
        held.retained = 1024;
        held.cursor = 1;
        held.trim();
        assert!(
            matches!(take_from(&mut held, 0, 0), Ready::Bytes(bytes) if bytes == vec![7u8; 1024])
        );
    }

    #[test]
    fn a_resume_does_not_prefetch_the_start_of_the_file() {
        let file: Arc<Vec<u8>> = Arc::new((0..4 * CHUNK).map(|i| (i * 29 % 251) as u8).collect());
        let origin = Origin::start(Arc::clone(&file), false, None);
        let source = format!("http://127.0.0.1:{}/file", origin.port);
        let proxy = StreamProxy::start(&source, 4).expect("proxy");
        let url = proxy.url().to_string();
        let expected = Arc::clone(&file);
        let at = 2 * CHUNK + 100;
        tauri::async_runtime::block_on(async move {
            let body = reqwest::Client::new()
                .get(&url)
                .header(RANGE, format!("bytes={at}-"))
                .send()
                .await
                .expect("request")
                .bytes()
                .await
                .expect("body");
            assert_eq!(&body[..], &expected[at as usize..]);
        });
        assert_eq!(origin.starts_at(0), 0, "the head was fetched for a resume");
        assert_eq!(
            origin.starts_at(2 * CHUNK),
            1,
            "the resumed chunk was not primed"
        );
    }

    #[test]
    fn a_request_past_the_end_is_refused() {
        let file: Arc<Vec<u8>> = Arc::new(vec![0u8; 1024]);
        let origin = Origin::start(Arc::clone(&file), false, None);
        let source = format!("http://127.0.0.1:{}/file", origin.port);
        let proxy = StreamProxy::start(&source, 4).expect("proxy");
        let url = proxy.url().to_string();
        tauri::async_runtime::block_on(async move {
            let response = reqwest::Client::new()
                .get(&url)
                .header(RANGE, "bytes=5000-")
                .send()
                .await
                .expect("request");
            assert_eq!(response.status().as_u16(), 416);
        });
    }
}
