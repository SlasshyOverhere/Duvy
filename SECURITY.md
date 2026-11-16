# Security policy

## Supported versions

Only the latest release receives fixes. There are no long-term support branches.

## Reporting a vulnerability

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose
**Report a vulnerability**. Do not open a public issue, and do not include exploit details in a
pull request.

If private reporting is unavailable to you, contact the maintainer on GitHub (`@SlasshyOverhere`)
and ask for a private channel. Keep that first message free of exploit details.

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
- the update path.

Out of scope:

- vulnerabilities in mpv, WebView2, Windows, or a third-party addon or service;
- anything that requires the user to install a malicious addon or run untrusted code they chose
  to run;
- missing hardening headers with no demonstrated impact.

## What the app already does

- Credentials live in Windows Credential Manager through the OS keyring; the database stores only
  a marker, and rows from older builds are migrated on first read.
- The WebView runs under a Content Security Policy.
- Addon URLs are validated and response bodies are bounded.
- Playback needs no local server: libmpv decodes in-process, and a stream comes from a configured
  backend or a local file.
- Update bundles are signature-verified before install.
- Usage counts are anonymous and limited to launches and playback shape: media type, seconds
  watched, finished or not, library and addon counts, the host name of each backend request (never
  its path or query, so a debrid token or stream link cannot ride along), app version and a random
  install id. No title, account, link or content id. On by default in release builds, with the
  switch in Settings, Privacy, and nothing sent from a build without a PostHog key. Crash reports
  are opt-in, off by default, capped per
  session and scrubbed of links, credentials, magnets and account names. Only a release build with
  a configured Sentry DSN can send one; local builds and switched-off installs send nothing.
