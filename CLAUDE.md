# Project Conventions

## Release / Versioning

- **Default bump on every GitHub push**: when pushing to GitHub without an explicitly specified version, bump the patch number (`0.1.0` → `0.1.1` → `0.1.2` …). Update all three places in sync:
  1. `@version` in `CPA-codex-helper.user.js` header
  2. `CHANGELOG.md` — move relevant entries from `[Unreleased]` into a new `[X.Y.Z] - YYYY-MM-DD` section
  3. `README.md` feature descriptions (if user-facing behavior changed)
- **Explicit version override**: if the user names a specific version (e.g. "release 0.2.0", "bump minor"), use that instead of the default patch bump.
- Today's date for the new CHANGELOG section uses the local timezone (`Asia/Shanghai`).

## Style

- Userscript metadata block (`// @version`, `// @match`, …) must keep its `// ` line-prefix — that's metadata syntax, not a regular comment.
- Commit messages follow the repo's existing style: semantic prefix (`fix:`, `docs:`, `feat:`) + 中文/英文混合 description. See `git log` for examples.
- Tampermonkey `@downloadURL` / `@updateURL` point at the `main` branch raw URL — no per-version tags required for auto-update to work.
