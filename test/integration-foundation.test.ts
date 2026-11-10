/**
 * AC17 — Integration with the OpenFox foundation.
 *
 * This suite proves, with executable assertions, the three properties the
 * criterion demands:
 *
 *   1. NO DUAL SOURCE OF TRUTH. The control plane owns the scheduling
 *      state; the legacy queue mirrors it. The mapping is total, so the
 *      two views cannot drift.
 *   2. NO PARALLEL EXECUTION ENGINE. The plugin never runs a workflow
 *      itself: it hands the launch to the host, and the host's events
 *      drive the chain. The plugin's engine only OBSERVES.
 *   3. CRASH, RECONCILIATION AND IDEMPOTENCE. A restart rebuilds the
 *      state from the durable registry; an expired lease blocks instead
 *      of duplicating; a replayed event changes nothing.
 *
 * Each native capability is reused when it is genuinely reachable, and
 * each duplication documents the PROVEN gap that justifies it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { deriveQueueStatus, findDivergence, syncQueueStatus } from '../src/state-ownership.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import {
  admit,
  completeItem,
  emptyControlPlaneState,
  markRunning,
  reclaimExpiredLeases,
  recordTokenUsage,
  reserve,
} from '../src/control-plane.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

const T0 = 1_700_000_000_000
const CHAIN = ['plan-issue-v3', 'build-verify-v3', 'publish-pr-v1']

function makeSim(): {
  registry: PluginRegistry
  calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  }
  backing: Map<string, unknown>
  launched: Array<{ sessionId: string; workflowId: string }>
  created: string[]
} {
  const calls: {
    hook: Array<{ h: string; fn: (p: unknown) => Promise<void> }>
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const backing = new Map<string, unknown>()
  const launched: Array<{ sessionId: string; workflowId: string }> = []
  const created: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-ac17' },
    logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    storage: {
      get: vi.fn(async (k: string) => {
        const raw = backing.get(k)
        return raw === undefined ? undefined : (JSON.parse(raw as string) as unknown)
      }),
      set: vi.fn(async (k: string, v: unknown) => {
        backing.set(k, JSON.stringify(v))
      }),
    },
    settings: vi.fn(() => ({
      'github.token': 'tok',
      'repos.mapping': 'acme/widgets=proj-1',
      'workflows.chain': CHAIN.join('\n'),
      'scan.startupScan': false,
      'scan.ignoreLabels': '',
      'batch.maxConcurrency': 5,
      'batch.maxConcurrencyPerRepo': 5,
      'ordering.dependencyPattern': '',
      dryRun: false,
      'history.retentionCount': 100,
      'pr.monitorEnabled': false,
      'budget.maxTokensPerIssue': 0,
      'control.leaseMinutes': 10,
    })),
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

  ;(context as unknown as { host?: unknown }).host = {
    sessions: {
      create: async () => {
        created.push('c')
        return { sessionId: `sess-${created.length}` }
      },
      stop: vi.fn(),
    },
    workflows: {
      launch: (p: { sessionId: string; workflowId: string }) => {
        launched.push({ sessionId: p.sessionId, workflowId: p.workflowId })
      },
    },
  }

  return { registry, calls, backing, launched, created }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

function queueEntry(partial: Partial<QueueEntry> = {}): QueueEntry {
  return {
    id: 'qe-1',
    repoKey: 'acme/widgets',
    projectId: 'proj-1',
    issueNumber: 7,
    title: 'Issue 7',
    body: '',
    url: 'https://github.com/acme/widgets/issues/7',
    labels: [],
    comments: [],
    dependsOn: [],
    status: 'queued',
    position: 0,
    addedAt: '2026-01-01T00:00:00.000Z',
    ...partial,
  }
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC17 — one source of truth for the scheduling state', () => {
  it('maps every control-plane status onto the legacy queue status', () => {
    const base = {
      key: 'k',
      repoKey: 'r',
      projectId: 'p',
      issueNumber: 1,
      title: 't',
      url: '',
      priority: 0,
      dependsOn: [],
      attempt: 0,
      tokens: {
        promptTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        cachedPromptTokens: 0,
        cacheWriteTokens: 0,
        llmCalls: 0,
      },
      updatedAt: '',
    }
    expect(deriveQueueStatus({ ...base, status: 'queued' })).toBe('queued')
    // 'reserved' is an internal scheduling state: from the chain engine's
    // point of view the issue is still queued.
    expect(deriveQueueStatus({ ...base, status: 'reserved' })).toBe('queued')
    expect(deriveQueueStatus({ ...base, status: 'running' })).toBe('running')
    expect(deriveQueueStatus({ ...base, status: 'done' })).toBe('done')
    expect(deriveQueueStatus({ ...base, status: 'failed' })).toBe('failed')
    expect(deriveQueueStatus({ ...base, status: 'blocked' })).toBe('blocked')
    expect(deriveQueueStatus({ ...base, status: 'cancelled' })).toBe('cancelled')
    // No item at all: the entry keeps its current status.
    expect(deriveQueueStatus(undefined)).toBe('queued')
  })

  it('mirrors the control-plane status and error onto the legacy entry', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/widgets', projectId: 'p', issueNumber: 7, title: 't', url: '' }], {
      now: T0,
    })
    const item = state.items['acme/widgets#7']!
    item.status = 'blocked'
    item.error = 'workflow plan-issue-v3 blocked'

    const mirrored = syncQueueStatus(queueEntry({ status: 'running' }), item)
    expect(mirrored.status).toBe('blocked')
    expect(mirrored.error).toBe('workflow plan-issue-v3 blocked')
    // The chain engine's data is untouched.
    expect(mirrored.executionStack).toBeUndefined()
  })

  it('detects a divergence between the two views', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/widgets', projectId: 'p', issueNumber: 7, title: 't', url: '' }], {
      now: T0,
    })
    const item = state.items['acme/widgets#7']!

    expect(findDivergence(queueEntry({ status: 'queued' }), item)).toBeNull()

    item.status = 'running'
    expect(findDivergence(queueEntry({ status: 'queued' }), item)).toContain('status drift')

    item.sessionId = 'sess-9'
    expect(findDivergence(queueEntry({ status: 'running', sessionId: 'sess-other' }), item)).toContain(
      'session drift',
    )
  })

  it('the plugin writes the scheduling state through the control plane only', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Issue 7',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/7',
              state: 'open',
              labels: [],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'r' },
            },
          ]),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The control plane knows the issue.
    const registry = readJson<{ items: Record<string, { status: string; sessionId?: string }> }>(
      sim.backing,
      CONTROL_PLANE_STORAGE_KEY,
    )
    const item = registry?.items['acme/widgets#7']
    expect(item).toBeDefined()
    expect(item?.status).toBe('running')

    // And the legacy queue mirrors it: the two agree.
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue')!
    expect(queue[0]?.status).toBe('running')
    expect(findDivergence(queue[0]!, item as never)).toBeNull()
  })
})

describe('AC17 — no parallel execution engine', () => {
  it('the plugin never executes a workflow itself: it delegates to the host', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Issue 7',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/7',
              state: 'open',
              labels: [],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'r' },
            },
          ]),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // Exactly ONE launch, for the FIRST step of the chain: the host runs
    // the workflow, the plugin only asks for it.
    expect(sim.launched).toHaveLength(1)
    expect(sim.launched[0]?.workflowId).toBe('plan-issue-v3')

    // The plugin does not launch the NEXT step by itself: only the host's
    // event advances the chain.
    const before = sim.launched.length
    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    await wfHook({
      event: 'workflow.execution.changed',
      timestamp: new Date().toISOString(),
      sessionId: sim.launched[0]!.sessionId,
      data: {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        workflowName: 'plan-issue-v3',
        status: 'completed',
      },
    })
    // Exactly one more launch: the second chain step, triggered BY THE HOST EVENT.
    expect(sim.launched.length).toBe(before + 1)
    expect(sim.launched[before]?.workflowId).toBe('build-verify-v3')
  })
})

describe('AC17 — crash, reconciliation and idempotence', () => {
  it('rebuilds the scheduling state from the durable registry after a restart', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Issue 7',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/7',
              state: 'open',
              labels: [],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'r' },
            },
          ]),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // Simulate a crash: the plugin is torn down, the storage survives.
    _resetLifecycleForTesting()

    // A fresh instance reads the same durable registry.
    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { items: Array<{ key: string; status: string }> }
    const item = status.items.find((i) => i.key === 'acme/widgets#7')
    expect(item).toBeDefined()
    expect(item?.status).toBe('running')
  })

  it('an expired lease blocks the issue instead of duplicating the session', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/widgets', projectId: 'p', issueNumber: 7, title: 't', url: '' }], {
      now: T0,
    })
    reserve(state, { maxWorkers: 5, maxWorkersPerRepo: 5, leaseMs: 1000, maxTokensPerIssue: 0, now: T0 })
    markRunning(state, 'acme/widgets#7', 'sess-1', { now: T0 })

    const reclaimed = reclaimExpiredLeases(state, { now: T0 + 2000 })
    expect(reclaimed).toHaveLength(1)
    expect(reclaimed[0]?.status).toBe('blocked')
    // The session id is kept: the operator needs to know WHICH session to
    // check before reprocessing.
    expect(reclaimed[0]?.sessionId).toBe('sess-1')
  })

  it('replays an event without changing the state twice', async () => {
    const sim = makeSim()
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))

    const fetchStub = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.includes('/issues?')) {
        return new Response(
          JSON.stringify([
            {
              number: 7,
              title: 'Issue 7',
              body: '',
              html_url: 'https://github.com/acme/widgets/issues/7',
              state: 'open',
              labels: [],
              created_at: '2026-01-01T00:00:00Z',
              updated_at: '2026-01-01T00:00:00Z',
              user: { login: 'r' },
            },
          ]),
          { status: 200 },
        )
      }
      return new Response('{}', { status: 200 })
    })
    vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

    await sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    const wfHook = sim.calls.hook.find((h) => h.h === 'workflow.execution.changed')!.fn
    const event = {
      event: 'workflow.execution.changed',
      timestamp: new Date().toISOString(),
      sessionId: sim.launched[0]!.sessionId,
      data: {
        executionId: 'exec-1',
        workflowId: 'plan-issue-v3',
        workflowName: 'plan-issue-v3',
        status: 'completed',
      },
    }

    await wfHook(event)
    const afterFirst = readJson<QueueEntry[]>(sim.backing, 'queue')!
    const launchesAfterFirst = sim.launched.length

    await wfHook(event)
    const afterReplay = readJson<QueueEntry[]>(sim.backing, 'queue')!

    // No second launch, and the state is identical.
    expect(sim.launched.length).toBe(launchesAfterFirst)
    expect(afterReplay[0]?.executionStack).toEqual(afterFirst[0]?.executionStack)
  })

  it('the token budget and the usage accounting survive in the durable registry', () => {
    const state = emptyControlPlaneState()
    admit(state, [{ repoKey: 'acme/widgets', projectId: 'p', issueNumber: 7, title: 't', url: '' }], {
      now: T0,
    })
    reserve(state, { maxWorkers: 5, maxWorkersPerRepo: 5, leaseMs: 60_000, maxTokensPerIssue: 0, now: T0 })
    markRunning(state, 'acme/widgets#7', 'sess-1', { now: T0 })

    recordTokenUsage(
      state,
      'sess-1',
      { promptTokens: 1000, completionTokens: 200, totalTokens: 1200, cachedPromptTokens: 700 },
      { now: T0 },
    )
    expect(state.items['acme/widgets#7']?.tokens.totalTokens).toBe(1200)
    expect(state.items['acme/widgets#7']?.tokens.cachedPromptTokens).toBe(700)

    // The budget blocks the LIVE run.
    recordTokenUsage(state, 'sess-1', { totalTokens: 900 }, { now: T0, maxTokensPerIssue: 1000 })
    expect(state.items['acme/widgets#7']?.status).toBe('blocked')
    expect(state.items['acme/widgets#7']?.error).toContain('token budget')

    completeItem(state, 'acme/widgets#7', 'blocked', { error: 'manual' })
    expect(state.items['acme/widgets#7']?.status).toBe('blocked')
  })
})
