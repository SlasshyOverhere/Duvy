//! Jellyfin and Emby servers: sign-in, library browsing and direct stream links.
//!
//! Both servers speak the same MediaBrowser-style API, so one client covers
//! them. The access token and user id live in the `servers` blob beside the
//! account record and never cross the command boundary: the UI only ever sees
//! the public `Server` shape.

use crate::{db, AppState};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
use tauri::State;

const KEY_BLOB: &str = "servers";
const TIMEOUT: Duration = Duration::from_secs(15);
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

fn normalize_url(raw: &str) -> Result<String, String> {
    let url = raw.trim().trim_end_matches('/');
    if url.is_empty() {
        return Err("Enter the server address, for example http://192.168.1.10:8096.".into());
    }
    let lower = url.to_ascii_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err("The server address must start with http:// or https://.".into());
    }
    Ok(url.to_string())
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

fn token_request(
    kind: &str,
    request: reqwest::RequestBuilder,
    token: &str,
) -> reqwest::RequestBuilder {
    let request = request.header("X-Emby-Token", token);
    if kind == "emby" {
        request.header("Authorization", format!("MediaBrowser Token=\"{token}\""))
    } else {
        request
    }
}

fn parse_auth(value: &Value) -> Option<(String, String)> {
    let token = value.get("AccessToken")?.as_str()?.trim();
    let user_id = value.pointer("/User/Id")?.as_str()?.trim();
    (!token.is_empty() && !user_id.is_empty())
        .then(|| (token.to_string(), user_id.to_string()))
}

/// Posters are fetched without a token, so only servers that allow anonymous
/// image access show artwork. Streams carry their own `api_key` instead.
fn item_image(base: &str, item_id: &str) -> String {
    format!("{base}/Items/{item_id}/Images/Primary?maxWidth=400")
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
                            .map(|year| year as i32),
                        series_id: text_field(item, "SeriesId"),
                        series_name: text_field(item, "SeriesName"),
                        season: item
                            .get("ParentIndexNumber")
                            .and_then(Value::as_i64)
                            .map(|number| number as i32),
                        episode: item
                            .get("IndexNumber")
                            .and_then(Value::as_i64)
                            .map(|number| number as i32),
                        id,
                    })
                })
                .collect()
        })
        .unwrap_or_default()
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

fn stream_url(base: &str, item_id: &str, source: Option<&str>, token: &str) -> String {
    let mut url = format!("{base}/Videos/{item_id}/stream?static=true");
    if let Some(source) = source {
        url.push_str("&MediaSourceId=");
        url.push_str(source);
    }
    url.push_str("&api_key=");
    url.push_str(token);
    url
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

fn load(state: &AppState) -> Result<Vec<Stored>, String> {
    let conn = state
        .db
        .0
        .lock()
        .map_err(|_| "The local database is locked.".to_string())?;
    let value = db::read_kv(&conn, KEY_BLOB).map_err(|error| error.to_string())?;
    drop(conn);
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    serde_json::from_value::<Vec<Stored>>(value)
        .map_err(|error| format!("The saved server list could not be read: {error}"))
}

fn store(state: &AppState, servers: &[Stored]) -> Result<(), String> {
    let conn = state
        .db
        .0
        .lock()
        .map_err(|_| "The local database is locked.".to_string())?;
    let value = serde_json::to_value(servers).map_err(|error| error.to_string())?;
    db::write_kv(&conn, KEY_BLOB, &value).map_err(|error| error.to_string())
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
    let reply = http
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
    let value: Value = reply
        .json()
        .await
        .map_err(|error| format!("{} sent an unreadable sign-in reply: {error}", label(kind)))?;
    let (token, user_id) = parse_auth(&value)
        .ok_or_else(|| sign_in_error(kind, "the reply carried no access token"))?;

    let name = server_name(&http, &url)
        .await
        .unwrap_or_else(|| host_label(&url));

    let mut servers = load(state.inner())?;
    servers.push(Stored {
        // Two adds inside one millisecond are impossible from the UI.
        id: format!("{kind}-{}", db::now()),
        kind: kind.to_string(),
        name,
        url,
        username,
        token,
        user_id,
    });
    store(state.inner(), &servers)?;
    Ok(public(&servers))
}

#[tauri::command]
pub async fn srv_remove(id: String, state: State<'_, AppState>) -> Result<Vec<Server>, String> {
    let mut servers = load(state.inner())?;
    servers.retain(|server| server.id != id);
    store(state.inner(), &servers)?;
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

    let parent_id = parent_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty());

    let url = if let Some(parent) = parent_id {
        // Children of a show are seasons, children of a season are episodes.
        format!(
            "{}/Users/{}/Items?ParentId={parent}&IncludeItemTypes=Season,Episode&Fields=ProductionYear,SeriesName&SortBy=SortName&Limit=200",
            server.url, server.user_id
        )
    } else {
        let types = match kind.as_deref().map(str::trim) {
            Some(value) if value.eq_ignore_ascii_case("movie") => "Movie",
            Some(value) if value.eq_ignore_ascii_case("series") => "Series",
            _ => "Movie,Series",
        };
        format!(
            "{}/Users/{}/Items?Recursive=true&IncludeItemTypes={types}&Fields=ProductionYear,SeriesName&SortBy=SortName&Limit=200",
            server.url, server.user_id
        )
    };
    let request = token_request(
        &server.kind,
        state.http.get(url).timeout(TIMEOUT),
        &server.token,
    );
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
    let value: Value = reply.json().await.map_err(|error| {
        format!(
            "{} sent an unreadable library reply: {error}",
            label(&server.kind)
        )
    })?;
    Ok(parse_items(&server.url, &value))
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
    let servers = load(state.inner())?;
    let server = servers
        .iter()
        .find(|server| server.id == id)
        .ok_or("That media server is no longer connected.")?;

    // Episodes and movies both resolve through PlaybackInfo; the reply names
    // the media source the static stream needs, or the item id when it does not.
    let info_url = format!(
        "{}/Items/{item_id}/PlaybackInfo?UserId={}",
        server.url, server.user_id
    );
    let request = token_request(
        &server.kind,
        state.http.post(info_url).timeout(TIMEOUT),
        &server.token,
    )
    .json(&serde_json::json!({ "UserId": server.user_id }));
    let source = match request.send().await {
        Ok(reply) if reply.status().is_success() => {
            reply.json::<Value>().await.ok().and_then(|value| media_source(&value))
        }
        _ => None,
    };
    Ok(stream_url(
        &server.url,
        item_id,
        source.as_deref(),
        &server.token,
    ))
}

async fn server_name(http: &reqwest::Client, base: &str) -> Option<String> {
    let reply = http
        .get(format!("{base}/System/Info/Public"))
        .timeout(TIMEOUT)
        .send()
        .await
        .ok()?;
    let value: Value = reply.json().await.ok()?;
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
        assert_eq!(host_label("https://media.example.com/jellyfin"), "media.example.com");
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
}
