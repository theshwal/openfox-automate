# Upstream extension proposal — `PluginContext.host`

> Status: **proposal only**. Nothing was sent, no issue was filed, no
> upstream code was patched. This document states precisely what the
> plugin needs from the host, why it cannot be worked around cleanly, and
> what the change would look like if the maintainer accepts it.

## The gap, as proven against OpenFox 2.0.161

`PluginContext` (`dist/plugin/index.d.ts:138-147`) exposes:

```ts
interface PluginContext {
  readonly id: string
  readonly version: string
  readonly runtime: PluginRuntime
  readonly logger: PluginLogger
  readonly storage: PluginStorage
  settings(scope?: 'global' | 'project', projectId?: string): Record<string, PluginSettingValue>
  notify(request: PluginNotificationRequest): void
  publish(panelId: string | undefined, key: string, value: unknown): void
}
```

There is **no** `host` and **no** `openFoxInternals`:

- `PluginHost.createContext` (`chunk-4XRJ4J6E.js:7976`) returns exactly
  that object — no extra property is attached at runtime;
- `openFoxInternals` appears **zero** times in the whole 2.0.161 `dist/`;
- the package's public exports do not expose `sessionManager` nor
  `launchWorkflowRun` (`openfox` only exports `createServer` /
  `createServerHandle`).

The consequence for a plugin that must create a session and run a
workflow is severe:

| Need | Native API | Reachable from a plugin? |
|---|---|---|
| Create a session | `sessionManager.createSession` | **No** |
| Launch a workflow | `launchWorkflowRun` | **No** |
| Stop a session | `sessionManager.stopSession` | **No** |
| List workflows | `loadAllWorkflows` | only via `GET /api/workflows` |
| Session state | `sessionManager.getSession` | only via `GET /api/sessions/:id` |
| Host events | `EventStore` | **Yes** (`registerHook`) |
| Plugin storage | `PluginStorage` | **Yes** |
| Tool registry | `setPluginTools` | **Yes** (`registerTool`) |
| Workflow transitions | `registerTransitionHandler` | **Yes** (binary decision only) |

So the plugin has to reach the host over its **local HTTP API** to do
anything. That works, but it is not free:

- the base URL and the port are **not** exposed (`PluginRuntime` only
  carries `mode` and `configDirectory`), so the operator has to
  configure them;
- when the host's auth strategy is `network`, the session token is
  derived from the host's encrypted password — the plugin cannot obtain
  it, so it must be configured too;
- the plugin then depends on the host's HTTP surface, which is a
  documented but separate contract from the plugin API.

## Proposed change (small, additive, backwards compatible)

Add an OPTIONAL facade to `PluginContext`:

```ts
/** Minimal surface a plugin needs to drive the host. */
interface PluginHostFacade {
  sessions: {
    create(input: { projectId: string; title?: string }): Promise<{ sessionId: string; workdir?: string }>
    stop(sessionId: string): void
  }
  workflows: {
    launch(input: {
      sessionId: string
      workflowId: string
      params?: Record<string, string>
      content?: string
      subGroup?: string
    }): void
  }
}
```

and expose it on the context:

```ts
interface PluginContext {
  // …
  /** Host capabilities, when the host supports plugin orchestration. */
  readonly host?: PluginHostFacade
}
```

In `PluginHost.createContext`, it is one conditional:

```ts
return {
  id: pluginId,
  version: manifest.version,
  runtime: { mode: this.options.mode, configDirectory: this.options.configDirectory },
  // …
  ...this.orchestration ? { host: this.orchestration } : {},
}
```

### Why this is safe

- **Additive.** `host` is optional; a plugin that does not use it is
  unaffected. The plugin API version stays at 2.
- **No new capability is invented.** The facade exposes exactly what
  `sessionManager` and `launchWorkflowRun` already do inside the server.
- **It removes the HTTP dependency.** With it, the plugin needs neither
  the port, nor the token, nor the HTTP routes — and `src/host-client.ts`
  stays as a fallback for hosts that have not adopted it.
- **It makes the failure explicit.** Today the plugin discovers at
  runtime that it cannot create a session; with the facade, the absence
  of `host` is a capability check, not a runtime surprise.

### What the plugin would do with it

`src/resolve-openfox.ts` already prefers `context.host` and already
implements the facade contract:

```ts
if (internal.kind === 'facade') {
  const s = await internal.facade.sessions.create({ projectId, title })
  internal.facade.workflows.launch({ sessionId, workflowId, params, content })
}
```

So the change on the plugin side would be **one line**: the resolver
already returns the facade when the host provides it. The HTTP client
would remain for older hosts.

### Alternatives considered and rejected

| Alternative | Why rejected |
|---|---|
| Import the host's internals (`dist/server/session`, `dist/server/runner`) | Not part of the package's `exports`; the paths do not exist in the published build; couples the plugin to the server's module layout. This is exactly what the previous `tryDynamicImport` did — it was removed in this branch because it could never work. |
| Use the host's task board (`/api/projects/:id/tasks`) | It has the slots, gates and links a control plane needs, but its service is internal to the server (`setTasksService`) and it is not on `PluginContext`. Reaching it over HTTP would require a project-scoped token and would race the user's own task board. |
| Have the plugin drive the workflow through the message route only | Works, but requires the port/token and couples the plugin to the HTTP contract for every launch. |
| Keep the plugin's own control plane | Kept **for now**, because the host exposes no scheduling API to plugins. It is documented as a functional duplication of the host's task board, not a duplication of the runner. If the host later exposes its task board to plugins, the control plane should be replaced by it. |

## The second proposal — a scheduling surface

If the maintainer wants plugins to schedule work natively, the natural
extension is to expose the EXISTING task board:

```ts
interface PluginTaskBoard {
  list(projectId: string): PluginTask[]
  create(projectId: string, input: { prompt: string; title?: string }): PluginTask
  move(projectId: string, taskId: string, to: 'todo' | 'in_progress' | 'done'): void
  setGateValue(projectId: string, taskId: string, gateId: string, value: string): void
}
```

It already provides what the control plane re-implements: a slot limit
(`slotLimit`), a paused queue (`queuePaused`), task links (exclusive
session binding) and gates (criteria). Exposing it would let the plugin
delete `src/control-plane.ts` entirely — a real simplification, and the
reason the control plane is deliberately kept small and pure.

**Recommendation:** accept the first proposal (the `host` facade) — it
is small, additive and removes an HTTP dependency. Treat the second one
as a follow-up: it is the change that would let the plugin drop its own
scheduler.
