# CLAUDE.md

Instructions for every agent working in BetterNuvio.

## Repo facts

- Tauri 2 desktop app: React 19 + TypeScript + Vite frontend, Rust backend in `src-tauri/`.
- No test framework configured. The only checks are `bun run check` (`tsc --noEmit`) and `bun run build` (`tsc && vite build`).
- Run `bun run app` for the desktop app, `bun run dev` for the web frontend only.
- Never add a dependency without a reason; prefer what is already installed.
- Do not edit `dist/`, `node_modules/`, `bun.lock`, or generated Tauri output.

## Agent workflow

These rules apply to every agent and every task in this repository.

### Coordination

- Parallel agents must have disjoint file, module, or feature ownership. Do not edit outside the assigned scope.
- Before editing, inspect git status and the assignment. Never reset, rebase, stash, clean, checkout, or switch branches.
- Never revert, overwrite, or reformat another agent's work. If a dependency crosses ownership boundaries, stop and report it.
- Shared manifests, lockfiles, generated files, and module roots are coordinator-owned unless explicitly assigned.
- Verify the narrowest relevant tests and required checks before reporting completion. Report the commit hash, files, tests, and blockers.

### Code comments

- Comment only where the code genuinely cannot explain itself.
- Keep comments few, short, and direct. Use TLDR style: one line, straight to the point.
- Do not write long prose, restate what the code already says, or add per-function banners.
- Never write a comment that merely narrates the next line.

### Commits

- Commit each fix or feature immediately after it is done. One issue or feature gets one commit.
- Use conventional commits: `fix(scope): short description` or `feat(scope): short description`.
- Keep commit subjects and bodies short and concise. Do not add long explanations.
- Never add `Co-Authored-By`, `Generated with`, or any other attribution or trailer.
- Commit locally only. Never push. Pushing is off-limits unless the user explicitly asks for it.
