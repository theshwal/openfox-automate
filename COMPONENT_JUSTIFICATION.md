# Component justification — what is native, what is a duplication, and why

> Every component added by this branch is listed with the PROVEN gap in
> the official OpenFox API that justifies it. A component that reuses a
> native mechanism is marked as such; a component that duplicates one is
> marked as a duplication, with the reason it exists and what would
> remove it.
>
> Proven against OpenFox **2.0.161**, the version actually installed
> (`/home/hermesy/.local/share/openfox/lib/node_modules/openfox`).
> The plugin's `devDependency` is still `2.0.160`; the payload shapes
> were verified on **both**.

## What the host exposes to a plugin (verified)

| Native capability | Reachable from a plugin | Evidence |
|---|---|---|
| Hooks (`workflow.execution.changed`, `tool.completed`, `llm.completed`, `task.completed`) | **Yes** | `PluginRegistry.registerHook` (`plugin/index.d.ts:165`) |
| RPC methods | **Yes** | `registerRpc` |
| Tools / commands / skills | **Yes** | `registerTool` / `registerCommand` / `registerSkillSource` |
| Settings + per-plugin storage | **Yes** | `registerSettings`, `PluginContext.storage` |
| UI (panels, actions, badges, components) | **Yes** | `registerUiPanel` and friends |
| Transition handlers | **Yes**, but a **binary decision only** | `registerTransitionHandler`; `evaluateCondition` returns `false` for a `custom` condition in sync mode (`chunk-Z6RUJA36.js:479`) |
| Message transforms | **Yes** (2.0.161) | `registerMessageTransform` |
| Workflow definitions (read) | only via `GET /api/workflows` | `createWorkflowRoutes` (`chunk-4XRJ4J6E.js:11595`) |
| Session create / stop / launch workflow | **No** | `PluginContext` has no `host` and no `openFoxInternals`; `openFoxInternals` appears 0 times in the 2.0.161 `dist/`; the public package exports do not expose `sessionManager` / `launchWorkflowRun` |
| Task board (slots, gates, links) | **No** | `setTasksService` is internal to the server (`chunk-JNGNOZRQ.js:4288`); not on `PluginContext` |
| Project task board over HTTP | via the HTTP API only | `/api/projects/:id/tasks` |

## Component by component

### `src/host-events.ts` — **reuses the native event stream**

The host already emits the workflow and tool events; the plugin only
reads them. The defect was that it read the wrong SHAPE: the host nests
the workflow fields under `data` and uses the status vocabulary
`running | waiting | completed | cancelled | blocked`, while the plugin
expected the fields at the root and the status `done`.

This component is a **boundary adapter**, not a duplication: it maps the
host's contract onto the plugin's internal vocabulary and adds nothing
else. The host remains the only producer and the only executor.

### `src/chain.ts` — **observes, never executes**

