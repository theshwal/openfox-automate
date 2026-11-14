/**
 * Contract tests for the OpenFox host event adapters.
 *
 * These tests pin the REAL shape of the payloads emitted by the OpenFox
 * host (verified against `node_modules/openfox@2.0.160`):
 *
 *  - `workflow.execution.changed` — the host's HookBus builds
 *      `{ event, timestamp, ...payload }` where the payload comes from
 *      `handleStoredEvent`, i.e. `{ sessionId, projectId?, data: <event.data> }`.
 *    The workflow fields therefore live under `data`:
 *      `data = { executionId, workflowId, workflowName, status,
 *                 currentStepId?, currentStepName?, pendingChoices? }`
 *    `status` uses the host vocabulary
 *      `'running' | 'waiting' | 'completed' | 'cancelled' | 'blocked'`
 *    (NOT `'done'`).
 *
 *  - `tool.completed` — the host maps the `tool.result` event, whose data is
 *      `{ messageId, toolCallId, result }` where `result` is a ToolResult
 *      (`{ success, output?, error?, ... }`).
 *    The textual output therefore lives under `data.result.output`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

interface FakeCalls {
  rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
}

function makeFakeRegistry(): {
  registry: PluginRegistry
  calls: FakeCalls
  backing: Map<string, unknown>
} {
  const calls: FakeCalls = { rpc: [], hook: [] }
  const backing = new Map<string, unknown>()
  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: {
      // The real host stores plugin values as JSON strings and parses them
      // back on read (`setSetting(..., JSON.stringify(value))`). Reproducing
      // that round-trip matters: it removes object aliasing between the
      // stored snapshot and the arrays handed out by `loadActive()`, so the
      // tests exercise the same semantics as production.
      get: vi.fn(async (k: string) => {
        const raw = backing.get(k)
        if (raw === undefined) return undefined
        return JSON.parse(raw as string) as unknown
      }),
      set: vi.fn(async (k: string, v: unknown) => {
        backing.set(k, JSON.stringify(v))
      }),
    },
    settings: vi.fn(() => ({})),
    notify: vi.fn(),
    publish: vi.fn(),
  } as unknown as PluginContext

  const registry = {
    context,
    registerTool: vi.fn(),
    registerCommand: vi.fn(),
    registerSkillSource: vi.fn(),
    registerSettings: vi.fn(),
    registerUiAction: vi.fn(),
    registerUiBadge: vi.fn(),
    registerUiPanel: vi.fn(),
    registerHook: (h: string, fn: (p: unknown) => Promise<void>) => calls.hook.push({ h, fn }),
    registerTransitionHandler: vi.fn(),
    registerRpc: (name: string, fn: (p: unknown, c: unknown) => Promise<unknown>) =>
      calls.rpc.push({ name, fn }),
    registerAsset: vi.fn(),
    registerAuth: vi.fn(),
    registerTransport: vi.fn(),
    registerPreset: vi.fn(),
    registerModelMetadataProvider: vi.fn(),
  } as unknown as PluginRegistry

  return { registry, calls, backing }
}

function hookFn(calls: FakeCalls, event: string): (p: unknown) => Promise<void> {
  const found = calls.hook.find((h) => h.h === event)
  if (!found) throw new Error(`hook not registered: ${event}`)
  return found.fn
}

/**
 * Payload exactly as the OpenFox host emits it for
 * `workflow.execution.changed`.
 */
function hostWorkflowEvent(
  sessionId: string,
  data: {
    executionId: string
    workflowId: string
    status: string
    workflowName?: string
    currentStepId?: string
    pendingChoices?: unknown[]
  },
): Record<string, unknown> {
  return {
    event: 'workflow.execution.changed',
    timestamp: new Date().toISOString(),
    sessionId,
    data: {
      executionId: data.executionId,
      workflowId: data.workflowId,
      workflowName: data.workflowName ?? data.workflowId,
      status: data.status,
      ...(data.currentStepId !== undefined ? { currentStepId: data.currentStepId } : {}),
      ...(data.pendingChoices !== undefined ? { pendingChoices: data.pendingChoices } : {}),
    },
  }
}

/**
 * Payload exactly as the OpenFox host emits it for `tool.completed`
 * (mapped from the `tool.result` event).
 */
function hostToolEvent(
  sessionId: string,
  output: string,
  opts: { toolName?: string; success?: boolean } = {},
): Record<string, unknown> {
  return {
    event: 'tool.completed',
    timestamp: new Date().toISOString(),
    sessionId,
    data: {
      messageId: 'msg-1',
      toolCallId: 'call-1',
      result: {
        success: opts.success ?? true,
        output,
        durationMs: 12,
        truncated: false,
      },
      ...(opts.toolName ? { toolName: opts.toolName } : {}),
    },
  }
}

