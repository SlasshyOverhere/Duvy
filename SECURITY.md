# Security policy

## Supported versions

Only the latest release receives fixes. There are no long-term support branches.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, and do not include exploit details in a
pull request.

Include:

- the app version and Windows version;
- what the issue is and what an attacker could do with it;
- steps to reproduce, or a proof of concept;
- any logs, screenshots or sample files that help.

You can expect an acknowledgement within a few days and a best-effort fix. This is a
single-maintainer project, so no response-time guarantee is offered.

## Scope

In scope:

- the Rust backend and Tauri command surface;
- the React UI and its handling of untrusted addon, metadata and subtitle data;
- credential storage and the local database;
- the update and first-run player download paths;
- the loopback torrent stream server.

Out of scope:

- vulnerabilities in mpv, WebView2, Windows, or a third-party addon or service;
- anything that requires the user to install a malicious addon or run untrusted code they chose
  to run;
- reports that only demonstrate that P2P playback exposes the user's IP address; that is
  documented behaviour and why P2P is opt-in;
- missing hardening headers with no demonstrated impact.

## What the app already does

- Credentials are encrypted with Windows DPAPI for the current user before they are stored.
- The WebView runs under a Content Security Policy.
- Addon URLs are validated and response bodies are bounded.
- The torrent HTTP endpoint binds to `127.0.0.1` on a random port.
- Update bundles are signature-verified before install.
- The first-run player download is checked against a published sha256 manifest.
- There is no telemetry, analytics or crash reporting.
