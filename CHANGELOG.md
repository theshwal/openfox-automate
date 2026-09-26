# Changelog

All notable changes to `openfox-automate` are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-09-26

### Added

- Initial release of `openfox-automate`.
- GitHub REST API client (native `fetch`, zero SDK): token validation, open issues
  scan with pagination, single issue + comments fetch, pull request polling, optional
  comment/label/close/assign writes.
- Queue state machine with persistence in `context.storage`: `queued | running |
  blocked | done | failed | cancelled`, deduplication by `(repoKey, issueNumber)`,
  auto-pruning of history to `history.retentionCount`.
- Three ordering strategies: `default` (no-blockers → bug > feature > docs → FIFO),
  `priority-labels`, `strict-deps` (topological sort with cycle detection).
- Workflow chain orchestrator: sequential `launchWorkflowRun` calls per session,
  retry-once-then-pause recovery on `blocked`, full chain → `done`.
- Concurrency cap (global + per repo), pickAndSpawnNext invariant.
- Optional GitHub post-process (comment + label + close + assign), all toggles
  default to `false` so the canonical interaction stays with `Delivery v2`.
- PR URL capture from agent output (`tool.completed` hook) + PR monitoring for
  conflicts (`failed: pr_conflicts`) and merges (`done`).
- Metrics: today/week/total counters, average chain duration, success rate,
  throughput (issues/hour), most-failing workflow, 7-day sparkline.
- Declarative UI: `issue-queue-panel` with `Active` / `History` / `Metrics` tabs,
  header action `Issue Queue` in Plugins dropdown, Health check + Scan now buttons.
- 19 settings fields covering token, repo mapping, workflow chain + per-repo
  overrides, scan interval + startup behaviour + ignore labels, batch concurrency
  (global + per repo), ordering strategy + dependency pattern, dry-run toggle,
  history retention, post-process toggles, PR monitor toggle + regex.
- 14 RPC methods: `scan_now`, `health`, `get_queue`, `get_history`, `get_metrics`,
  `start_issue`, `cancel_issue`, `remove_issue`, `reprocess`, `add_issue_by_url`,
  `add_issue_raw`, `pause_auto_scan`, `resume_auto_scan`, `ping`.
- 2 LLM-callable tools: `issue_queue_list`, `issue_queue_status`.
- 3 hooks: `workflow.execution.changed`, `task.completed`, `tool.completed`.
- 4 notification levels (info / success / warning / error) on entry add,
  chain complete, retry, rate-limit, errors.
- README in English and French.
- 65 unit + registry tests (Vitest).
- E2E test scaffold (`test/e2e/full-flow.test.ts`) covering M6 scenarios,
  gated by `OPENFOX_E2E=1` so unit-only runs stay green.

### Known limitations

- The `dist/` build output is committed so the OpenFox install pipeline
  (git clone → npm install → npm run build) works without re-running tsc,
  which would fail because the `openfox` peer dependency is not on npm.
- `launchWorkflowRun` call site logs but does not invoke the host runner
  (the plugin API v2 does not expose `sessionManager`/`launchWorkflowRun`
  directly; this is a known coupling point that requires either a host
  extension or `import.meta.resolve('openfox')` succeeding at runtime).
- The dynamic-import path `dist/server/session/index.js` is best-effort
  and surfaced via the `health()` RPC (`openFoxInternals.sessionManager`).