function seedRunningEntry(backing: Map<string, unknown>, overrides: Partial<QueueEntry> = {}): QueueEntry {
  const entry: QueueEntry = {
    id: 'qe-host-1',
    repoKey: 'o/r',
    projectId: 'p1',
    issueNumber: 7,
    title: 'Host contract issue',
    body: '',
    url: 'https://github.com/o/r/issues/7',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'running',
    position: 1,
    sessionId: 'sess-host-1',
    addedAt: '2026-01-01T00:00:00.000Z',
    startedAt: '2026-01-01T00:00:01.000Z',
    executionStack: [
      {
        workflowId: 'plan-issue-v3',
        workflowName: 'plan-issue-v3',
        status: 'running',
        retryCount: 0,
        startedAt: '2026-01-01T00:00:02.000Z',
      },
      {
        workflowId: 'build-verify-v3',
        workflowName: 'build-verify-v3',
        status: 'pending',
        retryCount: 0,
      },
      {
        workflowId: 'publish-pr-v1',
        workflowName: 'publish-pr-v1',
        status: 'pending',
        retryCount: 0,
      },
    ],
    ...overrides,
  }
  backing.set('queue', JSON.stringify([entry]))
  backing.set('history', JSON.stringify([]))
  return entry
}

const SETTINGS = {
  'repos.mapping': 'o/r=p1',
  'workflows.chain': 'plan-issue-v3\nbuild-verify-v3\npublish-pr-v1',
  'scan.startupScan': false,
  'pr.urlRegex': 'https://github\\.com/[^/]+/[^/]+/pull/(\\d+)',
}

/**
 * Register the plugin with a seeded queue and wait for the async startup
 * bookkeeping (orderAndStore) to settle, so the tests observe a stable
 * queue state.
 */
async function setup(overrides: Partial<QueueEntry> = {}): Promise<{
  calls: FakeCalls
  backing: Map<string, unknown>
}> {
  const { registry, calls, backing } = makeFakeRegistry()
  registry.context.settings = vi.fn(() => SETTINGS) as unknown as PluginContext['settings']
  stubHostWorkflows()
  seedRunningEntry(backing, overrides)
  register(registry)
  await new Promise((resolve) => setTimeout(resolve, 0))
  return { calls, backing }
}

function queueOf(backing: Map<string, unknown>): QueueEntry[] {
  const raw = backing.get('queue')
  return raw ? (JSON.parse(raw as string) as QueueEntry[]) : []
}

function historyOf(backing: Map<string, unknown>): QueueEntry[] {
  const raw = backing.get('history')
  return raw ? (JSON.parse(raw as string) as QueueEntry[]) : []
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

/**
 * The fake host.
 *
 * The plugin reads the workflows' DECLARED parameters before it launches
 * anything, and it REFUSES the launch when that read fails (the host
 * would otherwise map the arguments by position onto the WRONG
 * parameters). The stub therefore serves the real declarations.
 */
function stubHostWorkflows(): void {
  const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input)
    if (url.endsWith('/api/workflows')) {
      return new Response(
        JSON.stringify({
          defaults: [],
          userItems: [
            {
              id: 'plan-issue-v3',
              parameters: [
                { id: 'issue_ref', position: 0, required: true },
                { id: 'repo', position: 1, required: false },
              ],
            },
            { id: 'build-verify-v3', parameters: [{ id: 'workdir', position: 0, required: false }] },
            { id: 'publish-pr-v1', parameters: [{ id: 'workdir', position: 0, required: false }] },
          ],
          projectItems: [],
        }),
        { status: 200 },
      )
    }
    if (url.endsWith('/tasks')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    if (url.includes('/move')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' }, sessionId: 'sess-host-1' }), {
        status: 200,
      })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchImpl as unknown as typeof fetch)
}

