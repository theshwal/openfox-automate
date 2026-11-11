/**
 * AC18 — regression tests for the last two blocking defects.
 *
 *   K1 — a rescan BLOCKED a running issue in the legacy view only: the
 *        dependency check only knew the ACTIVE queue, so a dependency that
 *        had already COMPLETED (and moved to the history) looked missing.
 *        The divergence was permanent and the freed worker slot was lost
 *        (the hook threw on the illegal blocked → done transition, before
 *        it reused the slot).
 *
 *   K2 — a FAILED issue was resurrected by the history pruning: the
 *        durable-registry filter only covered 'done' and 'cancelled', and a
 *        failed issue lives in the (pruned) history.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

import { _resetLifecycleForTesting, register } from '../src/index.js'
import { CONTROL_PLANE_STORAGE_KEY } from '../src/control-plane-store.js'
import type { PluginContext, PluginRegistry } from 'openfox/plugin'
import type { QueueEntry } from '../src/types.js'

const CHAIN = ['plan-issue-v3']

interface Hook {
  h: string
  fn: (p: unknown) => Promise<void>
}

function makeSim(
  issues: Array<{ number: number; title: string; body?: string }>,
  options: { settings?: Record<string, unknown> } = {},
) {
  const backing = new Map<string, unknown>()
  const calls: {
    hook: Hook[]
    rpc: Array<{ name: string; fn: (p: unknown, c: unknown) => Promise<unknown> }>
  } = { hook: [], rpc: [] }
  const sessionsCreated: string[] = []

  const context = {
    id: 'openfox-automate',
    version: '0.1.0',
    runtime: { mode: 'development' as const, configDirectory: '/tmp/openfox-k' },
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
      'ordering.dependencyPattern': '(#(\\d+))',
      dryRun: false,
      'history.retentionCount': 100,
      'pr.monitorEnabled': false,
      'budget.maxTokensPerIssue': 0,
      'control.leaseMinutes': 10,
      'host.baseUrl': 'http://127.0.0.1:10369',
      ...(options.settings ?? {}),
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

  const fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.includes('/issues?')) {
      return new Response(
        JSON.stringify(
          issues.map((i) => ({
            number: i.number,
            title: i.title,
            body: i.body ?? '',
            html_url: `https://github.com/acme/widgets/issues/${i.number}`,
            state: 'open',
            labels: [],
            created_at: '2026-01-01T00:00:00Z',
            updated_at: '2026-01-01T00:00:00Z',
            user: { login: 'r' },
          })),
        ),
        { status: 200 },
      )
    }
    if (method !== 'GET' && url.endsWith('/api/sessions')) {
      sessionsCreated.push('c')
      return new Response(JSON.stringify({ session: { id: `sess-${sessionsCreated.length}` } }), {
        status: 201,
      })
    }
    if (method === 'POST' && url.endsWith('/tasks')) {
      return new Response(JSON.stringify({ task: { id: 'task-1' } }), { status: 201 })
    }
    return new Response(JSON.stringify({ success: true }), { status: 200 })
  })
  vi.stubGlobal('fetch', fetchStub as unknown as typeof fetch)

  return { registry, calls, backing, sessionsCreated, context }
}

function readJson<T>(backing: Map<string, unknown>, key: string): T | undefined {
  const raw = backing.get(key)
  return raw === undefined ? undefined : (JSON.parse(raw as string) as T)
}

function controlPlane(backing: Map<string, unknown>): {
  items: Record<string, { key: string; status: string; error?: string }>
} {
  return (
    readJson<{
      items: Record<string, { key: string; status: string; error?: string }>
    }>(backing, CONTROL_PLANE_STORAGE_KEY) ?? { items: {} }
  )
}

afterEach(() => {
  _resetLifecycleForTesting()
  vi.unstubAllGlobals()
})

describe('AC18 K1 — a rescan does not block a running issue whose dependency completed', () => {
  it('keeps the two views in agreement and does not lose the worker slot', async () => {
    const sim = makeSim([
      { number: 2, title: 'B', body: 'Depends on #3' },
      { number: 3, title: 'C' },
    ])
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!
    await scan.fn({}, sim.registry.context)
    await sim.calls.rpc.find((r) => r.name === 'automate.controlPlaneSchedule')!.fn({}, sim.registry.context)

    // The DEPENDENCY (#3) is the one that runs first; it completes and
    // moves to the history.
    const cp0 = controlPlane(sim.backing)
    const dependency = Object.values(cp0.items).find((i) => i.key.endsWith('#3'))
    expect(dependency?.status).toBe('running')
    await sim.calls.hook
      .find((h) => h.h === 'workflow.execution.changed')!
      .fn({
        event: 'workflow.execution.changed',
        timestamp: new Date().toISOString(),
        sessionId: 'sess-1',
        data: {
          executionId: 'exec-1',
          workflowId: 'plan-issue-v3',
          workflowName: 'plan-issue-v3',
          status: 'completed',
        },
      })

    // The rescan must not re-block the dependent issue.
    await scan.fn({}, sim.registry.context)

    const cp = controlPlane(sim.backing)
    expect(cp.items['acme/widgets#2']?.status).not.toBe('blocked')

    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    const dependent = queue.find((e) => e.issueNumber === 2)
    expect(dependent?.status).not.toBe('blocked')

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})

describe('AC18 K2 — a failed issue is not resurrected by the history pruning', () => {
  it('does not re-add it after the history was pruned', async () => {
    // 11 issues, a history that keeps 10. The oldest FAILED issue is pruned,
    // so a dedup based on the history would forget it.
    const issues = Array.from({ length: 11 }, (_, i) => ({ number: i + 1, title: `I${i + 1}` }))
    const sim = makeSim(issues, { settings: { 'history.retentionCount': 10 } })
    register(sim.registry)
    await new Promise((r) => setTimeout(r, 0))
    const scan = sim.calls.rpc.find((r) => r.name === 'automate.scanNow')!

    await scan.fn({}, sim.registry.context)

    // Every issue FAILED: the durable registry says 'failed' and the legacy
    // entry is in the history (as the PR monitor would leave it).
    const cp = controlPlane(sim.backing)
    for (const key of Object.keys(cp.items)) {
      cp.items[key]!.status = 'failed'
      cp.items[key]!.error = 'pr_conflicts'
    }
    sim.backing.set(CONTROL_PLANE_STORAGE_KEY, JSON.stringify(cp))
    const queue = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    sim.backing.set(
      'history',
      JSON.stringify(queue.map((e) => ({ ...e, status: 'failed', error: 'pr_conflicts' }))),
    )
    sim.backing.set('queue', JSON.stringify([]))

    // A rescan prunes the history, but must not re-add the failed issues.
    await scan.fn({}, sim.registry.context)

    const queued = readJson<QueueEntry[]>(sim.backing, 'queue') ?? []
    expect(queued).toHaveLength(0)

    const status = (await sim.calls.rpc
      .find((r) => r.name === 'automate.controlPlaneStatus')!
      .fn({}, sim.registry.context)) as { divergences: string[] }
    expect(status.divergences).toEqual([])
  })
})