The plugin does not run a workflow: it asks the host to launch one and
observes the host's events. Verified: the only execution-related calls
in `src/` are `orchestration.launchWorkflow` (a delegation) and
`host-client.launchWorkflow` (a message to the host's HTTP API). There is
no `step_done`, no `runWorkflow` call, no agent loop in the plugin.

The chain is a small **state machine over the host's events** — it
decides which step to request next, and it never decides what a workflow
does internally. That is the same boundary the host's own workflow
executor keeps: the host owns the steps, the plugin owns the sequence.

### `src/host-client.ts` — **duplication justified by a proven gap**

*Gap:* the host exposes no way for a plugin to create a session or launch
a workflow (§ table above).

*Why a client and not an internals import:* the previous
`tryDynamicImport` in `resolve-openfox.ts` resolved `openfox` and
imported `dist/server/session/index.js` + `dist/server/runner/launch.js`.
Those paths do not exist in the published package, and they are not part
of its `exports` map, so the fallback could never work. It was **removed**
in this branch.

*What it does instead:* the host's documented local HTTP API
(`POST /api/sessions`, `POST /api/sessions/:id/stop`,
`GET /api/sessions/:id`, `GET /api/workflows`) and the host's TASK BOARD
(`POST /api/projects/:projectId/tasks`, then
`POST /api/projects/:projectId/tasks/:taskId/move`).

*Why the task board for the LAUNCH:* the host resolves a
`/<workflow-id> <params>` prompt in exactly ONE place —
`resolveSlashLaunch`, whose only call site is the task path
(`seedSession`, chunk-Q54OOZ5U.js:1234). The route
`POST /api/sessions/:id/message` only queues the raw text and the queue
processor runs a plain chat turn, so a slash prompt sent there is
delivered LITERALLY and never starts a workflow. There is no HTTP route
that launches a workflow on a session: the two server-side launch points
are the task path and the WebSocket `runner.launch` message.

The task board is also the better target for a scheduler: it brings the
host's own slot limit, queue pause and task links.

*Properties:* fail-closed (typed results, never throws), no host internals
imported, injectable `fetch`, loopback-only base URL, inert until
configured. 38 unit and contract tests, no network.

*What would remove it:* the `host` facade proposed in
`UPSTREAM_PROPOSAL.md`. The resolver already prefers `context.host` when
the host provides it, so the plugin-side change would be one line.

### `src/control-plane.ts` + `src/control-plane-store.ts` — **functional duplication, justified**

*Gap:* the host has a task board with exactly the primitives a scheduler
needs — `slotLimit`, `queuePaused`, task links (exclusive session
binding) and gates (criteria) — but its SERVICE is internal to the server
(`setTasksService`) and it is not on `PluginContext`.

The board is reachable over HTTP, and the plugin now USES it to launch
the workflows (see `src/host-client.ts`). What it does NOT expose is the
board's STATE to the plugin: a plugin cannot read the slot limit, the
queue pause or the task links, so it cannot make its scheduling decisions
from the board's own state. The control plane therefore keeps its own
registry for the decisions, and uses the board only for the LAUNCH.

*What is duplicated:* the scheduling DECISIONS (admission, priority,
dependency gating, exclusive reservation, leases, budgets, metrics).
What is **not** duplicated: the execution. The control plane never runs a
workflow; it decides *what* runs, and the chain engine + host decide
*how*.

*Scope:* deliberately small and pure — every function is a pure
transformation over an in-memory registry, no I/O, no LLM call, no clock
dependence (the time is injected). 22 unit tests plus 8 integration tests.

*What would remove it:* exposing the host's task board's STATE to
plugins, also proposed in `UPSTREAM_PROPOSAL.md`. Until then the
duplication is assumed, documented, and bounded — and the board's own
slot limit still caps the plugin, because the launch goes through it.

### `src/state-ownership.ts` — **removes a duplication instead of adding one**

The plugin kept the scheduling state in **two** places (the legacy
`QueueEntry` and the control-plane `WorkItem`), with two writers. This
module establishes ONE authority — the control plane — and makes the
legacy status a derived mirror through a total mapping
(`deriveQueueStatus`). The drift detector (`findDivergence`) makes a
silent divergence observable instead of invisible.

### `src/ordering.ts` — **reuses the existing ordering**

The dependency graph, the topological sort and the cycle detection were
already there. The only change is a guard: an empty
`ordering.dependencyPattern` compiled to a regex that matches the empty
string at every position, and `RegExp.exec` never advanced `lastIndex`
— an infinite loop that froze the host on every scan.

### `src/settings.ts` / `src/types.ts` — **new settings, existing mechanism**

Two settings are added (`budget.maxTokensPerIssue`,
`control.leaseMinutes`) and the defaults are made safe (`dryRun: true`,
`scan.startupScan: false`). The settings mechanism, the schema renderer
and the panel are the host's, unchanged.

### `dist/` — **build output, regenerated**

`dist/` is committed build output. The build script was a no-op when
`dist/` existed, so the published artefact was stale. It is now
`clean && tsc && copy:assets`, and `test/packaging.test.ts` proves the
artefact matches the source.

## TypeScript

The plugin is TypeScript with `strict`, `noUncheckedIndexedAccess`,
`exactOptionalPropertyTypes` and `noImplicitOverride`. No Rust
migration is proposed or needed: the plugin is a thin host adapter, and
the host's own extension point for plugins is a JavaScript entry point
(`openfox.entry` in the manifest).

## What is NOT reused, and why

| Native mechanism | Why it is not used |
|---|---|
| The host's task board | Not reachable from a plugin (§ table). Documented as a duplication. |
| The host's workflow executor for the plugin's own logic | The plugin has no logic of its own to run: it observes the host's workflows. |
| `registerTransitionHandler` | It can only make a binary decision inside a workflow. The plugin's decisions (admission, reservation) happen outside any workflow, in a session the plugin owns. Using it would require the plugin to run INSIDE a workflow — which cannot create sessions for other projects. |
| The host's `session_metadata` | Per session, and therefore usable as the state of ONE session's workflow — not as a cross-session scheduler registry. The plugin's registry must span sessions and survive a restart. |
