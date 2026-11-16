//! Jellyfin and Emby servers: sign-in, library browsing and direct stream links.
//!
//! Both servers speak the same MediaBrowser-style API, so one client covers
//! them. The access token and user id live in the `servers` blob beside the
//! account record and never cross the command boundary: the UI only ever sees
//! the public `Server` shape, and playback gets an opaque handle the player
//! resolves here.

use crate::{AppState, db};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::sync::LazyLock;
use std::time::Duration;
use tauri::State;

const KEY_BLOB: &str = "servers";
const TIMEOUT: Duration = Duration::from_secs(15);
/// Far past any real library page, and enough to stop a hostile server from
/// buffering the machine out of memory.
const MAX_BODY: usize = 4 * 1024 * 1024;
const PAGE: usize = 200;
const MAX_ITEMS: usize = 10_000;
/// Streams cross the command boundary as this handle, never as a URL with a key.
const HANDLE: &str = "duvy-srv://";
const CLIENT: &str =
    r#"MediaBrowser Client="Duvy", Device="Desktop", DeviceId="duvy", Version="0.1.0""#;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Server {
    pub id: String,
    pub kind: String,
    pub name: String,
    pub url: String,
    pub username: String,
}

/// The stored shape carries the session, which is never serialised to the UI.
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct Stored {
    id: String,
    kind: String,
    name: String,
    url: String,
    username: String,
    #[serde(default)]
    token: String,
    #[serde(default)]
    user_id: String,
}

impl Stored {
    fn public(&self) -> Server {
        Server {
            id: self.id.clone(),
            kind: self.kind.clone(),
            name: self.name.clone(),
            url: self.url.clone(),
            username: self.username.clone(),
        }
    }
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ServerItem {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub year: Option<i32>,
    pub image: String,
    pub series_id: Option<String>,
    pub series_name: Option<String>,
    pub season: Option<i32>,
    pub episode: Option<i32>,
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

fn label(kind: &str) -> &'static str {
    if kind.eq_ignore_ascii_case("emby") {
        "Emby"
    } else {
        "Jellyfin"
    }
}

fn canonical_kind(kind: &str) -> Option<&'static str> {
    match kind.trim().to_ascii_lowercase().as_str() {
        "jellyfin" => Some("jellyfin"),
        "emby" => Some("emby"),
        _ => None,
    }
}

/// Names that never leave the user's own network: literal LAN addresses,
/// single-label hostnames and the usual mDNS/router suffixes.
fn lan_host(host: &str) -> bool {
    let host = host.trim_end_matches('.').to_ascii_lowercase();
    crate::addons::is_local_host(&host)
        || !host.contains('.')
        || [".local", ".lan", ".home.arpa", ".internal", ".home"]
            .iter()
            .any(|suffix| host.ends_with(suffix))
}

fn normalize_url(raw: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() {
        return Err("Enter the server address, for example http://192.168.1.10:8096.".into());
    }
    let parsed = url::Url::parse(raw)
        .map_err(|_| "The server address must start with http:// or https://.".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("The server address must start with http:// or https://.".into());
    }
    // Userinfo in the address would end up in every log line and in mpv's.
    if !parsed.username().is_empty() || parsed.password().is_some() {
        return Err("Remove the username and password from the address.".into());
    }
    let host = parsed.host_str().ok_or("That address has no host.")?;
    if crate::addons::is_blocked_host(host) {
        return Err("That address is not a media server.".into());
    }
    // A token over cleartext is only tolerable inside the user's own network.
    if parsed.scheme() == "http" && !lan_host(host) {
        return Err("Use https:// for a server outside your own network.".into());
    }
    Ok(parsed.as_str().trim_end_matches('/').to_string())
}

fn host_label(url: &str) -> String {
    url.split("://")
        .nth(1)
        .unwrap_or(url)
        .split('/')
        .next()
        .unwrap_or(url)
        .to_string()
}

fn auth_header() -> &'static str {
    CLIENT
}

