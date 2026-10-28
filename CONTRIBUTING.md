# Contributing to BetterNuvio

Thanks for looking. BetterNuvio is a Windows desktop app: React 19 and TypeScript in the WebView,
Rust and Tauri in the backend, mpv for playback. This file covers the practical bits; the design
rules are in [AGENTS.md](AGENTS.md).

## Before you start

- Open an issue for anything larger than a small fix. It is cheaper to agree on the shape first.
- Bug reports need the app version, Windows version, what you did, what happened, and the relevant
  lines from `%APPDATA%\app.betternuvio.desktop\mpv.log` or `mpv-stderr.log` when playback is
  involved.
- BetterNuvio ships no media, catalogs, addons or scrapers. Do not add a bundled source, a
  hard-coded addon URL, or anything that ships copyrighted content.

## Setup

Requirements are Windows 10/11 x64, WebView2, Rust 1.85+ and Bun 1.2+.

```bash
bun install
bun run app        # desktop app; first run downloads mpv in the background
bun run dev        # Vite only, with the in-browser mock backend
```

Dev builds use the `app.betternuvio.desktop.dev` identifier, so they keep their own database and
player.

## Checks

Run the narrowest check that covers your change, then the full set before you open a pull request:

```bash
bun run check      # tsc --noEmit
bun run build      # tsc && vite build
bun run test       # player HUD regression checks
cargo test --manifest-path src-tauri/Cargo.toml
```

CI runs `check`, `build`, `test` and the Rust tests on `windows-latest`. Playback, debrid, Trakt,
sync and server paths are not covered by automated tests; say in the pull request what you tested
by hand.

## Code

- Follow the existing structure, naming and styling. Do not reformat files you are not changing.
- Keep changes focused. One fix or feature per pull request.
- Comments explain why, not what. One short line beats a paragraph.
- Do not add a dependency for something the standard library or an installed package already
  does.
- Keep the Rust core owning I/O and parsing; the UI should not grow network or stream parsing.
- New user-facing strings are English for now (there is no i18n layer yet).

## Commits

Use conventional commits: `fix(player): ...`, `feat(settings): ...`, `docs: ...`, `ci: ...`.
Keep the subject short and the body to what changed and why. Do not add attribution trailers.

## Pull requests

Fill in the template. Include:

- what changed and why;
- the checks you ran;
- anything you could not test, and why;
- screenshots or a short clip for UI changes.

A maintainer may ask for a smaller diff or a different approach. That is normal, not a rejection.

## Security

Do not open a public issue for a vulnerability. Use [SECURITY.md](SECURITY.md).

## Licence

By contributing you agree that your work is licensed under the repository's MIT licence.
