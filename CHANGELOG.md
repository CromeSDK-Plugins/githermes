# Changelog

All notable changes to GitHermes are documented in this file. Format based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Fixed
- Issue and PR queue Goals no longer embed a machine-specific checkout path or allowlist; Hermes chooses checkout/worktree locations, while matching single-repository session cwd and repository/remote verification remain intact (#49).
- Queue prompt changes update Goal fingerprints, so previously run selections are eligible to start again.

### Added
- Repo guard tests: `test/repo_guard.test.js` fails if `desktop/plugin.js` contains foreign repository identifiers (`claudiumio`, `claudioorjunior`, `Crome696/`); `sdk_compatibility` requires every `compare` target in `desktop/plugin.js` to use `PLUGIN_REPO` and every literal `repos/<owner>/<repo>/compare` and `https://github.com/<owner>/…` in `desktop/plugin.js` to use the owner `CromeSDK-Plugins` (owner guard, 3adbc50), and asserts the new homepage/repository/bugs URLs and that no manifest contains `Crome696/githermes` (#32, 253655f, Refs #30).

### Removed
- **BREAKING:** Removed the generic `settings.plugins` contribution fallback for the Goal metrics settings page. GitHermes now registers it only via `ctx.registerSettingsPage(...)`; on Hermes Desktop hosts without that API the **GitHermes** settings page no longer appears (the **GitHub: Goal-Verbrauch** palette entry and pane remain available) (#29, c65aaea, Refs #28).

### Fixed
- Goal metrics token counters and the numeric observation check share one field table, so the raw usage aliases cannot drift from `TOKEN_KEYS` (#34).
- A Hermes host without `ctx.registerSettingsPage` logs one warning instead of skipping the GitHermes settings page silently. The rest of the plugin still loads (#34).
- The Windows shell runner creates its temp script with `mktemp` (`${TMPDIR:-/tmp}/gt.XXXXXX`, mode 600) and removes it with an `unlink` trap on EXIT, INT, and TERM, instead of a predictable PID path (#31).
- Windows Desktop with a Linux `shell.exec` backend no longer fails with "Git for Windows Bash not found". The gateway shell is identified with `%OS%` expansion; a POSIX shell runs the command directly (#41).
- `metricsOwner` is captured before the `save` callback is declared or called, so the original gateway/profile is kept if focus changes during session creation (#29, c65aaea, Refs #28).
- Empty or all-null usage snapshots no longer erase known token counters or cost (#29, c65aaea, Refs #28).
- The price-table textarea draft resyncs when the prices store changes externally (#29, c65aaea, Refs #28).

### Security
- Comment upload, chunked reads, the failing-check collector and aggregate GraphQL no longer use predictable `Date.now`/`Math.random` paths under `/tmp`. Each call creates a private directory with `mktemp -d` (`${TMPDIR:-/tmp}/<prefix>.XXXXXX`, mode 700) and removes it in a `finally` block by unlinking the known files and then `rmdir` (#33).
- The plugin update check and update source (`PLUGIN_REPO` in `desktop/plugin.js`) now point to `CromeSDK-Plugins/githermes` instead of the upstream repository `claudiumio/githermes` (#32, 253655f, Refs #30).
- Metadata correction: `plugin.yaml` `homepage` and `package.json` `homepage`/`repository` now point to `CromeSDK-Plugins/githermes` instead of `Crome696/githermes`, and `package.json` gains `bugs.url` (#32, 253655f, Refs #30).

## [0.7.0] - 2026-10-18

### Changed
- Replace conflicting Stop/Skip and blocker instructions with autonomous recovery for ordinary patch, tool, build and test failures. Only genuine decisions, access failures or unresolved obstacles require user input.
- Remove the error selector and clarify the remaining workflow controls. Older draft selections and permissions migrate without rewriting active Goals.
- Shorten Issue and PR queue prompts while preserving action scope, native security boundaries, required reviews/checks, exact-head merges and mutation readback.

## [0.6.6] - 2026-10-18

### Fixed
- Detect the executing backend shell per gateway/profile and keep multi-call transfers on their original gateway across Desktop focus changes.
- Send JSON bodies through stdin so native Windows gh works with disabled MSYS path conversion and long Unicode bodies.
- Remove invalid `gh api --slurp --jq` combinations, preserve complete check responses and paginated review decisions, and keep pending Renovate requests intact.
- Bind merge requests to the reviewed head and confirm the merged state before reporting success.
- Preserve accepted or ambiguous issue creation across pane reloads and provide read-only verification without duplicate POSTs.
- Persist bot-assignment handoffs, queue ownership and exact active Goal verification; route session links and metrics to their owning backend.
- Keep completed older Fix history without blocking a new head after a prompt upgrade.
- Replace unavailable plugin-tool instructions with backend-specific tool discovery, exact-head review API instructions, JSON-encoded untrusted data and explicit CI billing handling.
- Run Windows shell tests from a normal PowerShell PATH without accidentally selecting WSL Bash.

[Unreleased]: https://github.com/CromeSDK-Plugins/githermes/compare/v0.5.0...HEAD
