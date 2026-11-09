# Releasing

Releases are built and published by CI only (`.github/workflows/release.yml`). Run the workflow
from the Actions tab with the version, the preferred path because it builds on `main` and seeds
the shared build cache:

```bash
gh workflow run release.yml -f version=1.0.0
```

Pushing a `v*` tag also works as a fallback. A tag run can read the cache saved by a dispatch but
cannot save one.

The workflow writes the version into `package.json`, `src-tauri/Cargo.toml` and
`tauri.conf.json`, so they cannot disagree, then builds the MSI and NSIS installers, signs the
updater bundles, publishes the GitHub release and uploads `latest.json` (the manifest the in-app
updater reads). The installers carry `libmpv-2.dll` beside the executable, so playback works
offline.

## One-time setup

The workflow signs with a minisign key that has to match `plugins.updater.pubkey` in
`src-tauri/tauri.conf.json`. Add the private key as a repository secret:

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/duvy.key
```

`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` is only needed if the key has a password. Keep the key safe:
lose it and every install already in the wild can no longer verify updates.

Crash reporting is compiled in only when a Sentry DSN is configured. A DSN is a public write-only
ingest URL, so it lives in a repository variable, not a secret:

```bash
gh variable set VITE_SENTRY_DSN --body "https://<key>@<host>/<project>"
```

Leave it unset and the released build ships with reporting off; the consent prompt is never
shown.

## Local builds

The installer takes `src-tauri/libmpv/libmpv-2.dll` and places it next to the executable. Run
`scripts/fetch-libmpv.ps1` before a local build; the file is not committed.

A local `bun run tauri build` still works for smoke tests, but it needs the same key
(`TAURI_SIGNING_PRIVATE_KEY_PATH`) and its artifacts are never published.