describe('AC2 — workflow.execution.changed host payload contract', () => {
  it('reads the workflow fields from data.* (host shape) — status "completed" advances the chain', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )

    const stored = queueOf(backing)
    // The first step is done and the second one is now running.
    expect(stored[0]?.executionStack?.[0]?.status).toBe('done')
    expect(stored[0]?.executionStack?.[1]?.status).toBe('running')
    // The entry itself is not terminal yet: the chain still has 2 steps left.
    expect(stored[0]?.status).toBe('running')
  })

  it('PERSISTS the mutated execution stack across the chain advance (regression)', async () => {
    // The host storage is a JSON round-trip, so the in-place mutation made
    // by `processWorkflowEvent` is lost unless it is written back. The chain
    // advance branch used to skip that write-back: the next step stayed
    // 'pending' in the store and the chain stalled after the first workflow.
    // This test reads the STORE (not an in-memory object) to prove the
    // mutation is durable.
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )

    const stored = queueOf(backing)
    expect(stored[0]?.executionStack?.[1]?.status).toBe('running')
    expect(stored[0]?.executionStack?.[1]?.startedAt).toBeTruthy()
  })

  it('completes the whole chain and moves the entry to done after the last "completed"', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')

    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-2',
        workflowId: 'build-verify-v3',
        status: 'completed',
      }),
    )
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-3',
        workflowId: 'publish-pr-v1',
        status: 'completed',
      }),
    )

    expect(queueOf(backing)).toHaveLength(0)
    const history = historyOf(backing)
    expect(history).toHaveLength(1)
    expect(history[0]?.status).toBe('done')
  })

  it('maps host status "cancelled" to an explicit blocked step + blocked entry (never done)', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-cancel',
        workflowId: 'plan-issue-v3',
        status: 'cancelled',
      }),
    )

    const entry = queueOf(backing)[0] ?? historyOf(backing)[0]
    expect(entry).toBeDefined()
    // Cancelled is explicit and non-successful: the step is blocked…
    expect(entry?.executionStack?.[0]?.status).toBe('blocked')
    // …and the entry is blocked too, never "done".
    expect(entry?.status).toBe('blocked')
    expect(entry?.status).not.toBe('done')
    expect(entry?.error).toBeTruthy()
  })

  it('ignores an incomplete payload (no executionId) without launching anything', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: '',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )

    const stored = queueOf(backing)
    // Nothing advanced: step 0 is still running.
    expect(stored[0]?.executionStack?.[0]?.status).toBe('running')
    expect(stored[0]?.executionStack?.[1]?.status).toBe('pending')
  })

  it('ignores a payload for an unknown session without touching the queue', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    await fn(
      hostWorkflowEvent('sess-unknown', {
        executionId: 'exec-x',
        workflowId: 'plan-issue-v3',
        status: 'completed',
      }),
    )

    const stored = queueOf(backing)
    expect(stored[0]?.executionStack?.[0]?.status).toBe('running')
    expect(stored[0]?.executionStack?.[1]?.status).toBe('pending')
  })
})

describe('AC3 — a completed host event advances the chain exactly once', () => {
  it('does NOT launch a second workflow when the same completed event is replayed', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    const event = hostWorkflowEvent('sess-host-1', {
      executionId: 'exec-1',
      workflowId: 'plan-issue-v3',
      status: 'completed',
    })

    await fn(event)
    const afterFirst = queueOf(backing)
    expect(afterFirst[0]?.executionStack?.[1]?.status).toBe('running')

    // Replay the very same event (same executionId + status).
    await fn(event)
    const afterReplay = queueOf(backing)
    // The chain must NOT have advanced a second time: step 3 is still pending
    // (a second advance would have started it).
    expect(afterReplay[0]?.executionStack?.[1]?.status).toBe('running')
    expect(afterReplay[0]?.executionStack?.[2]?.status).toBe('pending')
    expect(afterReplay[0]?.status).toBe('running')
  })

  it('treats an event for a workflow outside the chain as non pertinent (no advance)', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'workflow.execution.changed')
    await fn(
      hostWorkflowEvent('sess-host-1', {
        executionId: 'exec-other',
        workflowId: 'some-unrelated-workflow',
        status: 'completed',
      }),
    )

    const stored = queueOf(backing)
    expect(stored[0]?.executionStack?.[0]?.status).toBe('running')
    expect(stored[0]?.executionStack?.[1]?.status).toBe('pending')
  })
})

describe('AC4 — tool.completed host payload contract (PR URL capture)', () => {
  it('captures a GitHub PR URL from data.result.output', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'tool.completed')
    await fn(
      hostToolEvent('sess-host-1', 'Opened https://github.com/o/r/pull/42 — please review', {
        toolName: 'run_command',
      }),
    )

    expect(queueOf(backing)[0]?.prUrl).toBe('https://github.com/o/r/pull/42')
  })

  it('does NOT invent a PR URL when the output contains none', async () => {
    const { calls, backing } = await setup()

    const fn = hookFn(calls, 'tool.completed')
    await fn(
      hostToolEvent('sess-host-1', 'Tests passed, no pull request opened.', { toolName: 'run_command' }),
    )

    expect(queueOf(backing)[0]?.prUrl).toBeUndefined()
  })

  it('does not overwrite an already captured PR URL', async () => {
    const { calls, backing } = await setup({ prUrl: 'https://github.com/o/r/pull/7' })

    const fn = hookFn(calls, 'tool.completed')
    await fn(
      hostToolEvent('sess-host-1', 'Opened https://github.com/o/r/pull/99', { toolName: 'run_command' }),
    )

    expect(queueOf(backing)[0]?.prUrl).toBe('https://github.com/o/r/pull/7')
  })
})
