# GitHermes

[![CI](https://github.com/CromeSDK-Plugins/githermes/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/CromeSDK-Plugins/githermes/actions/workflows/ci.yml)

GitHermes **0.6.2** — [CromeSDK-Plugins/githermes](https://github.com/CromeSDK-Plugins/githermes).

GitHub PRs & Issues as a right workspace pane in [Hermes Desktop](https://hermes-agent.nousresearch.com/docs/user-guide/desktop).

> **Community plugin.** GitHermes is an open-source, independent project. It is **not** an official Nous Research product and is not developed or maintained by the Hermes team. It works with Hermes Desktop through its public plugin API.

A single-file desktop plugin (`@hermes/plugin-sdk`) that shows your repository's open PRs and issues in a dockable pane — conversation, reviews, commits, checks, files, and in-pane merge — styled after GitHub and themed with Hermes `--ui-*` variables. No backend, no extra token: data comes from the connected `gh` CLI via `host.request('shell.exec')`.

| PR list | PR detail |
| --- | --- |
| ![PR list pane](docs/pr-list.png?v=3) | ![PR detail view](docs/pr-detail.png?v=3) |

| Conversation (inline review) | Commits |
| --- | --- |
| ![Inline review threads](docs/pr-conversation.png) | ![Commits tab](docs/pr-commits.png) |

| Issues |
| --- |
| ![Issue list](docs/issue-list.png) |

## Features

- **PR list** — state pills, `+N / −N`, relative timestamps, **CI** (`passing / pending / failing`) and **review** (`approved / changes / required`) chips, exact `#N` search (`#42` does not match `#142`)
- **Session chip + repo picker** — PR for the active session branch (same join as the core review pane); 32px pill with `https://github.com/{owner}.png` avatar
- **PR / Issue header** — kicker, grouped meta chips, title glued to `#`, **Merge** action on open PRs (`squash / merge / rebase`, optional delete-branch, `GH_PROMPT_DISABLED=1`)
- **Conversation** — `gh-timeline` rail, GFM subset (quotes, task lists, tables, `<details>`, strikethrough; raw HTML stripped), icon-only Quote → active composer, compact checks strip (`Blocked` / `Waiting` / `All passed`)
- **Inline review threads** — `file:line` chip (`original_line` fallback), collapsed diff hunk, replies grouped by `in_reply_to_id`
- **Jump to latest** — floating control on the Radix viewport only (nested code/table scrollers ignored); remeasures when the detail DOM mounts
- **Commits** — same rail; each row is a `<details>` with lazy-loaded body / `+−` / files; SHA + external link do not toggle
- **Files** — unified hunks per file, line numbers, theme diff colors, `A/D/M/R` badge; unboxed header, border on the diff body
- **Issues** — label chips in the label's own color, black/white text via W3C relative luminance
- **Session issue drafts** — use the command palette action **GitHub: Draft issue from this session** or **Draft issue** in the pane. Hermes proposes a structured draft; GitHermes resolves the repo from the session or explicit chat reference, masks secret-shaped values, and searches open issues before enabling a write. Existing issues show a body diff and are re-read immediately before an explicitly confirmed rewrite. Updates intentionally mask secrets throughout the complete existing issue body as well as in newly drafted content; non-secret existing text is preserved, and the diff previews the masked body that will be written. Create/update results are read back and the verified link is inserted into the session composer. Automatic suggestions are opt-in (**Auto suggestions: on/off**) and only react to explicit issue-intent phrasing.
- Issue-draft masking recursively redacts recognized private-key blocks, credential-shaped tokens and keys, JWTs, authorization values, URL credentials, sensitive URL parameters, and sensitive assignment/CLI values. It is pattern-based: ordinary text and unlabelled/unrecognized secrets are not guaranteed to be detected. A duplicate issue's title and body are masked before review; the final rewritten body is masked too, so the preview and submitted body use the same redacted content.
- **Goal usage metrics** — Issue/PR queue Goals and **Fix failing checks** show native Goal start, observed completion, duration, model, Reasoning/Fast and available cumulative session tokens. **Goal-Verbrauch** opens the persistent local history with profile/model filters, UTC day/week/month sums and CSV export. Settings → Plugins → GitHermes provides a dated, editable model price table; Hermes costs take precedence, estimates are labelled, and absent/unproven zero usage stays unavailable. Multi-item Goals are not split without attribution evidence. See [data sources, privacy and limitations](docs/goal-usage-metrics.md).
- **Theme** — field surfaces on `--ui-editor-surface-background` (matte/glass inherited from Desktop); cards on `--ui-bg-quaternary`; container queries at `<360` / `<300` / `<240`

## Requirements

- Hermes Desktop 0.21.7 or newer (audited SDK floor; see verification limits below)
- [`gh`](https://cli.github.com/) installed and authenticated (`gh auth status`)
- **Fix failing checks:** Python 3.8+ available as `python3` or `python` on the connected host, for secret-safe log collection.
- **Windows:** [Git for Windows](https://gitforwindows.org/) (Git Bash and its POSIX tools) when `shell.exec` itself runs under Windows `cmd.exe`, plus `gh` on the PATH inherited by that gateway. A Windows Desktop with a Linux gateway shell runs commands in that `sh` and does not look for Git Bash. WSL's `C:\Windows\System32\bash.exe` is not a substitute.

### Windows shell setup and recovery

The SDK/gateway contract is audited against **Hermes Desktop v0.21.7+9**,
commit `41cd7b649d0980`. Automated transport tests ran on Windows 11 through
real `cmd.exe` → Git Bash; this is **not** a live Desktop-tested minimum.
Linux/macOS Desktop loading and interactions remain unverified.

Git Bash discovery runs only after `shell.exec` expands `%OS%` the way `cmd.exe` does. A POSIX shell that leaves the probe token unexpanded is used directly. Otherwise GitHermes checks every `where git` result (including portable Git),
`%ProgramFiles%\Git\bin\bash.exe` / `usr\bin\bash.exe`,
`%ProgramFiles(x86)%\Git\bin\bash.exe`,
`%LOCALAPPDATA%\Programs\Git\bin\bash.exe` / `usr\bin\bash.exe`,
and `where bash`. Candidates must report a MINGW/MSYS environment; the Windows
System32/SysWOW64 WSL shims are never invoked. Discovery failures are not cached:
fix the installation and click **Retry** in the pane, without closing it.

For a custom/portable installation, add Git's `bin` directory to the PATH used
to **launch Hermes**. Check `where bash`, `gh --version` and `gh auth status`
in that terminal; run `gh auth login` if authentication is missing. Recovery
commands in the pane are copy-only, not automatic installers or login prompts.
If you changed the parent process's PATH, restart Hermes once to inherit it;
Retry cannot update an already running gateway's environment.

**Host boundary:** at the audited commit, `shell.exec` consumes only `command`
and uses Python `subprocess.run(..., shell=True)`: Windows `cmd.exe`, POSIX's
system shell. It exposes no `shell`, `executable` or direct-process/argv option.
The gateway does not use the terminal tool's Bash selector for this RPC, and
there is no audited per-RPC Bash-path setting to recommend. If another host
build rejects `shell.exec` *before executing the command*, GitHermes cannot
repair that launcher with a command wrapper; repair the host shell installation
or launch PATH and follow that build's host documentation, then Retry.
No undocumented RPC option or host configuration is assumed here.

The current large-output/comment transport still requires POSIX utilities,
`/tmp`, pipelines and quoting. Hex chunks protect against the gateway's
4,000-character stdout cap/redaction; base64 carries Windows command text
safely through cmd.exe. Removing these without a documented shell-neutral
transport would break large PRs/comments. Native cmd/PowerShell-only operation
without Git Bash is therefore **not supported** by this plugin.

### Repository access

The picker discovers all repositories accessible to the connected `gh` account:
owned repositories, collaborator repositories, and repositories available through
organization membership, including private repositories. It follows every page
of GitHub's `GET /user/repos` API; there is no 30-repository discovery limit.
Manual repository selection and the saved/session repository pins still work.

GitHermes reuses the existing `gh` login and does not store another token or grant
new GitHub permissions. For private repositories the credential must already have
repository access (`repo` for a classic OAuth/PAT credential, or the appropriate
repository selection and permissions for a fine-grained token). Organization
OAuth restrictions, SAML SSO authorization and administrator approval still apply;
this plugin cannot bypass them or expose repositories the account cannot access.

## Fix failing checks

Open **Fix failing checks** from a PR detail, repository list or combined list.
The action appears only for completed `FAILURE`, `TIMED_OUT`, `CANCELLED` or
`ACTION_REQUIRED` checks, or external `FAILURE`/`ERROR` statuses. Pending,
successful, neutral and skipped checks do not enable it. The dialog keeps the
existing issue/PR queue selection and shows failed-check links, the shared
profile/model/Reasoning/Fast controls, **Nur analysieren, nicht pushen**, and the
exact Goal preview. Forks force analysis-only mode.

The read-only collector follows all current-head check, status, Actions-job and
relevant Renovate-comment pages, rather than the timeline's five-page window.
Actions evidence must match the PR head and linked failed job; `gh run view
<run-id> --job <job-id> --log-failed` supplies failed-step logs. External evidence
includes check output title/summary/text or status description, plus relevant
Renovate artifact comments. Each excerpt contains error lines with two preceding
and three following lines, or an explicit unavailable-log notice. Excerpts are
UTF-8-safe, limited to 4,096 bytes each and 32,768 bytes total, shared fairly
between failed checks. Oversized metadata blocks the Goal instead of dropping
checks silently.

Raw CLI output stays in the collector's memory. Credential-shaped values,
authorization headers, signed URL parameters and multiline private keys are
masked before the plugin's remote transport files, local receipts, preview or
Goal serialization. This mandatory scrub does not depend on the gateway's
redaction switch: the gateway cannot inspect the hex carrier. It cannot identify
every arbitrary unlabelled secret; do not log credentials in CI. Untrusted text
is JSON data with Unicode separators escaped, never a native Goal contract field.

Fix runs use the existing native Session/Goal handoff state machine, fresh
profile catalogs and configuration readback. A repository/PR/head identity has
one receipt across repeated clicks and reloads. Changed settings cannot resume
that Session as a new configuration; a new head can start a new run. Ambiguous
creation or kickoff responses require checking the existing Session, not blind
replay. Issue, PR and Fix receipts remain separate and share the handoff lock.
The head and fork origin are refreshed immediately before creation and kickoff.

The Goal asks the model to reproduce and minimally repair the failure, keep all
checks/tests intact, run relevant checks, recheck the head before a normal push,
then wait for the new head's checks. Analysis-only, fork, stale-head and unclear
cause paths prohibit a push. A separately approved necessary rebase may use
`--force-with-lease`; the Fix Goal never authorizes a merge. These future model
actions are Goal constraints, not a deterministic Git executor.

The pane distinguishes confirmed handoff, native Session `working`/`waiting`
facts and current-head GitHub checks. It never labels a kickoff as a completed
repair or push. A new head's push attribution is unknown; only a nonempty,
fully successful check set is shown as successful. Missing, pending, neutral
or skipped checks are not all green. **Fix-Session öffnen** remains available
for the actual analysis, tool approvals and model result.

Verification exercises the shipped public handoff and collector boundaries,
registered native Session/config/Goal/progress handlers in an isolated home,
and production PR list/detail/combined components in Mullvad Light/Dark at
wide/narrow viewports. Browser host/profile/theme data and kickoff acknowledgments
are synthetic. Historical read-only Actions logs separately verify the real CLI;
they are not current-head freshness proof. No productive model turn, push or
live GitHub mutation is claimed by these local checks.

## Cross-repository issue queue and persistent Goal

Select open issues in **any individual or combined Issues list**. One shared
queue preserves selection order across repositories, owners, scopes and filters.
Identity is case-insensitive `owner/repo#number`, so equal issue numbers from
different repositories remain distinct. The queue displays repository, title,
labels and current GitHub assignees. Reorder with Up/Down buttons or drag handlers,
and remove items individually. Existing version-1 repository drafts migrate
without deleting their original storage; malformed data is not executable.

While any issue is selected, issue-detail navigation is blocked for row, title,
chevron and keyboard activation. **Auswahl aufheben** explicitly exits selection
mode; checkboxes, removal and ordering remain available. The selection is saved
locally before the UI publishes a change, so a storage failure keeps the prior
saved selection. The draft is restored after reload.

Choose a **Profil** (the current/default profile also works without a named bot),
inspect **Goal-Prompt vor Erstellung ansehen**, then click **Goal erstellen**.
That explicit action creates a separate profiled session, sets its title, and
calls the real native `command.dispatch` `/goal -- <objective>` contract. Native
Goals persist in the owning profile's `SessionDB.state_meta`. GitHermes verifies
`/goal show` against the native normalized objective, then submits the returned
`type: "send"` kickoff message through the audited session prompt API
(`prompt.submit`, not an invented `session.submit` RPC). An `exec`-only creation
response does not start model work. The new session opens in a tab and remains
reachable through **Neue Session öffnen**.

“Assigned to a profile” means GitHermes's existing internal BotAssignment mapping
for every selected issue, linked to this session. It **does not** add a GitHub
assignee named after the local profile, or perform a GitHub assignment mutation.
The mapping is saved only after Goal verification and an accepted kickoff.

### Queue execution settings (Issue and PR Goals)

Both queues share **Ausführung**, **Ablauf** and **Merge** groups, collapsed
section help and a separate prompt preview. A single state element reports the
Goal handoff; the existing Session link appears only after creation. The short
risk notice stays visible. Controls wrap at narrow widths and use Hermes UI tokens.

**Modell**, **Reasoning** and **Fast-Modus** default to **Profil-Standard**:
GitHermes sends no override for an inherited field. Models and capability flags
come from the selected profile's native `model.options` response, never a plugin
model catalog. Profile changes reset all three picks; model changes reset
Reasoning/Fast. Missing or stale models block creation rather than selecting a
replacement. Old Issue/PR drafts inherit the missing fields without losing items
or options, and unchanged default plans retain their existing receipt fingerprints.

Hermes `41cd7b649d0980c57620035af736f91be10dae79` accepts per-Session
`model`/`provider`, `reasoning_effort` and `fast` in `session.create`.
`fast: false` explicitly pins normal service; omission inherits the profile.
GitHermes revalidates explicit picks against a fresh profile catalog before
creation, verifies the returned model/provider and reads the actual Session
Reasoning/Fast pins with `config.get` before Goal dispatch and again before kickoff.
A mismatch prevents model work, retains the receipt and retries the same Session.
The native Lazy-Resume response can report the profile model rather than the pin;
if that response cannot confirm the selected route, retry stops safely.
No profile-global settings are written.

The audited `model.options` contract returns Reasoning/Fast booleans but explicitly
omits supported effort arrays. The Reasoning picker therefore uses the audited
native `codex_supported_efforts` vocabulary only for confirmed OpenAI-Codex routes;
it offers no clamped `ultra` step. Other or unknown vocabularies remain disabled
with an explanation, as do unsupported Fast/Reasoning capabilities. Their defaults
continue to inherit the profile. This is a capability limitation, not a claim that
other providers lack reasoning.

Local verification uses the registered native Session/config handlers in an
isolated home without model turns, plus mounted production Queue editors and
actual SDK primitives in Mullvad Light/Dark at wide/narrow iframe viewports.
The browser RPC/profile/theme data are synthetic; this does not establish native
Desktop docking, productive queue execution or GitHub review/merge behavior.

The live preview and submitted Goal use the same option-dependent plan. The
numbered prompt requests issue/comments review, code analysis, implementation,
real checks, and a separate PR with a `Closes owner/repo#N` reference per issue.

- **Repository-Ausführung** defaults to sequential global selection order.
  Parallel mode groups independent repository workers in first-seen repo order,
  preserving issue order within each repo. Workers must check cross-repo
  prerequisites and use separately verified checkouts or isolated worktrees.
- **Refinement erlaubt** defaults to off: no issue-body writes; ask about unclear
  requirements. Opt-in permits only acceptance-criteria/subtask clarification in
  the issue body, without expanding scope or weakening gates. Preserve other
  content, re-read before editing and verify the exact body after writing.
- **Block on issue** defaults to on: an unresolvable obstacle, unclear criteria
  or genuinely outstanding required review/permission pauses the entire Goal.
  Off pauses the affected repo queue; only independent repos in parallel mode
  may continue. Later issues in the blocked repo and sequential global order
  cannot bypass the blocker. Obtain independent reviews and wait for checks;
  ask the user only for a concrete blocker that cannot be resolved autonomously.
- **Bei Fehlern** remains separate: Stop is the queue's pause-on-error contract,
  including reparable unexpected errors; stop before further edits/retests,
  preserve evidence and limit diagnosis to reads. An intentionally failing
  reproduction regression is not an unexpected error. Without a current
  pause-on-error contract, diagnose reparable test/build/tool/CI failures,
  repair within scope and retest first. Skip permits only transparent skipping
  of non-blocking errors, never bypassing required checks or reviews. Explicit
  current pause-on-error instructions take precedence.
- **Auto-merge defaults to off**; explicit opt-in is advance personal merge
  permission for the selected queue, recorded once rather than requested again
  per PR. Only the coordinating parent may merge, not delegated workers. Other
  queues and tag/release publication are not authorized. Independent required
  reviews, current-head and current-base integration checks, branch protection,
  native security gates and all other profile rules remain required. Merge
  consent resets after reload; saved DRAFT preferences do not renew it.

Any new user-facing blocker request must identify the repository/issue/PR,
applicable rule, head/base, log or API evidence, attempted remedy and exact
missing decision. After consent, generic “approval missing” is insufficient:
show a new scope/security decision, revoked consent or an actually unmet
required review/protection rule. Unknown native gates remain blocked.

Older drafts keep their items and existing options and receive the safe new
defaults, with no accidental refinement permission. Explicit new preferences
persist across reloads. Metadata is untrusted JSON data, with line separators
escaped so titles cannot inject native completion-contract fields.
A known matching cwd is supplied only for a single-repository queue; cross-repo
work must locate and verify each checkout and remote inside the user's allowlist.

The native Goal is persistent; **the issue sequence and repo workers are
model-directed**, not an atomic native issue executor or a guarantee of parallel
scheduling or CI/merge ordering. Inspect actual
work in the new session and use native `/goal status`, `/goal pause`, `/goal resume`
or `/goal clear` there. Clearing selection does not cancel an existing Goal.
There is no fabricated per-issue running/merged progress in this panel.

A shared in-flight guard and durable submission receipt prevent duplicate starts
from repeated clicks. Known-session retries resume the same stored session;
a lost Goal reply is reconciled with show/resume rather than blindly replacing
it. Assignment-storage retries do not resend the kickoff. Unknown create or
kickoff outcomes (for example a transport timeout) require checking the existing
session instead of risking a duplicate. Hermes's create idempotency key is also
supplied, but its gateway-memory lifetime is not a durable restart guarantee.

Contracts were audited at Hermes `41cd7b649d0980c57620035af736f91be10dae79`
(and Goal sources at `2ddbd66ac6e511bbfe9acf696f67412c57685f63`). An isolated
probe executes the exact upstream command handler and GoalManager with real
SessionDB, verifies profile-owned state and restores it in a fresh process.
Mullvad light/dark production-component flows use synthetic host RPCs; no active
profile Goals, model calls or GitHub mutations are used by verification. Native
Desktop loading and user-run model work remain separate acceptance boundaries.
See the official [Persistent Goals documentation](https://hermes-agent.nousresearch.com/docs/user-guide/features/goals/).
The existing Windows Git Bash transport is retained.

## Cross-repository PR queue

Select open PRs in individual or combined lists. The PR queue has its own
`globalPrQueue` storage; issue drafts and issue Goal receipts are preserved.
Selection order survives scope/filter changes and reloads. Up/Down buttons,
checkboxes, removal and clear-selection are keyboard accessible. PR detail
navigation is locked while PR selection is nonempty.

Choose a profile (current profile by default), merge strategy (squash), conflict
policy (ignore), error policy (stop), and review result (comment-only). **Reviewen**
creates a native profiled Session/Goal and submits its returned kickoff. Opt-in
review decisions request approve/request changes; own PRs receive comments only.

**Reviewte mergen · Vorschau** performs read-only, uncapped paginated reads of
PR state, effective branch rules/protection, reviews and exact-head check runs
and statuses. The preview lists merge candidates, reasoned skips, conditional
conflict fixes and unknown blockers. Confirming it creates a separate merge
Goal; preview alone never starts model work or mutates GitHub. Extra protection
rules that the preview cannot prove satisfied block confirmation conservatively.
Missing/unknown permissions, protection or check data are never approval.

The merge Goal requests fresh eligibility before each mutation, exact-head
`--match-head-commit`, the selected strategy and `--delete-branch`, without admin
or auto-merge bypass. It must refresh every remaining PR after a merge. Ignore
mode leaves conflicts untouched. Rebase-and-fix mode is same-repo only, with an
explicit old-head force-with-lease, local checks, new-head Required Checks and
fresh valid review; unresolved conflicts stop without pushing. Fork conflicts
are skipped with a reason. The confirmed merge action supplies personal merge
permission only for the selected PRs; do not ask again per PR. Independent
reviews, branch protection, native security gates and all other profile rules
remain required. Only the coordinating parent may merge. The same evidence-backed
blocker and repair-before-skip contract applies within the selected action and
conflict policy; Stop still pauses before repair/retest. Review does not grant
merge or code/branch-change permission.

The PR start shares the issue submission state machine but uses separate
`prQueueGoalSubmission`, PR assignment identities and completed-action receipts.
Repeated clicks, reload retries and switching back to an already started action
do not blindly create another Session/Goal/kickoff. Ambiguous outcomes require
inspection of the existing Session. Clearing selection does not cancel a Goal.

Sequencing, reviews, rebase and merge are **model-directed contracts**, not a
new deterministic executor. Accepted pre-merge verification for this PR-queue
implementation consists of local regressions, mounted component/handler
checks, isolated native Goal persistence and required current-head CI.
Productive GitHub review/rebase/merge and native Desktop/model tests are
supplementary runtime validation, not additional pre-merge gates; they remain
unverified until actually exercised. Mutating test fixtures still need an
explicitly authorized disposable target. Required checks, branch protection,
review gates and the accepted Windows Git-for-Windows Bash transport are unchanged.

## Combined user / organization view

The repository picker starts with **Alle meine Repos**, followed by **Alle in
<Owner>** for your authenticated user and every discovered member organization.
The selected scope is saved in plugin storage and survives reloads; a combined
scope is not replaced when the active session changes repositories. Individual
repository entries, manual selection and drag ordering remain available.

“Mine” means repositories owned by your user or a member organization, **not**
repositories owned by another user who added you as a collaborator. The
single-repository picker still discovers all user/collaborator/organization
repositories. Archived repositories are excluded. Forks are excluded by default;
**Include forks** enables them in the combined view.

PRs and Issues each get an owner-spanning, updated-newest-first list. Every row
has an owner avatar and `owner/repo` chip, alongside the existing labels, times,
CI/review decisions, branch and diff/file counts. Opening a row preserves its
repository identity through Conversation, Commits, Checks, Files and the existing
merge controls; Back returns to the combined scope and filters.

Use Owner, Repo, open/closed/merged state (merged is PR-only), Assigned to me,
Authored by me and Review requested (PR-only). Combined **Closed** PRs exclude
merged PRs. Free text searches the GitHub index across the scope, not just loaded
rows; author/label chips generate safe scoped tokens. Arbitrary GitHub query
operators are not accepted as raw scope overrides; free-text words are quoted,
and quotes/backslashes in search text are rejected with a hint. Search input is
debounced. A bare `#42` requires a Repo filter. Use `owner/repo#42`, or `repo#42`
with an Owner selected, for an unambiguous direct lookup beyond Search's window.
All references are checked against the selected user/organization scope.

Implementation uses **one batched GraphQL request for up to eight owners**, with
separate aliased Search connections for each owner and CI/review metadata in the
same response. This is a true union, independent of mixed `user:X org:Y` or
advanced `OR` parser semantics. Larger memberships use additional owner batches;
there is never a request loop over every repository. Each owner starts with 50
results and its own cursor. **Mehr laden** appends unfinished owner pages,
deduplicates by `owner/repo#number` and re-sorts loaded rows. The displayed count
is **loaded rows**, not a claim of complete global inventory. Results are cached
for 60 seconds without automatic search polling; **Refresh combined list** resets
the window and retries discovery. Requests are serialized at least 2.2 seconds
apart, below 30/minute; other tools sharing the credential can still exhaust its
quota. Rate-limit/network failures are visible and retain previously loaded rows.

GitHub Search exposes at most **1,000 results per owner/query**, even with cursors.
The UI warns when the total exceeds that limit and asks you to narrow Owner,
Repo, status or text; it never silently labels that window “all”. CI uses GitHub's
complete rollup state; label/check metadata caps are disclosed when reached.
Fork exclusion is applied to returned `repository.isFork`, because `fork:false`
is not a valid issue-search filter and can yield zero results.

Organization discovery follows all `GET /user/orgs` pages. A classic OAuth scope
missing `read:org` is reported separately from SSO/OAuth organization restrictions.
For fine-grained/App credentials, missing OAuth scope headers mean **unknown**,
not “no organization access”. Organization-specific GraphQL authorization errors
produce a partial-list hint, while remaining owners still load. GitHub can also
silently hide private results; the UI explicitly tells you to check token scopes,
repository selection, SSO authorization and administrator approval if an owner
looks incomplete. Authentication, network and rate errors are not disguised as
empty success. No permission is granted automatically.

Verification: `node --test` covers query/scope safety, exact lookups, merging,
pagination, partial authorization, limit warnings and real Windows/capped JSON
transport. A full production-pane React/React Query harness in Mullvad exercises
public synthetic fixtures in light/dark; it is not native Desktop, real SSO or
an actual merge acceptance test. Those live/platform gates remain as listed below.

## Install

```bash
hermes plugins install CromeSDK-Plugins/githermes --enable
```

Or manually: drop this folder into `~/.hermes/plugins/githermes/` (unified package — the desktop half lives at `desktop/plugin.js`), or copy `desktop/plugin.js` to `~/.hermes/desktop-plugins/githermes/plugin.js` (standalone disk door). The app hot-reloads on save.

### Upgrading from `github-prs`

The plugin **id** changed (`github-prs` → `githermes`), so the old install must be removed first — delete the old folder (`~/.hermes/desktop-plugins/github-prs/` or `~/.hermes/plugins/github-prs/`), then install fresh. One-time cost: the saved repository in the picker resets (plugin storage is namespaced by id).

## Development notes

- Disk plugins load **uncompiled**: UI is written with `jsx()`/`jsxs()` calls, no JSX syntax, no build step.
- Only `@hermes/plugin-sdk`, `react`, and `react/jsx-runtime` are importable.
- No relative imports: the whole runtime lives in the single file `desktop/plugin.js` (enforced by `test/runtime_imports.test.js`).
- Tailwind classes must already exist in the app's compiled CSS — arbitrary `var()` bracket forms (`bg-[var(--x)]`) are silently dead at runtime. Use the paren shorthand (`text-(--ui-text-tertiary)`) or scoped `<style>` blocks with real theme variables.
- Large `gh` payloads go through `shBig` / `shJsonBig` (lowercase **hex**, not base64, in 3,800-character chunks under the 4,000-character gateway stdout cap). Single-repo lists start at 30 rows and grow on demand up to 120; combined lists use 50-row owner cursors and explicit Search-limit warnings, not that 120-row cap. Repository discovery is paginated without a list cap. Large GraphQL request bodies are chunked into a temporary file and passed on stdin (`gh api graphql --input -`) so Windows command/path limits do not truncate queries.

### Hermes 0.21.7 compatibility audit

The audit targets **v0.21.7+9**, upstream commit
[`41cd7b649d0980c57620035af736f91be10dae79`](https://github.com/NousResearch/hermes-agent/commit/41cd7b649d0980c57620035af736f91be10dae79).
The authoritative [Desktop SDK guide](https://hermes-agent.nousresearch.com/docs/developer-guide/desktop-plugin-sdk)
and the source at that commit were checked, not a local Hermes source checkout.

| Boundary | Finding |
| --- | --- |
| Release history | Official tags/releases expose v0.21.6 and v0.21.7, but no exact v0.21.1–v0.21.5 tags/releases. Both patch notes defer full curated notes to v0.22.0; missing notes are not evidence of no changes. v0.21.6 mentions isolated backend plugins and unified settings; v0.21.7 mentions new additive SDK actions/pet APIs. |
| Desktop loader/imports | `contrib/runtime-loader.ts` and `sdk/runtime.ts` still rewrite SDK/React imports to live ESM shims. Every GitHermes named SDK import exists at the audited commit. Unified `plugins/<id>/desktop/plugin.js` and standalone `desktop-plugins/<id>/plugin.js` remain supported; unified packages inventory disabled until enabled. No production import migration was indicated. |
| Manifest | `hermes_cli/plugins_manifest.py` retains v1 support; v2 is additive, not required here. `manifest_version: 1` stays. `requires_hermes: >=0.21.7` is the conservative **audited contract floor**, not proof that earlier versions fail or that a live Desktop minimum was exercised. |
| Pane/workspace | `host.openWorkspace(id, {dock, minWidth, render, title, onClose})` returns a close disposer. IDs remain `plugin-workspace:<id>`; visibility/reveal/undismiss and `ctx.onDispose` still match the existing pane lifecycle. `TITLEBAR_AREAS` is an object with `titleBar.left/center/right`, not a string; the old Node adapter allowed undefined registration areas in tests. |
| Storage | `ctx.storage.get(key, fallback)` is synchronous JSON persistence under `hermes.plugin.<id>.`; `set`/`remove` remain available. Repository, order and assignment keys remain unchanged. The existing pane-open localStorage key is preserved. |
| Shell/output | `tui_gateway/methods_tools.py` still returns `{stdout, stderr, code}`, redacts output and keeps the last 4,000 stdout characters. Hex chunking remains necessary; base64 is only used to carry Windows command text into Git Bash. Windows discovery now checks standard/portable Git Bash paths, keeps rejected host RPCs intact and retries uncached failures; see Windows shell setup above. |
| Theme/CSS | All referenced `--ui-*` tokens exist in upstream `styles.css`/theme presets, including editor-surface and diff colors. The existing scoped CSS stays unchanged. Source token presence does **not** prove a disk plugin's utility classes are included in the shipped CSS or visually correct in light/dark matte/glass. |

### Automated checks

GitHub Actions runs `npm test` and `node --check desktop/plugin.js` on every
pull request, every push to `main`, and manual CI dispatch. The matrix covers
Ubuntu, Windows and macOS with Node 22 and 24; newer runs cancel older runs for
the same ref. Run those same commands locally before opening a PR. `npm test`
includes the `pretest` bootstrap, so no dependency installation is needed.
Platform-specific tests execute on their matching OS and are skipped elsewhere;
these adapter and transport tests are not live Hermes Desktop acceptance.

The matrix follows the [Hermes v0.21.7 Desktop manifest](https://github.com/NousResearch/hermes-agent/blob/v0.21.7/apps/desktop/package.json),
which supports Node `^22.22.0 || ^24.11.0 || >=26.0.0` for host tooling and pins
Electron 40.10.2 ([embedded Node 24.15.0](https://releases.electronjs.org/release/v40.10.2)).
Node 24 covers that embedded Node major; Node 22 retains the supported older
host-tooling line. The plugin itself loads in Electron's Chromium renderer with
SDK/React shims, not as a standalone Node application. This matrix tests its
Node adapters and real shell transports, not the Electron renderer.
There are no npm dependencies or lockfile. If dependencies are added, commit a
`package-lock.json` and change CI installation to `npm ci` with npm caching.

### Tests and verification limits

Run `npm test` on a fresh clone: `pretest` creates repository-local, gitignored
SDK/React adapters. They model the correct bar slots, observable atoms, lazy
React state and required host state; an unconfigured RPC fails instead of
silently returning success. They are **not** Hermes Desktop or a React renderer.
The Windows baseline also exposed a CRLF-sensitive source assertion; the test
now accepts both LF and CRLF without weakening its row-action checks.

Deterministic registration/storage/pane and capped-output transport tests do
not establish live host installation or console cleanliness. Remaining live
acceptance: CLI and manual installation into an isolated Desktop data root,
open/dock/picker/list/detail interactions, an authorized disposable PR merge,
and light/dark × matte/glass on actual Desktop. Linux/macOS live execution is
also not claimed. No user plugin/profile, GitHub issue, or PR is changed by the
test suite.

## Status & contributing

Early stage — expect bugs; reports and PRs are very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT

---

🇧🇷 **PT-BR:** pane de PRs e Issues no Hermes Desktop. Lista com CI/review, busca `#N` exata, header preenchido, merge no pane, timeline com threads inline (`file:line` + diff), jump-to-latest no viewport, commits em `<details>` lazy, diffs por hunk, labels com contraste W3C. Sem backend — só `gh` via `shell.exec`.