/// Token-bearing calls never hop off the origin they were sent to: reqwest
/// strips `Authorization` only on a cross-host hop, and a 307 would replay the
/// sign-in password body. Same-origin path changes stay allowed.
fn same_origin(previous: &url::Url, next: &url::Url) -> bool {
    previous.scheme() == next.scheme()
        && previous.host_str() == next.host_str()
        && previous.port_or_known_default() == next.port_or_known_default()
}

fn token_client() -> reqwest::Client {
    static SHARED: LazyLock<reqwest::Client> = LazyLock::new(|| {
        reqwest::Client::builder()
            .timeout(TIMEOUT)
            .redirect(reqwest::redirect::Policy::custom(|attempt| {
                let stays = attempt
                    .previous()
                    .last()
                    .is_some_and(|previous| same_origin(previous, attempt.url()));
                if stays && attempt.previous().len() < 3 {
                    attempt.follow()
                } else {
                    attempt.error("refusing to send a server token to another host")
                }
            }))
            .build()
            .expect("the media server client should build")
    });
    SHARED.clone()
}

/// `Authorization: MediaBrowser Token="..."` is the documented form, and the one
/// reqwest itself strips on a cross-host hop.
fn token_request(request: reqwest::RequestBuilder, token: &str) -> reqwest::RequestBuilder {
    request
        .header("X-Emby-Authorization", auth_header())
        .header("Authorization", format!("MediaBrowser Token=\"{token}\""))
}

fn parse_auth(value: &Value) -> Option<(String, String)> {
    let token = value.get("AccessToken")?.as_str()?.trim();
    let user_id = value.pointer("/User/Id")?.as_str()?.trim();
    (!token.is_empty() && !user_id.is_empty()).then(|| (token.to_string(), user_id.to_string()))
}

/// Ids and tokens from a server reply are escaped before they go into a URL; an
/// id carrying `&` or `?` would otherwise rewrite the request.
fn esc(value: &str) -> String {
    url::form_urlencoded::byte_serialize(value.as_bytes()).collect()
}

/// Posters are fetched without a token, so only servers that allow anonymous
/// image access show artwork. Streams carry their own `api_key` instead.
fn item_image(base: &str, item_id: &str) -> String {
    format!("{base}/Items/{}/Images/Primary?maxWidth=400", esc(item_id))
}

