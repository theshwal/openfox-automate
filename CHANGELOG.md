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
- Workflow chain orchestrator: sequential workflow launches per session,
  retry-once-then-pause recovery on `blocked`, full chain → `done`.
- Concurrency cap (global + per repo), pickAndSpawnNext invariant.
- Optional GitHub post-process (comment + label + close + assign), all toggles
  default to `false` so the canonical interaction stays with `publish-pr-v1`.
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
- 14 RPC methods: `automate.scanNow`, `automate.health`, `automate.getQueue`, `automate.getHistory`, `automate.getMetrics`,
  `automate.startIssue`, `automate.cancelIssue`, `automate.removeIssue`, `automate.reprocess`, `automate.addIssueByUrl`,
  `automate.addIssueRaw`, `automate.pauseAutoScan`, `automate.resumeAutoScan`, `automate.ping`.
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
- The workflow launch is delegated to the host's task board
  (`POST /api/projects/:projectId/tasks` then `…/move {to: 'in_progress'}`),
  because the plugin API v2 does not expose `sessionManager`/`launchWorkflowRun`
  directly. The task must be closed (`…/move {to: 'done'}`) for the host to
  free its worker slot.

## [Unreleased]

### Added

- **Durable control plane** (`src/control-plane.ts`): admission, exclusive
  reservation, leases, dependency edges, per-issue token budgets, priority and
  metrics, persisted under a single storage key so its read-modify-write never
  races another key's write. It is the single authority for the scheduling
  state; the legacy queue mirrors it (`src/state-ownership.ts`).
- `automate.controlPlaneStatus` and `automate.controlPlaneSchedule` RPCs, and a
  `llm.completed` hook that attributes the host's token usage to the issue the
  session is working on.
- `automate.hostStatus` RPC: the host section (base URL, token, transport,
  in-process surface) computed **locally**, without touching the GitHub API.
- `host.baseUrl` and `host.sessionToken` settings. The host exposes neither its
  port nor its token to a plugin, so the URL is operator-supplied. Only a
  loopback origin is accepted, and the session token is only ever sent in the
  `x-session-token` header.
- `src/host-events.ts`: adapters for the host's real event shapes
  (`workflow.execution.changed` under `data.*`, `tool.completed` under
  `data.result.output`), with fail-closed handling of incomplete payloads.
- `src/host-client.ts`: a fail-closed client for the host's local HTTP API.
- `src/parameter-mapping.ts`: maps the plugin's values onto the parameters a
  workflow DECLARES, by name and in the declared order. It refuses the launch
  when the declaration cannot be read, rather than guessing.
- The Issue Queue panel shows the host it talks to and the number of
  divergences between the control plane and the queue.

### Changed

- **The launch speaks the host's protocol.** The `/<workflow-id> <args…>` prompt
  carries the positional arguments and nothing else: the host splits it on every
  whitespace and maps the tokens onto the declared parameters by position, and it
  drops the prompt when it launches the workflow. Only the parameters the
  workflows declare are sent (`issue_ref` and `repo` for `plan-issue-v3`,
  `workdir` for `build-verify-v3` and `publish-pr-v1` when it is known). The
  planner re-reads the issue itself, so the issue body and the comments are no
  longer transported.
- **The chain follows the session the host reports.** The host can only reuse a
  session that has no messages, so it seeds a new one for every step. The
  plugin persists the reported session — in the queue AND in the control plane,
  which is the authority — so the host's events are matched to the entry.
- **Every host task is closed.** The host only frees a worker slot when its task
  leaves `in_progress`, so the task of each step is closed when the next one
  starts, and the last one when the chain ends.
- Safe defaults: `dryRun` is `true` and `scan.startupScan` is `false`, so
  enabling the plugin creates no session, writes nothing on GitHub and launches
  no workflow. The worker ceiling is 5 on every path.
- The build is reproducible: `npm run build` is `clean && tsc && copy:assets`,
  and the committed `dist/` always matches the source.
- The panel polls the local `automate.hostStatus` instead of the full
  `automate.health`, which queries the GitHub API. The full check stays
  available for the operator's explicit click.

### Fixed

- A dependency removed from the queue no longer diverges the two views, and a
  RUNNING issue is never clobbered by a scan.
- `automate.startIssue` no longer revives a control-plane item that is
  `failed`, `cancelled`, `blocked` or `done`: the registry is the authority, and
  `automate.reprocess` is the supported way to run an issue again.
- The single-issue path applies the token budget, like the bulk path.
- A control-plane item the queue does not hold is ADDED instead of updated (the
  update threw `Queue entry not found`), and a dependency cycle is blocked in
  BOTH views instead of being dropped from the queue.
- An expired lease BLOCKS the issue (keeping its session id) instead of
  queueing it again, so no second session is created for it.
- The PR monitor performs the legacy transition first and only then updates the
  control plane, so the two views cannot diverge and no error escapes.
- An empty dependency pattern no longer compiles to a regex that matches the
  empty string, which made `exec` loop forever and froze the host on every scan.
- The panel no longer shows "not configured" when the host call failed.

### Known limitations

- The host does not expose its port or its session token to a plugin, so both
  must be configured (`host.baseUrl`, and `host.sessionToken` only when the
  host's authentication strategy is `network`).
- The plugin keeps its own control plane because a plugin cannot access the
  host's task board. It duplicates the host's scheduling DECISION, not its
  execution engine.
- The `dist/` build output is committed so the OpenFox install pipeline
  (git clone → npm install → npm run build) works without re-running tsc,
  which would fail because the `openfox` peer dependency is not on npm.
