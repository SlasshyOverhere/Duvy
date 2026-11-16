//! Keep credentials out of logs and error text: a URL reduces to scheme and host.

use url::Url;

/// `https://user:pass@host/path?token=x` becomes `https://host`.
pub fn origin(raw: &str) -> Option<String> {
    let parsed = Url::parse(raw).ok()?;
    Some(format!("{}://{}", parsed.scheme(), parsed.host_str()?))
}

/// Same, for a value that is expected to be a URL.
pub fn url(raw: &str) -> String {
    origin(raw).unwrap_or_else(|| "an unparsed URL".to_string())
}

/// Rewrites every URL in free text: server bodies and client errors echo them.
pub fn text(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut rest = input;
    while let Some(index) = find_url(rest) {
        let (before, tail) = rest.split_at(index);
        out.push_str(before);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | ')' | ']' | '>' | ','))
            .unwrap_or(tail.len());
        out.push_str(&url(&tail[..end]));
        rest = &tail[end..];
    }
    out.push_str(rest);
    out
}

fn find_url(text: &str) -> Option<usize> {
    [text.find("http://"), text.find("https://")]
        .into_iter()
        .flatten()
        .min()
}

#[cfg(test)]
mod tests {
    #[test]
    fn userinfo_and_tokens_reduce_to_scheme_and_host() {
        assert_eq!(
            super::url("https://user:pass@example.com/token/abc?key=1"),
            "https://example.com"
        );
        assert_eq!(
            super::url("http://example.com:8080/abc"),
            "http://example.com"
        );
        assert_eq!(super::url("not a url"), "an unparsed URL");
    }

    #[test]
    fn text_rewrites_every_url_it_finds() {
        let raw = "cannot install https://h/p?token=1 or https://user:pass@i/j";
        assert_eq!(
            super::text(raw),
            "cannot install https://h or https://i"
        );
    }
}