fn parse_items(base: &str, value: &Value) -> Vec<ServerItem> {
    value
        .get("Items")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let id = item.get("Id").and_then(Value::as_str)?.to_string();
                    Some(ServerItem {
                        image: item_image(base, &id),
                        name: item
                            .get("Name")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string(),
                        kind: item
                            .get("Type")
                            .and_then(Value::as_str)
                            .unwrap_or("Movie")
                            .to_string(),
                        year: item
                            .get("ProductionYear")
                            .and_then(Value::as_i64)
                            .and_then(|year| i32::try_from(year).ok()),
                        series_id: text_field(item, "SeriesId"),
                        series_name: text_field(item, "SeriesName"),
                        season: item
                            .get("ParentIndexNumber")
                            .and_then(Value::as_i64)
                            .and_then(|number| i32::try_from(number).ok()),
                        episode: item
                            .get("IndexNumber")
                            .and_then(Value::as_i64)
                            .and_then(|number| i32::try_from(number).ok()),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Items the page reported, before the ones without an id were dropped.
fn item_count(value: &Value) -> usize {
    value
        .get("Items")
        .and_then(Value::as_array)
        .map_or(0, Vec::len)
}

fn text_field(item: &Value, key: &str) -> Option<String> {
    item.get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
}

/// Picks the best media source from a PlaybackInfo reply: direct play first so
/// mpv gets the original file, any source otherwise.
fn media_source(value: &Value) -> Option<String> {
    let sources = value.get("MediaSources")?.as_array()?;
    let direct = sources.iter().find(|source| {
        source
            .get("SupportsDirectPlay")
            .and_then(Value::as_bool)
            .unwrap_or(false)
    });
    direct
        .or_else(|| sources.first())
        .and_then(|source| source.get("Id"))
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The authenticated URL, built inside Rust only.
fn stream_url(base: &str, item_id: &str, source: Option<&str>, token: &str) -> String {
    let mut url = format!("{base}/Videos/{}/stream?static=true", esc(item_id));
    if let Some(source) = source {
        url.push_str("&MediaSourceId=");
        url.push_str(&esc(source));
    }
    url.push_str("&api_key=");
    url.push_str(&esc(token));
    url
}

/// What crosses the command boundary instead of the URL: no token, no query.
fn stream_handle(server_id: &str, item_id: &str) -> String {
    format!("{HANDLE}{server_id}/{item_id}")
}

fn safe_part(part: &str) -> bool {
    !part.is_empty()
        && part
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn parse_handle(handle: &str) -> Option<(&str, &str)> {
    let (server, item) = handle.trim().strip_prefix(HANDLE)?.split_once('/')?;
    (safe_part(server) && safe_part(item)).then_some((server, item))
}

/// True for a handle, so the player seam knows it must ask this module for a URL.
pub fn is_stream_handle(handle: &str) -> bool {
    handle.trim().starts_with(HANDLE)
}

/// Bounded read: a hostile or broken server must not fill memory with a reply.
async fn reply_json(mut reply: reqwest::Response, kind: &str) -> Result<Value, String> {
    let too_large = || format!("{} sent a reply that is too large.", label(kind));
    if reply
        .content_length()
        .is_some_and(|len| len > MAX_BODY as u64)
    {
        return Err(too_large());
    }
    let mut body = Vec::new();
    while let Some(chunk) = reply
        .chunk()
        .await
        .map_err(|error| format!("{} sent an unreadable reply: {error}", label(kind)))?
    {
        if body.len() + chunk.len() > MAX_BODY {
            return Err(too_large());
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|error| format!("{} sent an unreadable reply: {error}", label(kind)))
}

fn sign_in_error(kind: &str, detail: &str) -> String {
    format!("{} rejected that sign-in: {detail}", label(kind))
}

fn unreachable(kind: &str, error: &reqwest::Error) -> String {
    format!("Could not reach the {} server: {error}", label(kind))
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

fn read(conn: &Connection) -> Result<Vec<Stored>, String> {
    let Some(value) = db::read_secret_kv(conn, KEY_BLOB).map_err(|error| error.to_string())? else {
        return Ok(Vec::new());
    };
    serde_json::from_value::<Vec<Stored>>(value)
        .map_err(|error| format!("The saved server list could not be read: {error}"))
}

fn write(conn: &Connection, servers: &[Stored]) -> Result<(), String> {
    let value = serde_json::to_value(servers).map_err(|error| error.to_string())?;
    db::write_secret_kv(conn, KEY_BLOB, &value).map_err(|error| error.to_string())
}

fn load(state: &AppState) -> Result<Vec<Stored>, String> {
    let conn = state.db.conn();
    read(&conn)
}

/// One lock covers the whole read-modify-write, so two commands cannot drop
/// each other's change.
fn update(
    state: &AppState,
    change: impl FnOnce(&mut Vec<Stored>) -> Result<(), String>,
) -> Result<Vec<Stored>, String> {
    let conn = state.db.conn();
    let mut servers = read(&conn)?;
    change(&mut servers)?;
    write(&conn, &servers)?;
    Ok(servers)
}

/// Millisecond stamps collide when two adds land in the same tick, so the id
/// walks forward until it is free.
fn next_id(servers: &[Stored], kind: &str) -> String {
    let mut stamp = db::now();
    loop {
        let id = format!("{kind}-{stamp}");
        if !servers.iter().any(|server| server.id == id) {
            return id;
        }
        stamp += 1;
    }
}

fn public(servers: &[Stored]) -> Vec<Server> {
    servers.iter().map(Stored::public).collect()
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn srv_list(state: State<'_, AppState>) -> Result<Vec<Server>, String> {
    Ok(public(&load(state.inner())?))
}

#[tauri::command]
pub async fn srv_add(
    kind: String,
    url: String,
    username: String,
    password: String,
    state: State<'_, AppState>,
) -> Result<Vec<Server>, String> {
    let kind = canonical_kind(&kind).ok_or("Unknown server type. Pick Jellyfin or Emby.")?;
    let url = normalize_url(&url)?;
    let username = username.trim().to_string();
    if username.is_empty() {
        return Err("Enter the server username.".into());
    }

    let http = state.http.clone();
    let reply = token_client()
        .post(format!("{url}/Users/AuthenticateByName"))
        .timeout(TIMEOUT)
        .header("X-Emby-Authorization", auth_header())
        .json(&serde_json::json!({ "Username": username, "Pw": password }))
        .send()
        .await
        .map_err(|error| unreachable(kind, &error))?;

    let status = reply.status();
    if !status.is_success() {
        return Err(sign_in_error(kind, &status.to_string()));
    }
    let value = reply_json(reply, kind).await?;
    let (token, user_id) = parse_auth(&value)
        .ok_or_else(|| sign_in_error(kind, "the reply carried no access token"))?;

    let name = server_name(&http, &url)
        .await
        .unwrap_or_else(|| host_label(&url));

    let servers = update(state.inner(), move |servers| {
        let id = next_id(servers, kind);
        servers.push(Stored {
            id,
            kind: kind.to_string(),
            name,
            url,
            username,
            token,
            user_id,
        });
        Ok(())
    })?;
    Ok(public(&servers))
}

#[tauri::command]
pub async fn srv_remove(
    id: String,
    app: tauri::AppHandle,
    state: State<'_, AppState>,
) -> Result<Vec<Server>, String> {
    if !crate::confirm(
        &app,
        "Remove server",
        "The saved server and its sign-in are removed from Duvy.",
    ) {
        return Err("Removal cancelled".into());
    }
    let servers = update(state.inner(), |servers| {
        servers.retain(|server| server.id != id);
        Ok(())
    })?;
    Ok(public(&servers))
}

#[tauri::command]
pub async fn srv_items(
    id: String,
    kind: Option<String>,
    parent_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<Vec<ServerItem>, String> {
    let servers = load(state.inner())?;
    let server = servers
        .iter()
        .find(|server| server.id == id)
        .ok_or("That media server is no longer connected.")?;
    let http = token_client();

    let parent_id = parent_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let url = if let Some(parent) = parent_id {
        // Children of a season are episodes; children of a show are seasons,
        // plus any episode the server hung straight off the show.
        let types = match parent_type(&http, server, &parent).await.as_deref() {
            Some("Season") => "Episode",
            _ => "Season,Episode",
        };
        format!(
            "{}/Users/{}/Items?ParentId={}&IncludeItemTypes={types}&Fields=ProductionYear,SeriesName&SortBy=SortName",
            server.url,
            esc(&server.user_id),
            esc(&parent)
        )
    } else {
        let types = match kind.as_deref().map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("movie") => "Movie",
            Some(value) if value.eq_ignore_ascii_case("series") => "Series",
            _ => "Movie,Series",
        };
        format!(
            "{}/Users/{}/Items?Recursive=true&IncludeItemTypes={types}&Fields=ProductionYear,SeriesName&SortBy=SortName",
            server.url,
            esc(&server.user_id)
        )
    };
    collect_items(&http, server, &url).await
}

/// Pages until the server runs out: one 200-item page hides the rest of a
/// larger library.
async fn collect_items(
    http: &reqwest::Client,
    server: &Stored,
    base: &str,
) -> Result<Vec<ServerItem>, String> {
    let mut items = Vec::new();
    let mut start = 0;
    loop {
        let url = format!("{base}&StartIndex={start}&Limit={PAGE}");
        let request = token_request(http.get(url).timeout(TIMEOUT), &server.token);
        let reply = request
            .send()
            .await
            .map_err(|error| unreachable(&server.kind, &error))?;
        let status = reply.status();
        if !status.is_success() {
            return Err(format!(
                "{} answered {status}. The saved session may have expired; remove the server and add it again.",
                label(&server.kind)
            ));
        }
        let value = reply_json(reply, &server.kind).await?;
        let page = item_count(&value);
        items.extend(parse_items(&server.url, &value));
        if page < PAGE || items.len() >= MAX_ITEMS {
            return Ok(items);
        }
        start += page;
    }
}

/// The parent's own type, so a season only asks for its episodes.
async fn parent_type(
    http: &reqwest::Client,
    server: &Stored,
    parent_id: &str,
) -> Option<String> {
    let url = format!(
        "{}/Users/{}/Items/{}",
        server.url,
        esc(&server.user_id),
        esc(parent_id)
    );
    let reply = token_request(http.get(url).timeout(TIMEOUT), &server.token)
        .send()
        .await
        .ok()?;
    if !reply.status().is_success() {
        return None;
    }
    let value = reply_json(reply, &server.kind).await.ok()?;
    value
        .get("Type")
        .and_then(Value::as_str)
        .map(str::to_string)
}

/// The player seam calls this: a handle in, the authenticated URL out.
pub async fn resolve_stream(state: &AppState, handle: &str) -> Result<String, String> {
    let (server_id, item_id) =
        parse_handle(handle).ok_or("That stream link is no longer valid.")?;
    let servers = load(state)?;
    let server = servers
        .iter()
        .find(|server| server.id == server_id)
        .ok_or("That media server is no longer connected.")?;

    // PlaybackInfo names the media source the static stream needs.
    let info_url = format!(
        "{}/Items/{}/PlaybackInfo?UserId={}",
        server.url,
        esc(item_id),
        esc(&server.user_id)
    );
    let request = token_request(
        token_client().post(info_url).timeout(TIMEOUT),
        &server.token,
    )
    .json(&serde_json::json!({ "UserId": server.user_id }));
    let reply = request
        .send()
        .await
        .map_err(|error| unreachable(&server.kind, &error))?;
    let status = reply.status();
    if !status.is_success() {
        return Err(format!(
            "{} could not prepare that item: {status}",
            label(&server.kind)
        ));
    }
    let value = reply_json(reply, &server.kind).await?;
    Ok(stream_url(
        &server.url,
        item_id,
        media_source(&value).as_deref(),
        &server.token,
    ))
}

#[tauri::command]
pub async fn srv_stream(
    id: String,
    item_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let item_id = item_id.trim();
    if item_id.is_empty() {
        return Err("Nothing to play.".into());
    }
    if !safe_part(&id) || !safe_part(item_id) {
        return Err("That item cannot be played.".into());
    }
    // The handle is all the UI gets; `resolve_stream` adds the token later.
    let servers = load(state.inner())?;
    if !servers.iter().any(|server| server.id == id) {
        return Err("That media server is no longer connected.".into());
    }
    Ok(stream_handle(&id, item_id))
}

async fn server_name(http: &reqwest::Client, base: &str) -> Option<String> {
    let reply = http
        .get(format!("{base}/System/Info/Public"))
        .timeout(TIMEOUT)
        .send()
        .await
        .ok()?;
    if !reply.status().is_success() {
        return None;
    }
    let value = reply_json(reply, "jellyfin").await.ok()?;
    value
        .get("ServerName")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn urls_are_trimmed_and_checked() {
        assert_eq!(
            normalize_url(" http://192.168.1.10:8096/ ").unwrap(),
            "http://192.168.1.10:8096"
        );
        assert_eq!(
            normalize_url("https://media.example.com/jellyfin///").unwrap(),
            "https://media.example.com/jellyfin"
        );
        assert!(normalize_url("192.168.1.10:8096").is_err());
        assert!(normalize_url("   ").is_err());
        assert_eq!(host_label("http://192.168.1.10:8096"), "192.168.1.10:8096");
        assert_eq!(
            host_label("https://media.example.com/jellyfin"),
            "media.example.com"
        );
    }

    #[test]
    fn urls_reject_credentials_and_public_cleartext() {
        assert!(normalize_url("https://user:pw@media.example.com").is_err());
        assert!(normalize_url("https://user@media.example.com").is_err());
        // A cloud metadata address is never a media server.
        assert!(normalize_url("http://169.254.169.254").is_err());
        assert!(normalize_url("https://metadata.google.internal").is_err());
        // Cleartext is only for the user's own network.
        assert!(normalize_url("http://media.example.com").is_err());
        assert!(normalize_url("http://93.184.216.34:8096").is_err());
        assert!(normalize_url("http://jellyfin.lan:8096").is_ok());
        assert!(normalize_url("http://nas:8096").is_ok());
        assert!(normalize_url("http://127.0.0.1:8096").is_ok());
        assert!(normalize_url("https://media.example.com").is_ok());
    }

    #[test]
    fn auth_header_identifies_the_client() {
        let header = auth_header();
        assert!(header.contains(r#"Client="Duvy""#));
        assert!(header.contains(r#"Device="Desktop""#));
        assert!(header.contains(r#"DeviceId="duvy""#));
        assert!(header.contains(r#"Version="0.1.0""#));
        assert!(!header.to_ascii_lowercase().contains("token="));
    }

    #[test]
    fn items_map_to_posters() {
        let payload = json!({
            "Items": [
                { "Id": "abc", "Name": "Dune", "Type": "Movie", "ProductionYear": 2021 },
                { "Id": "def", "Name": "Severance", "Type": "Series" },
                { "Name": "no id, so it is dropped" }
            ]
        });
        let items = parse_items("http://host:8096", &payload);
        assert_eq!(items.len(), 2);
        assert_eq!(items[0].name, "Dune");
        assert_eq!(items[0].kind, "Movie");
        assert_eq!(items[0].year, Some(2021));
        assert_eq!(
            items[0].image,
            "http://host:8096/Items/abc/Images/Primary?maxWidth=400"
        );
        assert_eq!(items[1].year, None);
    }

    #[test]
    fn episodes_carry_series_and_numbers() {
        let payload = json!({
            "Items": [{
                "Id": "ep1",
                "Name": "The We We Are",
                "Type": "Episode",
                "SeriesId": "show1",
                "SeriesName": "Severance",
                "ParentIndexNumber": 1,
                "IndexNumber": 9
            }]
        });
        let items = parse_items("http://host:8096", &payload);
        assert_eq!(items[0].kind, "Episode");
        assert_eq!(items[0].series_id.as_deref(), Some("show1"));
        assert_eq!(items[0].series_name.as_deref(), Some("Severance"));
        assert_eq!(items[0].season, Some(1));
        assert_eq!(items[0].episode, Some(9));
    }

    #[test]
    fn playback_info_selects_a_direct_source() {
        let reply = json!({
            "MediaSources": [
                { "Id": "transcode", "SupportsDirectPlay": false },
                { "Id": "direct", "SupportsDirectPlay": true }
            ]
        });
        assert_eq!(media_source(&reply).as_deref(), Some("direct"));
        assert_eq!(media_source(&json!({})), None);
        assert_eq!(
            stream_url("http://host:8096", "ep1", Some("direct"), "tok"),
            "http://host:8096/Videos/ep1/stream?static=true&MediaSourceId=direct&api_key=tok"
        );
        assert_eq!(
            stream_url("http://host:8096", "m1", None, "tok"),
            "http://host:8096/Videos/m1/stream?static=true&api_key=tok"
        );
    }

    #[test]
    fn sign_in_and_auth_replies_are_readable() {
        let reply = json!({ "AccessToken": "tok", "User": { "Id": "user-1" } });
        assert_eq!(
            parse_auth(&reply),
            Some(("tok".to_string(), "user-1".to_string()))
        );
        assert_eq!(
            parse_auth(&json!({ "AccessToken": "", "User": { "Id": "user-1" } })),
            None
        );

        assert_eq!(label("emby"), "Emby");
        assert_eq!(
            sign_in_error("emby", "401 Unauthorized"),
            "Emby rejected that sign-in: 401 Unauthorized"
        );
        assert_eq!(canonical_kind(" Emby "), Some("emby"));
        assert_eq!(canonical_kind("plex"), None);
    }

    #[test]
    fn a_stream_handle_carries_no_token() {
        let handle = stream_handle("jellyfin-1", "abc123");
        assert_eq!(handle, "duvy-srv://jellyfin-1/abc123");
        assert!(!handle.contains("api_key"));
        assert!(!handle.contains("tok"));
        assert_eq!(parse_handle(&handle), Some(("jellyfin-1", "abc123")));
        assert!(is_stream_handle(&handle));
        // A real stream URL is never mistaken for a handle.
        let url = stream_url("http://host:8096", "m1", None, "tok");
        assert!(!is_stream_handle(&url));
        assert_eq!(parse_handle(&url), None);
        assert_eq!(parse_handle("duvy-srv://a/b/c"), None);
        assert_eq!(parse_handle("duvy-srv:///b"), None);
    }

    #[test]
    fn a_redirect_may_not_change_the_origin() {
        let origin = url::Url::parse("http://192.168.1.10:8096/Users").expect("url");
        let same = url::Url::parse("http://192.168.1.10:8096/Users/Login").expect("url");
        let other_host = url::Url::parse("http://evil.example/Users").expect("url");
        let other_port = url::Url::parse("http://192.168.1.10:9999/Users").expect("url");
        let upgrade = url::Url::parse("https://192.168.1.10:8096/Users").expect("url");
        assert!(same_origin(&origin, &same));
        assert!(!same_origin(&origin, &other_host));
        assert!(!same_origin(&origin, &other_port));
        assert!(!same_origin(&origin, &upgrade));
    }

    /// A token-bearing call must not follow a hop, and must not reach the target.
    #[test]
    fn a_token_request_does_not_follow_a_cross_host_redirect() {
        use std::io::{Read, Write};
        use std::net::TcpListener;

        let target = TcpListener::bind("127.0.0.1:0").expect("bind target");
        target.set_nonblocking(true).expect("nonblocking");
        let target_port = target.local_addr().expect("addr").port();
        let front = TcpListener::bind("127.0.0.1:0").expect("bind front");
        let front_port = front.local_addr().expect("addr").port();

        let server = std::thread::spawn(move || {
            let (mut socket, _) = front.accept().expect("accept");
            let mut buffer = [0u8; 2048];
            let _ = socket.read(&mut buffer);
            let reply = format!(
                "HTTP/1.1 307 Temporary Redirect\r\nLocation: http://localhost:{target_port}/steal\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            );
            let _ = socket.write_all(reply.as_bytes());
        });

        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("test runtime");
        let result = runtime.block_on(async {
            token_client()
                .post(format!("http://127.0.0.1:{front_port}/Users/AuthenticateByName"))
                .body("{\"Username\":\"u\",\"Pw\":\"secret\"}")
                .send()
                .await
        });
        server.join().expect("server thread");
        assert!(result.is_err(), "the redirect must be refused, not followed");
        assert!(
            target.accept().is_err(),
            "no request may reach the redirect target"
        );
    }

    /// F-022: a panic while holding the lock must not brick the server list.
    #[test]
    fn a_poisoned_database_still_serves_the_server_list() {
        let path = std::env::temp_dir().join(format!("duvy-servers-test-{}.db", std::process::id()));
        let state = AppState {
            db: db::Db(std::sync::Mutex::new(
                db::open(&path).expect("test database opens"),
            )),
            http: reqwest::Client::new(),
            player: crate::PlayerSlot::new(),
            settings: std::sync::RwLock::new(None),
        };

        let poisoned = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            let _guard = state.db.0.lock().expect("lock");
            panic!("poison the database lock");
        }));
        assert!(poisoned.is_err());

        assert_eq!(load(&state).expect("the list still reads").len(), 0);
        assert_eq!(
            update(&state, |servers| {
                servers.push(Stored {
                    id: "jellyfin-1".into(),
                    kind: "jellyfin".into(),
                    name: "Home".into(),
                    url: "http://192.168.1.10:8096".into(),
                    username: "u".into(),
                    token: "tok".into(),
                    user_id: "user-1".into(),
                });
                Ok(())
            })
            .expect("the list still writes")
            .len(),
            1
        );

        drop(state);
        for suffix in ["", "-wal", "-shm"] {
            let mut file = path.clone().into_os_string();
            file.push(suffix);
            let _ = std::fs::remove_file(std::path::PathBuf::from(file));
        }
    }
}
