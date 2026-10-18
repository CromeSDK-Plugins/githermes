# Goal usage metrics

Settings contribution compatibility: the supported Desktop SDK path is `ctx.registerSettingsPage(...)` (audited in Hermes `apps/desktop/src/contrib/plugin.ts:118–121,362` and `contrib/settings-pages.ts:31–33,46–59`). `settings.plugins` is the area identifier consumed by that dedicated API, not a generic contribution fallback; GitHermes now feature-detects `registerSettingsPage` and does not register a generic contribution when it is absent. A missing method logs one console warning and does not stop the rest of the plugin from loading. (#12, #34)

Open **Goal-Verbrauch** in the pane/page or **GitHub: Goal-Verbrauch** in the command palette. Issue queues, PR review/merge queues and individual **Fix failing checks** Goals share the recorder and show their metrics beside the handoff status. The overview survives clearing a queue or restarting Desktop. It filters by profile/model and exports the filtered Goal rows as CSV.

## Data contract and investigation

GitHermes uses `host.request` / the captured `host.getGateway()` instance, not a spawned `hermes chat` process. `startQueueGoal` creates a dedicated session, calls `command.dispatch` (`/goal -- <objective>`, `/goal show`, optionally `/goal resume`), then `prompt.submit`.

Audited Hermes source: `NousResearch/hermes-agent` commit `41cd7b649d0980c57620035af736f91be10dae79` (GitHermes's existing Desktop v0.21.7+9 SDK audit floor).

- `tui_gateway/server.py::_get_usage` reads session-cumulative `session_*` counters. RPC `session.usage` (`tui_gateway/methods_session.py`) returns them. `session.usage` events wrap them in `payload.usage`; `message.complete` carries the final cumulative `usage` for a turn, **not** that message's delta. The recorder replaces snapshots; it never adds them. It listens on the captured owning gateway, matches explicit runtime IDs, and rejects replayed/out-of-order events. A 10-second read-only poll supplements events and reconnect/reload recovery.
- `input`, `output`, `reasoning`, `prompt`, `completion`, `total` are produced at the audit floor. Absolute cache counters are maintained internally but `_get_usage` only exposes a cache-hit percentage there. Optional schema fields are not proof of populated values. The adapter also accepts positive `cache_read`/`cache_write` and canonical `*_tokens` fields if the backend actually supplies them. Reasoning is a subset, not an extra billable bucket.
- Missing usage and normalized zero cannot be distinguished from unreported buckets. These remain `null` internally and **nicht verfügbar** in the UI. No tokens are inferred from text, context occupancy, cache-hit percentages or output length. Even a positive input count does not turn a normalized output/cache zero into reported data.
- Hermes already has cost accounting: `agent/usage_pricing.py::estimate_usage_cost` prefers provider costs and otherwise uses route/model prices; `agent/turn_usage.py` persists token/cost deltas. `gateway/platforms/api_server.py::_session_response` exposes stored `estimated_cost_usd` and `actual_cost_usd` through `GET /api/sessions/{stored_id}`. The audited Desktop `_get_usage` does **not** populate `cost_usd`/`cost_status`. GitHermes does not assume it does or bypass the SDK to acquire credentials. When its usage payload actually contains a usable Hermes cost, that takes precedence over the local table. A zero cost requires explicit `actual`/`included` status; unknown/normalized zero is not a free run.
- `hermes_cli/goals.py::GoalManager.set` persists `created_at`. `tui_gateway/methods_session_control.py::_safe_goal_snapshot` exposes it via `session.control.read` and `session.control.update`. `last_turn_at` is projected as `updated_at`, but is set **before** gates/judging and is not a completion timestamp. `GoalState` has no separate completed/ended timestamp. The recorder starts at `goal.created_at` and ends on the first **observed** `status: done`; the end is labelled **beobachtet**. `message.complete` occurs before the Goal judge and is not Goal completion. Queue receipt `stage: complete` is only a confirmed handoff.

The newer Hermes commit `60f56a6b13c8eb9a9e088c6fc1165257c92f7e11` additionally has `gateway/session_usage.py` and `session.stats`, including absolute cache counters. The implementation does not require that newer API or add snapshots from the two shapes.

## Costs and time semantics

**Settings → Plugins → GitHermes** contains the editable JSON price table. Every row has a model, optional provider, visible `YYYY-MM-DD` price date, and USD-per-million rates for `input`, `output`, `cacheRead`, `cacheWrite`. Empty provider is a model-wide fallback; exact provider wins. `null` means no price, explicitly entered `0` is a real zero rate. No prices are shipped or guessed. Example structure (replace the model/date and fill independently verified rates):

```json
{
  "version": 1,
  "rows": [
    { "provider": "", "model": "MODEL_ID", "date": "2026-10-15", "input": null, "output": null, "cacheRead": null, "cacheWrite": null }
  ]
}
```

- Table-derived values are labelled **geschätzt**, with their price date. Missing models/rates show **kein Preis hinterlegt**, not zero. Missing input/output yields **nicht verfügbar**. If input/output are known but cache buckets are unavailable, the UI explicitly labels the priced known buckets as a **Teilsumme: Cache-Tokens nicht verfügbar**. It does not call that the full Goal cost. Aggregates count these partial estimates separately.
- Changing the price table recalculates historical table estimates with the displayed new date; reported Hermes costs are retained and are not repriced. A detected model switch disables a single-model table estimate for that session's mixed counters.
- Duration is wall-clock time, including pauses and waits. The endpoint is either now or the observed done time. An offline completion can be observed late; it is never presented as an exact native completion timestamp. Loss of the owning session leaves the last captured numeric snapshot visible with a read-availability warning. Metrics never resume/create sessions or submit prompts to obtain accounting.
- A one-item Goal is attributable to that item and labelled accordingly. For multi-item Goals there is no trustworthy item boundary in these APIs; the UI reports **nur Goal-Summe**, without equal splitting or transcript analysis.
- Day/week/month sums use UTC creation dates, Monday-start weeks, and the selected profile/model filters. They include running Goals; missing values and cache partials have explicit counts. Unknown totals are not rendered as zero. CSV contains raw numeric fields, blank unknowns, cost source/status/price date, and an explicitly observed end column. Formula-like text is escaped for spreadsheets.

## Persistence and scope

`goalUsageMetricsV1` and `goalUsagePricesV1` live in the same plugin-local storage as the queue. A closed serialization allowlist retains only numeric metrics and metadata: connection, owning gateway/profile, stored/runtime IDs, item repository/number, Goal kind/handoff/status, model/provider/reasoning/Fast, timestamps and costs. No prompts, replies, contracts, issue titles, raw payloads, logs or error text are copied into metrics storage or CSV. Existing queue handoff receipts are unchanged; their existing content retention is not broadened by accounting.

Connection plus profile plus stored ID identifies a record. A cross-profile `session.create` can belong to the creating gateway, so its owning gateway profile is recorded separately from the Goal's execution profile. Reload polls that explicit route. Old SDK fallback only reads a captured or positively matching gateway; it never follows the currently focused unrelated chat. Disabling/reloading the plugin removes listeners, timers and socket leases.

Pre-existing receipts have no reliable owning-connection provenance and are not retroactively converted into fabricated historical usage. Tracking begins with handoffs made by this version. Persisted metrics from this version restore independently from the current queue selection.

## Verification

`npm test` includes cost, cumulative replacement/reset, unknown-zero provenance, aggregation/calendar/filter, metadata-only persistence, CSV, native Issue/PR handoff, owning-route, event ordering, observed completion, unavailable RPC and lifecycle tests. No provider/model call is needed.

The optional `scripts/check-goal-metrics-ui.mjs` runs the real production overview/settings components with React in an isolated headless browser context. Gateway replies are explicit test fixtures, not measured provider usage. It checks price editing, filters, UTC period selection, unavailable zero counts, partial-cost labels, observed completion, CSV download, content exclusion and reload persistence. Install `playwright`, `react`, `react-dom`, `esbuild` in a separate runner directory; set `GITHERMES_UI_RUNNER` to it and `TMPDIR` to Hermes scratch, then run `node scripts/check-goal-metrics-ui.mjs`. Browser preference is Edge, Chrome, runner Chromium. This does not claim a productive Hermes Desktop/model run.
